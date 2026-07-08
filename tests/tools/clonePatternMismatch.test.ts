import { describe, it, expect } from 'vitest';
import { cloneFromPatternMismatchWarning, checkTableMappingCoverage } from '../../src/tools/generateSmartForm';

/** Minimal AxForm shell carrying a Design-level <Pattern>. */
function formXmlWithPattern(pattern: string): string {
  return `<?xml version="1.0"?><AxForm><Design><Pattern xmlns="">${pattern}</Pattern></Design></AxForm>`;
}

describe('cloneFromPatternMismatchWarning', () => {
  it('warns when the cloned reference declares a different pattern than requested', () => {
    const warn = cloneFromPatternMismatchWarning(
      'SimpleListDetails',
      formXmlWithPattern('SimpleList'),
      'CustGroup',
    );
    expect(warn).not.toBeNull();
    expect(warn).toContain('PATTERN MISMATCH');
    expect(warn).toContain('SimpleListDetails');
    expect(warn).toContain('SimpleList');
    expect(warn).toContain('CustGroup');
    // Points the caller at a same-pattern reference form to clone instead.
    expect(warn).toMatch(/cloneFrom="\w+"/);
  });

  it('returns null when the cloned pattern matches the requested one', () => {
    expect(
      cloneFromPatternMismatchWarning(
        'SimpleListDetails',
        formXmlWithPattern('SimpleListDetails'),
        'ProjCategory',
      ),
    ).toBeNull();
  });

  it('is case-insensitive on the pattern name', () => {
    expect(
      cloneFromPatternMismatchWarning('simplelist', formXmlWithPattern('SimpleList'), 'CustGroup'),
    ).toBeNull();
  });

  it('returns null when no pattern was requested', () => {
    expect(
      cloneFromPatternMismatchWarning(undefined, formXmlWithPattern('SimpleList'), 'CustGroup'),
    ).toBeNull();
  });

  it('returns null when the cloned XML carries no Design pattern', () => {
    expect(
      cloneFromPatternMismatchWarning('SimpleListDetails', '<AxForm><Design/></AxForm>', 'X'),
    ).toBeNull();
  });
});

// ─── checkTableMappingCoverage ────────────────────────────────────────────────
// Regression coverage for the 2026-07-01 usage-examples eval finding (scenario 2):
// cloneFrom="CustGroup" + tableMapping to a brand-new table not yet in the symbol
// index silently produced a 0-datasource form (getTableFields returned null/empty
// for the unknown target, which used to be treated the same as "skip the check").
describe('checkTableMappingCoverage', () => {
  const CUSTGROUP_FIELDS = ['CustGroup', 'Name', 'PaymTermId', 'ClearingPeriod', 'TaxGroupId'];

  it('flags a target table with zero known fields as unknown (not a silent skip)', () => {
    const result = checkTableMappingCoverage(
      { CustGroup: 'ContosoSalesPostingAuditLog' },
      (table) => (table === 'CustGroup' ? CUSTGROUP_FIELDS : []),
    );
    expect(result.unknownTargets).toEqual(['ContosoSalesPostingAuditLog']);
    expect(result.poorOverlap).toEqual([]);
  });

  it('treats a null field lookup the same as empty (unknown target)', () => {
    const result = checkTableMappingCoverage(
      { CustGroup: 'BrandNewTable' },
      (table) => (table === 'CustGroup' ? CUSTGROUP_FIELDS : null),
    );
    expect(result.unknownTargets).toEqual(['BrandNewTable']);
  });

  it('dedupes repeated unknown targets across multiple mapping pairs', () => {
    const result = checkTableMappingCoverage(
      { TableA: 'SharedUnknown', TableB: 'SharedUnknown' },
      (table) => (table === 'SharedUnknown' ? [] : ['SomeField']),
    );
    expect(result.unknownTargets).toEqual(['SharedUnknown']);
  });

  it('flags poor overlap when both tables are known but barely share fields', () => {
    const result = checkTableMappingCoverage(
      { CustGroup: 'SalesLine' },
      (table) => (table === 'CustGroup' ? CUSTGROUP_FIELDS : ['SalesId', 'ItemId', 'SalesQty', 'LineNum']),
    );
    expect(result.unknownTargets).toEqual([]);
    expect(result.poorOverlap).toHaveLength(1);
    expect(result.poorOverlap[0]).toContain('CustGroup → SalesLine');
  });

  it('passes clean when tables share enough fields', () => {
    const result = checkTableMappingCoverage(
      { CustGroup: 'VendGroup' },
      (table) => (table === 'CustGroup' ? CUSTGROUP_FIELDS : [...CUSTGROUP_FIELDS, 'ExtraVendField']),
    );
    expect(result.unknownTargets).toEqual([]);
    expect(result.poorOverlap).toEqual([]);
  });

  it('skips self-mapped and empty target entries', () => {
    const result = checkTableMappingCoverage(
      { CustGroup: 'CustGroup', VendGroup: '' },
      () => [],
    );
    expect(result.unknownTargets).toEqual([]);
    expect(result.poorOverlap).toEqual([]);
  });

  it('skips the overlap check when the source table itself is unknown/too small', () => {
    const result = checkTableMappingCoverage(
      { UnknownSource: 'ContosoSalesPostingAuditLog' },
      (table) => (table === 'ContosoSalesPostingAuditLog' ? ['SalesId', 'PostingType'] : null),
    );
    expect(result.unknownTargets).toEqual([]);
    expect(result.poorOverlap).toEqual([]);
  });
});
