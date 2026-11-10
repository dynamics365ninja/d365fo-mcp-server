/**
 * Binary ISV models: BinaryModelExtractor dump -> index JSON.
 * Fixture is hand-written in the extractor's output shape (no vendor data).
 */
import { describe, it, expect } from 'vitest';
import { convertBinaryModel, KERNEL_MODEL, type BinaryModelDump } from '../../src/metadata/binaryModelImport.js';

const dump = (over: Partial<BinaryModelDump> = {}): BinaryModelDump => ({
  Model: 'Contoso Tools',
  ModelInfo: {
    Module: 'ContosoTools',
    Publisher: 'Contoso',
    VersionMajor: '1',
    VersionMinor: '2',
    VersionBuild: '3',
    VersionRevision: '4',
  },
  Classes: [
    {
      Name: 'ContosoPrinter',
      Extends: 'Object',
      IsFinal: false,
      IsInternal: false,
      Declaration:
        '/// <summary>\n/// Prints things.\n/// </summary>\npublic class ContosoPrinter extends Object\n{\n}',
      Attributes: [],
      Methods: [
        {
          Name: 'print',
          Visibility: 'public',
          ReturnType: 'boolean',
          Parameters: [
            { Name: '_copies', Type: 'int', DefaultValue: '1' },
            { Name: '_name', Type: 'str' },
          ],
          Attributes: [{ Name: 'Hookable', Args: ['False'] }],
        },
        { Name: 'construct', Visibility: 'public', IsStatic: true, ReturnType: 'ContosoPrinter', Parameters: [] },
      ],
    },
    {
      Name: 'SalesTable_Contoso_Extension',
      IsFinal: true,
      Declaration: '[ExtensionOf(tableStr(SalesTable))]\nfinal class SalesTable_Contoso_Extension\n{\n}',
      Attributes: [{ Name: 'ExtensionOf', Args: ['tableStr'] }],
      Methods: [{ Name: 'acmeCheck', Visibility: 'public', ReturnType: 'void' }],
    },
  ],
  Tables: [
    {
      Name: 'ContosoLog',
      Label: '@Contoso:Log',
      PrimaryIndex: 'IdIdx',
      Fields: [{ Name: 'Id', Type: 'Int64', Edt: 'RefRecId', Mandatory: true }],
      Indexes: [{ Name: 'IdIdx', Unique: true, Fields: ['Id'] }],
    },
  ],
  Enums: [
    {
      Name: 'ContosoMode',
      Values: [
        { Name: 'A', Value: 0 },
        { Name: 'B', Value: 1 },
      ],
    },
  ],
  ...over,
});

describe('convertBinaryModel', () => {
  const m = convertBinaryModel(dump());

  it('names the model after the module and records vendor/version', () => {
    expect(m.model).toBe('ContosoTools');
    expect(m.info).toMatchObject({ vendor: 'Contoso', version: '1.2.3.4', kind: 'binary-isv' });
  });

  it('never carries method source or raw XML', () => {
    for (const c of m.classes) {
      expect((c as { raw?: string }).raw).toBeUndefined();
      for (const meth of c.methods as Array<{ source: string }>) expect(meth.source).toBe('');
    }
  });

  it('keeps parameters, defaults, return type and marks the entry as binary ISV', () => {
    const cls = m.classes.find(c => c.name === 'ContosoPrinter')!;
    const print = (cls.methods as Array<Record<string, unknown>>).find(x => x.name === 'print')!;
    expect(print.parameters).toEqual([
      { name: '_copies', type: 'int', defaultValue: '1' },
      { name: '_name', type: 'str' },
    ]);
    expect(print.returnType).toBe('boolean');
    expect(String(print.documentation)).toContain('binary ISV, signatures only');
    expect(String(print.documentation)).toContain('[Hookable(False)]');
    expect(print.tags).toContain('hookable');
    expect(String(cls.description)).toContain('Prints things.');
  });

  it('derives [ExtensionOf] from the declaration and emits a class-extension record', () => {
    expect(m.classExtensions).toHaveLength(1);
    expect(m.classExtensions[0]).toMatchObject({
      name: 'SalesTable_Contoso_Extension',
      baseObjectName: 'SalesTable',
      baseKind: 'table',
      addedMethods: ['acmeCheck'],
    });
  });

  it('converts tables and enums', () => {
    expect(m.tables[0]).toMatchObject({ name: 'ContosoLog', primaryIndex: 'IdIdx' });
    expect((m.tables[0].indexes as Array<{ unique: boolean }>)[0].unique).toBe(true);
    expect((m.enums[0].values as unknown[]).length).toBe(2);
  });

  it('keeps the base table of a table that extends another, and imports the platform kernel like any model', () => {
    const k = convertBinaryModel(
      dump({
        Model: 'Kernel',
        ModelInfo: {
          Module: 'Kernel',
          Publisher: 'Microsoft',
          VersionMajor: '7',
          VersionMinor: '0',
          VersionBuild: '1',
          VersionRevision: '2',
        },
        Classes: [],
        Tables: [
          { Name: 'Common', Methods: [{ Name: 'update', Visibility: 'public', ReturnType: 'void' }] },
          { Name: 'ContosoChild', Extends: 'ContosoBase' },
        ],
      }),
    );
    expect(k.model).toBe(KERNEL_MODEL);
    expect(k.tables.find(t => t.name === 'ContosoChild')?.extends).toBe('ContosoBase');
    expect(k.tables.find(t => t.name === 'Common')?.methods).toHaveLength(1);
  });
});
