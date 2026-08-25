/**
 * Index staleness detection tests.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  findNewestMetadataMtime, findNewestMetadataMtimeCached, checkIndexStaleness,
  resetMetadataMtimeCache,
} from '../../src/utils/indexStaleness';
import { XppSymbolIndex } from '../../src/metadata/symbolIndex';

let tmpDir: string;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'staleness-test-'));
  fs.mkdirSync(path.join(tmpDir, 'MyModel', 'AxClass'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, 'MyModel', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, 'MyModel', 'AxClass', 'ContosoHelper.xml'), '<AxClass/>');
  fs.writeFileSync(path.join(tmpDir, 'MyModel', 'bin', 'ignored.xml'), '<x/>'); // bin is skipped
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('findNewestMetadataMtime', () => {
  it('finds the newest xml file and skips bin folders', () => {
    const result = findNewestMetadataMtime(path.join(tmpDir, 'MyModel'));
    expect(result).not.toBeNull();
    expect(result!.newestFile).toContain('ContosoHelper.xml');
    expect(result!.scannedFiles).toBe(1); // bin/ignored.xml not counted
  });

  it('returns null for a missing directory', () => {
    expect(findNewestMetadataMtime(path.join(tmpDir, 'DoesNotExist'))).toBeNull();
  });

  it('returns null for a directory without metadata files', () => {
    const empty = path.join(tmpDir, 'Empty');
    fs.mkdirSync(empty, { recursive: true });
    expect(findNewestMetadataMtime(empty)).toBeNull();
  });
});

describe('checkIndexStaleness', () => {
  it('reports unknown when no timestamp exists', () => {
    const report = checkIndexStaleness(null, path.join(tmpDir, 'MyModel'));
    expect(report.status).toBe('unknown');
    expect(report.lines.join('\n')).toContain('no freshness timestamp');
  });

  it('reports stale when workspace files are newer than the index', () => {
    const oldIndex = new Date(Date.now() - 24 * 3_600_000).toISOString();
    const report = checkIndexStaleness(oldIndex, path.join(tmpDir, 'MyModel'));
    expect(report.status).toBe('stale');
    const text = report.lines.join('\n');
    expect(text).toContain('INDEX IS STALE');
    expect(text).toContain('update_symbol_index');
  });

  it('reports fresh when the index is newer than all files', () => {
    const futureIndex = new Date(Date.now() + 3_600_000).toISOString();
    const report = checkIndexStaleness(futureIndex, path.join(tmpDir, 'MyModel'));
    expect(report.status).toBe('fresh');
    expect(report.lines.join('\n')).toContain('up to date');
  });

  it('reports unknown when the model dir cannot be resolved', () => {
    const report = checkIndexStaleness(new Date().toISOString(), null);
    expect(report.status).toBe('unknown');
  });
});

describe('checkIndexStaleness compact lines', () => {
  it('is one line when the index is fresh', () => {
    // get_workspace_info's default output pays for this on every call, and a
    // fresh index needs no scan detail — there is nothing to act on.
    const report = checkIndexStaleness(new Date(Date.now() + 3_600_000).toISOString(), path.join(tmpDir, 'MyModel'));
    expect(report.compactLines).toHaveLength(1);
    expect(report.compactLines[0]).toContain('up to date');
  });

  it('keeps the fix reachable when the index is stale', () => {
    const report = checkIndexStaleness(new Date(Date.now() - 24 * 3_600_000).toISOString(), path.join(tmpDir, 'MyModel'));
    const text = report.compactLines.join('\n');
    expect(report.compactLines).toHaveLength(2);
    expect(text).toContain('STALE');
    expect(text).toContain('update_symbol_index');
  });
});

describe('findNewestMetadataMtime scan cache', () => {
  // get_workspace_info ran this scan on every call: up to 5000 synchronous
  // statSync calls, 1-3 s of blocked event loop on Windows, uncached and outside
  // the in-flight dedup.
  let cacheDir: string;

  beforeAll(() => {
    cacheDir = path.join(tmpDir, 'CacheModel', 'AxClass');
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(path.join(cacheDir, 'First.xml'), '<AxClass/>');
  });

  it('does not re-walk the tree for a repeated call on the same root', () => {
    const root = path.join(tmpDir, 'CacheModel');
    resetMetadataMtimeCache();

    expect(findNewestMetadataMtime(root)!.scannedFiles).toBe(1);
    fs.writeFileSync(path.join(cacheDir, 'Second.xml'), '<AxClass/>');

    expect(findNewestMetadataMtime(root)!.scannedFiles).toBe(1);

    resetMetadataMtimeCache();
    expect(findNewestMetadataMtime(root)!.scannedFiles).toBe(2);
  });
});

describe('non-blocking freshness scan (audit 2026-08-25)', () => {
  // get_workspace_info averaged 31.5 s over 31 real calls and is neither
  // bridge-gated nor DB-gated: the cost was inside the tool, and this walk —
  // up to 5,000 synchronous statSync calls — was part of it. It cannot be made
  // cheap, so it stops being the thing the first call of a session waits for.
  const root = () => path.join(tmpDir, 'MyModel');

  it('answers "pending" on a cold cache instead of walking the tree', () => {
    resetMetadataMtimeCache();
    expect(findNewestMetadataMtimeCached(root(), { blocking: false })).toEqual({ status: 'pending' });
  });

  it('has the real answer once the background scan has run', async () => {
    resetMetadataMtimeCache();
    findNewestMetadataMtimeCached(root(), { blocking: false });

    // Poll to a deadline rather than sleeping a fixed 20 ms. The scan is a real
    // filesystem walk on a background tick; 20 ms is comfortable on an idle dev
    // box and not on a loaded CI runner, which is a flake that looks like a
    // broken cache. Polling finishes as fast as the scan does.
    let state = findNewestMetadataMtimeCached(root(), { blocking: false });
    const deadline = Date.now() + 5000;
    while (state.status !== 'ready' && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 5));
      state = findNewestMetadataMtimeCached(root(), { blocking: false });
    }

    expect(state.status).toBe('ready');
    expect(state.status === 'ready' && state.result!.newestFile).toContain('ContosoHelper.xml');
  });

  it('blocking:true is the old behaviour — scan now, answer now', () => {
    resetMetadataMtimeCache();
    const state = findNewestMetadataMtimeCached(root(), { blocking: true });
    expect(state.status).toBe('ready');
  });

  it('checkIndexStaleness says the verdict is pending rather than hiding it', () => {
    resetMetadataMtimeCache();
    const report = checkIndexStaleness(new Date().toISOString(), root(), { blocking: false });

    expect(report.status).toBe('pending');
    // Named, not absent — and both ways to the real answer are on the line.
    expect(report.compactLines.join('\n')).toContain('background');
    expect(report.compactLines.join('\n')).toContain('diagnostics=true');
    expect(report.compactLines).toHaveLength(1);
  });

  it('checkIndexStaleness still blocks by default, so existing callers are unchanged', () => {
    resetMetadataMtimeCache();
    const report = checkIndexStaleness(new Date(Date.now() - 24 * 3_600_000).toISOString(), root());
    expect(report.status).toBe('stale');
  });
});

describe('symbolIndex last_indexed_at bookkeeping', () => {
  it('touchLastIndexed/getLastIndexedAt round-trips an ISO timestamp', () => {
    const index = new XppSymbolIndex(':memory:', ':memory:');
    try {
      expect(index.getLastIndexedAt()).toBeNull();
      index.touchLastIndexed();
      const ts = index.getLastIndexedAt();
      expect(ts).toBeTruthy();
      expect(Number.isNaN(Date.parse(ts!))).toBe(false);
    } finally {
      index.close();
    }
  });
});
