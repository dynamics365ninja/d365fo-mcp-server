/**
 * Corpus evidence-shape guard (docs/AGENT_EVAL_LOOP.md §5 — "The record is
 * self-contained evidence — the improver agent must be able to act on it
 * without access to the original VM session").
 *
 * Regression: several corpus records (e.g.
 * eval/corpus/runs/2026-07-06T16__L0-enum-basic__cc58c3f.json,
 * eval/corpus/runs/2026-07-07T07__L2-interface-abstract-basic__cb1b73d.json,
 * eval/corpus/runs/2026-07-07T16__L4-ssrs-report-advanced__cb1b73d.json ×2)
 * were classified KNOWLEDGE_GAP purely because `score.bp_clean === 0`, but
 * every entry in `build.bpWarnings` is a literal empty object (`{}`) — the
 * implementer recorded THAT there were N warnings but not their rule/target/
 * message, so no improver session (VM-free by design) can ever confirm what
 * the actual defect was. `eval/corpus/schema.json` allowed this (each item
 * only required `{"type":"object"}`, satisfied by `{}`), so nothing ever
 * flagged the gap.
 *
 * This module is a pure, VM-free shape check: it flags "thin evidence" —
 * array-of-object fields (bpWarnings / errors / systest.failures /
 * golden_diff.changed) whose entries carry zero properties — separately from
 * classification, so a future improver run (or the implementer, before it
 * even writes the record) can catch this class of gap immediately instead of
 * silently losing the evidence, and cluster/report tooling can distinguish
 * "confirmed defect, no fix yet" from "cannot be confirmed at all — needs a
 * fresh VM capture".
 */

/** Where in a corpus record to look for evidence-carrying object arrays. */
const EVIDENCE_ARRAY_FIELDS: ReadonlyArray<{
  path: string;
  get: (record: any) => unknown;
}> = [
  { path: 'build.errors', get: (r) => r?.build?.errors },
  { path: 'build.bpWarnings', get: (r) => r?.build?.bpWarnings },
  { path: 'systest.failures', get: (r) => r?.systest?.failures },
  { path: 'golden_diff.changed', get: (r) => r?.golden_diff?.changed },
];

export interface ThinEvidenceIssue {
  /** e.g. "build.bpWarnings[0]" */
  path: string;
  reason: string;
}

/** True for a plain object with zero own enumerable properties: `{}`. */
function isEmptyObject(v: unknown): v is Record<string, never> {
  return v != null && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0;
}

/**
 * Scan a corpus record's evidence-carrying arrays for entries that are empty
 * placeholder objects. An empty ARRAY (`[]`) is fine — it means "zero
 * warnings/failures/deltas", a real, meaningful result. An empty OBJECT
 * *inside* the array (`{}`) is the defect: "there was one, but we recorded
 * nothing about it".
 */
export function findThinEvidence(record: unknown): ThinEvidenceIssue[] {
  const issues: ThinEvidenceIssue[] = [];
  for (const field of EVIDENCE_ARRAY_FIELDS) {
    const arr = field.get(record);
    if (!Array.isArray(arr)) continue;
    arr.forEach((item, i) => {
      if (isEmptyObject(item)) {
        issues.push({
          path: `${field.path}[${i}]`,
          reason: 'empty object — no rule/message/target/path captured for this entry',
        });
      }
    });
  }
  return issues;
}

/** True when the record has at least one thin-evidence entry. */
export function hasThinEvidence(record: unknown): boolean {
  return findThinEvidence(record).length > 0;
}

/**
 * True when a record's classification cannot be confirmed purely from what
 * it contains — its score implies a real signal fired (bp_clean=0, a
 * golden_diff mismatch, etc.) but the arrays that would explain WHY are
 * either absent or entirely thin-evidence. Distinct from `hasThinEvidence`:
 * a record can carry ONE thin entry alongside other well-formed ones and
 * still be actionable (e.g. golden_diff.changed has real deltas even if one
 * bpWarnings entry is thin) — this checks whether the record is a total loss.
 */
export function isUnconfirmable(record: any): boolean {
  if (!record || typeof record !== 'object') return false;
  const classification = record.classification;
  if (classification === 'PASS' || classification === undefined) return false;

  const score = record.score ?? {};
  const bpFlaggedButThin =
    score.bp_clean === 0 &&
    Array.isArray(record.build?.bpWarnings) &&
    record.build.bpWarnings.length > 0 &&
    record.build.bpWarnings.every(isEmptyObject);
  const goldenFlaggedButThin =
    score.golden_match === 0 &&
    Array.isArray(record.golden_diff?.changed) &&
    record.golden_diff.changed.length > 0 &&
    record.golden_diff.changed.every(isEmptyObject) &&
    (record.golden_diff?.missing?.length ?? 0) === 0 &&
    (record.golden_diff?.extra?.length ?? 0) === 0;

  const noHypothesis =
    (typeof record.root_cause_hypothesis !== 'string' || record.root_cause_hypothesis.trim() === '') &&
    (typeof record.suggested_fix_area !== 'string' || record.suggested_fix_area.trim() === '') &&
    (!Array.isArray(record.evidence_refs) || record.evidence_refs.length === 0);

  return noHypothesis && (bpFlaggedButThin || goldenFlaggedButThin);
}
