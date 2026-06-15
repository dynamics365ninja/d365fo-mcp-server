/**
 * get_form_pattern_spec — expose the curated form-pattern catalog to AI
 * clients: structure tree (required containers, ordering, allowed
 * sub-patterns), when to use, reference forms, lifecycle guidance.
 */

import { z } from 'zod';
import {
  FORM_PATTERN_CATALOG,
  resolvePattern,
  resolveSubPattern,
  type NodeSpec,
  type FormPatternSpec,
  type SubPatternSpec,
} from '../knowledge/formPatterns/index.js';
import { hasMinedPatternData } from '../knowledge/formPatterns/crossCheck.js';
import { methodStubsForPattern } from '../knowledge/formPatterns/methodStubs.js';

export const getFormPatternSpecArgsSchema = z.object({
  pattern: z.string().describe(
    'Pattern name (id, xmlName, or alias) — e.g. "SimpleList", "DetailsMaster", "Dialog", ' +
    'or a sub-pattern like "FieldsFieldGroups". Aliases like "master", "transaction" work too.'
  ),
});

// Tool registration (name, description, inputSchema) lives inline in
// src/server/mcpServer.ts - the single source of truth for tool instructions.

function occurrenceLabel(occ: NodeSpec['occurrence']): string {
  switch (occ) {
    case 'required': return 'required';
    case 'optional': return 'optional';
    case 'oneOrMore': return '1..n required';
    case 'zeroOrMore': return '0..n';
  }
}

function renderNode(node: NodeSpec, indent: string, lines: string[]): void {
  const types = node.controlTypes.join('|');
  const parts = [`${indent}${types} "${node.id}" (${occurrenceLabel(node.occurrence)})`];
  if (node.nameHint) parts.push(`name≈${node.nameHint}`);
  if (node.properties) {
    parts.push(Object.entries(node.properties).map(([k, v]) => `${k}=${v}`).join(' '));
  }
  if (node.requiresSubPattern) {
    parts.push(
      node.allowedSubPatterns?.length
        ? `sub-pattern: ${node.allowedSubPatterns.join('/')}`
        : 'sub-pattern required',
    );
  }
  if (node.extraChildren === 'none') parts.push('[no extra children]');
  else if (Array.isArray(node.extraChildren)) parts.push(`[extras: ${node.extraChildren.join(', ')}]`);
  lines.push(parts.join('  — '));
  for (const child of node.children ?? []) renderNode(child, indent + '  ', lines);
}

function renderTopLevel(spec: FormPatternSpec, db: any): string {
  const lines: string[] = [];
  lines.push(`# Form Pattern: ${spec.displayName}`);
  lines.push('');
  lines.push(`**xmlName:** \`${spec.xmlName}\`   **Versions:** ${spec.versions.join(', ')} (current: ${spec.versions[0]})`);
  if (spec.variantOf) lines.push(`**Variant of:** ${spec.variantOf}`);
  lines.push('');
  lines.push(spec.purpose);
  lines.push('');
  lines.push('## When to use');
  for (const w of spec.whenToUse) lines.push(`- ${w}`);
  if (spec.whenNotToUse?.length) {
    lines.push('');
    lines.push('## When NOT to use');
    for (const w of spec.whenNotToUse) lines.push(`- ${w}`);
  }

  lines.push('');
  lines.push('## Structure (required order under Design)');
  lines.push('```');
  for (const node of spec.root) renderNode(node, '', lines);
  if (spec.extraRootChildren === 'none') lines.push('(no other root controls allowed)');
  else if (Array.isArray(spec.extraRootChildren)) lines.push(`(extra root controls allowed: ${spec.extraRootChildren.join(', ')})`);
  else lines.push('(additional root controls tolerated)');
  lines.push('```');

  if (spec.designProperties) {
    lines.push('');
    lines.push('**Design properties:** ' + Object.entries(spec.designProperties).map(([k, v]) => `${k}="${v}"`).join(', '));
  }
  if (spec.requiresDataSource && spec.requiresDataSource !== 'none') {
    lines.push(
      `**Datasources:** ${spec.requiresDataSource === 'headerLines'
        ? 'header + lines (≥2, linked via JoinSource)'
        : 'at least one primary datasource'}`,
    );
  }

  lines.push('');
  lines.push(`**Reference forms (clone these):** ${spec.referenceForms.map((f) => `\`${f}\``).join(', ')}`);
  try {
    if (db && hasMinedPatternData(db)) {
      const mined = db.prepare(`
        SELECT form_name FROM form_patterns
        WHERE node_path = 'Design' AND pattern = ? ORDER BY form_name LIMIT 8
      `).all(spec.xmlName) as Array<{ form_name: string }>;
      if (mined.length > 0) {
        lines.push(`**Mined usage in this environment:** ${mined.map((m) => `\`${m.form_name}\``).join(', ')}`);
      }
    }
  } catch { /* older index */ }

  if (spec.lifecycleGuidance?.length) {
    lines.push('');
    lines.push('## Lifecycle methods');
    for (const g of spec.lifecycleGuidance) lines.push(`- ${g}`);
    const stubs = methodStubsForPattern(spec.id, '<PrimaryDS>');
    const stubNames = [
      ...stubs.formMethods.map((s) => s.name),
      ...stubs.dataSourceMethods.map((s) => `<PrimaryDS>.${s.name}`),
    ];
    if (stubNames.length > 0) {
      lines.push(`- \`generate_object(mode="scaffold", objectType="form", includeMethodStubs=true)\` injects: ${stubNames.join(', ')}`);
    }
  }

  if (spec.notes?.length) {
    lines.push('');
    lines.push('## Notes');
    for (const n of spec.notes) lines.push(`- ${n}`);
  }

  lines.push('');
  lines.push('## Workflow');
  lines.push(`1. \`generate_object(mode="scaffold", objectType="form", name=..., cloneFrom="${spec.referenceForms[0]}", tableMapping={...}, includeMethodStubs=true)\``);
  lines.push('2. `object_patterns(domain="form", action="validate", xml=...)` — fix any FP errors');
  lines.push('3. `d365fo_file(action="create", objectType="form", ...)` — structural errors block while FORM_PATTERN_ENFORCE=true');
  return lines.join('\n');
}

function renderSubPattern(sp: SubPatternSpec): string {
  const lines: string[] = [];
  lines.push(`# Container Sub-Pattern: ${sp.displayName}`);
  lines.push('');
  lines.push(`**xmlName:** \`${sp.xmlName}\`   **Versions:** ${sp.versions.join(', ')}`);
  lines.push(`**Applies to container types:** ${sp.appliesToControlTypes.join(', ')}`);
  if (sp.parentPatterns?.length) lines.push(`**Only inside patterns:** ${sp.parentPatterns.join(', ')}`);
  lines.push('');
  lines.push(sp.purpose);
  lines.push('');
  lines.push('## Structure (inside the container)');
  lines.push('```');
  for (const node of sp.root) renderNode(node, '', lines);
  if (sp.extraRootChildren === 'none') lines.push('(no other children allowed)');
  else if (Array.isArray(sp.extraRootChildren)) lines.push(`(allowed children: ${sp.extraRootChildren.join(', ')})`);
  else lines.push('(additional children tolerated)');
  lines.push('```');
  if (sp.referenceForms?.length) {
    lines.push('');
    lines.push(`**Reference usage:** ${sp.referenceForms.map((f) => `\`${f}\``).join(', ')}`);
  }
  if (sp.notes?.length) {
    lines.push('');
    for (const n of sp.notes) lines.push(`- ${n}`);
  }
  return lines.join('\n');
}

export async function getFormPatternSpecTool(
  request: any,
  context?: { symbolIndex?: any },
): Promise<any> {
  const raw = request?.params?.arguments ?? request;
  const parsed = getFormPatternSpecArgsSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      isError: true,
      content: [{ type: 'text', text: `❌ Invalid parameters: ${parsed.error.message}` }],
    };
  }

  const name = parsed.data.pattern;
  const db = context?.symbolIndex?.getReadDb?.();

  const spec = resolvePattern(name);
  if (spec) {
    return { content: [{ type: 'text', text: renderTopLevel(spec, db) }] };
  }

  const sub = resolveSubPattern(name);
  if (sub) {
    return { content: [{ type: 'text', text: renderSubPattern(sub) }] };
  }

  const allNames = [
    ...FORM_PATTERN_CATALOG.patterns.map((p) => p.xmlName),
    ...FORM_PATTERN_CATALOG.subPatterns.map((p) => p.xmlName),
  ];
  return {
    isError: true,
    content: [{
      type: 'text',
      text: `❌ Unknown pattern "${name}".\n\nKnown patterns and sub-patterns:\n${allNames.map((n) => `  - ${n}`).join('\n')}`,
    }],
  };
}
