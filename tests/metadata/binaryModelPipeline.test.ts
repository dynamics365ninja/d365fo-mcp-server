/**
 * Binary ISV models, end to end on SYNTHETIC fixtures (no vendor data):
 *   dump JSON (classes/tables/EDTs/enums + chain-of-command + platform info)
 *   + serialized AOT XML (forms, queries, views, data entities, maps, menu items, security, extensions)
 *   + label texts
 * -> `extract-binary-models` -> index JSON -> `XppSymbolIndex`.
 * The fixtures mirror what BinaryModelExtractor writes: object XML with method NAMES only, no bodies.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { XppSymbolIndex } from '../../src/metadata/symbolIndex';
import { indexAllLabels } from '../../src/metadata/labelParser';
import { resolveXppReferences } from '../../src/tools/write/resolveReferences';
import {
  checkBinaryCompat,
  convertBinaryModel,
  UNRESOLVED_ERROR_RATIO,
  type BinaryModelDump,
} from '../../src/metadata/binaryModelImport';

const repoRoot = path.resolve(__dirname, '..', '..');
const MODEL = 'ContosoTools';

const dump = (over: Partial<BinaryModelDump> = {}): BinaryModelDump => ({
  Model: 'Contoso Tools',
  ModelInfo: {
    Module: MODEL,
    Publisher: 'Contoso',
    VersionMajor: '1',
    VersionMinor: '2',
    VersionBuild: '3',
    VersionRevision: '4',
  },
  ProviderFileVersion: '7.0.1.2',
  Platform: { ProviderFileVersion: '7.0.1.2', Modules: { ApplicationSuite: '10.40.1.1' }, MissingModules: [] },
  Unresolved: { Checked: 10, Count: 0, Examples: [] },
  Classes: [
    {
      Name: 'ContosoPrinter',
      Extends: 'Object',
      Declaration: 'public class ContosoPrinter extends Object\n{\n}',
      Methods: [
        { Name: 'print', Visibility: 'public', ReturnType: 'boolean', Parameters: [{ Name: '_copies', Type: 'int' }] },
        { Name: 'construct', Visibility: 'public', IsStatic: true, ReturnType: 'ContosoPrinter', Parameters: [] },
      ],
    },
    {
      Name: 'ContosoPrinter_Contoso_Extension',
      IsFinal: true,
      Declaration: '[ExtensionOf(classStr(ContosoPrinter))]\nfinal class ContosoPrinter_Contoso_Extension\n{\n}',
      Attributes: [{ Name: 'ExtensionOf', Args: ['classStr'] }],
      Methods: [
        { Name: 'print', Visibility: 'public', ReturnType: 'boolean', Parameters: [{ Name: '_copies', Type: 'int' }] },
        { Name: 'helper', Visibility: 'public', ReturnType: 'void' },
      ],
    },
  ],
  ChainOfCommand: [
    {
      Class: 'ContosoPrinter_Contoso_Extension',
      Target: 'ContosoPrinter',
      TargetType: 'ClassTypeId',
      Methods: [{ Name: 'print', IsStatic: false, Owner: 'ContosoPrinter' }],
    },
  ],
  Tables: [{ Name: 'ContosoLog', Label: '@ContosoLabels:Log', Fields: [{ Name: 'Id', Type: 'Int64' }] }],
  ...over,
});

// ---- synthetic AOT XML, one per object type -------------------------------------------------------------
const XML: Record<string, Record<string, string>> = {
  AxForm: {
    ContosoLogForm: `<?xml version="1.0" encoding="utf-8"?>
<AxForm xmlns:i="http://www.w3.org/2001/XMLSchema-instance" xmlns="Microsoft.Dynamics.AX.Metadata.V6">
  <Name>ContosoLogForm</Name>
  <SourceCode>
    <Methods xmlns=""><Method><Name>classDeclaration</Name></Method><Method><Name>init</Name></Method></Methods>
    <DataSources xmlns=""><DataSource><Name>ContosoLog</Name><Methods><Method><Name>write</Name></Method></Methods></DataSource></DataSources>
  </SourceCode>
  <DataSources>
    <AxFormDataSource xmlns=""><Name>ContosoLog</Name><Table>ContosoLog</Table><Fields><AxFormDataSourceField><DataField>Id</DataField></AxFormDataSourceField></Fields></AxFormDataSource>
  </DataSources>
  <Design>
    <Caption xmlns="">@ContosoLabels:Log</Caption>
    <DataSource xmlns="">ContosoLog</DataSource>
    <Controls xmlns="">
      <AxFormControl xmlns="" i:type="AxFormGroupControl"><Name>Main</Name><Type>Group</Type>
        <Controls><AxFormControl xmlns="" i:type="AxFormStringControl"><Name>LogId</Name><Type>String</Type><DataField>Id</DataField><DataSource>ContosoLog</DataSource></AxFormControl></Controls>
      </AxFormControl>
    </Controls>
  </Design>
</AxForm>`,
  },
  AxQuery: {
    ContosoLogQuery: `<?xml version="1.0" encoding="utf-8"?>
<AxQuery xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
  <Name>ContosoLogQuery</Name>
  <DataSources><AxQuerySimpleRootDataSource><Name>ContosoLog</Name><Table>ContosoLog</Table><DataSources /><Fields><AxQuerySimpleDataSourceField><Name>Id</Name><Field>Id</Field></AxQuerySimpleDataSourceField></Fields></AxQuerySimpleRootDataSource></DataSources>
</AxQuery>`,
  },
  AxView: {
    ContosoLogView: `<?xml version="1.0" encoding="utf-8"?>
<AxView xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
  <Name>ContosoLogView</Name>
  <Query>ContosoLogQuery</Query>
  <Fields><AxViewField xmlns="" i:type="AxViewFieldBound"><Name>LogId</Name><DataField>Id</DataField><DataSource>ContosoLog</DataSource></AxViewField></Fields>
</AxView>`,
  },
  AxDataEntityView: {
    ContosoLogEntity: `<?xml version="1.0" encoding="utf-8"?>
<AxDataEntityView xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
  <Name>ContosoLogEntity</Name>
  <Label>@ContosoLabels:Log</Label>
  <IsPublic>Yes</IsPublic>
  <PrimaryKey>EntityKey</PrimaryKey>
  <PublicEntityName>ContosoLog</PublicEntityName>
  <PublicCollectionName>ContosoLogs</PublicCollectionName>
  <Keys><AxDataEntityViewKey><Name>EntityKey</Name><Fields><AxDataEntityViewKeyField><DataField>LogId</DataField></AxDataEntityViewKeyField></Fields></AxDataEntityViewKey></Keys>
  <Fields><AxDataEntityViewMappedField><Name>LogId</Name><DataField>Id</DataField><DataSource>ContosoLog</DataSource></AxDataEntityViewMappedField></Fields>
  <ViewMetadata><DataSources><AxQuerySimpleRootDataSource><Name>ContosoLog</Name><Table>ContosoLog</Table><DataSources /></AxQuerySimpleRootDataSource></DataSources></ViewMetadata>
</AxDataEntityView>`,
  },
  AxMap: {
    ContosoLogMap: `<?xml version="1.0" encoding="utf-8"?>
<AxMap xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
  <Name>ContosoLogMap</Name>
  <Fields><AxMapField xmlns="" i:type="AxMapFieldString"><Name>Text</Name><ExtendedDataType>Name</ExtendedDataType></AxMapField></Fields>
  <Mappings><AxMapMapping><MappingTable>ContosoLog</MappingTable></AxMapMapping></Mappings>
</AxMap>`,
  },
  AxMenuItemDisplay: {
    ContosoLogForm: `<?xml version="1.0" encoding="utf-8"?>
<AxMenuItemDisplay xmlns:i="http://www.w3.org/2001/XMLSchema-instance" xmlns="Microsoft.Dynamics.AX.Metadata.V1">
  <Name>ContosoLogForm</Name><Label>@ContosoLabels:Log</Label><Object>ContosoLogForm</Object>
</AxMenuItemDisplay>`,
  },
  AxSecurityPrivilege: {
    ContosoLogMaintain: `<?xml version="1.0" encoding="utf-8"?>
<AxSecurityPrivilege xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
  <Name>ContosoLogMaintain</Name><Label>@ContosoLabels:Log</Label>
  <EntryPoints><AxSecurityEntryPointReference><Name>ContosoLogForm</Name><Grant><Read>Allow</Read><Update>Allow</Update></Grant><ObjectName>ContosoLogForm</ObjectName><ObjectType>MenuItemDisplay</ObjectType></AxSecurityEntryPointReference></EntryPoints>
</AxSecurityPrivilege>`,
  },
  AxSecurityDuty: {
    ContosoLogMaintainDuty: `<?xml version="1.0" encoding="utf-8"?>
<AxSecurityDuty xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
  <Name>ContosoLogMaintainDuty</Name><Label>@ContosoLabels:Log</Label>
  <Privileges><AxSecurityPrivilegeReference><Name>ContosoLogMaintain</Name></AxSecurityPrivilegeReference></Privileges>
</AxSecurityDuty>`,
  },
  AxSecurityRole: {
    ContosoLogAdmin: `<?xml version="1.0" encoding="utf-8"?>
<AxSecurityRole xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
  <Name>ContosoLogAdmin</Name><Label>@ContosoLabels:Log</Label>
  <Duties><AxSecurityDutyReference><Name>ContosoLogMaintainDuty</Name></AxSecurityDutyReference></Duties>
</AxSecurityRole>`,
  },
  AxTableExtension: {
    'SalesTable.ContosoExtension': `<?xml version="1.0" encoding="utf-8"?>
<AxTableExtension xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
  <Name>SalesTable.ContosoExtension</Name>
  <Fields><AxTableField xmlns="" i:type="AxTableFieldString"><Name>ContosoNote</Name><ExtendedDataType>Name</ExtendedDataType></AxTableField></Fields>
</AxTableExtension>`,
  },
};

let tmp: string;
let dumpDir: string;
let outDir: string;

function writeFixture(dir: string, d: BinaryModelDump): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'Contoso Tools.binary.json'), JSON.stringify(d));
  const aot = path.join(dir, 'aot', MODEL, MODEL);
  for (const [folder, files] of Object.entries(XML)) {
    fs.mkdirSync(path.join(aot, folder), { recursive: true });
    for (const [name, xml] of Object.entries(files)) fs.writeFileSync(path.join(aot, folder, `${name}.xml`), xml);
  }
  const lbl = path.join(aot, 'AxLabelFile', 'LabelResources', 'en-US');
  fs.mkdirSync(lbl, { recursive: true });
  fs.writeFileSync(path.join(lbl, 'ContosoLabels.en-US.label.txt'), 'Log=Contoso log\nMode=Contoso mode\n');
}

function runImport(dir: string, out: string, extra: string[] = []) {
  return spawnSync(
    process.execPath,
    ['--import', 'tsx/esm', path.join(repoRoot, 'scripts', 'extract-binary-models.ts'), dir, '--out', out, ...extra],
    {
      cwd: repoRoot,
      encoding: 'utf-8',
      env: { ...process.env, NO_COLOR: '1' },
    },
  );
}

const readJson = (...p: string[]): Record<string, any> =>
  JSON.parse(fs.readFileSync(path.join(outDir, MODEL, ...p), 'utf-8'));

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'binary-isv-'));
  dumpDir = path.join(tmp, 'dump');
  outDir = path.join(tmp, 'meta');
  writeFixture(dumpDir, dump());
  const r = runImport(dumpDir, outDir);
  if (r.status !== 0) throw new Error(`import failed: ${r.stdout}\n${r.stderr}`);
}, 120_000);

afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('object coverage (one assertion block per AOT type)', () => {
  it('forms: data sources, controls, method names, no bodies', () => {
    const f = readJson('forms', 'ContosoLogForm.json');
    expect(f.dataSources[0]).toMatchObject({ name: 'ContosoLog', table: 'ContosoLog' });
    expect(JSON.stringify(f.design)).toContain('LogId');
    expect(f.methods.map((m: { name: string }) => m.name)).toEqual(['classDeclaration', 'init']);
    for (const m of f.methods as Array<{ source?: string }>) expect((m.source ?? '').trim()).toBe('');
  });

  it('queries: stored with their XML', () => {
    const q = readJson('queries', 'ContosoLogQuery.json');
    expect(q).toMatchObject({ name: 'ContosoLogQuery', model: MODEL, type: 'query' });
    expect(q.raw).toContain('AxQuerySimpleRootDataSource');
  });

  it('views, data entities (keys, fields, public names) and maps', () => {
    expect(readJson('views', 'ContosoLogView.json')).toMatchObject({ name: 'ContosoLogView', type: 'view' });
    const e = readJson('views', 'ContosoLogEntity.json');
    expect(e).toMatchObject({
      name: 'ContosoLogEntity',
      type: 'data-entity',
      publicEntityName: 'ContosoLog',
      publicCollectionName: 'ContosoLogs',
    });
    expect(readJson('maps', 'ContosoLogMap.json')).toMatchObject({ name: 'ContosoLogMap', type: 'map' });
  });

  it('menu items point at their object', () => {
    expect(readJson('menu-item-displays', 'ContosoLogForm.json')).toMatchObject({
      name: 'ContosoLogForm',
      targetObject: 'ContosoLogForm',
      type: 'menu-item-display',
    });
  });

  it('security: privilege entry points, duty -> privilege, role -> duty', () => {
    expect(JSON.stringify(readJson('security-privileges', 'ContosoLogMaintain.json').entryPoints)).toContain(
      'ContosoLogForm',
    );
    expect(JSON.stringify(readJson('security-duties', 'ContosoLogMaintainDuty.json'))).toContain('ContosoLogMaintain');
    expect(JSON.stringify(readJson('security-roles', 'ContosoLogAdmin.json'))).toContain('ContosoLogMaintainDuty');
  });

  it('extensions of platform objects', () => {
    expect(readJson('table-extensions', 'SalesTable.ContosoExtension.json')).toMatchObject({
      baseObjectName: 'SalesTable',
      type: 'table-extension',
    });
  });

  it('every stock-extracted object is stamped binary ISV with a binary-isv:// path (no dump path leaks)', () => {
    for (const [folder, name, ax] of [
      ['forms', 'ContosoLogForm', 'AxForm'],
      ['queries', 'ContosoLogQuery', 'AxQuery'],
      ['security-roles', 'ContosoLogAdmin', 'AxSecurityRole'],
    ]) {
      const o = readJson(folder, `${name}.json`);
      expect(o.sourcePath).toBe(`binary-isv://${MODEL}/${ax}/${name}`);
      expect(o.binaryIsv).toMatchObject({
        kind: 'binary-isv',
        vendor: 'Contoso',
        version: '1.2.3.4',
        platform: { ApplicationSuite: '10.40.1.1' },
      });
    }
  });

  it('classes, tables from the dump are written next to them', () => {
    expect(readJson('classes', 'ContosoPrinter.json').name).toBe('ContosoPrinter');
    expect(readJson('tables', 'ContosoLog.json').name).toBe('ContosoLog');
  });
});

describe('chain of command in binary extension classes', () => {
  it('takes the wrapped methods from the compiler record, not from bodies', () => {
    const ext = readJson('class-extensions', 'ContosoPrinter_Contoso_Extension.json');
    expect(ext).toMatchObject({
      baseObjectName: 'ContosoPrinter',
      cocMethods: ['print'],
      addedMethods: ['print', 'helper'],
    });
    const cls = readJson('classes', 'ContosoPrinter_Contoso_Extension.json');
    expect(cls.chainOfCommand).toEqual({ target: 'ContosoPrinter', targetType: 'ClassTypeId', wrapped: ['print'] });
    const tags = Object.fromEntries(
      (cls.methods as Array<{ name: string; tags: string[] }>).map(m => [m.name, m.tags]),
    );
    expect(tags.print).toContain('coc-wrapper');
    expect(tags.helper).not.toContain('coc-wrapper');
  });

  it('a class without a compiler CoC record keeps cocMethods empty', () => {
    const m = convertBinaryModel(dump({ ChainOfCommand: [] }));
    expect(m.classExtensions[0].cocMethods).toEqual([]);
  });
});

describe('index and labels', () => {
  it('indexes every object type and the CoC wraps', async () => {
    const index = new XppSymbolIndex(':memory:', ':memory:');
    await index.indexMetadataDirectory(outDir, [MODEL]);
    const db = index.getReadDb();
    const types = new Set(
      db
        .prepare('SELECT DISTINCT type FROM symbols WHERE model = ?')
        .all(MODEL)
        .map((r: any) => r.type),
    );
    for (const t of [
      'class',
      'class-extension',
      'table',
      'form',
      'query',
      'view',
      'map',
      'menu-item-display',
      'security-privilege',
      'security-duty',
      'security-role',
      'table-extension',
    ]) {
      expect(types, `symbol type ${t}`).toContain(t);
    }
    const row = db
      .prepare("SELECT coc_methods FROM extension_metadata WHERE extension_name = 'ContosoPrinter_Contoso_Extension'")
      .get() as { coc_methods: string };
    expect(JSON.parse(row.coc_methods)).toEqual(['print']);
    index.close?.();
  });

  it('validate_code(references) grounds calls into the ISV and catches invented ones', async () => {
    const index = new XppSymbolIndex(':memory:', ':memory:');
    await index.indexMetadataDirectory(outDir, [MODEL]);
    const deps = { db: index.getReadDb() };
    const ok = resolveXppReferences('class T { void run() { ContosoPrinter p = ContosoPrinter::construct(); } }', deps);
    expect(ok.violations).toEqual([]);
    expect(ok.verifiedCount).toBeGreaterThan(0);
    const bad = resolveXppReferences(
      'class T { void run() { ContosoPrinter p = ContosoPrinter::inventedFactory(); } }',
      deps,
    );
    expect(bad.violations.map(v => `${v.kind}:${v.severity}`)).toContain('unknown-static-member:error');
    index.close?.();
  });

  it('label texts end up next to the model JSON and are indexable', async () => {
    const labelDir = path.join(outDir, MODEL);
    expect(
      fs.existsSync(path.join(labelDir, 'AxLabelFile', 'LabelResources', 'en-US', 'ContosoLabels.en-US.label.txt')),
    ).toBe(true);
    const index = new XppSymbolIndex(':memory:', ':memory:');
    const { totalLabels: n } = await indexAllLabels(index, outDir);
    expect(n).toBe(2);
    const t = index.labelsDb
      .prepare("SELECT text FROM labels WHERE label_id = 'Log' AND label_file_id = 'ContosoLabels'")
      .get() as { text: string };
    expect(t.text).toBe('Contoso log');
    index.close?.();
  });
});

describe('platform compatibility', () => {
  it('is ok when every reference resolves', () => {
    expect(checkBinaryCompat(dump())).toMatchObject({ level: 'ok' });
  });

  it('warns when referenced application modules are not in the packages path', () => {
    const c = checkBinaryCompat(
      dump({ Platform: { ProviderFileVersion: '7.0.1.2', MissingModules: ['ApplicationSuite', 'Tax'] } }),
    );
    expect(c.level).toBe('warn');
    expect(c.messages.join(' ')).toContain('ApplicationSuite, Tax');
  });

  it('warns on a few unresolved references, errors when most do not resolve', () => {
    const few = checkBinaryCompat(dump({ Unresolved: { Checked: 100, Count: 2, Examples: ['class A -> B'] } }));
    expect(few.level).toBe('warn');
    expect(few.messages[0]).toContain('built against another application version');
    const many = checkBinaryCompat(
      dump({ Unresolved: { Checked: 100, Count: Math.ceil(UNRESOLVED_ERROR_RATIO * 100) + 1, Examples: [] } }),
    );
    expect(many.level).toBe('error');
  });

  it('flags objects the provider could not read', () => {
    expect(checkBinaryCompat(dump({ Errors: ['class X: boom'] })).level).toBe('warn');
  });

  it('import refuses an incompatible model unless --force', () => {
    const bad = path.join(tmp, 'dump-bad');
    writeFixture(bad, dump({ Unresolved: { Checked: 10, Count: 9, Examples: ['class A -> Missing'] } }));
    const refused = runImport(bad, path.join(tmp, 'meta-bad'));
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain('Refusing to import');
    expect(fs.existsSync(path.join(tmp, 'meta-bad', MODEL))).toBe(false);
    const forced = runImport(bad, path.join(tmp, 'meta-bad'), ['--force']);
    expect(forced.status).toBe(0);
    expect(fs.existsSync(path.join(tmp, 'meta-bad', MODEL, 'forms', 'ContosoLogForm.json'))).toBe(true);
  }, 120_000);
});
