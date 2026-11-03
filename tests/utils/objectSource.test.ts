/**
 * object_source: the index keeps every object's original XML, so a host with only the
 * database (no AOT files, no bridge) reads the same definition a host with the files does.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { gunzipSync } from 'node:zlib';

// A remap onto a configured packages root would make the file "reachable" on a dev box.
vi.mock('../../src/utils/metadataResolver', async (orig) => ({
  ...(await orig<typeof import('../../src/utils/metadataResolver')>()),
  resolveDbPathLocally: async () => null,
  remapDbPathLocally: async () => null,
  readViewMetadata: async () => null,
}));

// The configured model's folder is probed first; keep the test off the developer's config.
vi.mock('../../src/utils/objectFileLookup', async (orig) => ({
  ...(await orig<typeof import('../../src/utils/objectFileLookup')>()),
  findD365FileOnDisk: vi.fn(async () => null),
}));

import { XppSymbolIndex } from '../../src/metadata/symbolIndex';
import { XppMetadataParser } from '../../src/metadata/xmlParser';
import { readIndexedXml, resetStaleRootCache } from '../../src/utils/indexedXmlLookup';
import { findD365FileOnDisk } from '../../src/utils/objectFileLookup';
import { readObjectXml } from '../../src/tools/readers/objectXml';
import { getViewInfoTool } from '../../src/tools/readers/viewInfo';
import { getQueryInfoTool } from '../../src/tools/readers/queryInfo';
import { getReportInfoTool } from '../../src/tools/readers/reportInfo';
import { getMapInfoTool } from '../../src/tools/readers/mapInfo';
import { findBaseObjectXml } from '../../src/utils/baseObjectXml';
import { indexOneFile } from '../../src/tools/sdlc/updateSymbolIndex';

const AGENT = '/home/vsts/work/1/s/PackagesLocalDirectory/Pkg/Model';

const ENTITY_XML = `<?xml version="1.0" encoding="utf-8"?>
<AxDataEntityView xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
\t<Name>DemoSettlementEntity</Name>
\t<Label>@Demo:Settlement</Label>
\t<DataManagementEnabled>No</DataManagementEnabled>
\t<EntityCategory>Transaction</EntityCategory>
\t<IsPublic>Yes</IsPublic>
\t<IsReadOnly>Yes</IsReadOnly>
\t<PublicCollectionName>DemoSettlements</PublicCollectionName>
\t<PublicEntityName>DemoSettlement</PublicEntityName>
\t<Fields>
\t\t<AxDataEntityViewField xmlns="" i:type="AxDataEntityViewMappedField">
\t\t\t<Name>DueDate</Name>
\t\t\t<Label>@Demo:DueDate</Label>
\t\t\t<DataField>DueDate</DataField>
\t\t\t<DataSource>Settlement</DataSource>
\t\t</AxDataEntityViewField>
\t\t<AxDataEntityViewField xmlns="" i:type="AxDataEntityViewMappedField">
\t\t\t<Name>CustomerName</Name>
\t\t\t<DataField>Name</DataField>
\t\t\t<DataSource>Customer</DataSource>
\t\t</AxDataEntityViewField>
\t</Fields>
\t<ViewMetadata>
\t\t<Name>Metadata</Name>
\t\t<DataSources>
\t\t\t<AxQuerySimpleRootDataSource>
\t\t\t\t<Name>Settlement</Name>
\t\t\t\t<Table>DemoSettlement</Table>
\t\t\t\t<DataSources>
\t\t\t\t\t<AxQuerySimpleEmbeddedDataSource>
\t\t\t\t\t\t<Name>Customer</Name>
\t\t\t\t\t\t<JoinMode>OuterJoin</JoinMode>
\t\t\t\t\t\t<Table>DemoCustomer</Table>
\t\t\t\t\t</AxQuerySimpleEmbeddedDataSource>
\t\t\t\t</DataSources>
\t\t\t</AxQuerySimpleRootDataSource>
\t\t</DataSources>
\t</ViewMetadata>
</AxDataEntityView>`;

const MAP_XML = `<?xml version="1.0" encoding="utf-8"?>
<AxMap xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
\t<Name>DemoMap</Name>
\t<Fields>
\t\t<AxMapBaseField xmlns="" i:type="AxMapFieldString">
\t\t\t<Name>AccountNum</Name>
\t\t\t<ExtendedDataType>DemoAccount</ExtendedDataType>
\t\t</AxMapBaseField>
\t</Fields>
</AxMap>
`;
const QUERY_XML = '<?xml version="1.0" encoding="utf-8"?>\n<AxQuery><Name>DemoQuery</Name></AxQuery>\n';
const REPORT_XML = '<?xml version="1.0" encoding="utf-8"?>\n<AxReport><Name>DemoReport</Name></AxReport>\n';
const CLASS_XML = '<?xml version="1.0" encoding="utf-8"?>\n<AxClass><Name>DemoClass</Name></AxClass>\n';

let index: XppSymbolIndex;

beforeEach(() => {
  resetStaleRootCache();
  index = new XppSymbolIndex(':memory:', ':memory:');
});
afterEach(() => {
  index.close();
  vi.mocked(findD365FileOnDisk).mockImplementation(async () => null);
});

const call = (args: Record<string, unknown>) =>
  ({ method: 'tools/call', params: { name: 'get_object_info', arguments: args } }) as any;
const ctx = () => ({ symbolIndex: index, parser: new XppMetadataParser() }) as any;
const textOf = (res: any) => res.content[0].text as string;

const addTop = (name: string, type: string, folder: string, model = 'Model') =>
  index.addSymbol({ name, type, filePath: `${AGENT}/${folder}/${name}.xml`, model } as any);

const count = (where = ''): number =>
  (index.db.prepare(`SELECT COUNT(*) AS n FROM object_source ${where}`).get() as any).n;

describe('readIndexedXml and the stored copy', () => {
  it('answers a view from object_source when no file is reachable', async () => {
    addTop('DemoSettlementEntity', 'view', 'AxDataEntityView');
    index.writeObjectSource('view', 'DemoSettlementEntity', 'Model', ENTITY_XML);

    const found = await readIndexedXml(index.getReadDb(), 'demosettlemententity', ['view']);
    expect(found?.source).toBe('stored');
    expect(found?.xml).toBe(ENTITY_XML);
  });

  it('keys the copy by type: a table and a form of the same name keep their own XML', async () => {
    addTop('Shared', 'table', 'AxTable');
    addTop('Shared', 'form', 'AxForm');
    index.writeObjectSource('table', 'Shared', 'Model', '<AxTable/>');
    index.writeObjectSource('form', 'Shared', 'Model', '<AxForm/>');

    expect((await readIndexedXml(index.getReadDb(), 'Shared', ['table']))?.xml).toBe('<AxTable/>');
    expect((await readIndexedXml(index.getReadDb(), 'Shared', ['form']))?.xml).toBe('<AxForm/>');
  });

  it('reads a class extension through its class row, as the build indexes it', async () => {
    // The build writes the AxClass file as a top-level class and the extension as a row
    // under its base class.
    addTop('DemoClass_Extension', 'class', 'AxClass');
    index.addSymbol({
      name: 'DemoClass_Extension', type: 'class-extension', parentName: 'DemoClass',
      filePath: `${AGENT}/AxClass/DemoClass_Extension.xml`, model: 'Model',
    } as any);
    index.writeObjectSource('class', 'DemoClass_Extension', 'Model', CLASS_XML);

    const res = await readObjectXml('class-extension', 'DemoClass_Extension', { index });
    expect(res.isError).toBe(false);
    expect(res.text).toContain('<Name>DemoClass</Name>');
  });

  it('does not answer from a stored copy whose file this host knows was deleted', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'object-source-deleted-'));
    try {
      // The file's metadata root is here and populated, so absence means deleted.
      fs.mkdirSync(path.join(root, 'Pkg', 'Model', 'AxMap'), { recursive: true });
      index.addSymbol({ name: 'DemoMap', type: 'map', filePath: path.join(root, 'Pkg', 'Model', 'AxMap', 'DemoMap.xml'), model: 'Model' } as any);
      index.writeObjectSource('map', 'DemoMap', 'Model', MAP_XML);

      expect(await readIndexedXml(index.getReadDb(), 'DemoMap', ['map'])).toBeNull();
      expect(await findBaseObjectXml('map', 'DemoMap', index)).toBeNull();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('is a miss, not an error, in a database built before object_source', async () => {
    addTop('DemoMap', 'map', 'AxMap');
    index.db.exec('DROP TABLE object_source');
    expect(await readIndexedXml(index.getReadDb(), 'DemoMap', ['map'])).toBeNull();
  });
});

describe('get_object_info on a database-only host', () => {
  beforeEach(() => {
    addTop('DemoSettlementEntity', 'view', 'AxDataEntityView');
    index.writeObjectSource('view', 'DemoSettlementEntity', 'Model', ENTITY_XML);
    index.bulkAddLabels([
      { labelId: 'Settlement', labelFileId: 'Demo', model: 'Model', language: 'en-US', text: 'Customer settlement', comment: null, filePath: 'Demo.en-US.label.txt' },
      { labelId: 'DueDate', labelFileId: 'Demo', model: 'Model', language: 'en-US', text: 'Due date', comment: null, filePath: 'Demo.en-US.label.txt' },
    ] as any, { skipFtsRebuild: true });
  });

  it('renders a data entity with its properties, data sources and label text', async () => {
    const res: any = await getViewInfoTool(
      { method: 'tools/call', params: { name: 'get_object_info', arguments: { viewName: 'DemoSettlementEntity' } } } as any,
      { symbolIndex: index, parser: new XppMetadataParser() } as any,
    );
    const text = res.content[0].text as string;

    expect(text).toContain('Customer settlement (@Demo:Settlement)');
    expect(text).toContain('**Public Entity Name:** DemoSettlement');
    expect(text).toContain('**Public Collection Name:** DemoSettlements');
    expect(text).toContain('**OData Enabled (IsPublic):** Yes');
    expect(text).toContain('**Data Management (DMF):** No');
    expect(text).toContain('**Category:** Transaction');
    expect(text).toContain('| Settlement | DemoSettlement | root | — |');
    expect(text).toContain('| Customer | DemoCustomer | OuterJoin | Settlement |');
    expect(text).toContain('| DueDate | Settlement | DueDate | Due date (@Demo:DueDate) |');
    expect(text).toContain('stored copy in the index');
  });

  it('returns the stored XML for include="xml" on a data entity', async () => {
    const res = await readObjectXml('data-entity', 'DemoSettlementEntity', { index });
    expect(res.isError).toBe(false);
    expect(res.text).toContain('<PublicEntityName>DemoSettlement</PublicEntityName>');
    expect(res.text).toContain('stored copy in the index');
  });

  it('serves findBaseObjectXml from the stored copy', async () => {
    addTop('DemoMap', 'map', 'AxMap');
    index.writeObjectSource('map', 'DemoMap', 'Model', MAP_XML);
    expect(await findBaseObjectXml('map', 'DemoMap', index)).toBe(MAP_XML);
  });

  it('renders a map, a query and a report from the stored copy and labels it', async () => {
    addTop('DemoMap', 'map', 'AxMap');
    addTop('DemoQuery', 'query', 'AxQuery');
    addTop('DemoReport', 'report', 'AxReport');
    index.writeObjectSource('map', 'DemoMap', 'Model', MAP_XML);
    index.writeObjectSource('query', 'DemoQuery', 'Model', QUERY_XML);
    index.writeObjectSource('report', 'DemoReport', 'Model', REPORT_XML);

    const map = textOf(await getMapInfoTool(call({ mapName: 'DemoMap' }), ctx()));
    expect(map).toContain('`AccountNum`');
    expect(map).toContain('stored copy in the index');

    for (const text of [
      textOf(await getQueryInfoTool(call({ queryName: 'DemoQuery' }), ctx())),
      textOf(await getReportInfoTool(call({ reportName: 'DemoReport' }), ctx())),
    ]) {
      expect(text).toContain('stored copy in the index');
      expect(text).not.toContain('null');
    }
  });

  it('maps the get_object_info menu-item and config-key types onto their indexed types', async () => {
    addTop('DemoMenuItem', 'menu-item-action', 'AxMenuItemAction');
    addTop('DemoKey', 'configuration-key', 'AxConfigurationKey');
    index.writeObjectSource('menu-item-action', 'DemoMenuItem', 'Model', '<AxMenuItemAction><Name>DemoMenuItem</Name></AxMenuItemAction>');
    index.writeObjectSource('configuration-key', 'DemoKey', 'Model', '<AxConfigurationKey><Name>DemoKey</Name></AxConfigurationKey>');

    const item = await readObjectXml('menu-item', 'DemoMenuItem', { index });
    const key = await readObjectXml('config-key', 'DemoKey', { index });
    expect(item.isError).toBe(false);
    expect(item.text).toContain('<AxMenuItemAction>');
    expect(key.isError).toBe(false);
    expect(key.text).toContain('<AxConfigurationKey>');
  });

  it('returns the stored XML for include="xml" on a map', async () => {
    addTop('DemoMap', 'map', 'AxMap');
    index.writeObjectSource('map', 'DemoMap', 'Model', MAP_XML);
    const res = await readObjectXml('map', 'DemoMap', { index });
    expect(res.isError).toBe(false);
    expect(res.text).toContain('<ExtendedDataType>DemoAccount</ExtendedDataType>');
  });
});

describe('a file on this host beats the stored copy', () => {
  let root: string;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'object-source-live-')); });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('reads the live file the disk scan finds, not the copy taken at index time', async () => {
    const live = MAP_XML.replace('AccountNum', 'LiveField');
    const livePath = path.join(root, 'DemoMap.xml');
    fs.writeFileSync(livePath, live);
    vi.mocked(findD365FileOnDisk).mockResolvedValue(livePath);
    addTop('DemoMap', 'map', 'AxMap');
    index.writeObjectSource('map', 'DemoMap', 'Model', MAP_XML);

    expect(await findBaseObjectXml('map', 'DemoMap', index)).toBe(live);
    const map = textOf(await getMapInfoTool(call({ mapName: 'DemoMap' }), ctx()));
    expect(map).toContain('`LiveField`');
    expect(map).not.toContain('stored copy');
  });

  it('renders a data entity from its file the same way as from the stored copy', async () => {
    // <Model>/Ax<Type>/<Name>.xml: the disk reader takes the model from the path.
    fs.mkdirSync(path.join(root, 'Model', 'AxDataEntityView'), { recursive: true });
    const livePath = path.join(root, 'Model', 'AxDataEntityView', 'DemoSettlementEntity.xml');
    fs.writeFileSync(livePath, ENTITY_XML);
    addTop('DemoSettlementEntity', 'view', 'AxDataEntityView');
    index.writeObjectSource('view', 'DemoSettlementEntity', 'Model', ENTITY_XML);
    const fromStored = textOf(await getViewInfoTool(call({ viewName: 'DemoSettlementEntity' }), ctx()));

    vi.mocked(findD365FileOnDisk).mockResolvedValue(livePath);
    const fromFile = textOf(await getViewInfoTool(call({ viewName: 'DemoSettlementEntity' }), ctx()));

    const body = (t: string) => t.replace(/_Source:[^\n]*\n/, '');
    expect(fromFile).toContain('live file');
    expect(body(fromFile)).toBe(body(fromStored));
  });
});

describe('index build from extracted JSON', () => {
  let out: string;
  beforeEach(() => { out = fs.mkdtempSync(path.join(os.tmpdir(), 'object-source-build-')); });
  afterEach(() => fs.rmSync(out, { recursive: true, force: true }));

  const json = (folder: string, name: string, data: Record<string, unknown>) => {
    const dir = path.join(out, 'DemoPkg', folder);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify({ name, sourcePath: `${AGENT}/${name}.xml`, ...data }));
  };

  it('stores each type under its own key, and nothing without raw or for an extension', async () => {
    json('views', 'DemoSettlementEntity', { type: 'data-entity', fields: [], raw: ENTITY_XML });
    json('maps', 'DemoMap', { raw: MAP_XML });
    json('classes', 'DemoClass', { methods: [], raw: CLASS_XML });
    json('tables', 'DemoTable', { fields: [] });
    json('table-extensions', 'DemoTable.Ext', { baseObjectName: 'DemoTable', raw: '<AxTableExtension/>' });

    await index.indexMetadataDirectory(out, 'DemoPkg');

    const keys = (index.db.prepare('SELECT object_type, name FROM object_source ORDER BY object_type').all() as any[])
      .map(r => `${r.object_type}:${r.name}`);
    expect(keys).toEqual(['class:DemoClass', 'map:DemoMap', 'view:DemoSettlementEntity']);
  });
});

describe('keeping object_source in step', () => {
  it('removeSymbolsByFile removes the stored copy, but not a form of the same name', () => {
    addTop('Shared', 'table', 'AxTable');
    addTop('Shared', 'form', 'AxForm');
    index.writeObjectSource('table', 'Shared', 'Model', '<AxTable/>');
    index.writeObjectSource('form', 'Shared', 'Model', '<AxForm/>');

    index.removeSymbolsByFile(`${AGENT}/AxTable/Shared.xml`);

    expect(count(`WHERE object_type = 'table'`)).toBe(0);
    expect(count(`WHERE object_type = 'form'`)).toBe(1);
  });

  it('clearModels removes only the named models', () => {
    index.writeObjectSource('map', 'A', 'ModelA', MAP_XML);
    index.writeObjectSource('map', 'B', 'ModelB', MAP_XML);
    index.clearModels(['ModelA']);
    expect(count(`WHERE model = 'ModelA'`)).toBe(0);
    expect(count(`WHERE model = 'ModelB'`)).toBe(1);
  });
});

describe('update_symbol_index', () => {
  let root: string;
  let file: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'object-source-'));
    const dir = path.join(root, 'PackagesLocalDirectory', 'DemoPkg', 'DemoPkg', 'AxDataEntityView');
    fs.mkdirSync(dir, { recursive: true });
    file = path.join(dir, 'DemoSettlementEntity.xml');
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  const stored = () => {
    const row = index.db.prepare(`SELECT xml_gz FROM object_source WHERE object_type = 'view'`).get() as any;
    return row ? gunzipSync(row.xml_gz).toString('utf-8') : null;
  };

  it('replaces the stored copy on an edit and removes it on a delete', async () => {
    fs.writeFileSync(file, ENTITY_XML);
    await indexOneFile(file, { symbolIndex: index } as any);
    expect(stored()).toBe(ENTITY_XML);

    const edited = ENTITY_XML.replace('<EntityCategory>Transaction', '<EntityCategory>Master');
    fs.writeFileSync(file, edited);
    await indexOneFile(file, { symbolIndex: index } as any);
    expect(count()).toBe(1);
    expect(stored()).toBe(edited);

    fs.rmSync(file);
    await indexOneFile(file, { symbolIndex: index } as any);
    expect(count()).toBe(0);
  });

  it('does not store an extension', async () => {
    const dir = path.join(root, 'PackagesLocalDirectory', 'DemoPkg', 'DemoPkg', 'AxTableExtension');
    fs.mkdirSync(dir, { recursive: true });
    const ext = path.join(dir, 'DemoTable.Ext.xml');
    fs.writeFileSync(ext, '<?xml version="1.0" encoding="utf-8"?>\n<AxTableExtension><Name>DemoTable.Ext</Name></AxTableExtension>\n');

    await indexOneFile(ext, { symbolIndex: index } as any);

    expect(count()).toBe(0);
  });
});
