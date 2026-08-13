/**
 * An extension reindexed from its AOT file must land in extension_metadata, the
 * way the full build writes it.
 *
 * Only the full pipeline used to write that table, so a field added to a table
 * extension — or a method added to a CoC class — was invisible to every reader
 * keyed on base_object_name until the next rebuild. resolve_references reports
 * such an identifier as an ERROR, and under GROUNDING_ENFORCE that error refuses
 * the write carrying it.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { XppSymbolIndex } from '../../src/metadata/symbolIndex';
import { indexOneFile } from '../../src/tools/sdlc/updateSymbolIndex';
import { resolveXppReferences, type ResolverDeps } from '../../src/tools/write/resolveReferences';

const MODEL = 'ContosoExt';
const BASE_TABLE = 'ContosoOrderLog';

const TABLE_EXTENSION_XML = `<?xml version="1.0" encoding="utf-8"?>
<AxTableExtension xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
	<Name>${BASE_TABLE}.ContosoExtension</Name>
	<Fields>
		<AxTableField i:type="AxTableFieldEnum">
			<Name>Contoso_QualityTier</Name>
			<EnumType>Contoso_QualityTier</EnumType>
		</AxTableField>
	</Fields>
</AxTableExtension>`;

const COC_CLASS_XML = `<?xml version="1.0" encoding="utf-8"?>
<AxClass xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
	<Name>${BASE_TABLE}Contoso_Extension</Name>
	<SourceCode>
		<Declaration><![CDATA[
[ExtensionOf(tableStr(${BASE_TABLE}))]
final class ${BASE_TABLE}Contoso_Extension
{
}
]]></Declaration>
		<Methods>
			<Method>
				<Name>validateWrite</Name>
				<Source><![CDATA[
    public boolean validateWrite()
    {
        return next validateWrite();
    }
]]></Source>
			</Method>
			<Method>
				<Name>contosoTierRank</Name>
				<Source><![CDATA[
    public int contosoTierRank()
    {
        return 0;
    }
]]></Source>
			</Method>
		</Methods>
	</SourceCode>
</AxClass>`;

/** A wrapper reading the field the extension adds. */
const USES_FIELD = `[ExtensionOf(tableStr(${BASE_TABLE}))]
final class ${BASE_TABLE}Contoso_Extension
{
    public boolean validateWrite()
    {
        ${BASE_TABLE} rec;
        boolean ret = next validateWrite();

        if (rec.Contoso_QualityTier)
        {
            ret = false;
        }

        return ret;
    }
}`;

/** The same, calling the method the CoC class adds. */
const USES_METHOD = USES_FIELD.replace('rec.Contoso_QualityTier', 'rec.contosoTierRank()');

let tmpDir: string;
let tableExtensionFile: string;
let cocClassFile: string;
let index: XppSymbolIndex;
let deps: ResolverDeps;

const write = async (aotFolder: string, fileName: string, xml: string): Promise<string> => {
  const dir = path.join(tmpDir, MODEL, aotFolder);
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, fileName);
  await fs.writeFile(file, xml, 'utf-8');
  return file;
};

const reindex = (file: string) => indexOneFile(file, { symbolIndex: index } as any);

const errorsFor = (code: string, kind: string) =>
  resolveXppReferences(code, deps).violations.filter(v => v.kind === kind);

const metadataRows = (extensionType: string) =>
  index.getReadDb().prepare(
    `SELECT extension_name, base_object_name, added_fields, added_methods, coc_methods
     FROM extension_metadata WHERE extension_type = ?`,
  ).all(extensionType) as Array<Record<string, string | null>>;

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xpp-ext-meta-'));
  tableExtensionFile = await write('AxTableExtension', `${BASE_TABLE}.ContosoExtension.xml`, TABLE_EXTENSION_XML);
  cocClassFile = await write('AxClass', `${BASE_TABLE}Contoso_Extension.xml`, COC_CLASS_XML);

  index = new XppSymbolIndex(':memory:', ':memory:');
  // The base table, as a full build of the shared model left it.
  index.addSymbol({ name: BASE_TABLE, type: 'table', filePath: 'K:\\base\\ContosoOrderLog.xml', model: 'ContosoBase' });
  index.addSymbol({
    name: 'Voucher', type: 'field', parentName: BASE_TABLE,
    filePath: 'K:\\base\\ContosoOrderLog.xml', model: 'ContosoBase',
  });

  deps = {
    db: index.getReadDb(),
    getLabelById: () => [],
    getLabelFileIds: () => [],
  };
});

afterAll(async () => {
  index.close();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('a table extension reindexed from its file', () => {
  it('starts out unable to resolve the field — the state this fixes', () => {
    expect(errorsFor(USES_FIELD, 'unknown-field')).toHaveLength(1);
  });

  it('resolves the field once the file has been reindexed', async () => {
    const result = await reindex(tableExtensionFile);
    expect(result.isError).toBe(false);
    expect(errorsFor(USES_FIELD, 'unknown-field')).toHaveLength(0);
  });

  it('writes one row carrying the base object and the added field', () => {
    const rows = metadataRows('table-extension');
    expect(rows).toHaveLength(1);
    expect(rows[0].extension_name).toBe(`${BASE_TABLE}.ContosoExtension`);
    expect(rows[0].base_object_name).toBe(BASE_TABLE);
    expect(JSON.parse(rows[0].added_fields as string)).toEqual(['Contoso_QualityTier']);
  });

  it('replaces that row rather than appending on every reindex', async () => {
    await reindex(tableExtensionFile);
    await reindex(tableExtensionFile);
    expect(metadataRows('table-extension')).toHaveLength(1);
  });

  it('records the base object on the symbol row too, as the full build does', () => {
    const row = index.getReadDb().prepare(
      `SELECT parent_name, extends_class FROM symbols WHERE type = 'table-extension' AND name = ?`,
    ).get(`${BASE_TABLE}.ContosoExtension`) as { parent_name: string; extends_class: string } | undefined;
    expect(row?.parent_name).toBe(BASE_TABLE);
    expect(row?.extends_class).toBe(BASE_TABLE);
  });
});

describe('a CoC class reindexed from its file', () => {
  it('starts out unable to resolve the method it adds', () => {
    expect(errorsFor(USES_METHOD, 'unknown-method')).toHaveLength(1);
  });

  it('resolves it once the class has been reindexed', async () => {
    const result = await reindex(cocClassFile);
    expect(result.isError).toBe(false);
    expect(errorsFor(USES_METHOD, 'unknown-method')).toHaveLength(0);
  });

  it('reads the base object off [ExtensionOf], and tells a wrapper from an addition', () => {
    const rows = metadataRows('class-extension');
    expect(rows).toHaveLength(1);
    expect(rows[0].base_object_name).toBe(BASE_TABLE);
    expect(JSON.parse(rows[0].added_methods as string)).toEqual(['validateWrite', 'contosoTierRank']);
    // Only the one that calls next is a wrapper.
    expect(JSON.parse(rows[0].coc_methods as string)).toEqual(['validateWrite']);
  });

  it('leaves a plain class out of extension_metadata', async () => {
    const plain = await write('AxClass', 'ContosoPlainHelper.xml', COC_CLASS_XML
      .replace(`${BASE_TABLE}Contoso_Extension`, 'ContosoPlainHelper')
      .replace(`[ExtensionOf(tableStr(${BASE_TABLE}))]\n`, ''));
    await reindex(plain);
    expect(metadataRows('class-extension')).toHaveLength(1);
  });
});

describe('an extension whose file is gone', () => {
  it('takes its extension_metadata row with it', async () => {
    await fs.rm(tableExtensionFile);
    const result = await reindex(tableExtensionFile);

    expect(result.isError).toBe(false);
    expect(result.text).toContain('extension record(s)');
    expect(metadataRows('table-extension')).toHaveLength(0);
    expect(errorsFor(USES_FIELD, 'unknown-field')).toHaveLength(1);
  });
});
