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
import { buildAxSecurityPrivilegeXml } from '../../src/tools/securityPrivilegeXml';

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
      // The serializer emits these alphabetically, NOT in CRUD order — note that
      // this differs from the entry-point grant above, which is Read/Update/
      // Create/Delete. The asymmetry is real; do not "normalise" it.
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
    const { XmlTemplateGenerator: fromCreate } = await import('../../src/tools/createD365File');
    const props = { targetObject: 'MyMenuItem', dataEntity: 'MyEntity', accessLevel: 'maintain' };
    const direct = buildAxSecurityPrivilegeXml('MyPrivilege', props);
    expect(fromCreate.generateAxSecurityPrivilegeXml('MyPrivilege', props)).toBe(direct);
  });
});
