/**
 * The test-first offer fires on behaviour and stays silent on structure.
 *
 * Both halves are load-bearing and they fail in opposite directions.
 *
 * Silent when it should speak: the TDD loop was used ZERO times in 1,603 measured
 * MCP calls while `prepare(mode="change")` ran 54 and the most-asked knowledge
 * question was the table `validateWrite` contract — i.e. people were doing
 * exactly the work the loop exists for and never found it. That is the bug this
 * offer fixes, so a validateWrite change MUST carry it.
 *
 * Speaks when it should be silent: an offer on every call is banner blindness,
 * and on a metadata change it is worse than noise — it recommends the wrong
 * oracle. Adding a field, a control or an enum value is structure, and structure
 * is proven by a golden diff, not by a SysTest. `add-field` on a testable object
 * is the precise case that must NOT fire, because the object type alone looks
 * like a match.
 */

import { describe, expect, it } from 'vitest';
import { renderTestFirst, testFirstOffer } from '../../src/tools/prepare/testFirst';

describe('testFirstOffer — fires on behaviour', () => {
  it('fires for a validateWrite CoC on a table extension', () => {
    const offer = testFirstOffer({
      objectType: 'table-extension',
      methodName: 'validateWrite',
      goal: 'reject a downgrade of the service tier',
      operation: 'add-method',
    });
    expect(offer).toBeDefined();
    expect(offer?.focusMethod).toBe('validateWrite');
  });

  it('fires for replace-code on a class extension', () => {
    expect(testFirstOffer({
      objectType: 'class-extension',
      goal: 'wrap the price calculation',
      operation: 'replace-code',
    })).toBeDefined();
  });

  it('fires on a rule-shaped goal even without a named method', () => {
    expect(testFirstOffer({
      objectType: 'class',
      goal: 'the total must not exceed the credit limit',
    })).toBeDefined();
  });

  it('fires for a table method written through add-table-method', () => {
    expect(testFirstOffer({
      objectType: 'table',
      methodName: 'initValue',
      operation: 'add-table-method',
    })).toBeDefined();
  });
});

describe('testFirstOffer — silent on structure', () => {
  it('does NOT fire for add-field on a table extension', () => {
    // The object type is testable and the goal mentions a field; only the
    // OPERATION says this is metadata. That is the whole discrimination.
    expect(testFirstOffer({
      objectType: 'table-extension',
      goal: 'add a ServiceTier field to CustTable',
      operation: 'add-field',
    })).toBeUndefined();
  });

  it('does NOT fire for add-field + add-field-to-field-group, the most common write', () => {
    expect(testFirstOffer({
      objectType: 'table-extension',
      goal: 'add two fields and show them on the Overview group',
      operation: 'add-field,add-field-to-field-group',
    })).toBeUndefined();
  });

  it('does NOT fire for add-control on a form extension', () => {
    expect(testFirstOffer({
      objectType: 'form-extension',
      goal: 'add the new field to the details tab',
      operation: 'add-control',
    })).toBeUndefined();
  });

  it('does NOT fire for an enum value change', () => {
    expect(testFirstOffer({
      objectType: 'enum',
      goal: 'add a Platinum tier',
      operation: 'add-enum-value',
    })).toBeUndefined();
  });

  it('does NOT fire for an object family a SysTest cannot reach', () => {
    expect(testFirstOffer({ objectType: 'menu-item-display', goal: 'point it at the new form' }))
      .toBeUndefined();
    expect(testFirstOffer({ objectType: 'security-privilege', goal: 'grant maintain on the table' }))
      .toBeUndefined();
  });

  it('does NOT fire on a structural goal with no operation and no method', () => {
    expect(testFirstOffer({ objectType: 'table', goal: 'add an index on NoteId' })).toBeUndefined();
  });

  it('does not fire without a resolved object type', () => {
    expect(testFirstOffer({ methodName: 'validateWrite', goal: 'reject bad rows' })).toBeUndefined();
  });
});

describe('renderTestFirst', () => {
  const offer = { reason: 'it is a rule', focusMethod: 'validateWrite' };

  it('renders nothing when there is no offer', () => {
    expect(renderTestFirst(undefined, 'CustTable', [])).toEqual([]);
  });

  it('names the exact call, with the dotted target', () => {
    const text = renderTestFirst(offer, 'CustTable', []).join('\n');
    expect(text).toContain('prepare(mode="test", objectName="CustTable.validateWrite")');
  });

  it('points at the EXISTING test rather than a second test class', () => {
    const text = renderTestFirst(offer, 'CustTable', ['CustTableTest']).join('\n');
    expect(text).toContain('CustTableTest');
    expect(text).toContain('rather than a');
    // The red-first scaffold pitch belongs only to the no-test-yet branch.
    expect(text).not.toContain('red-first scaffold');
  });

  it('stays short — it must never be why the write contract is cut', () => {
    const text = renderTestFirst(offer, 'CustTable', []).join('\n');
    expect(text.length).toBeLessThan(400);
  });
});
