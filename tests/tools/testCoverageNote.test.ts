/**
 * The post-write coverage note, against a REAL in-memory index.
 *
 * The note names a follow-up call, so the name in it has to resolve. That is not
 * a formatting concern: a CoC wrapper is transparent to a test — you exercise
 * `CustTable`, not `CustTableConExtension_Extension` — and the infix between base
 * and `_Extension` is a per-model convention, so reducing one to the other by
 * string surgery alone produces plausible names that resolve to nothing. The
 * caller then pays a round trip to discover the suggestion was fiction.
 *
 * Hence the rule under test: every candidate is verified against the index, and
 * when none resolves the note is not printed at all. These run the real SQL for
 * the same reason `prepare-realindex.test.ts` does — a mocked DB never executes
 * the lookup that this whole design turns on.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { XppSymbolIndex } from '../../src/metadata/symbolIndex';
import { resolveTestTarget, testCoverageNote } from '../../src/tools/prepare/testFirst';
import type { XppServerContext } from '../../src/types/context';

let index: XppSymbolIndex;
let context: XppServerContext;

const symbol = (over: Record<string, unknown>) => ({
  name: '', type: 'class', filePath: '/x.xml', model: 'ApplicationSuite', ...over,
}) as never;

beforeAll(() => {
  index = new XppSymbolIndex(':memory:', ':memory:');
  index.addSymbol(symbol({ name: 'CustTable', type: 'table' }));
  index.addSymbol(symbol({ name: 'FMVehicleDataContract', type: 'class' }));
  index.addSymbol(symbol({ name: 'ConPriceEngine', type: 'class' }));
  // The object that HAS a test, so the "already covered" branch is reachable.
  index.addSymbol(symbol({ name: 'ConTaxCalculator', type: 'class' }));
  index.addSymbol(symbol({ name: 'ConTaxCalculatorTest', type: 'class' }));
  context = { symbolIndex: index, bridge: undefined } as unknown as XppServerContext;
});

afterAll(() => index.close());

describe('resolveTestTarget', () => {
  it('reduces a dot-notation extension to its base', () => {
    expect(resolveTestTarget(context, 'CustTable.ConExtension', 'table-extension')).toBe('CustTable');
  });

  it('reduces an underscore extension past its model infix', () => {
    // `FMVehicleDataContract` + `Con` + `_Extension`. Stripping only `_Extension`
    // leaves `FMVehicleDataContractCon`, which is not an object.
    expect(resolveTestTarget(context, 'FMVehicleDataContractCon_Extension', 'class-extension'))
      .toBe('FMVehicleDataContract');
  });

  it('passes a plain class through', () => {
    expect(resolveTestTarget(context, 'ConPriceEngine', 'class')).toBe('ConPriceEngine');
  });

  it('is case-insensitive, like the AOT', () => {
    expect(resolveTestTarget(context, 'custtable', 'table')).toBe('CustTable');
  });

  it('answers undefined rather than guessing when nothing resolves', () => {
    expect(resolveTestTarget(context, 'ConThingThatDoesNotExist_Extension', 'class-extension'))
      .toBeUndefined();
  });
});

describe('testCoverageNote', () => {
  it('fires for a CoC method write on an extension, naming the BASE object', () => {
    const note = testCoverageNote(context, {
      objectType: 'table-extension',
      objectName: 'CustTable.ConExtension',
      methodName: 'validateWrite',
      operation: 'add-method',
    });
    expect(note).toContain('prepare(mode="test", objectName="CustTable.validateWrite")');
    expect(note).toContain('Untested');
  });

  it('stays silent when a test class already references the target', () => {
    expect(testCoverageNote(context, {
      objectType: 'class',
      objectName: 'ConTaxCalculator',
      methodName: 'calculateTax',
      operation: 'add-method',
    })).toBeUndefined();
  });

  it('stays silent for a metadata-only write', () => {
    expect(testCoverageNote(context, {
      objectType: 'table-extension',
      objectName: 'CustTable.ConExtension',
      operation: 'add-field',
    })).toBeUndefined();
  });

  it('stays silent when the target cannot be resolved', () => {
    expect(testCoverageNote(context, {
      objectType: 'class-extension',
      objectName: 'ConMysteryCon_Extension',
      operation: 'replace-code',
    })).toBeUndefined();
  });

  it('is one line — it annotates a write report, it does not compete with it', () => {
    const note = testCoverageNote(context, {
      objectType: 'class',
      objectName: 'ConPriceEngine',
      methodName: 'calculateDiscount',
      operation: 'add-method',
    });
    expect(note).toBeDefined();
    expect((note ?? '').trim().split('\n')).toHaveLength(1);
  });
});
