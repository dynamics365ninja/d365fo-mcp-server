/**
 * The drive scan runs off the event loop.
 *
 * Bounding the scan (packagesRootBounded.test.ts) capped how MANY letters a
 * stalled drive can cost, but not what the stall blocks: C:, K:, J: and I: are
 * probed unconditionally — deliberately, since skipping one hides the packages
 * root on it — and `statSync` on a disconnected mapped network drive freezes
 * the thread it runs on for the SMB timeout. On the main thread that is the
 * event loop, so the server stops answering, logging and sending heartbeats.
 *
 * The async twin hands the same stats to the libuv threadpool. These cases pin
 * the two properties that makes it worth having: it agrees with the sync scan
 * about every answer, and awaiting it never blocks the loop.
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
  describeDriveScan,
  lastDriveScanReport,
  packagesRoots,
  resetPackagesRootCache,
  scanPackagesRoots,
  scanPackagesRootsAsync,
  warmPackagesRoots,
  type AsyncProbeIo,
  type ProbeIo,
} from '../../src/utils/packagesRoot';

/** The same fake machine in both flavours, so the two scans can be compared. */
function fakeWindows(
  drives: string[],
  layout: Record<string, string[]>,
  slow: Record<string, number> = {},
): { sync: ProbeIo; async: AsyncProbeIo; probed: string[]; clock: () => number } {
  const roots = new Map(
    Object.entries(layout).map(([letter, entries]) => [
      `${letter}:\\AosService\\PackagesLocalDirectory`,
      entries,
    ]),
  );
  const probed: string[] = [];
  let now = 0;
  const isDirectory = (target: string): boolean => {
    if (target.length === 3) {
      probed.push(target[0]);
      now += slow[target[0]] ?? 1;
      return drives.includes(target[0]);
    }
    return roots.has(target);
  };
  const readDir = (target: string): string[] => roots.get(target) ?? [];
  return {
    sync: { platform: 'win32', isDirectory, readDir },
    async: {
      platform: 'win32',
      isDirectory: async t => isDirectory(t),
      readDir: async t => readDir(t),
    },
    probed,
    clock: () => now,
  };
}

afterEach(() => {
  resetPackagesRootCache();
  delete process.env.D365FO_SCAN_DRIVES;
});

describe('scanPackagesRootsAsync', () => {
  it('finds and ranks exactly what the synchronous scan finds', async () => {
    const layout = { P: ['bin'], C: [], K: ['AppSuite'] };
    const a = fakeWindows(['C', 'K', 'P'], layout);
    const b = fakeWindows(['C', 'K', 'P'], layout);

    const fromSync = scanPackagesRoots(a.sync, { clock: a.clock });
    const fromAsync = await scanPackagesRootsAsync(b.async, { clock: b.clock });

    expect(fromAsync).toEqual(fromSync);
    // bin beats populated beats empty, preferred letters break the tie.
    expect(fromAsync).toEqual([
      'P:\\AosService\\PackagesLocalDirectory',
      'K:\\AosService\\PackagesLocalDirectory',
      'C:\\AosService\\PackagesLocalDirectory',
    ]);
    expect(b.probed).toEqual(a.probed);
  });

  it('keeps the preferred letters unconditional — a stall must not hide a root behind it', async () => {
    // C: is a dead mapped drive. K:, probed after it, holds the real root: if
    // the stall were allowed to cut the preferred letters short, the scan would
    // answer "no packages root" on a machine that has one.
    const { async: io, probed, clock } = fakeWindows(['C', 'K'], { K: ['bin'] }, { C: 30_000 });
    expect(await scanPackagesRootsAsync(io, { clock })).toEqual([
      'K:\\AosService\\PackagesLocalDirectory',
    ]);
    expect(probed).toEqual(['C', 'K', 'J', 'I']);
    expect(lastDriveScanReport()?.slow).toEqual([{ letter: 'C', ms: 30_000 }]);
  });

  it('still spends the budget on the other letters and reports what it skipped', async () => {
    const { async: io, clock } = fakeWindows(['C', 'D', 'K', 'P'], { P: ['bin'] }, { D: 30_000 });
    const found = await scanPackagesRootsAsync(io, { clock });
    expect(found).toEqual([]);
    const text = describeDriveScan(found, lastDriveScanReport());
    expect(text).toMatch(/Probing D: took 30\.0 s/);
    expect(text).toMatch(/did not probe .*P:/);
  });

  it('lets the event loop run while a slow drive is being probed', async () => {
    // The probe resolves on a timer rather than immediately, because that is the
    // shape of the real thing: fsp.stat completes on the libuv threadpool and
    // its callback arrives as a loop event. (A fake that resolves inline would
    // prove nothing — the whole scan would drain as microtasks before any timer
    // got a turn, which is an artefact of the fake, not of the scan.)
    let other = 0;
    const ticking = setInterval(() => { other++; }, 1);
    try {
      const io: AsyncProbeIo = {
        platform: 'win32',
        isDirectory: (target: string) =>
          new Promise(resolve => setTimeout(() => resolve(target.length === 3), 2)),
        readDir: async () => [],
      };
      await scanPackagesRootsAsync(io, { drives: 'C,K,J,I' });
      // Every one of the four letters was probed, and the loop kept running the
      // whole time. The synchronous scan cannot produce this: statSync holds the
      // thread, so `other` would still be 0.
      expect(other).toBeGreaterThan(0);
    } finally {
      clearInterval(ticking);
    }
  });

  it('answers nothing off Windows, like its synchronous twin', async () => {
    const io: AsyncProbeIo = {
      platform: 'linux',
      isDirectory: async () => true,
      readDir: async () => ['bin'],
    };
    expect(await scanPackagesRootsAsync(io)).toEqual([]);
  });
});

describe('warmPackagesRoots', () => {
  it('fills the cache the synchronous callers read, so they never scan themselves', async () => {
    resetPackagesRootCache();
    const warmed = await warmPackagesRoots();
    // packagesRoots() must now be answering from the cache warmPackagesRoots
    // filled — same array identity, so no second scan can have run.
    expect(packagesRoots()).toBe(warmed);
  });

  it('shares one in-flight scan between concurrent callers', async () => {
    resetPackagesRootCache();
    const [a, b] = await Promise.all([warmPackagesRoots(), warmPackagesRoots()]);
    expect(a).toBe(b);
  });

  it('does not let an in-flight scan write into the cache after a reset', async () => {
    resetPackagesRootCache();
    const inFlight = warmPackagesRoots();
    // A reset lands while the scan is still going; its answer must be dropped
    // rather than installed over the fresh state.
    resetPackagesRootCache();
    await inFlight;
    const { sync: io, clock } = fakeWindows(['C'], { C: ['bin'] });
    // If the stale warm had won, this scan would never run and the fake drive
    // would be invisible.
    expect(scanPackagesRoots(io, { clock })).toEqual(['C:\\AosService\\PackagesLocalDirectory']);
  });
});
