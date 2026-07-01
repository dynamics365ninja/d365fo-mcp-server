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

export { normalizeAotXml, normalizeMultiArtifact, renderNormalized, globToRegExp } from './normalize.js';
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
}

export interface EvaluateResult {
  goldenDiff: GoldenDiff;
  score: Score;
  /** Echoed runtime result for the corpus record, when a SysTest was supplied. */
  systest: SysTestResult | { ran: false; passed: null; failures: [] };
}

export async function evaluate(input: EvaluateInput): Promise<EvaluateResult> {
  const { caseSpec, actualXml, goldenXml, build, systest } = input;
  const ignore = caseSpec.ignore ?? [];
  const [expected, actual] = await Promise.all([
    normalizeAotXml(goldenXml, ignore),
    normalizeAotXml(actualXml, ignore),
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
  const ignore = caseSpec.ignore ?? [];
  const [expected, actual] = await Promise.all([
    normalizeMultiArtifact(goldenArtifacts, ignore),
    normalizeMultiArtifact(actualArtifacts, ignore),
  ]);
  const goldenDiff = diffNormalized(expected, actual);
  const score = scoreRun({ build, goldenDiff, tier: caseSpec.tier, systest });
  const systestOut = systest && 'ran' in systest
    ? systest
    : { ran: false as const, passed: null, failures: [] as [] };
  return { goldenDiff, score, systest: systestOut };
}
