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
// The holder touches its lock directory on this interval. Without it the mtime is
// frozen at acquisition time and a build/DB-sync that legitimately runs longer than
// LOCK_STALE_MS has its own lock reaped out from under it by the next caller.
const LOCK_HEARTBEAT_MS = parseInt(process.env.OPERATION_LOCK_HEARTBEAT_MS || '60000', 10); // 1 min

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
    return true;
  } catch (e: any) {
    return e?.code === 'EPERM'; // EPERM = exists but not ours; ESRCH = gone
  }
}

/** Owner record of a filesystem lock, or null when it is missing/unreadable. */
async function readLockOwner(lockDir: string): Promise<{ pid?: number } | null> {
  try {
    return JSON.parse(await fs.readFile(path.join(lockDir, 'owner.json'), 'utf8')) as { pid?: number };
  } catch {
    return null;
  }
}

/**
 * Take the lock directory away from its current occupant and delete it.
 *
 * The rename is the claim: two processes that both decide the same lock is stale
 * would otherwise each call rm(), and the loser's rm() lands AFTER the winner has
 * already re-created the directory — deleting a lock that is now legitimately held.
 * Exactly one rename can succeed, so exactly one caller reports the removal.
 */
async function claimAndRemoveLock(lockDir: string): Promise<boolean> {
  const claimed = `${lockDir}.reaped-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    await fs.rename(lockDir, claimed);
  } catch {
    return false; // someone else claimed it first, or the owner released it
  }
  await fs.rm(claimed, { recursive: true, force: true }).catch(() => {});
  return true;
}

async function tryRemoveStaleLock(lockDir: string, normalizedKey: string): Promise<boolean> {
  try {
    const stat = await fs.stat(lockDir);
    const ageMs = Date.now() - stat.mtimeMs;

    const owner = await readLockOwner(lockDir);
    if (typeof owner?.pid === 'number') {
      if (!isProcessAlive(owner.pid)) {
        // Dead owner: remove immediately regardless of age.
        if (!(await claimAndRemoveLock(lockDir))) return false;
        console.error(`[operationLocks] removed dead-process lock for ${normalizedKey} (pid ${owner.pid} no longer running, age ${ageMs} ms)`);
        return true;
      }
      // A LIVING owner's lock is never age-reaped. The age check exists for locks
      // whose owner vanished without a trace; applied to a live pid it cancelled
      // long-running work — a build or DB sync past LOCK_STALE_MS had its lock
      // deleted and a second build started concurrently against the same package.
      return false;
    }

    // No usable owner record — all that is left is time-based stale detection.
    if (ageMs < LOCK_STALE_MS) {
      return false;
    }

    if (!(await claimAndRemoveLock(lockDir))) return false;
    console.error(`[operationLocks] removed stale filesystem lock for ${normalizedKey} (age ${ageMs} ms)`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Keep the lock directory's mtime moving while the operation runs, so the
 * time-based reaper sees a fresh lock rather than one frozen at acquisition.
 * Best-effort: the timer is unref'd (a held lock must not keep the process
 * alive) and every failure is ignored — the pid check is the primary defence.
 */
function startLockHeartbeat(lockDir: string, ownerFile: string): () => void {
  const timer = setInterval(() => {
    const now = new Date();
    void fs.utimes(lockDir, now, now).catch(() => {});
    void fs.utimes(ownerFile, now, now).catch(() => {});
  }, LOCK_HEARTBEAT_MS);
  timer.unref?.();
  return () => clearInterval(timer);
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

      const stopHeartbeat = startLockHeartbeat(lockDir, ownerFile);

      return async () => {
        stopHeartbeat();
        // Release only what is still OURS. If a reaper wrongly took this lock and
        // a third party re-created it, an unconditional rm() would delete the new
        // holder's lock and let two operations run at once.
        const owner = await readLockOwner(lockDir);
        if (owner && owner.pid !== process.pid) {
          console.error(`[operationLocks] lock for ${normalizedKey} is now owned by pid ${owner.pid} — leaving it in place`);
          return;
        }
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

  if (operationLocks.has(normalizedKey)) return true;

  const lockDir = getLockDirectory(normalizedKey);
  try {
    const stat = await fs.stat(lockDir);
    const ageMs = Date.now() - stat.mtimeMs;

    const owner = await readLockOwner(lockDir);
    if (typeof owner?.pid === 'number') {
      // Held iff the owner is alive — age is irrelevant for a living owner, the
      // same rule tryRemoveStaleLock applies, so the two never disagree about
      // whether a long-running build still holds its lock.
      return isProcessAlive(owner.pid);
    }

    // owner.json missing/unreadable — fall back to age check
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
  operationLocks.delete(normalizedKey);
  console.error(`[operationLocks] force-released lock for ${normalizedKey}`);
}
