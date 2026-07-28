/**
 * Drive scan for AosService\PackagesLocalDirectory (issue #769).
 *
 * The scan replaced a hardcoded C:/J:/K: candidate list, so what matters here
 * is that a drive letter nobody anticipated is found at all, and that a
 * populated volume wins over an empty stub on a "standard" letter.
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
  FALLBACK_PACKAGES_ROOT,
  defaultPackagesRoot,
  packagesRoots,
  resetPackagesRootCache,
  scanPackagesRoots,
  type ProbeIo,
} from '../../src/utils/packagesRoot';

/**
 * A fake Windows box. `layout` maps a drive letter to the entries its
 * PackagesLocalDirectory holds; a drive absent from `drives` does not exist.
 */
function fakeWindows(drives: string[], layout: Record<string, string[]>): ProbeIo {
  const roots = new Map(
    Object.entries(layout).map(([letter, entries]) => [
      `${letter}:\\AosService\\PackagesLocalDirectory`,
      entries,
    ]),
  );
  return {
    platform: 'win32',
    isDirectory: (target: string) =>
      (target.length === 3 && drives.includes(target[0])) || roots.has(target),
    readDir: (target: string) => roots.get(target) ?? [],
  };
}

afterEach(() => resetPackagesRootCache());

describe('scanPackagesRoots', () => {
  it('finds AosService on J: — the drive the hardcoded list never had (#769)', () => {
    const io = fakeWindows(['C', 'D', 'J'], { J: ['bin', 'ApplicationSuite'] });
    expect(scanPackagesRoots(io)).toEqual(['J:\\AosService\\PackagesLocalDirectory']);
  });

  it('finds a packages root on any drive letter, not just the historical ones', () => {
    const io = fakeWindows(['C', 'P'], { P: ['bin', 'ApplicationSuite'] });
    expect(scanPackagesRoots(io)).toEqual(['P:\\AosService\\PackagesLocalDirectory']);
  });

  it('prefers the populated volume over an empty stub on C:', () => {
    const io = fakeWindows(['C', 'J'], { C: [], J: ['bin', 'ApplicationSuite'] });
    expect(scanPackagesRoots(io)[0]).toBe('J:\\AosService\\PackagesLocalDirectory');
  });

  it('prefers a root with bin over one that only has metadata folders', () => {
    const io = fakeWindows(['C', 'K'], { C: ['SomePackage'], K: ['bin', 'SomePackage'] });
    expect(scanPackagesRoots(io)[0]).toBe('K:\\AosService\\PackagesLocalDirectory');
  });

  it('keeps the historical C: → K: → J: order when the roots look equally real', () => {
    const io = fakeWindows(['C', 'J', 'K'], {
      C: ['bin'], J: ['bin'], K: ['bin'],
    });
    expect(scanPackagesRoots(io)).toEqual([
      'C:\\AosService\\PackagesLocalDirectory',
      'K:\\AosService\\PackagesLocalDirectory',
      'J:\\AosService\\PackagesLocalDirectory',
    ]);
  });

  it('returns every root it found, not only the winner', () => {
    const io = fakeWindows(['C', 'J'], { C: ['bin'], J: ['bin'] });
    expect(scanPackagesRoots(io)).toHaveLength(2);
  });

  it('ignores drives without AosService', () => {
    const io = fakeWindows(['C', 'D', 'E'], {});
    expect(scanPackagesRoots(io)).toEqual([]);
  });

  it('never probes A: or B: — floppy letters stall the scan', () => {
    const probed: string[] = [];
    const io: ProbeIo = {
      platform: 'win32',
      isDirectory: (target: string) => { probed.push(target); return false; },
      readDir: () => [],
    };
    scanPackagesRoots(io);
    expect(probed.some(t => t.startsWith('A:') || t.startsWith('B:'))).toBe(false);
  });

  it('finds nothing off Windows', () => {
    const io = { ...fakeWindows(['C', 'K'], { K: ['bin'] }), platform: 'darwin' as NodeJS.Platform };
    expect(scanPackagesRoots(io)).toEqual([]);
  });
});

describe('defaultPackagesRoot', () => {
  it('falls back to a named path when nothing was detected', () => {
    // Off Windows the real scan always comes back empty; on a D365FO VM the
    // detected root is the answer and there is nothing to fall back to.
    if (packagesRoots().length > 0) {
      expect(defaultPackagesRoot()).toBe(packagesRoots()[0]);
      return;
    }
    expect(defaultPackagesRoot()).toBe(FALLBACK_PACKAGES_ROOT);
  });
});
