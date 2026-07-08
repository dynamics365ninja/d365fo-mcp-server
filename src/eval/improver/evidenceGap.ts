/**
 * Evidence-gap report (docs/AGENT_EVAL_LOOP.md §5, §9) — pure logic, VM-free.
 *
 * This is the actionable handoff for the gap fixed by
 * src/eval/improver/corpusShapeGuard.ts: a record can score `bp_clean=0` /
 * `golden_match=0` yet carry zero diagnostic detail (`build.bpWarnings`
 * populated with empty `{}` placeholders instead of `{rule, target,
 * message}`). Such a record cannot be triaged by a VM-free improver session
 * — it needs a fresh eval-implementer run that captures full detail.
 */

import { findThinEvidence, isUnconfirmable, type ThinEvidenceIssue } from './corpusShapeGuard.js';

export interface CorpusRunLike {
  run_id: string;
  case_id: string;
  classification: string;
  [key: string]: unknown;
}

export interface EvidenceGapReportEntry {
  run_id: string;
  case_id: string;
  classification: string;
  unconfirmable: boolean;
  issues: ThinEvidenceIssue[];
}

export function buildEvidenceGapReport(runs: CorpusRunLike[]): EvidenceGapReportEntry[] {
  const out: EvidenceGapReportEntry[] = [];
  for (const r of runs) {
    const issues = findThinEvidence(r);
    if (issues.length === 0) continue;
    out.push({
      run_id: r.run_id,
      case_id: r.case_id,
      classification: r.classification,
      unconfirmable: isUnconfirmable(r),
      issues,
    });
  }
  // Unconfirmable-first (needs a VM re-run to unblock at all), then by case_id.
  return out.sort((a, b) =>
    Number(b.unconfirmable) - Number(a.unconfirmable) || a.case_id.localeCompare(b.case_id));
}

export function renderEvidenceGapReport(entries: EvidenceGapReportEntry[]): string {
  if (entries.length === 0) return 'No thin-evidence corpus records — every non-PASS run carries confirmable detail. 🎉';
  const lines: string[] = [`# Corpus evidence gaps (${entries.length} run(s))\n`];
  const unconfirmable = entries.filter(e => e.unconfirmable);
  if (unconfirmable.length > 0) {
    lines.push(
      `${unconfirmable.length} run(s) are UNCONFIRMABLE — classified non-PASS with zero recoverable ` +
      `diagnostic detail (no root_cause_hypothesis/suggested_fix_area/evidence_refs, and every relevant ` +
      `evidence array is empty-placeholder-only). These need a fresh eval-implementer VM run for the same ` +
      `case that captures full bpWarnings/golden_diff detail before an improver session can act on them.\n`,
    );
  }
  for (const e of entries) {
    lines.push(`${e.unconfirmable ? '[UNCONFIRMABLE]' : '[partial]'} ${e.case_id} — ${e.classification}`);
    lines.push(`   run: ${e.run_id}`);
    for (const issue of e.issues) lines.push(`   - ${issue.path}: ${issue.reason}`);
  }
  return lines.join('\n');
}
