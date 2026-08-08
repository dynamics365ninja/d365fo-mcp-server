/**
 * Symbol-index fallback for the get_object_info readers.
 *
 * Regression guard for the "bridge silent ⇒ object does not exist" bug class:
 * `search` resolved e.g. TaxTransDeclarationView while get_object_info answered
 * "not found. Bridge returned no data". Every reader must fall back to the symbol
 * index (and disk) before it claims an object is missing.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import type { XppServerContext } from '../../src/types/context';

// Bridge returns nothing for every reader — the scenario under test.
vi.mock('../../src/bridge/bridgeAdapter', () => ({
  tryBridgeTable: vi.fn(async () => null),
  tryBridgeClass: vi.fn(async () => null),
  tryBridgeEnum: vi.fn(async () => null),
  tryBridgeEdt: vi.fn(async () => null),
  tryBridgeForm: vi.fn(async () => null),
  tryBridgeQuery: vi.fn(async () => null),
  tryBridgeView: vi.fn(async () => null),
  tryBridgeDataEntity: vi.fn(async () => null),
  tryBridgeReport: vi.fn(async () => null),
  tryBridgeMethodSource: vi.fn(async () => null),
}));

// No disk scan — the index path is what these tests exercise.
vi.mock('../../src/tools/write/modifyD365File', async (orig) => {
  const actual = await orig<typeof import('../../src/tools/write/modifyD365File')>();
  return { ...actual, findD365FileOnDisk: vi.fn(async () => null) };
});

// No extracted-metadata store in the test env → readers must use the indexed XML.
vi.mock('../../src/utils/metadataResolver', async (orig) => {
  const actual = await orig<typeof import('../../src/utils/metadataResolver')>();
  return {
    ...actual,
    readEnumRawXml: vi.fn(async () => null),
    readViewMetadata: vi.fn(async () => null),
    buildObjectTypeMismatchMessage: vi.fn(() => ''),
  };
});

const INDEX_ROOT = 'K:\\Indexed';

const XML: Record<string, string> = {
  'SalesTableListPage.xml':
    `<?xml version="1.0"?><AxQuery><Name>SalesTableListPage</Name><Title>@SYS1</Title>` +
    `<DataSources><AxQuerySimpleRootDataSource><Name>SalesTable</Name><Table>SalesTable</Table>` +
    `</AxQuerySimpleRootDataSource></DataSources></AxQuery>`,
  'SalesStatus.xml':
    `<?xml version="1.0"?><AxEnum><Name>SalesStatus</Name><IsExtensible>Yes</IsExtensible>` +
    `<EnumValues><AxEnumValue><Name>Backorder</Name><Value>1</Value><Label>@SYS1</Label></AxEnumValue>` +
    `</EnumValues></AxEnum>`,
  'SalesTable.xml':
    `<?xml version="1.0"?><AxForm><Name>SalesTable</Name><DataSources><AxFormDataSource>` +
    `<Name>SalesTable</Name><Table>SalesTable</Table></AxFormDataSource></DataSources></AxForm>`,
  'SalesInvoiceReport.xml':
    `<?xml version="1.0"?><AxReport><Name>SalesInvoiceReport</Name><DataSets><AxReportDataSet>` +
    `<Name>SalesInvoiceDS</Name><DataSourceType>Query</DataSourceType><Query>SalesInvoiceQuery</Query>` +
    `</AxReportDataSet></DataSets></AxReport>`,
};

// Indexed paths exist and are readable; everything else is absent.
vi.mock('fs', async (orig) => {
  const actual = await orig<typeof import('fs')>();
  return {
    ...actual,
    existsSync: vi.fn((p: any) => String(p).startsWith(INDEX_ROOT)),
    promises: {
      ...actual.promises,
      readFile: vi.fn(async (p: any) => {
        const file = String(p).split('\\').pop() ?? '';
        if (XML[file]) return XML[file];
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      }),
    },
  };
});

import { getObjectInfoTool } from '../../src/tools/readers/getObjectInfo';
import { dataEntityInfoTool } from '../../src/tools/readers/dataEntityInfo';

const req = (name: string, args: Record<string, unknown>): CallToolRequest => ({
  method: 'tools/call',
  params: { name, arguments: args },
});

const makeStmt = (rows: any[] = [], row: any = undefined) => ({
  all: vi.fn(() => rows),
  get: vi.fn(() => row),
  run: vi.fn(() => ({ changes: 0 })),
});

/** DB that knows exactly one top-level object, like the real symbol index does. */
function indexWith(name: string, type: string, model = 'ApplicationSuite', fields: any[] = []) {
  return vi.fn((sql: string) => {
    if (/FROM symbols s\b/.test(sql)) {
      return makeStmt([{
        name, type, model, extends_class: null,
        file_path: `${INDEX_ROOT}\\${model}\\${name}.xml`,
      }]);
    }
    if (/'field'/.test(sql)) return makeStmt(fields);
    return makeStmt();
  });
}

const buildContext = (prepare: any): XppServerContext => ({
  symbolIndex: {
    searchSymbols: vi.fn(() => []),
    getSymbolByName: vi.fn(() => undefined),
    getClassMethods: vi.fn(() => []),
    getTableFields: vi.fn(() => []),
    db: { prepare },
    getReadDb: vi.fn(function (this: any) { return this.db; }),
  } as any,
  parser: {
    parseViewFile: vi.fn(async () => ({ success: false })),
  } as any,
  cache: {
    get: vi.fn(async () => null),
    set: vi.fn(async () => {}),
  } as any,
  workspaceScanner: {} as any,
  hybridSearch: {} as any,
});

describe('get_object_info — symbol-index fallback when the bridge is silent', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('query: resolves from the indexed AxQuery XML', async () => {
    const ctx = buildContext(indexWith('SalesTableListPage', 'query'));
    const result = await getObjectInfoTool(
      req('get_object_info', { objectType: 'query', name: 'SalesTableListPage' }), ctx,
    );
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toMatch(/^# Query/);
    expect(result.content[0].text).toContain('SalesTableListPage');
    expect(result.content[0].text).toContain('SalesTable');
  });

  it('enum: resolves from the indexed AxEnum XML', async () => {
    const ctx = buildContext(indexWith('SalesStatus', 'enum'));
    const result = await getObjectInfoTool(
      req('get_object_info', { objectType: 'enum', name: 'SalesStatus' }), ctx,
    );
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toMatch(/^# Enum/);
    expect(result.content[0].text).toContain('SalesStatus');
    expect(result.content[0].text).toContain('Backorder');
  });

  it('form: resolves from the indexed AxForm XML', async () => {
    const ctx = buildContext(indexWith('SalesTable', 'form'));
    const result = await getObjectInfoTool(
      req('get_object_info', { objectType: 'form', name: 'SalesTable' }), ctx,
    );
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toMatch(/^# Form/);
    expect(result.content[0].text).toContain('SalesTable');
  });

  it('report: resolves from the indexed AxReport XML', async () => {
    const ctx = buildContext(indexWith('SalesInvoiceReport', 'report'));
    const result = await getObjectInfoTool(
      req('get_object_info', { objectType: 'report', name: 'SalesInvoiceReport' }), ctx,
    );
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toMatch(/^# AxReport/);
    expect(result.content[0].text).toContain('SalesInvoiceDS');
  });

  it('data entity: falls back through the view reader (entities are indexed as views)', async () => {
    const ctx = buildContext(
      indexWith('CustCustomerV3Entity', 'view', 'ApplicationSuite', [{ name: 'AccountNum', signature: 'CustTable.AccountNum' }]),
    );
    const result = await dataEntityInfoTool(
      req('get_data_entity_info', { entityName: 'CustCustomerV3Entity' }), ctx,
    );
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('CustCustomerV3Entity');
    expect(result.content[0].text).toContain('AccountNum');
  });

  it('still reports not-found (with a bridge note) when the index is empty', async () => {
    const ctx = buildContext(vi.fn(() => makeStmt()));
    const result = await getObjectInfoTool(
      req('get_object_info', { objectType: 'query', name: 'NoSuchQuery' }), ctx,
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/not found/i);
  });
});
