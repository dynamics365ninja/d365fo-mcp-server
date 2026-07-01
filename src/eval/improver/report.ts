/**
 * Corpus scoreboard (docs/AGENT_EVAL_LOOP.md §7): aggregate run records into
 * per-tier pass-rates and the headline tool-defect rate, tracked over the catalog.
 * Pure + VM-free.
 */

export interface RunForReport {
  case_id: string;
  tier: number;
  classification: string;
  score?: { build?: number; bp_clean?: number; golden_match?: number; tier_weight?: number };
}

export interface TierStats {
  tier: number;
  count: number;
  pass_at_build: number;
  pass_at_bp_clean: number;
  pass_at_golden: number;
}

export interface Report {
  total: number;
  byTier: TierStats[];
  /** Fraction of runs whose class is an actionable server gap (the headline metric). */
  toolDefectRate: number;
  pass_at_build: number;
  pass_at_bp_clean: number;
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
  return {
    pass_at_build: frac(runs.filter(r => r.score?.build === 1).length, n),
    pass_at_bp_clean: frac(runs.filter(r => r.score?.bp_clean === 1).length, n),
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

export function renderReport(r: Report): string {
  if (r.total === 0) return 'No corpus runs to report.';
  const lines: string[] = [
    `# Corpus scoreboard — ${r.total} run(s)`,
    '',
    `overall   build=${pct(r.pass_at_build)}  bp=${pct(r.pass_at_bp_clean)}  golden=${pct(r.pass_at_golden)}`,
    `tool-defect rate: ${pct(r.toolDefectRate)} (TOOL_DEFECT/KNOWLEDGE_GAP/VALIDATOR_GAP)`,
    '',
    '## By tier',
  ];
  for (const t of r.byTier) {
    lines.push(`  L${t.tier}  n=${t.count}  build=${pct(t.pass_at_build)}  bp=${pct(t.pass_at_bp_clean)}  golden=${pct(t.pass_at_golden)}`);
  }
  lines.push('', '## Classifications');
  for (const [cls, n] of Object.entries(r.classificationCounts).sort((a, b) => b[1] - a[1])) {
    lines.push(`  ${cls.padEnd(14)} ${n}`);
  }
  return lines.join('\n');
}
