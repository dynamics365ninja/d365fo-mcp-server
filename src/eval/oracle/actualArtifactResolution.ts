/**
 * Multi-artifact (`--actual-dir`) actual-file resolution for src/eval/oracle/cli.ts.
 * Pure logic + fs reads — no CLI argv/process side effects — split out so it can be
 * unit-tested without triggering the CLI script's `main()` (docs/AGENT_EVAL_LOOP.md §6).
 */

import * as fs from 'fs';
import * as path from 'path';
import { canonicalizePrefix } from './normalize.js';

/**
 * Resolve the actual-dir file matching a golden artifact filename. Tries an
 * exact filename match first (fast path, and the only path when golden and
 * actual happen to share the same EXTENSION_PREFIX session); if that misses,
 * falls back to matching on the PREFIX-CANONICALISED filename (the golden's
 * filename is itself typically a prefixed object name, e.g.
 * "ContosoMyContract.metadata.xml", produced under a different session than the
 * one that generated the actual artifacts) so a whole L3/L4 multi-artifact
 * case doesn't spuriously score every artifact as missing/extra under prefix
 * drift alone.
 */
export function resolveActualFile(
  actualDir: string,
  goldenName: string,
  goldenPrefix: string,
  actualPrefix: string,
): string | undefined {
  const direct = path.join(actualDir, goldenName);
  if (fs.existsSync(direct)) return direct;
  const canonGolden = canonicalizePrefix(goldenName, goldenPrefix);
  const candidate = fs.readdirSync(actualDir)
    .filter(f => f.endsWith('.metadata.xml'))
    .find(f => canonicalizePrefix(f, actualPrefix) === canonGolden);
  return candidate ? path.join(actualDir, candidate) : undefined;
}

/**
 * Build the `actualArtifacts` map for a multi-artifact (`--actual-dir`) run,
 * one entry per golden artifact name.
 *
 * Regression: this used to key every entry by the GOLDEN's own filename
 * (`actualArtifacts[name] = ...` inside a `for (const name of
 * artifactNames)` loop) even when the resolved actual file had a DIFFERENT
 * literal prefix (e.g. golden "ContosoMyContract.metadata.xml" resolved to actual
 * file "DemoMyContract.metadata.xml" under prefix-agnostic matching —
 * `resolveActualFile`'s whole point). `evaluateMulti`/`normalizeMultiArtifact`
 * then canonicalises each artifact KEY with `actualPrefix` — but a key that's
 * still the GOLDEN's literal name doesn't contain `actualPrefix` at all, so
 * `canonicalizePrefix` is a no-op on it, and the golden side's key (correctly
 * canonicalised from ITS OWN prefix) never matches. Every path in the
 * artifact then shows up as wholesale `missing` (under the golden's canonical
 * key) AND `extra` (under the actual's un-canonicalised key), even when the
 * content is byte-identical. Keying by the RESOLVED actual file's own
 * basename (which DOES contain `actualPrefix`) fixes the canonicalisation on
 * both sides consistently — matching the documented multi-artifact contract
 * (src/eval/oracle/normalize.ts's `normalizeMultiArtifact` doc comment).
 *
 * A golden artifact with NO resolvable actual file (genuinely missing, not a
 * prefix-matching miss) keeps the golden's own name as the key with empty
 * content — unchanged from before; there is no real actual basename to key it
 * by, and the empty content correctly registers every one of that artifact's
 * paths as `missing`.
 */
export function buildActualArtifactsMap(
  actualDir: string,
  artifactNames: string[],
  goldenPrefix: string,
  actualPrefix: string,
): { actualArtifacts: Record<string, string>; matchedActualFiles: Set<string> } {
  const actualArtifacts: Record<string, string> = {};
  const matchedActualFiles = new Set<string>();
  for (const name of artifactNames) {
    const actualFile = resolveActualFile(actualDir, name, goldenPrefix, actualPrefix);
    if (actualFile) {
      const actualBasename = path.basename(actualFile);
      actualArtifacts[actualBasename] = fs.readFileSync(actualFile, 'utf8');
      matchedActualFiles.add(actualBasename);
    } else {
      actualArtifacts[name] = '';
    }
  }
  return { actualArtifacts, matchedActualFiles };
}
