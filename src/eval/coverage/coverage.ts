/**
 * Coverage computation — derive the K/E/T matrix from reality,
 * not by hand.
 *
 * Inputs are the live sources: KNOWLEDGE_BASE entry ids, the eval case
 * catalog, and the set of object types the tool path can actually create.
 * A taxonomy leaf's flags are therefore only as green as the repo really is —
 * deleting a case or renaming a knowledge entry turns a leaf red instead of
 * quietly leaving a stale table behind.
 *
 * The module is pure so it runs in CI with no VM and no symbol index.
 */

import type { CoverageLeaf, CoverageTier } from './taxonomy.js';

export interface EvalCaseSummary {
  id: string;
  tags: string[];
  /** Cases whose golden has not been captured yet do not prove anything. */
  goldenPending: boolean;
}

export interface CoverageInputs {
  /** Every KNOWLEDGE_BASE entry id present in the shipped build. */
  knowledgeIds: Set<string>;
  /** Every eval case in eval/cases. */
  cases: EvalCaseSummary[];
  /** Object types the tool path can create (d365fo_file / generate_object). */
  toolTypes: Set<string>;
}

export interface LeafCoverage {
  leaf: CoverageLeaf;
  k: boolean;
  e: boolean;
  t: boolean;
  covered: boolean;
  /** Case ids that actually matched (evidence for E). */
  matchedCases: string[];
  /** Knowledge ids declared by the leaf that do not exist (spec rot). */
  danglingKnowledge: string[];
  /** Case ids declared by the leaf that do not exist (spec rot). */
  danglingCases: string[];
}

export interface CoverageOrphans {
  /** Knowledge entries no taxonomy leaf claims — unproven knowledge. */
  knowledge: string[];
  /** Eval cases no taxonomy leaf claims — unmapped proof. */
  cases: string[];
}

export interface TierSummary {
  tier: CoverageTier | 'all';
  total: number;
  covered: number;
  percent: number;
}

export interface CoverageReport {
  leaves: LeafCoverage[];
  orphans: CoverageOrphans;
  core: TierSummary;
  total: TierSummary;
  /** Uncovered leaves ordered by weight — the P7 closure queue. */
  queue: LeafCoverage[];
}

function summarise(tier: CoverageTier | 'all', leaves: LeafCoverage[]): TierSummary {
  const covered = leaves.filter(l => l.covered).length;
  return {
    tier,
    total: leaves.length,
    covered,
    percent: leaves.length === 0 ? 0 : Math.round((covered / leaves.length) * 1000) / 10,
  };
}

export function computeCoverage(taxonomy: CoverageLeaf[], inputs: CoverageInputs): CoverageReport {
  const caseById = new Map(inputs.cases.map(c => [c.id, c]));
  const claimedKnowledge = new Set<string>();
  const claimedCases = new Set<string>();

  const leaves: LeafCoverage[] = taxonomy.map(leaf => {
    const declaredKnowledge = leaf.knowledgeIds ?? [];
    const danglingKnowledge = declaredKnowledge.filter(id => !inputs.knowledgeIds.has(id));
    for (const id of declaredKnowledge) claimedKnowledge.add(id);

    const declaredCases = leaf.caseIds ?? [];
    const danglingCases = declaredCases.filter(id => !caseById.has(id));

    // A case proves the leaf only once its golden exists — a golden_pending
    // case is an authored intention, not evidence.
    const byId = declaredCases.filter(id => caseById.get(id)?.goldenPending === false);
    const byTag = leaf.caseTags?.length
      ? inputs.cases
          .filter(c => !c.goldenPending && leaf.caseTags!.every(t => c.tags.includes(t)))
          .map(c => c.id)
      : [];
    const matchedCases = [...new Set([...byId, ...byTag])].sort();
    for (const id of [...declaredCases, ...byTag]) claimedCases.add(id);

    const k = declaredKnowledge.some(id => inputs.knowledgeIds.has(id));
    const e = matchedCases.length > 0;
    const t = (leaf.aotTypes ?? []).some(type => inputs.toolTypes.has(type));

    return { leaf, k, e, t, covered: k && e && t, matchedCases, danglingKnowledge, danglingCases };
  });

  const orphans: CoverageOrphans = {
    knowledge: [...inputs.knowledgeIds].filter(id => !claimedKnowledge.has(id)).sort(),
    cases: inputs.cases.map(c => c.id).filter(id => !claimedCases.has(id)).sort(),
  };

  const queue = leaves
    .filter(l => !l.covered)
    .sort((a, b) => b.leaf.weight - a.leaf.weight || a.leaf.id.localeCompare(b.leaf.id));

  return {
    leaves,
    orphans,
    core: summarise('core', leaves.filter(l => l.leaf.tier === 'core')),
    total: summarise('all', leaves),
    queue,
  };
}

// ─── Rendering ──────────────────────────────────────────────────────────────

const flag = (on: boolean) => (on ? '✅' : '—');

export function renderMarkdown(report: CoverageReport, generatedAt: string): string {
  const out: string[] = [];
  out.push('# Coverage — what "100%" means');
  out.push('');
  out.push('<!-- GENERATED FILE — edit src/eval/coverage/taxonomy.ts, then run `npm run eval:coverage`. -->');
  out.push('');
  out.push(
    'A taxonomy leaf counts as covered only when all three hold: **K** a knowledge entry ' +
    'teaches it · **E** an eval case with a captured golden proves it · **T** the tool path ' +
    'can create/validate the artifact. Flags are derived from the live sources ' +
    '(`KNOWLEDGE_BASE`, `eval/cases`, the create/scaffold registry), so a deleted case or a ' +
    'renamed entry drops the number.',
  );
  out.push('');
  out.push(
    '**core** = anything done at least once per project — the hard commitment. ' +
    '**total** = core plus exotics (license codes, XDS, aggregate measurements), a visible ' +
    'asymptote rather than a target.',
  );
  out.push('');
  out.push(`| Tier | Covered | Leaves | % |`);
  out.push(`| --- | ---: | ---: | ---: |`);
  out.push(`| core | ${report.core.covered} | ${report.core.total} | **${report.core.percent}%** |`);
  out.push(`| total | ${report.total.covered} | ${report.total.total} | ${report.total.percent}% |`);
  out.push('');

  const domains = [...new Set(report.leaves.map(l => l.leaf.domain))];
  for (const domain of domains) {
    const rows = report.leaves.filter(l => l.leaf.domain === domain);
    const cov = rows.filter(r => r.covered).length;
    out.push(`## ${domain} (${cov}/${rows.length})`);
    out.push('');
    out.push('| Leaf | Tier | K | E | T | Evidence / gap |');
    out.push('| --- | --- | :-: | :-: | :-: | --- |');
    for (const r of rows) {
      const evidence = r.covered
        ? r.matchedCases.slice(0, 3).join(', ') + (r.matchedCases.length > 3 ? ` +${r.matchedCases.length - 3}` : '')
        : r.leaf.note ?? missingLabel(r);
      out.push(`| ${r.leaf.label} | ${r.leaf.tier} | ${flag(r.k)} | ${flag(r.e)} | ${flag(r.t)} | ${evidence} |`);
    }
    out.push('');
  }

  out.push('## Closure queue (uncovered, by frequency weight)');
  out.push('');
  if (report.queue.length === 0) {
    out.push('Nothing uncovered.');
  } else {
    out.push('| Weight | Leaf | Missing |');
    out.push('| ---: | --- | --- |');
    for (const r of report.queue) {
      out.push(`| ${r.leaf.weight} | ${r.leaf.label} | ${missingLabel(r)} |`);
    }
  }
  out.push('');

  out.push('## Orphans');
  out.push('');
  out.push(
    `- Knowledge entries no leaf claims (**unproven knowledge**): ${
      report.orphans.knowledge.length ? report.orphans.knowledge.join(', ') : 'none'}`,
  );
  out.push(
    `- Eval cases no leaf claims (**unmapped proof**): ${
      report.orphans.cases.length ? report.orphans.cases.join(', ') : 'none'}`,
  );
  out.push('');
  out.push(`_Generated ${generatedAt}._`);
  out.push('');
  return out.join('\n');
}

function missingLabel(r: LeafCoverage): string {
  const missing = [!r.k && 'K', !r.e && 'E', !r.t && 'T'].filter(Boolean);
  return missing.length ? `missing ${missing.join('+')}` : '—';
}

/** Spec rot: a leaf pointing at a knowledge entry or case that no longer exists. */
export function danglingReferences(report: CoverageReport): string[] {
  return report.leaves.flatMap(l => [
    ...l.danglingKnowledge.map(id => `${l.leaf.id}: knowledge "${id}" does not exist`),
    ...l.danglingCases.map(id => `${l.leaf.id}: eval case "${id}" does not exist`),
  ]);
}
