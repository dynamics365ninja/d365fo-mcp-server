/**
 * Regression (eval L2 / TOOL_DEFECT): a D365FO model directory symlinked under
 * the allowed PackagesLocalDirectory root (e.g. PLD/<Model> → a repo checkout)
 * must not be rejected by the write-path containment guard. realpath-only
 * comparison resolved the file out to the symlink target and wrongly reported
 * "Refusing to write outside configured D365FO package roots".
 */

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

const ctx = vi.hoisted(() => {
  const os = require('os');
  const fs = require('fs');
  const path = require('path');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pcsym-'));
  return { base, pld: path.join(base, 'pld'), real: path.join(base, 'realstore') };
});

vi.mock('../../src/utils/configManager.js', () => ({
  getConfigManager: () => ({
    ensureLoaded: async () => {},
    getPackagePath: () => ctx.pld,          // the allowed root (contains the symlink)
    getCustomPackagesPath: async () => null,
    getMicrosoftPackagesPath: async () => null,
  }),
  fallbackPackagePath: () => 'C:/never',
}));

import * as fs from 'fs';
import * as path from 'path';
import { assertWritePathAllowed } from '../../src/utils/pathContainment.js';

let symlinkOk = true;
const MODEL = 'contoso';

beforeAll(() => {
  // Real store: <real>/contoso/contoso/AxTable/Foo.xml
  const realModelRoot = path.join(ctx.real, MODEL);
  const realAxTable = path.join(realModelRoot, MODEL, 'AxTable');
  fs.mkdirSync(realAxTable, { recursive: true });
  fs.writeFileSync(path.join(realAxTable, 'Foo.xml'), '<AxTable><Name>Foo</Name></AxTable>');

  // Allowed root: <pld>, with <pld>/contoso symlinked to the real model root.
  fs.mkdirSync(ctx.pld, { recursive: true });
  try {
    const type = process.platform === 'win32' ? 'junction' : 'dir';
    fs.symlinkSync(realModelRoot, path.join(ctx.pld, MODEL), type);
  } catch {
    symlinkOk = false; // e.g. no privilege — skip the symlink assertions
  }
});

afterAll(() => {
  try { fs.rmSync(ctx.base, { recursive: true, force: true }); } catch { /* best-effort */ }
});

describe('pathContainment — symlinked model directory under an allowed root', () => {
  it('allows a write reached through the PLD/<Model> symlink', async () => {
    if (!symlinkOk) return; // environment can't create symlinks — skip
    const viaSymlink = path.join(ctx.pld, MODEL, MODEL, 'AxTable', 'Foo.xml');
    const r = await assertWritePathAllowed(viaSymlink, MODEL);
    expect(r.ok).toBe(true);
  });

  it('rejects a raw path into the symlink target that is NOT reached via an allowed root', async () => {
    if (!symlinkOk) return;
    // The symlink TARGET tree (<real>/…) is not itself a configured root — only
    // access through the allowed PLD root is trusted. A bare target path is
    // correctly outside the boundary (use the PLD path, or configure the target
    // as a custom packages root).
    const realForm = path.join(ctx.real, MODEL, MODEL, 'AxTable', 'Foo.xml');
    const r = await assertWritePathAllowed(realForm, MODEL);
    expect(r.ok).toBe(false);
  });

  it('still rejects an unrelated path outside every root', async () => {
    const r = await assertWritePathAllowed('K:\\Repos\\evil\\AxTable\\Foo.xml', MODEL);
    expect(r.ok).toBe(false);
  });
});
