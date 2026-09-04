/**
 * The AosService drive scan is bounded.
 *
 * Every probe is a synchronous stat, and a stat on a disconnected mapped
 * network drive stalls for the SMB timeout — tens of seconds for one letter,
 * on the first tool call of the session (the scan is lazy and cached). The
 * letters that have ever held AosService are probed first and always, the
 * rest only inside a time budget, D365FO_SCAN_DRIVES pins the set, and the
 * report names what was skipped and what was slow.
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
  DRIVE_SCAN_BUDGET_MS,
  describeDriveScan,
  describePackagesRootScan,
  driveLettersToProbe,
  lastDriveScanReport,
  packagesRoots,
  resetPackagesRootCache,
  scanPackagesRoots,
  type ProbeIo,
} from '../../src/utils/packagesRoot';

/**
 * A fake Windows box that records the order it was probed in. `slow` maps a
 * drive letter to how long its root probe takes on the fake clock.
 */
function recordingWindows(
  drives: string[],
  layout: Record<string, string[]>,
  slow: Record<string, number> = {},
): { io: ProbeIo; probed: string[]; clock: () => number } {
  const roots = new Map(
    Object.entries(layout).map(([letter, entries]) => [
      `${letter}:\\AosService\\PackagesLocalDirectory`,
      entries,
    ]),
  );
  const probed: string[] = [];
  let now = 0;
  const io: ProbeIo = {
    platform: 'win32',
    isDirectory: (target: string) => {
      if (target.length === 3) {
        probed.push(target[0]);
        now += slow[target[0]] ?? 1;
        return drives.includes(target[0]);
      }
      return roots.has(target);
    },
    readDir: (target: string) => roots.get(target) ?? [],
  };
  return { io, probed, clock: () => now };
}

afterEach(() => {
  resetPackagesRootCache();
  delete process.env.D365FO_SCAN_DRIVES;
});

describe('driveLettersToProbe', () => {
  it('probes the letters that have ever held AosService before the alphabet', () => {
    const { letters, pinned } = driveLettersToProbe(undefined);
    expect(pinned).toBe(false);
    expect(letters.slice(0, 4)).toEqual(['C', 'K', 'J', 'I']);
    expect(letters).toHaveLength(24);
    expect(letters).not.toContain('A');
    expect(letters).not.toContain('B');
  });

  it('pins the set from D365FO_SCAN_DRIVES, tolerating colons, separators and case', () => {
    expect(driveLettersToProbe('c, K:; j:\\')).toEqual({ letters: ['C', 'K', 'J'], pinned: true });
  });

  it('ignores a spec that names no usable letter', () => {
    expect(driveLettersToProbe('A, B, 1').pinned).toBe(false);
  });
});

describe('scanPackagesRoots (bounded)', () => {
  it('probes C:, K:, J:, I: first so a stalled drive further down cannot delay them', () => {
    const { io, probed, clock } = recordingWindows(['C', 'D', 'K'], { K: ['bin'] });
    scanPackagesRoots(io, { clock });
    expect(probed.slice(0, 4)).toEqual(['C', 'K', 'J', 'I']);
  });

  it('still scans every letter on a healthy machine and ranks as before', () => {
    const { io, probed, clock } = recordingWindows(['C', 'K', 'P'], { P: ['bin'], C: [] });
    expect(scanPackagesRoots(io, { clock })).toEqual([
      'P:\\AosService\\PackagesLocalDirectory',
      'C:\\AosService\\PackagesLocalDirectory',
    ]);
    expect(probed).toHaveLength(24);
    expect(lastDriveScanReport()?.skipped).toEqual([]);
  });

  it('stops probing the remaining letters once one stalled drive has spent the budget', () => {
    // D: is a dead mapped drive: one probe costs 30 s. P: holds a real root
    // behind it and is never reached — the report has to say so.
    const { io, probed, clock } = recordingWindows(
      ['C', 'D', 'K', 'P'],
      { K: ['bin'], P: ['bin'] },
      { D: 30_000 },
    );
    const roots = scanPackagesRoots(io, { clock });

    expect(roots).toEqual(['K:\\AosService\\PackagesLocalDirectory']);
    // The four preferred letters, then D: (inside the budget when it began), then nothing.
    expect(probed).toEqual(['C', 'K', 'J', 'I', 'D']);
    const report = lastDriveScanReport()!;
    expect(report.slow).toEqual([{ letter: 'D', ms: 30_000 }]);
    expect(report.skipped).toContain('P');
    expect(report.skipped).toHaveLength(24 - 5);
  });

  it('always probes the preferred letters even when the budget is already gone', () => {
    const { io, probed, clock } = recordingWindows(['C', 'K'], { K: ['bin'] }, { C: 30_000 });
    expect(scanPackagesRoots(io, { clock })).toEqual(['K:\\AosService\\PackagesLocalDirectory']);
    expect(probed).toEqual(['C', 'K', 'J', 'I']);
  });

  it('probes exactly the pinned letters, in the given order, with no budget', () => {
    const { io, probed, clock } = recordingWindows(
      ['C', 'K', 'P'],
      { P: ['bin'] },
      { K: 30_000 },
    );
    expect(scanPackagesRoots(io, { clock, drives: 'K,P' })).toEqual(['P:\\AosService\\PackagesLocalDirectory']);
    expect(probed).toEqual(['K', 'P']);
    expect(lastDriveScanReport()).toMatchObject({ pinned: true, skipped: [] });
  });

  it('reads the pinned set from D365FO_SCAN_DRIVES when no override is passed', () => {
    process.env.D365FO_SCAN_DRIVES = 'C';
    const { io, probed, clock } = recordingWindows(['C', 'K'], { K: ['bin'] });
    expect(scanPackagesRoots(io, { clock })).toEqual([]);
    expect(probed).toEqual(['C']);
  });

  it('honours a custom budget', () => {
    const { io, probed, clock } = recordingWindows(['C'], {});
    scanPackagesRoots(io, { clock, budgetMs: 3 });
    // The four preferred probes cost 1 ms each on the fake clock, so the 3 ms
    // budget is gone before the first non-preferred letter is considered.
    expect(probed).toEqual(['C', 'K', 'J', 'I']);
  });

  it('exposes the budget so messages and docs quote the same number', () => {
    expect(DRIVE_SCAN_BUDGET_MS).toBe(2_000);
  });
});

describe('describePackagesRootScan (bounded)', () => {
  it('keeps the plain wording when nothing was skipped or slow', () => {
    // packagesRoots() runs the real scan on this machine; the report may be
    // anything, so only the shape of the sentence is checked.
    resetPackagesRootCache();
    packagesRoots();
    const text = describePackagesRootScan();
    expect(text).toMatch(/^(Detected packages roots: |No <drive>:\\AosService\\PackagesLocalDirectory found)/);
  });

  it('names the slow probe and the skipped letters after a scan that ran out of budget', () => {
    const { io, clock } = recordingWindows(['C', 'D', 'K', 'P'], { P: ['bin'] }, { D: 30_000 });
    const found = scanPackagesRoots(io, { clock });
    const text = describeDriveScan(found, lastDriveScanReport());
    expect(text).toMatch(/^No <drive>:\\AosService\\PackagesLocalDirectory found on any drive \(C:, K:, J:, I:, D: were scanned\)\./);
    expect(text).toMatch(/Probing D: took 30\.0 s/);
    expect(text).toMatch(/did not probe .*P:/);
    expect(text).toMatch(/D365FO_SCAN_DRIVES/);
  });

  it('says which letters a pinned scan covered', () => {
    const { io, clock } = recordingWindows(['C', 'K'], { K: ['bin'] });
    const found = scanPackagesRoots(io, { clock, drives: 'C' });
    expect(describeDriveScan(found, lastDriveScanReport())).toBe(
      'No <drive>:\\AosService\\PackagesLocalDirectory found on any drive (C: were scanned (D365FO_SCAN_DRIVES)).',
    );
  });
});
