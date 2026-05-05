/**
 * Bridge Adapter — Converts C# bridge responses into the markdown format
 * expected by MCP tool handlers.
 *
 * Each function returns a pre-formatted MCP tool result (content array)
 * or null if the bridge couldn't provide the data.
 *
 * Usage pattern inside a tool handler:
 *   const bridgeResult = await tryBridgeTable(context.bridge, tableName, methodOffset);
 *   if (bridgeResult) return bridgeResult;
 *   // ... fallback to SQLite/parser ...
 */

import type { BridgeClient } from './bridgeClient.js';
import * as debouncedRefresh from './debouncedRefresh.js';
import type {
  BridgeTableInfo,
  BridgeClassInfo,
  BridgeQueryInfo,
  BridgeQueryDataSource,
  BridgeViewInfo,
  BridgeDataEntityInfo,
  BridgeReportInfo,
  BridgeEdtInfo,
  BridgeFormInfo,
  BridgeFormControl,
  BridgeSecurityPrivilegeResult,
  BridgeSecurityDutyResult,
  BridgeSecurityRoleResult,
  BridgeMenuItemResult,
  BridgeTableExtensionListResult,
  BridgeCompletionResult,
  BridgeExtensionClassResult,
  BridgeEventSubscriberResult,
  BridgeSmartTableResult,
  BridgeApiUsageCallersResult,
} from './bridgeTypes.js';

/** Standard MCP tool response shape */
export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

// ════════════════════════════════════════════════════════════════════════
// TABLE
// ════════════════════════════════════════════════════════════════════════

const TABLE_METHOD_PAGE_SIZE = 25;

export async function tryBridgeTable(
  bridge: BridgeClient | undefined,
  tableName: string,
  methodOffset = 0,
): Promise<ToolResult | null> {
  if (!bridge?.isReady || !bridge.metadataAvailable) return null;
  try {
    const t = await bridge.readTable(tableName);
    if (!t) return null;
    return { content: [{ type: 'text', text: formatTable(t, methodOffset) }] };
  } catch (e) {
    console.error(`[BridgeAdapter] readTable(${tableName}) failed: ${e}`);
    return null;
  }
}

function formatTable(t: BridgeTableInfo, methodOffset: number): string {
  let out = `# Table: ${t.name}\n\n`;
  if (t.label) out += `**Label:** ${t.label}\n`;
  if (t.tableGroup) out += `**Table Group:** ${t.tableGroup}\n`;
  if (t.model) out += `**Model:** ${t.model}\n`;
  if (t.extends) out += `**Extends:** ${t.extends}\n`;
  if (t.cacheLookup) out += `**CacheLookup:** ${t.cacheLookup}\n`;
  if (t.clusteredIndex) out += `**ClusteredIndex:** ${t.clusteredIndex}\n`;
  if (t.primaryIndex) out += `**PrimaryIndex:** ${t.primaryIndex}\n`;
  out += `_Source: C# bridge (IMetadataProvider)_\n\n`;

  // Fields
  out += `## Fields (${t.fields.length})\n\n`;
  out += `_Field type is shown as explicit EDT when available._\n\n`;
  for (const f of t.fields) {
    const required = f.mandatory ? ' **(required)**' : '';
    const label = f.label ? ` - ${f.label}` : '';
    const typeInfo = f.extendedDataType
      ? `EDT: ${f.extendedDataType} (base: ${f.fieldType})`
      : `Type: ${f.fieldType}`;
    out += `- **${f.name}**: ${typeInfo}${required}${label}\n`;
  }

  // Indexes
  out += `\n## Indexes (${t.indexes.length})\n\n`;
  for (const idx of t.indexes) {
    const unique = !idx.allowDuplicates ? ' **(unique)**' : '';
    const fieldNames = idx.fields.map((f: any) => typeof f === 'string' ? f : f.dataField ?? f.name).join(', ');
    out += `- **${idx.name}**: [${fieldNames}]${unique}\n`;
  }

  // Relations
  out += `\n## Relations (${t.relations.length})\n\n`;
  for (const rel of t.relations) {
    out += `- **${rel.name}** → ${rel.relatedTable}\n`;
    for (const c of rel.constraints) {
      if (c.field && c.relatedField) {
        out += `  - ${c.field} = ${c.relatedField}\n`;
      } else if (c.field && c.value) {
        out += `  - ${c.field} = (fixed: ${c.value})\n`;
      }
    }
  }

  // Methods (paginated)
  if (t.methods.length > 0) {
    const visible = t.methods.slice(methodOffset, methodOffset + TABLE_METHOD_PAGE_SIZE);
    const total = t.methods.length;
    const hasMore = methodOffset + TABLE_METHOD_PAGE_SIZE < total;

    out += `\n## Methods (${total} total`;
    if (total > TABLE_METHOD_PAGE_SIZE) {
      out += `, showing ${methodOffset + 1}–${Math.min(methodOffset + TABLE_METHOD_PAGE_SIZE, total)}`;
    }
    out += `)\n\n`;

    for (const m of visible) {
      out += `### ${m.name}\n\n`;
      if (m.source) {
        const preview = m.source.substring(0, 500);
        out += `\`\`\`xpp\n${preview}${m.source.length > 500 ? '\n// ...' : ''}\n\`\`\`\n\n`;
      }
    }

    if (hasMore) {
      out += `> ⚠️ **${total - methodOffset - TABLE_METHOD_PAGE_SIZE} more methods.** Call again with \`methodOffset: ${methodOffset + TABLE_METHOD_PAGE_SIZE}\`.\n\n`;
    }
  }

  return out;
}

// ════════════════════════════════════════════════════════════════════════
// CLASS
// ════════════════════════════════════════════════════════════════════════

const CLASS_METHOD_PAGE_SIZE = 15;

export async function tryBridgeClass(
  bridge: BridgeClient | undefined,
  className: string,
  compact: boolean,
  methodOffset = 0,
): Promise<ToolResult | null> {
  if (!bridge?.isReady || !bridge.metadataAvailable) return null;
  try {
    const cls = await bridge.readClass(className);
    if (!cls) return null;
    return { content: [{ type: 'text', text: formatClass(cls, compact, methodOffset) }] };
  } catch (e) {
    console.error(`[BridgeAdapter] readClass(${className}) failed: ${e}`);
    return null;
  }
}

function formatClass(cls: BridgeClassInfo, compact: boolean, methodOffset: number): string {
  const modifiers: string[] = [];
  if (cls.isFinal) modifiers.push('final');
  if (cls.isAbstract) modifiers.push('abstract');
  const modStr = modifiers.length > 0 ? ` (${modifiers.join(', ')})` : '';

  let out = `# Class: ${cls.name}${modStr}\n\n`;
  if (cls.extends) out += `**Extends:** ${cls.extends}\n`;
  if (cls.model) out += `**Model:** ${cls.model}\n`;
  out += `**Abstract:** ${cls.isAbstract ? 'Yes' : 'No'}\n`;
  out += `**Final:** ${cls.isFinal ? 'Yes' : 'No'}\n`;
  out += `_Source: C# bridge (IMetadataProvider)_\n\n`;

  if (!compact && cls.declaration) {
    out += `## Declaration\n\`\`\`xpp\n${cls.declaration}\n\`\`\`\n\n`;
  }

  const total = cls.methods.length;
  const visible = cls.methods.slice(methodOffset, methodOffset + CLASS_METHOD_PAGE_SIZE);
  const hasMore = methodOffset + CLASS_METHOD_PAGE_SIZE < total;

  out += `## Methods (${total} total`;
  if (total > CLASS_METHOD_PAGE_SIZE) {
    out += `, showing ${methodOffset + 1}–${Math.min(methodOffset + CLASS_METHOD_PAGE_SIZE, total)}`;
  }
  out += `)\n\n`;

  for (const m of visible) {
    if (compact) {
      // Signature-only: extract first line of source for signature
      const sig = m.source ? m.source.split('\n')[0].trim() : m.name;
      out += `- \`${sig}\`\n`;
    } else {
      out += `### ${m.name}\n\n`;
      if (m.source) {
        const preview = m.source.substring(0, 500);
        out += `\`\`\`xpp\n${preview}${m.source.length > 500 ? '\n// ... (use get_method_source for full body)' : ''}\n\`\`\`\n\n`;
      }
    }
  }

  if (hasMore) {
    out += `> ⚠️ **${total - methodOffset - CLASS_METHOD_PAGE_SIZE} more methods.** Call again with \`methodOffset: ${methodOffset + CLASS_METHOD_PAGE_SIZE}\`.\n\n`;
  }

  return out;
}

// ════════════════════════════════════════════════════════════════════════
// METHOD SOURCE
// ════════════════════════════════════════════════════════════════════════

export async function tryBridgeMethodSource(
  bridge: BridgeClient | undefined,
  className: string,
  methodName: string,
): Promise<ToolResult | null> {
  if (!bridge?.isReady || !bridge.metadataAvailable) return null;
  try {
    const ms = await bridge.getMethodSource(className, methodName);
    if (!ms.found || !ms.source) return null;

    // Detect [SysObsolete] / [Obsolete] — same logic as fallback path.
    // Without this, bridge-returned source silently omits the deprecation warning
    // and AI may generate calls to obsolete methods (violates system rule 26).
    const obsoleteMatch = ms.source.match(/\[\s*SysObsolete\s*\(\s*['"]([^'"]*)['"]/i)
      ?? ms.source.match(/\[\s*Obsolete\s*\(\s*['"]([^'"]*)['"]/i);
    const obsoleteWarning = obsoleteMatch
      ? `\n\n> ⚠️ **This method is marked obsolete.** Do NOT generate calls to it.\n> Replacement hint from the attribute: _"${obsoleteMatch[1]}"_\n> Read the hint above and use the stated replacement instead.`
      : '';

    const text =
      `## ${ms.className}.${ms.methodName}\n\n` +
      `_Source: C# bridge (IMetadataProvider)_\n` +
      obsoleteWarning +
      `\n\`\`\`xpp\n${ms.source}\n\`\`\``;
    return { content: [{ type: 'text', text }] };
  } catch (e) {
    console.error(`[BridgeAdapter] getMethodSource(${className}, ${methodName}) failed: ${e}`);
    return null;
  }
}

// ════════════════════════════════════════════════════════════════════════
// ENUM
// ════════════════════════════════════════════════════════════════════════

export async function tryBridgeEnum(
  bridge: BridgeClient | undefined,
  enumName: string,
): Promise<ToolResult | null> {
  if (!bridge?.isReady || !bridge.metadataAvailable) return null;
  try {
    const en = await bridge.readEnum(enumName);
    if (!en) return null;

    let out = `# Enum: ${en.name}\n\n`;
    if (en.label) out += `**Label:** ${en.label}\n`;
    if (en.model) out += `**Model:** ${en.model}\n`;
    out += `**Extensible:** ${en.isExtensible ? 'Yes' : 'No'}\n`;
    out += `_Source: C# bridge (IMetadataProvider)_\n\n`;

    out += `## Values (${en.values.length})\n\n`;
    for (const v of en.values) {
      const lbl = v.label ? ` - ${v.label}` : '';
      out += `- **${v.name}** = ${v.value}${lbl}\n`;
    }

    return { content: [{ type: 'text', text: out }] };
  } catch (e) {
    console.error(`[BridgeAdapter] readEnum(${enumName}) failed: ${e}`);
    return null;
  }
}

// ════════════════════════════════════════════════════════════════════════
// EDT
// ════════════════════════════════════════════════════════════════════════

export async function tryBridgeEdt(
  bridge: BridgeClient | undefined,
  edtName: string,
): Promise<ToolResult | null> {
  if (!bridge?.isReady || !bridge.metadataAvailable) return null;
  try {
    const edt = await bridge.readEdt(edtName);
    if (!edt) return null;
    return { content: [{ type: 'text', text: formatEdt(edt) }] };
  } catch (e) {
    console.error(`[BridgeAdapter] readEdt(${edtName}) failed: ${e}`);
    return null;
  }
}

function formatEdt(edt: BridgeEdtInfo): string {
  let out = `# Extended Data Type: ${edt.name}\n\n`;
  if (edt.model) out += `**Model:** ${edt.model}\n`;
  out += `_Source: C# bridge (IMetadataProvider)_\n\n`;

  // Core properties table
  out += `## 🔧 Core Properties\n\n`;
  out += `| Property | Value |\n|---|---|\n`;
  out += `| Base Type | ${edt.baseType ?? '—'}${edt.extends ? ` (Extends: ${edt.extends})` : ''} |\n`;
  if (edt.enumType) out += `| Enum Type | ${edt.enumType} |\n`;
  if (edt.referenceTable) out += `| Reference Table | ${edt.referenceTable} |\n`;
  if (edt.relationType) out += `| Relation Type | ${edt.relationType} |\n`;
  if (edt.stringSize) out += `| String Size | ${edt.stringSize} |\n`;
  if (edt.displayLength) out += `| Display Length | ${edt.displayLength} |\n`;
  if (edt.label) out += `| Label | ${edt.label} |\n`;
  if (edt.helpText) out += `| Help Text | ${edt.helpText} |\n`;
  if (edt.formHelp) out += `| Form Help | ${edt.formHelp} |\n`;
  if (edt.configurationKey) out += `| Configuration Key | ${edt.configurationKey} |\n`;
  if (edt.alignment) out += `| Alignment | ${edt.alignment} |\n`;
  if (edt.noOfDecimals != null) out += `| No. of Decimals | ${edt.noOfDecimals} |\n`;
  if (edt.decimalSeparator) out += `| Decimal Separator | ${edt.decimalSeparator} |\n`;
  if (edt.signDisplay) out += `| Sign Display | ${edt.signDisplay} |\n`;

  return out;
}

// ════════════════════════════════════════════════════════════════════════
// FORM
// ════════════════════════════════════════════════════════════════════════

export async function tryBridgeForm(
  bridge: BridgeClient | undefined,
  formName: string,
): Promise<ToolResult | null> {
  if (!bridge?.isReady || !bridge.metadataAvailable) return null;
  try {
    const form = await bridge.readForm(formName);
    if (!form) return null;
    return { content: [{ type: 'text', text: formatForm(form) }] };
  } catch (e) {
    console.error(`[BridgeAdapter] readForm(${formName}) failed: ${e}`);
    return null;
  }
}

function formatForm(form: BridgeFormInfo): string {
  let out = `# Form: ${form.name}\n\n`;
  if (form.model) out += `**Model:** ${form.model}\n`;
  if (form.formPattern) out += `**Pattern:** ${form.formPattern}\n`;
  out += `_Source: C# bridge (IMetadataProvider)_\n\n`;

  // Data Sources with permissions
  out += `## 📊 Data Sources (${form.dataSources.length})\n\n`;
  for (const ds of form.dataSources) {
    const join = ds.joinSource ? ` (join: ${ds.joinSource})` : '';
    const link = ds.linkType ? ` [LinkType: ${ds.linkType}]` : '';
    out += `### ${ds.name}\n`;
    out += `  Table: ${ds.table}${join}${link}\n`;
    const perms: string[] = [];
    if (ds.allowEdit) perms.push(`Edit: ${ds.allowEdit}`);
    if (ds.allowCreate) perms.push(`Create: ${ds.allowCreate}`);
    if (ds.allowDelete) perms.push(`Delete: ${ds.allowDelete}`);
    if (perms.length > 0) out += `  Permissions: ${perms.join(', ')}\n`;
    out += '\n';
  }

  // Controls tree with extra properties
  out += `## 🎨 Controls (${form.controls.length} top-level)\n\n`;
  out += buildControlTreeV2(form.controls, 0);

  // Methods
  if (form.methods && form.methods.length > 0) {
    out += `\n## 🔧 Form Methods (${form.methods.length})\n\n`;
    for (const m of form.methods) {
      out += `### ${m.name}\n`;
      if (m.source) {
        const preview = m.source.substring(0, 400);
        out += `\`\`\`xpp\n${preview}${m.source.length > 400 ? '\n// ...' : ''}\n\`\`\`\n`;
      }
      out += '\n';
    }
  }

  // Summary
  const totalControls = countControls(form.controls);
  out += `\n## 📈 Summary\n`;
  out += `Data Sources: ${form.dataSources.length} | Controls: ${totalControls} | Methods: ${form.methods?.length ?? 0}\n`;

  return out;
}

function buildControlTreeV2(controls: BridgeFormControl[], depth: number): string {
  if (!controls || depth > 10) return '';
  let out = '';
  const indent = '  '.repeat(depth);
  for (const c of controls) {
    const binding = c.dataSource && c.dataField ? ` [${c.dataSource}.${c.dataField}]` : '';
    const method = c.dataMethod ? ` (method: ${c.dataMethod})` : '';
    out += `${indent}- **${c.name}** (${c.controlType})${binding}${method}`;
    // Show important properties inline
    const props: string[] = [];
    if (c.caption) props.push(`Caption: ${c.caption}`);
    if (c.visible && c.visible !== 'Yes') props.push(`Visible: ${c.visible}`);
    if (c.enabled && c.enabled !== 'Yes') props.push(`Enabled: ${c.enabled}`);
    if (c.label) props.push(`Label: ${c.label}`);
    if (props.length > 0) out += `\n${indent}  _${props.join(', ')}_`;
    out += '\n';
    if (c.children?.length) {
      out += buildControlTreeV2(c.children, depth + 1);
    }
  }
  return out;
}

function countControls(controls: BridgeFormControl[]): number {
  let count = 0;
  for (const c of controls) {
    count++;
    if (c.children) count += countControls(c.children);
  }
  return count;
}

// ════════════════════════════════════════════════════════════════════════
// FIND REFERENCES
// ════════════════════════════════════════════════════════════════════════

export async function tryBridgeReferences(
  bridge: BridgeClient | undefined,
  targetName: string,
  limit = 50,
): Promise<ToolResult | null> {
  if (!bridge?.isReady || !bridge.xrefAvailable) return null;
  try {
    const refs = await bridge.findReferences(targetName);
    if (!refs || refs.count === 0) return null;

    let out = `# References to \`${targetName}\`\n\n`;
    out += `**Total:** ${refs.count} reference(s) found\n`;
    out += `_Source: C# bridge (DYNAMICSXREFDB)_\n\n`;

    // Group by reference type for summary
    const byType = new Map<string, number>();
    const topCallers = new Map<string, number>();
    for (const r of refs.references) {
      const rt = r.referenceType || 'reference';
      byType.set(rt, (byType.get(rt) || 0) + 1);
      const caller = r.callerClass
        ? (r.callerMethod ? `${r.callerClass}.${r.callerMethod}` : r.callerClass)
        : r.sourcePath;
      topCallers.set(caller, (topCallers.get(caller) || 0) + 1);
    }

    // Summary by type
    out += `## 📊 Summary by Type\n\n`;
    for (const [type, count] of byType) {
      out += `- **${type}**: ${count} reference(s)\n`;
    }
    out += `\n`;

    // Top callers
    const sortedCallers = [...topCallers.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
    if (sortedCallers.length > 0) {
      out += `## 🔝 Top Callers\n\n`;
      for (const [caller, count] of sortedCallers) {
        out += `- **${caller}** (${count} call(s))\n`;
      }
      out += `\n`;
    }

    // Detailed references
    out += `## 📍 References\n\n`;
    const visible = refs.references.slice(0, limit);
    for (const r of visible) {
      const module = r.sourceModule ? ` [${r.sourceModule}]` : '';
      const loc = r.line > 0 ? `:${r.line}` : '';
      const refType = r.referenceType ? ` (${r.referenceType})` : '';
      const caller = r.callerClass
        ? (r.callerMethod ? `${r.callerClass}.${r.callerMethod}` : r.callerClass)
        : null;
      if (caller) {
        out += `- **${caller}**${loc}${module}${refType}\n`;
      } else {
        out += `- **${r.sourcePath}**${loc}${module}${refType}\n`;
      }
    }

    if (refs.count > limit) {
      out += `\n> ⚠️ Showing first ${limit} of ${refs.count} references.\n`;
    }

    return { content: [{ type: 'text', text: out }] };
  } catch (e) {
    console.error(`[BridgeAdapter] findReferences(${targetName}) failed: ${e}`);
    return null;
  }
}

// ════════════════════════════════════════════════════════════════════════
// SEARCH
// ════════════════════════════════════════════════════════════════════════

export async function tryBridgeSearch(
  bridge: BridgeClient | undefined,
  query: string,
  objectType?: string,
  maxResults = 50,
): Promise<ToolResult | null> {
  if (!bridge?.isReady || !bridge.metadataAvailable) return null;
  try {
    const sr = await bridge.searchObjects(query, objectType);
    if (!sr || sr.results.length === 0) return null;

    let out = `# Search: "${query}"${objectType ? ` (type: ${objectType})` : ''}\n\n`;
    out += `**Results:** ${sr.results.length}\n`;
    out += `_Source: C# bridge (IMetadataProvider)_\n\n`;

    for (const r of sr.results.slice(0, maxResults)) {
      out += `- **${r.name}** (${r.type})\n`;
    }

    return { content: [{ type: 'text', text: out }] };
  } catch (e) {
    console.error(`[BridgeAdapter] searchObjects(${query}) failed: ${e}`);
    return null;
  }
}

// ════════════════════════════════════════════════════════════════════════
// QUERY
// ════════════════════════════════════════════════════════════════════════

export async function tryBridgeQuery(
  bridge: BridgeClient | undefined,
  queryName: string,
): Promise<ToolResult | null> {
  if (!bridge?.isReady || !bridge.metadataAvailable) return null;
  try {
    const q = await bridge.readQuery(queryName);
    if (!q) return null;
    return { content: [{ type: 'text', text: formatQuery(q) }] };
  } catch (e) {
    console.error(`[BridgeAdapter] readQuery(${queryName}) failed: ${e}`);
    return null;
  }
}

function formatQuery(q: BridgeQueryInfo): string {
  let out = `# Query: ${q.name}\n\n`;
  if (q.model) out += `**Model:** ${q.model}\n`;
  if (q.description) out += `**Description:** ${q.description}\n`;
  out += `_Source: C# bridge (IMetadataProvider)_\n\n`;

  if (q.dataSources.length > 0) {
    out += `## Data Sources (${q.dataSources.length})\n\n`;
    let totalRanges = 0;
    for (const ds of q.dataSources) {
      out += formatQueryDataSource(ds, 0);
      totalRanges += countRanges(ds);
    }
    if (totalRanges > 0) {
      out += `\n## 📈 Summary\nData Sources: ${q.dataSources.length} | Total Ranges: ${totalRanges}\n`;
    }
  }

  return out;
}

function countRanges(ds: BridgeQueryDataSource): number {
  let count = ds.ranges?.length ?? 0;
  if (ds.childDataSources) {
    for (const child of ds.childDataSources) count += countRanges(child);
  }
  return count;
}

function formatQueryDataSource(ds: BridgeQueryDataSource, depth: number): string {
  const indent = '  '.repeat(depth);
  const join = ds.joinMode ? ` (${ds.joinMode})` : '';
  const fetch = ds.fetchMode ? ` [FetchMode: ${ds.fetchMode}]` : '';
  let out = `${indent}- **${ds.name}** → ${ds.table}${join}${fetch}\n`;

  // Ranges
  if (ds.ranges && ds.ranges.length > 0) {
    out += `${indent}  **Ranges:**\n`;
    for (const r of ds.ranges) {
      const status = r.status ? ` (${r.status})` : '';
      out += `${indent}    - ${r.field}: ${r.value ?? '(any)'}${status}\n`;
    }
  }

  // Fields
  if (ds.fields && ds.fields.length > 0) {
    const shown = ds.fields.slice(0, 10);
    const more = ds.fields.length > 10 ? ` ... (+${ds.fields.length - 10} more)` : '';
    out += `${indent}  **Fields (${ds.fields.length}):** ${shown.join(', ')}${more}\n`;
  }

  if (ds.childDataSources?.length) {
    for (const child of ds.childDataSources) {
      out += formatQueryDataSource(child, depth + 1);
    }
  }
  return out;
}

// ════════════════════════════════════════════════════════════════════════
// VIEW
// ════════════════════════════════════════════════════════════════════════

export async function tryBridgeView(
  bridge: BridgeClient | undefined,
  viewName: string,
): Promise<ToolResult | null> {
  if (!bridge?.isReady || !bridge.metadataAvailable) return null;
  try {
    const v = await bridge.readView(viewName);
    if (!v) return null;
    return { content: [{ type: 'text', text: formatView(v) }] };
  } catch (e) {
    console.error(`[BridgeAdapter] readView(${viewName}) failed: ${e}`);
    return null;
  }
}

function formatView(v: BridgeViewInfo): string {
  let out = `# View: ${v.name}\n\n`;
  if (v.label) out += `**Label:** ${v.label}\n`;
  if (v.model) out += `**Model:** ${v.model}\n`;
  if (v.query) out += `**Query:** ${v.query}\n`;
  if (v.isPublic != null) out += `**Public:** ${v.isPublic ? 'Yes' : 'No'}\n`;
  if (v.isReadOnly != null) out += `**Read-Only:** ${v.isReadOnly ? 'Yes' : 'No'}\n`;
  if (v.primaryKey) out += `**Primary Key:** ${v.primaryKey}\n`;
  out += `_Source: C# bridge (IMetadataProvider)_\n\n`;

  // DataSources
  if (v.dataSources && v.dataSources.length > 0) {
    out += `## Data Sources (${v.dataSources.length})\n\n`;
    for (const ds of v.dataSources) {
      out += `- **${ds.name}** → ${ds.table}\n`;
    }
    out += '\n';
  }

  // Fields — split mapped vs computed
  if (v.fields.length > 0) {
    const mapped = v.fields.filter(f => !f.isComputed);
    const computed = v.fields.filter(f => f.isComputed);

    out += `## 📊 Fields (${v.fields.length})\n\n`;

    if (mapped.length > 0) {
      out += `### Mapped Fields (${mapped.length})\n\n`;
      out += `| Field Name | Data Source | Data Field | Type |\n|---|---|---|---|\n`;
      for (const f of mapped) {
        out += `| ${f.name} | ${f.dataSource ?? '—'} | ${f.dataField ?? '—'} | ${f.fieldType} |\n`;
      }
      out += '\n';
    }

    if (computed.length > 0) {
      out += `### Computed Fields (${computed.length})\n\n`;
      out += `| Field Name | Data Method | Type |\n|---|---|---|\n`;
      for (const f of computed) {
        out += `| ${f.name} | ${f.dataMethod ?? '—'} | ${f.fieldType} |\n`;
      }
      out += '\n';
    }
  }

  // Relations
  if (v.relations && v.relations.length > 0) {
    out += `## 🔗 Relations (${v.relations.length})\n\n`;
    for (const rel of v.relations) {
      out += `- **${rel.name}** → ${rel.relatedTable}`;
      if (rel.cardinality) out += ` (${rel.cardinality})`;
      out += '\n';
      for (const c of rel.constraints) {
        if (c.field && c.relatedField) out += `  - ${c.field} = ${c.relatedField}\n`;
      }
    }
    out += '\n';
  }

  // Methods
  if (v.methods && v.methods.length > 0) {
    out += `## 🔧 Methods (${v.methods.length})\n\n`;
    for (const m of v.methods) {
      out += `- ${m.name}\n`;
    }
  }

  return out;
}

// ════════════════════════════════════════════════════════════════════════
// DATA ENTITY
// ════════════════════════════════════════════════════════════════════════

export async function tryBridgeDataEntity(
  bridge: BridgeClient | undefined,
  entityName: string,
): Promise<ToolResult | null> {
  if (!bridge?.isReady || !bridge.metadataAvailable) return null;
  try {
    const e = await bridge.readDataEntity(entityName);
    if (!e) return null;
    return { content: [{ type: 'text', text: formatDataEntity(e) }] };
  } catch (err) {
    console.error(`[BridgeAdapter] readDataEntity(${entityName}) failed: ${err}`);
    return null;
  }
}

function formatDataEntity(e: BridgeDataEntityInfo): string {
  let out = `DataEntity: ${e.name}\n`;
  if (e.model) out += `Model: ${e.model}\n`;
  if (e.label) out += `Label: ${e.label}\n`;
  out += `Type: Data Entity (AxDataEntityView)\n`;
  if (e.entityCategory) out += `Category: ${e.entityCategory}\n`;
  if (e.publicEntityName) out += `Public Name: ${e.publicEntityName} (OData resource name)\n`;
  if (e.publicCollectionName) out += `Collection: ${e.publicCollectionName}\n`;
  out += `OData Enabled: ${e.isPublic ? 'Yes' : 'No'}\n`;
  if (e.isReadOnly != null) out += `Read-Only: ${e.isReadOnly ? 'Yes' : 'No'}\n`;
  if (e.dataManagementEnabled != null) out += `Data Management (DMF): ${e.dataManagementEnabled ? 'Yes' : 'No'}\n`;
  if (e.stagingTable) out += `Staging Table: ${e.stagingTable}\n`;
  out += `_Source: C# bridge (IMetadataProvider)_\n`;

  if (e.dataSources.length > 0) {
    out += `\nData Sources (${e.dataSources.length}): ${e.dataSources.map(ds => ds.table || ds.name).join(', ')}\n`;
  }

  if (e.fields && e.fields.length > 0) {
    out += `\nFields (${e.fields.length}): `;
    const fieldNames = e.fields.slice(0, 8).map(f => f.name);
    out += fieldNames.join(', ');
    if (e.fields.length > 8) out += ` ... (+${e.fields.length - 8} more)`;
    out += '\n';
  }

  // Field mappings
  if (e.fieldMappings && e.fieldMappings.length > 0) {
    out += `\nField Mappings (${e.fieldMappings.length}):\n`;
    for (const fm of e.fieldMappings.slice(0, 20)) {
      out += `  ${fm.fieldName} → ${fm.dataSource ?? '?'}.${fm.dataField ?? '?'}\n`;
    }
    if (e.fieldMappings.length > 20) out += `  ... (+${e.fieldMappings.length - 20} more)\n`;
  }

  // Computed columns
  if (e.computedColumns && e.computedColumns.length > 0) {
    out += `\nComputed/Virtual Columns (${e.computedColumns.length}): ${e.computedColumns.join(', ')}\n`;
  }

  // Keys
  if (e.keys && e.keys.length > 0) {
    out += `\nKeys: ${e.keys.map(k => k.name).join(', ')}\n`;
  }

  return out;
}

// ════════════════════════════════════════════════════════════════════════
// REPORT (fallback only — used when XML file is not found on disk)
// ════════════════════════════════════════════════════════════════════════

export async function tryBridgeReport(
  bridge: BridgeClient | undefined,
  reportName: string,
): Promise<ToolResult | null> {
  if (!bridge?.isReady || !bridge.metadataAvailable) return null;
  try {
    const r = await bridge.readReport(reportName);
    if (!r) return null;
    return { content: [{ type: 'text', text: formatReport(r) }] };
  } catch (e) {
    console.error(`[BridgeAdapter] readReport(${reportName}) failed: ${e}`);
    return null;
  }
}

function formatReport(r: BridgeReportInfo): string {
  let out = `# Report: ${r.name}\n\n`;
  if (r.model) out += `**Model:** ${r.model}\n`;
  out += `_Source: C# bridge (IMetadataProvider)_\n\n`;

  if (r.dataSets.length > 0) {
    out += `## 📊 Data Sets (${r.dataSets.length})\n\n`;
    for (const ds of r.dataSets) {
      out += `### DataSet: ${ds.name}\n`;
      if (ds.dataSourceType) out += `  DataSourceType: ${ds.dataSourceType}\n`;
      if (ds.query) out += `  Query: ${ds.query}\n`;
      if (ds.fields && ds.fields.length > 0) {
        out += `\n  | Name | Data Field | Data Type |\n  |---|---|---|\n`;
        for (const f of ds.fields) {
          out += `  | ${f.name} | ${f.dataField ?? '—'} | ${f.dataType ?? '—'} |\n`;
        }
      }
      out += '\n';
    }
  } else {
    out += `_No data set information available from the metadata API._\n\n`;
  }

  if (r.designs && r.designs.length > 0) {
    out += `## 🎨 Designs (${r.designs.length})\n\n`;
    for (const d of r.designs) {
      out += `### Design: ${d.name}\n`;
      if (d.caption) out += `  Caption: ${d.caption}\n`;
      if (d.style) out += `  Style: ${d.style}\n`;
      out += `  Embedded RDL: ${d.hasRdl ? '✅' : '❌'}\n\n`;
    }
  }

  out += `> 💡 For full RDL content, ensure the report XML file is accessible on disk.\n`;

  return out;
}

// ============================================================
// Write-support adapters (Phase 3)
// ============================================================

/**
 * Refreshes the C# DiskProvider so it picks up newly written/modified files.
 * Returns elapsed time in ms, or null if bridge is unavailable.
 */
export async function bridgeRefreshProvider(
  bridge: BridgeClient | undefined,
): Promise<{ refreshed: boolean; elapsedMs: number } | null> {
  if (!bridge?.isReady || !bridge.metadataAvailable) return null;
  try {
    return await bridge.refreshProvider();
  } catch (e) {
    console.error(`[BridgeAdapter] refreshProvider failed: ${e}`);
    return null;
  }
}

/**
 * Validates a just-written D365FO object by asking IMetadataProvider to read it back.
 * Automatically refreshes the provider first so the new file is visible.
 * Returns a validation summary or null if bridge is unavailable.
 */
export async function bridgeValidateAfterWrite(
  bridge: BridgeClient | undefined,
  objectType: string,
  objectName: string,
): Promise<string | null> {
  if (!bridge?.isReady || !bridge.metadataAvailable) return null;
  try {
    // Debounced refresh — coalesces multiple rapid create/modify operations
    // into a single DiskProvider refresh (400ms settle, 2s max wait)
    await debouncedRefresh.refresh(bridge);
    const result = await bridge.validateObject(objectType, objectName);
    if (!result) return null;

    if (result.valid) {
      const parts = [`✅ **IMetadataProvider validation passed** for \`${objectName}\``];
      if (result.fieldCount != null && result.fieldCount > 0) parts.push(`${result.fieldCount} fields`);
      if (result.methodCount != null && result.methodCount > 0) parts.push(`${result.methodCount} methods`);
      if (result.indexCount != null && result.indexCount > 0) parts.push(`${result.indexCount} indexes`);
      if (result.valueCount != null && result.valueCount > 0) parts.push(`${result.valueCount} values`);
      return parts.join(' | ');
    } else {
      return `⚠️ **IMetadataProvider could not read back \`${objectName}\`**: ${result.reason ?? 'unknown error'}`;
    }
  } catch (e) {
    console.error(`[BridgeAdapter] validateAfterWrite(${objectType}, ${objectName}) failed: ${e}`);
    return null; // non-fatal — bridge validation is best-effort
  }
}

/**
 * Resolves object existence and model via IMetadataProvider.
 * Used by modify_d365fo_file to locate objects without the SQLite index.
 * Returns { exists, objectType, objectName, model } or null.
 */
export async function bridgeResolveObject(
  bridge: BridgeClient | undefined,
  objectType: string,
  objectName: string,
): Promise<{ exists: boolean; objectType: string; objectName: string; model?: string } | null> {
  if (!bridge?.isReady || !bridge.metadataAvailable) return null;
  try {
    return await bridge.resolveObjectInfo(objectType, objectName);
  } catch (e) {
    console.error(`[BridgeAdapter] resolveObjectInfo(${objectType}, ${objectName}) failed: ${e}`);
    return null;
  }
}

// ========================================
// Write operations (Phase 4)
// ========================================

/**
 * Supported object types for bridge-based creation.
 * Covers core types + menu items + security + extensions + form + menu.
 * Complex types (report, data-entity, business-event, tile, kpi) continue
 * using TypeScript XML generation — the bridge handles them via xmlContent passthrough.
 */
const BRIDGE_CREATE_TYPES = new Set([
  'class', 'class-extension', 'table', 'enum', 'edt',
  'query', 'view', 'form',
  'table-extension', 'form-extension', 'enum-extension',
  'menu',
  'menu-item-action', 'menu-item-display', 'menu-item-output',
  'security-privilege', 'security-duty', 'security-role',
]);

/**
 * Supported operations for bridge-based modification.
 * All modify operations are now routed through the C# bridge.
 */
const BRIDGE_MODIFY_OPS = new Set([
  'add-method', 'remove-method', 'replace-code',
  'add-field', 'modify-field', 'rename-field', 'replace-all-fields', 'remove-field',
  'add-index', 'remove-index',
  'add-relation', 'remove-relation',
  'add-field-group', 'remove-field-group', 'add-field-to-field-group',
  'modify-property',
  'add-enum-value', 'modify-enum-value', 'remove-enum-value',
  'add-control', 'add-data-source',
  'add-display-method', 'add-table-method',
  'add-field-modification', 'add-menu-item-to-menu',
]);

/**
 * Supported object types for bridge-based modification.
 * Covers core types + query/view/form (add-method, modify-property, replace-code)
 * + menu items, security, and extension types.
 */
const BRIDGE_MODIFY_TYPES = new Set([
  'class', 'table', 'enum', 'edt',
  'form', 'query', 'view',
  'class-extension', 'table-extension', 'form-extension', 'enum-extension',
  'menu-item-action', 'menu-item-display', 'menu-item-output',
]);

/**
 * Checks if bridge can handle this create operation.
 */
export function canBridgeCreate(objectType: string): boolean {
  return BRIDGE_CREATE_TYPES.has(objectType.toLowerCase());
}

/**
 * Checks if bridge can handle this modify operation.
 */
export function canBridgeModify(objectType: string, operation: string): boolean {
  return BRIDGE_MODIFY_TYPES.has(objectType.toLowerCase()) && BRIDGE_MODIFY_OPS.has(operation.toLowerCase());
}

/**
 * Creates a D365FO object via the C# bridge (IMetadataProvider.Create()).
 * Returns { success, filePath, api } or null if bridge unavailable.
 */
export async function bridgeCreateObject(
  bridge: BridgeClient | undefined,
  params: {
    objectType: string;
    objectName: string;
    modelName: string;
    declaration?: string;
    methods?: { name: string; source?: string }[];
    fields?: Record<string, unknown>[];
    fieldGroups?: Record<string, unknown>[];
    indexes?: Record<string, unknown>[];
    relations?: Record<string, unknown>[];
    values?: Record<string, unknown>[];
    properties?: Record<string, string>;
  },
): Promise<{ success: boolean; filePath?: string; message: string } | null> {
  if (!bridge?.isReady || !bridge.metadataAvailable) return null;
  if (!canBridgeCreate(params.objectType)) return null;

  try {
    const result = await bridge.createObject(params);
    if (result.success) {
      return {
        success: true,
        filePath: result.filePath,
        message: `✅ Created via ${result.api ?? 'IMetadataProvider'} — file: ${result.filePath}`,
      };
    } else {
      return { success: false, message: `Bridge createObject returned success=false` };
    }
  } catch (e) {
    console.error(`[BridgeAdapter] createObject(${params.objectType}, ${params.objectName}) failed: ${e}`);
    return null; // Signal to caller: fall back to XML generation
  }
}

/**
 * Creates a smart table via the C# bridge with all BP-smart defaults
 * (CacheLookup, FieldGroups, DeleteActions, TitleField, PrimaryIndex) auto-set.
 * Returns { success, filePath, bpDefaults } or null if bridge unavailable.
 */
export async function bridgeCreateSmartTable(
  bridge: BridgeClient | undefined,
  params: {
    objectName: string;
    modelName: string;
    tableGroup?: string;
    tableType?: string;
    label?: string;
    fields?: Record<string, unknown>[];
    extraFieldGroups?: Record<string, unknown>[];
    indexes?: Record<string, unknown>[];
    relations?: Record<string, unknown>[];
    methods?: { name: string; source?: string }[];
    extraProperties?: Record<string, string>;
  },
): Promise<BridgeSmartTableResult | null> {
  if (!bridge?.isReady || !bridge.metadataAvailable) return null;

  try {
    const result = await bridge.createSmartTable(params);
    if (result.success) {
      console.error(`[BridgeAdapter] ✅ Smart table created: ${result.filePath} (${result.api})`);
      return result;
    } else {
      console.error(`[BridgeAdapter] createSmartTable returned success=false`);
      return null;
    }
  } catch (e) {
    console.error(`[BridgeAdapter] createSmartTable(${params.objectName}) failed: ${e}`);
    return null; // Signal to caller: fall back to SmartXmlBuilder
  }
}

/**
 * Adds/replaces a method via the C# bridge (IMetadataProvider.Update()).
 */
export async function bridgeAddMethod(
  bridge: BridgeClient | undefined,
  objectType: string,
  objectName: string,
  methodName: string,
  sourceCode: string,
): Promise<{ success: boolean; message: string } | null> {
  if (!bridge?.isReady || !bridge.metadataAvailable) return null;
  if (!BRIDGE_MODIFY_TYPES.has(objectType.toLowerCase())) return null;

  try {
    const result = await bridge.addMethod(objectType, objectName, methodName, sourceCode);
    return {
      success: result.success,
      message: result.success
        ? `✅ Method '${methodName}' added via ${result.api}`
        : `Bridge addMethod returned success=false`,
    };
  } catch (e) {
    console.error(`[BridgeAdapter] addMethod(${objectType}, ${objectName}, ${methodName}) failed: ${e}`);
    return null;
  }
}

/**
 * Adds a field to a table via the C# bridge (IMetadataProvider.Update()).
 */
export async function bridgeAddField(
  bridge: BridgeClient | undefined,
  tableName: string,
  fieldName: string,
  fieldType: string,
  edt?: string,
  mandatory?: boolean,
  label?: string,
): Promise<{ success: boolean; message: string } | null> {
  if (!bridge?.isReady || !bridge.metadataAvailable) return null;

  try {
    const result = await bridge.addField(tableName, fieldName, fieldType, edt, mandatory, label);
    return {
      success: result.success,
      message: result.success
        ? `✅ Field '${fieldName}' added via ${result.api}`
        : `Bridge addField returned success=false`,
    };
  } catch (e) {
    console.error(`[BridgeAdapter] addField(${tableName}, ${fieldName}) failed: ${e}`);
    return { success: false, message: String(e) };
  }
}

/**
 * Sets a property via the C# bridge (IMetadataProvider.Update()).
 */
export async function bridgeSetProperty(
  bridge: BridgeClient | undefined,
  objectType: string,
  objectName: string,
  propertyPath: string,
  propertyValue: string,
): Promise<{ success: boolean; message: string } | null> {
  if (!bridge?.isReady || !bridge.metadataAvailable) return null;
  if (!BRIDGE_MODIFY_TYPES.has(objectType.toLowerCase())) return null;

  try {
    const result = await bridge.setProperty(objectType, objectName, propertyPath, propertyValue);
    return {
      success: result.success,
      message: result.success
        ? `✅ Property '${propertyPath}'='${propertyValue}' set via ${result.api}`
        : `Bridge setProperty returned success=false`,
    };
  } catch (e) {
    console.error(`[BridgeAdapter] setProperty(${objectType}, ${objectName}, ${propertyPath}) failed: ${e}`);
    return null;
  }
}

/**
 * Replaces code in a method via the C# bridge (IMetadataProvider.Update()).
 */
export async function bridgeReplaceCode(
  bridge: BridgeClient | undefined,
  objectType: string,
  objectName: string,
  methodName: string | undefined,
  oldCode: string,
  newCode: string,
): Promise<{ success: boolean; message: string } | null> {
  if (!bridge?.isReady || !bridge.metadataAvailable) return null;
  if (!BRIDGE_MODIFY_TYPES.has(objectType.toLowerCase())) return null;

  try {
    const result = await bridge.replaceCode(objectType, objectName, methodName, oldCode, newCode);
    return {
      success: result.success,
      message: result.success
        ? `✅ Code replaced via ${result.api}`
        : `Bridge replaceCode returned success=false`,
    };
  } catch (e) {
    console.error(`[BridgeAdapter] replaceCode(${objectType}, ${objectName}) failed: ${e}`);
    return null;
  }
}

/**
 * Removes a method from a class, table, form, etc. via the C# bridge.
 */
export async function bridgeRemoveMethod(
  bridge: BridgeClient | undefined,
  objectType: string,
  objectName: string,
  methodName: string,
): Promise<{ success: boolean; message: string } | null> {
  if (!bridge?.isReady || !bridge.metadataAvailable) return null;
  if (!BRIDGE_MODIFY_TYPES.has(objectType.toLowerCase())) return null;

  try {
    const result = await bridge.removeMethod(objectType, objectName, methodName);
    return {
      success: result.success,
      message: result.success
        ? `✅ Method '${methodName}' removed via ${result.api}`
        : `Bridge removeMethod returned success=false`,
    };
  } catch (e) {
    console.error(`[BridgeAdapter] removeMethod(${objectType}, ${objectName}, ${methodName}) failed: ${e}`);
    return null;
  }
}

/**
 * Adds an index to a table via the C# bridge.
 */
export async function bridgeAddIndex(
  bridge: BridgeClient | undefined,
  tableName: string,
  indexName: string,
  fields?: string[],
  allowDuplicates?: boolean,
  alternateKey?: boolean,
): Promise<{ success: boolean; message: string } | null> {
  if (!bridge?.isReady || !bridge.metadataAvailable) return null;
  try {
    const result = await bridge.addIndex(tableName, indexName, fields, allowDuplicates, alternateKey);
    return {
      success: result.success,
      message: result.success
        ? `✅ Index '${indexName}' added via ${result.api}`
        : `Bridge addIndex returned success=false`,
    };
  } catch (e) {
    console.error(`[BridgeAdapter] addIndex(${tableName}, ${indexName}) failed: ${e}`);
    return null;
  }
}

/**
 * Removes an index from a table via the C# bridge.
 */
export async function bridgeRemoveIndex(
  bridge: BridgeClient | undefined,
  tableName: string,
  indexName: string,
): Promise<{ success: boolean; message: string } | null> {
  if (!bridge?.isReady || !bridge.metadataAvailable) return null;
  try {
    const result = await bridge.removeIndex(tableName, indexName);
    return {
      success: result.success,
      message: result.success
        ? `✅ Index '${indexName}' removed via ${result.api}`
        : `Bridge removeIndex returned success=false`,
    };
  } catch (e) {
    console.error(`[BridgeAdapter] removeIndex(${tableName}, ${indexName}) failed: ${e}`);
    return null;
  }
}

/**
 * Adds a relation to a table via the C# bridge.
 */
export async function bridgeAddRelation(
  bridge: BridgeClient | undefined,
  tableName: string,
  relationName: string,
  relatedTable: string,
  constraints?: Array<{ field?: string; relatedField?: string }>,
): Promise<{ success: boolean; message: string } | null> {
  if (!bridge?.isReady || !bridge.metadataAvailable) return null;
  try {
    const result = await bridge.addRelation(tableName, relationName, relatedTable, constraints);
    return {
      success: result.success,
      message: result.success
        ? `✅ Relation '${relationName}' added via ${result.api}`
        : `Bridge addRelation returned success=false`,
    };
  } catch (e) {
    console.error(`[BridgeAdapter] addRelation(${tableName}, ${relationName}) failed: ${e}`);
    return null;
  }
}

/**
 * Removes a relation from a table via the C# bridge.
 */
export async function bridgeRemoveRelation(
  bridge: BridgeClient | undefined,
  tableName: string,
  relationName: string,
): Promise<{ success: boolean; message: string } | null> {
  if (!bridge?.isReady || !bridge.metadataAvailable) return null;
  try {
    const result = await bridge.removeRelation(tableName, relationName);
    return {
      success: result.success,
      message: result.success
        ? `✅ Relation '${relationName}' removed via ${result.api}`
        : `Bridge removeRelation returned success=false`,
    };
  } catch (e) {
    console.error(`[BridgeAdapter] removeRelation(${tableName}, ${relationName}) failed: ${e}`);
    return null;
  }
}

/**
 * Adds a field group to a table via the C# bridge.
 */
export async function bridgeAddFieldGroup(
  bridge: BridgeClient | undefined,
  tableName: string,
  groupName: string,
  label?: string,
  fields?: string[],
): Promise<{ success: boolean; message: string } | null> {
  if (!bridge?.isReady || !bridge.metadataAvailable) return null;
  try {
    const result = await bridge.addFieldGroup(tableName, groupName, label, fields);
    return {
      success: result.success,
      message: result.success
        ? `✅ Field group '${groupName}' added via ${result.api}`
        : `Bridge addFieldGroup returned success=false`,
    };
  } catch (e) {
    console.error(`[BridgeAdapter] addFieldGroup(${tableName}, ${groupName}) failed: ${e}`);
    return null;
  }
}

/**
 * Removes a field group from a table via the C# bridge.
 */
export async function bridgeRemoveFieldGroup(
  bridge: BridgeClient | undefined,
  tableName: string,
  groupName: string,
): Promise<{ success: boolean; message: string } | null> {
  if (!bridge?.isReady || !bridge.metadataAvailable) return null;
  try {
    const result = await bridge.removeFieldGroup(tableName, groupName);
    return {
      success: result.success,
      message: result.success
        ? `✅ Field group '${groupName}' removed via ${result.api}`
        : `Bridge removeFieldGroup returned success=false`,
    };
  } catch (e) {
    console.error(`[BridgeAdapter] removeFieldGroup(${tableName}, ${groupName}) failed: ${e}`);
    return null;
  }
}

/**
 * Adds a field to an existing field group on a table via the C# bridge.
 */
export async function bridgeAddFieldToFieldGroup(
  bridge: BridgeClient | undefined,
  tableName: string,
  groupName: string,
  fieldName: string,
): Promise<{ success: boolean; message: string } | null> {
  if (!bridge?.isReady || !bridge.metadataAvailable) return null;
  try {
    const result = await bridge.addFieldToFieldGroup(tableName, groupName, fieldName);
    return {
      success: result.success,
      message: result.success
        ? `✅ Field '${fieldName}' added to group '${groupName}' via ${result.api}`
        : `Bridge addFieldToFieldGroup returned success=false`,
    };
  } catch (e) {
    console.error(`[BridgeAdapter] addFieldToFieldGroup(${tableName}, ${groupName}, ${fieldName}) failed: ${e}`);
    return null;
  }
}

/**
 * Modifies field properties on a table via the C# bridge.
 */
export async function bridgeModifyField(
  bridge: BridgeClient | undefined,
  tableName: string,
  fieldName: string,
  properties?: Record<string, string>,
): Promise<{ success: boolean; message: string } | null> {
  if (!bridge?.isReady || !bridge.metadataAvailable) return null;
  try {
    const result = await bridge.modifyField(tableName, fieldName, properties);
    return {
      success: result.success,
      message: result.success
        ? `✅ Field '${fieldName}' modified via ${result.api}`
        : `Bridge modifyField returned success=false`,
    };
  } catch (e) {
    console.error(`[BridgeAdapter] modifyField(${tableName}, ${fieldName}) failed: ${e}`);
    return { success: false, message: String(e) };
  }
}

/**
 * Renames a field on a table via the C# bridge. Also fixes index/fieldgroup/TitleField refs.
 */
export async function bridgeRenameField(
  bridge: BridgeClient | undefined,
  tableName: string,
  oldName: string,
  newName: string,
): Promise<{ success: boolean; message: string } | null> {
  if (!bridge?.isReady || !bridge.metadataAvailable) return null;
  try {
    const result = await bridge.renameField(tableName, oldName, newName);
    return {
      success: result.success,
      message: result.success
        ? `✅ Field renamed '${oldName}' → '${newName}' via ${result.api}`
        : `Bridge renameField returned success=false`,
    };
  } catch (e) {
    console.error(`[BridgeAdapter] renameField(${tableName}, ${oldName} → ${newName}) failed: ${e}`);
    return { success: false, message: String(e) };
  }
}

/**
 * Removes a field from a table via the C# bridge.
 */
export async function bridgeRemoveField(
  bridge: BridgeClient | undefined,
  tableName: string,
  fieldName: string,
): Promise<{ success: boolean; message: string } | null> {
  if (!bridge?.isReady || !bridge.metadataAvailable) return null;
  try {
    const result = await bridge.removeField(tableName, fieldName);
    return {
      success: result.success,
      message: result.success
        ? `✅ Field '${fieldName}' removed via ${result.api}`
        : `Bridge removeField returned success=false`,
    };
  } catch (e) {
    console.error(`[BridgeAdapter] removeField(${tableName}, ${fieldName}) failed: ${e}`);
    return { success: false, message: String(e) };
  }
}

/**
 * Replaces ALL fields on a table via the C# bridge. Use for bulk field rewrite.
 */
export async function bridgeReplaceAllFields(
  bridge: BridgeClient | undefined,
  tableName: string,
  fields: Array<Record<string, unknown>>,
): Promise<{ success: boolean; message: string } | null> {
  if (!bridge?.isReady || !bridge.metadataAvailable) return null;
  try {
    const result = await bridge.replaceAllFields(tableName, fields);
    return {
      success: result.success,
      message: result.success
        ? `✅ All fields replaced (${fields.length}) via ${result.api}`
        : `Bridge replaceAllFields returned success=false`,
    };
  } catch (e) {
    console.error(`[BridgeAdapter] replaceAllFields(${tableName}) failed: ${e}`);
    return { success: false, message: String(e) };
  }
}

/**
 * Adds a value to an enum via the C# bridge.
 */
export async function bridgeAddEnumValue(
  bridge: BridgeClient | undefined,
  enumName: string,
  valueName: string,
  value: number,
  label?: string,
): Promise<{ success: boolean; message: string } | null> {
  if (!bridge?.isReady || !bridge.metadataAvailable) return null;
  try {
    const result = await bridge.addEnumValue(enumName, valueName, value, label);
    return {
      success: result.success,
      message: result.success
        ? `✅ Enum value '${valueName}'=${value} added via ${result.api}`
        : `Bridge addEnumValue returned success=false`,
    };
  } catch (e) {
    console.error(`[BridgeAdapter] addEnumValue(${enumName}, ${valueName}) failed: ${e}`);
    return null;
  }
}

/**
 * Modifies an enum value's properties via the C# bridge.
 */
export async function bridgeModifyEnumValue(
  bridge: BridgeClient | undefined,
  enumName: string,
  valueName: string,
  properties?: Record<string, string>,
): Promise<{ success: boolean; message: string } | null> {
  if (!bridge?.isReady || !bridge.metadataAvailable) return null;
  try {
    const result = await bridge.modifyEnumValue(enumName, valueName, properties);
    return {
      success: result.success,
      message: result.success
        ? `✅ Enum value '${valueName}' modified via ${result.api}`
        : `Bridge modifyEnumValue returned success=false`,
    };
  } catch (e) {
    console.error(`[BridgeAdapter] modifyEnumValue(${enumName}, ${valueName}) failed: ${e}`);
    return null;
  }
}

/**
 * Removes an enum value via the C# bridge.
 */
export async function bridgeRemoveEnumValue(
  bridge: BridgeClient | undefined,
  enumName: string,
  valueName: string,
): Promise<{ success: boolean; message: string } | null> {
  if (!bridge?.isReady || !bridge.metadataAvailable) return null;
  try {
    const result = await bridge.removeEnumValue(enumName, valueName);
    return {
      success: result.success,
      message: result.success
        ? `✅ Enum value '${valueName}' removed via ${result.api}`
        : `Bridge removeEnumValue returned success=false`,
    };
  } catch (e) {
    console.error(`[BridgeAdapter] removeEnumValue(${enumName}, ${valueName}) failed: ${e}`);
    return null;
  }
}

/**
 * Adds a control to a form via the C# bridge.
 */
export async function bridgeAddControl(
  bridge: BridgeClient | undefined,
  formName: string,
  controlName: string,
  parentControl: string,
  controlType: string,
  dataSource?: string,
  dataField?: string,
  label?: string,
): Promise<{ success: boolean; message: string } | null> {
  if (!bridge?.isReady || !bridge.metadataAvailable) return null;
  try {
    const result = await bridge.addControl(formName, controlName, parentControl, controlType, dataSource, dataField, label);
    return {
      success: result.success,
      message: result.success
        ? `✅ Control '${controlName}' added to '${parentControl}' via ${result.api}`
        : `Bridge addControl returned success=false`,
    };
  } catch (e) {
    console.error(`[BridgeAdapter] addControl(${formName}, ${controlName}) failed: ${e}`);
    return null;
  }
}

/**
 * Adds a data source to a form via the C# bridge.
 */
export async function bridgeAddDataSource(
  bridge: BridgeClient | undefined,
  objectType: string,
  objectName: string,
  dsName: string,
  table: string,
  joinSource?: string,
  linkType?: string,
): Promise<{ success: boolean; message: string } | null> {
  if (!bridge?.isReady || !bridge.metadataAvailable) return null;
  try {
    const result = await bridge.addDataSource(objectType, objectName, dsName, table, joinSource, linkType);
    return {
      success: result.success,
      message: result.success
        ? `✅ DataSource '${dsName}' added via ${result.api}`
        : `Bridge addDataSource returned success=false`,
    };
  } catch (e) {
    console.error(`[BridgeAdapter] addDataSource(${objectType}, ${objectName}, ${dsName}) failed: ${e}`);
    return null;
  }
}

// ════════════════════════════════════════════════════════════════════════
// DELETE OBJECT
// ════════════════════════════════════════════════════════════════════════

/**
 * Deletes a D365FO object via the C# bridge.
 * Returns a formatted ToolResult or null if bridge unavailable.
 */
export async function bridgeDeleteObject(
  bridge: BridgeClient | undefined,
  objectType: string,
  objectName: string,
): Promise<ToolResult | null> {
  if (!bridge?.isReady || !bridge.metadataAvailable) return null;

  try {
    const result = await bridge.deleteObject(objectType, objectName);
    if (result.success) {
      let text = `✅ **Deleted** ${objectType} \`${objectName}\`\n`;
      if (result.model) text += `- **Model:** ${result.model}\n`;
      if (result.filePath) text += `- **File:** ${result.filePath}\n`;
      return { content: [{ type: 'text', text }] };
    } else {
      const text = `❌ **Delete failed** for ${objectType} \`${objectName}\`\n- Error: ${result.error ?? 'Unknown error'}`;
      return { content: [{ type: 'text', text }], isError: true };
    }
  } catch (e) {
    console.error(`[BridgeAdapter] deleteObject(${objectType}, ${objectName}) failed: ${e}`);
    return null;
  }
}

// ════════════════════════════════════════════════════════════════════════
// TABLE-EXTENSION: ADD FIELD MODIFICATION
// ════════════════════════════════════════════════════════════════════════

/**
 * Adds or updates a FieldModification entry in a table-extension via the C# bridge.
 * Allows overriding Label / Mandatory on a base-table field.
 */
export async function bridgeAddFieldModification(
  bridge: BridgeClient | undefined,
  extensionName: string,
  fieldName: string,
  fieldLabel?: string,
  fieldMandatory?: boolean,
): Promise<{ success: boolean; message: string } | null> {
  if (!bridge?.isReady || !bridge.metadataAvailable) return null;

  try {
    const result = await bridge.addFieldModification(extensionName, fieldName, fieldLabel, fieldMandatory);
    return {
      success: result.success,
      message: result.success
        ? `✅ Field modification '${fieldName}' applied via ${result.api}`
        : `Bridge addFieldModification returned success=false`,
    };
  } catch (e) {
    console.error(`[BridgeAdapter] addFieldModification(${extensionName}, ${fieldName}) failed: ${e}`);
    return null;
  }
}

// ════════════════════════════════════════════════════════════════════════
// MENU: ADD MENU ITEM TO MENU
// ════════════════════════════════════════════════════════════════════════

/**
 * Adds a menu item reference to a menu via the C# bridge.
 */
export async function bridgeAddMenuItemToMenu(
  bridge: BridgeClient | undefined,
  menuName: string,
  menuItemToAdd: string,
  menuItemToAddType?: string,
): Promise<{ success: boolean; message: string } | null> {
  if (!bridge?.isReady || !bridge.metadataAvailable) return null;

  try {
    const result = await bridge.addMenuItemToMenu(menuName, menuItemToAdd, menuItemToAddType);
    return {
      success: result.success,
      message: result.success
        ? `✅ Menu item '${menuItemToAdd}' added via ${result.api}`
        : `Bridge addMenuItemToMenu returned success=false`,
    };
  } catch (e) {
    console.error(`[BridgeAdapter] addMenuItemToMenu(${menuName}, ${menuItemToAdd}) failed: ${e}`);
    return null;
  }
}

// ════════════════════════════════════════════════════════════════════════
// BATCH MODIFY
// ════════════════════════════════════════════════════════════════════════

/**
 * Executes multiple write operations on a single object in one bridge call.
 * Returns a formatted ToolResult or null if bridge unavailable.
 */
export async function bridgeBatchModify(
  bridge: BridgeClient | undefined,
  objectType: string,
  objectName: string,
  operations: Array<{ operation: string; params?: Record<string, unknown> }>,
): Promise<ToolResult | null> {
  if (!bridge?.isReady || !bridge.metadataAvailable) return null;

  try {
    const result = await bridge.batchModify(objectType, objectName, operations);
    let text = `## Batch Modify: ${objectType} \`${objectName}\`\n\n`;
    text += `- **Total:** ${result.totalOperations}\n`;
    text += `- **Success:** ${result.successCount}\n`;
    text += `- **Failed:** ${result.failureCount}\n\n`;

    if (result.operations.length > 0) {
      text += `### Operations\n\n`;
      for (const op of result.operations) {
        const icon = op.success ? '✅' : '❌';
        text += `${icon} **${op.operation}** (${op.elapsedMs}ms)`;
        if (op.error) text += ` — ${op.error}`;
        text += `\n`;
      }
    }

    return {
      content: [{ type: 'text', text }],
      isError: result.failureCount > 0,
    };
  } catch (e) {
    console.error(`[BridgeAdapter] batchModify(${objectType}, ${objectName}) failed: ${e}`);
    return null;
  }
}

// ════════════════════════════════════════════════════════════════════════
// CAPABILITIES
// ════════════════════════════════════════════════════════════════════════

/**
 * Retrieves the structured capabilities map from the C# bridge.
 * Returns a formatted ToolResult or null if bridge unavailable.
 */
export async function bridgeGetCapabilities(
  bridge: BridgeClient | undefined,
): Promise<ToolResult | null> {
  if (!bridge?.isReady || !bridge.metadataAvailable) return null;

  try {
    const caps = await bridge.getCapabilities();
    let text = `# Bridge Capabilities (v${caps.version})\n\n`;

    for (const [objType, operations] of Object.entries(caps.objectTypes)) {
      text += `## ${objType}\n`;
      for (const op of operations) {
        text += `- \`${op}\`\n`;
      }
      text += `\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (e) {
    console.error(`[BridgeAdapter] getCapabilities() failed: ${e}`);
    return null;
  }
}

// ════════════════════════════════════════════════════════════════════════
// FORM PATTERN DISCOVERY
// ════════════════════════════════════════════════════════════════════════

/**
 * Discovers available D365FO form patterns from the Patterns DLL or fallback list.
 * Returns a formatted ToolResult or null if bridge unavailable.
 */
export async function bridgeDiscoverFormPatterns(
  bridge: BridgeClient | undefined,
): Promise<ToolResult | null> {
  if (!bridge?.isReady || !bridge.metadataAvailable) return null;

  try {
    const result = await bridge.discoverFormPatterns();
    let text = `# D365FO Form Patterns (${result.count})\n`;
    text += `_Source: ${result.source}_\n\n`;

    for (const p of result.patterns) {
      text += `- **${p.name}**`;
      if (p.version) text += ` (v${p.version})`;
      if (p.description) text += ` — ${p.description}`;
      text += `\n`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (e) {
    console.error(`[BridgeAdapter] discoverFormPatterns() failed: ${e}`);
    return null;
  }
}

// ════════════════════════════════════════════════════════════════════════
// SECURITY ARTIFACT (Phase 6)
// ════════════════════════════════════════════════════════════════════════

export async function tryBridgeSecurityArtifact(
  bridge: BridgeClient | undefined,
  name: string,
  artifactType: 'privilege' | 'duty' | 'role',
  includeChain: boolean,
): Promise<ToolResult | null> {
  if (!bridge?.isReady || !bridge.metadataAvailable) return null;
  try {
    if (artifactType === 'privilege') {
      const priv = await bridge.readSecurityPrivilege(name);
      if (!priv) return null;
      return { content: [{ type: 'text', text: formatSecurityPrivilege(priv, includeChain) }] };
    } else if (artifactType === 'duty') {
      const duty = await bridge.readSecurityDuty(name);
      if (!duty) return null;
      return { content: [{ type: 'text', text: formatSecurityDuty(duty, includeChain) }] };
    } else {
      const role = await bridge.readSecurityRole(name);
      if (!role) return null;
      return { content: [{ type: 'text', text: formatSecurityRole(role, includeChain) }] };
    }
  } catch (e) {
    console.error(`[BridgeAdapter] readSecurity${artifactType}(${name}) failed: ${e}`);
    return null;
  }
}

function formatSecurityPrivilege(priv: BridgeSecurityPrivilegeResult, _includeChain: boolean): string {
  let out = `SecurityPrivilege: ${priv.name}\n`;
  if (priv.label) out += `Label: ${priv.label}\n`;
  if (priv.description) out += `Description: ${priv.description}\n`;
  if (priv.model) out += `Model: ${priv.model}\n`;
  out += `_Source: C# bridge (IMetadataProvider)_\n`;

  if (priv.entryPoints.length > 0) {
    out += `\nEntry Points (${priv.entryPoints.length}):\n`;
    for (const ep of priv.entryPoints) {
      out += `  ✓ ${ep.objectName ?? '(unnamed)'} [${ep.objectType ?? '?'}]  → ${ep.accessLevel ?? '?'} access\n`;
    }
  } else {
    out += `\nEntry Points: none\n`;
  }

  if (priv.parentDuties.length > 0) {
    out += `\nUsed in Duties (${priv.parentDuties.length}):\n`;
    out += `  ${priv.parentDuties.map(d => d.name).join(', ')}\n`;
  }

  return out;
}

function formatSecurityDuty(duty: BridgeSecurityDutyResult, _includeChain: boolean): string {
  let out = `SecurityDuty: ${duty.name}\n`;
  if (duty.label) out += `Label: ${duty.label}\n`;
  if (duty.description) out += `Description: ${duty.description}\n`;
  if (duty.model) out += `Model: ${duty.model}\n`;
  out += `_Source: C# bridge (IMetadataProvider)_\n`;

  if (duty.childPrivileges.length > 0) {
    out += `\nPrivileges (${duty.childPrivileges.length}):\n`;
    for (const p of duty.childPrivileges) {
      out += `  • ${p.name}\n`;
    }
  }

  if (duty.subDuties.length > 0) {
    out += `\nSub-Duties (${duty.subDuties.length}):\n`;
    for (const d of duty.subDuties) {
      out += `  • ${d.name}\n`;
    }
  }

  if (duty.parentRoles.length > 0) {
    out += `\nAssigned to Roles (${duty.parentRoles.length}):\n`;
    out += `  ${duty.parentRoles.map(r => r.name).join(', ')}\n`;
  }

  return out;
}

function formatSecurityRole(role: BridgeSecurityRoleResult, _includeChain: boolean): string {
  let out = `SecurityRole: ${role.name}\n`;
  if (role.label) out += `Label: ${role.label}\n`;
  if (role.description) out += `Description: ${role.description}\n`;
  if (role.model) out += `Model: ${role.model}\n`;
  out += `_Source: C# bridge (IMetadataProvider)_\n`;

  if (role.childDuties.length > 0) {
    out += `\nDuties (${role.childDuties.length}):\n`;
    for (const d of role.childDuties) {
      out += `  • ${d.name}\n`;
    }
  }

  if (role.childPrivileges.length > 0) {
    out += `\nDirect Privileges (${role.childPrivileges.length}):\n`;
    for (const p of role.childPrivileges) {
      out += `  • ${p.name}\n`;
    }
  }

  if (role.subRoles.length > 0) {
    out += `\nSub-Roles (${role.subRoles.length}):\n`;
    for (const sr of role.subRoles) {
      out += `  • ${sr.name}\n`;
    }
  }

  return out;
}

// ════════════════════════════════════════════════════════════════════════
// MENU ITEM (Phase 6)
// ════════════════════════════════════════════════════════════════════════

export async function tryBridgeMenuItem(
  bridge: BridgeClient | undefined,
  name: string,
  itemType?: string,
): Promise<ToolResult | null> {
  if (!bridge?.isReady || !bridge.metadataAvailable) return null;
  try {
    const mi = await bridge.readMenuItem(name, itemType);
    if (!mi) return null;
    return { content: [{ type: 'text', text: formatMenuItem(mi) }] };
  } catch (e) {
    console.error(`[BridgeAdapter] readMenuItem(${name}) failed: ${e}`);
    return null;
  }
}

function formatMenuItem(mi: BridgeMenuItemResult): string {
  const typeLabel = mi.menuItemType === 'display' ? 'MenuItemDisplay'
    : mi.menuItemType === 'action' ? 'MenuItemAction'
    : 'MenuItemOutput';

  let out = `${typeLabel}: ${mi.name}\n`;
  if (mi.label) out += `Label: ${mi.label}\n`;
  if (mi.model) out += `Model: ${mi.model}\n`;
  out += `_Source: C# bridge (IMetadataProvider)_\n`;

  if (mi.object) {
    out += `Target: ${mi.object}`;
    if (mi.objectType) out += ` (${mi.objectType})`;
    out += '\n';
  }
  if (mi.openMode && mi.openMode !== 'Auto') out += `Open Mode: ${mi.openMode}\n`;
  if (mi.linkedPermissionObject) {
    out += `Security Privilege: ${mi.linkedPermissionObject}`;
    if (mi.linkedPermissionType) out += ` [${mi.linkedPermissionType}]`;
    out += '\n';
  }
  if (mi.helpText) out += `Help: ${mi.helpText}\n`;

  return out;
}

// ════════════════════════════════════════════════════════════════════════
// TABLE EXTENSIONS (Phase 6)
// ════════════════════════════════════════════════════════════════════════

export async function tryBridgeTableExtensions(
  bridge: BridgeClient | undefined,
  baseTableName: string,
): Promise<ToolResult | null> {
  if (!bridge?.isReady || !bridge.metadataAvailable) return null;
  try {
    const result = await bridge.readTableExtensions(baseTableName);
    if (!result) return null;
    return { content: [{ type: 'text', text: formatTableExtensions(result) }] };
  } catch (e) {
    console.error(`[BridgeAdapter] readTableExtensions(${baseTableName}) failed: ${e}`);
    return null;
  }
}

function formatTableExtensions(r: BridgeTableExtensionListResult): string {
  let out = `Table Extensions of: ${r.baseTable}\n`;
  out += `_Source: C# bridge (IMetadataProvider)_\n\n`;

  if (r.extensionCount === 0) {
    out += `No table extensions found.\n`;
    return out;
  }

  out += `Found ${r.extensionCount} extension(s):\n\n`;
  for (let i = 0; i < r.extensions.length; i++) {
    const ext = r.extensions[i];
    out += `[${i + 1}] ${ext.extensionName} (${ext.model ?? 'unknown'})\n`;
    if (ext.addedFields.length > 0) {
      out += `    Added Fields (${ext.addedFields.length}): ${ext.addedFields.join(', ')}\n`;
    }
    if (ext.addedIndexes.length > 0) {
      out += `    Added Indexes (${ext.addedIndexes.length}): ${ext.addedIndexes.join(', ')}\n`;
    }
    if (ext.addedFieldGroups.length > 0) {
      out += `    Added Field Groups (${ext.addedFieldGroups.length}): ${ext.addedFieldGroups.join(', ')}\n`;
    }
    if (ext.addedRelations.length > 0) {
      out += `    Added Relations (${ext.addedRelations.length}): ${ext.addedRelations.join(', ')}\n`;
    }
  }
  return out;
}

// ════════════════════════════════════════════════════════════════════════
// CODE COMPLETION (Phase 6)
// ════════════════════════════════════════════════════════════════════════

export async function tryBridgeCompletion(
  bridge: BridgeClient | undefined,
  symbolName: string,
  prefix?: string,
): Promise<ToolResult | null> {
  if (!bridge?.isReady || !bridge.metadataAvailable) return null;
  try {
    const result = await bridge.getCompletionMembers(symbolName);
    if (!result || !result.members || result.members.length === 0) return null;
    return { content: [{ type: 'text', text: formatCompletion(result, prefix) }] };
  } catch (e) {
    console.error(`[BridgeAdapter] getCompletionMembers(${symbolName}) failed: ${e}`);
    return null;
  }
}

function formatCompletion(r: BridgeCompletionResult, prefix?: string): string {
  let members = r.members;
  if (prefix) {
    const lowerPrefix = prefix.toLowerCase();
    members = members.filter(m => m.name.toLowerCase().startsWith(lowerPrefix));
  }

  let out = `# Code Completion: ${r.symbolName} (${r.symbolType})\n`;
  if (r.model) out += `**Model:** ${r.model}\n`;
  out += `_Source: C# bridge (IMetadataProvider)_\n\n`;

  if (members.length === 0) {
    out += `No members found${prefix ? ` matching prefix "${prefix}"` : ''}.\n`;
    return out;
  }

  out += `**${members.length} member(s)${prefix ? ` matching "${prefix}"` : ''}:**\n\n`;

  const methodMembers = members.filter(m => m.kind === 'method');
  const fieldMembers = members.filter(m => m.kind === 'field');

  if (methodMembers.length > 0) {
    out += `## Methods (${methodMembers.length})\n`;
    for (const m of methodMembers) {
      out += m.signature ? `- \`${m.signature}\`\n` : `- ${m.name}\n`;
    }
  }

  if (fieldMembers.length > 0) {
    out += `\n## Fields (${fieldMembers.length})\n`;
    for (const f of fieldMembers) {
      out += f.signature ? `- \`${f.signature}\`\n` : `- ${f.name}\n`;
    }
  }

  return out;
}

// ════════════════════════════════════════════════════════════════════════
// FIND COC EXTENSIONS via XREF (Phase 6)
// ════════════════════════════════════════════════════════════════════════

export async function tryBridgeCocExtensions(
  bridge: BridgeClient | undefined,
  baseClassName: string,
  methodName?: string,
): Promise<ToolResult | null> {
  if (!bridge?.isReady || !bridge.xrefAvailable) return null;
  try {
    const result = await bridge.findExtensionClasses(baseClassName);
    if (!result) return null;
    return { content: [{ type: 'text', text: formatCocExtensions(result, methodName) }] };
  } catch (e) {
    console.error(`[BridgeAdapter] findExtensionClasses(${baseClassName}) failed: ${e}`);
    return null;
  }
}

function formatCocExtensions(r: BridgeExtensionClassResult, methodNameFilter?: string): string {
  let out = `CoC Extensions of: ${r.baseClassName}\n`;
  out += `_Source: C# bridge (DYNAMICSXREFDB)_\n\n`;

  if (r.count === 0) {
    out += `No class extensions found via cross-reference database.\n`;
    return out;
  }

  // Apply method filter if specified
  let filtered = r.extensions;
  if (methodNameFilter) {
    filtered = r.extensions.filter(ext =>
      ext.wrappedMethods?.some(m => m.toLowerCase() === methodNameFilter.toLowerCase())
      || !ext.wrappedMethods || ext.wrappedMethods.length === 0
    );
  }

  out += `Found ${filtered.length} extension class(es)${methodNameFilter ? ` wrapping "${methodNameFilter}"` : ''}:\n\n`;
  const seen = new Set<string>();
  for (const ext of filtered) {
    if (seen.has(ext.className)) continue;
    seen.add(ext.className);
    out += `- **${ext.className}**`;
    if (ext.module) out += ` (${ext.module})`;
    if (ext.wrappedMethods && ext.wrappedMethods.length > 0) {
      out += `\n    Wraps methods: ${ext.wrappedMethods.join(', ')}`;
      out += `\n    Uses 'next' keyword: ✓`;
    }
    out += `\n`;
  }
  return out;
}

// ════════════════════════════════════════════════════════════════════════
// FIND EVENT HANDLERS via XREF (Phase 6)
// ════════════════════════════════════════════════════════════════════════

export async function tryBridgeEventHandlers(
  bridge: BridgeClient | undefined,
  targetName: string,
  eventName?: string,
  handlerType?: string,
): Promise<ToolResult | null> {
  if (!bridge?.isReady || !bridge.xrefAvailable) return null;
  try {
    const result = await bridge.findEventSubscribers(targetName, eventName, handlerType);
    if (!result) return null;
    return { content: [{ type: 'text', text: formatEventHandlers(result) }] };
  } catch (e) {
    console.error(`[BridgeAdapter] findEventSubscribers(${targetName}) failed: ${e}`);
    return null;
  }
}

function formatEventHandlers(r: BridgeEventSubscriberResult): string {
  let out = `Event Handlers for: ${r.targetName}\n`;
  out += `_Source: C# bridge (DYNAMICSXREFDB)_\n\n`;

  if (r.count === 0) {
    out += `No event handlers found via cross-reference database.\n`;
    return out;
  }

  out += `Found ${r.count} handler(s):\n\n`;

  // Group by handler type
  const byType = new Map<string, typeof r.handlers>();
  for (const h of r.handlers) {
    const type = h.handlerType || 'static';
    if (!byType.has(type)) byType.set(type, []);
    byType.get(type)!.push(h);
  }

  for (const [type, handlers] of byType) {
    out += `### ${type} handlers (${handlers.length})\n\n`;
    for (const h of handlers) {
      out += `- **${h.className}**`;
      if (h.methodName) out += `.${h.methodName}`;
      if (h.module) out += ` (${h.module})`;
      if (h.eventName) out += ` — event: ${h.eventName}`;
      out += `\n`;
    }
    out += `\n`;
  }
  return out;
}

// ════════════════════════════════════════════════════════════════════════
// API USAGE CALLERS via XREF (P5)
// ════════════════════════════════════════════════════════════════════════

export async function tryBridgeApiUsageCallers(
  bridge: BridgeClient | undefined,
  apiName: string,
  limit = 200,
): Promise<ToolResult | null> {
  if (!bridge?.isReady || !bridge.xrefAvailable) return null;
  try {
    const result = await bridge.findApiUsageCallers(apiName, limit);
    if (!result || result.totalCallers === 0) return null;
    return { content: [{ type: 'text', text: formatApiUsageCallers(result) }] };
  } catch (e) {
    console.error(`[BridgeAdapter] findApiUsageCallers(${apiName}) failed: ${e}`);
    return null;
  }
}

function formatApiUsageCallers(r: BridgeApiUsageCallersResult): string {
  let out = `# API Usage: ${r.apiName}\n\n`;
  out += `**Total references:** ${r.totalCallers} from ${r.uniqueClasses} unique class(es)\n`;
  out += `_Source: C# bridge (DYNAMICSXREFDB)_\n\n`;

  out += `## Top Callers by Class\n\n`;
  for (const cls of r.callersByClass.slice(0, 30)) {
    out += `- **${cls.callerClass}** (${cls.callCount} call(s))`;
    if (cls.module) out += ` [${cls.module}]`;
    if (cls.methods.length > 0) {
      out += `\n    Methods: ${cls.methods.slice(0, 8).join(', ')}`;
      if (cls.methods.length > 8) out += ` (+${cls.methods.length - 8} more)`;
    }
    out += `\n`;
  }

  if (r.callersByClass.length > 30) {
    out += `\n> ⚠️ Showing top 30 of ${r.uniqueClasses} caller classes.\n`;
  }

  return out;
}
