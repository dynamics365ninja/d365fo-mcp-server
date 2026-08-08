/**
 * Index staleness detection tests.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  findNewestMetadataMtime, checkIndexStaleness, resetMetadataMtimeCache,
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
