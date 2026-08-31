/**
 * Every corpus record must parse. A skipped one is lost evidence, not a warning.
 *
 * `loadJsonRecords` skips a file it cannot parse, and says so in its own doc
 * comment: "silently skipped — callers that need to know about skips should check
 * the returned array length against the directory listing themselves." Nothing
 * did. So a run record written on 2026-07-07 sat in the directory for eight weeks
 * carrying `classification: TOOL_DEFECT`, invisible to every cluster, report and
 * held-out check that reads the corpus — the improver was ranking failures
 * against a corpus it did not know was short.
 *
 * The cause was a writer that put Windows paths into JSON without escaping the
 * backslashes; `\c` is not a valid escape, and stricter parsers reject the whole
 * document. (BOMs are a separate, already-fixed hazard: `stripBom` handles those,
 * and 52 records rely on it.)
 *
 * This is the check the doc comment asked someone to write.
 */
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { readJsonLenient } from '../../src/eval/improver/corpusIO.js';

const RUNS = path.join(process.cwd(), 'eval', 'corpus', 'runs');
const files = () => fs.readdirSync(RUNS).filter(f => f.toLowerCase().endsWith('.json'));

describe('corpus records are all readable', () => {
  it('every record parses — a silent skip is evidence quietly leaving the corpus', () => {
    const broken: string[] = [];
    for (const f of files()) {
      try {
        readJsonLenient(path.join(RUNS, f));
      } catch (e) {
        broken.push(`${f}: ${(e as Error).message}`);
      }
    }
    expect(
      broken,
      'These records are dropped by loadJsonRecords without a word, so every cluster and ' +
      'report is computed over fewer runs than the directory holds. Usually an unescaped ' +
      'Windows path — \\ in JSON, or no backslash at all.',
    ).toEqual([]);
  });

  it('each record carries the identity the improver keys on', () => {
    const missing: string[] = [];
    for (const f of files()) {
      const r = readJsonLenient<Record<string, unknown>>(path.join(RUNS, f));
      if (!r.case_id || !r.run_id) missing.push(f);
    }
    expect(missing, 'a record without case_id/run_id cannot be clustered').toEqual([]);
  });

  it('is actually looking at the corpus', () => {
    // A broken path would make both checks above pass forever.
    expect(files().length).toBeGreaterThan(100);
  });
});
