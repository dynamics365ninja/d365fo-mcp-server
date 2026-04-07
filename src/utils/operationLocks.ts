/**
 * Lightweight in-process async locks for serializing heavyweight local
 * operations like builds, BP checks, DB syncs, and SysTest runs.
 *
 * Scope is primarily the local Windows VM companion. We combine:
 * - in-process queueing for concurrent requests hitting the same Node process
 * - filesystem-backed lock directories in os.tmpdir() for cross-process safety
 *
 * This covers the practical case of multiple local MCP companion processes on
 * the same machine. It does NOT provide cross-machine / cross-instance locking;
 * that would require a shared coordinator such as Redis or blob leases.
 */

import { createHash } from 'crypto';
import * as fs from 'fs/promises';
import os from 'os';
import path from 'path';

const operationLocks = new Map<string, Promise<void>>();

const LOCK_ROOT = path.join(os.tmpdir(), 'd365fo-mcp-locks');
const LOCK_WAIT_TIMEOUT_MS = parseInt(process.env.OPERATION_LOCK_TIMEOUT_MS || '900000', 10); // 15 min
const LOCK_POLL_INTERVAL_MS = parseInt(process.env.OPERATION_LOCK_POLL_MS || '250', 10);
const LOCK_STALE_MS = parseInt(process.env.OPERATION_LOCK_STALE_MS || '1200000', 10); // 20 min

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getLockDirectory(normalizedKey: string): string {
  const hash = createHash('sha256').update(normalizedKey).digest('hex');
  return path.join(LOCK_ROOT, hash);
}

/**
 * Returns true if `pid` corresponds to a running process.
 * On Windows, `process.kill(pid, 0)` throws ESRCH when the process is gone
 * and EPERM when it's alive but owned by another user — both are usable.
 */
function isProcessAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;          // signal 0 delivered → process exists
  } catch (e: any) {
    return e?.code === 'EPERM'; // EPERM = exists but not ours; ESRCH = gone
  }
}

async function tryRemoveStaleLock(lockDir: string, normalizedKey: string): Promise<boolean> {
  try {
    const stat = await fs.stat(lockDir);
    const ageMs = Date.now() - stat.mtimeMs;

    // Primary: check if the owning process is still alive.
    // If it died (e.g. MCP server was killed mid-build), remove immediately
    // regardless of age so we don't wait up to LOCK_STALE_MS (20 min).
    const ownerFile = path.join(lockDir, 'owner.json');
    try {
      const ownerRaw = await fs.readFile(ownerFile, 'utf8');
      const owner = JSON.parse(ownerRaw) as { pid?: number };
      if (typeof owner.pid === 'number' && !isProcessAlive(owner.pid)) {
        await fs.rm(lockDir, { recursive: true, force: true });
        console.error(`[operationLocks] removed dead-process lock for ${normalizedKey} (pid ${owner.pid} no longer running, age ${ageMs} ms)`);
        return true;
      }
    } catch {
      // owner.json missing or unparseable — fall through to age check
    }

    // Fallback: time-based stale detection
    if (ageMs < LOCK_STALE_MS) {
      return false;
    }

    await fs.rm(lockDir, { recursive: true, force: true });
    console.error(`[operationLocks] removed stale filesystem lock for ${normalizedKey} (age ${ageMs} ms)`);
    return true;
  } catch {
    return false;
  }
}

async function acquireFilesystemLock(normalizedKey: string): Promise<() => Promise<void>> {
  const lockDir = getLockDirectory(normalizedKey);
  const ownerFile = path.join(lockDir, 'owner.json');
  const start = Date.now();

  await fs.mkdir(LOCK_ROOT, { recursive: true });

  while (true) {
    try {
      await fs.mkdir(lockDir);
      await fs.writeFile(ownerFile, JSON.stringify({
        pid: process.pid,
        key: normalizedKey,
        acquiredAt: new Date().toISOString(),
      }, null, 2), 'utf8').catch(() => {});

      return async () => {
        await fs.rm(lockDir, { recursive: true, force: true }).catch(() => {});
      };
    } catch (error: any) {
      if (error?.code !== 'EEXIST') {
        throw error;
      }

      const removed = await tryRemoveStaleLock(lockDir, normalizedKey);
      if (removed) {
        continue;
      }

      const waitedMs = Date.now() - start;
      if (waitedMs >= LOCK_WAIT_TIMEOUT_MS) {
        throw new Error(`Timeout waiting for filesystem lock: ${normalizedKey}`);
      }

      await sleep(LOCK_POLL_INTERVAL_MS);
    }
  }
}

export async function withOperationLock<T>(lockKey: string, fn: () => Promise<T>): Promise<T> {
  const normalizedKey = lockKey.trim().toLowerCase();
  const previous = operationLocks.get(normalizedKey) ?? Promise.resolve();

  let release!: () => void;
  const current = new Promise<void>(resolve => {
    release = resolve;
  });

  operationLocks.set(normalizedKey, current);

  const waitStart = Date.now();
  try {
    await previous;
    const releaseFilesystemLock = await acquireFilesystemLock(normalizedKey);

    const waitedMs = Date.now() - waitStart;
    if (waitedMs > 100) {
      console.error(`[operationLocks] waited ${waitedMs} ms for ${normalizedKey}`);
    }

    try {
      return await fn();
    } finally {
      await releaseFilesystemLock();
    }
  } finally {
    release();
    if (operationLocks.get(normalizedKey) === current) {
      operationLocks.delete(normalizedKey);
    }
  }
}

export function getOperationLockCount(): number {
  return operationLocks.size;
}

/**
 * Returns true if a lock for the given key is currently held (in-process or
 * filesystem-backed by a living process). Dead-process and time-stale locks
 * are treated as not-held so callers don't block after a crash/restart.
 */
export async function isOperationLockHeld(lockKey: string): Promise<boolean> {
  const normalizedKey = lockKey.trim().toLowerCase();

  // In-process: check map
  if (operationLocks.has(normalizedKey)) return true;

  // Filesystem: check lock directory existence, owner liveness, and freshness
  const lockDir = getLockDirectory(normalizedKey);
  try {
    const stat = await fs.stat(lockDir);
    const ageMs = Date.now() - stat.mtimeMs;

    // Check if the owning process is still alive
    const ownerFile = path.join(lockDir, 'owner.json');
    try {
      const ownerRaw = await fs.readFile(ownerFile, 'utf8');
      const owner = JSON.parse(ownerRaw) as { pid?: number };
      if (typeof owner.pid === 'number' && !isProcessAlive(owner.pid)) {
        // Dead process — lock is orphaned, not held
        return false;
      }
    } catch {
      // owner.json missing/unreadable — fall back to age check
    }

    return ageMs < LOCK_STALE_MS;
  } catch {
    return false;
  }
}

/**
 * Forcibly removes the filesystem lock directory for the given key, allowing
 * a new operation to proceed even if a previous one is stuck.
 */
export async function forceReleaseLock(lockKey: string): Promise<void> {
  const normalizedKey = lockKey.trim().toLowerCase();
  const lockDir = getLockDirectory(normalizedKey);
  await fs.rm(lockDir, { recursive: true, force: true }).catch(() => {});
  // Also clear in-process map entry so we don't wait on a resolved-but-retained promise
  operationLocks.delete(normalizedKey);
  console.error(`[operationLocks] force-released lock for ${normalizedKey}`);
}
