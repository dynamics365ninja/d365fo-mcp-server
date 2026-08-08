/**
 * KNOWLEDGE_BASE structural integrity gate.
 *
 * Companion to apiSymbols.test.ts (which gates the *content* — do the named
 * AOT types exist) and exampleValidation.test.ts (do the examples pass
 * validate_code). This file gates the *shape* of an entry.
 *
 * Motivating defect: three topics carried `related: ['coc-extensions',
 * 'batch-jobs']` — ids that have never existed. formatDetailed silently drops
 * unresolvable ids via `.filter(Boolean)`, but formatConcise (the DEFAULT
 * output format) prints the raw list, so the model was handed nonexistent
 * topic ids presented as queryable and burned a round trip discovering they
 * return nothing. Nothing anywhere checked this.
 */

import { describe, it, expect } from 'vitest';
import { KNOWLEDGE_BASE } from '../../src/tools/xppKnowledge';

describe('KNOWLEDGE_BASE structural integrity', () => {
  const ids = new Set(KNOWLEDGE_BASE.map(e => e.id));

  it('has a non-trivial number of entries', () => {
    // Guards against an import/registry regression making every other
    // assertion in this file vacuously true.
    expect(KNOWLEDGE_BASE.length).toBeGreaterThan(50);
  });

  it('every entry id is unique', () => {
    const seen = new Map<string, number>();
    for (const e of KNOWLEDGE_BASE) seen.set(e.id, (seen.get(e.id) ?? 0) + 1);
    const dupes = [...seen.entries()].filter(([, n]) => n > 1).map(([id]) => id);
    expect(dupes, `duplicate topic ids: ${dupes.join(', ')}`).toEqual([]);
  });

  it('every related: id resolves to a real topic', () => {
    const dangling: string[] = [];
    for (const e of KNOWLEDGE_BASE) {
      for (const rel of e.related ?? []) {
        if (!ids.has(rel)) dangling.push(`${e.id} → ${rel}`);
      }
    }
    expect(
      dangling,
      `\nThese related: ids do not exist. The concise (default) formatter prints ` +
        `them verbatim, so the agent will call get_knowledge with a topic that ` +
        `returns nothing:\n${dangling.join('\n')}`,
    ).toEqual([]);
  });

  it('no entry lists itself as related', () => {
    const selfRefs = KNOWLEDGE_BASE.filter(e => (e.related ?? []).includes(e.id)).map(e => e.id);
    expect(selfRefs).toEqual([]);
  });

  it('every entry has an id, title, summary, keywords and at least one rule', () => {
    const bad: string[] = [];
    for (const e of KNOWLEDGE_BASE) {
      if (!e.id?.trim()) bad.push(`${e.title}: empty id`);
      if (!e.title?.trim()) bad.push(`${e.id}: empty title`);
      if (!e.summary?.trim()) bad.push(`${e.id}: empty summary`);
      if (!e.keywords?.length) bad.push(`${e.id}: no keywords`);
      if (!e.rules?.length) bad.push(`${e.id}: no rules`);
    }
    expect(bad, `\n${bad.join('\n')}`).toEqual([]);
  });

  it('ids are kebab-case', () => {
    // searchKnowledge tokenizes the query; a topic id the agent cannot type
    // back verbatim is a topic it cannot re-request.
    const bad = KNOWLEDGE_BASE.map(e => e.id).filter(id => !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(id));
    expect(bad, `non-kebab-case ids: ${bad.join(', ')}`).toEqual([]);
  });

  it('keywords are lowercase and non-empty', () => {
    // scoreEntry compares against a lowercased query; an uppercase keyword can
    // never match and is dead weight in the payload.
    const bad: string[] = [];
    for (const e of KNOWLEDGE_BASE) {
      for (const k of e.keywords) {
        if (k !== k.toLowerCase() || !k.trim()) bad.push(`${e.id}: "${k}"`);
      }
    }
    expect(bad, `\n${bad.join('\n')}`).toEqual([]);
  });

  it('every example has a label and code', () => {
    const bad: string[] = [];
    for (const e of KNOWLEDGE_BASE) {
      for (const [i, ex] of (e.examples ?? []).entries()) {
        if (!ex.label?.trim()) bad.push(`${e.id}: examples[${i}] has no label`);
        if (!ex.code?.trim()) bad.push(`${e.id}: examples[${i}] has no code`);
      }
    }
    expect(bad, `\n${bad.join('\n')}`).toEqual([]);
  });
});
