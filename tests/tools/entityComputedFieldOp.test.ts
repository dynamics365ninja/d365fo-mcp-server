/** modify-field computedFieldMethod end to end on a file: field and method land in one write. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { modifyFieldOp } from '../../src/tools/write/dataEntityOps.js';

const ENTITY = [
  '<?xml version="1.0" encoding="utf-8"?>',
  '<AxDataEntityView xmlns:i="http://www.w3.org/2001/XMLSchema-instance">',
  '\t<Name>ShopExportLineEntity</Name>',
  '\t<SourceCode>',
  '\t\t<Declaration><![CDATA[',
  'public class ShopExportLineEntity extends common',
  '{',
  '}',
  ']]></Declaration>',
  '\t\t<Methods />',
  '\t</SourceCode>',
  '\t<Fields>',
  '\t\t<AxDataEntityViewField xmlns=""',
  '\t\t\ti:type="AxDataEntityViewMappedField">',
  '\t\t\t<Name>ExportedDateTime</Name>',
  '\t\t\t<DataField>CreatedDateTime</DataField>',
  '\t\t\t<DataSource>ShopExportLine</DataSource>',
  '\t\t</AxDataEntityViewField>',
  '\t</Fields>',
  '\t<ViewMetadata>',
  '\t\t<Name>Metadata</Name>',
  '\t\t<DataSources>',
  '\t\t\t<AxQuerySimpleRootDataSource>',
  '\t\t\t\t<Name>ShopExportLine</Name>',
  '\t\t\t\t<Table>ShopExportLineTable</Table>',
  '\t\t\t</AxQuerySimpleRootDataSource>',
  '\t\t</DataSources>',
  '\t</ViewMetadata>',
  '</AxDataEntityView>',
  '',
].join('\r\n');

describe('modifyFieldOp computedFieldMethod', () => {
  let dir: string;
  let file: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'entity-computed-'));
    file = path.join(dir, 'ShopExportLineEntity.xml');
    await fs.writeFile(file, ENTITY);
  });
  afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

  const run = (args: Record<string, unknown>) =>
    modifyFieldOp(undefined, 'ShopExportLineEntity', file, { fieldName: 'ExportedDateTime', ...args });

  it('converts the field and adds a returnField method', async () => {
    const r = await run({ computedFieldMethod: 'exportedDateTimeDefinition' });
    expect(r?.success).toBe(true);
    const xml = await fs.readFile(file, 'utf8');
    expect(xml).toContain('i:type="AxDataEntityViewUnmappedFieldUtcDateTime"');
    expect(xml).toContain('<ComputedFieldMethod>exportedDateTimeDefinition</ComputedFieldMethod>');
    expect(xml).toContain('<ExtendedDataType>CreatedDateTime</ExtendedDataType>');
    expect(xml).not.toContain('<DataField>CreatedDateTime</DataField>');
    expect(xml).toMatch(/<Name>exportedDateTimeDefinition<\/Name>\s*<Source><!\[CDATA\[[\s\S]*SysComputedColumn::returnField\([\s\S]*fieldStr\(ShopExportLineTable, CreatedDateTime\)/);
  });

  it('uses sourceCode when given', async () => {
    const src = '/// <summary>P&amp;L date.</summary>\nprivate static str exportedDateTimeDefinition()\n{\n    return SysComputedColumn::getCurrentUtcDate();\n}';
    const r = await run({ computedFieldMethod: 'exportedDateTimeDefinition', sourceCode: src });
    expect(r?.success).toBe(true);
    expect(await fs.readFile(file, 'utf8')).toContain('getCurrentUtcDate');
  });

  it('refuses a table file and writes nothing', async () => {
    await fs.writeFile(file, '<AxTable><Name>T</Name></AxTable>');
    const r = await run({ computedFieldMethod: 'm' });
    expect(r?.success).toBe(false);
    expect(await fs.readFile(file, 'utf8')).toBe('<AxTable><Name>T</Name></AxTable>');
  });
});
