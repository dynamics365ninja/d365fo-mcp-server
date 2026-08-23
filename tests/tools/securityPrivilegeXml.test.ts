/**
 * AxSecurityPrivilege XML builder — the exact path of a historical incident.
 *
 * `security-privilege` / `-duty` / `-role` create once wrote structurally empty
 * artifacts: the C# bridge silently dropped their structured collections
 * (EntryPoints, DataEntityPermissions, Privileges, Duties), so the file landed,
 * the project built, xppbp reported ZERO warnings — and the privilege granted
 * nothing. Nothing failed loudly, which is exactly why it survived. The fix was
 * to exclude those types from BRIDGE_CREATE_TYPES and route them through this
 * TypeScript builder instead.
 *
 * That makes this 62-line function the whole guarantee, and it had no direct
 * test. Two properties matter and neither is observable from a build:
 *
 *  1. The collections are actually POPULATED when the caller asks for them —
 *     an `<EntryPoints />` where an entry point was requested is the incident.
 *  2. ELEMENT ORDER matches the Microsoft serializer. The AOT reads these
 *     positionally; a misordered child is dropped on load without a diagnostic.
 *     The two collections disagree on purpose — AxSecurityEntryPointReference is
 *     Name-first, AxSecurityDataEntityPermission is Grant-first — and that
 *     asymmetry is the kind of detail a refactor "tidies up".
 */

import { describe, it, expect } from 'vitest';
import {
  buildAxSecurityPrivilegeXml,
  removeSecurityEntryPoint,
} from '../../src/tools/xml/securityPrivilegeXml';

/** Index of a tag's first occurrence in either open or self-closed form; -1 when absent. */
function at(xml: string, tag: string): number {
  const open = xml.indexOf(`<${tag}>`);
  const selfClosed = xml.indexOf(`<${tag} />`);
  if (open === -1) return selfClosed;
  if (selfClosed === -1) return open;
  return Math.min(open, selfClosed);
}

/** Assert tags appear in the given order and all are present. */
function expectOrder(xml: string, tags: string[]): void {
  const positions = tags.map(t => ({ tag: t, pos: at(xml, t) }));
  for (const { tag, pos } of positions) {
    expect(pos, `<${tag}> missing from:\n${xml}`).toBeGreaterThan(-1);
  }
  for (let i = 1; i < positions.length; i++) {
    expect(
      positions[i].pos,
      `<${positions[i].tag}> must come after <${positions[i - 1].tag}>:\n${xml}`,
    ).toBeGreaterThan(positions[i - 1].pos);
  }
}

describe('buildAxSecurityPrivilegeXml', () => {
  it('emits a well-formed skeleton with no properties', () => {
    const xml = buildAxSecurityPrivilegeXml('MyPrivilege');

    expect(xml.startsWith('<?xml version="1.0" encoding="utf-8"?>')).toBe(true);
    // A missing xmlns:i makes the element unloadable in Visual Studio.
    expect(xml).toContain('<AxSecurityPrivilege xmlns:i="http://www.w3.org/2001/XMLSchema-instance">');
    expect(xml).toContain('<Name>MyPrivilege</Name>');
    // A raw-text label fails xppbp (BPErrorLabelIsText), so the placeholder must
    // stay in label-id form rather than becoming prose.
    expect(xml).toContain('<Label>@TODO:LabelId</Label>');
    expect(xml.trimEnd().endsWith('</AxSecurityPrivilege>')).toBe(true);
  });

  it('keeps the top-level element order the serializer expects', () => {
    const xml = buildAxSecurityPrivilegeXml('MyPrivilege', {
      targetObject: 'MyMenuItem',
      dataEntity: 'MyEntity',
    });
    expectOrder(xml, [
      'Name',
      'Label',
      'DataEntityPermissions',
      'DirectAccessPermissions',
      'EntryPoints',
      'FormControlOverrides',
    ]);
  });

  describe('entry points', () => {
    it('is self-closed when no target object was requested', () => {
      const xml = buildAxSecurityPrivilegeXml('MyPrivilege');
      expect(xml).toContain('<EntryPoints></EntryPoints>');
      expect(xml).not.toContain('AxSecurityEntryPointReference');
    });

    it('is POPULATED when a target object was requested (the incident)', () => {
      const xml = buildAxSecurityPrivilegeXml('MyPrivilege', { targetObject: 'MyMenuItem' });
      expect(xml).toContain('<AxSecurityEntryPointReference>');
      expect(xml).toContain('<ObjectName>MyMenuItem</ObjectName>');
      expect(xml).toContain('<ObjectType>MenuItemDisplay</ObjectType>');
      // The empty-collection form is precisely what shipped and granted nothing.
      expect(xml).not.toContain('<EntryPoints />');
    });

    it('is Name-first — the opposite of AxSecurityDataEntityPermission', () => {
      const xml = buildAxSecurityPrivilegeXml('MyPrivilege', { targetObject: 'MyMenuItem' });
      const ref = xml.slice(
        xml.indexOf('<AxSecurityEntryPointReference>'),
        xml.indexOf('</AxSecurityEntryPointReference>'),
      );
      expectOrder(ref, ['Name', 'Grant', 'ObjectName', 'ObjectType']);
      expect(ref).toContain('<Forms />');
    });

    it('grants Read only at the default (view) access level', () => {
      const xml = buildAxSecurityPrivilegeXml('MyPrivilege', { targetObject: 'MyMenuItem' });
      expect(xml).toContain('<Read>Allow</Read>');
      expect(xml).not.toContain('<Update>Allow</Update>');
      expect(xml).not.toContain('<Delete>Allow</Delete>');
    });

    it('grants full CRUD at accessLevel="maintain"', () => {
      const xml = buildAxSecurityPrivilegeXml('MyPrivilege', {
        targetObject: 'MyMenuItem',
        accessLevel: 'maintain',
      });
      const grant = xml.slice(xml.indexOf('<AxSecurityEntryPointReference>'));
      for (const op of ['Read', 'Update', 'Create', 'Delete']) {
        expect(grant, `entry-point grant missing ${op}`).toContain(`<${op}>Allow</${op}>`);
      }
    });

    /**
     * The entry-point grant is alphabetical too. An earlier revision emitted
     * Read/Update/Create/Delete here and this suite asserted only PRESENCE, with a
     * comment calling the asymmetry deliberate ("do not normalise it") — so the
     * order was never checked and the claim was never tested. It was wrong:
     *
     *  - The Microsoft deserializer is sequence-ordered. A live round trip in eval
     *    case L2-object-delete-and-entry-point-cleanup (2026-08-23) read the
     *    tool's own output back as R:[Allow] U:[Allow] C:[Unset] D:[Unset] — the
     *    same content in alphabetical order read back as all four Allow.
     *  - 370 shipped AxSecurityPrivilege files (ApplicationSuite +
     *    ApplicationFoundation) carry 731 multi-element entry-point grants. NONE
     *    is out of alphabetical order.
     *  - This module's own header already stated the rule without qualifying it
     *    to data entities.
     *
     * So `accessLevel:"maintain"` silently granted read+update, on a privilege
     * that built clean and passed xppbp — the one failure class a security object
     * must not have.
     */
    it('writes the entry-point CRUD grant in ALPHABETICAL order at maintain level', () => {
      const xml = buildAxSecurityPrivilegeXml('MyPrivilege', {
        targetObject: 'MyMenuItem',
        accessLevel: 'maintain',
      });
      const grant = xml.slice(
        xml.indexOf('<AxSecurityEntryPointReference>'),
        xml.indexOf('</AxSecurityEntryPointReference>'),
      );
      expectOrder(grant, ['Create', 'Delete', 'Read', 'Update']);
    });

    it('matches accessLevel case-insensitively', () => {
      // `al` is lowercased before comparison; a caller passing "Maintain" from a
      // UI or a JSON payload must not silently degrade to view-only.
      const xml = buildAxSecurityPrivilegeXml('MyPrivilege', {
        targetObject: 'MyMenuItem',
        accessLevel: 'MAINTAIN',
      });
      expect(xml).toContain('<Delete>Allow</Delete>');
    });

    it('honours a non-default objectType', () => {
      const xml = buildAxSecurityPrivilegeXml('MyPrivilege', {
        targetObject: 'MyAction',
        objectType: 'MenuItemAction',
      });
      expect(xml).toContain('<ObjectType>MenuItemAction</ObjectType>');
    });
  });

  describe('data entity permissions', () => {
    it('is self-closed when no data entity was requested', () => {
      const xml = buildAxSecurityPrivilegeXml('MyPrivilege');
      expect(xml).toContain('<DataEntityPermissions />');
      expect(xml).not.toContain('AxSecurityDataEntityPermission');
    });

    it('is POPULATED when a data entity was requested', () => {
      const xml = buildAxSecurityPrivilegeXml('MyPrivilege', { dataEntity: 'MyEntity' });
      expect(xml).toContain('<AxSecurityDataEntityPermission>');
      expect(xml).toContain('<Name>MyEntity</Name>');
      expect(xml).not.toContain('<DataEntityPermissions />');
    });

    it('is Grant-first, with Fields and Methods after Name', () => {
      const xml = buildAxSecurityPrivilegeXml('MyPrivilege', { dataEntity: 'MyEntity' });
      const perm = xml.slice(
        xml.indexOf('<AxSecurityDataEntityPermission>'),
        xml.indexOf('</AxSecurityDataEntityPermission>'),
      );
      // Grant BEFORE Name — verified against ApplicationCommon's shipped
      // AgentFeedEntity{Maintain,View}.xml. Reversing it drops the grant on load.
      expect(perm.indexOf('<Grant>')).toBeLessThan(perm.indexOf('<Name>'));
      expect(perm.indexOf('<Name>')).toBeLessThan(perm.indexOf('<Fields />'));
      expect(perm.indexOf('<Fields />')).toBeLessThan(perm.indexOf('<Methods />'));
    });

    it('writes the CRUD grant in ALPHABETICAL order at maintain level', () => {
      const xml = buildAxSecurityPrivilegeXml('MyPrivilege', {
        dataEntity: 'MyEntity',
        accessLevel: 'maintain',
      });
      const grant = xml.slice(
        xml.indexOf('<AxSecurityDataEntityPermission>'),
        xml.indexOf('</AxSecurityDataEntityPermission>'),
      );
      // The serializer emits these alphabetically, NOT in CRUD order. The
      // entry-point grant above follows the same rule — an earlier comment here
      // claimed the two were deliberately asymmetric, which was an assumption the
      // shipped metadata and a live round trip both refute (see that test).
      // `Correct` is the one real difference: it is a data-entity permission only.
      expectOrder(grant, ['Correct', 'Create', 'Delete', 'Read', 'Update']);
    });

    it('grants Read only at view level', () => {
      const xml = buildAxSecurityPrivilegeXml('MyPrivilege', { dataEntity: 'MyEntity' });
      const perm = xml.slice(
        xml.indexOf('<AxSecurityDataEntityPermission>'),
        xml.indexOf('</AxSecurityDataEntityPermission>'),
      );
      expect(perm).toContain('<Read>Allow</Read>');
      expect(perm).not.toContain('<Correct>Allow</Correct>');
    });
  });

  it('emits both collections when both were requested', () => {
    const xml = buildAxSecurityPrivilegeXml('MyPrivilege', {
      targetObject: 'MyMenuItem',
      dataEntity: 'MyEntity',
      accessLevel: 'maintain',
      label: '@MyModel:PrivilegeLabel',
    });
    expect(xml).toContain('<AxSecurityEntryPointReference>');
    expect(xml).toContain('<AxSecurityDataEntityPermission>');
    expect(xml).toContain('<Label>@MyModel:PrivilegeLabel</Label>');
  });

  it('is byte-identical to the createD365File and generateD365Xml wrappers', async () => {
    // Both XmlTemplateGenerator classes delegate here precisely so they cannot
    // drift. If either grows its own copy, this catches it.
    const { XmlTemplateGenerator: fromCreate } = await import('../../src/tools/write/createD365File');
    const props = { targetObject: 'MyMenuItem', dataEntity: 'MyEntity', accessLevel: 'maintain' };
    const direct = buildAxSecurityPrivilegeXml('MyPrivilege', props);
    expect(fromCreate.generateAxSecurityPrivilegeXml('MyPrivilege', props)).toBe(direct);
  });
});

/**
 * removeSecurityEntryPoint — the inverse of what the builder writes for
 * `targetObject`, and the pure half of the remove-entry-point operation.
 *
 * Same stakes as the builder above, from the other direction: security objects
 * have no bridge write path, the AOT reads these positionally, and a privilege
 * that grants the WRONG thing builds clean and reports nothing. Removing the
 * wrong entry point revokes a user's access to a different form and only surfaces
 * as a support call, so ambiguity is refused rather than resolved.
 */

/** Privilege with two entry points — a display and an action menu item. */
const TWO_ENTRY_POINTS = `<?xml version="1.0" encoding="utf-8"?>
<AxSecurityPrivilege xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
\t<Name>ConDemoTicketMaintain</Name>
\t<Label>@ConDemo:TicketMaintain</Label>
\t<DataEntityPermissions />
\t<DirectAccessPermissions />
\t<EntryPoints>
\t\t<AxSecurityEntryPointReference>
\t\t\t<Name>ConDemoTicketTable</Name>
\t\t\t<Grant>
\t\t\t\t<Read>Allow</Read>
\t\t\t\t<Update>Allow</Update>
\t\t\t</Grant>
\t\t\t<ObjectName>ConDemoTicketTable</ObjectName>
\t\t\t<ObjectType>MenuItemDisplay</ObjectType>
\t\t\t<Forms />
\t\t</AxSecurityEntryPointReference>
\t\t<AxSecurityEntryPointReference>
\t\t\t<Name>ConDemoPostAction</Name>
\t\t\t<Grant>
\t\t\t\t<Read>Allow</Read>
\t\t\t</Grant>
\t\t\t<ObjectName>ConDemoTicketTable</ObjectName>
\t\t\t<ObjectType>MenuItemAction</ObjectType>
\t\t\t<Forms />
\t\t</AxSecurityEntryPointReference>
\t</EntryPoints>
\t<FormControlOverrides />
</AxSecurityPrivilege>`;

describe('removeSecurityEntryPoint', () => {
  it('removes the entry point named by entryPointName', () => {
    const result = removeSecurityEntryPoint(TWO_ENTRY_POINTS, { name: 'ConDemoPostAction' });
    expect(result.kind).toBe('removed');
    if (result.kind !== 'removed') return;

    expect(result.removed).toEqual({
      name: 'ConDemoPostAction',
      objectName: 'ConDemoTicketTable',
      objectType: 'MenuItemAction',
    });
    expect(result.xml).not.toContain('ConDemoPostAction');
    expect(result.xml).not.toContain('MenuItemAction');
    // The other entry point survives whole — Grant block included.
    expect(result.xml).toContain('<Name>ConDemoTicketTable</Name>');
    expect(result.xml).toContain('<Update>Allow</Update>');
    expect(result.xml).toContain('<ObjectType>MenuItemDisplay</ObjectType>');
  });

  it('never mistakes the privilege\'s own <Name> for an entry point', () => {
    // A `<Name>` search finds the privilege first. Removing on that match would
    // cut the privilege's identity out of the file.
    const result = removeSecurityEntryPoint(TWO_ENTRY_POINTS, { name: 'ConDemoTicketMaintain' });
    expect(result.kind).toBe('not-found');
    if (result.kind !== 'not-found') return;
    expect(result.present.map(e => e.name)).toEqual(['ConDemoTicketTable', 'ConDemoPostAction']);
  });

  it('resolves by objectName + objectType when the names differ', () => {
    const result = removeSecurityEntryPoint(TWO_ENTRY_POINTS, {
      objectName: 'ConDemoTicketTable',
      objectType: 'MenuItemAction',
    });
    expect(result.kind).toBe('removed');
    if (result.kind !== 'removed') return;
    expect(result.removed.name).toBe('ConDemoPostAction');
  });

  it('refuses an objectName that matches two entry-point types', () => {
    // Both entry points point at ConDemoTicketTable, through different types.
    const result = removeSecurityEntryPoint(TWO_ENTRY_POINTS, { objectName: 'ConDemoTicketTable' });
    expect(result.kind).toBe('ambiguous');
    if (result.kind !== 'ambiguous') return;
    expect(result.matches).toHaveLength(2);
    expect(result.matches.map(m => m.objectType)).toEqual(['MenuItemDisplay', 'MenuItemAction']);
  });

  it('matches case-insensitively', () => {
    expect(removeSecurityEntryPoint(TWO_ENTRY_POINTS, { name: 'condemopostaction' }).kind).toBe('removed');
  });

  it('collapses <EntryPoints> when the last entry point goes', () => {
    const one = buildAxSecurityPrivilegeXml('ConDemoTicketView', {
      label: '@ConDemo:TicketView',
      targetObject: 'ConDemoTicketTable',
    });
    const result = removeSecurityEntryPoint(one, { name: 'ConDemoTicketTable' });
    expect(result.kind).toBe('removed');
    if (result.kind !== 'removed') return;
    // The SAME empty spelling the builder emits (see the round-trip test) — not
    // `<EntryPoints />`, which would make a stripped privilege differ from a
    // never-populated one over something the deserializer cannot see.
    expect(result.xml).toContain('<EntryPoints></EntryPoints>');
    expect(result.xml).not.toMatch(/<EntryPoints>\s+<\/EntryPoints>/);
  });

  it('reports not-found with the entry points that ARE there', () => {
    const result = removeSecurityEntryPoint(TWO_ENTRY_POINTS, { name: 'ConDemoNoSuchItem' });
    expect(result.kind).toBe('not-found');
    if (result.kind !== 'not-found') return;
    expect(result.present).toHaveLength(2);
  });

  it('reports not-found on a privilege with no entry points at all', () => {
    const bare = buildAxSecurityPrivilegeXml('ConDemoBare', { label: '@ConDemo:Bare' });
    const result = removeSecurityEntryPoint(bare, { name: 'Anything' });
    expect(result.kind).toBe('not-found');
    if (result.kind !== 'not-found') return;
    expect(result.present).toEqual([]);
  });

  it('declines a file that is not a privilege', () => {
    const duty = `<?xml version="1.0" encoding="utf-8"?>\n<AxSecurityDuty><Name>ConDemoDuty</Name></AxSecurityDuty>`;
    expect(removeSecurityEntryPoint(duty, { name: 'x' }).kind).toBe('unsupported');
  });

  it('round-trips the builder: what it writes, this removes', () => {
    const built = buildAxSecurityPrivilegeXml('ConDemoTicketMaintain', {
      label: '@ConDemo:TicketMaintain',
      targetObject: 'ConDemoTicketTable',
      objectType: 'MenuItemDisplay',
      accessLevel: 'maintain',
    });
    const stripped = removeSecurityEntryPoint(built, { name: 'ConDemoTicketTable' });
    if (stripped.kind !== 'removed') throw new Error('expected removal');
    expect(stripped.xml).toBe(buildAxSecurityPrivilegeXml('ConDemoTicketMaintain', {
      label: '@ConDemo:TicketMaintain',
    }));
  });
});
