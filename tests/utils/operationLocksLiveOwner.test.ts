/**
 * Stale-lock reaping must never cancel a LIVE owner (audit 2.4 #18).
 *
 * The lock directory's mtime was stamped once, at acquisition, and never touched
 * again. Any operation that legitimately outran OPERATION_LOCK_STALE_MS — a full
 * build, a DB sync, a SysTest run — therefore looked abandoned to the next caller,
 * which deleted the lock and started a second copy of the same work against the
 * same package. Two guards close that: a living owner pid is never age-reaped, and
 * the holder keeps its own mtime moving while it works.
 *
 * The release path had the mirror-image bug: it rm'd the lock directory
 * unconditionally, so a lock a reaper had wrongly taken and a third party had
 * re-created was deleted by whoever released second.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { createHash } from 'crypto';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

const LOCK_ROOT = path.join(os.tmpdir(), 'd365fo-mcp-locks');

let testSeq = 0;
const key = (base: string) => `${base}-live${++testSeq}`;

/** Same mapping acquireFilesystemLock uses: sha256 of the normalized key. */
function lockDirFor(lockKey: string): string {
  const hash = createHash('sha256').update(lockKey.trim().toLowerCase()).digest('hex');
  return path.join(LOCK_ROOT, hash);
}

async function plantLock(lockKey: string, owner: { pid: number }, ageMs: number): Promise<string> {
  const dir = lockDirFor(lockKey);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'owner.json'), JSON.stringify(owner), 'utf8');
  const when = new Date(Date.now() - ageMs);
  await fs.utimes(dir, when, when);
  return dir;
}

const exists = (p: string) => fs.stat(p).then(() => true, () => false);

/** Fresh module instance so the env-derived timing constants are re-read. */
async function loadModule(env: Record<string, string>) {
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  vi.resetModules();
  return import('../../src/utils/operationLocks');
}

afterEach(async () => {
  delete process.env.OPERATION_LOCK_HEARTBEAT_MS;
  delete process.env.OPERATION_LOCK_TIMEOUT_MS;
  await fs.rm(LOCK_ROOT, { recursive: true, force: true }).catch(() => {});
});

describe('stale-lock reaping vs. a living owner', () => {
  it('still reports a two-hour-old lock as held when its owner process is alive', async () => {
    const { isOperationLockHeld } = await loadModule({});
    const lockKey = key('build:long-running');
    await plantLock(lockKey, { pid: process.pid }, 2 * 60 * 60 * 1000);

    // Age says "abandoned", the pid says "still working". The pid wins — otherwise
    // the next caller reaps this lock and runs a second build concurrently.
    expect(await isOperationLockHeld(lockKey)).toBe(true);
  });

  it('makes an acquire wait behind that lock instead of reaping it', async () => {
    const { withOperationLock } = await loadModule({ OPERATION_LOCK_TIMEOUT_MS: '600' });
    const lockKey = key('build:long-running');
    const lockDir = await plantLock(lockKey, { pid: process.pid }, 2 * 60 * 60 * 1000);

    await expect(
      withOperationLock(lockKey, async () => 'should not run'),
    ).rejects.toThrow(/Timeout waiting for filesystem lock/);

    expect(await exists(lockDir)).toBe(true);
  });

  it('still reaps a lock whose owner process is gone', async () => {
    const { withOperationLock } = await loadModule({ OPERATION_LOCK_TIMEOUT_MS: '2000' });
    const lockKey = key('build:crashed');
    // A pid that cannot be running: the max pid on Linux is 2^22, and Windows
    // pids are multiples of 4 well below it.
    await plantLock(lockKey, { pid: 0x7ffffffe }, 1000);

    await expect(withOperationLock(lockKey, async () => 'ran')).resolves.toBe('ran');
  });
});

describe('lock heartbeat', () => {
  it('keeps the lock directory mtime moving while the operation runs', async () => {
    const { withOperationLock } = await loadModule({ OPERATION_LOCK_HEARTBEAT_MS: '30' });
    const lockKey = key('build:heartbeat');
    const lockDir = lockDirFor(lockKey);

    const mtimeAtStart = await withOperationLock(lockKey, async () => {
      const at = (await fs.stat(lockDir)).mtimeMs;
      await new Promise(r => setTimeout(r, 250));
      // Read the refreshed value from inside the callback — the directory is gone
      // by the time the lock is released.
      return { at, after: (await fs.stat(lockDir)).mtimeMs };
    });

    expect(mtimeAtStart.after).toBeGreaterThan(mtimeAtStart.at);
  });
});

describe('release', () => {
  it('leaves the lock directory alone once it belongs to another pid', async () => {
    const { withOperationLock } = await loadModule({});
    const lockKey = key('build:stolen');
    const lockDir = lockDirFor(lockKey);

    await withOperationLock(lockKey, async () => {
      // Stand in for the sequence the TOCTOU race produces: a reaper took this
      // directory away and someone else re-created it under their own pid.
      await fs.writeFile(path.join(lockDir, 'owner.json'), JSON.stringify({ pid: process.pid + 1 }), 'utf8');
    });

    expect(await exists(lockDir)).toBe(true);
    await fs.rm(lockDir, { recursive: true, force: true });
  });
});
