/**
 * add-duty, remove-duty, add-privilege and remove-privilege: the pure XML half, and
 * the file writers on a real file (line endings, undo).
 *
 * The surface (dispatch gate, wrong objectType, the index checks) is tested in
 * securityReferenceOps.test.ts. Fixture element order follows Visual Studio's
 * serialization, measured on 172 roles, duties and extensions.
 */

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { undoLastModificationTool } from '../../src/tools/sdlc/undoLastModification';
import {
  directXmlAddSecurityReference,
  directXmlRemoveSecurityReference,
} from '../../src/tools/write/directXmlWriters';
import {
  addSecurityReference,
  buildAxSecurityDutyExtensionXml,
  buildAxSecurityDutyXml,
  buildAxSecurityRoleExtensionXml,
  buildAxSecurityRoleXml,
  listSecurityReferences,
  removeSecurityReference,
  type SecurityReferenceKind,
} from '../../src/tools/xml/securityDutyRoleXml';

const dutyRef = (name: string) =>
  `\t\t<AxSecurityDutyReference>\n\t\t\t<Name>${name}</Name>\n\t\t</AxSecurityDutyReference>\n`;
const privilegeRef = (name: string) =>
  `\t\t<AxSecurityPrivilegeReference>\n\t\t\t<Name>${name}</Name>\n\t\t</AxSecurityPrivilegeReference>\n`;

const role = (duties: string[]) => buildAxSecurityRoleXml('ContosoRentClerk', { label: '@ContosoExt:Clerk', duties });

/** Every object that carries a list, with the kinds it carries. */
const OBJECTS: Array<[string, (p: Record<string, string[]>) => string, SecurityReferenceKind[]]> = [
  ['AxSecurityRole', p => buildAxSecurityRoleXml('ContosoRentClerk', p), ['duty', 'privilege']],
  ['AxSecurityRoleExtension', p => buildAxSecurityRoleExtensionXml('SystemUser.ContosoExtension', p), ['duty', 'privilege']],
  ['AxSecurityDuty', p => buildAxSecurityDutyXml('ContosoRentDuty', p), ['privilege']],
  ['AxSecurityDutyExtension', p => buildAxSecurityDutyExtensionXml('BatchJobMaintain.ContosoExtension', p), ['privilege']],
];

const expectAdded = (xml: string, kind: SecurityReferenceKind, name: string): string => {
  const r = addSecurityReference(xml, kind, name);
  if (r.kind !== 'added') throw new Error(`expected added, got ${r.kind}`);
  return r.xml;
};
const expectRemoved = (xml: string, kind: SecurityReferenceKind, name: string): string => {
  const r = removeSecurityReference(xml, kind, name);
  if (r.kind !== 'removed') throw new Error(`expected removed, got ${r.kind}`);
  return r.xml;
};

describe('addSecurityReference', () => {
  it('expands a self-closing container, keeping the element order', () => {
    const xml = expectAdded(role([]), 'duty', 'ContosoRentDuty');
    expect(xml).toBe(role(['ContosoRentDuty']));
    expect(xml.indexOf('<DirectAccessPermissions />')).toBeLessThan(xml.indexOf('<Duties>'));
    expect(xml.indexOf('</Duties>')).toBeLessThan(xml.indexOf('<Privileges />'));
    expect(xml.indexOf('<Privileges />')).toBeLessThan(xml.indexOf('<SubRoles />'));
  });

  it('expands the paired empty spelling a hand edit can leave', () => {
    const xml = role([]).replace('<Duties />', '<Duties>\n\t</Duties>');
    expect(expectAdded(xml, 'duty', 'ContosoRentDuty')).toBe(role(['ContosoRentDuty']));
  });

  it('appends at the end of a filled container, in the shape create writes', () => {
    expect(expectAdded(role(['ContosoA', 'ContosoB']), 'duty', 'ContosoC'))
      .toBe(role(['ContosoA', 'ContosoB', 'ContosoC']));
  });

  it('is idempotent, case-insensitively, and reports the spelling in the file', () => {
    expect(addSecurityReference(role(['ContosoRentDuty']), 'duty', 'CONTOSORENTDUTY'))
      .toEqual({ kind: 'already-present', existing: 'ContosoRentDuty' });
  });

  it('touches only its own list when a role has both', () => {
    const xml = buildAxSecurityRoleXml('ContosoRentClerk', { duties: ['ContosoShared'] });
    expect(listSecurityReferences(expectAdded(xml, 'privilege', 'ContosoShared'), 'privilege')).toEqual(['ContosoShared']);
  });

  it('trims the name', () => {
    expect(expectAdded(role([]), 'duty', '  ContosoRentDuty ')).toBe(role(['ContosoRentDuty']));
  });

  it.each(['A,B', 'A;B', 'A B', '', '1Duty', '</Name><Evil>'])('refuses %j, which is not one AOT name', name => {
    expect(addSecurityReference(role([]), 'duty', name)).toEqual({ kind: 'invalid-name' });
  });

  it('declines a hand-edited file with no container', () => {
    const xml = role([]).replace('\t<Duties />\n', '');
    expect(addSecurityReference(xml, 'duty', 'ContosoRentDuty')).toEqual({ kind: 'no-collection' });
  });

  it('does not take a commented-out reference for a real one', () => {
    const xml = role(['ContosoA']).replace(
      '\t</Duties>',
      `\t\t<!-- <AxSecurityDutyReference><Name>ContosoOld</Name></AxSecurityDutyReference> -->\n\t</Duties>`,
    );
    expect(listSecurityReferences(xml, 'duty')).toEqual(['ContosoA']);
    expect(listSecurityReferences(expectAdded(xml, 'duty', 'ContosoOld'), 'duty')).toEqual(['ContosoA', 'ContosoOld']);
  });

  it('stays inside the container: another collection of the same child is not the list', () => {
    const xml = buildAxSecurityDutyXml('ContosoRentDuty', { privileges: ['ContosoA'] }).replace(
      '</AxSecurityDuty>',
      `\t<SubDuties>\n${dutyRef('ContosoSub')}\t</SubDuties>\n</AxSecurityDuty>`,
    );
    expect(listSecurityReferences(xml, 'duty')).toEqual([]);
    expect(listSecurityReferences(xml, 'privilege')).toEqual(['ContosoA']);
  });
});

describe('removeSecurityReference', () => {
  it('removes the middle entry and leaves its neighbours byte-identical', () => {
    expect(expectRemoved(role(['ContosoA', 'ContosoB', 'ContosoC']), 'duty', 'ContosoB'))
      .toBe(role(['ContosoA', 'ContosoC']));
  });

  it('collapses the container when the last entry goes, back to what create writes', () => {
    expect(expectRemoved(role(['ContosoA']), 'duty', 'ContosoA')).toBe(role([]));
  });

  it('matches case-insensitively and reports the spelling in the file', () => {
    const r = removeSecurityReference(role(['ContosoA']), 'duty', 'contosoa');
    expect(r).toMatchObject({ kind: 'removed', removed: 'ContosoA' });
  });

  it('returns what IS there for a name that is not', () => {
    expect(removeSecurityReference(role(['ContosoA', 'ContosoB']), 'duty', 'ContosoZ'))
      .toEqual({ kind: 'not-found', present: ['ContosoA', 'ContosoB'], root: 'AxSecurityRole' });
  });

  it('reports an empty list as not-found with nothing present', () => {
    expect(removeSecurityReference(role([]), 'duty', 'ContosoA'))
      .toEqual({ kind: 'not-found', present: [], root: 'AxSecurityRole' });
  });

  it('refuses a name listed twice, in any casing', () => {
    const xml = role(['ContosoA', 'ContosoB']).replace('\t</Duties>', `${dutyRef('CONTOSOA')}\t</Duties>`);
    const r = removeSecurityReference(xml, 'duty', 'ContosoA');
    expect(r).toEqual({ kind: 'ambiguous', matches: ['ContosoA', 'CONTOSOA'] });
  });

  it('does not collapse away a comment left in the list', () => {
    const xml = role(['ContosoA']).replace('\t</Duties>', '\t\t<!-- keep -->\n\t</Duties>');
    const after = expectRemoved(xml, 'duty', 'ContosoA');
    expect(after).toContain('<!-- keep -->');
    expect(after).not.toContain('<Duties />');
  });
});

describe('all four object roots', () => {
  for (const [root, build, kinds] of OBJECTS) {
    for (const kind of kinds) {
      const param = kind === 'duty' ? 'duties' : 'privileges';
      it(`${kind} on ${root}: add then remove round-trips byte for byte`, () => {
        const empty = build({});
        const one = expectAdded(empty, kind, 'ContosoA');
        expect(one).toBe(build({ [param]: ['ContosoA'] }));
        expect(expectRemoved(one, kind, 'ContosoA')).toBe(empty);
      });
    }
  }

  it.each([
    ['AxSecurityDuty', buildAxSecurityDutyXml('ContosoRentDuty')],
    ['AxSecurityDutyExtension', buildAxSecurityDutyExtensionXml('BatchJobMaintain.ContosoExtension')],
  ])('declines a duty reference on %s, which has no <Duties>', (root, xml) => {
    expect(addSecurityReference(xml, 'duty', 'ContosoA')).toEqual({ kind: 'unsupported', root });
    expect(removeSecurityReference(xml, 'duty', 'ContosoA')).toEqual({ kind: 'unsupported', root });
  });

  it('declines both kinds on a privilege', () => {
    const xml = '<AxSecurityPrivilege><Name>ContosoRentView</Name><EntryPoints /></AxSecurityPrivilege>';
    for (const kind of ['duty', 'privilege'] as const) {
      expect(addSecurityReference(xml, kind, 'ContosoA')).toEqual({ kind: 'unsupported', root: 'AxSecurityPrivilege' });
    }
  });

  it('reads the fixture shape the extensions ship with', () => {
    const xml = expectAdded(buildAxSecurityRoleExtensionXml('SystemUser.ContosoExtension'), 'privilege', 'ContosoA');
    expect(xml).toContain(`<Privileges>\n${privilegeRef('ContosoA')}\t</Privileges>\n\t<PropertyModifications />`);
  });
});

describe('the writers on a real file', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'security-refs-')));
    file = path.join(dir, 'ContosoRentClerk.xml');
    fs.writeFileSync(file, role(['ContosoA']).replace(/\n/g, '\r\n'), 'utf-8');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('keeps the file CRLF with no BOM and no trailing newline, as Visual Studio writes it', async () => {
    const r = await directXmlAddSecurityReference(file, 'duty', 'ContosoB', '');
    expect(r.success).toBe(true);
    const after = fs.readFileSync(file, 'utf-8');
    expect(after).toBe(role(['ContosoA', 'ContosoB']).replace(/\n/g, '\r\n'));
    expect(after.charCodeAt(0)).not.toBe(0xfeff);
  });

  it('reports a duplicate as skipped and leaves the file alone', async () => {
    const before = fs.readFileSync(file);
    const r = await directXmlAddSecurityReference(file, 'duty', 'contosoa', '⚠️ unused\n');
    expect(r).toMatchObject({ success: true, skipped: true });
    expect(r.message).toContain(`'ContosoA' is already in <Duties>`);
    expect(fs.readFileSync(file).equals(before)).toBe(true);
  });

  it('puts the note ahead of the result', async () => {
    const r = await directXmlAddSecurityReference(file, 'duty', 'ContosoB', '⚠️ note\n');
    expect(r.message.startsWith('⚠️ note\n✅')).toBe(true);
  });

  it('answers a missing name with the list that is there', async () => {
    const r = await directXmlRemoveSecurityReference(file, 'duty', 'ContosoZ');
    expect(r.success).toBe(false);
    expect(r.message).toContain('<Duties> lists: ContosoA.');
    expect(r.message).not.toContain('An extension');
  });

  it('says why a base reference cannot go when the file is an extension', async () => {
    fs.writeFileSync(file, buildAxSecurityRoleExtensionXml('SystemUser.ContosoExtension'), 'utf-8');
    const r = await directXmlRemoveSecurityReference(file, 'duty', 'ContosoZ');
    expect(r.message).toContain('<Duties> is empty.');
    expect(r.message).toContain('An extension lists only what it adds');
  });

  it('reports a read failure as an error, not as a bridge resolution problem', async () => {
    const r = await directXmlAddSecurityReference(path.join(dir, 'Gone.xml'), 'duty', 'ContosoB', '');
    expect(r.success).toBe(false);
    expect(r.message).toContain('Could not add');
  });

  it('action="undo" reverts an add and a remove on a tracked file', async () => {
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, windowsHide: true, stdio: 'pipe' });
    git('init');
    git('add', '.');
    git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-m', 'base');
    const committed = fs.readFileSync(file);

    await directXmlAddSecurityReference(file, 'duty', 'ContosoB', '');
    expect(fs.readFileSync(file).equals(committed)).toBe(false);
    expect((await undoLastModificationTool({ filePath: file }, {} as any)).isError).toBeFalsy();
    expect(fs.readFileSync(file).equals(committed)).toBe(true);

    await directXmlRemoveSecurityReference(file, 'duty', 'ContosoA');
    expect(fs.readFileSync(file).equals(committed)).toBe(false);
    expect((await undoLastModificationTool({ filePath: file }, {} as any)).isError).toBeFalsy();
    expect(fs.readFileSync(file).equals(committed)).toBe(true);
  });
});
