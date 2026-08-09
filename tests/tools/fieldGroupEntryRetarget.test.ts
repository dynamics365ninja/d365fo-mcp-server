/**
 * The other half of the extension-member rename.
 *
 * `add-field` on an extension renames what it adds — a member added to someone
 * else's table has to carry your prefix — and says so in the response. The
 * `add-field-to-field-group` that follows names the SAME field, and was left
 * exactly as the caller spelled it: applyExtensionMemberPrefix mints names for
 * NEW members and this operation mints none, so it is correctly absent from
 * EXTENSION_MEMBER_NAME_ARG. Nothing then reconciled the two.
 *
 * The bridge validates no DataField, so `<DataField>QualityTier</DataField>`
 * went into a group against a field called `CtsoSK_QualityTier`, came back
 * reported as applied, and pointed at nothing. Sending both operations in ONE
 * call — which every add-field response tells the agent to do — hit it every
 * time; the run this was found in had to repair the XML by hand afterwards.
 *
 * Blind prefixing would be the wrong repair: a group extension may perfectly
 * well carry a BASE-table field, which has no prefix. Only the one-reading case
 * is corrected, which is what these pin.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockReadFile, mockPrefixToken, mockFindBaseObjectXml } = vi.hoisted(() => ({
  mockReadFile: vi.fn(),
  mockPrefixToken: vi.fn(),
  mockFindBaseObjectXml: vi.fn(),
}));

vi.mock('fs/promises', () => ({
  default: { readFile: mockReadFile },
  readFile: mockReadFile,
}));

vi.mock('../../src/utils/modelClassifier', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveRegularObjectPrefixToken: mockPrefixToken,
}));

import { resolveFieldNameForFieldGroup } from '../../src/tools/write/modifyD365File';

const EXT_PATH = 'K:\\Packages\\CtsoFinSK\\CtsoFinSK\\AxTableExtension\\TaxLog.CtsoSKExtension.xml';

/** A table extension declaring exactly these fields. */
const extensionXml = (...fields: string[]) => `<?xml version="1.0" encoding="utf-8"?>
<AxTableExtension xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
  <Name>TaxLog.CtsoSKExtension</Name>
  <FieldGroupExtensions>
    <AxTableFieldGroupExtension>
      <Name>Administration</Name>
      <Fields>
        <AxTableFieldGroupField><DataField>SomethingElse</DataField></AxTableFieldGroupField>
      </Fields>
    </AxTableFieldGroupExtension>
  </FieldGroupExtensions>
  <Fields>
${fields.map(f => `    <AxTableField xmlns="" i:type="AxTableFieldEnum"><Name>${f}</Name></AxTableField>`).join('\n')}
  </Fields>
</AxTableExtension>`;

/** A base table declaring exactly these fields. */
const baseTableXml = (...fields: string[]) => `<?xml version="1.0" encoding="utf-8"?>
<AxTable>
  <Name>TaxLog</Name>
  <Fields>
${fields.map(f => `    <AxTableField i:type="AxTableFieldString"><Name>${f}</Name></AxTableField>`).join('\n')}
  </Fields>
</AxTable>`;

const call = (args: Record<string, any>) =>
  resolveFieldNameForFieldGroup(
    args,
    args.objectType ?? 'table-extension',
    args.operation ?? 'add-field-to-field-group',
    'CtsoFinanceSK',
    EXT_PATH,
    { getReadDb: () => { throw new Error('no index in this test'); } },
  );

describe('add-field-to-field-group points at the field add-field actually created', () => {
  beforeEach(() => {
    mockReadFile.mockReset();
    mockPrefixToken.mockReset();
    mockFindBaseObjectXml.mockReset();
    mockPrefixToken.mockReturnValue('CtsoSK_');
    // No base table readable unless a test says otherwise: findBaseObjectXml
    // goes through the symbol index, which throws in this harness.
    mockReadFile.mockResolvedValue(extensionXml('CtsoSK_QualityTier'));
  });

  it('retargets the bare name at the prefixed field the extension actually has', async () => {
    const args: Record<string, any> = {
      objectName: 'TaxLog.CtsoSKExtension', fieldName: 'QualityTier', fieldGroupName: 'Administration',
    };

    const note = await call(args);

    expect(args.fieldName).toBe('CtsoSK_QualityTier');
    expect(note).toMatch(/CtsoSK_QualityTier/);
  });

  it('leaves a name that already matches a field of the extension alone', async () => {
    const args: Record<string, any> = {
      objectName: 'TaxLog.CtsoSKExtension', fieldName: 'CtsoSK_QualityTier', fieldGroupName: 'Administration',
    };

    expect(await call(args)).toBe('');
    expect(args.fieldName).toBe('CtsoSK_QualityTier');
  });

  // The case blind prefixing would break: a group extension may carry a field
  // the BASE table declares, and that one has no prefix.
  it('leaves a base-table field alone even when a prefixed namesake exists', async () => {
    // Both readings are valid here: the extension has CtsoSK_Voucher AND the
    // base table has Voucher, so "Voucher" in a group entry is not a mistake.
    mockReadFile.mockImplementation(async (p: string) =>
      String(p) === EXT_PATH ? extensionXml('CtsoSK_Voucher') : baseTableXml('Voucher'),
    );
    const indexWithBaseTable = {
      getReadDb: () => ({
        prepare: () => ({ get: () => ({ file_path: 'K:\\base\\TaxLog.xml' }) }),
      }),
    };
    const args: Record<string, any> = {
      objectName: 'TaxLog.CtsoSKExtension', fieldName: 'Voucher', fieldGroupName: 'Administration',
    };

    const note = await resolveFieldNameForFieldGroup(
      args, 'table-extension', 'add-field-to-field-group', 'CtsoFinanceSK', EXT_PATH,
      indexWithBaseTable,
    );

    expect(note).toBe('');
    expect(args.fieldName).toBe('Voucher');
  });

  // Same setup as above minus the base-table namesake: one reading only, so the
  // correction must fire. Without this the test above passes for any reason at
  // all, including the extension file never being read.
  it('does retarget when the base table has no field of that name', async () => {
    mockReadFile.mockImplementation(async (p: string) =>
      String(p) === EXT_PATH ? extensionXml('CtsoSK_Voucher') : baseTableXml('AccountNum'),
    );
    const indexWithBaseTable = {
      getReadDb: () => ({
        prepare: () => ({ get: () => ({ file_path: 'K:\\base\\TaxLog.xml' }) }),
      }),
    };
    const args: Record<string, any> = {
      objectName: 'TaxLog.CtsoSKExtension', fieldName: 'Voucher', fieldGroupName: 'Administration',
    };

    const note = await resolveFieldNameForFieldGroup(
      args, 'table-extension', 'add-field-to-field-group', 'CtsoFinanceSK', EXT_PATH,
      indexWithBaseTable,
    );

    expect(note).toMatch(/CtsoSK_Voucher/);
    expect(args.fieldName).toBe('CtsoSK_Voucher');
  });

  it('says nothing when the prefixed field does not exist either', async () => {
    mockReadFile.mockResolvedValue(extensionXml('CtsoSK_SomethingElse'));
    const args: Record<string, any> = {
      objectName: 'TaxLog.CtsoSKExtension', fieldName: 'QualityTier', fieldGroupName: 'Administration',
    };

    expect(await call(args)).toBe('');
    expect(args.fieldName).toBe('QualityTier');
  });

  it('ignores operations that are not a field-group entry', async () => {
    const args: Record<string, any> = {
      objectName: 'TaxLog.CtsoSKExtension', fieldName: 'QualityTier', operation: 'add-field',
    };

    expect(await call(args)).toBe('');
    expect(args.fieldName).toBe('QualityTier');
  });

  it('ignores a base table, where members carry no prefix', async () => {
    const args: Record<string, any> = {
      objectName: 'TaxLog', fieldName: 'QualityTier', objectType: 'table',
    };

    expect(await call(args)).toBe('');
    expect(args.fieldName).toBe('QualityTier');
  });

  // Advisory: it runs before a write that can succeed without it.
  it('makes no correction when the extension file cannot be read', async () => {
    mockReadFile.mockRejectedValue(new Error('ENOENT'));
    const args: Record<string, any> = {
      objectName: 'TaxLog.CtsoSKExtension', fieldName: 'QualityTier', fieldGroupName: 'Administration',
    };

    expect(await call(args)).toBe('');
    expect(args.fieldName).toBe('QualityTier');
  });

  it('makes no correction when the model has no prefix', async () => {
    mockPrefixToken.mockReturnValue('');
    const args: Record<string, any> = {
      objectName: 'TaxLog.CtsoSKExtension', fieldName: 'QualityTier', fieldGroupName: 'Administration',
    };

    expect(await call(args)).toBe('');
    expect(args.fieldName).toBe('QualityTier');
  });
});
