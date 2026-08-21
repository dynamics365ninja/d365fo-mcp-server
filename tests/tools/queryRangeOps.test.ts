/**
 * add-query-range / remove-query-range — the ViewMetadata filter ranges of a data entity.
 *
 * There is no bridge op (MetadataWriteService exposes no AddQueryRange on entities),
 * so both are served by direct-XML writers — same pattern as directXmlAddIndex.
 *
 * The shape these tests defend is the one Microsoft ships: <Name>, <Field>, <Value>
 * in that order, inside the <Ranges> the data source OWNS. That last part is the
 * whole difficulty. A query data source nests: <AxQuerySimpleRootDataSource> carries
 * joined <AxQuerySimpleEmbeddedDataSource> children, each with a <Ranges> of its own,
 * and those come FIRST in document order. A first-match `replace('<Ranges />', …)`
 * therefore lands the range on the joined table — valid XML, different query, ✅
 * reported. Likewise an idempotency probe for a bare `<Name>X</Name>` anywhere in the
 * block matches the data source's own name and every mapped field, so the write it
 * guards gets skipped under a ✅. Both are regression-tested below.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { modifyD365FileTool } from '../../src/tools/write/modifyD365File';
import type { XppServerContext } from '../../src/types/context';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';

vi.mock('../../src/bridge/bridgeAdapter', async (orig) => {
  const actual = await orig<typeof import('../../src/bridge/bridgeAdapter')>();
  return { ...actual, bridgeValidateAfterWrite: vi.fn(async () => null) };
});

/**
 * Entity in the shape this server's own dataEntityXml.ts emits — note the root data
 * source's <Fields>, whose <AxQuerySimpleDataSourceField><Name> is the field a range
 * would filter on — plus one joined data source carrying its own <Ranges />.
 */
const ENTITY_XML = `<?xml version="1.0" encoding="utf-8"?>
<AxDataEntityView xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
\t<Name>ConDemoEntity</Name>
\t<Label>@Contoso:Demo</Label>
\t<Fields>
\t\t<AxDataEntityViewField xmlns="" i:type="AxDataEntityViewMappedField">
\t\t\t<Name>IsActive</Name>
\t\t\t<DataField>IsActive</DataField>
\t\t\t<DataSource>ConDemoTable</DataSource>
\t\t</AxDataEntityViewField>
\t</Fields>
\t<Keys />
\t<Mappings />
\t<Ranges />
\t<Relations />
\t<ViewMetadata>
\t\t<Name>Metadata</Name>
\t\t<SourceCode>
\t\t\t<Methods>
\t\t\t\t<Method>
\t\t\t\t\t<Name>classDeclaration</Name>
\t\t\t\t\t<Source><![CDATA[
[Query]
public class Metadata extends QueryRun
{
}
]]></Source>
\t\t\t\t</Method>
\t\t\t</Methods>
\t\t</SourceCode>
\t\t<DataSources>
\t\t\t<AxQuerySimpleRootDataSource>
\t\t\t\t<Name>ConDemoTable</Name>
\t\t\t\t<Table>ConDemoTable</Table>
\t\t\t\t<DataSources>
\t\t\t\t\t<AxQuerySimpleEmbeddedDataSource>
\t\t\t\t\t\t<Name>ConDemoChild</Name>
\t\t\t\t\t\t<Table>ConDemoChild</Table>
\t\t\t\t\t\t<DataSources />
\t\t\t\t\t\t<DerivedDataSources />
\t\t\t\t\t\t<Fields />
\t\t\t\t\t\t<Ranges />
\t\t\t\t\t\t<JoinMode>OuterJoin</JoinMode>
\t\t\t\t\t</AxQuerySimpleEmbeddedDataSource>
\t\t\t\t</DataSources>
\t\t\t\t<DerivedDataSources />
\t\t\t\t<Fields>
\t\t\t\t\t<AxQuerySimpleDataSourceField>
\t\t\t\t\t\t<Name>IsActive</Name>
\t\t\t\t\t\t<Field>IsActive</Field>
\t\t\t\t\t</AxQuerySimpleDataSourceField>
\t\t\t\t</Fields>
\t\t\t\t<Ranges />
\t\t\t\t<GroupBy />
\t\t\t\t<Having />
\t\t\t\t<OrderBy />
\t\t\t</AxQuerySimpleRootDataSource>
\t\t</DataSources>
\t</ViewMetadata>
</AxDataEntityView>`;

/** One range element at the given tab depth. */
const range = (tabs: number, name: string, field: string, value: string): string => {
  const i = '\t'.repeat(tabs);
  return `${i}<AxQuerySimpleDataSourceRange>\n${i}\t<Name>${name}</Name>\n` +
    `${i}\t<Field>${field}</Field>\n${i}\t<Value>${value}</Value>\n` +
    `${i}</AxQuerySimpleDataSourceRange>`;
};

/** Replaces the ROOT data source's `<Ranges />` with a populated collection. */
const withRootRanges = (xml: string, ...entries: string[]): string =>
  xml.replace(
    '\t\t\t\t<Ranges />\n\t\t\t\t<GroupBy />',
    `\t\t\t\t<Ranges>\n${entries.join('\n')}\n\t\t\t\t</Ranges>\n\t\t\t\t<GroupBy />`,
  );

/** Replaces the JOINED data source's `<Ranges />` with a populated collection. */
const withChildRanges = (xml: string, ...entries: string[]): string =>
  xml.replace(
    '\t\t\t\t\t\t<Ranges />',
    `\t\t\t\t\t\t<Ranges>\n${entries.join('\n')}\n\t\t\t\t\t\t</Ranges>`,
  );

const { mockWriteFile, currentXml } = vi.hoisted(() => ({
  mockWriteFile: vi.fn(async () => {}),
  currentXml: { value: '' },
}));

vi.mock('fs/promises', () => ({
  readFile: vi.fn(async (p: string) => {
    if (typeof p === 'string' && p.endsWith('.xml')) return currentXml.value;
    if (typeof p === 'string' && p.endsWith('.rnrproj')) return `<Project><ItemGroup></ItemGroup></Project>`;
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  }),
  writeFile: mockWriteFile,
  mkdir: vi.fn(async () => {}),
  access: vi.fn(async () => {}),
  stat: vi.fn(async () => ({ isFile: () => true, isDirectory: () => false })),
  readdir: vi.fn(async () => []),
  copyFile: vi.fn(async () => {}),
  // Direct-XML writes go through writeFileAtomic: a temp sibling written with
  // writeFile, then renamed over the target.
  rename: vi.fn(async () => {}),
  rm: vi.fn(async () => {}),
}));

vi.mock('../../src/utils/configManager', () => ({
  getConfigManager: vi.fn(() => ({
    ensureLoaded: vi.fn(async () => {}),
    getPackagePath: vi.fn(() => 'K:\\PackagesLocalDirectory'),
    getModelName: vi.fn(() => 'MyModel'),
    getWriteAnchorModel: vi.fn(() => 'MyModel'),
    getToolProjectSwitch: vi.fn(() => null),
    getPackageNameFromWorkspacePath: vi.fn(() => 'MyPackage'),
    getProjectPath: vi.fn(async () => null),
    getSolutionPath: vi.fn(async () => null),
    getDevEnvironmentType: vi.fn(async () => 'traditional'),
    getCustomPackagesPath: vi.fn(async () => null),
    getMicrosoftPackagesPath: vi.fn(async () => null),
  })),
  fallbackPackagePath: vi.fn(() => 'C:\\AosService\\PackagesLocalDirectory'),
  extractModelFromFilePath: vi.fn(() => null),
}));

vi.mock('../../src/utils/packageResolver', () => ({
  PackageResolver: vi.fn().mockImplementation(() => ({
    resolve: vi.fn(async (m: string) => ({ packageName: m, modelName: m, rootPath: 'K:\\PackagesLocalDirectory' })),
    resolveWithPackage: vi.fn((m: string, p: string) => ({ packageName: p, modelName: m, rootPath: 'K:\\PackagesLocalDirectory' })),
  })),
}));

vi.mock('../../src/utils/modelClassifier', () => ({
  registerCustomModel: vi.fn(),
  resolveObjectPrefix: vi.fn(() => ''),
  applyObjectPrefix: vi.fn((name: string) => name),
  getObjectSuffix: vi.fn(() => ''),
  applyObjectSuffix: vi.fn((name: string) => name),
  isCustomModel: vi.fn(() => true),
  isStandardModel: vi.fn(() => false),
}));

const FILE_PATH = 'K:\\PackagesLocalDirectory\\MyPackage\\MyModel\\AxDataEntityView\\ConDemoEntity.xml';

const req = (args: Record<string, unknown>): CallToolRequest => ({
  method: 'tools/call',
  params: {
    name: 'modify_d365fo_file',
    arguments: { objectType: 'data-entity', objectName: 'ConDemoEntity', filePath: FILE_PATH, ...args },
  },
});

const buildContext = (): XppServerContext => {
  const stmt = { all: vi.fn(() => []), get: vi.fn(() => undefined), run: vi.fn() };
  return {
    symbolIndex: {
      searchSymbols: vi.fn(() => []),
      getSymbolByName: vi.fn(() => undefined),
      getCustomModels: vi.fn(() => ['MyModel']),
      db: { prepare: vi.fn(() => stmt) },
      getReadDb: vi.fn(function (this: any) { return this.db; }),
    } as any,
    parser: {} as any,
    cache: { get: vi.fn(async () => null), set: vi.fn(async () => {}), generateSearchKey: vi.fn((q: string) => `k:${q}`) } as any,
    workspaceScanner: {} as any,
    hybridSearch: {} as any,
    bridge: { isReady: true, metadataAvailable: true } as any,
  };
};

/** The entity XML that was written, LF-normalised for matching. */
const captured = (): string | undefined => {
  const call = mockWriteFile.mock.calls.find(
    (c: any[]) => typeof c[1] === 'string' && c[1].includes('<AxDataEntityView'),
  );
  return call ? (call[1] as string).replace(/\r\n/g, '\n') : undefined;
};

/**
 * The <Ranges> collection sitting at a given tab depth — 4 for the root data
 * source, 6 for the joined one.
 *
 * Anchored on indentation rather than on "the first <Ranges> after <Name>X</Name>",
 * because that shortcut walks into the very trap these tests exist for: the joined
 * data source's collection comes first in document order.
 */
const rangesAtDepth = (xml: string, tabs: number): string => {
  const re = new RegExp(`^\\t{${tabs}}<Ranges(?: />|>[\\s\\S]*?^\\t{${tabs}}</Ranges>)`, 'm');
  const hit = re.exec(xml);
  return hit ? hit[0].replace(new RegExp(`^\\t{${tabs}}`, 'gm'), '') : '';
};

/** The root data source's own <Ranges>. */
const rootRanges = (xml: string): string => rangesAtDepth(xml, 4);
/** The joined data source's own <Ranges>. */
const joinedRanges = (xml: string): string => rangesAtDepth(xml, 6);

describe('data-entity query ranges via the modify surface', () => {
  let ctx: XppServerContext;

  beforeEach(() => {
    ctx = buildContext();
    currentXml.value = ENTITY_XML;
    mockWriteFile.mockClear();
  });

  describe('add-query-range', () => {
    it('adds the range in canonical shape to the ROOT data source, not the joined one', async () => {
      const result = await modifyD365FileTool(
        req({ operation: 'add-query-range', dataSourceName: 'ConDemoTable', rangeField: 'IsActive', rangeValue: '1' }),
        ctx,
      );

      expect(result.isError).toBeFalsy();
      const xml = captured();
      expect(xml).toBeTruthy();
      expect(xml).toContain(range(5, 'IsActive', 'IsActive', '1'));
      // The joined data source keeps its own empty collection.
      expect(joinedRanges(xml!)).toBe('<Ranges />');
      expect(rootRanges(xml!)).toContain('<Name>IsActive</Name>');
    });

    it('writes even when the data source <Fields> already names that field', async () => {
      // The idempotency probe used to search the whole data source block for a bare
      // <Name>IsActive</Name>; the mapped field in <Fields> matched it and the write
      // was skipped under a ✅ — on exactly the entity shape this server generates.
      const result = await modifyD365FileTool(
        req({ operation: 'add-query-range', dataSourceName: 'ConDemoTable', rangeField: 'IsActive', rangeValue: '1' }),
        ctx,
      );

      expect(result.content[0].text as string).not.toContain('skipped (idempotent)');
      expect(captured()).toContain('<AxQuerySimpleDataSourceRange>');
    });

    it('writes when the range name equals the data source name', async () => {
      await modifyD365FileTool(
        req({ operation: 'add-query-range', dataSourceName: 'ConDemoTable', rangeField: 'ConDemoTable', rangeValue: '1' }),
        ctx,
      );
      expect(captured()).toContain(range(5, 'ConDemoTable', 'ConDemoTable', '1'));
    });

    it('appends to a populated <Ranges> without disturbing the existing entries', async () => {
      currentXml.value = withRootRanges(ENTITY_XML, range(5, 'RootFlag', 'RootFlag', '1'));

      await modifyD365FileTool(
        req({ operation: 'add-query-range', dataSourceName: 'ConDemoTable', rangeField: 'Status', rangeValue: '2' }),
        ctx,
      );

      const xml = captured();
      expect(xml).toContain(range(5, 'RootFlag', 'RootFlag', '1'));
      expect(xml).toContain(range(5, 'Status', 'Status', '2'));
      expect(joinedRanges(xml!)).toBe('<Ranges />');
    });

    it('leaves a joined data source alone when its <Ranges> is populated', async () => {
      currentXml.value = withChildRanges(ENTITY_XML, range(7, 'ChildFlag', 'ChildFlag', '1'));

      await modifyD365FileTool(
        req({ operation: 'add-query-range', dataSourceName: 'ConDemoTable', rangeField: 'Status', rangeValue: '2' }),
        ctx,
      );

      const xml = captured();
      expect(joinedRanges(xml!)).toContain('<Name>ChildFlag</Name>');
      expect(joinedRanges(xml!)).not.toContain('<Name>Status</Name>');
      expect(rootRanges(xml!)).toContain('<Name>Status</Name>');
    });

    it('targets a joined data source by name, indented to its own depth', async () => {
      await modifyD365FileTool(
        req({ operation: 'add-query-range', dataSourceName: 'ConDemoChild', rangeField: 'IsPrimary', rangeValue: '1' }),
        ctx,
      );

      const xml = captured();
      expect(xml).toContain(range(7, 'IsPrimary', 'IsPrimary', '1'));
      expect(rootRanges(xml!)).toBe('<Ranges />');
    });

    it('honours a rangeName distinct from rangeField', async () => {
      await modifyD365FileTool(
        req({
          operation: 'add-query-range', dataSourceName: 'ConDemoTable',
          rangeName: 'ActiveOnly', rangeField: 'IsActive', rangeValue: '1',
        }),
        ctx,
      );
      expect(captured()).toContain(range(5, 'ActiveOnly', 'IsActive', '1'));
    });

    it('is idempotent when that data source already carries the range', async () => {
      currentXml.value = withRootRanges(ENTITY_XML, range(5, 'IsActive', 'IsActive', '1'));

      const result = await modifyD365FileTool(
        req({ operation: 'add-query-range', dataSourceName: 'ConDemoTable', rangeField: 'IsActive', rangeValue: '1' }),
        ctx,
      );

      expect(result.isError).toBeFalsy();
      expect(result.content[0].text as string).toContain('idempotent');
      expect(captured()).toBeUndefined();
    });

    it('adds the range even when a joined data source already has one by that name', async () => {
      currentXml.value = withChildRanges(ENTITY_XML, range(7, 'IsActive', 'IsActive', '1'));

      await modifyD365FileTool(
        req({ operation: 'add-query-range', dataSourceName: 'ConDemoTable', rangeField: 'IsActive', rangeValue: '1' }),
        ctx,
      );

      expect(rootRanges(captured()!)).toContain('<Name>IsActive</Name>');
    });

    it('rejects a missing rangeValue instead of writing a value-less range', async () => {
      // Not one of the 1192 ranges Microsoft ships omits <Value>, and a range with no
      // value filters nothing — so the omission is named rather than serialised.
      const result = await modifyD365FileTool(
        req({ operation: 'add-query-range', dataSourceName: 'ConDemoTable', rangeField: 'IsActive' }),
        ctx,
      );

      expect(result.isError).toBeTruthy();
      expect(result.content[0].text as string).toContain('rangeValue');
      expect(captured()).toBeUndefined();
    });

    it('escapes XML-special characters in the value', async () => {
      await modifyD365FileTool(
        req({ operation: 'add-query-range', dataSourceName: 'ConDemoTable', rangeField: 'Code', rangeValue: 'A & <B>' }),
        ctx,
      );
      expect(captured()).toContain('<Value>A &amp; &lt;B&gt;</Value>');
    });

    it('keeps the empty-string filter in the form D365FO stores it', async () => {
      await modifyD365FileTool(
        req({ operation: 'add-query-range', dataSourceName: 'ConDemoTable', rangeField: 'Code', rangeValue: '""' }),
        ctx,
      );
      expect(captured()).toContain('<Value>""</Value>');
    });

    it('names the data sources it can see when the target is not one of them', async () => {
      const result = await modifyD365FileTool(
        req({ operation: 'add-query-range', dataSourceName: 'NoSuchTable', rangeField: 'IsActive', rangeValue: '1' }),
        ctx,
      );

      expect(result.isError).toBeTruthy();
      const text = result.content[0].text as string;
      expect(text).toContain('ConDemoTable');
      expect(text).toContain('ConDemoChild');
      expect(captured()).toBeUndefined();
    });

    it('refuses to guess when two data sources share the name', async () => {
      currentXml.value = ENTITY_XML.replace('<Name>ConDemoChild</Name>', '<Name>ConDemoTable</Name>');

      const result = await modifyD365FileTool(
        req({ operation: 'add-query-range', dataSourceName: 'ConDemoTable', rangeField: 'IsActive', rangeValue: '1' }),
        ctx,
      );

      expect(result.isError).toBeTruthy();
      expect(result.content[0].text as string).toMatch(/more than one data source/);
      expect(captured()).toBeUndefined();
    });

    it('refuses a file that is not an AxDataEntityView', async () => {
      currentXml.value = '<?xml version="1.0" encoding="utf-8"?>\n<AxTable xmlns:i="x">\n\t<Name>ConDemoTable</Name>\n</AxTable>';

      const result = await modifyD365FileTool(
        req({ operation: 'add-query-range', dataSourceName: 'ConDemoTable', rangeField: 'IsActive', rangeValue: '1' }),
        ctx,
      );

      expect(result.isError).toBeTruthy();
      expect(result.content[0].text as string).toContain('not an AxDataEntityView');
      expect(captured()).toBeUndefined();
    });

    it('rejects a name that is not an AOT identifier', async () => {
      const result = await modifyD365FileTool(
        req({
          operation: 'add-query-range', dataSourceName: 'ConDemoTable',
          rangeField: 'Is</Name><Injected>', rangeValue: '1',
        }),
        ctx,
      );

      expect(result.isError).toBeTruthy();
      expect(result.content[0].text as string).toContain('not a valid AOT name');
      expect(captured()).toBeUndefined();
    });

    it('writes CRLF with no trailing newline, as D365FO serialises', async () => {
      await modifyD365FileTool(
        req({ operation: 'add-query-range', dataSourceName: 'ConDemoTable', rangeField: 'IsActive', rangeValue: '1' }),
        ctx,
      );
      const raw = mockWriteFile.mock.calls.find(
        (c: any[]) => typeof c[1] === 'string' && c[1].includes('<AxDataEntityView'),
      )![1] as unknown as string;
      expect(raw).toContain('\r\n');
      expect(raw.endsWith('\n')).toBe(false);
    });
  });

  describe('remove-query-range', () => {
    it('removes the range and collapses the collection when it was the last one', async () => {
      currentXml.value = withRootRanges(ENTITY_XML, range(5, 'IsActive', 'IsActive', '1'));

      const result = await modifyD365FileTool(
        req({ operation: 'remove-query-range', dataSourceName: 'ConDemoTable', rangeName: 'IsActive' }),
        ctx,
      );

      expect(result.isError).toBeFalsy();
      const xml = captured();
      expect(xml).not.toContain('<AxQuerySimpleDataSourceRange>');
      expect(rootRanges(xml!)).toBe('<Ranges />');
    });

    it('keeps the siblings when one of several ranges goes', async () => {
      currentXml.value = withRootRanges(
        ENTITY_XML,
        range(5, 'RootFlag', 'RootFlag', '1'),
        range(5, 'Status', 'Status', '2'),
      );

      await modifyD365FileTool(
        req({ operation: 'remove-query-range', dataSourceName: 'ConDemoTable', rangeName: 'RootFlag' }),
        ctx,
      );

      const xml = captured();
      expect(xml).not.toContain('<Name>RootFlag</Name>');
      expect(xml).toContain(range(5, 'Status', 'Status', '2'));
    });

    it('never removes a same-named range from a joined data source', async () => {
      // The removal regex used to run over the whole root block, so a range the root
      // did not have was deleted off the joined data source under a ✅.
      currentXml.value = withChildRanges(ENTITY_XML, range(7, 'Status', 'Status', '1'));

      const result = await modifyD365FileTool(
        req({ operation: 'remove-query-range', dataSourceName: 'ConDemoTable', rangeName: 'Status' }),
        ctx,
      );

      expect(result.isError).toBeFalsy();
      expect(result.content[0].text as string).toContain('nothing to remove');
      expect(captured()).toBeUndefined();
    });

    it('removes from the joined data source when that is the one named', async () => {
      currentXml.value = withChildRanges(ENTITY_XML, range(7, 'Status', 'Status', '1'));

      await modifyD365FileTool(
        req({ operation: 'remove-query-range', dataSourceName: 'ConDemoChild', rangeName: 'Status' }),
        ctx,
      );

      const xml = captured();
      expect(xml).not.toContain('<Name>Status</Name>');
      expect(joinedRanges(xml!)).toBe('<Ranges />');
    });

    it('finds the range when <Name> is not the first child', async () => {
      const outOfOrder =
        '\t\t\t\t\t<AxQuerySimpleDataSourceRange>\n\t\t\t\t\t\t<Field>IsActive</Field>\n' +
        '\t\t\t\t\t\t<Name>IsActive</Name>\n\t\t\t\t\t\t<Value>1</Value>\n' +
        '\t\t\t\t\t</AxQuerySimpleDataSourceRange>';
      currentXml.value = withRootRanges(ENTITY_XML, outOfOrder);

      await modifyD365FileTool(
        req({ operation: 'remove-query-range', dataSourceName: 'ConDemoTable', rangeName: 'IsActive' }),
        ctx,
      );

      expect(captured()).not.toContain('<AxQuerySimpleDataSourceRange>');
    });

    it('is idempotent when the range is not there', async () => {
      const result = await modifyD365FileTool(
        req({ operation: 'remove-query-range', dataSourceName: 'ConDemoTable', rangeName: 'IsActive' }),
        ctx,
      );

      expect(result.isError).toBeFalsy();
      expect(result.content[0].text as string).toContain('nothing to remove');
      expect(captured()).toBeUndefined();
    });

    it('reports an unknown data source rather than reporting nothing to remove', async () => {
      const result = await modifyD365FileTool(
        req({ operation: 'remove-query-range', dataSourceName: 'NoSuchTable', rangeName: 'IsActive' }),
        ctx,
      );

      expect(result.isError).toBeTruthy();
      expect(result.content[0].text as string).toContain('not found in ViewMetadata');
      expect(captured()).toBeUndefined();
    });
  });

  it('never steers the agent into create overwrite=true', async () => {
    const result = await modifyD365FileTool(
      req({ operation: 'add-query-range', dataSourceName: 'ConDemoTable', rangeField: 'IsActive', rangeValue: '1' }),
      ctx,
    );
    expect(result.content[0].text as string).not.toMatch(/overwrite=true/);
  });
});
