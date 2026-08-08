import { describe, it, expect, afterAll } from 'vitest';
import { getOperationLockCount, withOperationLock } from '../../src/utils/operationLocks';
import { createHash } from 'crypto';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

// Unique key per test — ensures no cross-test contamination in the in-memory Map
// even if a previous test left dangling promises (e.g. after an early assertion failure).
let testSeq = 0;
const usedKeys: string[] = [];
function key(base: string): string {
  const k = `${base}-t${++testSeq}`;
  usedKeys.push(k);
  return k;
}

const LOCK_ROOT = path.join(os.tmpdir(), 'd365fo-mcp-locks');

afterAll(async () => {
  // Remove ONLY the lock directories these tests created. LOCK_ROOT is a fixed
  // path under os.tmpdir() shared by every suite that takes an operation lock,
  // and vitest runs suites in parallel workers — an `rm -rf` of the whole root
  // deletes a live lock belonging to another suite, which surfaces as a random
  // failure somewhere else entirely.
  const usedDirs = usedKeys.map(k =>
    path.join(LOCK_ROOT, createHash('sha256').update(k.trim().toLowerCase()).digest('hex')));
  for (const dir of usedDirs) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
});

describe('operationLocks', () => {
  it('serializes work for the same lock key', async () => {
    const lockKey = key('build:project-a');
    const order: string[] = [];

    let releaseFirst!: () => void;
    const firstGate = new Promise<void>(resolve => {
      releaseFirst = resolve;
    });

    const first = withOperationLock(lockKey, async () => {
      order.push('first-start');
      await firstGate;
      order.push('first-end');
      return 'first';
    });

    const second = withOperationLock(lockKey, async () => {
      order.push('second-start');
      order.push('second-end');
      return 'second';
    });

    // Filesystem lock acquisition takes multiple I/O event-loop turns — poll
    // until the first callback has actually started rather than assuming a
    // single microtask tick is enough.
    const deadline = Date.now() + 2000;
    while (order.length === 0 && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 10));
    }
    expect(order).toEqual(['first-start']);

    releaseFirst();

    await expect(first).resolves.toBe('first');
    await expect(second).resolves.toBe('second');
    expect(order).toEqual(['first-start', 'first-end', 'second-start', 'second-end']);
  });

  it('allows parallel work for different keys', async () => {
    const keyA = key('build:project-a');
    const keyB = key('build:project-b');
    const order: string[] = [];

    await Promise.all([
      withOperationLock(keyA, async () => {
        order.push('a-start');
        await Promise.resolve();
        order.push('a-end');
      }),
      withOperationLock(keyB, async () => {
        order.push('b-start');
        await Promise.resolve();
        order.push('b-end');
      }),
    ]);

    expect(order).toContain('a-start');
    expect(order).toContain('b-start');
    expect(getOperationLockCount()).toBe(0);
  });

  it('cleans up the lock after a failure', async () => {
    const lockKey = key('bp:project-a');

    await expect(
      withOperationLock(lockKey, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    expect(getOperationLockCount()).toBe(0);

    await expect(
      withOperationLock(lockKey, async () => 'recovered'),
    ).resolves.toBe('recovered');
  });
});
