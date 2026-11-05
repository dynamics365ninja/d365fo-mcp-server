/**
 * Version diff of extracted-metadata directories. Fixtures are hand-written in the shapes
 * extract-metadata (source models) and extract-binary-models (binary ISV models) write.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  canonicalMethod,
  diffSnapshots,
  isEmptyDiff,
  leadingAttributes,
  listModels,
  loadModelSnapshot,
  type ModelSnapshot,
} from '../../src/metadata/versionDiff';

const snapshot = (): ModelSnapshot => ({
  model: 'ContosoCore',
  classes: [
    {
      name: 'ContosoPrinter',
      extends: 'Object',
      declaration: 'public class ContosoPrinter extends Object\n{\n}',
      methods: [
        {
          name: 'print',
          visibility: 'public',
          returnType: 'boolean',
          parameters: [
            { name: '_copies', type: 'int', defaultValue: '1' },
            { name: '_name', type: 'str' },
          ],
          source: 'public boolean print(int _copies = 1, str _name)\n{\n    return true;\n}',
        },
        {
          name: 'construct',
          visibility: 'public',
          isStatic: true,
          returnType: 'ContosoPrinter',
          parameters: [],
          source: '',
        },
      ],
    },
  ],
  tables: [
    {
      name: 'ContosoLog',
      fields: [
        { name: 'Id', type: 'Int64', extendedDataType: 'RefRecId' },
        { name: 'Note', type: 'String', extendedDataType: 'Notes' },
      ],
    },
  ],
  edts: [{ name: 'ContosoCode', extends: 'Name', stringSize: 10 }],
  enums: [
    {
      name: 'ContosoMode',
      raw: '<AxEnum><EnumValues><AxEnumValue><Name>A</Name></AxEnumValue><AxEnumValue><Name>B</Name></AxEnumValue></EnumValues></AxEnum>',
    },
  ],
});

describe('leadingAttributes', () => {
  it('reads attribute lines in front of a declaration, with arguments and shared lines', () => {
    const text = '[Hookable(false)]\n[SysObsolete("@Contoso:UseV2", false)]\npublic void f() {}';
    expect(leadingAttributes(text)).toEqual(['[Hookable(false)]', '[SysObsolete("@Contoso:UseV2", false)]']);
    expect(leadingAttributes('[A][B(x[0])] public void f() {}')).toEqual(['[A]', '[B(x[0])]']);
  });

  it('skips doc comments and returns nothing when the text starts with modifiers', () => {
    expect(leadingAttributes('/// <summary>x</summary>\n[A]\npublic void f() {}')).toEqual(['[A]']);
    expect(leadingAttributes('public void f() { int[] a; }')).toEqual([]);
    expect(leadingAttributes(undefined)).toEqual([]);
  });
});

describe('diffSnapshots', () => {
  it('is empty for identical snapshots', () => {
    expect(isEmptyDiff(diffSnapshots(snapshot(), snapshot()))).toBe(true);
  });

  it('reports added and removed classes, methods and header changes', () => {
    const b = snapshot();
    b.classes[0].extends = 'RunBase';
    b.classes[0].methods = [
      { ...b.classes[0].methods![0] },
      { name: 'preview', visibility: 'public', returnType: 'void', parameters: [], source: '' },
    ];
    b.classes.push({ name: 'ContosoNew', methods: [] });
    const d = diffSnapshots(snapshot(), b);
    expect(d.classesAdded).toEqual(['ContosoNew']);
    expect(d.methodsAdded).toEqual(['ContosoPrinter.preview']);
    expect(d.methodsRemoved).toEqual(['ContosoPrinter.construct']);
    expect(d.classesChanged).toEqual([{ class: 'ContosoPrinter', before: 'extends Object', after: 'extends RunBase' }]);
  });

  it('reports a changed signature with before and after, defaults included', () => {
    const b = snapshot();
    b.classes[0].methods![0].parameters = [{ name: '_copies', type: 'int' }];
    const d = diffSnapshots(snapshot(), b);
    expect(d.methodsChanged).toHaveLength(1);
    expect(d.methodsChanged[0].before).toBe('public boolean print(int _copies = 1, str _name)');
    expect(d.methodsChanged[0].after).toBe('public boolean print(int _copies)');
  });

  it('breaks out a method that gained [SysObsolete], from source text and from binary attributes alike', () => {
    const fromSource = snapshot();
    fromSource.classes[0].methods![0].source =
      '[SysObsolete("@Contoso:UseV2")]\npublic boolean print(int _copies = 1, str _name)\n{\n}';
    const fromBinary = snapshot();
    fromBinary.classes[0].methods![1] = {
      ...fromBinary.classes[0].methods![1],
      attributes: ['[SysObsolete("@Contoso:Gone", true)]'],
    };
    expect(diffSnapshots(snapshot(), fromSource).newlyObsolete).toEqual(['ContosoPrinter.print']);
    expect(diffSnapshots(snapshot(), fromBinary).newlyObsolete).toEqual(['ContosoPrinter.construct']);
    expect(diffSnapshots(fromSource, fromSource).newlyObsolete).toEqual([]);
  });

  it('detects an obsolete class from its declaration', () => {
    const b = snapshot();
    b.classes[0].declaration = '[SysObsolete("@Contoso:Old")]\npublic class ContosoPrinter extends Object\n{\n}';
    const d = diffSnapshots(snapshot(), b);
    expect(d.newlyObsolete).toEqual(['ContosoPrinter']);
    expect(d.classesChanged).toHaveLength(1);
  });

  it('diffs tables and fields, EDTs and enums (values from the stored XML or from a values list)', () => {
    const b = snapshot();
    b.tables[0].fields = [
      { name: 'Id', type: 'Int64', extendedDataType: 'RecId' },
      { name: 'Added', type: 'String' },
    ];
    b.tables.push({ name: 'ContosoNewTable', fields: [] });
    b.edts[0] = { name: 'ContosoCode', extends: 'Name', stringSize: 20 };
    b.edts.push({ name: 'ContosoNewEdt' });
    b.enums = [
      { name: 'ContosoMode', values: [{ name: 'A' }, { name: 'C' }] },
      { name: 'ContosoNewEnum', values: [] },
    ];
    const d = diffSnapshots(snapshot(), b);
    expect(d.tablesAdded).toEqual(['ContosoNewTable']);
    expect(d.fieldsAdded).toEqual(['ContosoLog.Added']);
    expect(d.fieldsRemoved).toEqual(['ContosoLog.Note']);
    expect(d.fieldsChanged).toEqual([{ field: 'ContosoLog.Id', before: 'Int64 RefRecId', after: 'Int64 RecId' }]);
    expect(d.edtsAdded).toEqual(['ContosoNewEdt']);
    expect(d.edtsChanged).toEqual([
      { edt: 'ContosoCode', before: 'extends Name size 10', after: 'extends Name size 20' },
    ]);
    expect(d.enumsAdded).toEqual(['ContosoNewEnum']);
    expect(d.enumValuesAdded).toEqual(['ContosoMode.C']);
    expect(d.enumValuesRemoved).toEqual(['ContosoMode.B']);
  });

  it('writes a method the same way whichever shape it came from', () => {
    expect(canonicalMethod({ name: 'f', returnType: 'void', parameters: [], attributes: ['[B]', '[A]'] })).toBe(
      '[A][B] public void f()',
    );
  });
});

describe('model directories', () => {
  let tmp = '';
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('lists the models that hold extracted objects and loads their snapshot', () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'version-diff-'));
    fs.mkdirSync(path.join(tmp, 'ContosoCore', 'classes'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'NotAModel'), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, 'ContosoCore', 'classes', 'ContosoPrinter.json'),
      JSON.stringify(snapshot().classes[0]),
    );
    expect(listModels(tmp)).toEqual(['ContosoCore']);
    const s = loadModelSnapshot(tmp, 'ContosoCore');
    expect(s.classes.map(c => c.name)).toEqual(['ContosoPrinter']);
    expect(s.tables).toEqual([]);
  });
});
