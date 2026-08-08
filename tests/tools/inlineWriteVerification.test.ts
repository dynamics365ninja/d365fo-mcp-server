/**
 * Phase 1.4 — verify the write in the call that made it.
 *
 * The conventional loop was create → verify_d365fo_project → run_bp_check: two
 * extra round trips per object, both asking questions the writing call already
 * had the answers to. It knows the path it wrote and the project it registered
 * the file in; checking that the bytes are on disk and that the .rnrproj really
 * references them is two filesystem reads, not a round trip.
 *
 * The negative case is the one that earns its keep: this project has a
 * documented history of writes that report ✅ and leave nothing usable behind
 * (empty security objects, tables with no fields, files absent from the
 * .rnrproj). A success message that has actually looked at the disk is a
 * different claim from one that has not.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { verifyWrittenFile, renderWriteVerification } from '../../src/tools/inlineWriteVerification';

let base: string;
let xmlPath: string;
let projectPath: string;

beforeAll(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'inlineverify-'));
  const modelDir = path.join(base, 'MyPackage', 'MyModel', 'AxTable');
  fs.mkdirSync(modelDir, { recursive: true });
  xmlPath = path.join(modelDir, 'ContosoXyzTable.xml');
  fs.writeFileSync(xmlPath, '<AxTable><Name>ContosoXyzTable</Name></AxTable>');

  projectPath = path.join(base, 'MyPackage', 'MyModel', 'MyModel.rnrproj');
  // Includes are project-RELATIVE and Windows-relative — the check has to resolve
  // them, not string-compare, or a legitimate entry reads as missing.
  fs.writeFileSync(projectPath,
    `<Project><ItemGroup><Content Include="AxTable\\ContosoXyzTable.xml" /></ItemGroup></Project>`);
});

afterAll(() => {
  try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* best-effort */ }
});

describe('verifyWrittenFile', () => {
  it('confirms a file that is really on disk', async () => {
    const v = await verifyWrittenFile(xmlPath);
    expect(v.onDisk).toBe(true);
    expect(v.bytes).toBeGreaterThan(0);
  });

  it('reports a missing file as not on disk', async () => {
    const v = await verifyWrittenFile(path.join(base, 'nope.xml'));
    expect(v.onDisk).toBe(false);
  });

  it('treats an empty file as not written', async () => {
    const empty = path.join(base, 'empty.xml');
    fs.writeFileSync(empty, '');
    const v = await verifyWrittenFile(empty);
    expect(v.onDisk).toBe(false);
  });

  it('resolves a project-relative Include rather than string-comparing it', async () => {
    const v = await verifyWrittenFile(xmlPath, projectPath);
    expect(v.inProject).toBe(true);
  });

  it('reports a file the .rnrproj does not reference', async () => {
    const orphan = path.join(path.dirname(xmlPath), 'ContosoOrphan.xml');
    fs.writeFileSync(orphan, '<AxTable/>');
    const v = await verifyWrittenFile(orphan, projectPath);
    expect(v.inProject).toBe(false);
  });

  it('says nothing about the project when the .rnrproj is unreadable', async () => {
    // An absent project file is not evidence either way — reporting "not
    // registered" there would be a false alarm on a write that was fine.
    const v = await verifyWrittenFile(xmlPath, path.join(base, 'missing.rnrproj'));
    expect(v.inProject).toBeUndefined();
  });

  it('never throws on a bad path', async () => {
    await expect(verifyWrittenFile(undefined)).resolves.toMatchObject({ onDisk: false });
  });
});

describe('renderWriteVerification', () => {
  it('contradicts the ✅ when the file is not there', () => {
    const text = renderWriteVerification({ onDisk: false });
    expect(text).toContain('NOT on disk');
    expect(text).toMatch(/treat this write as failed/i);
  });

  it('warns when the .rnrproj does not reference the file', () => {
    const text = renderWriteVerification({ onDisk: true, bytes: 120, inProject: false });
    expect(text).toContain('does NOT reference');
    expect(text).toMatch(/will not compile/i);
  });

  it('stays to one line when everything is fine', () => {
    const text = renderWriteVerification({ onDisk: true, bytes: 120, inProject: true });
    expect(text.trim().split('\n')).toHaveLength(1);
    expect(text).toContain('Verified');
  });

  it('does not claim anything about the project when it could not tell', () => {
    const text = renderWriteVerification({ onDisk: true, bytes: 120 });
    expect(text).not.toMatch(/rnrproj/i);
    expect(text).toContain('Verified');
  });
});
