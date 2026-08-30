/**
 * Index warm-up — the cold-cache tax, paid off the request path.
 *
 * Measured on the reference VM: the first covering scan of idx_symbols_name
 * costs 83 s cold and 0.11 s warm, the labels ⋈ label_files join 31 s cold, and
 * a covering scan of idx_type_name 33 s cold. Benchmark run d79f62a3 spent
 * 189 s / 174 s / 33 s on exactly those three, on queries that are milliseconds
 * once the pages are cached.
 *
 * The SQL is asserted against a REAL schema, because the whole warm-up turns
 * into a silent no-op if an index is renamed: `INDEXED BY` fails loudly here
 * rather than warming whichever index SQLite would have picked instead.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { XppSymbolIndex } from '../../src/metadata/symbolIndex';
import { WARMUP_STEPS } from '../../src/metadata/indexWarmupWorker';
import { shouldWarmIndexes, warmIndexes, renderWarmupReport } from '../../src/metadata/indexWarmup';

describe('WARMUP_STEPS', () => {
  let index: any;

  beforeEach(() => { index = new XppSymbolIndex(':memory:', ':memory:'); });
  afterEach(() => { index.close?.(); });

  it('names indexes that exist in the shipped schema', () => {
    for (const step of WARMUP_STEPS) {
      const db = step.db === 'symbols' ? index.getReadDb() : index.labelsDb;
      // Throws "no such index" if the schema drifted from the step list.
      expect(() => db.prepare(step.sql).get(), step.name).not.toThrow();
    }
  });

  it('leads with the step the benchmark waits on longest', () => {
    // The budget cuts from the end, so order is not cosmetic.
    expect(WARMUP_STEPS[0].name).toBe('symbols.idx_symbols_name');
  });
});

describe('shouldWarmIndexes', () => {
  const original = process.env.INDEX_WARMUP;
  afterEach(() => {
    if (original === undefined) delete process.env.INDEX_WARMUP;
    else process.env.INDEX_WARMUP = original;
  });

  it('warms a real pair of database files', () => {
    delete process.env.INDEX_WARMUP;
    expect(shouldWarmIndexes('K:/data/xpp.db', 'K:/data/xpp-labels.db')).toBe(true);
  });

  it('skips an in-memory database, which has nothing to warm', () => {
    delete process.env.INDEX_WARMUP;
    expect(shouldWarmIndexes(':memory:', ':memory:')).toBe(false);
    expect(shouldWarmIndexes('K:/data/xpp.db', ':memory:')).toBe(false);
  });

  it('honours INDEX_WARMUP=off', () => {
    process.env.INDEX_WARMUP = 'off';
    expect(shouldWarmIndexes('K:/data/xpp.db', 'K:/data/xpp-labels.db')).toBe(false);
  });
});

describe('warmIndexes', () => {
  it('collects every step, keeps failures apart from successes, and passes the budget on', async () => {
    const report = await warmIndexes({
      dbPath: 'unused.db',
      labelsDbPath: 'unused-labels.db',
      budgetMs: 1234,
      workerUrl: new URL('../fixtures/fakeWarmupWorker.mjs', import.meta.url),
    });

    expect(report.steps.map(s => s.name)).toEqual(['symbols.idx_symbols_name', 'labels join label_files']);
    expect(report.failed).toEqual([{ name: 'labels_fts', error: 'no such table: labels_fts' }]);
    expect(report.totalMs).toBe(11000);
  });

  it('rejects rather than hanging when the worker cannot run', async () => {
    await expect(warmIndexes({
      dbPath: 'unused.db',
      labelsDbPath: 'unused-labels.db',
      workerUrl: new URL('../fixtures/thisWorkerDoesNotExist.mjs', import.meta.url),
    })).rejects.toThrow();
  });
});

describe('renderWarmupReport', () => {
  it('names the two most expensive steps — the only ones worth acting on', () => {
    const line = renderWarmupReport({
      steps: [
        { name: 'a', ms: 1000, rows: 1 },
        { name: 'b', ms: 9000, rows: 1 },
        { name: 'c', ms: 5000, rows: 1 },
      ],
      failed: [{ name: 'd', error: 'x' }],
      totalMs: 15000,
    });

    expect(line).toContain('15.0s');
    expect(line).toContain('b 9.0s, c 5.0s');
    expect(line).toContain('1 step(s) skipped');
    expect(line).not.toContain('a 1.0s');
  });
});
