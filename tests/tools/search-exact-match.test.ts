/**
 * Finding #15 (2026-07-21 golden-capture sweep):
 *   `search(type="edt", query="Num")` at limit=40 never surfaced the EDT `Num`
 *   — the window was filled with NumberOf* / Numeric* prefix hits.
 *
 * Two independent causes, one per backing search:
 *   • the C# bridge fills its window in provider-enumeration order and truncates
 *     at maxResults, so a short exact name can be missing altogether;
 *   • the SQLite path orders by FTS5 `rank` (token frequency), which says
 *     nothing about name equality.
 *
 * PERFORMANCE CONSTRAINT: the repair may not introduce a full-scan query shape
 * on the 1.17M-row production symbol DB. The exact probe therefore goes through
 * `lookupSymbolsNocase` (exact-case equality on idx_name_type + bounded FTS
 * phrase fallback) — asserted below by inspecting the SQL that actually runs.
 */

import { describe, it, expect, vi } from 'vitest';
import Database from 'better-sqlite3';
import { tryBridgeSearch } from '../../src/bridge/bridgeAdapter';
import type { BridgeClient } from '../../src/bridge/bridgeClient';
import { rankExactFirst, exactMatchRank } from '../../src/utils/exactMatchRanking';
import { probeExactMatches } from '../../src/tools/search';

// ── ranking primitive ────────────────────────────────────────────────────────

describe('exact-match ranking primitive', () => {
  it('ranks exact above case-insensitive-exact above prefix above the rest', () => {
    expect(exactMatchRank('Num', 'Num')).toBe(0);
    expect(exactMatchRank('Num', 'NUM')).toBe(1);
    expect(exactMatchRank('Num', 'NumberOfDays')).toBe(2);
    expect(exactMatchRank('Num', 'AccountNum')).toBe(3);
  });

  it('is a stable sort — equal-rank items keep the backing search order', () => {
    const items = ['NumberOfDays', 'NumericSequence', 'Num', 'NumberSequenceCode'];
    expect(rankExactFirst('Num', items, n => n)).toEqual([
      'Num', 'NumberOfDays', 'NumericSequence', 'NumberSequenceCode',
    ]);
  });
});

// ── bridge path ──────────────────────────────────────────────────────────────

function makeBridge(results: { name: string; type: string }[]): BridgeClient {
  return {
    isReady: true,
    metadataAvailable: true,
    searchObjects: vi.fn(async () => ({ results, totalCount: results.length })),
  } as unknown as BridgeClient;
}

/** The exact shape observed on the VM: 40 prefix hits, no `Num`. */
const PREFIX_HITS = Array.from({ length: 40 }, (_, i) => ({
  name: i % 2 === 0 ? `NumberOf${i}` : `Numeric${i}`,
  type: 'edt',
}));

describe('tryBridgeSearch — exact match first (#15)', () => {
  it('ranks an exact match first when the bridge returned it buried in the window', async () => {
    const bridge = makeBridge([...PREFIX_HITS.slice(0, 20), { name: 'Num', type: 'edt' }, ...PREFIX_HITS.slice(20)]);

    const result = await tryBridgeSearch(bridge, 'Num', 'edt', 40);
    const text = (result!.content[0] as { text: string }).text;

    const firstBullet = text.split('\n').find(l => l.startsWith('- '));
    expect(firstBullet).toContain('**Num**');
    expect(firstBullet).toContain('exact match');
  });

  it('splices in an exact match the bridge window truncated away', async () => {
    // Reproduces the VM observation directly: the bridge returns ONLY prefix
    // hits, `Num` is beyond its cutoff, and the agent is told the EDT is absent.
    const bridge = makeBridge(PREFIX_HITS);

    const result = await tryBridgeSearch(bridge, 'Num', 'edt', 40, {
      exactMatches: [{ name: 'Num', type: 'edt' }],
    });
    const text = (result!.content[0] as { text: string }).text;

    expect(text).toContain('**Num**');
    const firstBullet = text.split('\n').find(l => l.startsWith('- '));
    expect(firstBullet).toContain('**Num**');
    expect(text).toContain('SQLite symbol index');
  });

  it('ignores non-exact "exactMatches" candidates', async () => {
    const bridge = makeBridge([{ name: 'NumberOfDays', type: 'edt' }]);

    const result = await tryBridgeSearch(bridge, 'Num', 'edt', 40, {
      exactMatches: [{ name: 'NumberSequenceCode', type: 'edt' }],
    });
    const text = (result!.content[0] as { text: string }).text;

    expect(text).not.toContain('NumberSequenceCode');
  });

  it('does not duplicate an exact match already present in the bridge window', async () => {
    const bridge = makeBridge([{ name: 'Num', type: 'edt' }, { name: 'NumberOfDays', type: 'edt' }]);

    const result = await tryBridgeSearch(bridge, 'Num', 'edt', 40, {
      exactMatches: [{ name: 'Num', type: 'edt' }],
    });
    const text = (result!.content[0] as { text: string }).text;

    expect(text.match(/\*\*Num\*\*/g)).toHaveLength(1);
  });
});

// ── index probe: correctness AND query shape ─────────────────────────────────

/** Minimal symbols schema + FTS mirror, matching src/metadata/symbolIndex.ts. */
function makeIndexDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE symbols (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL, type TEXT NOT NULL, parent_name TEXT,
      signature TEXT, file_path TEXT, model TEXT, description TEXT,
      extends_class TEXT
    );
    CREATE INDEX idx_symbols_name ON symbols(name);
    CREATE INDEX idx_name_type ON symbols(name, type);
    CREATE VIRTUAL TABLE symbols_fts USING fts5(name, type, parent_name, signature, description, tags);
  `);
  const ins = db.prepare(
    `INSERT INTO symbols (name, type, parent_name, model, file_path) VALUES (?, ?, NULL, ?, ?)`,
  );
  const insFts = db.prepare(`INSERT INTO symbols_fts (rowid, name, type) VALUES (?, ?, ?)`);
  const add = (name: string, type: string) => {
    const info = ins.run(name, type, 'ApplicationPlatform', `K:\\Ax${type}\\${name}.xml`);
    insFts.run(info.lastInsertRowid, name, type);
  };
  add('Num', 'edt');
  for (const h of PREFIX_HITS) add(h.name, h.type);
  add('Num', 'class'); // same name, different type — must be filtered by type
  return db;
}

describe('probeExactMatches — index-safe exact probe (#15)', () => {
  it('finds the exact EDT the FTS ranking buried', () => {
    const db = makeIndexDb();
    const hits = probeExactMatches({ getReadDb: () => db }, 'Num', ['edt']);
    expect(hits.map(h => h.name)).toEqual(['Num']);
    expect(hits[0].type).toBe('edt');
  });

  it('resolves a differently-cased query without COLLATE NOCASE as the primary predicate', () => {
    const db = makeIndexDb();
    const hits = probeExactMatches({ getReadDb: () => db }, 'num', ['edt']);
    expect(hits.map(h => h.name)).toEqual(['Num']);
  });

  it('never emits an unindexed LIKE or a bare COLLATE NOCASE scan (2 GB DB constraint)', () => {
    const db = makeIndexDb();
    const seen: string[] = [];
    const realPrepare = db.prepare.bind(db);
    (db as any).prepare = (sql: string) => { seen.push(sql); return realPrepare(sql); };

    probeExactMatches({ getReadDb: () => db }, 'num', ['edt']);

    expect(seen.length).toBeGreaterThan(0);
    for (const sql of seen) {
      expect(sql).not.toMatch(/LIKE/i);
      // COLLATE NOCASE is allowed only as a re-check on FTS-narrowed candidates,
      // never as the sole predicate of a symbols scan.
      if (/COLLATE NOCASE/i.test(sql)) expect(sql).toMatch(/symbols_fts MATCH/i);
    }
    // The first probe must be the exact-case equality served by idx_name_type.
    expect(seen[0]).toMatch(/s\.name = \?/);
  });

  it('returns [] instead of throwing when there is no readable DB', () => {
    expect(probeExactMatches({}, 'Num', ['edt'])).toEqual([]);
    expect(probeExactMatches({ getReadDb: () => { throw new Error('closed'); } }, 'Num', ['edt'])).toEqual([]);
  });

  it('skips multi-token / wildcard queries — those are not name lookups', () => {
    const db = makeIndexDb();
    expect(probeExactMatches({ getReadDb: () => db }, 'Num ber', ['edt'])).toEqual([]);
    expect(probeExactMatches({ getReadDb: () => db }, 'Num*', ['edt'])).toEqual([]);
  });
});
