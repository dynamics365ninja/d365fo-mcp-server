/**
 * A failed write must not claim it wrote nothing when it already wrote something.
 *
 * `d365fo_file(action="modify", operation="add-field", fieldName:"Qty",
 * fieldLabel:"Quantity on hand")` with no `fieldType` resolves the raw label
 * text into a real `@LabelFile:Id` FIRST — creating it in the model's
 * `.label.txt` across every language — and only then reaches the contract check
 * that refuses the call. The reply ended "— nothing was written.", which is not
 * true, and `d365fo_file(action="undo")` does not take a label back.
 *
 * The sink is scoped per call (AsyncLocalStorage), the same shape as the
 * bridge-failure sink, so concurrent calls cannot bleed into one another — which
 * these tests check, because a global would pass every other assertion here.
 */

import { describe, it, expect } from 'vitest';
import {
  runWithSideEffectScope,
  recordWriteSideEffect,
  renderSideEffectNote,
  type WriteSideEffect,
} from '../../src/utils/writeSideEffects.js';

describe('committed side effects of a failed write', () => {
  it('collects what was recorded inside the scope', async () => {
    const sink: WriteSideEffect[] = [];
    await runWithSideEffectScope(sink, async () => {
      recordWriteSideEffect('label created', '@ContosoExt:QuantityOnHand');
    });
    expect(sink).toEqual([{ kind: 'label created', detail: '@ContosoExt:QuantityOnHand' }]);
  });

  it('keeps what was recorded before a throw — the failing case is the point', async () => {
    const sink: WriteSideEffect[] = [];
    await expect(runWithSideEffectScope(sink, async () => {
      recordWriteSideEffect('label created', '@ContosoExt:Qty');
      throw new Error('add-field requires fieldType');
    })).rejects.toThrow('fieldType');
    expect(sink).toHaveLength(1);
  });

  it('does not record the same effect twice', async () => {
    const sink: WriteSideEffect[] = [];
    await runWithSideEffectScope(sink, async () => {
      recordWriteSideEffect('label created', '@X:A');
      recordWriteSideEffect('label created', '@X:A');
      recordWriteSideEffect('label created', '@X:B');
    });
    expect(sink.map(e => e.detail)).toEqual(['@X:A', '@X:B']);
  });

  it('does not leak between concurrent calls', async () => {
    const a: WriteSideEffect[] = [];
    const b: WriteSideEffect[] = [];
    await Promise.all([
      runWithSideEffectScope(a, async () => {
        await new Promise(r => setTimeout(r, 5));
        recordWriteSideEffect('label created', '@A:one');
      }),
      runWithSideEffectScope(b, async () => {
        recordWriteSideEffect('label created', '@B:two');
      }),
    ]);
    expect(a.map(e => e.detail)).toEqual(['@A:one']);
    expect(b.map(e => e.detail)).toEqual(['@B:two']);
  });

  it('is a no-op outside a scope, so the CLI and the eval harness are unaffected', () => {
    expect(() => recordWriteSideEffect('label created', '@X:Y')).not.toThrow();
  });

  it('says nothing when nothing was committed', () => {
    expect(renderSideEffectNote([])).toBe('');
  });

  it('names what to reuse on the retry, and does not call it orphaned', () => {
    const note = renderSideEffectNote([{ kind: 'label created', detail: '@ContosoExt:Qty' }]);
    expect(note).toContain('@ContosoExt:Qty');
    expect(note).toMatch(/already written/i);
    // The label is reusable — the retry should pick it up, not work around it.
    expect(note).toMatch(/Re-using these on the retry is correct/);
  });
});
