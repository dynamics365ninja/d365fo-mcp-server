/**
 * Structural diff for the eval golden oracle. Compares two normalized
 * `path → value` maps (see normalize.ts) and classifies each delta as
 * missing / extra / changed, mirroring eval/corpus/schema.json `golden_diff`.
 */

export interface GoldenDiff {
  matched: boolean;
  /** Paths present in the golden but absent from the actual. */
  missing: string[];
  /** Paths present in the actual but absent from the golden. */
  extra: string[];
  /** Paths present in both with differing values. */
  changed: Array<{ path: string; expected: string; actual: string }>;
}

/**
 * Diff a normalized actual against a normalized golden (expected).
 * `expected` = the golden; `actual` = what the run produced.
 */
export function diffNormalized(
  expected: Map<string, string>,
  actual: Map<string, string>,
): GoldenDiff {
  const missing: string[] = [];
  const changed: GoldenDiff['changed'] = [];
  const extra: string[] = [];

  for (const [path, expVal] of expected) {
    if (!actual.has(path)) {
      missing.push(path);
    } else {
      const actVal = actual.get(path)!;
      if (actVal !== expVal) changed.push({ path, expected: expVal, actual: actVal });
    }
  }
  for (const path of actual.keys()) {
    if (!expected.has(path)) extra.push(path);
  }

  missing.sort();
  extra.sort();
  changed.sort((a, b) => a.path.localeCompare(b.path));

  return {
    matched: missing.length === 0 && extra.length === 0 && changed.length === 0,
    missing,
    extra,
    changed,
  };
}

/** Render a GoldenDiff as a short human-readable report. */
export function renderDiff(d: GoldenDiff): string {
  if (d.matched) return '✅ golden match — no structural deltas.';
  const lines: string[] = [`❌ golden mismatch — ${d.missing.length} missing, ${d.extra.length} extra, ${d.changed.length} changed.`];
  for (const p of d.missing) lines.push(`  − missing: ${p}`);
  for (const p of d.extra) lines.push(`  + extra:   ${p}`);
  for (const c of d.changed) lines.push(`  ~ changed: ${c.path}  (golden="${c.expected}" actual="${c.actual}")`);
  return lines.join('\n');
}
