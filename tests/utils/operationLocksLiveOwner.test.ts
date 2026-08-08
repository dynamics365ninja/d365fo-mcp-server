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
import { spawnSync } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

const LOCK_ROOT = path.join(os.tmpdir(), 'd365fo-mcp-locks');

let testSeq = 0;
const key = (base: string) => `${base}-live${++testSeq}`;

/**
 * Lock directories this suite touched. Cleanup removes exactly these — LOCK_ROOT
 * is a fixed path under os.tmpdir(), shared with every other suite that takes an
 * operation lock, and vitest runs suites in parallel workers. An `rm -rf` of the
 * whole root deletes another suite's live lock mid-test, which reads as a random
 * unrelated failure.
 */
const touched = new Set<string>();

/** Same mapping acquireFilesystemLock uses: sha256 of the normalized key. */
function lockDirFor(lockKey: string): string {
  const hash = createHash('sha256').update(lockKey.trim().toLowerCase()).digest('hex');
  const dir = path.join(LOCK_ROOT, hash);
  touched.add(dir);
  return dir;
}

/**
 * A pid that is certainly not running: spawnSync returns only once the child has
 * exited. Picking a large constant instead is a guess, and a wrong guess makes
 * the dead-owner tests assert the opposite of what they claim.
 */
function deadPid(): number {
  const child = spawnSync(process.execPath, ['-e', '0']);
  if (typeof child.pid !== 'number') throw new Error('could not spawn a probe process');
  return child.pid;
}

async function plantLock(lockKey: string, owner: { pid: number } | null, ageMs: number): Promise<string> {
  const dir = lockDirFor(lockKey);
  await fs.mkdir(dir, { recursive: true });
  if (owner) await fs.writeFile(path.join(dir, 'owner.json'), JSON.stringify(owner), 'utf8');
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
  delete process.env.OPERATION_LOCK_STALE_MS;
  delete process.env.OPERATION_LOCK_POLL_MS;
  for (const dir of touched) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  touched.clear();
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
    await plantLock(lockKey, { pid: deadPid() }, 1000);

    await expect(withOperationLock(lockKey, async () => 'ran')).resolves.toBe('ran');
  });

  it('falls back to age for a lock with no owner record at all', async () => {
    // owner.json missing — a lock left by an older build of this server, or one
    // whose write lost a race with the mkdir. Age is the only signal left, so it
    // is the only one used: below the window the lock still blocks, above it the
    // lock is reaped. Without the first half a fresh owner-less lock would be
    // walked straight over.
    const { withOperationLock, isOperationLockHeld } = await loadModule({
      OPERATION_LOCK_TIMEOUT_MS: '300',
      OPERATION_LOCK_POLL_MS: '25',
      OPERATION_LOCK_STALE_MS: '100000',
    });

    const fresh = key('sync:no-owner-fresh');
    await plantLock(fresh, null, 1_000);
    expect(await isOperationLockHeld(fresh)).toBe(true);
    await expect(withOperationLock(fresh, async () => 'ran'))
      .rejects.toThrow(/Timeout waiting for filesystem lock/);

    const stale = key('sync:no-owner-stale');
    await plantLock(stale, null, 200_000);
    expect(await isOperationLockHeld(stale)).toBe(false);
    await expect(withOperationLock(stale, async () => 'ran')).resolves.toBe('ran');
  });

  it('lets exactly one of several concurrent reapers claim the same dead lock', async () => {
    // The claim side of the TOCTOU the `release` suite below covers from the
    // other end. Without the rename-to-claim step both callers rm() the
    // directory: the winner re-creates it, the loser's rm() then deletes a lock
    // that is by now legitimately held, and two builds run at once.
    const { withOperationLock } = await loadModule({ OPERATION_LOCK_TIMEOUT_MS: '3000' });
    const lockKey = key('build:reap-race');
    await plantLock(lockKey, { pid: deadPid() }, 1000);

    let inside = 0;
    let overlapped = false;
    const body = async () => {
      inside++;
      if (inside > 1) overlapped = true;
      await new Promise(r => setTimeout(r, 20));
      inside--;
    };

    // Three spellings of one key, so this also pins the trim()/toLowerCase()
    // normalisation the lock directory is derived from.
    const settled = await Promise.allSettled([
      withOperationLock(lockKey, body),
      withOperationLock(` ${lockKey.toUpperCase()} `, body),
      withOperationLock(lockKey, body),
    ]);

    expect(overlapped, 'two operations held the same lock at once').toBe(false);
    expect(settled.filter(r => r.status === 'fulfilled')).toHaveLength(3);
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
