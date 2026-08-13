/**
 * bpMonikers/index.ts loads BP_MONIKER_CATALOG from BP_CATALOG_PATH when it
 * points at a valid per-instance catalog (see ensureBpCatalogFresh in
 * src/cli/commands/bpCatalog.ts), and falls back to the compiled-in
 * catalog.generated.ts snapshot — silently, never throwing — when the
 * override is absent, missing, or malformed. The module reads the env var
 * once at import time, so each case reloads it fresh via vi.resetModules().
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BP_MONIKER_CATALOG as COMPILED_CATALOG } from '../../src/knowledge/bpMonikers/catalog.generated.js';

const ORIGINAL_BP_CATALOG_PATH = process.env.BP_CATALOG_PATH;
let dir: string | null = null;

afterEach(() => {
  if (ORIGINAL_BP_CATALOG_PATH === undefined) delete process.env.BP_CATALOG_PATH;
  else process.env.BP_CATALOG_PATH = ORIGINAL_BP_CATALOG_PATH;
  vi.resetModules();
  if (dir) { rmSync(dir, { recursive: true, force: true }); dir = null; }
});

async function loadWithOverride(catalogFileContent: string | undefined) {
  vi.resetModules();
  if (catalogFileContent === undefined) {
    delete process.env.BP_CATALOG_PATH;
  } else {
    dir = mkdtempSync(join(tmpdir(), 'bp-catalog-'));
    const file = join(dir, 'bp-moniker-catalog.json');
    writeFileSync(file, catalogFileContent, 'utf-8');
    process.env.BP_CATALOG_PATH = file;
  }
  return import('../../src/knowledge/bpMonikers/index.js');
}

describe('bpMonikers catalog override', () => {
  it('uses the compiled default when BP_CATALOG_PATH is unset', async () => {
    const mod = await loadWithOverride(undefined);
    expect(mod.BP_MONIKER_CATALOG).toEqual(COMPILED_CATALOG);
  });

  it('uses the per-instance catalog when BP_CATALOG_PATH points at a valid file', async () => {
    const mod = await loadWithOverride(JSON.stringify({
      version: '10.0.9999.1',
      entries: [{ moniker: 'CUSTestMoniker', message: 'A test message', description: null, canonical: true }],
    }));
    expect(mod.BP_MONIKER_CATALOG).toEqual([
      { moniker: 'CUSTestMoniker', message: 'A test message', description: null, canonical: true },
    ]);
    expect(mod.validateMoniker('CUSTestMoniker').found).toBe(true);
  });

  it('falls back to the compiled default when the override file has no entries array', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const mod = await loadWithOverride(JSON.stringify({ version: '10.0.9999.1' }));
    expect(mod.BP_MONIKER_CATALOG).toEqual(COMPILED_CATALOG);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('falls back to the compiled default when BP_CATALOG_PATH points at a missing file', async () => {
    vi.resetModules();
    process.env.BP_CATALOG_PATH = join(tmpdir(), 'does-not-exist-bp-catalog.json');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const mod = await import('../../src/knowledge/bpMonikers/index.js');
    expect(mod.BP_MONIKER_CATALOG).toEqual(COMPILED_CATALOG);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
