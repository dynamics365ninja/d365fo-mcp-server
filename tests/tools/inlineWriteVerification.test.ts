/**
 * Verify the write in the call that made it.
 *
 * The conventional loop was create → verify_d365fo_project → run_bp_check: two
 * extra round trips per object, both asking questions the writing call already
 * had the answers to.
 *
 * The negative case is the one that earns its keep: this project has a
 * documented history of writes that report ✅ and leave nothing usable behind
 * (empty security objects, tables with no fields, files absent from the
 * .rnrproj). A success message that has actually looked at the disk is a
 * different claim from one that has not.
 *
 * But a false alarm costs more than no alarm. The first version of this check
 * resolved the .rnrproj `Content Include` against the project directory and
 * compared it to the absolute .xml path, and the fixture below used to make
 * that work: project and metadata in one tree, `.xml` in the Include. Neither
 * holds in a real installation — projects live in a repo, metadata under
 * PackagesLocalDirectory, and Includes are extensionless — so the check was
 * false on every write. Twelve such warnings in one session taught the agent to
 * disregard the warning, and it then disregarded the true one. The fixture is
 * now the real layout, and the tests below are what the old fixture hid.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { verifyWrittenFile, renderWriteVerification } from '../../src/tools/write/inlineWriteVerification';
import type { Membership } from '../../src/workspace/projectMembership';

let base: string;
let xmlPath: string;
let orphanPath: string;
let activeProject: string;
let owningProject: string;

/** A .rnrproj whose Content Includes are model-relative and extensionless. */
function writeProject(at: string, includes: string[]): void {
  fs.mkdirSync(path.dirname(at), { recursive: true });
  fs.writeFileSync(
    at,
    `<Project><PropertyGroup><Model>MyModel</Model></PropertyGroup><ItemGroup>` +
      includes.map(i => `<Content Include="${i}"><Name>x</Name></Content>`).join('') +
      `</ItemGroup></Project>`,
  );
}

beforeAll(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'inlineverify-'));

  // Metadata: <base>\packages\MyPackage\MyModel\AxTable\*.xml
  const modelDir = path.join(base, 'packages', 'MyPackage', 'MyModel', 'AxTable');
  fs.mkdirSync(modelDir, { recursive: true });
  xmlPath = path.join(modelDir, 'ContosoXyzTable.xml');
  fs.writeFileSync(xmlPath, '<AxTable><Name>ContosoXyzTable</Name></AxTable>');
  orphanPath = path.join(modelDir, 'ContosoOrphan.xml');
  fs.writeFileSync(orphanPath, '<AxTable/>');

  // Projects: a different tree entirely, as in a real repo checkout.
  activeProject = path.join(base, 'repo', 'MyModel - Active', 'MyModel - Active.rnrproj');
  owningProject = path.join(base, 'repo', 'MyModel - Owning', 'MyModel - Owning.rnrproj');
  writeProject(activeProject, ['AxTable\\SomethingElse']);
  writeProject(owningProject, ['AxTable\\ContosoXyzTable']);
});

afterAll(() => {
  try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* best-effort */ }
});

const table = (name: string, siblings: string[] = []) => ({
  axFolder: 'AxTable',
  objectName: name,
  siblingProjectPaths: siblings,
});

describe('verifyWrittenFile — disk', () => {
  it('confirms a file that is really on disk', async () => {
    const v = await verifyWrittenFile(xmlPath);
    expect(v.onDisk).toBe(true);
    expect(v.bytes).toBeGreaterThan(0);
  });

  it('reports a missing file as not on disk', async () => {
    expect((await verifyWrittenFile(path.join(base, 'nope.xml'))).onDisk).toBe(false);
  });

  it('treats an empty file as not written', async () => {
    const empty = path.join(base, 'empty.xml');
    fs.writeFileSync(empty, '');
    expect((await verifyWrittenFile(empty)).onDisk).toBe(false);
  });

  it('never throws on a bad path', async () => {
    await expect(verifyWrittenFile(undefined)).resolves.toMatchObject({ onDisk: false });
  });
});

describe('verifyWrittenFile — project membership', () => {
  it('matches an extensionless, model-relative Include across separate trees', async () => {
    // The regression: the project lives in a repo, the file under packages, and
    // the Include is "AxTable\ContosoXyzTable". Any path resolution says no.
    const v = await verifyWrittenFile(xmlPath, owningProject, table('ContosoXyzTable'));
    expect(v.membership?.status).toBe('active');
  });

  it('reports a file registered in a sibling project as registered, not missing', async () => {
    const v = await verifyWrittenFile(
      xmlPath, activeProject, table('ContosoXyzTable', [owningProject]),
    );
    expect(v.membership?.status).toBe('other');
    expect(v.membership?.owners).toEqual([owningProject]);
  });

  it('reports missing only when no project of the model has it', async () => {
    const v = await verifyWrittenFile(
      orphanPath, activeProject, table('ContosoOrphan', [owningProject]),
    );
    expect(v.membership?.status).toBe('missing');
  });

  it('ignores case drift between the file name and the Include', async () => {
    // The generators write "…CtsoFinExtension" where the XML says
    // "…CtsoFINExtension"; VS does not care and neither should this.
    const v = await verifyWrittenFile(xmlPath, owningProject, table('contosoXYZtable'));
    expect(v.membership?.status).toBe('active');
  });

  it('says nothing about the project when the .rnrproj is unreadable', async () => {
    const v = await verifyWrittenFile(
      xmlPath, path.join(base, 'missing.rnrproj'), table('ContosoXyzTable'),
    );
    expect(v.membership?.status).toBe('unknown');
  });

  it('asks nothing when the caller supplies no membership target', async () => {
    const v = await verifyWrittenFile(xmlPath, owningProject);
    expect(v.membership).toBeUndefined();
  });
});

const m = (status: Membership['status'], owners: string[] = []): Membership => ({ status, owners });

describe('renderWriteVerification', () => {
  it('contradicts the ✅ when the file is not there', () => {
    const text = renderWriteVerification({ onDisk: false });
    expect(text).toContain('NOT on disk');
    expect(text).toMatch(/treat this write as failed/i);
  });

  it('warns only when no project of the model references the file', () => {
    const text = renderWriteVerification({
      onDisk: true, bytes: 120, membership: m('missing'), axFolder: 'AxTable', objectName: 'T',
    });
    expect(text).toMatch(/no \.rnrproj of this model/i);
    expect(text).toMatch(/will not compile/i);
  });

  it('names the owning project instead of crying missing', () => {
    const text = renderWriteVerification({
      onDisk: true,
      bytes: 120,
      membership: m('other', ['K:\\repo\\MyModel - Owning.rnrproj']),
      axFolder: 'AxTable',
      objectName: 'T',
    });
    expect(text).toContain('MyModel - Owning');
    expect(text).toMatch(/do not add it again/i);
    expect(text).not.toMatch(/will not compile/i);
  });

  it('stays to one line when the active project has it', () => {
    const text = renderWriteVerification({
      onDisk: true, bytes: 120, membership: m('active', ['p.rnrproj']),
    });
    expect(text.trim().split('\n')).toHaveLength(1);
    expect(text).toContain('Verified');
  });

  it('does not claim anything about the project when it could not tell', () => {
    const text = renderWriteVerification({ onDisk: true, bytes: 120, membership: m('unknown') });
    expect(text).not.toMatch(/rnrproj/i);
    expect(text).toContain('Verified');
  });
});
