/**
 * The proactive half of the DataGroup guard.
 *
 * A container carrying <DataGroup> is filled by the compiler from that table
 * field group, so a field added to the group is already on the form. The
 * add-control guard says the same, but only once a form extension exists and a
 * control is being added to it — a create that then has to be undone.
 *
 * Said at add-field-to-field-group time it costs one indexed lookup. These pin
 * both that it fires and that it stays quiet on every ambiguous case.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockReadFile } = vi.hoisted(() => ({ mockReadFile: vi.fn() }));

vi.mock('fs/promises', () => ({
  default: { readFile: mockReadFile },
  readFile: mockReadFile,
}));

import {
  describeFieldGroupRendering,
  describeUnrenderedFieldGroup,
} from '../../src/tools/write/modifyD365File';

const FORM_PATH = 'K:\\Packages\\AslFinanceCore\\AslFinanceCore\\AxForm\\TaxLog.xml';

/** SimpleList shape: Grid > Group[DataGroup=Modified], plus one unbound group. */
const FORM_XML = `<?xml version="1.0" encoding="utf-8"?>
<AxForm xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
  <Name>TaxLog</Name>
  <Design>
    <Controls>
      <AxFormControl xmlns="" i:type="AxFormGridControl">
        <Name>Grid</Name>
        <Type>Grid</Type>
        <Controls>
          <AxFormControl xmlns="" i:type="AxFormGroupControl">
            <Name>Modified</Name>
            <Type>Group</Type>
            <Controls />
            <DataGroup>Modified</DataGroup>
            <DataSource>TaxLog</DataSource>
          </AxFormControl>
          <AxFormControl xmlns="" i:type="AxFormGroupControl">
            <Name>Freeform</Name>
            <Type>Group</Type>
            <Controls />
          </AxFormControl>
        </Controls>
        <DataSource>TaxLog</DataSource>
      </AxFormControl>
    </Controls>
  </Design>
</AxForm>`;

/**
 * Fake read DB serving the two queries the probe makes: the form_datasources
 * lookup by table, and findBaseObjectXml's file_path lookup by name.
 */
const indexWith = (rows: Array<{ form_name: string; datasource_name: string }>) => ({
  getReadDb: () => ({
    prepare: (sql: string) => ({
      all: () => (/form_datasources/.test(sql) ? rows : []),
      get: () => (/FROM symbols/.test(sql) ? { file_path: FORM_PATH } : undefined),
    }),
  }),
});

const ON_TAX_LOG = [{ form_name: 'TaxLog', datasource_name: 'TaxLog' }];

describe('add-field-to-field-group names the form the group already renders on', () => {
  beforeEach(() => {
    mockReadFile.mockReset();
    mockReadFile.mockResolvedValue(FORM_XML);
  });

  it('names the form, the control and the control the compiler will generate', async () => {
    const note = await describeFieldGroupRendering(
      'TaxLog', 'Modified', 'AslFinSK_QualityTier', indexWith(ON_TAX_LOG),
    );

    expect(note).toContain('TaxLog');
    expect(note).toContain('Modified');
    expect(note).toContain('Modified_AslFinSK_QualityTier');
    expect(note).toContain('already on the form');
    // The whole point: do not build the thing that then has to be undone.
    expect(note).toMatch(/form extension/i);
  });

  it('says nothing for a field group no control renders', async () => {
    expect(await describeFieldGroupRendering(
      'TaxLog', 'Identification', 'AslFinSK_QualityTier', indexWith(ON_TAX_LOG),
    )).toBe('');
  });

  it('says nothing when no form uses the table', async () => {
    expect(await describeFieldGroupRendering(
      'TaxLog', 'Modified', 'AslFinSK_QualityTier', indexWith([]),
    )).toBe('');
  });

  it('ignores a container bound to a different datasource', async () => {
    // Same group name on another table's datasource renders another table's
    // fields — claiming it would send the agent after the wrong form.
    const note = await describeFieldGroupRendering(
      'TaxLog', 'Modified', 'AslFinSK_QualityTier',
      indexWith([{ form_name: 'TaxLog', datasource_name: 'SomeOtherTable' }]),
    );
    expect(note).toBe('');
  });

  it('says nothing when the form XML cannot be read', async () => {
    mockReadFile.mockRejectedValue(new Error('ENOENT'));
    expect(await describeFieldGroupRendering(
      'TaxLog', 'Modified', 'AslFinSK_QualityTier', indexWith(ON_TAX_LOG),
    )).toBe('');
  });

  it('survives an index that cannot answer at all', async () => {
    const broken = { getReadDb: () => { throw new Error('no index'); } };
    expect(await describeFieldGroupRendering('TaxLog', 'Modified', 'F', broken)).toBe('');
    expect(await describeFieldGroupRendering('TaxLog', 'Modified', 'F', undefined)).toBe('');
  });
});

/**
 * The other half. A field group no container renders generates no controls, so a
 * field parked in a new group on a table extension is on no form — and the agent
 * that does not know it builds the form extension, hits the add-control guard and
 * undoes the lot (run 81803f01, ~24 AIU).
 */
describe('a field group nothing renders names the groups that are rendered', () => {
  beforeEach(() => {
    mockReadFile.mockReset();
    mockReadFile.mockResolvedValue(FORM_XML);
  });

  it('says the group reaches no form, and names the one that does', async () => {
    const note = await describeUnrenderedFieldGroup('TaxLog', 'QualityAssessment', indexWith(ON_TAX_LOG));

    expect(note).toContain('QualityAssessment');
    expect(note).toMatch(/no form/i);
    expect(note).toContain('`Modified`');
    expect(note).toContain('TaxLog');
    // The cheap path, named as such.
    expect(note).toMatch(/extendBaseFieldGroup=true/);
  });

  it('stays quiet when the group IS rendered — that is the other note\'s sentence', async () => {
    expect(await describeUnrenderedFieldGroup('TaxLog', 'Modified', indexWith(ON_TAX_LOG))).toBe('');
    // Case-insensitively, as the form XML spells it however it likes.
    expect(await describeUnrenderedFieldGroup('TaxLog', 'modified', indexWith(ON_TAX_LOG))).toBe('');
  });

  it('says nothing when no form uses the table, or none carries a DataGroup', async () => {
    expect(await describeUnrenderedFieldGroup('TaxLog', 'QualityAssessment', indexWith([]))).toBe('');

    mockReadFile.mockResolvedValue('<AxForm><Name>TaxLog</Name><Design><Controls /></Design></AxForm>');
    expect(await describeUnrenderedFieldGroup('TaxLog', 'QualityAssessment', indexWith(ON_TAX_LOG))).toBe('');
  });

  it('ignores a container bound to a different datasource', async () => {
    const note = await describeUnrenderedFieldGroup(
      'TaxLog', 'QualityAssessment',
      indexWith([{ form_name: 'TaxLog', datasource_name: 'SomeOtherTable' }]),
    );
    expect(note).toBe('');
  });

  it('survives an unreadable form and an index that cannot answer', async () => {
    mockReadFile.mockRejectedValue(new Error('ENOENT'));
    expect(await describeUnrenderedFieldGroup('TaxLog', 'QualityAssessment', indexWith(ON_TAX_LOG))).toBe('');

    const broken = { getReadDb: () => { throw new Error('no index'); } };
    expect(await describeUnrenderedFieldGroup('TaxLog', 'QualityAssessment', broken)).toBe('');
    expect(await describeUnrenderedFieldGroup('TaxLog', 'QualityAssessment', undefined)).toBe('');
  });
});
