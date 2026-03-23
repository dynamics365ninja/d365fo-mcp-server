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
    const text =
      `# ${ms.className}.${ms.methodName}\n\n` +
      `_Source: C# bridge (IMetadataProvider)_\n\n` +
      `\`\`\`xpp\n${ms.source}\n\`\`\``;
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

    let out = `# EDT: ${edt.name}\n\n`;
    if (edt.baseType) out += `**Base Type:** ${edt.baseType}\n`;
    if (edt.extends) out += `**Extends:** ${edt.extends}\n`;
    if (edt.label) out += `**Label:** ${edt.label}\n`;
    if (edt.helpText) out += `**Help Text:** ${edt.helpText}\n`;
    if (edt.stringSize) out += `**String Size:** ${edt.stringSize}\n`;
    if (edt.enumType) out += `**Enum Type:** ${edt.enumType}\n`;
    if (edt.referenceTable) out += `**Reference Table:** ${edt.referenceTable}\n`;
    if (edt.model) out += `**Model:** ${edt.model}\n`;
    out += `_Source: C# bridge (IMetadataProvider)_\n`;

    return { content: [{ type: 'text', text: out }] };
  } catch (e) {
    console.error(`[BridgeAdapter] readEdt(${edtName}) failed: ${e}`);
    return null;
  }
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

    let out = `# Form: ${form.name}\n\n`;
    if (form.model) out += `**Model:** ${form.model}\n`;
    out += `_Source: C# bridge (IMetadataProvider)_\n\n`;

    out += `## Data Sources (${form.dataSources.length})\n\n`;
    for (const ds of form.dataSources) {
      const join = ds.joinSource ? ` (join: ${ds.joinSource})` : '';
      out += `- **${ds.name}** → ${ds.table}${join}\n`;
    }

    out += `\n## Controls (${form.controls.length} top-level)\n\n`;
    formatControlTree(form.controls, out, 0);
    // formatControlTree appends to a local — rebuild via helper
    out += buildControlTree(form.controls, 0);

    return { content: [{ type: 'text', text: out }] };
  } catch (e) {
    console.error(`[BridgeAdapter] readForm(${formName}) failed: ${e}`);
    return null;
  }
}

function buildControlTree(controls: Array<{ name: string; controlType: string; dataSource?: string; dataField?: string; children?: any[] }>, depth: number): string {
  if (!controls || depth > 10) return '';
  let out = '';
  const indent = '  '.repeat(depth);
  for (const c of controls) {
    const binding = c.dataSource && c.dataField ? ` [${c.dataSource}.${c.dataField}]` : '';
    out += `${indent}- **${c.name}** (${c.controlType})${binding}\n`;
    if (c.children?.length) {
      out += buildControlTree(c.children, depth + 1);
    }
  }
  return out;
}

function formatControlTree(_controls: any[], _out: string, _depth: number): void {
  // no-op — buildControlTree handles this
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
