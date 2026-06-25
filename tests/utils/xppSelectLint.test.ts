import { describe, it, expect } from 'vitest';
import { lintXppSelect } from '../../src/utils/xppSelectLint';

describe('lintXppSelect', () => {
  it('flags a main-table WHERE placed after an exists join', () => {
    const src = `
      BudgetSourceTrackingDetail trackingDetail;
      BudgetSourceTracking       tracking;
      select firstOnly trackingDetail
          exists join tracking
              where tracking.RecId == trackingDetail.BudgetSourceTracking
                 && tracking.BudgetSource == _budgetSourceId
          where trackingDetail.BudgetControlLedgerDimension == ruleDim;
    `;
    const warnings = lintXppSelect(src);
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toMatch(/WHERE clause appears AFTER a join/i);
  });

  it('does NOT flag a correct select: main WHERE before the join', () => {
    const src = `
      select firstOnly trackingDetail
          where trackingDetail.BudgetControlLedgerDimension == ruleDim
          exists join tracking
              where tracking.RecId == trackingDetail.BudgetSourceTracking
                 && tracking.BudgetSource == _budgetSourceId;
    `;
    expect(lintXppSelect(src)).toEqual([]);
  });

  it('does NOT flag multiple joins each with their own WHERE', () => {
    const src = `
      select A
          where A.x == 1
          exists join B where B.y == A.y
          exists join C where C.z == A.z;
    `;
    expect(lintXppSelect(src)).toEqual([]);
  });

  it('ignores non-select source and source without joins', () => {
    expect(lintXppSelect('public void foo() { int x = 1; }')).toEqual([]);
    expect(lintXppSelect('select firstOnly t where t.Field == 1;')).toEqual([]);
    expect(lintXppSelect(undefined)).toEqual([]);
  });

  it('does not trip on the word "where"/"join" inside comments or strings', () => {
    const src = `
      // select t exists join u where a where b -- this is a comment, not code
      str msg = "select x exists join y where p where q";
      select firstOnly t where t.Field == 1 exists join u where u.Id == t.Id;
    `;
    expect(lintXppSelect(src)).toEqual([]);
  });
});
