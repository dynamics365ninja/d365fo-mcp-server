/**
 * Knowledge-base example BP gate (audit 2026-07-20 roadmap, VM-free half of
 * "route knowledge code examples through validate_code").
 *
 * Every code example in KNOWLEDGE_BASE is routed through the same offline
 * best-practice validator the `validate_code(mode="syntax")` tool runs
 * (`runRules`, no VM / no xppbp.exe). Any NEW error-severity violation fails
 * CI, so a future knowledge edit cannot teach BP-breaking X++ (today(),
 * forceLiterals, crossCompany-on-joined-buffer, default-param CoC wrappers,
 * hardcoded infolog strings, unbalanced tts, …).
 *
 * A handful of examples deliberately demonstrate the WRONG pattern next to the
 * right one; those are pinned in ALLOWED so they stay teachable while still
 * being asserted to fire (a stale allow entry fails too).
 *
 * NOTE: this is the offline BP slice only. Proving the surrounding X++ actually
 * *compiles* needs a real build on the VM and stays tracked in eval/ROADMAP.md.
 */

import { describe, it, expect } from 'vitest';
import { KNOWLEDGE_BASE } from '../../src/tools/xppKnowledge';
import { runRules } from '../../src/tools/validateXpp';

type CodeType = 'xpp' | 'xml-table' | 'xml-any';

function codeTypeOf(code: string): CodeType {
  const t = code.trimStart();
  if (!t.startsWith('<')) return 'xpp';
  return /<AxTable\b|<Table\b/.test(t) ? 'xml-table' : 'xml-any';
}

/**
 * Intentional "wrong vs right" demonstrations — `topicId::label::rule`. Each
 * must still fire (guards against a dead allow entry after an example changes).
 */
const ALLOWED = new Set<string>([
  'select-statement::crossCompany — correct vs wrong placement::SEL003',
]);

interface ExampleError {
  key: string;
  topicId: string;
  label: string;
  rule: string;
}

function collectErrors(): { errors: ExampleError[]; exampleCount: number } {
  const errors: ExampleError[] = [];
  let exampleCount = 0;
  for (const topic of KNOWLEDGE_BASE as Array<{ id: string; examples?: { label: string; code: string }[] }>) {
    for (const ex of topic.examples ?? []) {
      exampleCount++;
      const violations = runRules(ex.code, codeTypeOf(ex.code)).filter(v => v.severity === 'error');
      for (const v of violations) {
        errors.push({ key: `${topic.id}::${ex.label}::${v.rule}`, topicId: topic.id, label: ex.label, rule: v.rule });
      }
    }
  }
  return { errors, exampleCount };
}

describe('KNOWLEDGE_BASE code examples — offline BP gate', () => {
  const { errors, exampleCount } = collectErrors();

  it('scans a non-trivial number of examples', () => {
    expect(exampleCount).toBeGreaterThan(50);
  });

  it('no example teaches BP-error X++ (except pinned wrong-vs-right demos)', () => {
    const unexpected = errors.filter(e => !ALLOWED.has(e.key));
    const detail = unexpected.map(e => `  ${e.topicId} :: ${e.label} -> ${e.rule}`).join('\n');
    expect(unexpected.map(e => e.key), `\nunexpected BP errors in knowledge examples:\n${detail}`).toEqual([]);
  });

  it('every pinned wrong-vs-right demo still fires (no dead allow entries)', () => {
    const seen = new Set(errors.map(e => e.key));
    const dead = [...ALLOWED].filter(k => !seen.has(k));
    expect(dead, `\nallow entries that no longer fire (remove them):\n${dead.join('\n')}`).toEqual([]);
  });
});
