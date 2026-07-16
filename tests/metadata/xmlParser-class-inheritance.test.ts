/**
 * Class inheritance extraction from the Declaration CDATA.
 *
 * Regression (#688): parseClassFile read inheritance from <Extends>,
 * <Implements>, <IsAbstract> and <IsFinal> XML elements. No AxClass file has
 * any of them — the clause exists only as X++ text in <SourceCode><Declaration>
 * — so extends_class/implements_interfaces were NULL for every class in the
 * index, and isAbstract/isFinal false for every class. Everything keyed on
 * those columns (find_references extends/implements, resolve_references'
 * inheritance walk, class rendering) silently returned nothing.
 *
 * The same element-reading bug applied to Ax*Extension files, leaving
 * base_object_name empty for every extension_metadata row.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { XppMetadataParser } from '../../src/metadata/xmlParser';
import { parseXppClassHeader } from '../../src/metadata/xppDeclaration';

let tmpDir: string;

const writeClass = async (name: string, declaration: string) => {
  const xml = [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<AxClass xmlns:i="http://www.w3.org/2001/XMLSchema-instance">',
    `  <Name>${name}</Name>`,
    '  <SourceCode>',
    `    <Declaration><![CDATA[${declaration}]]></Declaration>`,
    '  </SourceCode>',
    '</AxClass>',
  ].join('\n');
  const file = path.join(tmpDir, `${name}.xml`);
  await fs.writeFile(file, xml, 'utf-8');
  return file;
};

const writeExtension = async (rootTag: string, name: string, declaration?: string) => {
  const xml = [
    '<?xml version="1.0" encoding="utf-8"?>',
    `<${rootTag} xmlns:i="http://www.w3.org/2001/XMLSchema-instance">`,
    `  <Name>${name}</Name>`,
    ...(declaration
      ? ['  <SourceCode>', `    <Declaration><![CDATA[${declaration}]]></Declaration>`, '  </SourceCode>']
      : []),
    `</${rootTag}>`,
  ].join('\n');
  const file = path.join(tmpDir, `${name}.xml`);
  await fs.writeFile(file, xml, 'utf-8');
  return file;
};

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xpp-class-inherit-'));
});

afterAll(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('parseXppClassHeader', () => {
  it('reads extends and implements off the class header', () => {
    const h = parseXppClassHeader('class Foo extends Bar implements IBaz\n{\n}');
    expect(h).toMatchObject({ kind: 'class', name: 'Foo', extends: 'Bar', implements: ['IBaz'] });
  });

  it('reads an implements list that wraps across lines', () => {
    // ~17% of real implements lists are multi-line; a line-bounded regex drops them.
    const h = parseXppClassHeader(
      'class Handler implements\n    IFirstHandler,\n    ISecondHandler,\n    IThirdHandler\n{\n}',
    );
    expect(h?.implements).toEqual(['IFirstHandler', 'ISecondHandler', 'IThirdHandler']);
  });

  it('ignores "extends" mentioned in a doc comment above the class', () => {
    // A regex over the raw CDATA harvests `extends the` here.
    const h = parseXppClassHeader(
      '/// <summary>\n/// This class extends the accounting distribution rule.\n/// </summary>\nclass AccDistRule extends AccountingDistributionRule\n{\n}',
    );
    expect(h?.extends).toBe('AccountingDistributionRule');
  });

  it('does not treat a commented-out implements clause as real', () => {
    const h = parseXppClassHeader('// class Old implements IGone\nclass New extends Base\n{\n}');
    expect(h?.name).toBe('New');
    expect(h?.implements).toEqual([]);
  });

  it('reads abstract and final off the class line, not the body', () => {
    const abstract = parseXppClassHeader('[Attr]\nabstract class A extends B\n{\n    final void m() {}\n}');
    expect(abstract).toMatchObject({ isAbstract: true, isFinal: false });

    const final = parseXppClassHeader('public final class C\n{\n}');
    expect(final).toMatchObject({ isAbstract: false, isFinal: true });
  });

  it('does not mistake an attribute name for a modifier', () => {
    const h = parseXppClassHeader('[FinalizeAttribute]\nclass D\n{\n}');
    expect(h?.isFinal).toBe(false);
  });

  it('survives an attribute string containing braces', () => {
    const h = parseXppClassHeader('[SysObsolete("use {0} instead")]\nclass E extends F\n{\n}');
    expect(h?.extends).toBe('F');
  });

  it('handles interfaces and namespaced base types', () => {
    expect(parseXppClassHeader('interface IThing\n{\n}')).toMatchObject({ kind: 'interface', name: 'IThing' });
    expect(parseXppClassHeader('class G extends Microsoft.Dynamics.Foo\n{\n}')?.extends)
      .toBe('Microsoft.Dynamics.Foo');
  });

  it('returns null when there is no class header', () => {
    expect(parseXppClassHeader('')).toBeNull();
    expect(parseXppClassHeader('// just a comment')).toBeNull();
  });
});

describe('parseClassFile inheritance', () => {
  it('populates extends/implements/isFinal from the Declaration CDATA', async () => {
    const file = await writeClass(
      'PurchFormLetter_Invoice',
      '\n[SysOperationJournaledParametersAttribute(true)]\nfinal class PurchFormLetter_Invoice extends PurchFormLetter implements BatchRetryable\n{\n    str packed;\n}\n',
    );
    const result = await new XppMetadataParser().parseClassFile(file, 'ApplicationSuite');

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      name: 'PurchFormLetter_Invoice',
      extends: 'PurchFormLetter',
      implements: ['BatchRetryable'],
      isFinal: true,
      isAbstract: false,
    });
    expect(result.data?.declaration)
      .toBe('final class PurchFormLetter_Invoice extends PurchFormLetter implements BatchRetryable');
  });

  it('still parses when Declaration carries an attribute (xml2js yields an object, not a string)', async () => {
    const xml = [
      '<?xml version="1.0" encoding="utf-8"?>',
      '<AxClass xmlns:i="http://www.w3.org/2001/XMLSchema-instance">',
      '  <Name>Attributed</Name>',
      '  <SourceCode>',
      '    <Declaration xml:space="preserve"><![CDATA[class Attributed extends Base\n{\n}]]></Declaration>',
      '  </SourceCode>',
      '</AxClass>',
    ].join('\n');
    const file = path.join(tmpDir, 'Attributed.xml');
    await fs.writeFile(file, xml, 'utf-8');

    const result = await new XppMetadataParser().parseClassFile(file, 'M');
    expect(result.success).toBe(true);
    expect(result.data?.extends).toBe('Base');
  });

  it('leaves extends undefined for a base class that extends nothing', async () => {
    const file = await writeClass('Standalone', 'class Standalone\n{\n}');
    const result = await new XppMetadataParser().parseClassFile(file, 'M');

    expect(result.data?.extends).toBeUndefined();
    expect(result.data?.implements).toEqual([]);
  });
});

describe('parseExtensionFile base object', () => {
  it('reads the base object from the ExtensionOf attribute', async () => {
    const file = await writeExtension(
      'AxClassExtension',
      'SalesTable_Extension',
      '[ExtensionOf(classStr(SalesTableType))]\nfinal class SalesTable_Extension\n{\n}',
    );
    const result = await new XppMetadataParser().parseExtensionFile(file, 'class-extension');
    expect(result.data?.baseObjectName).toBe('SalesTableType');
  });

  it('reads the base object from the name convention for a table extension', async () => {
    // Real AxTableExtension XML has no <Extends> and no declaration at all.
    const file = await writeExtension('AxTableExtension', 'AccountingDistributionTmpTax.ApplicationSuite_Extension');
    const result = await new XppMetadataParser().parseExtensionFile(file, 'table-extension');
    expect(result.data?.baseObjectName).toBe('AccountingDistributionTmpTax');
  });

  it('splits the name on the first dot when the suffix contains dots', async () => {
    const file = await writeExtension('AxTableExtension', 'OMLegalEntity.Extension.Retail');
    const result = await new XppMetadataParser().parseExtensionFile(file, 'table-extension');
    expect(result.data?.baseObjectName).toBe('OMLegalEntity');
  });

  it('reads the base object for a form extension', async () => {
    const file = await writeExtension('AxFormExtension', 'AccountingDistribution.SubBillDeferralExtension');
    const result = await new XppMetadataParser().parseExtensionFile(file, 'form-extension');
    expect(result.data?.baseObjectName).toBe('AccountingDistribution');
  });
});
