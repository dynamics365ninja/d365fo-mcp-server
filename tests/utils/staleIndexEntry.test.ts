/**
 * Symbol-index rows that outlived their files.
 *
 * The index is not rebuilt when an object is deleted, and the extracted-metadata
 * JSON written at index time is not removed either. After a workspace reset one
 * benchmark run therefore got a complete, confident enum back from
 * `get_object_info` — name, four values, four labels — for a file that did not
 * exist. Nothing in the answer said "cache", so the agent believed it and spent
 * roughly a quarter of the run proving the object was a ghost before starting the
 * actual work.
 *
 * The tell was available at the point of the answer: the bridge knew nothing, the
 * index recorded a PackagesLocalDirectory path, and no file was at that path or at
 * its local remap. These cover that rule and the ways it must NOT fire.
 *
 * The packages root is a REAL directory here (a temp dir), never the host's own:
 * the rule asks whether this machine can observe the file's absence, so a test
 * that borrowed the host's configured root would pass on a developer VM with
 * D365FO installed and fail on CI without one.
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import * as realFs from 'fs';
import * as os from 'os';
import * as path from 'path';

const mockResolveDbPathLocally = vi.fn(async (_p: string): Promise<string | null> => null);
vi.mock('../../src/utils/metadataResolver', () => ({
  resolveDbPathLocally: (p: string) => mockResolveDbPathLocally(p),
}));

/** An existing directory stands in for a reachable PackagesLocalDirectory. */
const REACHABLE_ROOT = realFs.mkdtempSync(path.join(os.tmpdir(), 'stale-index-root-'));
const UNREACHABLE_ROOT = path.join(REACHABLE_ROOT, 'not-mounted', 'PackagesLocalDirectory');

const packagesRoot = { value: REACHABLE_ROOT as string | null };
vi.mock('../../src/utils/configManager', () => ({
  getConfigManager: () => ({
    ensureLoaded: async () => {},
    getPackagePath: () => packagesRoot.value,
  }),
  fallbackPackagePath: () => '',
}));

afterAll(() => {
  realFs.rmSync(REACHABLE_ROOT, { recursive: true, force: true });
});

const mockLookupSymbolNocase = vi.fn();
vi.mock('../../src/utils/symbolLookup', () => ({
  lookupSymbolNocase: (...args: unknown[]) => mockLookupSymbolNocase(...args),
}));

import {
  indexedPathIsMissing,
  renderStaleIndexNote,
  staleIndexNote,
  indexedSourceNote,
  resolveIndexedObject,
} from '../../src/utils/indexedXmlLookup';

// A path that is under PackagesLocalDirectory and certainly not on this machine.
const GHOST = 'Q:\\NoSuchDrive\\PackagesLocalDirectory\\GhostModel\\GhostModel\\AxEnum\\Ghost_QualityTier.xml';
// A build-agent path the DB may legitimately store; unreachable here, not deleted.
const BUILD_AGENT = '/mnt/vss/_work/1/s/Metadata/Foundation/AxEnum/NoYes.xml';

describe('indexedPathIsMissing', () => {
  beforeEach(() => {
    mockResolveDbPathLocally.mockReset();
    mockResolveDbPathLocally.mockResolvedValue(null);
    packagesRoot.value = REACHABLE_ROOT;
  });

  it('reports a PackagesLocalDirectory path with no file at either location', async () => {
    expect(await indexedPathIsMissing(GHOST)).toBe(true);
  });

  it('says nothing when the packages root itself is unreachable', async () => {
    // A root that is not there makes EVERY object unreadable. Calling that a
    // deleted object hands the agent "treat it as NOT EXISTING and create it",
    // and it is told not to re-check — a duplicate CustTable on a bad config day.
    packagesRoot.value = UNREACHABLE_ROOT;
    expect(await indexedPathIsMissing(GHOST)).toBe(false);
  });

  it('says nothing when no packages root is configured at all', async () => {
    packagesRoot.value = null;
    expect(await indexedPathIsMissing(GHOST)).toBe(false);
  });

  it('does not report one that remaps onto a file that is here', async () => {
    mockResolveDbPathLocally.mockResolvedValue('K:\\other\\ConSK_QualityTier.xml');
    expect(await indexedPathIsMissing(GHOST)).toBe(false);
  });

  it('never judges a path outside PackagesLocalDirectory', async () => {
    // Unreachable is not deleted — calling a build-agent row stale would tell the
    // agent to re-create objects that exist perfectly well.
    expect(await indexedPathIsMissing(BUILD_AGENT)).toBe(false);
    expect(mockResolveDbPathLocally).not.toHaveBeenCalled();
  });

  it('says nothing for a row with no path at all', async () => {
    expect(await indexedPathIsMissing(null)).toBe(false);
    expect(await indexedPathIsMissing(undefined)).toBe(false);
    expect(await indexedPathIsMissing('')).toBe(false);
  });
});

describe('resolveIndexedObject — sourceFileMissing', () => {
  beforeEach(() => {
    mockResolveDbPathLocally.mockReset();
    mockResolveDbPathLocally.mockResolvedValue(null);
    mockLookupSymbolNocase.mockReset();
    packagesRoot.value = REACHABLE_ROOT;
  });

  it('does not flag anything while the packages root is unreachable', async () => {
    // Same guard as indexedPathIsMissing, and it has to be the same answer: the
    // two describe one row, and a reader that got them from different helpers
    // would otherwise print a ghost warning one call and not the next.
    packagesRoot.value = UNREACHABLE_ROOT;
    mockLookupSymbolNocase.mockReturnValue({ name: 'ConSK_QualityTier', model: 'ContosoFinanceSK', file_path: GHOST });

    const ref = await resolveIndexedObject({}, 'ConSK_QualityTier', ['enum']);

    expect(ref?.sourceFileMissing).toBe(false);
  });

  it('flags a row whose file is gone', async () => {
    mockLookupSymbolNocase.mockReturnValue({ name: 'ConSK_QualityTier', model: 'ContosoFinanceSK', file_path: GHOST });

    const ref = await resolveIndexedObject({}, 'ConSK_QualityTier', ['enum']);

    expect(ref?.sourceFileMissing).toBe(true);
    expect(ref?.localPath).toBeNull();
  });

  it('does not flag a row that resolves to a readable file', async () => {
    mockLookupSymbolNocase.mockReturnValue({ name: 'NoYes', model: 'Foundation', file_path: GHOST });
    mockResolveDbPathLocally.mockResolvedValue('K:\\real\\NoYes.xml');

    const ref = await resolveIndexedObject({}, 'NoYes', ['enum']);

    expect(ref?.sourceFileMissing).toBe(false);
    expect(ref?.localPath).toBe('K:\\real\\NoYes.xml');
  });

  it('does not flag an unreachable build-agent row', async () => {
    mockLookupSymbolNocase.mockReturnValue({ name: 'NoYes', model: 'Foundation', file_path: BUILD_AGENT });

    const ref = await resolveIndexedObject({}, 'NoYes', ['enum']);

    expect(ref?.sourceFileMissing).toBe(false);
  });
});

describe('the warning itself', () => {
  it('names the path, tells the caller to create, and tells it not to re-check', async () => {
    const note = renderStaleIndexNote('ConSK_QualityTier', GHOST);

    expect(note).toContain('STALE INDEX ENTRY');
    expect(note).toContain(GHOST);
    expect(note).toMatch(/NOT EXISTING/);
    // The 20-odd calls that went into proving the ghost was a ghost are the cost
    // this line exists to remove.
    expect(note).toMatch(/Do not spend calls proving this/i);
    expect(note).toContain('update_symbol_index');
  });

  it('is silent for a healthy row', () => {
    expect(staleIndexNote({
      name: 'NoYes', model: 'Foundation', indexedPath: GHOST,
      localPath: 'K:\\real\\NoYes.xml', sourceFileMissing: false,
    })).toBe('');
  });

  it('rides along on the provenance footer readers already print', () => {
    const withRef = indexedSourceNote('symbol index (extracted metadata)', {
      name: 'ConSK_QualityTier', model: 'ContosoFinanceSK', indexedPath: GHOST,
      localPath: null, sourceFileMissing: true,
    });
    expect(withRef).toContain('the C# bridge returned no data');
    expect(withRef).toContain('STALE INDEX ENTRY');

    // Callers that pass no ref keep the footer they had.
    expect(indexedSourceNote('symbol index')).not.toContain('STALE INDEX ENTRY');
  });
});
