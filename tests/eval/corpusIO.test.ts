/**
 * Corpus record loading (docs/AGENT_EVAL_LOOP.md §10) — BOM tolerance.
 *
 * Regression: every improver CLI (`eval:clusters`, `eval:report`, `eval:brief`,
 * `eval:flakes`, `eval:knowledge`) parsed `eval/corpus/runs/*.json` with a bare
 * `JSON.parse(fs.readFileSync(f, 'utf8'))` wrapped in `try { } catch { return null }`.
 * Several implementer-written corpus records carry a leading UTF-8 BOM (observed
 * 2026-07-08: 52 of 60 files in eval/corpus/runs/), which `JSON.parse` rejects —
 * and the bare catch swallowed the failure silently, so `npm run eval:clusters`
 * reported "Loaded 8 corpus run(s)" when 60 were on disk, with no error surfaced.
 * That starved every downstream cluster/priority/report computation of ~87% of the
 * evidence. Fixed by stripping a leading BOM before parsing.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { stripBom, readJsonLenient, loadJsonRecords } from '../../src/eval/improver/corpusIO';

describe('stripBom', () => {
  it('removes a leading UTF-8 BOM character', () => {
    expect(stripBom('﻿{"a":1}')).toBe('{"a":1}');
  });

  it('is a no-op when there is no BOM', () => {
    expect(stripBom('{"a":1}')).toBe('{"a":1}');
  });

  it('is a no-op on an empty string', () => {
    expect(stripBom('')).toBe('');
  });
});

describe('readJsonLenient', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'corpusio-test-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('parses a plain UTF-8 JSON file', () => {
    const f = path.join(dir, 'plain.json');
    fs.writeFileSync(f, '{"run_id":"a","classification":"PASS"}', 'utf8');
    expect(readJsonLenient(f)).toEqual({ run_id: 'a', classification: 'PASS' });
  });

  it('parses a JSON file written with a leading UTF-8 BOM (the corpus writer\'s actual output)', () => {
    const f = path.join(dir, 'bom.json');
    fs.writeFileSync(f, '﻿{"run_id":"b","classification":"TOOL_DEFECT"}', 'utf8');
    expect(readJsonLenient(f)).toEqual({ run_id: 'b', classification: 'TOOL_DEFECT' });
  });

  it('still throws on genuinely malformed JSON (BOM stripping does not mask real corruption)', () => {
    const f = path.join(dir, 'broken.json');
    fs.writeFileSync(f, '﻿{not valid json', 'utf8');
    expect(() => readJsonLenient(f)).toThrow();
  });
});

describe('loadJsonRecords', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'corpusio-test-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const isCorpusRun = (r: unknown): r is { run_id: string; classification: string } =>
    r != null && typeof r === 'object' && typeof (r as any).classification === 'string';

  it('returns [] when the directory does not exist', () => {
    expect(loadJsonRecords(path.join(dir, 'does-not-exist'), isCorpusRun)).toEqual([]);
  });

  it('loads BOM and non-BOM records alike, skipping non-.json and malformed files', () => {
    fs.writeFileSync(path.join(dir, 'a.json'), '{"run_id":"a","classification":"PASS"}', 'utf8');
    fs.writeFileSync(path.join(dir, 'b.json'), '﻿{"run_id":"b","classification":"TOOL_DEFECT"}', 'utf8');
    fs.writeFileSync(path.join(dir, 'c.json'), '﻿{not json', 'utf8');
    fs.writeFileSync(path.join(dir, 'notes.txt'), '{"run_id":"d","classification":"PASS"}', 'utf8');
    fs.writeFileSync(path.join(dir, 'd.json'), '{"run_id":"e"}', 'utf8'); // fails isValid (no classification)

    const records = loadJsonRecords(dir, isCorpusRun);
    const runIds = records.map(r => r.run_id).sort();
    expect(runIds).toEqual(['a', 'b']);
  });

  it('demonstrates the regression this fixes: a naive readdir+JSON.parse+bare-catch loader silently drops every BOM file', () => {
    fs.writeFileSync(path.join(dir, 'a.json'), '{"run_id":"a","classification":"PASS"}', 'utf8');
    fs.writeFileSync(path.join(dir, 'b.json'), '﻿{"run_id":"b","classification":"TOOL_DEFECT"}', 'utf8');

    const naiveLoaded = fs.readdirSync(dir)
      .filter(f => f.endsWith('.json'))
      .map(f => {
        try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); }
        catch { return null; }
      })
      .filter((r): r is { run_id: string } => r != null);
    expect(naiveLoaded.length).toBe(1); // the bug: BOM file silently dropped

    const fixedLoaded = loadJsonRecords(dir, isCorpusRun);
    expect(fixedLoaded.length).toBe(2); // the fix: both records load
  });
});
