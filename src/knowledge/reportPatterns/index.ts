/**
 * Report-pattern catalog — resolution and rendering.
 * Served through object_patterns(domain="report"); see catalog.ts for content.
 */

import { REPORT_PATTERN_CATALOG } from './catalog.js';
import type { ReportPatternSpec } from './types.js';

/** Case-insensitive, separator-insensitive key. */
function key(s: string): string {
  return s.toLowerCase().replace(/[-_\s]/g, '');
}

/** Resolve a pattern by id or alias — exact (normalized) match only. */
export function resolveReportPattern(nameOrAlias: string): ReportPatternSpec | undefined {
  const k = key(nameOrAlias);
  return REPORT_PATTERN_CATALOG.find(
    p => key(p.id) === k || (p.aliases ?? []).some(a => key(a) === k),
  );
}

export function listReportPatterns(): ReportPatternSpec[] {
  return REPORT_PATTERN_CATALOG;
}

/** One-line-per-pattern overview. */
export function renderReportPatternList(): string {
  const lines: string[] = [
    '📊 SSRS report patterns — implementation recipes. object_patterns(domain="report", pattern=<id>) for the full spec.',
    '',
  ];
  for (const p of REPORT_PATTERN_CATALOG) {
    lines.push(`• ${p.id} — ${p.purpose}`);
  }
  lines.push('');
  lines.push('Deeper rules: get_knowledge(topic="ssrs-reports"); generation: generate_object(mode="scaffold", objectType="report", …).');
  return lines.join('\n');
}

/** Full spec of one pattern. */
export function renderReportPatternSpec(spec: ReportPatternSpec): string {
  const lines: string[] = [];
  lines.push(`📊 Report pattern: ${spec.displayName} (${spec.id})`);
  lines.push('');
  lines.push(spec.purpose);
  lines.push('');
  lines.push('When to use:');
  for (const w of spec.whenToUse) lines.push(`  • ${w}`);
  if (spec.whenNotToUse?.length) {
    lines.push('When NOT to use:');
    for (const w of spec.whenNotToUse) lines.push(`  • ${w}`);
  }
  lines.push('');
  lines.push('Objects:');
  for (const o of spec.objects) {
    lines.push(`  • ${o.role}: ${o.naming} — ${o.baseOrType}`);
    if (o.notes) lines.push(`      ${o.notes}`);
  }
  lines.push('');
  lines.push('Scaffold (one call creates the full roster):');
  lines.push(`  ${spec.scaffold}`);
  lines.push('');
  lines.push('Method guidance:');
  for (const m of spec.methodNotes) lines.push(`  • ${m}`);
  lines.push('');
  lines.push('Verify:');
  for (const c of spec.crossChecks) lines.push(`  • ${c}`);
  if (spec.referenceReports?.length) {
    lines.push('');
    lines.push(`Standard examples: ${spec.referenceReports.join(', ')} (get_object_info(objectType="report", name=…))`);
  }
  if (spec.relatedTopics?.length) {
    lines.push(`Related knowledge: ${spec.relatedTopics.map(t => `"${t}"`).join(', ')} (get_knowledge)`);
  }
  return lines.join('\n');
}
