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

    const visible = refs.references.slice(0, limit);
    for (const r of visible) {
      const module = r.sourceModule ? ` [${r.sourceModule}]` : '';
      const loc = r.line > 0 ? `:${r.line}` : '';
      out += `- **${r.sourcePath}**${loc}${module}\n`;
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
    // Refresh so DiskProvider sees the new/modified file
    await bridge.refreshProvider();
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
 * Covers core types + menu items + security objects + query/view.
 * Forms and reports continue using TypeScript XML generation (complex nested designs).
 */
const BRIDGE_CREATE_TYPES = new Set([
  'class', 'table', 'enum', 'edt',
  'query', 'view',
  'menu-item-action', 'menu-item-display', 'menu-item-output',
  'security-privilege', 'security-duty', 'security-role',
]);

/**
 * Supported operations for bridge-based modification.
 * Other operations (add-index, add-relation, add-control, add-data-source, etc.)
 * continue using the TypeScript xml2js approach.
 */
const BRIDGE_MODIFY_OPS = new Set(['add-method', 'add-field', 'modify-property', 'replace-code']);

/**
 * Supported object types for bridge-based modification.
 * Covers core types + query/view/form (add-method, modify-property, replace-code)
 * + menu items and security (modify-property only).
 */
const BRIDGE_MODIFY_TYPES = new Set([
  'class', 'table', 'enum', 'edt',
  'form', 'query', 'view',
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
    return null;
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
