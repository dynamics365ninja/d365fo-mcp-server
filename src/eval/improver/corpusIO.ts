/**
 * Shared corpus-record loading for the improver CLIs (docs/AGENT_EVAL_LOOP.md
 * §10). VM-free — reads `eval/corpus/runs/*.json` from disk.
 *
 * The implementer (running on Windows/PowerShell) writes some corpus records
 * with a UTF-8 BOM. `JSON.parse` throws on a leading BOM, and every loader in
 * this package swallows parse errors in a bare `catch { return null }` so a
 * malformed run is skipped rather than crashing the CLI — which silently
 * dropped the majority of the corpus (52/60 files observed 2026-07-08) from
 * every report/cluster/brief/flake/knowledge CLI without any error surfaced.
 * Strip the BOM before parsing so a valid-JSON-except-for-BOM file loads like
 * any other record.
 */

import * as fs from 'fs';
import * as path from 'path';

/** Strip a leading UTF-8 BOM (U+FEFF), if present, from file text. */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** Parse a JSON file, tolerating a leading UTF-8 BOM. */
export function readJsonLenient<T = unknown>(filePath: string): T {
  return JSON.parse(stripBom(fs.readFileSync(filePath, 'utf8'))) as T;
}

/**
 * Read every `*.json` file directly under `dir`, parsing each with
 * {@link readJsonLenient} and keeping only records that pass `isValid`.
 * A file that fails to parse (bad JSON, not just BOM) or fails `isValid` is
 * silently skipped — callers that need to know about skips should check the
 * returned array length against the directory listing themselves.
 */
export function loadJsonRecords<T>(dir: string, isValid: (r: unknown) => r is T): T[] {
  if (!fs.existsSync(dir)) return [];
  const out: T[] = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    let parsed: unknown;
    try {
      parsed = readJsonLenient(path.join(dir, f));
    } catch {
      continue;
    }
    if (isValid(parsed)) out.push(parsed);
  }
  return out;
}
