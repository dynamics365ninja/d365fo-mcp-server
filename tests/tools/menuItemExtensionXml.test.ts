/**
 * buildAxMenuItemExtensionXml (src/tools/menuItemExtensionXml.ts).
 *
 * Regression: all three menu-item extension objectTypes shared the same stub as
 * `data-entity-extension` and `edt-extension` before it —
 * generateAxSimpleExtensionXml(rootElement, name), which takes no `properties`.
 * A menu-item extension changes the base menu item ONLY through property
 * modifications, so the objectType had no grounded path at all: it wrote an inert
 *     <AxMenuItemActionExtension><Name>…</Name><PropertyModifications /></…>
 * that builds green and changes nothing.
 *
 * Shape is pinned against the only four shipped elements in
 * PackagesLocalDirectory: MasterPlanningService\MasterPlanningService\
 * AxMenuItemActionExtension\*.xml — 4/4 carry the V1 default namespace on the
 * root and xmlns="" on each AxPropertyModification.
 */

import { describe, it, expect } from 'vitest';
import { buildAxMenuItemExtensionXml } from '../../src/tools/xml/menuItemExtensionXml';

const NAME = 'CustTableListPage.ConExtension';

describe('buildAxMenuItemExtensionXml — property modifications', () => {
  it('turns the object shortcut into an AxPropertyModification instead of dropping it — regression', () => {
    const xml = buildAxMenuItemExtensionXml('AxMenuItemActionExtension', NAME, {
      object: 'ConDemoRunner',
    });
    expect(xml).toContain('<AxPropertyModification xmlns="">');
    expect(xml).toContain('<Name>Object</Name>');
    expect(xml).toContain('<Value>ConDemoRunner</Value>');
  });

  it('maps every named shortcut to its metadata property name', () => {
    const xml = buildAxMenuItemExtensionXml('AxMenuItemDisplayExtension', NAME, {
      object: 'ConDemoForm',
      label: '@SYS1',
      helpText: '@SYS2',
      enumTypeParameter: 'NoYes',
      enumParameter: 'Yes',
      parameters: 'Foo',
      configurationKey: 'ConDemoKey',
      needsRecord: 'Yes',
      visible: 'No',
    });
    for (const property of [
      'Object', 'Label', 'HelpText', 'EnumTypeParameter', 'EnumParameter',
      'Parameters', 'ConfigurationKey', 'NeedsRecord', 'Visible',
    ]) {
      expect(xml, `${property} missing`).toContain(`<Name>${property}</Name>`);
    }
  });

  it('accepts an explicit propertyModifications list for properties with no shortcut', () => {
    const xml = buildAxMenuItemExtensionXml('AxMenuItemOutputExtension', NAME, {
      propertyModifications: [{ name: 'ObjectType', value: 'SSRSReport' }],
    });
    expect(xml).toContain('<Name>ObjectType</Name>');
    expect(xml).toContain('<Value>SSRSReport</Value>');
  });

  it('lets an explicit entry win over the named shortcut for the same property', () => {
    const xml = buildAxMenuItemExtensionXml('AxMenuItemActionExtension', NAME, {
      object: 'FromShortcut',
      propertyModifications: [{ name: 'Object', value: 'FromExplicit' }],
    });
    expect(xml).toContain('<Value>FromExplicit</Value>');
    expect(xml).not.toContain('<Value>FromShortcut</Value>');
  });

  it('escapes XML metacharacters in the value', () => {
    const xml = buildAxMenuItemExtensionXml('AxMenuItemActionExtension', NAME, {
      label: 'a & b < c',
    });
    expect(xml).toContain('<Value>a &amp; b &lt; c</Value>');
  });
});

describe('buildAxMenuItemExtensionXml — element shape', () => {
  it('carries the V1 default namespace on the root, as 4/4 shipped elements do', () => {
    const xml = buildAxMenuItemExtensionXml('AxMenuItemActionExtension', NAME, { object: 'X' });
    expect(xml).toContain(
      '<AxMenuItemActionExtension xmlns:i="http://www.w3.org/2001/XMLSchema-instance" xmlns="Microsoft.Dynamics.AX.Metadata.V1">'
    );
  });

  it('resets each AxPropertyModification back to no namespace', () => {
    const xml = buildAxMenuItemExtensionXml('AxMenuItemActionExtension', NAME, { object: 'X' });
    expect(xml).toContain('<AxPropertyModification xmlns="">');
  });

  it('self-closes PropertyModifications when there is nothing to modify', () => {
    const xml = buildAxMenuItemExtensionXml('AxMenuItemDisplayExtension', NAME);
    expect(xml).toContain('<PropertyModifications />');
  });

  it('honours each of the three root elements', () => {
    for (const root of [
      'AxMenuItemDisplayExtension', 'AxMenuItemActionExtension', 'AxMenuItemOutputExtension',
    ] as const) {
      const xml = buildAxMenuItemExtensionXml(root, NAME);
      expect(xml).toContain(`<${root} `);
      expect(xml.endsWith(`</${root}>`)).toBe(true);
    }
  });
});
