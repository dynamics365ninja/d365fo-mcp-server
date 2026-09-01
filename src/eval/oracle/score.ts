/**
 * Scorecard for the eval golden oracle (docs/AGENT_EVAL_LOOP.md §7).
 * Layers cheap→expensive: build (hard gate) → bp_clean → golden_match → systest.
 */

import type { GoldenDiff } from './diff.js';

export interface BuildResult {
  succeeded: boolean;
  /**
   * The BP warnings xppbp actually reported. `undefined` means either that the
   * check was NOT RUN, or that only its COUNT is known (`bpWarningCount`) —
   * neither of which is "ran and found nothing" (see `Score.bp_clean`).
   */
  bpWarnings?: unknown[];
  /**
   * How many warnings xppbp reported, when the findings themselves were not
   * captured. Scoring `bp_clean` needs a number, not a list, so a count is
   * enough for THIS dimension — but only the findings carry a BP code, which is
   * what the improver ranks on. The scorer used to reconcile the two by
   * inflating the count into N empty objects, which produced N findings with no
   * code and silently under-counted every BP defect downstream (#982).
   */
  bpWarningCount?: number;
}

export interface Score {
  build: 0 | 1;
  /**
   * 1 = xppbp ran and reported no warnings, 0 = xppbp ran and reported some,
   * `null` = **xppbp was never run**, so this run carries no BP evidence at all.
   *
   * The three states used to be two: a run with no BP evidence
   * (`bpWarnings === undefined`) scored `bp_clean: 1`, indistinguishable from a
   * genuinely clean run. Older class goldens carry no class-level `///` doc
   * header yet their corpus records claim `bp_clean: 1` — a faithful rerun of
   * the same artifact today scores 0 on `BPXmlDocNoDocumentationComments`. So the
   * dimension mixed "BP-clean" with "BP never checked" and could not be trended
   * (the 2026-07-21 eval sweep, finding #3). `null` makes the unchecked state
   * explicit, and reporting excludes it from the BP pass-rate rather than
   * averaging incomparable records.
   */
  bp_clean: 0 | 1 | null;
  /**
   * 0|1 when a golden was diffed; `null` when the golden dimension was NOT
   * evaluated (case is `golden_pending`, or no `*.metadata.xml` golden exists
   * yet — §6.4). `null` is neither a fabricated pass nor a fail: downstream
   * pass-counting keys on `=== 1`, so a null is correctly excluded from both.
   */
  golden_match: 0 | 1 | null;
  systest: 0 | 1 | null;
  tier_weight: number;
}

export interface ScoreInput {
  build: BuildResult;
  goldenDiff: GoldenDiff;
  tier: number;
  systest?: { passed: boolean | null } | null;
}

/** The number of BP findings this run has evidence of, or undefined when BP was not checked. */
function bpFindingCount(build: BuildResult): number | undefined {
  return build.bpWarnings?.length ?? build.bpWarningCount;
}

export function scoreRun(input: ScoreInput): Score {
  const { build, goldenDiff, tier, systest } = input;
  return {
    build: build.succeeded ? 1 : 0,
    bp_clean: bpFindingCount(build) === undefined ? null : (bpFindingCount(build) === 0 ? 1 : 0),
    golden_match: goldenDiff.matched ? 1 : 0,
    systest: systest == null || systest.passed == null ? null : (systest.passed ? 1 : 0),
    tier_weight: tier,
  };
}
