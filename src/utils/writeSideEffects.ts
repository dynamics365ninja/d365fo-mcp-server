/**
 * Side effects a tool call already committed before it failed.
 *
 * A write tool is not atomic. `d365fo_file(action="modify", operation="add-field",
 * fieldName:"Qty", fieldLabel:"Quantity on hand")` with no `fieldType` resolves
 * the raw label text into a real `@LabelFile:Id` FIRST — creating it in the
 * model's `.label.txt` across every language, and possibly registering the label
 * file in the `.rnrproj` — and only then reaches the add-field contract check
 * that refuses the call. The reply said:
 *
 *     ❌ add-field … requires fieldType (the EDT) … — nothing was written.
 *
 * which is not true, and `d365fo_file(action="undo")` does not take the label
 * back. A caller told nothing was written has no reason to look.
 *
 * Same shape as the bridge-failure sink next door (src/bridge/bridgeFailure.ts):
 * an AsyncLocalStorage scope entered once per tool call, so recording is safe
 * under concurrent calls and a no-op outside a server (CLI, eval harness, tests).
 * `toolHandler` reads it and appends to the response when — and only when — the
 * call came back as an error.
 */

import { AsyncLocalStorage } from 'async_hooks';

export interface WriteSideEffect {
  /** What was committed, in the caller's terms: `label`, `file`, `project entry`. */
  kind: string;
  /** The thing itself — a label reference, a path. Must be enough to act on. */
  detail: string;
}

const sideEffectScope = new AsyncLocalStorage<WriteSideEffect[]>();

/**
 * Run `fn` with a collector attached. The sink is passed in rather than returned
 * so effects recorded before a throw are still visible to the caller — the
 * failing case is exactly the one this exists for.
 */
export function runWithSideEffectScope<T>(sink: WriteSideEffect[], fn: () => Promise<T>): Promise<T> {
  return sideEffectScope.run(sink, fn);
}

/** Record something this call has already committed to disk. */
export function recordWriteSideEffect(kind: string, detail: string): void {
  const store = sideEffectScope.getStore();
  if (!store) return;
  if (store.some(e => e.kind === kind && e.detail === detail)) return;
  store.push({ kind, detail });
}

/**
 * The line appended to a FAILED response, or '' when nothing was committed.
 *
 * Deliberately not appended to a successful one: there the effect is part of the
 * result and the tool already reports it in its own words.
 */
export function renderSideEffectNote(effects: WriteSideEffect[]): string {
  if (effects.length === 0) return '';
  const lines = effects.map(e => `>    • ${e.kind}: ${e.detail}`);
  return (
    '> ⚠️ This call FAILED, but it had already written the following before it did — ' +
    'so "nothing was written" above is about the operation, not about everything this ' +
    'call touched. Re-using these on the retry is correct; they are not orphaned by it.\n' +
    lines.join('\n')
  );
}
