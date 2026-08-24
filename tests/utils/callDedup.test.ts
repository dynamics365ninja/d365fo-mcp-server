/**
 * Dedup cache + call-sequence loop detection tests.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  dedupKey, getDedupedResult, storeDedupResult, clearDedupCache,
  appendNote, DEDUP_EXCLUDED_TOOLS, DEDUP_TTL_MS,
  getInFlight, registerInFlight, clearInFlight, clearAllInFlight,
  MUTATING_TOOLS, currentWriteEpoch, bumpWriteEpoch,
} from '../../src/utils/callDedup';
import { recordCallSequence, resetCallSequence, getMetricsSnapshot, occurrencesInEpoch } from '../../src/utils/toolMetrics';

beforeEach(() => {
  clearDedupCache();
  clearAllInFlight();
  resetCallSequence();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('dedup cache', () => {
  it('ignores argument order — the same call spelled two ways hits one entry', () => {
    // JSON.stringify preserved insertion order, so {objectType,name} and
    // {name,objectType} were two cache entries for one call and the second
    // spelling always missed and re-ran the query.
    const a = dedupKey('get_object_info', { objectType: 'table', name: 'CustTable' });
    const b = dedupKey('get_object_info', { name: 'CustTable', objectType: 'table' });
    expect(a).toBe(b);

    storeDedupResult(a, { content: [{ type: 'text', text: 'CustTable' }] });
    expect(getDedupedResult(b)).toBeDefined();
  });

  it('sorts keys at every depth, not just the top level', () => {
    expect(dedupKey('prepare', { o: { z: 1, a: 2 }, t: 'x' }))
      .toBe(dedupKey('prepare', { t: 'x', o: { a: 2, z: 1 } }));
  });

  it('keeps ARRAY order significant — operations[] order is meaningful', () => {
    // Two ops applied in the opposite order are a different write, not a repeat.
    expect(dedupKey('d365fo_file', { operations: [{ op: 'a' }, { op: 'b' }] }))
      .not.toBe(dedupKey('d365fo_file', { operations: [{ op: 'b' }, { op: 'a' }] }));
  });

  it('falls back to a stable marker for a circular argument', () => {
    const circular: any = { name: 'X' };
    circular.self = circular;
    expect(dedupKey('search', circular)).toBe('search|<unserializable>');
  });

  it('returns the stored result for an identical key within the TTL', () => {
    const key = dedupKey('search', { query: 'CustTable' });
    const result = { content: [{ type: 'text', text: 'hit' }] };
    storeDedupResult(key, result);
    expect(getDedupedResult(key)).toBe(result);
  });

  it('treats different args as different keys', () => {
    storeDedupResult(dedupKey('search', { query: 'A' }), { content: [{ type: 'text', text: 'A' }] });
    expect(getDedupedResult(dedupKey('search', { query: 'B' }))).toBeUndefined();
  });

  it('expires entries after the TTL', () => {
    vi.useFakeTimers();
    const key = dedupKey('search', { query: 'CustTable' });
    storeDedupResult(key, { content: [{ type: 'text', text: 'hit' }] });
    vi.advanceTimersByTime(DEDUP_TTL_MS + 1);
    expect(getDedupedResult(key)).toBeUndefined();
  });

  it('never caches error results', () => {
    const key = dedupKey('search', { query: 'X' });
    storeDedupResult(key, { isError: true, content: [{ type: 'text', text: 'fail' }] });
    expect(getDedupedResult(key)).toBeUndefined();
  });

  it('excludes stateful tools from dedup', () => {
    for (const tool of ['build_d365fo_project', 'd365fo_file', 'prepare', 'get_workspace_info']) {
      expect(DEDUP_EXCLUDED_TOOLS.has(tool)).toBe(true);
    }
    expect(DEDUP_EXCLUDED_TOOLS.has('search')).toBe(false);
    expect(DEDUP_EXCLUDED_TOOLS.has('get_table_info')).toBe(false);
  });

  it('excludes generate_object from dedup (writes to disk + reads live symbol-index state)', () => {
    // Regression (2026-07-01 usage-examples eval, scenario 2): generate_object(mode="scaffold",
    // objectType="form", cloneFrom=...) writes the file directly to disk in traditional/Windows
    // mode, and its cloneFrom/tableMapping resolution depends on the CURRENT symbol-index state.
    // A retry after update_symbol_index() used to be served the stale/broken cached result
    // instead of re-reading the now-current index.
    expect(DEDUP_EXCLUDED_TOOLS.has('generate_object')).toBe(true);
  });
});

describe('appendNote', () => {
  it('appends to the first text item only', () => {
    const result = appendNote(
      { content: [{ type: 'text', text: 'body' }, { type: 'text', text: 'second' }] },
      '> note',
    );
    expect(result.content[0].text).toBe('body\n\n> note');
    expect(result.content[1].text).toBe('second');
  });

  it('returns the input unchanged when there is no content', () => {
    const r = { content: [] };
    expect(appendNote(r, 'x')).toBe(r);
  });
});

describe('in-flight dedup', () => {
  it('getInFlight returns undefined before registration', () => {
    expect(getInFlight('k1')).toBeUndefined();
  });

  it('registerInFlight makes the promise available via getInFlight', () => {
    registerInFlight('k1');
    expect(getInFlight('k1')).toBeInstanceOf(Promise);
  });

  it('resolving the handle settles the promise', async () => {
    const handle = registerInFlight('k1');
    const result = { content: [{ type: 'text', text: 'done' }] };
    handle.resolve(result);
    await expect(getInFlight('k1')).resolves.toBe(result);
  });

  it('clearInFlight removes the entry', () => {
    registerInFlight('k1');
    clearInFlight('k1');
    expect(getInFlight('k1')).toBeUndefined();
  });

  it('coalesces two parallel identical calls (integration)', async () => {
    // Simulate two concurrent calls: both check in-flight, neither finds a
    // cached result. The first registers; the second should coalesce onto it.
    const key = dedupKey('object_patterns', { domain: 'form', action: 'analyze' });

    // --- caller A: registers and will resolve after a tick ---
    const handle = registerInFlight(key);
    const result = { content: [{ type: 'text', text: 'patterns' }] };

    // --- caller B: finds the in-flight promise ---
    const inFlight = getInFlight(key);
    expect(inFlight).toBeInstanceOf(Promise);

    // Simulate A completing
    handle.resolve(result);
    clearInFlight(key);

    // B should receive the same result
    expect(await inFlight).toBe(result);
  });
});

describe('recordCallSequence (loop detection)', () => {
  it('counts identical calls within the window', () => {
    expect(recordCallSequence('search', 'k1')).toBe(1);
    expect(recordCallSequence('search', 'k1')).toBe(2);
    expect(recordCallSequence('search', 'k1')).toBe(3);
  });

  it('does not mix different tools or args', () => {
    recordCallSequence('search', 'k1');
    expect(recordCallSequence('get_table_info', 'k1')).toBe(1);
    expect(recordCallSequence('search', 'k2')).toBe(1);
  });

  it('forgets calls that fall outside the window', () => {
    recordCallSequence('search', 'k1');
    for (let i = 0; i < 15; i++) recordCallSequence('other', `fill-${i}`);
    expect(recordCallSequence('search', 'k1')).toBe(1);
  });

  /**
   * The loop advisory fires on repeats WITHIN one write epoch, not on raw repeats.
   *
   * Re-reading after a write is correct behaviour — it is how an agent sees its own
   * edit. Counting raw repeats attached "the answer does not change between calls"
   * to content this server's own writes had just changed twice (observed live, eval
   * case L2-entity-query-range-roundtrip, 2026-08-24, occurrence #3). That is the
   * same hazard the cache invalidation was for: talking an agent out of trusting a
   * re-read it was right to make.
   */
  it('counts three repeats as a loop only while the epoch holds', () => {
    for (let i = 0; i < 3; i++) recordCallSequence('get_object_info', 'ep', 7);
    expect(occurrencesInEpoch('get_object_info', 'ep', 7)).toBe(3);
  });

  it('does not count a re-read that follows a write as a repeat', () => {
    // Two reads, then a write bumps the epoch, then the same read twice more.
    recordCallSequence('get_object_info', 'ep2', 1);
    recordCallSequence('get_object_info', 'ep2', 1);
    recordCallSequence('get_object_info', 'ep2', 2);
    recordCallSequence('get_object_info', 'ep2', 2);
    // Four identical calls in the window — but never three under one epoch, so no
    // loop advisory in either.
    expect(occurrencesInEpoch('get_object_info', 'ep2', 1)).toBe(2);
    expect(occurrencesInEpoch('get_object_info', 'ep2', 2)).toBe(2);
  });

  it('tracks duplicates in the metrics snapshot', () => {
    recordCallSequence('search', 'dup');
    recordCallSequence('search', 'dup');
    const snap = getMetricsSnapshot().find(s => s.tool === 'search');
    expect(snap?.duplicateCalls).toBeGreaterThanOrEqual(1);
  });
});

/**
 * Write-awareness. The cache used to key purely on (tool, args), so a read
 * repeated after a write was answered from before the write — and the note it
 * carried told the agent to trust it ("the result above is identical. Use the
 * data you already have instead of re-querying").
 *
 * Observed in 2 of the 4 eval runs on 2026-08-23: a get_object_info(include:"xml")
 * on a data entity, three d365fo_file(action="modify") writes, then the same read
 * again — served the 2399-byte pre-write body while disk held 2738 bytes with both
 * ranges. An agent verifying its own write is told the write did not happen.
 */
describe('dedup cache — invalidation on write', () => {
  const key = () => dedupKey('get_object_info', { objectType: 'data-entity', name: 'MyEntity' });

  it('serves the cached read when nothing has been written', () => {
    storeDedupResult(key(), { content: [{ type: 'text', text: 'before' }] }, currentWriteEpoch());
    expect(getDedupedResult(key())?.content[0].text).toBe('before');
  });

  it('drops the cached read once a write bumps the epoch', () => {
    storeDedupResult(key(), { content: [{ type: 'text', text: 'before' }] }, currentWriteEpoch());
    bumpWriteEpoch(); // d365fo_file(action="modify")
    expect(getDedupedResult(key())).toBeUndefined();
  });

  it('stays dropped after several writes, and re-caches under the new epoch', () => {
    storeDedupResult(key(), { content: [{ type: 'text', text: 'before' }] }, currentWriteEpoch());
    bumpWriteEpoch(); bumpWriteEpoch(); bumpWriteEpoch();
    expect(getDedupedResult(key())).toBeUndefined();

    storeDedupResult(key(), { content: [{ type: 'text', text: 'after' }] }, currentWriteEpoch());
    expect(getDedupedResult(key())?.content[0].text).toBe('after');
  });

  it('refuses to cache a read that RACED a write', () => {
    // The read starts, a write lands while it is in flight, the read finishes:
    // its answer describes the pre-write disk and must not become the cached one.
    const epochAtStart = currentWriteEpoch();
    bumpWriteEpoch();
    storeDedupResult(key(), { content: [{ type: 'text', text: 'raced' }] }, epochAtStart);
    expect(getDedupedResult(key())).toBeUndefined();
  });

  it('leaves unrelated cached reads alone only until the next write', () => {
    const other = dedupKey('search', { query: 'CustTable' });
    storeDedupResult(other, { content: [{ type: 'text', text: 'hit' }] }, currentWriteEpoch());
    expect(getDedupedResult(other)).toBeDefined();
    // Epoch-wide on purpose: a write to one object changes reads of others
    // (extensions, references, search hits, the index), so scoping the blast
    // radius would be a guess.
    bumpWriteEpoch();
    expect(getDedupedResult(other)).toBeUndefined();
  });

  it('every mutating tool is also excluded from being cached itself', () => {
    for (const tool of MUTATING_TOOLS) {
      expect(DEDUP_EXCLUDED_TOOLS.has(tool), `${tool} must never be served from cache`).toBe(true);
    }
  });

  it('names the write tools that can change a later read', () => {
    // A new write surface that is not here reopens the defect, so the set is
    // asserted rather than merely spot-checked.
    expect([...MUTATING_TOOLS].sort()).toEqual([
      'd365fo_file', 'generate_object', 'labels',
      'trigger_db_sync', 'undo_last_modification', 'update_symbol_index',
    ]);
  });
});
