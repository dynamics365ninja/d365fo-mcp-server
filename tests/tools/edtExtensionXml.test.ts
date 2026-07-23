/**
 * buildAxEdtExtensionXml (src/tools/edtExtensionXml.ts).
 *
 * Regression: eval/corpus/runs/2026-07-23T16__L2-edt-extension-basic__01cd181.json —
 * `edt-extension` went through generateAxSimpleExtensionXml(), whose signature takes
 * only (rootElement, name). Every property the caller passed was therefore silently
 * dropped and the element came out as an inert
 *     <AxEdtExtension><Name>…</Name><PropertyModifications /></AxEdtExtension>
 * with no <ArrayElements /> either. Since an EDT extension changes the base EDT
 * ONLY through property modifications, that left the objectType with no grounded
 * path at all — the eval case could only be completed through the xmlContent
 * escape hatch.
 *
 * Shape is pinned against the shipped elements in PackagesLocalDirectory
 * (13/13 carry <ArrayElements />, e.g. ApplicationSuite\Foundation\AxEdtExtension\
 * DocuOverdueFineTxt_FR.Extension.xml). Element order matters: the metadata
 * deserializer silently drops children it meets out of order.
 */

import { describe, it, expect } from 'vitest';
import { buildAxEdtExtensionXml } from '../../src/tools/edtExtensionXml';

describe('buildAxEdtExtensionXml — property modifications', () => {
  it('turns helpText into an AxPropertyModification instead of dropping it — regression', () => {
    const xml = buildAxEdtExtensionXml('AccountNum.ConExtension', {
      helpText: '@SYS12345',
    });
    expect(xml).toContain('<AxPropertyModification>');
    expect(xml).toContain('<Name>HelpText</Name>');
    expect(xml).toContain('<Value>@SYS12345</Value>');
  });

  it('maps every named shortcut to its metadata property name', () => {
    const xml = buildAxEdtExtensionXml('AccountNum.ConExtension', {
      label: '@SYS1',
      helpText: '@SYS2',
      stringSize: 40,
      extends: 'Num',
      formHelp: '@SYS3',
    });
    for (const name of ['Label', 'HelpText', 'StringSize', 'Extends', 'FormHelp']) {
      expect(xml).toContain(`<Name>${name}</Name>`);
    }
    expect(xml).toContain('<Value>40</Value>');
  });

  it('accepts an explicit propertyModifications list for properties with no shortcut', () => {
    const xml = buildAxEdtExtensionXml('AccountNum.ConExtension', {
      propertyModifications: [{ name: 'DisplayLength', value: 25 }],
    });
    expect(xml).toContain('<Name>DisplayLength</Name>');
    expect(xml).toContain('<Value>25</Value>');
  });

  it('lets an explicit entry win over the named shortcut for the same property', () => {
    const xml = buildAxEdtExtensionXml('AccountNum.ConExtension', {
      propertyModifications: [{ name: 'Label', value: '@SYS_EXPLICIT' }],
      label: '@SYS_SHORTCUT',
    });
    expect(xml).toContain('<Value>@SYS_EXPLICIT</Value>');
    expect(xml).not.toContain('@SYS_SHORTCUT');
    expect(xml.match(/<Name>Label<\/Name>/g)).toHaveLength(1);
  });

  it('escapes XML metacharacters in the value', () => {
    const xml = buildAxEdtExtensionXml('AccountNum.ConExtension', {
      helpText: 'A & B <tag>',
    });
    expect(xml).toContain('<Value>A &amp; B &lt;tag&gt;</Value>');
  });
});

describe('buildAxEdtExtensionXml — element shape', () => {
  it('always emits ArrayElements, before PropertyModifications (13/13 shipped elements do)', () => {
    const xml = buildAxEdtExtensionXml('AccountNum.ConExtension', { label: '@SYS1' });
    expect(xml).toContain('<ArrayElements />');
    expect(xml.indexOf('<ArrayElements />')).toBeLessThan(xml.indexOf('<PropertyModifications'));
    expect(xml.indexOf('<Name>AccountNum.ConExtension</Name>'))
      .toBeLessThan(xml.indexOf('<ArrayElements />'));
  });

  it('self-closes PropertyModifications when there is nothing to modify', () => {
    const xml = buildAxEdtExtensionXml('AccountNum.ConExtension');
    expect(xml).toContain('<PropertyModifications />');
    expect(xml).toContain('<ArrayElements />');
  });

  it('matches the shipped root element and declaration verbatim', () => {
    const xml = buildAxEdtExtensionXml('AccountNum.ConExtension');
    expect(xml.startsWith('<?xml version="1.0" encoding="utf-8"?>\n')).toBe(true);
    expect(xml).toContain(
      '<AxEdtExtension xmlns:i="http://www.w3.org/2001/XMLSchema-instance">'
    );
  });
});
