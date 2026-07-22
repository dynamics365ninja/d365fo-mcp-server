/**
 * Corpus scoreboard (docs/AGENT_EVAL_LOOP.md §7): aggregate run records into
 * per-tier pass-rates and the headline tool-defect rate, tracked over the catalog.
 * Pure + VM-free.
 */

export interface RunForReport {
  case_id: string;
  tier: number;
  classification: string;
  score?: { build?: number; bp_clean?: number | null; golden_match?: number | null; tier_weight?: number };
  /** `bp_checked` is the BP-provenance flag written by the oracle CLI (see `bpState`). */
  build?: { bp_checked?: boolean };
}

/**
 * Which of the three BP states a run is in.
 *
 * `bp_clean` used to have two values where it needed three: a run whose capture
 * never ran xppbp scored 1, indistinguishable from a run that ran it and found
 * nothing. Averaging the two together is meaningless — the number mixes
 * "BP-clean" with "BP never checked" (docs/eval-sweep-findings-2026-07-21.md #3).
 *
 * Going forward the oracle CLI records `build.bp_checked` and `bp_clean: null`,
 * so the state is explicit. For the ~70 records written BEFORE that flag existed
 * there is exactly one thing we can honestly infer: `bp_clean: 0` was only ever
 * reachable from OBSERVED warnings, so a 0 proves the check ran. A legacy 1
 * proves nothing either way — it is marked `unverified` and kept OUT of the
 * pass-rate rather than retro-edited into a value nobody measured.
 */
export type BpState = 'clean' | 'dirty' | 'unverified';

export function bpState(run: RunForReport): BpState {
  const bp = run.score?.bp_clean;
  if (run.build?.bp_checked === true) return bp === 1 ? 'clean' : 'dirty';
  if (bp === 0) return 'dirty';
  return 'unverified';
}

export interface TierStats {
  tier: number;
  count: number;
  pass_at_build: number;
  /** Over BP-VERIFIED runs only; `null` when none of them is verified. */
  pass_at_bp_clean: number | null;
  /** How many runs in this bucket carry usable BP evidence, and how many do not. */
  bp_verified: number;
  bp_unverified: number;
  pass_at_golden: number;
}

export interface Report {
  total: number;
  byTier: TierStats[];
  /** Fraction of runs whose class is an actionable server gap (the headline metric). */
  toolDefectRate: number;
  pass_at_build: number;
  /** Over BP-VERIFIED runs only; `null` when no run carries BP evidence (see `bpState`). */
  pass_at_bp_clean: number | null;
  bp_verified: number;
  bp_unverified: number;
  pass_at_golden: number;
  classificationCounts: Record<string, number>;
}

/** Classes that count as an actionable server gap for the tool-defect rate. */
const ACTIONABLE = new Set(['TOOL_DEFECT', 'KNOWLEDGE_GAP', 'VALIDATOR_GAP']);

function frac(n: number, d: number): number {
  return d === 0 ? 0 : n / d;
}

function passRates(runs: RunForReport[]) {
  const n = runs.length;
  // BP is averaged over VERIFIED runs only — a run with no BP evidence is not
  // comparable with one that was actually checked, so it is counted, not blended.
  const states = runs.map(bpState);
  const verified = states.filter(s => s !== 'unverified').length;
  return {
    pass_at_build: frac(runs.filter(r => r.score?.build === 1).length, n),
    pass_at_bp_clean: verified === 0 ? null : frac(states.filter(s => s === 'clean').length, verified),
    bp_verified: verified,
    bp_unverified: states.length - verified,
    pass_at_golden: frac(runs.filter(r => r.score?.golden_match === 1).length, n),
  };
}

export function buildReport(runs: RunForReport[]): Report {
  const tiers = [...new Set(runs.map(r => r.tier))].sort((a, b) => a - b);
  const byTier: TierStats[] = tiers.map(tier => {
    const subset = runs.filter(r => r.tier === tier);
    return { tier, count: subset.length, ...passRates(subset) };
  });

  const classificationCounts: Record<string, number> = {};
  for (const r of runs) {
    classificationCounts[r.classification] = (classificationCounts[r.classification] ?? 0) + 1;
  }
  const actionable = runs.filter(r => ACTIONABLE.has(r.classification)).length;

  return {
    total: runs.length,
    byTier,
    toolDefectRate: frac(actionable, runs.length),
    ...passRates(runs),
    classificationCounts,
  };
}

function pct(f: number): string {
  return `${Math.round(f * 100)}%`;
}

/** Render the BP dimension, never hiding how much of the bucket was unmeasured. */
function bp(stats: { pass_at_bp_clean: number | null; bp_verified: number; bp_unverified: number }): string {
  const value = stats.pass_at_bp_clean === null ? 'n/a' : pct(stats.pass_at_bp_clean);
  const suffix = stats.bp_unverified > 0
    ? ` [${stats.bp_verified} checked, ${stats.bp_unverified} unverified]`
    : '';
  return `bp=${value}${suffix}`;
}

export function renderReport(r: Report): string {
  if (r.total === 0) return 'No corpus runs to report.';
  const lines: string[] = [
    `# Corpus scoreboard — ${r.total} run(s)`,
    '',
    `overall   build=${pct(r.pass_at_build)}  ${bp(r)}  golden=${pct(r.pass_at_golden)}`,
    `tool-defect rate: ${pct(r.toolDefectRate)} (TOOL_DEFECT/KNOWLEDGE_GAP/VALIDATOR_GAP)`,
    '',
    '## By tier',
  ];
  for (const t of r.byTier) {
    lines.push(`  L${t.tier}  n=${t.count}  build=${pct(t.pass_at_build)}  ${bp(t)}  golden=${pct(t.pass_at_golden)}`);
  }
  if (r.bp_unverified > 0) {
    lines.push(
      '',
      `note: ${r.bp_unverified} run(s) carry no BP evidence (captured before \`build.bp_checked\` existed,`,
      '      or scored with bp_clean: null). They are excluded from the BP pass-rate rather than',
      '      averaged in — "BP-clean" and "BP never checked" are not the same measurement.',
    );
  }
  lines.push('', '## Classifications');
  for (const [cls, n] of Object.entries(r.classificationCounts).sort((a, b) => b[1] - a[1])) {
    lines.push(`  ${cls.padEnd(14)} ${n}`);
  }
  return lines.join('\n');
}
