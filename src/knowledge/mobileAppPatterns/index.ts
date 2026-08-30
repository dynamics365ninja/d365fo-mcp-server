/**
 * Warehouse-app pattern catalog — resolution and rendering.
 * Served through object_patterns(domain="mobile-app"); content in catalog.ts.
 */

import { MOBILE_APP_PATTERN_CATALOG } from './catalog.js';
import type { MobileAppFramework, MobileAppPatternSpec } from './types.js';

/** Case-insensitive, separator-insensitive key. */
function key(s: string): string {
  return s.toLowerCase().replace(/[-_\s]/g, '');
}

/** Resolve a pattern by id or alias — exact (normalized) match only. */
export function resolveMobileAppPattern(nameOrAlias: string): MobileAppPatternSpec | undefined {
  const k = key(nameOrAlias);
  return MOBILE_APP_PATTERN_CATALOG.find(
    p => key(p.id) === k || (p.aliases ?? []).some(a => key(a) === k),
  );
}

export function listMobileAppPatterns(): MobileAppPatternSpec[] {
  return MOBILE_APP_PATTERN_CATALOG;
}

const FRAMEWORK_LABEL: Record<MobileAppFramework, string> = {
  'process-guide': 'ProcessGuide (current)',
  legacy: 'WHSWorkExecuteDisplay (legacy)',
  'app-metadata': 'App step metadata',
  configuration: 'Configuration only',
};

/**
 * The decision that has to be made before any recipe applies. It leads the list
 * view on purpose: the two frameworks build the SAME screens, and picking the
 * wrong one is a rewrite rather than a refactor.
 */
export function renderFrameworkDecision(): string {
  return [
    '📱 Warehouse-app screens are built by ONE OF TWO FRAMEWORKS. Decide first:',
    '',
    '  1. ProcessGuide — current, and what Microsoft extends. One class per responsibility:',
    '     controller (the process) → step (one screen) → page builder (the controls) →',
    '     data processor (the input) → navigation agent (what comes next) → action (a button).',
    '     Extension points are designed in: add a control, replace a page, insert a step.',
    '     No WHS prefix by design — production and inventory flows use it too.',
    '',
    '  2. WHSWorkExecuteDisplay — the original. One subclass per WHSWorkExecuteMode whose',
    '     displayForm() processes input, runs logic, increments the step and builds the next',
    '     screen as a container. Still shipping, still behind many flows.',
    '',
    '  How to tell which one owns the flow you must change: find the class registered for the',
    '  mode (both frameworks are instantiated by SysExtension off [WHSWorkExecuteMode]) and',
    '  look at what it extends — ProcessGuideController, or WHSWorkExecuteDisplay.',
    '  search(query="ProcessGuide", type="class") on the installed version answers whether the',
    '  framework is there at all. NEW flows go to ProcessGuide when it exists.',
    '',
    '  Both share the session pass-through (WhsrfPassthrough) and the same service endpoint,',
    '  so a converted flow keeps its data — that is what makes a per-flow choice possible.',
  ].join('\n');
}

/** One-line-per-pattern overview, led by the framework decision. */
export function renderMobileAppPatternList(): string {
  const lines: string[] = [renderFrameworkDecision(), ''];
  lines.push('Recipes — object_patterns(domain="mobile-app", pattern=<id>) for the full spec:');
  lines.push('');
  for (const p of MOBILE_APP_PATTERN_CATALOG) {
    lines.push(`• ${p.id} [${FRAMEWORK_LABEL[p.framework]}] — ${p.purpose}`);
  }
  lines.push('');
  lines.push(
    'Surrounding rules: get_knowledge(topic="warehouse-mobile-app") for the flow invariants, ' +
    '"process-guide-framework" for the class model, "barcode-scanning" for what a scan carries.',
  );
  return lines.join('\n');
}

/** Full spec of one pattern. */
export function renderMobileAppPatternSpec(spec: MobileAppPatternSpec): string {
  const lines: string[] = [];
  lines.push(`📱 Warehouse-app pattern: ${spec.displayName} (${spec.id})`);
  lines.push(`Framework: ${FRAMEWORK_LABEL[spec.framework]}`);
  lines.push('');
  lines.push(spec.purpose);
  lines.push('');
  lines.push('When to use:');
  for (const w of spec.whenToUse) lines.push(`  • ${w}`);
  if (spec.whenNotToUse?.length) {
    lines.push('When NOT to use:');
    for (const w of spec.whenNotToUse) lines.push(`  • ${w}`);
  }
  if (spec.objects.length) {
    lines.push('');
    lines.push('Objects:');
    for (const o of spec.objects) {
      lines.push(`  • ${o.role}: ${o.naming} — ${o.baseOrType}`);
      if (o.notes) lines.push(`      ${o.notes}`);
    }
  }
  for (const s of spec.skeletons ?? []) {
    lines.push('');
    lines.push(`X++ — ${s.label}:`);
    lines.push('```xpp');
    lines.push(s.code);
    lines.push('```');
  }
  lines.push('');
  lines.push('Implementation notes:');
  for (const m of spec.methodNotes) lines.push(`  • ${m}`);
  lines.push('');
  lines.push('Verify:');
  for (const c of spec.crossChecks) lines.push(`  • ${c}`);
  if (spec.referenceElements?.length) {
    lines.push('');
    lines.push(`Standard examples to read first: ${spec.referenceElements.join(', ')} (get_object_info)`);
  }
  if (spec.relatedTopics?.length) {
    lines.push(`Related knowledge: ${spec.relatedTopics.map(t => `"${t}"`).join(', ')} (get_knowledge)`);
  }
  return lines.join('\n');
}
