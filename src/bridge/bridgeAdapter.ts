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
 *
 * ERROR CONTRACT — `null` means "the bridge is not in play, or it answered and the
 * object is not there". It does NOT mean "the bridge blew up": a thrown call goes
 * through `recordBridgeFailure`, which keeps the reason on the current tool call so
 * the dispatcher can label the index fallback instead of letting a bridge outage
 * pass for a missing object. The few wrappers whose caller must act differently on a
 * failure (create/resolve — they fall back to XML generation and would otherwise
 * report ✅ for a write the bridge never performed) return `BridgeAttempt<T>` and
 * hand back the `BridgeFailure` itself; discriminate with `isBridgeFailure` before
 * the truthiness check.
 */

import type { BridgeClient } from './bridgeClient.js';
import { recordBridgeFailure } from './bridgeFailure.js';
import { markRefreshStarted } from './debouncedRefresh.js';
import type { BridgeAttempt } from './bridgeFailure.js';
import * as debouncedRefresh from './debouncedRefresh.js';
import { debugLog } from '../utils/logger.js';
import { xppMethodSourceForXml } from '../utils/xppFormat.js';
import { ensureXppDocComment, ensureBlankLineBeforeClosingBrace } from '../utils/xppDocGen.js';
import { parseXppDeclaration, parseXppClassHeader } from '../metadata/xppDeclaration.js';
import { rankCustomFirst, isExactNameMatch } from '../utils/exactMatchRanking.js';
import { COMPACT_METHODS_HINT, fullBodyHint } from '../utils/methodBodyHint.js';
import {
  pageFields, fieldsHeading, fieldsFooter,
  createControlBudget, chargeControl, chargeSkippedSubtree, controlsFooter,
  type ControlBudget,
} from '../utils/payloadBudget.js';
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
  BridgeReferenceInfo,
} from './bridgeTypes.js';

/** Standard MCP tool response shape */
export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

// TABLE

const TABLE_METHOD_PAGE_SIZE = 25;

/**
 * ── SEAM for the C#-side method paging (deliberately left for a later phase) ──
 *
 * MEASURED: `readTable("CustTable")` ships all ~120 methods WITH full source
 * across the pipe, and this adapter then renders one page of 25 (15 for a class).
 * Everything else was parsed out of JSON and dropped on the floor. The same is
 * true of `readClass`.
 *
 * The C# side cannot be changed in this phase (another agent owns bridge/), so
 * the paging is made EXPLICIT here instead of implicit in a `.slice()`: this is
 * the single place that decides which methods a table response needs and whether
 * it needs their bodies. When `readTable` grows `includeSource` / `methodLimit` /
 * `methodOffset` request parameters, they are populated from exactly this object
 * — `bridge.readTable(tableName, methodPageRequest(methodOffset, wantBodies))` —
 * and nothing below has to change, because the renderer already asks for no more
 * than it prints.
 *
 * Same shape is intended for classes (CLASS_METHOD_PAGE_SIZE, formatClass).
 */
export interface BridgeMethodPageRequest {
  /** First method to render (the caller's methodOffset). */
  offset: number;
  /** How many methods this response renders — never more than one page. */
  limit: number;
  /** Whether the BODIES are actually rendered; false = signature lines only. */
  includeSource: boolean;
}

/**
 * MEASURED before you build the C# half: do not.
 *
 * The obvious next step from this seam is to push offset/limit into readTable /
 * readClass so the bridge stops shipping every method (and its Source) for a
 * response that renders 25 of them. It buys nothing. First, uncached reads over
 * stdio against the real metadata, 2026-08-25:
 *
 *     table SalesLine          808 methods   255 ms
 *     table CustTable          222 methods   962 ms   <- first bridge read overall
 *     class SalesFormLetter    179 methods   368 ms
 *     table CustPaymModeTable   39 methods   254 ms
 *     table CustGroup           16 methods    66 ms
 *
 * Method count does not predict latency — four times the methods runs four
 * times faster — and every repeat read is 1-2 ms. CustTable's 962 ms is the
 * provider warming up, not serialisation. The bytes that mattered were the ones
 * reaching the MODEL, and those are already gone: this reader went from 20,199
 * to ~7,000 chars by rendering less, not by transferring less.
 *
 * The seam stays because paging the RENDER is worth doing and this is where it
 * is decided. If a future change makes the transfer itself expensive, re-measure
 * first — this table is what to beat.
 */
export function methodPageRequest(
  offset: number, includeSource: boolean, limit = TABLE_METHOD_PAGE_SIZE,
): BridgeMethodPageRequest {
  return { offset: Math.max(0, offset), limit, includeSource };
}

/**
 * What a table response renders beyond the always-present fields/indexes.
 *
 * MEASURED (live harness, 2026-08-25): `get_object_info(objectType="table",
 * name="CustTable")` returned 20,199 chars — 50 fields, 20 indexes, ALL 75
 * relations in full, and 25 methods WITH their bodies — and `options:{compact:true}`
 * returned byte-identical 20,199 chars, i.e. compact did nothing for tables. The
 * class reader answers the same question in 1,241 chars because it is
 * signature-only by default. This is the most-called tool in the corpus (286 of
 * 1,400 calls) and its result is re-read by every later request in the session,
 * so those bytes are paid many times over.
 */
export interface TableRenderOptions {
  /** false → method BODIES (the old default). Default true: signatures only. */
  compact?: boolean;
  /** true → the full relation list with its constraints. Default false. */
  relations?: boolean;
}

export async function tryBridgeTable(
  bridge: BridgeClient | undefined,
  tableName: string,
  methodOffset = 0,
  fieldsOffset = 0,
  fieldFilter?: string,
  render: TableRenderOptions = {},
): Promise<ToolResult | null> {
  if (!bridge?.isReady || !bridge.metadataAvailable) return null;
  try {
    const t = await bridge.readTable(tableName);
    if (!t) return null;
    return { content: [{ type: 'text', text: formatTable(t, methodOffset, fieldsOffset, fieldFilter, render) }] };
  } catch (e) {
    recordBridgeFailure(`readTable(${tableName})`, e);
    return null;
  }
}

function formatTable(
  t: BridgeTableInfo,
  methodOffset: number,
  fieldsOffset = 0,
  fieldFilter?: string,
  render: TableRenderOptions = {},
): string {
  const compact = render.compact !== false;
  const showRelations = render.relations === true || !compact;
  let out = `# Table: ${t.name}\n\n`;
  if (t.label) out += `**Label:** ${t.label}\n`;
  if (t.tableGroup) out += `**Table Group:** ${t.tableGroup}\n`;
  if (t.model) out += `**Model:** ${t.model}\n`;
  if (t.extends) out += `**Extends:** ${t.extends}\n`;
  if (t.cacheLookup) out += `**CacheLookup:** ${t.cacheLookup}\n`;
  if (t.clusteredIndex) out += `**ClusteredIndex:** ${t.clusteredIndex}\n`;
  if (t.primaryIndex) out += `**PrimaryIndex:** ${t.primaryIndex}\n`;
  out += `_Source: C# bridge (IMetadataProvider)_\n\n`;

  // Fields — paged like methods below. A Microsoft table can carry 400+ fields,
  // which dominated this response and was paid again on every re-read.
  const fieldPage = pageFields(t.fields, fieldsOffset, fieldFilter);
  out += `## ${fieldsHeading(fieldPage)}\n\n`;
  out += `_Field type is shown as explicit EDT when available._\n\n`;
  if (fieldPage.matched === 0 && fieldPage.filter) {
    out += `_No field name contains "${fieldPage.filter}" — drop \`fieldFilter\` to list all ${fieldPage.total}._\n`;
  }
  for (const f of fieldPage.visible) {
    const required = f.mandatory ? ' **(required)**' : '';
    const label = f.label ? ` - ${f.label}` : '';
    const typeInfo = f.extendedDataType
      ? `EDT: ${f.extendedDataType} (base: ${f.fieldType})`
      : `Type: ${f.fieldType}`;
    out += `- **${f.name}**: ${typeInfo}${required}${label}\n`;
  }
  out += fieldsFooter(fieldPage);

  // Indexes
  out += `\n## Indexes (${t.indexes.length})\n\n`;
  for (const idx of t.indexes) {
    const unique = !idx.allowDuplicates ? ' **(unique)**' : '';
    const fieldNames = idx.fields.map((f: any) => typeof f === 'string' ? f : f.dataField ?? f.name).join(', ');
    out += `- **${idx.name}**: [${fieldNames}]${unique}\n`;
  }

  // Relations — the single largest block on a Microsoft table (CustTable: 75 of
  // them, ~7 KB with their constraints) and the one least often the reason the
  // table was read. Withheld by default, never silently: the count and the exact
  // option that returns them are printed, so nothing disappears without saying so.
  if (showRelations) {
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
  } else if (t.relations.length > 0) {
    out += `\n## Relations (${t.relations.length}) — not listed\n\n` +
      `> 💡 ${t.relations.length} relation(s) exist. \`options:{"relations":true}\` lists them with their constraints.\n`;
  }

  // Methods — signature lines by default, the same shape the class reader has
  // always used. `compact:false` restores the bodies.
  if (t.methods.length > 0) {
    const page = methodPageRequest(methodOffset, !compact);
    const visible = t.methods.slice(page.offset, page.offset + page.limit);
    const total = t.methods.length;
    const hasMore = page.offset + page.limit < total;

    out += `\n## Methods (${total} total`;
    if (total > page.limit) {
      out += `, showing ${page.offset + 1}–${Math.min(page.offset + page.limit, total)}`;
    }
    out += `)\n\n`;

    for (const m of visible) {
      if (page.includeSource) {
        out += `### ${m.name}\n\n`;
        if (m.source) {
          const preview = m.source.substring(0, 500);
          out += `\`\`\`xpp\n${preview}${m.source.length > 500 ? `\n// ... (${fullBodyHint(m.name)})` : ''}\n\`\`\`\n\n`;
        }
      } else {
        out += `- \`${methodSignatureLine(m.name, m.source)}\`\n`;
      }
    }

    if (hasMore) {
      out += `\n> ⚠️ **${total - page.offset - page.limit} more methods.** Call again with \`methodOffset: ${page.offset + page.limit}\`.\n`;
    }
    // Same escape hatch the class view prints, for the same reason: this list is
    // the only place a caller who did not read the tool schema learns that bodies
    // exist and were withheld rather than absent.
    if (!page.includeSource && visible.some(m => m.source)) {
      out += `\n${COMPACT_METHODS_HINT}\n`;
    }
    out += `\n`;
  }

  return out;
}

// CLASS

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
    recordBridgeFailure(`readClass(${className})`, e);
    return null;
  }
}

/**
 * The one-line signature shown per method in the compact class view.
 *
 * This used to be `source.split('\n')[0]`, which for any method whose body opens
 * with an XML doc comment rendered the METHOD NAME as `/// <summary>`: on
 * Foundation's CustVendVoucher, 14 of the first 15 methods came out that way
 * (L2-datetime-timezone-range run). Every documented platform class was
 * therefore unreadable through the default grounding path, while the sibling
 * `options={members:"names"}` path answered correctly.
 *
 * The declaration is located with the shared X++ parser, which handles
 * parameter lists wrapped across lines; only if that fails do we fall back to
 * the first line that is neither blank, nor a comment, nor an attribute — and
 * finally to the name the metadata itself carries, which is never wrong.
 */
export function methodSignatureLine(name: string, source?: string): string {
  if (!source) return name;

  const decl = parseXppDeclaration(source, name);
  if (decl) {
    const params = decl.parameters
      .map(p => `${p.type} ${p.name}${p.defaultValue ? ` = ${p.defaultValue}` : ''}`)
      .join(', ');
    const mods = decl.modifiers.length ? `${decl.modifiers.join(' ')} ` : '';
    return `${mods}${decl.returnType} ${decl.name}(${params})`;
  }

  const firstCode = source
    .split('\n')
    .map(l => l.trim())
    .find(l => l && !l.startsWith('///') && !l.startsWith('//') && !l.startsWith('/*') && !l.startsWith('*') && !l.startsWith('['));
  return firstCode || name;
}

function formatClass(cls: BridgeClassInfo, compact: boolean, methodOffset: number): string {
  const modifiers: string[] = [];
  if (cls.isFinal) modifiers.push('final');
  if (cls.isAbstract) modifiers.push('abstract');
  const modStr = modifiers.length > 0 ? ` (${modifiers.join(', ')})` : '';

  // The bridge sends no access modifier of its own, but it does send the
  // declaration verbatim — and that is where the modifier lives, since AxClass
  // XML has no element for it either. Parsed rather than regexed so a modifier
  // named in an attribute or a doc comment cannot be mistaken for the real one.
  const visibility = cls.declaration
    ? parseXppClassHeader(cls.declaration)?.visibility
    : undefined;

  let out = `# Class: ${cls.name}${modStr}\n\n`;
  if (cls.extends) out += `**Extends:** ${cls.extends}\n`;
  if (cls.model) out += `**Model:** ${cls.model}\n`;
  // Printed on every path, so a reader comparing two classes is not left to infer
  // package scope from a line's absence. Silent only when there was no
  // declaration to read at all (#902).
  if (cls.declaration) out += `**Access:** ${visibility ?? 'public'}\n`;
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
      out += `- \`${methodSignatureLine(m.name, m.source)}\`\n`;
    } else {
      out += `### ${m.name}\n\n`;
      if (m.source) {
        const preview = m.source.substring(0, 500);
        // Same call syntax as COMPACT_METHODS_HINT below — two different ways to
        // ask for one method body, fifteen lines apart, is the inconsistency
        // this hint exists to remove.
        out += `\`\`\`xpp\n${preview}${m.source.length > 500 ? `\n// ... (${fullBodyHint(m.name)})` : ''}\n\`\`\`\n\n`;
      }
    }
  }

  if (hasMore) {
    out += `> ⚠️ **${total - methodOffset - CLASS_METHOD_PAGE_SIZE} more methods.** Call again with \`methodOffset: ${methodOffset + CLASS_METHOD_PAGE_SIZE}\`.\n\n`;
  }

  // compact=true is the default, and this list is the only place a caller who
  // didn't read the tool schema learns that bodies exist but were withheld —
  // the DB-only fallback (classInfo.ts buildDbOnlyResponse) already says this;
  // the bridge path (the primary, "always available on VM" path) silently gave
  // signatures with no pointer to the escape hatch, which read as "no source
  // available for this class" when it was really "not requested".
  //
  // Gated on the RENDERED page carrying source, not on `total`. Bridge method
  // source is Safe(() => method.Source) and BridgeMethodInfo.source is
  // optional, so a class can come back with none: the compact:false branch
  // above then prints `### name` and no code block at all (`if (m.source)`),
  // which is strictly LESS than the signature line compact just gave — a round
  // trip spent to lose information, on exactly the classes where the caller was
  // already unsure whether source existed. The same guard covers an out-of-range
  // methodOffset, where `visible` is empty and there is no signature on the page
  // for "signatures only" to be describing.
  if (compact && visible.some(m => m.source)) {
    out += `${COMPACT_METHODS_HINT}\n\n`;
  }

  return out;
}

// METHOD SOURCE

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
    recordBridgeFailure(`getMethodSource(${className}, ${methodName})`, e);
    return null;
  }
}

// ENUM

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
    recordBridgeFailure(`readEnum(${enumName})`, e);
    return null;
  }
}

// EDT

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
    recordBridgeFailure(`readEdt(${edtName})`, e);
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
  if (edt.rootEdt && edt.rootEdt !== edt.extends) out += `| Root EDT | ${edt.rootEdt} |\n`;
  if (edt.enumType) out += `| Enum Type | ${edt.enumType} |\n`;
  if (edt.referenceTable) out += `| Reference Table | ${edt.referenceTable} |\n`;
  if (edt.relationType) out += `| Relation Type | ${edt.relationType} |\n`;
  // A derived EDT usually inherits its StringSize rather than declaring one, and a value it
  // does declare can still be overridden by an ancestor's. Say where the number came from
  // whenever it is not what this EDT's own XML said.
  if (edt.stringSize) {
    const from = edt.stringSizeInheritedFrom ? ` (inherited from ${edt.stringSizeInheritedFrom})` : '';
    const size = edt.stringSize === -1 ? '-1 (memo, unlimited)' : String(edt.stringSize);
    out += `| String Size | ${size}${from} |\n`;
  }
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

// FORM

export async function tryBridgeForm(
  bridge: BridgeClient | undefined,
  formName: string,
  maxControls?: number,
): Promise<ToolResult | null> {
  if (!bridge?.isReady || !bridge.metadataAvailable) return null;
  try {
    const form = await bridge.readForm(formName);
    if (!form) return null;
    return { content: [{ type: 'text', text: formatForm(form, maxControls) }] };
  } catch (e) {
    recordBridgeFailure(`readForm(${formName})`, e);
    return null;
  }
}

function formatForm(form: BridgeFormInfo, maxControls?: number): string {
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

  // Controls tree with extra properties. Capped: a platform form's tree runs to
  // >1000 nodes and there was no limit at all, so one read of SalesTable buried
  // everything else in the response.
  const budget = createControlBudget(maxControls);
  out += `## 🎨 Controls (${form.controls.length} top-level)\n\n`;
  out += buildControlTreeV2(form.controls, 0, budget);
  out += controlsFooter(budget);

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

function buildControlTreeV2(controls: BridgeFormControl[], depth: number, budget: ControlBudget): string {
  if (!controls || depth > 10) return '';
  let out = '';
  const indent = '  '.repeat(depth);
  for (const c of controls) {
    if (!chargeControl(budget)) {
      // Over budget: the node and everything under it are omitted, but still
      // counted so the footer reports a true remainder rather than "1 more".
      chargeSkippedSubtree(budget, c.children?.length ? countControls(c.children) : 0);
      continue;
    }
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
      out += buildControlTreeV2(c.children, depth + 1, budget);
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

// FIND REFERENCES

/**
 * Outcome of a bridge where-used lookup. The caller must distinguish a clean
 * empty result (authoritative "no references") from an error or an unavailable
 * bridge — in the latter cases falling back to the name-only FTS scan is right,
 * but for a clean empty it must NOT (that would re-introduce the over-reporting).
 */
export type BridgeReferencesOutcome =
  | { status: 'ok'; result: ToolResult }
  | { status: 'empty' }
  | { status: 'error' }
  | { status: 'unavailable' };

export async function tryBridgeReferences(
  bridge: BridgeClient | undefined,
  target: string | string[],
  limit = 50,
  displayName?: string,
  formatAs: 'default' | 'label' = 'default',
): Promise<BridgeReferencesOutcome> {
  if (!bridge?.isReady || !bridge.xrefAvailable) return { status: 'unavailable' };
  // Accept several candidate paths (e.g. one per container type when an owner
  // name collides across Tables/Classes) — query each and merge. Each source
  // reference targets a distinct path, so there are no cross-candidate dupes.
  const targets = Array.isArray(target) ? target : [target];
  const label = displayName ?? targets[0];

  // Query each candidate independently: a failing one — a thrown RPC error or an
  // in-band SQL error from the C# bridge (resolves with `error` set, count 0) —
  // must not abort the others, and must be remembered so we never report a
  // transient failure as an authoritative "0 references".
  const merged: BridgeReferenceInfo[] = [];
  let errored = false;
  for (const t of targets) {
    try {
      const r = await bridge.findReferences(t);
      if (r?.error) errored = true;
      if (r?.references?.length) merged.push(...r.references);
    } catch (e) {
      errored = true;
      recordBridgeFailure(`findReferences(${t})`, e);
    }
  }

  // No rows: "empty" is authoritative only when nothing went wrong; otherwise
  // signal "error" so the caller falls back instead of trusting the 0.
  if (merged.length === 0) return errored ? { status: 'error' } : { status: 'empty' };

  // Labels are referenced from every object type (tables, forms, EDTs, enums,
  // reports, menu items, security objects, …), mostly via declarative metadata
  // properties rather than X++ code — so they get a dedicated formatter that
  // groups by source object type and surfaces the referencing property.
  if (formatAs === 'label') {
    return { status: 'ok', result: formatLabelReferences(merged, label, limit) };
  }

  {
    const refs = { count: merged.length, references: merged };

    let out = `# References to \`${label}\`\n\n`;
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

    return { status: 'ok', result: { content: [{ type: 'text', text: out }] } };
  }
}

// LABEL REFERENCES (formatting)

/**
 * Friendly display name for an xref source-container segment. Handles both xref
 * path conventions seen for label references: code references use plural,
 * slash-prefixed containers ("/Classes/…", "/Tables/…"), while declarative
 * metadata references use singular containers with no leading slash
 * ("Table/…", "Form/…", "EdtString/…", "MenuItemDisplay/…").
 */
const XREF_SOURCE_TYPE_LABELS: Record<string, string> = {
  classes: 'Class', class: 'Class',
  tables: 'Table', table: 'Table', tableextension: 'Table extension',
  forms: 'Form', form: 'Form', formextension: 'Form extension',
  views: 'View', view: 'View', viewextension: 'View extension',
  maps: 'Map', map: 'Map',
  queries: 'Query', querysimple: 'Query',
  enum: 'Enum', enums: 'Enum', enumextension: 'Enum extension',
  reports: 'Report', report: 'Report',
  dataentityviews: 'Data entity', dataentityview: 'Data entity',
  compositedataentityview: 'Composite data entity', dataentityviewextension: 'Data entity extension',
  aggregatedataentity: 'Aggregate data entity', aggregatedimension: 'Aggregate dimension',
  aggregatemeasurement: 'Aggregate measurement',
  menu: 'Menu', menuextension: 'Menu extension',
  menuitemdisplay: 'Menu item (display)', menuitemaction: 'Menu item (action)', menuitemoutput: 'Menu item (output)',
  securityprivilege: 'Security privilege', securityduty: 'Security duty',
  securityrole: 'Security role', securitypolicy: 'Security policy',
  configurationkey: 'Configuration key', configurationkeygroup: 'Configuration key group',
  tile: 'Tile', kpi: 'KPI', licensecode: 'License code', resource: 'Resource',
};

function friendlyXrefSourceType(container: string): string {
  const key = container.toLowerCase();
  if (XREF_SOURCE_TYPE_LABELS[key]) return XREF_SOURCE_TYPE_LABELS[key];
  if (key.startsWith('edt')) return 'EDT';            // EdtString, EdtEnum, EdtReal, EdtInt64, …
  if (key.startsWith('workflow')) return 'Workflow';  // WorkflowTemplate, WorkflowApproval, …
  return container || 'Other';
}

interface ParsedLabelSource {
  type: string;        // friendly source type, e.g. "Form", "EDT", "Table"
  objectName: string;  // referencing object, e.g. "AbatementCertificate_IN"
  detail?: string;     // X++ method (code ref) or referencing property (metadata ref)
}

/**
 * Parse an xref source path for a label reference into (type, object, detail).
 * `detail` names *where on the object* the label is used, so a reader can jump
 * straight to it — the X++ method for code refs, or "<member> › <property>" for
 * declarative metadata refs (the referencing field / enum value / form control
 * plus the property it sits on). The member is omitted when the property is
 * declared directly on the object itself (e.g. an EDT's own HelpText).
 * Examples:
 *   "/Classes/WhsWorkManualComplete/Methods/performValidation" → Class · WhsWorkManualComplete · performValidation
 *   "Form/AbatementCertificate_IN/FormDesign/.../ShowData?Text" → Form  · AbatementCertificate_IN · ShowData › Text
 *   "Table/Foo/Fields/Bar?Label"                               → Table · Foo · Bar › Label
 *   "Enum/ABC/EnumValue/A?Label"                               → Enum  · ABC · A › Label
 *   "EdtString/ABNControllingCorporation_AU?HelpText"          → EDT   · ABNControllingCorporation_AU · HelpText
 */
function parseLabelSource(sourcePath: string): ParsedLabelSource {
  const parts = sourcePath.split('/').filter(Boolean);
  const type = friendlyXrefSourceType(parts[0] ?? '');

  let objectName = parts[1] ?? sourcePath;
  const objQ = objectName.indexOf('?');            // e.g. "EdtString/Foo?HelpText" — object is 2nd segment
  if (objQ >= 0) objectName = objectName.substring(0, objQ);

  let detail: string | undefined;
  const mi = parts.indexOf('Methods');
  if (mi >= 0 && parts[mi + 1]) {
    detail = parts[mi + 1].split('?')[0];           // X++ method name (code reference)
  } else {
    const q = sourcePath.lastIndexOf('?');
    if (q >= 0) {
      const property = sourcePath.substring(q + 1); // property: Label/Caption/HelpText/Text/…
      // The member the property sits on is the last path segment before the "?"
      // (a form control, table field, enum value, …). Keep it unless it *is* the
      // object — a property declared directly on the object needs no member.
      const member = (parts[parts.length - 1] ?? '').split('?')[0];
      detail = member && member !== objectName ? `${member} › ${property}` : property;
    }
  }
  return { type, objectName, detail };
}

/**
 * Format label where-used results, grouped by source object type. Unlike the
 * default (caller/method-oriented) formatter, this makes the object-type spread
 * explicit — a label is typically referenced far more from metadata (form
 * captions, field/EDT labels, menu-item captions, …) than from X++ code.
 */
function formatLabelReferences(references: BridgeReferenceInfo[], label: string, limit: number): ToolResult {
  type LabelRefRow = ParsedLabelSource & { module?: string; line: number };
  const parsed: LabelRefRow[] = references.map(r => ({
    ...parseLabelSource(r.sourcePath),
    module: r.sourceModule,
    line: r.line,
  }));

  let out = `# References to label \`${label}\`\n\n`;
  out += `**Total:** ${references.length} reference(s) found\n`;
  out += `_Source: C# bridge (DYNAMICSXREFDB) — includes both X++ code and declarative metadata references_\n\n`;

  // Summary: count by source object type (most-referenced first). This counts
  // ALL references, whereas the detail section below is capped at `limit` — so
  // each truncated group carries a "showing X of Y" marker to keep the two
  // sections reconcilable.
  const byType = new Map<string, number>();
  for (const p of parsed) byType.set(p.type, (byType.get(p.type) || 0) + 1);
  out += `## 📊 By source object type\n\n`;
  for (const [type, count] of [...byType.entries()].sort((a, b) => b[1] - a[1])) {
    out += `- **${type}**: ${count} reference(s)\n`;
  }
  out += `\n`;

  // Detail: grouped by type, capped at `limit` total rows
  out += `## 📍 References\n\n`;
  const visible = parsed.slice(0, limit);
  const groups = new Map<string, LabelRefRow[]>();
  for (const p of visible) {
    const bucket = groups.get(p.type) ?? [];
    bucket.push(p);
    groups.set(p.type, bucket);
  }
  for (const [type, refs] of [...groups.entries()].sort((a, b) => b[1].length - a[1].length)) {
    // When the overall `limit` truncates a group, show "shown of total" so the
    // rows below don't appear to contradict the summary count above.
    const total = byType.get(type) ?? refs.length;
    const heading = refs.length < total ? `${refs.length} of ${total}` : `${refs.length}`;
    out += `### ${type} (${heading})\n\n`;
    for (const r of refs) {
      const loc = r.line > 0 ? `:${r.line}` : '';
      const mod = r.module ? ` [${r.module}]` : '';
      const det = r.detail ? ` › ${r.detail}` : '';
      out += `- **${r.objectName}**${det}${loc}${mod}\n`;
    }
    out += `\n`;
  }

  if (references.length > limit) {
    out += `> ⚠️ Showing first ${limit} of ${references.length} references. Raise \`limit\` to see more.\n`;
  }

  return { content: [{ type: 'text', text: out }] };
}

// SEARCH

export interface BridgeSearchOptions {
  /**
   * Exact-name hits the caller already resolved from the SQLite index with an
   * index-safe probe. Used to repair defect #15: the bridge fills its result
   * window in provider-enumeration order and truncates at maxResults, so an
   * exact match can be missing entirely. Any candidate absent from the bridge
   * window is spliced in and ranked first.
   */
  exactMatches?: Array<{ name: string; type: string; model?: string }>;
  /**
   * Keyword hits from CUSTOM/ISV models the caller resolved from the SQLite
   * index (model-scoped, FTS-driven). The bridge enumerates a single merged
   * key list dominated by Microsoft standard objects and truncates at
   * maxResults, so custom matches that enumerate later never reach the client.
   * These are spliced in and ranked directly after the exact matches (ahead of
   * Microsoft standard hits) so custom code is always visible.
   */
  customMatches?: Array<{ name: string; type: string; model?: string; parentName?: string }>;
  /**
   * Fills in the MODEL for rows the bridge itself returns.
   *
   * The C# `SearchItemModel` carries a `model` property but SearchObjects never
   * populates it (Models.cs / MetadataReadService.cs), so a bridge row is name +
   * type and nothing else — while `search`'s published schema promises "returns
   * name, type, model". Rather than a second round trip per hit, the caller
   * passes a resolver backed by the SQLite index (see
   * tools/analysis/search.ts#buildBridgeMetaResolver), keyed by
   * `name.toLowerCase()::type`.
   *
   * Optional on purpose: with no resolver the rows render exactly as before.
   */
  resolveMeta?: (
    rows: Array<{ name: string; type: string }>,
  ) => Map<string, { model?: string }>;
}

/** Key of the resolveMeta map — must match tools/analysis/search.ts#metaKey. */
function searchMetaKey(name: string, type: string): string {
  return `${String(name).toLowerCase()}::${type}`;
}

export async function tryBridgeSearch(
  bridge: BridgeClient | undefined,
  query: string,
  objectType?: string,
  maxResults = 50,
  opts?: BridgeSearchOptions,
): Promise<ToolResult | null> {
  if (!bridge?.isReady || !bridge.metadataAvailable) return null;
  try {
    const sr = await bridge.searchObjects(query, objectType, maxResults);
    if (!sr) return null;

    // Splice in exact matches the bridge's truncated window missed (#15).
    //
    // …but first, honour the type filter the caller asked for, because the bridge
    // does not always honour it. Its C#-side type map has no entry for every AOT
    // kind — `report` is one — and an unmapped type runs the query UNFILTERED, so
    // `search(type="report")` answered with tables and queries and looked
    // authoritative doing it ("Cust" returned six tables). A report reached the
    // caller only when the SQLite exact-name splice happened to carry one, which
    // is why the failure looked intermittent rather than total.
    //
    // Only the BRIDGE's hits are filtered. The spliced exact and custom matches
    // are deliberately allowed to differ in type — a `table-extension` is a
    // wanted answer to a `type="table"` search for the table it extends — and
    // filtering those too would delete that behaviour.
    const rawBridgeHits = sr.results ?? [];
    const bridgeHits = objectType && objectType !== 'all'
      ? rawBridgeHits.filter(r => r.type === objectType)
      : rawBridgeHits;
    const known = new Set(bridgeHits.map(r => `${r.name.toLowerCase()}\0${r.type}`));
    const spliced: Array<{ name: string; type: string; model?: string; fromIndex?: boolean }> = [];
    for (const cand of opts?.exactMatches ?? []) {
      if (!isExactNameMatch(query, cand.name)) continue;
      if (known.has(`${cand.name.toLowerCase()}\0${cand.type}`)) continue;
      known.add(`${cand.name.toLowerCase()}\0${cand.type}`);
      spliced.push({ ...cand, fromIndex: true });
    }

    const key = (n: string, t: string) => `${n.toLowerCase()} ${t}`;
    const exactKeys = new Set(spliced.map(s => key(s.name, s.type)));
    const bridgeKeys = new Set(bridgeHits.map(r => key(r.name, r.type)));

    // Custom/ISV matches truncated out of the Microsoft-dominated bridge window:
    // splice the ones the window missed and flag them so they rank ahead of
    // Microsoft standard hits (see BridgeSearchOptions.customMatches).
    const customKeys = new Set((opts?.customMatches ?? []).map(c => key(c.name, c.type)));
    const customSpliced = (opts?.customMatches ?? [])
      .filter(c => !exactKeys.has(key(c.name, c.type)) && !bridgeKeys.has(key(c.name, c.type)))
      .map(c => ({
        name: c.name, type: c.type, model: c.model, parentName: c.parentName,
        fromIndex: true as const, custom: true as const,
      }));
    const splicedCustom = customSpliced.length;

    const merged: Array<{
      name: string; type: string; fromIndex?: boolean; custom?: boolean;
      model?: string; parentName?: string;
    }> = [
      ...spliced.map(s => ({ ...s })),
      ...customSpliced,
      ...bridgeHits.map(r => ({
        name: r.name,
        type: r.type,
        // The bridge leaves this undefined in practice (see BridgeSearchOptions
        // .resolveMeta); read it anyway so a later C#-side fix needs no change here.
        model: r.model ?? undefined,
        custom: customKeys.has(key(r.name, r.type)),
      })),
    ];
    if (merged.length === 0) return null;

    // Exact name matches first — the bridge itself returns provider order (#15).
    const ranked = rankCustomFirst(query, merged, r => r.name, r => !!r.custom)
      .slice(0, Math.max(maxResults, spliced.length + splicedCustom));

    let out = `# Search: "${query}"${objectType ? ` (type: ${objectType})` : ''}\n\n`;
    out += `**Results:** ${ranked.length}\n`;
    out += `_Source: C# bridge (IMetadataProvider)_\n\n`;

    // Model on every row, and the owning object on a method/field row.
    //
    // These rows used to render as `- **Name** (type)` while the tool's own
    // schema promised "returns name, type, model" — so the caller either guessed
    // the model or spent a get_object_info call to find out where the hit lives,
    // which is the expensive half of an answer the server already had.
    const meta = opts?.resolveMeta?.(ranked) ?? new Map<string, { model?: string }>();
    for (const r of ranked) {
      const exact = isExactNameMatch(query, r.name) ? ' ⭐ exact match' : '';
      const model = r.model ?? meta.get(searchMetaKey(r.name, r.type))?.model;
      const owner = r.parentName ? `${r.parentName}.` : '';
      out += `- **${owner}${r.name}** (${r.type})${model ? ` — ${model}` : ''}${exact}\n`;
    }

    if (spliced.length > 0) {
      out += `\n_${spliced.length} exact match(es) came from the SQLite symbol index — ` +
        `the bridge's result window (maxResults=${maxResults}) did not contain them._\n`;
    }

    if (splicedCustom > 0) {
      out += `\n_${splicedCustom} custom/ISV-model match(es) were spliced in from the ` +
        `SQLite symbol index and prioritized (bridge window maxResults=${maxResults} had truncated them)._\n`;
    }

    return { content: [{ type: 'text', text: out }] };
  } catch (e) {
    recordBridgeFailure(`searchObjects(${query})`, e);
    return null;
  }
}

// QUERY

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
    recordBridgeFailure(`readQuery(${queryName})`, e);
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

// VIEW

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
    recordBridgeFailure(`readView(${viewName})`, e);
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

// DATA ENTITY

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
    recordBridgeFailure(`readDataEntity(${entityName})`, err);
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

// REPORT (fallback only — used when XML file is not found on disk)

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
    recordBridgeFailure(`readReport(${reportName})`, e);
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

// Write-support adapters

/**
 * Refreshes the C# DiskProvider so it picks up newly written/modified files.
 * Returns elapsed time in ms, or null if bridge is unavailable.
 */
export async function bridgeRefreshProvider(
  bridge: BridgeClient | undefined,
): Promise<{ refreshed: boolean; elapsedMs: number } | null> {
  if (!bridge?.isReady || !bridge.metadataAvailable) return null;
  try {
    // Recorded so callers that only need the provider to be no older than a
    // given write can skip a redundant rebuild — see debouncedRefresh.
    debouncedRefresh.markRefreshStarted();
    return await bridge.refreshProvider();
  } catch (e) {
    recordBridgeFailure(`refreshProvider`, e);
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
      // The bridge can't read back this object type yet — not an error (the file was
      // already written). Skip silently rather than emitting a misleading warning.
      if (typeof result.reason === 'string' && result.reason.startsWith('validation-unsupported')) {
        debugLog(`[BridgeAdapter] validateAfterWrite: ${result.reason} (${objectName}) — skipped`);
        return null;
      }
      return `⚠️ **IMetadataProvider could not read back \`${objectName}\`**: ${result.reason ?? 'unknown error'}`;
    }
  } catch (e) {
    recordBridgeFailure(`validateAfterWrite(${objectType}, ${objectName})`, e);
    return null; // non-fatal — bridge validation is best-effort
  }
}

export interface BridgeResolvedObject {
  exists: boolean;
  objectType: string;
  objectName: string;
  model?: string;
}

/**
 * Resolves object existence and model via IMetadataProvider.
 * Used to locate objects without the SQLite index.
 *
 * Returns the resolution, `null` when the bridge is not in play, or a
 * `BridgeFailure` when the call threw. The distinction matters more here than
 * anywhere else in this file: the payload's whole content is `exists`, so a
 * `null`-on-throw reads as "this object does not exist" — the literal shape of the
 * historical "could not resolve" reports.
 */
export async function bridgeResolveObject(
  bridge: BridgeClient | undefined,
  objectType: string,
  objectName: string,
): Promise<BridgeAttempt<BridgeResolvedObject>> {
  if (!bridge?.isReady || !bridge.metadataAvailable) return null;
  try {
    return await bridge.resolveObjectInfo(objectType, objectName);
  } catch (e) {
    return recordBridgeFailure(`resolveObjectInfo(${objectType}, ${objectName})`, e);
  }
}

// Write operations

/**
 * Supported object types for bridge-based creation.
 * Covers core types + menu items + extensions + form + menu.
 * Complex types (report, data-entity, business-event, tile, kpi) continue
 * using TypeScript XML generation — the bridge handles them via xmlContent passthrough.
 *
 * security-privilege/security-duty/security-role and query/view are DELIBERATELY
 * excluded: the bridge's generic `properties: Dictionary<string,string>` channel
 * can't carry the structured collections these types need (EntryPoints, Privileges,
 * Duties, query data sources, etc.) — creation would "succeed" but produce an empty,
 * functionally-broken object. The local XML generators (securityPrivilegeXml.ts,
 * queryViewXml.ts, generateAxSecurityDuty/RoleXml) build these correctly instead.
 */
const BRIDGE_CREATE_TYPES = new Set([
  'class', 'class-extension', 'table', 'enum', 'edt',
  'form',
  'table-extension', 'form-extension', 'enum-extension',
  'menu',
  'menu-item-action', 'menu-item-display', 'menu-item-output',
]);

/**
 * Supported operations for bridge-based modification.
 * All modify operations are now routed through the C# bridge.
 */
const BRIDGE_MODIFY_OPS = new Set([
  'add-method', 'remove-method', 'replace-code',
  'add-field', 'modify-field', 'rename-field', 'replace-all-fields', 'remove-field',
  'add-index', 'remove-index',
  'add-full-text-index', 'remove-full-text-index',
  'add-table-mapping', 'remove-table-mapping',
  'add-relation', 'remove-relation',
  // No C# op backs these — they are served by a direct-XML writer, but they still
  // pass through the same modify gate.
  'add-delete-action', 'remove-delete-action',
  'add-field-group', 'remove-field-group', 'add-field-to-field-group',
  'modify-property',
  'add-enum-value', 'modify-enum-value', 'remove-enum-value',
  'add-control', 'add-data-source',
  // Removal of a control, and of a privilege's entry point, have no C# op either
  // (MetadataWriteService exposes no RemoveControl, and security objects have no
  // bridge write path at all) — both are served by a direct-XML writer and still
  // pass through this gate.
  // add-entry-point shipped its schema entry, op-spec, dispatcher case and writer
  // without ever being listed here, so canBridgeModify() short-circuited and the
  // whole feature was unreachable from the tool surface — dead code behind a ✅
  // schema. Both this set AND XML_ONLY_MODIFY_PAIRS have to name it; either alone
  // still returns false. (eval case L2-object-delete-and-entry-point-cleanup)
  'remove-control', 'add-entry-point', 'remove-entry-point',
  // AxIgnoreDiagnosticList is not an AOT object at all — MetadataWriteService has
  // no concept of it — so this is XML-only for the same structural reason as the
  // two above.
  'remove-diagnostic-suppression', 'add-diagnostic-suppression',
  'add-display-method', 'add-table-method',
  'add-field-modification', 'add-menu-item-to-menu',
  // No C# op exists for query ranges on entities — served entirely by a
  // direct-XML writer (data-entity is already in BRIDGE_MODIFY_TYPES).
  'add-query-range', 'remove-query-range',
  // Routed straight to the XML writer by XML_ONLY_MODIFY_PAIRS below, but the
  // dispatch gate is checked FIRST — an op absent here is refused as unknown
  // before the pair table is ever consulted.
  'report-design',
]);

/**
 * Supported object types for bridge-based modification.
 * Covers core types + query/view/form (add-method, modify-property, replace-code)
 * + menu items, security, and extension types.
 */
const BRIDGE_MODIFY_TYPES = new Set([
  'class', 'table', 'enum', 'edt',
  'form', 'query', 'view', 'data-entity',
  'class-extension', 'table-extension', 'form-extension', 'enum-extension', 'edt-extension',
  'data-entity-extension',
  'menu-item-action', 'menu-item-display', 'menu-item-output',
  'menu',
]);

/**
 * Operation → the object types it may target that BRIDGE_MODIFY_TYPES does not
 * cover, because a direct-XML writer serves the pair and the bridge never will.
 *
 * This gate is what EVERY modify operation clears before dispatch, whether or not
 * a C# op backs it, so an XML-only writer for an XML-only type has nowhere else to
 * be admitted. The pairing is per-operation rather than per-type on purpose:
 * dropping 'security-privilege' into BRIDGE_MODIFY_TYPES would also claim
 * add-method, replace-code and modify-property work on a privilege, which they do
 * not — the bridge has no write path for security objects at all (the same reason
 * they are absent from BRIDGE_CREATE_TYPES: a generic
 * Dictionary<string,string> cannot carry <EntryPoints>). The caller would then get
 * a bridge resolution failure instead of "not supported for this object type".
 */
const XML_ONLY_MODIFY_PAIRS: Record<string, ReadonlySet<string>> = {
  'add-entry-point': new Set(['security-privilege']),
  'remove-entry-point': new Set(['security-privilege']),
  'remove-diagnostic-suppression': new Set(['ignore-diagnostic-list']),
  'add-diagnostic-suppression': new Set(['ignore-diagnostic-list']),
  // An AxReport has no bridge write path at all — IMetadataProvider cannot express
  // a dataset field or a report parameter through a Dictionary<string,string> — and
  // `report` is deliberately absent from BRIDGE_MODIFY_TYPES for that reason. Without
  // this pair the caller would get "the bridge could not resolve the object" instead
  // of the operation actually running.
  'report-design': new Set(['report']),
};

/**
 * Names the properties the bridge could not write, for appending to a success message.
 *
 * The C# side has reported `unsupportedProperties` for a while, but nothing on this side
 * read it: an EDT whose stringSize had nowhere to go, or a Group control that cannot hold
 * the DataSource it was handed, still produced a bare ✅. Reporting it in C# and dropping
 * it here is the same silence with more steps.
 */
export function unappliedSuffix(result: { unsupportedProperties?: string[] }): string {
  const dropped = result.unsupportedProperties ?? [];
  if (dropped.length === 0) return '';
  return `\n⚠️ NOT applied — this object type has nowhere to store them: ${dropped.join(', ')}`;
}

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
  const type = objectType.toLowerCase();
  const op = operation.toLowerCase();
  if (!BRIDGE_MODIFY_OPS.has(op)) return false;
  return BRIDGE_MODIFY_TYPES.has(type) || (XML_ONLY_MODIFY_PAIRS[op]?.has(type) ?? false);
}

/**
 * Give a create's X++ the same doc comments and indentation the XML fallback gives it.
 *
 * The bridge stores `declaration` / `methods[].source` verbatim, and only the XML
 * writers ran `ensureXppDocComment` — so the SAME create landed documented when the
 * bridge was down and undocumented when it was up, and the undocumented one then
 * failed `run_bp_check` on `BPXmlDocNoDocumentationComments`. The agent's repair for
 * that was to hand-edit the AOT XML with a plain text tool, which is exactly the
 * bypass this server exists to remove. Doing it here covers every create type at once.
 *
 * Both helpers are idempotent, so a caller that already formatted its own source
 * (the table path does) is not disturbed.
 */
function documentAndFormat<T extends { declaration?: string; methods?: { name: string; source?: string }[] }>(
  params: T,
): T {
  return {
    ...params,
    declaration:
      params.declaration !== undefined
        ? ensureBlankLineBeforeClosingBrace(ensureXppDocComment(params.declaration))
        : undefined,
    methods: params.methods?.map(m => ({
      ...m,
      source: m.source !== undefined ? xppMethodSourceForXml(ensureXppDocComment(m.source)) : m.source,
    })),
  };
}

/**
 * Creates a D365FO object via the C# bridge (IMetadataProvider.Create()).
 *
 * Returns { success, filePath, message }, `null` when the bridge is unavailable or
 * the type is not a bridge-create type, or a `BridgeFailure` when the create threw.
 * The caller falls back to XML generation in all three cases — but only the third
 * means the object it is about to hand-write skipped IMetadataProvider entirely,
 * which is what the ✅ has to admit (the XML templates carry fewer collections than
 * the bridge does).
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
): Promise<BridgeAttempt<{ success: boolean; filePath?: string; message: string }>> {
  if (!bridge?.isReady || !bridge.metadataAvailable) return null;
  if (!canBridgeCreate(params.objectType)) return null;

  try {
    const result = await bridge.createObject(documentAndFormat(params));
    if (result.success) {
      // The C# dispatcher runs RefreshProvider() itself after a successful
      // createObject/createSmartTable (RequestDispatcher.cs, refreshAfterSuccess),
      // so the provider has ALREADY been rebuilt by the time this returns.
      // Recording it here lets the caller skip its own refresh instead of
      // paying for a second full DiskProvider rebuild of the same tree.
      markRefreshStarted();
      return {
        success: true,
        filePath: result.filePath,
        message: `✅ Created via ${result.api ?? 'IMetadataProvider'} — file: ${result.filePath}` + unappliedSuffix(result),
      };
    } else {
      return { success: false, message: `Bridge createObject returned success=false` };
    }
  } catch (e) {
    // Recoverable — the caller falls back to XML generation, so this stays at debug
    // level rather than surfacing as a client-facing error. It is still returned as
    // a BridgeFailure so the fallback can say the bridge is the reason it ran.
    return recordBridgeFailure(`createObject(${params.objectType}, ${params.objectName})`, e, { quiet: true });
  }
}

/**
 * Creates a smart table via the C# bridge with all BP-smart defaults
 * (CacheLookup, FieldGroups, DeleteActions, TitleField, PrimaryIndex) auto-set.
 *
 * Returns the result, `null` when the bridge is unavailable or declined, or a
 * `BridgeFailure` when the call threw — same reasoning as bridgeCreateObject: the
 * XML fallback that follows writes none of those BP defaults, so "the bridge threw"
 * has to reach the caller's message.
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
): Promise<BridgeAttempt<BridgeSmartTableResult>> {
  if (!bridge?.isReady || !bridge.metadataAvailable) return null;

  try {
    const result = await bridge.createSmartTable(params);
    if (result.success) {
      // The C# dispatcher runs RefreshProvider() itself after a successful
      // createObject/createSmartTable (RequestDispatcher.cs, refreshAfterSuccess),
      // so the provider has ALREADY been rebuilt by the time this returns.
      // Recording it here lets the caller skip its own refresh instead of
      // paying for a second full DiskProvider rebuild of the same tree.
      markRefreshStarted();
      console.error(`[BridgeAdapter] ✅ Smart table created: ${result.filePath} (${result.api})`);
      return result;
    } else {
      console.error(`[BridgeAdapter] createSmartTable returned success=false`);
      return null;
    }
  } catch (e) {
    // Recoverable — the caller falls back to SmartXmlBuilder, so this stays at debug
    // level; the BridgeFailure is what tells that fallback why it is running.
    return recordBridgeFailure(`createSmartTable(${params.objectName})`, e, { quiet: true });
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
    // The bridge stores sourceCode verbatim — whatever indentation the caller typed
    // (or didn't) ends up in the AOT XML as-is. Re-derive consistent indentation
    // from brace depth so ragged/flush-left input doesn't produce garbled formatting,
    // and add the doc comment `BPXmlDocNoDocumentationComments` asks for, so a method
    // added through the bridge is not the one shape of write that fails BP.
    const result = await bridge.addMethod(
      objectType,
      objectName,
      methodName,
      xppMethodSourceForXml(ensureXppDocComment(sourceCode)),
    );
    return {
      success: result.success,
      message: result.success
        ? `✅ Method '${methodName}' added via ${result.api}`
        : `Bridge addMethod returned success=false`,
    };
  } catch (e) {
    // Record into the per-call failure sink as well as returning the
    // message: without this a bridge write that THREW reached the model
    // as an ordinary failure string, with nothing saying the bridge was
    // what broke. Same stderr line as before.
    recordBridgeFailure(`addMethod(${objectType}, ${objectName}, ${methodName})`, e);
    return { success: false, message: String(e) };
  }
}

/**
 * Adds a field to a table, table-extension or data-entity-view-extension via the C#
 * bridge (IMetadataProvider.Update()).
 *
 * `mapped` carries the data-entity mapped-field binding. A mapped field has no EDT and
 * no base type — it points at a field on one of the entity's data sources — so passing
 * it switches the bridge to the AxDataEntityViewMappedField path.
 */
export async function bridgeAddField(
  bridge: BridgeClient | undefined,
  tableName: string,
  fieldName: string,
  fieldType: string,
  edt?: string,
  mandatory?: boolean,
  label?: string,
  mapped?: { dataField?: string; dataSource?: string; fieldGroupName?: string },
): Promise<{ success: boolean; message: string } | null> {
  if (!bridge?.isReady || !bridge.metadataAvailable) return null;

  try {
    const result = await bridge.addField(
      tableName, fieldName, fieldType, edt, mandatory, label,
      mapped?.dataField, mapped?.dataSource, mapped?.fieldGroupName,
    );
    return {
      success: result.success,
      message: result.success
        ? `✅ Field '${fieldName}' added via ${result.api}`
        : `Bridge addField returned success=false`,
    };
  } catch (e) {
    // Record into the per-call failure sink as well as returning the
    // message: without this a bridge write that THREW reached the model
    // as an ordinary failure string, with nothing saying the bridge was
    // what broke. Same stderr line as before.
    recordBridgeFailure(`addField(${tableName}, ${fieldName})`, e);
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
    // Record into the per-call failure sink as well as returning the
    // message: without this a bridge write that THREW reached the model
    // as an ordinary failure string, with nothing saying the bridge was
    // what broke. Same stderr line as before.
    recordBridgeFailure(`setProperty(${objectType}, ${objectName}, ${propertyPath})`, e);
    return { success: false, message: String(e) };
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
    // Record into the per-call failure sink as well as returning the
    // message: without this a bridge write that THREW reached the model
    // as an ordinary failure string, with nothing saying the bridge was
    // what broke. Same stderr line as before.
    recordBridgeFailure(`replaceCode(${objectType}, ${objectName})`, e);
    return { success: false, message: String(e) };
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
    // Record into the per-call failure sink as well as returning the
    // message: without this a bridge write that THREW reached the model
    // as an ordinary failure string, with nothing saying the bridge was
    // what broke. Same stderr line as before.
    recordBridgeFailure(`removeMethod(${objectType}, ${objectName}, ${methodName})`, e);
    return { success: false, message: String(e) };
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
    // Record into the per-call failure sink as well as returning the
    // message: without this a bridge write that THREW reached the model
    // as an ordinary failure string, with nothing saying the bridge was
    // what broke. Same stderr line as before.
    recordBridgeFailure(`addIndex(${tableName}, ${indexName})`, e);
    return { success: false, message: String(e) };
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
    // Record into the per-call failure sink as well as returning the
    // message: without this a bridge write that THREW reached the model
    // as an ordinary failure string, with nothing saying the bridge was
    // what broke. Same stderr line as before.
    recordBridgeFailure(`removeIndex(${tableName}, ${indexName})`, e);
    return { success: false, message: String(e) };
  }
}

/**
 * Adds a full-text index to a table or table-extension via the C# bridge.
 *
 * <FullTextIndexes> is a separate collection with a separate element type
 * (AxTableFullTextIndex), so add-index could never reach it.
 */
export async function bridgeAddFullTextIndex(
  bridge: BridgeClient | undefined,
  tableName: string,
  indexName: string,
  fields?: string[],
): Promise<{ success: boolean; message: string } | null> {
  if (!bridge?.isReady || !bridge.metadataAvailable) return null;
  try {
    const result = await bridge.addFullTextIndex(tableName, indexName, fields);
    return {
      success: result.success,
      message: result.success
        ? `✅ Full-text index '${indexName}' added via ${result.api}`
        : `Bridge addFullTextIndex returned success=false`,
    };
  } catch (e) {
    // Record into the per-call failure sink as well as returning the
    // message: without this a bridge write that THREW reached the model
    // as an ordinary failure string, with nothing saying the bridge was
    // what broke. Same stderr line as before.
    recordBridgeFailure(`addFullTextIndex(${tableName}, ${indexName})`, e);
    return { success: false, message: String(e) };
  }
}

/** Removes a full-text index from a table or table-extension via the C# bridge. */
export async function bridgeRemoveFullTextIndex(
  bridge: BridgeClient | undefined,
  tableName: string,
  indexName: string,
): Promise<{ success: boolean; message: string } | null> {
  if (!bridge?.isReady || !bridge.metadataAvailable) return null;
  try {
    const result = await bridge.removeFullTextIndex(tableName, indexName);
    return {
      success: result.success,
      message: result.success
        ? `✅ Full-text index '${indexName}' removed via ${result.api}`
        : `Bridge removeFullTextIndex returned success=false`,
    };
  } catch (e) {
    // Record into the per-call failure sink as well as returning the
    // message: without this a bridge write that THREW reached the model
    // as an ordinary failure string, with nothing saying the bridge was
    // what broke. Same stderr line as before.
    recordBridgeFailure(`removeFullTextIndex(${tableName}, ${indexName})`, e);
    return { success: false, message: String(e) };
  }
}

/** Adds a Map membership to a table or table-extension via the C# bridge. */
export async function bridgeAddTableMapping(
  bridge: BridgeClient | undefined,
  tableName: string,
  mapName: string,
  mappingTable?: string,
  connections?: Array<{ mapField?: string; mapFieldTo?: string }>,
): Promise<{ success: boolean; message: string } | null> {
  if (!bridge?.isReady || !bridge.metadataAvailable) return null;
  try {
    const result = await bridge.addTableMapping(tableName, mapName, mappingTable, connections);
    return {
      success: result.success,
      message: result.success
        ? `✅ Mapping '${mapName}' added via ${result.api}`
        : `Bridge addTableMapping returned success=false`,
    };
  } catch (e) {
    // Record into the per-call failure sink as well as returning the
    // message: without this a bridge write that THREW reached the model
    // as an ordinary failure string, with nothing saying the bridge was
    // what broke. Same stderr line as before.
    recordBridgeFailure(`addTableMapping(${tableName}, ${mapName})`, e);
    return { success: false, message: String(e) };
  }
}

/** Removes a Map membership from a table or table-extension via the C# bridge. */
export async function bridgeRemoveTableMapping(
  bridge: BridgeClient | undefined,
  tableName: string,
  mapName: string,
): Promise<{ success: boolean; message: string } | null> {
  if (!bridge?.isReady || !bridge.metadataAvailable) return null;
  try {
    const result = await bridge.removeTableMapping(tableName, mapName);
    return {
      success: result.success,
      message: result.success
        ? `✅ Mapping '${mapName}' removed via ${result.api}`
        : `Bridge removeTableMapping returned success=false`,
    };
  } catch (e) {
    // Record into the per-call failure sink as well as returning the
    // message: without this a bridge write that THREW reached the model
    // as an ordinary failure string, with nothing saying the bridge was
    // what broke. Same stderr line as before.
    recordBridgeFailure(`removeTableMapping(${tableName}, ${mapName})`, e);
    return { success: false, message: String(e) };
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
  properties?: { relationCardinality?: string; relatedTableCardinality?: string; relationshipType?: string },
): Promise<{ success: boolean; message: string; propertiesWritten?: boolean } | null> {
  if (!bridge?.isReady || !bridge.metadataAvailable) return null;
  try {
    const result = await bridge.addRelation(tableName, relationName, relatedTable, constraints, properties);
    // An older bridge binary silently ignores the extra params; it echoes back only
    // what it set, so the response says whether the on-disk fallback is still needed.
    const r = result as unknown as Record<string, unknown>;
    const propertiesWritten = typeof r.relationshipType === 'string';
    // On a table-extension the bridge routes a relation the BASE table already owns into
    // <RelationExtensions> and says so in `note` — the constraints landed, but the three
    // relation properties belong to the base relation and were deliberately not written.
    // Surfacing it verbatim is what stops that from reading as a plain "✅ added".
    const note = typeof r.note === 'string' ? ` ${r.note}` : '';
    return {
      success: result.success,
      propertiesWritten,
      message: result.success
        ? `✅ Relation '${relationName}' added via ${result.api}` +
          (propertiesWritten
            ? ` (Cardinality=${r.cardinality}, RelatedTableCardinality=${r.relatedTableCardinality}, RelationshipType=${r.relationshipType})`
            : '') + note
        : `Bridge addRelation returned success=false`,
    };
  } catch (e) {
    // Record into the per-call failure sink as well as returning the
    // message: without this a bridge write that THREW reached the model
    // as an ordinary failure string, with nothing saying the bridge was
    // what broke. Same stderr line as before.
    recordBridgeFailure(`addRelation(${tableName}, ${relationName})`, e);
    return { success: false, message: String(e) };
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
    // Record into the per-call failure sink as well as returning the
    // message: without this a bridge write that THREW reached the model
    // as an ordinary failure string, with nothing saying the bridge was
    // what broke. Same stderr line as before.
    recordBridgeFailure(`removeRelation(${tableName}, ${relationName})`, e);
    return { success: false, message: String(e) };
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
    // Record into the per-call failure sink as well as returning the
    // message: without this a bridge write that THREW reached the model
    // as an ordinary failure string, with nothing saying the bridge was
    // what broke. Same stderr line as before.
    recordBridgeFailure(`addFieldGroup(${tableName}, ${groupName})`, e);
    return { success: false, message: String(e) };
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
    // Record into the per-call failure sink as well as returning the
    // message: without this a bridge write that THREW reached the model
    // as an ordinary failure string, with nothing saying the bridge was
    // what broke. Same stderr line as before.
    recordBridgeFailure(`removeFieldGroup(${tableName}, ${groupName})`, e);
    return { success: false, message: String(e) };
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
  extendBaseFieldGroup?: boolean,
): Promise<{ success: boolean; message: string } | null> {
  if (!bridge?.isReady || !bridge.metadataAvailable) return null;
  try {
    const result = await bridge.addFieldToFieldGroup(tableName, groupName, fieldName, extendBaseFieldGroup);
    // An OLD bridge binary silently ignores extendBaseFieldGroup and writes to
    // <FieldGroups> instead — the field then lands in the file but never surfaces on
    // the base table's forms. The C# echoes the flag back, so say which collection
    // actually received it rather than letting the caller assume.
    const target = (result as unknown as Record<string, unknown>).extendBaseFieldGroup === true
      ? '<FieldGroupExtensions> (extending the base-table group)'
      : '<FieldGroups>';
    return {
      success: result.success,
      message: result.success
        ? `✅ Field '${fieldName}' added to group '${groupName}' in ${target} via ${result.api}`
        : `Bridge addFieldToFieldGroup returned success=false`,
    };
  } catch (e) {
    // Record into the per-call failure sink as well as returning the
    // message: without this a bridge write that THREW reached the model
    // as an ordinary failure string, with nothing saying the bridge was
    // what broke. Same stderr line as before.
    recordBridgeFailure(`addFieldToFieldGroup(${tableName}, ${groupName}, ${fieldName})`, e);
    return { success: false, message: String(e) };
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
    // Record into the per-call failure sink as well as returning the
    // message: without this a bridge write that THREW reached the model
    // as an ordinary failure string, with nothing saying the bridge was
    // what broke. Same stderr line as before.
    recordBridgeFailure(`modifyField(${tableName}, ${fieldName})`, e);
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
    // Record into the per-call failure sink as well as returning the
    // message: without this a bridge write that THREW reached the model
    // as an ordinary failure string, with nothing saying the bridge was
    // what broke. Same stderr line as before.
    recordBridgeFailure(`renameField(${tableName}, ${oldName} → ${newName})`, e);
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
    // Record into the per-call failure sink as well as returning the
    // message: without this a bridge write that THREW reached the model
    // as an ordinary failure string, with nothing saying the bridge was
    // what broke. Same stderr line as before.
    recordBridgeFailure(`removeField(${tableName}, ${fieldName})`, e);
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
    // Record into the per-call failure sink as well as returning the
    // message: without this a bridge write that THREW reached the model
    // as an ordinary failure string, with nothing saying the bridge was
    // what broke. Same stderr line as before.
    recordBridgeFailure(`replaceAllFields(${tableName})`, e);
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
  countryRegionCodes?: string,
): Promise<{ success: boolean; message: string } | null> {
  if (!bridge?.isReady || !bridge.metadataAvailable) return null;
  try {
    const result = await bridge.addEnumValue(enumName, valueName, value, label, countryRegionCodes);
    return {
      success: result.success,
      message: result.success
        ? `✅ Enum value '${valueName}'=${value} added via ${result.api}`
        : `Bridge addEnumValue returned success=false`,
    };
  } catch (e) {
    // Record into the per-call failure sink as well as returning the
    // message: without this a bridge write that THREW reached the model
    // as an ordinary failure string, with nothing saying the bridge was
    // what broke. Same stderr line as before.
    recordBridgeFailure(`addEnumValue(${enumName}, ${valueName})`, e);
    return { success: false, message: String(e) };
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
    // Record into the per-call failure sink as well as returning the
    // message: without this a bridge write that THREW reached the model
    // as an ordinary failure string, with nothing saying the bridge was
    // what broke. Same stderr line as before.
    recordBridgeFailure(`modifyEnumValue(${enumName}, ${valueName})`, e);
    return { success: false, message: String(e) };
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
    // Record into the per-call failure sink as well as returning the
    // message: without this a bridge write that THREW reached the model
    // as an ordinary failure string, with nothing saying the bridge was
    // what broke. Same stderr line as before.
    recordBridgeFailure(`removeEnumValue(${enumName}, ${valueName})`, e);
    return { success: false, message: String(e) };
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
        ? `✅ Control '${controlName}' added to '${parentControl}' via ${result.api}` + unappliedSuffix(result)
        : `Bridge addControl returned success=false`,
    };
  } catch (e) {
    // Record into the per-call failure sink as well as returning the
    // message: without this a bridge write that THREW reached the model
    // as an ordinary failure string, with nothing saying the bridge was
    // what broke. Same stderr line as before.
    recordBridgeFailure(`addControl(${formName}, ${controlName})`, e);
    return { success: false, message: String(e) };
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
    // Record into the per-call failure sink as well as returning the
    // message: without this a bridge write that THREW reached the model
    // as an ordinary failure string, with nothing saying the bridge was
    // what broke. Same stderr line as before.
    recordBridgeFailure(`addDataSource(${objectType}, ${objectName}, ${dsName})`, e);
    return { success: false, message: String(e) };
  }
}

// TABLE-EXTENSION: ADD FIELD MODIFICATION

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
    // Record into the per-call failure sink as well as returning the
    // message: without this a bridge write that THREW reached the model
    // as an ordinary failure string, with nothing saying the bridge was
    // what broke. Same stderr line as before.
    recordBridgeFailure(`addFieldModification(${extensionName}, ${fieldName})`, e);
    return { success: false, message: String(e) };
  }
}

// MENU: ADD MENU ITEM TO MENU

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
    // Record into the per-call failure sink as well as returning the
    // message: without this a bridge write that THREW reached the model
    // as an ordinary failure string, with nothing saying the bridge was
    // what broke. Same stderr line as before.
    recordBridgeFailure(`addMenuItemToMenu(${menuName}, ${menuItemToAdd})`, e);
    return { success: false, message: String(e) };
  }
}

// BATCH MODIFY

/**
 * Executes multiple write operations on a single object in one bridge call.
 * Returns a formatted ToolResult or null if bridge unavailable.
 *
 * NOT REACHED BY ANY PUBLISHED TOOL, and that is deliberate — do not wire
 * `d365fo_file(operations:[…])` to it on the assumption that it is the faster
 * path. See the comment on `runModifyBatch` in src/tools/d365foFile.ts: the
 * round trip worth saving is the MCP one, and bridge IPC is local and costs
 * milliseconds, while this RPC bypasses path containment, backups, prefix
 * application, .rnrproj registration, the per-operation validation and the
 * direct-XML fallbacks — several of which exist because a bridge write failed.
 *
 * Kept rather than deleted: the C# counterpart (RequestDispatcher.HandleBatchModify)
 * is ~300 lines whose three known defects are fixed, and a future caller that
 * accepts those trade-offs has somewhere to start. Retired, not broken.
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
    recordBridgeFailure(`batchModify(${objectType}, ${objectName})`, e);
    return null;
  }
}

// CAPABILITIES

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
    recordBridgeFailure(`getCapabilities()`, e);
    return null;
  }
}

// FORM PATTERN DISCOVERY

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
    recordBridgeFailure(`discoverFormPatterns()`, e);
    return null;
  }
}

// SECURITY ARTIFACT (Phase 6)

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
    recordBridgeFailure(`readSecurity${artifactType}(${name})`, e);
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
  } else if (priv.parentDutiesComplete === false) {
    // Not the same as "none". The bridge scans every duty to answer this, and a
    // scan that could not finish used to come back as an empty list — read as
    // "this privilege is in no duty", which is exactly the claim
    // BPErrorPrivilegeNotCoveredByDuty is about and the one an agent acts on by
    // adding the privilege to a duty it may already be in.
    out += `\nUsed in Duties: UNKNOWN — the duty scan could not complete, so this is NOT ` +
      `evidence the privilege is uncovered.\n`;
  } else {
    out += `\nUsed in Duties: none\n`;
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

// MENU ITEM (Phase 6)

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
    recordBridgeFailure(`readMenuItem(${name})`, e);
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

// TABLE EXTENSIONS (Phase 6)

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
    recordBridgeFailure(`readTableExtensions(${baseTableName})`, e);
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

// CODE COMPLETION (Phase 6)

export async function tryBridgeCompletion(
  bridge: BridgeClient | undefined,
  symbolName: string,
  prefix?: string,
  ancestors?: string[],
): Promise<ToolResult | null> {
  if (!bridge?.isReady || !bridge.metadataAvailable) return null;
  try {
    const result = await bridge.getCompletionMembers(symbolName);
    if (!result || !result.members || result.members.length === 0) return null;

    // IMetadataProvider returns DECLARED members only, so a subclass lists
    // nothing it inherits and the reader concludes the member does not exist.
    // Merge the base classes in, nearest first; a name already present wins,
    // since that is the subclass's own override.
    if (ancestors?.length) {
      const seen = new Set(result.members.map(m => m.name.toLowerCase()));
      for (const ancestor of ancestors) {
        let inherited: BridgeCompletionResult | null = null;
        try {
          inherited = await bridge.getCompletionMembers(ancestor);
        } catch (e) {
          // One unreadable link must not discard the members already merged.
          recordBridgeFailure(`getCompletionMembers(${ancestor})`, e);
          continue;
        }
        for (const m of inherited?.members ?? []) {
          const key = m.name.toLowerCase();
          if (seen.has(key)) continue;
          seen.add(key);
          result.members.push({ ...m, inheritedFrom: inherited?.symbolName || ancestor });
        }
      }
    }

    return { content: [{ type: 'text', text: formatCompletion(result, prefix) }] };
  } catch (e) {
    recordBridgeFailure(`getCompletionMembers(${symbolName})`, e);
    return null;
  }
}

/**
 * One line of a member list — NAME first, always.
 *
 * This used to print the signature INSTEAD of the name whenever a signature
 * existed, which made a member unidentifiable the moment the signature was
 * wrong. It is sometimes wrong: the bridge's extractor hands back the line
 * preceding the body when a macro sits between the doc block and the signature,
 * so `SysQuery.range` was listed as `#ISOCountryRegionCodes`. Filtering runs on
 * the NAME, so asking for prefix "range" returned "1 member" that appeared to be
 * something else entirely — and a member list that renders a public API as
 * another string argues the API does not exist. An eval run concluded exactly
 * that and worked around a method that was there all along.
 *
 * The signature is still shown, as detail, and only when it plausibly belongs to
 * this member. Fixing the extractor is a separate, C#-side change; this makes the
 * output honest either way.
 */
function memberLine(m: { name: string; signature?: string }): string {
  const sig = m.signature?.trim();
  const belongs = sig && new RegExp(`\\b${m.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\(`, 'i').test(sig);
  if (belongs) return `\`${sig}\``;
  return sig ? `**${m.name}** _(signature unavailable)_` : `**${m.name}**`;
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
    const inheritedCount = methodMembers.filter(m => m.inheritedFrom).length;
    out += `## Methods (${methodMembers.length})\n`;
    for (const m of methodMembers) {
      out += m.inheritedFrom
        ? `- ${memberLine(m)} _(inherited from ${m.inheritedFrom})_\n`
        : `- ${memberLine(m)}\n`;
    }
    if (inheritedCount > 0) {
      out += `\n> ${inheritedCount} of these are inherited — callable on ${r.symbolName}, but ` +
        `declared on a base class. To read or wrap one, target the class named beside it.\n`;
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

// FIND COC EXTENSIONS via XREF (Phase 6)

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
    recordBridgeFailure(`findExtensionClasses(${baseClassName})`, e);
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

// FIND EVENT HANDLERS via XREF (Phase 6)

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
    recordBridgeFailure(`findEventSubscribers(${targetName})`, e);
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

// API USAGE CALLERS via XREF (P5)

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
    recordBridgeFailure(`findApiUsageCallers(${apiName})`, e);
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

/**
 * Internals exposed for tests only. `formatCompletion` renders a member list,
 * and a member list that cannot be trusted to name its members is worse than no
 * list at all — see tests/bridge/completionMemberLine.test.ts.
 */
export const __testing = { formatCompletion, memberLine };
