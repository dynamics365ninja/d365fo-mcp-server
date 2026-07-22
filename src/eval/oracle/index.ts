/**
 * Eval golden oracle — orchestrator.
 *
 * Given a case spec, the actual produced XML, the golden XML, and the build
 * result, compute the structural golden diff and the scorecard. VM-free: this is
 * the piece the improver/CI runs without the D365FO platform.
 */

import { normalizeAotXml, normalizeMultiArtifact } from './normalize.js';
import { diffNormalized, type GoldenDiff } from './diff.js';
import { scoreRun, type BuildResult, type Score } from './score.js';
import { type SysTestResult } from './systest.js';

export {
  normalizeAotXml, normalizeMultiArtifact, renderNormalized, globToRegExp,
  GOLDEN_CAPTURE_PREFIX, GOLDEN_CAPTURE_PREFIXES, canonicalizePrefix, type PrefixSpec,
} from './normalize.js';
export { artifactKey, artifactKeyMap } from './artifactKey.js';
export { diffNormalized, renderDiff, type GoldenDiff } from './diff.js';
export { scoreRun, type Score, type BuildResult, type ScoreInput } from './score.js';
export { parseSysTestResult, type SysTestResult, type SysTestFailure } from './systest.js';

export interface CaseSpec {
  id: string;
  tier: number;
  ignore?: string[];
}

export interface EvaluateInput {
  caseSpec: CaseSpec;
  actualXml: string;
  goldenXml: string;
  build: BuildResult;
  /** Runtime-oracle result (e.g. from parseSysTestResult); omit when the case has no SysTest. */
  systest?: SysTestResult | { passed: boolean | null } | null;
  /**
   * EXTENSION_PREFIX the golden was captured under, to canonicalise away
   * before comparing (docs/AGENT_EVAL_LOOP.md §6.2). Pass
   * `GOLDEN_CAPTURE_PREFIX` for the committed `eval/goldens/` corpus. Defaults
   * to '' (no canonicalisation — legacy literal-string comparison), so
   * existing callers that don't pass one are unaffected.
   */
  goldenPrefix?: string | readonly string[];
  /**
   * EXTENSION_PREFIX the actual artifact was produced under (the CURRENT
   * session's configured prefix — see
   * `resolveRegularObjectPrefixToken()` in src/utils/modelClassifier.ts).
   * Defaults to '' (no canonicalisation), so callers that don't know/care
   * about prefix drift keep the legacy literal-string comparison.
   */
  actualPrefix?: string | readonly string[];
}

export interface EvaluateResult {
  goldenDiff: GoldenDiff;
  score: Score;
  /** Echoed runtime result for the corpus record, when a SysTest was supplied. */
  systest: SysTestResult | { ran: false; passed: null; failures: [] };
}

export async function evaluate(input: EvaluateInput): Promise<EvaluateResult> {
  const { caseSpec, actualXml, goldenXml, build, systest } = input;
  const goldenPrefix = input.goldenPrefix ?? '';
  const actualPrefix = input.actualPrefix ?? '';
  const ignore = caseSpec.ignore ?? [];
  const [expected, actual] = await Promise.all([
    normalizeAotXml(goldenXml, ignore, goldenPrefix),
    normalizeAotXml(actualXml, ignore, actualPrefix),
  ]);
  const goldenDiff = diffNormalized(expected, actual);
  const score = scoreRun({ build, goldenDiff, tier: caseSpec.tier, systest });
  const systestOut = systest && 'ran' in systest
    ? systest
    : { ran: false as const, passed: null, failures: [] as [] };
  return { goldenDiff, score, systest: systestOut };
}

export interface EvaluateMultiInput {
  caseSpec: CaseSpec;
  /** filename → produced XML, e.g. { "MyContract.metadata.xml": "<AxClass>..." } */
  actualArtifacts: Record<string, string>;
  /** filename → golden XML, same keys expected (a missing/extra key shows up in the diff). */
  goldenArtifacts: Record<string, string>;
  build: BuildResult;
  systest?: SysTestResult | { passed: boolean | null } | null;
  /** See EvaluateInput.goldenPrefix. */
  goldenPrefix?: string | readonly string[];
  /** See EvaluateInput.actualPrefix. */
  actualPrefix?: string | readonly string[];
}

/**
 * Multi-artifact variant of `evaluate` for L3/L4 cases that produce several
 * objects (e.g. a SysOperation's Contract + DP + Controller, or a data entity +
 * its security chain). Each artifact's normalized paths are prefixed with
 * `<filename>::` and merged into one combined map, then diffed/scored with the
 * same single-document machinery — a wholly missing or extra artifact shows up
 * as every one of its paths being missing/extra under that prefix.
 */
export async function evaluateMulti(input: EvaluateMultiInput): Promise<EvaluateResult> {
  const { caseSpec, actualArtifacts, goldenArtifacts, build, systest } = input;
  const goldenPrefix = input.goldenPrefix ?? '';
  const actualPrefix = input.actualPrefix ?? '';
  const ignore = caseSpec.ignore ?? [];
  const [expected, actual] = await Promise.all([
    normalizeMultiArtifact(goldenArtifacts, ignore, goldenPrefix),
    normalizeMultiArtifact(actualArtifacts, ignore, actualPrefix),
  ]);
  const goldenDiff = diffNormalized(expected, actual);
  const score = scoreRun({ build, goldenDiff, tier: caseSpec.tier, systest });
  const systestOut = systest && 'ran' in systest
    ? systest
    : { ran: false as const, passed: null, failures: [] as [] };
  return { goldenDiff, score, systest: systestOut };
}
