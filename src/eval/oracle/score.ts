/**
 * Scorecard for the eval golden oracle (docs/AGENT_EVAL_LOOP.md §7).
 * Layers cheap→expensive: build (hard gate) → bp_clean → golden_match → systest.
 */

import type { GoldenDiff } from './diff.js';

export interface BuildResult {
  succeeded: boolean;
  bpWarnings?: unknown[];
}

export interface Score {
  build: 0 | 1;
  bp_clean: 0 | 1;
  golden_match: 0 | 1;
  systest: 0 | 1 | null;
  tier_weight: number;
}

export interface ScoreInput {
  build: BuildResult;
  goldenDiff: GoldenDiff;
  tier: number;
  systest?: { passed: boolean | null } | null;
}

export function scoreRun(input: ScoreInput): Score {
  const { build, goldenDiff, tier, systest } = input;
  return {
    build: build.succeeded ? 1 : 0,
    bp_clean: (build.bpWarnings?.length ?? 0) === 0 ? 1 : 0,
    golden_match: goldenDiff.matched ? 1 : 0,
    systest: systest == null || systest.passed == null ? null : (systest.passed ? 1 : 0),
    tier_weight: tier,
  };
}
