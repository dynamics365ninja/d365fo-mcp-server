/**
 * buildAxDataEntityXml (src/tools/dataEntityXml.ts).
 *
 * Regression:
 * eval/corpus/runs/2026-07-07T12__L4-bridge-drops-data-entity-primarytable-fields-on-create__cb1b73d.json
 * — d365fo_file(action="create", objectType="data-entity") unconditionally
 * hard-coded <DataManagementEnabled>Yes</DataManagementEnabled> and
 * <DataManagementStagingTable>${entityName}Staging</DataManagementStagingTable>
 * with no path that ever creates that staging table, so the very next full
 * build failed: "Metadata Error: AxDataEntityView/.../DataManagementStagingTable:
 * Table '<Name>Staging' does not exist." Every data entity this tool ever
 * created was build-broken by default. Fixed by defaulting
 * DataManagementEnabled=No (self-closed, empty DataManagementStagingTable)
 * unless the caller explicitly opts in via properties.dataManagementEnabled.
 */

import { describe, it, expect } from 'vitest';
import { buildAxDataEntityXml } from '../../src/tools/dataEntityXml';

describe('buildAxDataEntityXml — DataManagementEnabled defaulting', () => {
  it('defaults DataManagementEnabled=No with an empty staging table (skeleton branch: no primaryTable/fields)', () => {
    const xml = buildAxDataEntityXml('ConSmallItemEntity');
    expect(xml).toContain('<DataManagementEnabled>No</DataManagementEnabled>');
    expect(xml).toContain('<DataManagementStagingTable />');
    expect(xml).not.toContain('ConSmallItemEntityStaging');
    expect(xml).not.toContain('<DataManagementEnabled>Yes</DataManagementEnabled>');
  });

  it('defaults DataManagementEnabled=No with an empty staging table (full branch: primaryTable + fields given)', () => {
    const xml = buildAxDataEntityXml('ConSmallItemEntity', {
      primaryTable: 'ConSmallItem',
      fields: [{ name: 'ItemId' }, { name: 'Name' }],
    });
    expect(xml).toContain('<DataManagementEnabled>No</DataManagementEnabled>');
    expect(xml).toContain('<DataManagementStagingTable />');
    expect(xml).not.toContain('Staging<');
    // The real fix this case was originally mined for (primaryTable/fields honoured) still works.
    expect(xml).toContain('<DataField>ItemId</DataField>');
    expect(xml).toContain('<Table>ConSmallItem</Table>');
  });

  it('opts IN to data management when properties.dataManagementEnabled=true, defaulting the staging table name', () => {
    const xml = buildAxDataEntityXml('ConSmallItemEntity', {
      primaryTable: 'ConSmallItem',
      fields: [{ name: 'ItemId' }],
      dataManagementEnabled: true,
    });
    expect(xml).toContain('<DataManagementEnabled>Yes</DataManagementEnabled>');
    expect(xml).toContain('<DataManagementStagingTable>ConSmallItemEntityStaging</DataManagementStagingTable>');
  });

  it('opts IN with an explicit staging table name override', () => {
    const xml = buildAxDataEntityXml('ConSmallItemEntity', {
      primaryTable: 'ConSmallItem',
      fields: [{ name: 'ItemId' }],
      dataManagementEnabled: true,
      dataManagementStagingTable: 'ConCustomStagingTable',
    });
    expect(xml).toContain('<DataManagementStagingTable>ConCustomStagingTable</DataManagementStagingTable>');
  });

  it('an unset/false dataManagementEnabled behaves identically to omitting the property', () => {
    const withFalse = buildAxDataEntityXml('X', { dataManagementEnabled: false });
    const withOmitted = buildAxDataEntityXml('X', {});
    expect(withFalse).toBe(withOmitted);
  });
});
