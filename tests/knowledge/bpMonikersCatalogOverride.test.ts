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

  it('falls back to the compiled default when the override has an EMPTY entries array', async () => {
    // Reachable from a *successful* extraction: a packages root with a bin\
    // folder but no AxRuleSet/BPRules.xml and no BP rule DLLs exits 0 with zero
    // entries. Taking it at face value would replace the whole catalog with
    // nothing — every validate misses, every search is empty — which is the
    // opposite of what this module guarantees.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const mod = await loadWithOverride(JSON.stringify({ version: '10.0.9999.1', entries: [] }));
    expect(mod.BP_MONIKER_CATALOG).toEqual(COMPILED_CATALOG);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('drops entries with no string moniker instead of throwing at import', async () => {
    // BY_MONIKER is built outside loadCatalog's try/catch, so an entry missing
    // `moniker` used to throw during module evaluation and take the server down
    // with it — the one failure mode the fallback exists to prevent.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const mod = await loadWithOverride(JSON.stringify({
      version: '10.0.9999.1',
      entries: [
        { moniker: 'CUSTestMoniker', message: 'A test message', description: null, canonical: true },
        { message: 'no moniker at all', canonical: false },
        null,
      ],
    }));
    expect(mod.BP_MONIKER_CATALOG.map(e => e.moniker)).toEqual(['CUSTestMoniker']);
    expect(mod.validateMoniker('CUSTestMoniker').found).toBe(true);
    warn.mockRestore();
  });

  it('reads a catalog written with a UTF-8 BOM', async () => {
    // Windows PowerShell 5.1's `Set-Content -Encoding utf8` prepends one, so any
    // catalog generated before extract-bp-catalog.ps1 switched to WriteAllText
    // carries it. JSON.parse throws on the leading \uFEFF, and the resulting
    // fallback is silent — the feature just quietly does nothing.
    const mod = await loadWithOverride('\uFEFF' + JSON.stringify({
      version: '10.0.9999.1',
      entries: [{ moniker: 'CUSBomMoniker', message: null, description: null, canonical: true }],
    }));
    expect(mod.validateMoniker('CUSBomMoniker').found).toBe(true);
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
