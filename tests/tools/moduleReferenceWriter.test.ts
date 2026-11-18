/**
 * The descriptor write path end-to-end on a real file:
 * directXmlAdd/RemoveModuleReference.
 *
 * The transforms themselves are covered in tests/metadata/modelDescriptorWrite —
 * what is covered here is everything the WRITER adds on top and the pure
 * functions cannot see: that a duplicate leaves the file byte-identical rather
 * than merely reporting so, that a UTF-8 BOM survives, that CRLF is what lands
 * on disk, and that the refusals report success:false instead of null (a null
 * from a direct-XML writer is rendered as "the C# bridge could not resolve the
 * object", about an operation that never touched the bridge).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  directXmlAddModuleReference,
  directXmlRemoveModuleReference,
  directXmlInternalsVisibleTo,
} from '../../src/tools/write/directXmlWriters';
import { canBridgeModify } from '../../src/bridge/bridgeAdapter';
import { D365FO_FILE_OP_SPECS, getRequiredParams } from '../../src/tools/specs/d365foFileOpSpecs';
import { d365foFileTool } from '../../src/server/toolSchemas/d365foFile';
import { axFolderForObjectType, objectTypeForAxFolder, hasAxFolder } from '../../src/workspace/projectMembership';
import { membershipOf } from '../../src/tools/write/inlineWriteVerification';
import { getModelVisibility } from '../../src/metadata/modelDescriptor';

const BOM = '﻿';

const descriptorLf =
  `<?xml version="1.0" encoding="utf-8"?>\n` +
  `<AxModelInfo xmlns:d2p1="http://schemas.microsoft.com/2003/10/Serialization/Arrays">\n` +
  `  <Name>Contoso</Name>\n` +
  `  <ModuleReferences>\n` +
  `    <d2p1:string>ApplicationSuite</d2p1:string>\n` +
  `  </ModuleReferences>\n` +
  `</AxModelInfo>`;

let dir: string;
let file: string;

/** Write a descriptor as Visual Studio does: BOM + CRLF. */
async function seed(content = descriptorLf): Promise<void> {
  await fs.writeFile(file, BOM + content.replace(/\n/g, '\r\n'), 'utf-8');
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'descriptor-writer-'));
  file = path.join(dir, 'Contoso.xml');
  await seed();
});

// `dir` IS the mkdtemp folder, so this removes exactly it. The previous
// afterAll removed `path.dirname(dir)` — that is os.tmpdir() itself — and
// deleted every file in %TEMP% on each run, with the errors on locked files
// swallowed by a .catch. tests/tmpdirGuard.globalSetup.ts now fails the run
// if any test does that again.
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('the ops are actually REACHABLE from the tool surface', () => {
  // The trap this guards is documented in bridgeAdapter.ts: add-entry-point
  // shipped its schema entry, op-spec, dispatcher case and writer without ever
  // being named in BRIDGE_MODIFY_OPS, so canBridgeModify short-circuited and the
  // whole feature was dead code behind a published enum value. BOTH that set and
  // XML_ONLY_MODIFY_PAIRS have to name an op; either alone still returns false.
  for (const op of ['add-module-reference', 'remove-module-reference']) {
    it(`${op} clears the modify dispatch gate on model-descriptor`, () => {
      expect(canBridgeModify('model-descriptor', op)).toBe(true);
    });

    it(`${op} is published, has an op-spec, and takes moduleReference or internalsVisibleTo`, () => {
      const published: string[] = (d365foFileTool.inputSchema.properties as any).operation.enum;
      expect(published).toContain(op);
      expect(D365FO_FILE_OP_SPECS[op]).toBeDefined();
      expect(D365FO_FILE_OP_SPECS[op].optional).toEqual(['moduleReference', 'internalsVisibleTo']);
      expect(getRequiredParams(op)).toEqual([]);
    });

  }

  it('model-descriptor does not accept operations meant for AOT objects', () => {
    // The pairing is per-operation on purpose: dropping model-descriptor into
    // BRIDGE_MODIFY_TYPES would also claim add-method and modify-property work
    // on a descriptor, which they do not.
    for (const op of ['add-method', 'modify-property', 'add-field', 'add-control']) {
      expect(canBridgeModify('model-descriptor', op), op).toBe(false);
    }
  });

  it('model-descriptor is published as an objectType', () => {
    const types: string[] = (d365foFileTool.inputSchema.properties as any).objectType.enum;
    expect(types).toContain('model-descriptor');
  });

  it('has no AOT folder, so no .rnrproj membership question is asked about it', () => {
    // Two live runs reported this under a write that had SUCCEEDED:
    //   "No .rnrproj of this model references `AxClass\<Model>`
    //    — it will not compile until one does."
    // A descriptor belongs to the package, not to any project in it, and the
    // folder is invented: axFolderForObjectType falls back to 'AxClass' for a
    // type it has no entry for. The first fix guarded modifyD365File's
    // single-operation path only, and the batch wrapper reproduced it verbatim
    // on the next run — so the guard moved into membershipOf, which every
    // caller goes through.
    expect(axFolderForObjectType('model-descriptor')).toBe('AxClass');
    expect(objectTypeForAxFolder('Descriptor')).toBeUndefined();
    expect(hasAxFolder('model-descriptor')).toBe(false);
    expect(membershipOf('model-descriptor', 'AnyModel', 'AnyModel')).toBeUndefined();
  });

  it('still asks the membership question for every real AOT type', () => {
    // The gate must not silence types that genuinely belong in a .rnrproj —
    // including ignore-diagnostic-list, the other non-AOT-object write target,
    // which DOES live in an Ax* folder and does belong to a project.
    for (const t of ['class', 'table', 'form', 'table-extension', 'security-privilege',
                     'ignore-diagnostic-list']) {
      expect(hasAxFolder(t), t).toBe(true);
      expect(membershipOf(t, 'Foo', 'AnyModel'), t).toBeDefined();
    }
  });
});

describe('directXmlAddModuleReference', () => {
  it('adds the reference and keeps the BOM and CRLF the file came with', async () => {
    const r = await directXmlAddModuleReference(file, 'Ledger', '');
    expect(r?.success).toBe(true);

    const after = await fs.readFile(file, 'utf-8');
    expect(after.charCodeAt(0)).toBe(0xfeff);
    expect(after).toContain('\r\n');
    expect(after).not.toMatch(/[^\r]\n/);
    expect(after).toContain('<d2p1:string>Ledger</d2p1:string>');
    // One line added, nothing else touched.
    expect(after.replace(/\r/g, '')).toBe(
      BOM + descriptorLf.replace(
        '  </ModuleReferences>',
        '    <d2p1:string>Ledger</d2p1:string>\n  </ModuleReferences>',
      ),
    );
  });

  it('carries an unknown-module warning into the success message', async () => {
    const r = await directXmlAddModuleReference(file, 'Ledgre', '⚠️ No package folder named "Ledgre"\n');
    expect(r?.success).toBe(true);
    // The typo is written (it may exist on the build agent) but never silently.
    expect(r?.message).toContain('No package folder named "Ledgre"');
  });

  it('leaves the file BYTE-IDENTICAL on a duplicate', async () => {
    const before = await fs.readFile(file, 'utf-8');
    const r = await directXmlAddModuleReference(file, 'applicationsuite', '');
    expect(r?.success).toBe(false);
    expect(r?.message).toMatch(/already in <ModuleReferences>/i);
    // Reporting a duplicate and rewriting the file anyway would still produce a
    // diff on a reviewed file.
    expect(await fs.readFile(file, 'utf-8')).toBe(before);
  });

  it('refuses — not crashes, not nulls — when <ModuleReferences> is absent', async () => {
    await seed(`<?xml version="1.0" encoding="utf-8"?>\n<AxModelInfo>\n  <Name>Contoso</Name>\n</AxModelInfo>`);
    const before = await fs.readFile(file, 'utf-8');
    const r = await directXmlAddModuleReference(file, 'Ledger', '');
    expect(r).not.toBeNull();
    expect(r?.success).toBe(false);
    expect(r?.message).toMatch(/no <ModuleReferences> element/i);
    // The whole point: nothing is created implicitly.
    expect(await fs.readFile(file, 'utf-8')).toBe(before);
  });

  it('reports an unreadable file as an error rather than as a bridge failure', async () => {
    const missing = path.join(dir, 'NoSuchModel.xml');
    const r = await directXmlAddModuleReference(missing, 'Ledger', '');
    expect(r).not.toBeNull();
    expect(r?.success).toBe(false);
    expect(r?.message).toMatch(/Could not add the module reference/i);
  });

  it('tells the caller a full build is needed for the change to take effect', async () => {
    const r = await directXmlAddModuleReference(file, 'Ledger', '');
    expect(r?.message).toMatch(/FULL build/i);
  });
});

describe('directXmlRemoveModuleReference', () => {
  it('removes the reference and lists what is left', async () => {
    await directXmlAddModuleReference(file, 'Ledger', '');
    const r = await directXmlRemoveModuleReference(file, 'Ledger');
    expect(r?.success).toBe(true);
    expect(r?.message).toContain('Still referenced: ApplicationSuite');
    expect(await fs.readFile(file, 'utf-8')).not.toContain('Ledger');
  });

  it('warns that removing a reference can break a build that currently passes', async () => {
    const r = await directXmlRemoveModuleReference(file, 'ApplicationSuite');
    expect(r?.success).toBe(true);
    expect(r?.message).toMatch(/invisible to xppc/i);
    expect(r?.message).toContain('Still referenced: (nothing)');
  });

  it('leaves the file untouched and names what IS referenced on a miss', async () => {
    const before = await fs.readFile(file, 'utf-8');
    const r = await directXmlRemoveModuleReference(file, 'Tax');
    expect(r?.success).toBe(false);
    expect(r?.message).toContain('This model references: ApplicationSuite');
    expect(await fs.readFile(file, 'utf-8')).toBe(before);
  });

  it('refuses when there is no <ModuleReferences> element', async () => {
    await seed(`<AxModelInfo>\n  <Name>Contoso</Name>\n</AxModelInfo>`);
    const r = await directXmlRemoveModuleReference(file, 'Ledger');
    expect(r?.success).toBe(false);
    expect(r?.message).toMatch(/references no modules at all/i);
  });
});

describe('the visibility oracle follows a descriptor write', () => {
  // resolve_references memoises what a model may see. Without invalidation it
  // kept reporting not-visible-from-model — and telling the agent to add the
  // reference it had just added — until the server restarted.
  it('sees an added reference, then stops seeing it once removed', async () => {
    const root = path.join(dir, 'PackagesLocalDirectory');
    const descriptorDir = path.join(root, 'Contoso', 'Descriptor');
    await fs.mkdir(descriptorDir, { recursive: true });
    const target = path.join(descriptorDir, 'Contoso.xml');
    await fs.writeFile(target, descriptorLf, 'utf-8');

    expect(getModelVisibility(root, 'Contoso')?.visiblePackages.has('ledger')).toBe(false);

    expect((await directXmlAddModuleReference(target, 'Ledger', ''))?.success).toBe(true);
    expect(getModelVisibility(root, 'Contoso')?.visiblePackages.has('ledger')).toBe(true);

    expect((await directXmlRemoveModuleReference(target, 'Ledger'))?.success).toBe(true);
    expect(getModelVisibility(root, 'Contoso')?.visiblePackages.has('ledger')).toBe(false);
  });
});

describe('directXmlAddModuleReference name validation', () => {
  it('leaves the file BYTE-IDENTICAL for a name that is not a package folder', async () => {
    const before = await fs.readFile(file);
    const r = await directXmlAddModuleReference(file, 'Application Suite', '');
    expect(r?.success).toBe(false);
    expect(r?.message).toContain('not a package folder name');
    expect((await fs.readFile(file)).equals(before)).toBe(true);
  });
});

describe('InternalsVisibleTo through the same writers', () => {
  const ns = 'xmlns:d2p1="http://schemas.microsoft.com/2003/10/Serialization/Arrays"';
  const withIv = `<?xml version="1.0" encoding="utf-8"?>\n<AxModelInfo ${ns}>\n  <Name>Contoso</Name>\n` +
    `  <InternalsVisibleTo />\n  <ModuleReferences>\n    <d2p1:string>ApplicationSuite</d2p1:string>\n` +
    `  </ModuleReferences>\n</AxModelInfo>`;

  it('adds and removes a test model, BOM and CRLF intact, module references untouched', async () => {
    await seed(withIv);
    const added = await directXmlAddModuleReference(file, 'ContosoTests', '', 'InternalsVisibleTo');
    expect(added?.success, added?.message).toBe(true);
    expect(added?.message).toContain('InternalsVisibleTo');
    const after = await fs.readFile(file, 'utf-8');
    expect(after.charCodeAt(0)).toBe(0xfeff);
    expect(after).not.toMatch(/[^\r]\n/);
    expect(after.replace(/\r/g, '')).toContain(
      '  <InternalsVisibleTo>\n    <d2p1:string>ContosoTests</d2p1:string>\n  </InternalsVisibleTo>');
    expect(after).toContain('<d2p1:string>ApplicationSuite</d2p1:string>');

    const dup = await directXmlAddModuleReference(file, 'contosotests', '', 'InternalsVisibleTo');
    expect(dup?.success).toBe(false);
    expect(dup?.message).toMatch(/already in <InternalsVisibleTo>/);

    const removed = await directXmlRemoveModuleReference(file, 'ContosoTests', 'InternalsVisibleTo');
    expect(removed?.success, removed?.message).toBe(true);
    expect((await fs.readFile(file, 'utf-8')).replace(/\r/g, '')).toBe(BOM + withIv);
  });

  it('the dispatcher helper edits <InternalsVisibleTo>, refusing both params or a bad name', async () => {
    await seed(withIv);
    const both = await directXmlInternalsVisibleTo(file, 'add-module-reference',
      { internalsVisibleTo: 'ContosoTests', moduleReference: 'Ledger' });
    expect(both?.success).toBe(false);
    expect(both?.message).toContain('OR');
    const bad = await directXmlInternalsVisibleTo(file, 'add-module-reference', { internalsVisibleTo: 'Contoso Tests' });
    expect(bad?.success).toBe(false);
    const ok = await directXmlInternalsVisibleTo(file, 'add-module-reference', { internalsVisibleTo: 'ContosoTests' });
    expect(ok?.success, ok?.message).toBe(true);
    const gone = await directXmlInternalsVisibleTo(file, 'remove-module-reference', { internalsVisibleTo: 'ContosoTests' });
    expect(gone?.success, gone?.message).toBe(true);
    expect((await fs.readFile(file, 'utf-8')).split(String.fromCharCode(13)).join('')).toBe(BOM + withIv);
  });

  it('refuses when the descriptor has no <InternalsVisibleTo>, writing nothing', async () => {
    const before = await fs.readFile(file, 'utf-8');
    const r = await directXmlAddModuleReference(file, 'ContosoTests', '', 'InternalsVisibleTo');
    expect(r?.success).toBe(false);
    expect(r?.message).toMatch(/no <InternalsVisibleTo> element/);
    expect(await fs.readFile(file, 'utf-8')).toBe(before);
  });
});
