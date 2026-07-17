/**
 * Class-extension extraction from AxClass files.
 *
 * Regression (#693): extraction looked for class extensions in an
 * `AxClassExtension` folder, which does not exist anywhere in the AOT. Class
 * extensions are ordinary AxClass files carrying [ExtensionOf(...)], so they
 * were indexed as plain classes and produced ZERO rows of type
 * 'class-extension' in symbols and extension_metadata — both branches of
 * find_coc_extensions structurally returned nothing for every class, and
 * resolve_references could not resolve any CoC-added method.
 *
 * Roughly 4,500 class extensions across the AOT were affected; ~74% of them
 * are `next`-calling CoC wrappers, i.e. exactly what the tool exists to find.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  XppMetadataParser,
  buildClassExtensionRecord,
  extensionMembersFrom,
} from '../../src/metadata/xmlParser';
import { parseExtensionOfAttribute, callsNext } from '../../src/metadata/xppDeclaration';

let tmpDir: string;

const writeClass = async (name: string, declaration: string, methods: Array<{ name: string; source: string }> = []) => {
  const xml = [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<AxClass xmlns:i="http://www.w3.org/2001/XMLSchema-instance">',
    `  <Name>${name}</Name>`,
    '  <SourceCode>',
    `    <Declaration><![CDATA[${declaration}]]></Declaration>`,
    '    <Methods>',
    ...methods.flatMap(m => [
      '      <Method>',
      `        <Name>${m.name}</Name>`,
      `        <Source><![CDATA[${m.source}]]></Source>`,
      '      </Method>',
    ]),
    '    </Methods>',
    '  </SourceCode>',
    '</AxClass>',
  ].join('\n');
  const file = path.join(tmpDir, `${name}.xml`);
  await fs.writeFile(file, xml, 'utf-8');
  return file;
};

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xpp-class-ext-'));
});

afterAll(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('parseExtensionOfAttribute', () => {
  it('reads the base object off a classStr extension', () => {
    expect(parseExtensionOfAttribute('[ExtensionOf(classStr(SalesFormLetter))]\nfinal class Foo_Extension\n{\n}'))
      .toMatchObject({ baseObjectName: 'SalesFormLetter', baseKind: 'class' });
  });

  it('matches the intrinsic case-insensitively', () => {
    // All of these casings occur in the AOT.
    for (const intrinsic of ['classStr', 'classstr', 'ClassStr', 'CLASSSTR']) {
      expect(parseExtensionOfAttribute(`[ExtensionOf(${intrinsic}(CustTable))]\nfinal class C\n{\n}`))
        .toMatchObject({ baseObjectName: 'CustTable', baseKind: 'class' });
    }
  });

  it('handles bases that are not classes', () => {
    // A class extension's base isn't always a class — tableStr / formStr /
    // dataEntityViewStr all appear on [ExtensionOf].
    expect(parseExtensionOfAttribute('[ExtensionOf(tableStr(CustTable))]\nfinal class T\n{\n}'))
      .toMatchObject({ baseObjectName: 'CustTable', baseKind: 'table' });
    expect(parseExtensionOfAttribute('[ExtensionOf(dataentityviewstr(CustCustomerV3Entity))]\nfinal class D\n{\n}'))
      .toMatchObject({ baseObjectName: 'CustCustomerV3Entity', baseKind: 'dataentityview' });
  });

  it('takes the first argument of the two-argument intrinsics', () => {
    // The old single-argument regex declined to match these entirely.
    expect(parseExtensionOfAttribute('[ExtensionOf(formDataSourceStr(SalesTable, SalesLine))]\nfinal class F\n{\n}'))
      .toMatchObject({ baseObjectName: 'SalesTable', baseKind: 'formdatasource', memberName: 'SalesLine' });
    expect(parseExtensionOfAttribute('[ExtensionOf(formControlStr(CustTable, OKButton))]\nfinal class G\n{\n}'))
      .toMatchObject({ baseObjectName: 'CustTable', baseKind: 'formcontrol', memberName: 'OKButton' });
  });

  it('ignores an [ExtensionOf] quoted in a doc comment', () => {
    const decl = '/// <summary>\n/// Replaces [ExtensionOf(classStr(WrongBase))] on the old class.\n/// </summary>\n'
      + '[ExtensionOf(classStr(RightBase))]\nfinal class H_Extension\n{\n}';
    expect(parseExtensionOfAttribute(decl)?.baseObjectName).toBe('RightBase');
  });

  it('returns null for a class with no [ExtensionOf]', () => {
    expect(parseExtensionOfAttribute('final class NotAnExtension extends Base\n{\n}')).toBeNull();
    expect(parseExtensionOfAttribute('')).toBeNull();
  });
});

describe('callsNext', () => {
  it('detects a CoC next call', () => {
    expect(callsNext('public void insert()\n{\n    next insert();\n}')).toBe(true);
  });

  it('does not count `next` mentioned only in a comment', () => {
    expect(callsNext('public void insert()\n{\n    // remember to call next insert() here\n}')).toBe(false);
  });

  it('is false for a method that adds new behaviour', () => {
    expect(callsNext('public str newHelper()\n{\n    return "x";\n}')).toBe(false);
  });
});

describe('parseClassFile [ExtensionOf] detection', () => {
  it('flags an AxClass carrying [ExtensionOf] as a class extension', async () => {
    const file = await writeClass(
      'SalesFormLetter_MyExt',
      '[ExtensionOf(classStr(SalesFormLetter))]\nfinal class SalesFormLetter_MyExt\n{\n}',
    );
    const result = await new XppMetadataParser().parseClassFile(file, 'MyModel');

    expect(result.success).toBe(true);
    expect(result.data?.extensionOf).toMatchObject({ baseObjectName: 'SalesFormLetter', baseKind: 'class' });
  });

  it('leaves extensionOf undefined for an ordinary class', async () => {
    const file = await writeClass('PlainClass', 'final class PlainClass extends Base\n{\n}');
    const result = await new XppMetadataParser().parseClassFile(file, 'MyModel');

    expect(result.data?.extensionOf).toBeUndefined();
  });

  it('does not treat the *_Extension name convention as the signal', async () => {
    // 87 of 400 AOT classes named *_Extension carry no [ExtensionOf] at all —
    // the attribute is the signal, the name is not.
    const file = await writeClass('Looks_Extension', 'final class Looks_Extension\n{\n}');
    const result = await new XppMetadataParser().parseClassFile(file, 'MyModel');

    expect(result.data?.extensionOf).toBeUndefined();
    expect(buildClassExtensionRecord(result.data!, 'MyModel')).toBeNull();
  });
});

describe('extensionMembersFrom', () => {
  it('separates CoC wrappers from added methods and event subscriptions', () => {
    const members = extensionMembersFrom([
      { name: 'insert', source: 'public void insert()\n{\n    next insert();\n}' },
      { name: 'helper', source: 'public str helper()\n{\n    return "x";\n}' },
      { name: 'onInserted', source: '[SubscribesTo(tableStr(CustTable), delegateStr(CustTable, onInserted))]\npublic static void onInserted(Common _c)\n{\n}' },
    ]);

    expect(members.addedMethods).toEqual(['insert', 'helper', 'onInserted']);
    expect(members.cocMethods).toEqual(['insert']);
    expect(members.eventSubscriptions).toHaveLength(1);
  });

  it('skips unnamed methods', () => {
    expect(extensionMembersFrom([{ name: '', source: 'next foo();' }]).addedMethods).toEqual([]);
  });
});

describe('buildClassExtensionRecord', () => {
  it('produces an indexable class-extension record with CoC methods', async () => {
    const file = await writeClass(
      'CustTable_MyExt',
      '[ExtensionOf(tableStr(CustTable))]\nfinal class CustTable_MyExt\n{\n}',
      [
        { name: 'insert', source: 'public void insert()\n{\n    next insert();\n}' },
        { name: 'myHelper', source: 'public str myHelper()\n{\n    return "x";\n}' },
      ],
    );
    const parsed = await new XppMetadataParser().parseClassFile(file, 'MyModel');
    const record = buildClassExtensionRecord(parsed.data!, 'MyModel');

    expect(record).toMatchObject({
      name: 'CustTable_MyExt',
      baseObjectName: 'CustTable',
      baseKind: 'table',
      type: 'class-extension',
      model: 'MyModel',
      cocMethods: ['insert'],
      addedMethods: ['insert', 'myHelper'],
      // A class extension adds neither, but the shape stays uniform with the
      // Ax*Extension kinds so indexExtensions can read it generically.
      addedFields: [],
      addedIndexes: [],
    });
  });

  it('carries the data source name for a two-argument intrinsic', async () => {
    const file = await writeClass(
      'SalesTable_DsExt',
      '[ExtensionOf(formDataSourceStr(SalesTable, SalesLine))]\nfinal class SalesTable_DsExt\n{\n}',
    );
    const parsed = await new XppMetadataParser().parseClassFile(file, 'MyModel');

    expect(buildClassExtensionRecord(parsed.data!, 'MyModel'))
      .toMatchObject({ baseObjectName: 'SalesTable', baseMemberName: 'SalesLine' });
  });
});
