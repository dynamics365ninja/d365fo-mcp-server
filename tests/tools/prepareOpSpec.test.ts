/**
 * Phase 1.3 — prepare carries the write contract.
 *
 * Deferring the parameter contracts out of the wire schema (#825) traded schema
 * bytes for a DISCOVERY HOP: nearly every write flow then spent a round trip on
 * get_knowledge(kind="op-spec", …), or a failed write that returned the spec in
 * its error message. prepare already knows the objectType and, for a change,
 * the method — so it hands the contract over in the call the agent was making
 * anyway, a few hundred bytes against a whole round trip.
 */

import { describe, it, expect } from 'vitest';
import { renderPrepareOpSpec } from '../../src/tools/opSpecs';

const render = (args: Parameters<typeof renderPrepareOpSpec>[0]) => renderPrepareOpSpec(args).join('\n');

describe('renderPrepareOpSpec — create', () => {
  it('returns the objectType properties contract', () => {
    const out = render({ mode: 'create', objectType: 'table' });
    expect(out).toContain('d365fo_file(action="create", objectType="table")');
    // The actual contract, not just a pointer to it.
    expect(out).toContain('tableGroup');
    expect(out).toContain('fields[{name');
  });

  it('answers for an objectType that takes no extra properties', () => {
    const out = render({ mode: 'create', objectType: 'menu-item-display' });
    expect(out.length).toBeGreaterThan(0);
  });

  it('renders nothing without an objectType rather than guessing', () => {
    expect(renderPrepareOpSpec({ mode: 'create' })).toEqual([]);
  });
});

describe('renderPrepareOpSpec — change', () => {
  it('uses the operation the caller named', () => {
    const out = render({ mode: 'change', operation: 'add-index' });
    expect(out).toContain('operation="add-index"');
    expect(out).toContain('indexFields');
  });

  it('falls back to add-method when a method is targeted', () => {
    const out = render({ mode: 'change', methodName: 'validateWrite' });
    expect(out).toContain('operation="add-method"');
    expect(out).toContain('methodName');
  });

  it('prefers the named operation over the methodName guess', () => {
    const out = render({ mode: 'change', operation: 'replace-code', methodName: 'validateWrite' });
    expect(out).toContain('operation="replace-code"');
    expect(out).toContain('oldCode');
  });

  it('gives the pointer, not a wrong guess, when there is nothing to go on', () => {
    const out = render({ mode: 'change' });
    expect(out).toContain('kind="op-spec"');
    expect(out).not.toContain('operation="add-method"');
  });

  it('ignores an operation that is not a real one and falls back', () => {
    const out = render({ mode: 'change', operation: 'not-an-operation', methodName: 'foo' });
    expect(out).toContain('operation="add-method"');
  });

  it('stays within the size the round-trip trade assumes (~1 kB)', () => {
    // The point is to be cheaper than the round trip it removes, not free.
    for (const args of [
      { mode: 'create' as const, objectType: 'table' },
      { mode: 'change' as const, methodName: 'validateWrite' },
    ]) {
      expect(render(args).length).toBeLessThan(2_000);
    }
  });
});
