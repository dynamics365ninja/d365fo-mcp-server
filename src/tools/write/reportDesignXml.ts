/**
 * `d365fo_file(action="modify", objectType="report", operation="report-design")`
 * — the first write path an AxReport has ever had.
 *
 * Until now every report recipe ended with "open the Report Designer", and for
 * LAYOUT that is still true and correct. But two of the things a developer needs
 * after scaffolding a report are not layout at all — they are bookkeeping the
 * tool already holds every input for, and getting them wrong is silent:
 *
 *  - `refresh-dataset` — a field was added to the DP's temp table and the report's
 *    dataset does not know about it. The information is on disk in the table's own
 *    XML; nothing about copying it is a design decision.
 *  - `add-parameter` — a report parameter is two elements in two collections that
 *    must agree. Hand-writing one and forgetting the other produces a document
 *    that builds and behaves oddly.
 *
 * ── WHAT MAKES THIS SAFE, AND WHY IT IS NOT A FINGERPRINT ────────────────────
 * The plan proposed refusing "any design the scaffold does not own", enforced by
 * a marker in the RDL. That guard has the wrong shape: it is a property of the
 * FILE's provenance, so every report scaffolded before the marker existed — the
 * committed goldens included — would be refused, and a hand-written report that
 * acquired the marker would be accepted.
 *
 * The guarantee here is a property of the OPERATION instead, and it holds for
 * every document regardless of origin:
 *
 *   1. **Metadata only.** The RDL is never read, parsed or written. A malformed
 *      RDL fails in the SSRS renderer at run time, where no build and no test can
 *      see it, so this code does not go near it.
 *
 *      It is stored TWO ways, and both are covered. This server's scaffold writes
 *      a `<![CDATA[…]]>` block, which every search here masks first. Shipped
 *      reports instead put XML-ESCAPED text in `<Text>` — zero of the 1,057 on a
 *      full install use CDATA — and that form is inert by construction: `&lt;Fields&gt;`
 *      cannot match a search for `<Fields>`. The masking is what makes OUR
 *      documents safe; escaping is what makes Microsoft's.
 *   2. **Additive only.** Fields and parameters are added; nothing is removed or
 *      renamed. Adding a dataset field the RDL does not reference is inert — the
 *      design simply does not show it. REMOVING one the RDL does reference breaks
 *      the render, so removal is not offered at all.
 *
 * That is also why there is no `add-column`: putting a column in the layout means
 * editing the RDL, and the failure mode there is invisible until someone runs the
 * report.
 */

import * as fs from 'fs/promises';
import { findTableXmlPath, resetTableXmlIndexCache } from '../../utils/fieldControlTypes.js';

export interface ReportDesignResult {
  success: boolean;
  message: string;
}

/** AOT names are identifiers; anything else is a caller mistake, not a shape to write. */
function nonIdentifier(value: string | undefined): boolean {
  return !value || !/^[A-Za-z_]\w*$/.test(value);
}

/**
 * A .NET type name as a dataset carries it — `System.DateTime`, `System.Byte[]`,
 * a fully-qualified framework type. Anything else is a caller mistake, and it
 * would land in the document unescaped.
 */
function nonDotNetTypeName(value: string): boolean {
  return !/^[A-Za-z_][\w.]*(?:\[\])?$/.test(value);
}

/** Text that lands INSIDE an element. A label id never needs it; a raw caption might. */
function xmlText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Where to insert a new element so it takes the closing tag's LINE rather than
 * its indentation. `at` is the index of `</Foo>`; when nothing but whitespace
 * precedes it on that line, the insertion point moves to the start of the line
 * and the closing tag keeps its own indent. Inserting at `at` itself puts the
 * new element after the closing tag's tabs and leaves `</Foo>` at column 0 —
 * which is what the first captured golden looked like.
 */
function lineStartBefore(text: string, at: number): number {
  const lineStart = text.lastIndexOf('\n', at - 1) + 1;
  return /^[ \t]*$/.test(text.slice(lineStart, at)) ? lineStart : at;
}

/**
 * X++ base type → the .NET type name a dataset field carries.
 *
 * Deliberately the same mapping `generateSmartReport.ts` uses. The two types a
 * report field has — the X++ one on the temp table and the .NET one in the
 * dataset — drifting apart is a hard "Data type mismatch" at build time, which
 * is exactly the defect that mapping was written for.
 */
function rdlDataType(iType: string | undefined, enumType: string | undefined): string {
  if (enumType) return 'System.Int32';
  switch (iType) {
    case 'AxTableFieldReal': return 'System.Double';
    case 'AxTableFieldInt': return 'System.Int32';
    case 'AxTableFieldInt64': return 'System.Int64';
    case 'AxTableFieldDate':
    case 'AxTableFieldUtcDateTime': return 'System.DateTime';
    case 'AxTableFieldEnum': return 'System.Int32';
    case 'AxTableFieldContainer': return 'System.Byte[]';
    default: return 'System.String';
  }
}

/** `<AxTableField … i:type="X">` blocks, in declaration order, with their names. */
function tableFields(tableXml: string): Array<{ name: string; iType: string; enumType?: string }> {
  const out: Array<{ name: string; iType: string; enumType?: string }> = [];
  const re = /<AxTableField\b[^>]*?i:type="(AxTableField\w+)"[^>]*>([\s\S]*?)<\/AxTableField>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(tableXml)) !== null) {
    const name = /<Name>([^<]+)<\/Name>/.exec(m[2])?.[1]?.trim();
    if (!name) continue;
    out.push({ name, iType: m[1], enumType: /<EnumType>([^<]+)<\/EnumType>/.exec(m[2])?.[1]?.trim() });
  }
  return out;
}

/**
 * The `<AxReportDataSet>` block for one dataset, located WITHOUT parsing the RDL.
 *
 * The document holds the design's RDL in a CDATA block that reaches megabytes and
 * contains element names identical to the metadata ones. Every search here runs
 * on a copy with those blocks blanked, so a `<Fields>` tag inside the RDL can
 * never be mistaken for the dataset's own.
 */
function locateDataSet(content: string, datasetName?: string):
  | { ok: true; start: number; end: number; name: string }
  | { ok: false; reason: string; available: string[] } {
  const masked = content.replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, m => ' '.repeat(m.length));
  const blocks: Array<{ start: number; end: number; name: string }> = [];
  const re = /<AxReportDataSet\b[^>]*>([\s\S]*?)<\/AxReportDataSet>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(masked)) !== null) {
    const name = /<Name>([^<]+)<\/Name>/.exec(m[1])?.[1]?.trim();
    if (name) blocks.push({ start: m.index, end: m.index + m[0].length, name });
  }
  if (blocks.length === 0) return { ok: false, reason: 'no-datasets', available: [] };

  const available = blocks.map(b => b.name);
  if (!datasetName) {
    if (blocks.length === 1) return { ok: true, ...blocks[0] };
    return { ok: false, reason: 'ambiguous', available };
  }
  const hit = blocks.find(b => b.name.toLowerCase() === datasetName.trim().toLowerCase());
  return hit ? { ok: true, ...hit } : { ok: false, reason: 'not-found', available };
}

/**
 * The `<Fields>…</Fields>` collection inside a located dataset block.
 *
 * ATTRIBUTES ARE THE NORM, not the exception. A literal `<Fields>` search finds
 * the committed goldens and misses what the scaffold itself writes, because the
 * generator emits `xmlns=""` on several of these containers — which is how the
 * first live run of this operation refused a report the scaffold had just made.
 * Every container search in this file is attribute-tolerant for that reason.
 *
 * `<Fields />` is a real shape for a dataset with none yet, and it is not one
 * this function can insert into — the caller reports that rather than silently
 * finding nothing.
 */
function locateFields(block: string): { innerStart: number; innerEnd: number; indent: string } | undefined {
  const open = /<Fields\b[^>]*>/.exec(block);
  if (!open || open[0].endsWith('/>')) return undefined;
  const closeIdx = block.indexOf('</Fields>', open.index);
  if (closeIdx < 0) return undefined;
  const inner = block.slice(open.index + open[0].length, closeIdx);
  const indent = /\n([ \t]+)</.exec(inner)?.[1] ?? '\t\t\t\t';
  return { innerStart: open.index + open[0].length, innerEnd: closeIdx, indent };
}

/**
 * Sync a report dataset with the temp table it reads.
 *
 * ADD-ONLY, by construction: a field the report already declares is left exactly
 * as it is, even when the table now disagrees about its type. Rewriting it would
 * be the one edit that can break a render, because the RDL binds by name AND
 * type, and this operation has no way to see the RDL.
 */
export async function refreshReportDataset(
  filePath: string,
  tableName: string,
  datasetName?: string,
  packageRoots?: readonly string[],
): Promise<ReportDesignResult> {
  const raw = await fs.readFile(filePath, 'utf-8');
  const content = raw.replace(/^﻿/, '');

  if (!/<AxReport\b/.test(content)) {
    return { success: false, message: `❌ report-design: '${filePath}' is not an AxReport — nothing was written.` };
  }
  if (nonIdentifier(tableName)) {
    return {
      success: false,
      message: `❌ report-design(refresh-dataset): tableName '${tableName}' is not a valid AOT name.`,
    };
  }

  // The per-root listing is memoised for the life of the process, and the
  // temp table this reads is usually the one the caller created a moment ago —
  // after the cache was primed by an earlier lookup. Without the reset a table
  // that exists on disk is reported as missing.
  resetTableXmlIndexCache();
  const tablePath = findTableXmlPath(tableName, packageRoots);
  if (!tablePath) {
    return {
      success: false,
      message:
        `❌ report-design(refresh-dataset): table '${tableName}' was not found on disk, so its fields ` +
        'cannot be read. Create the table first, or check the spelling — this operation copies the ' +
        'table\'s own field list and will not invent one.',
    };
  }

  const located = locateDataSet(content, datasetName);
  if (!located.ok) {
    return { success: false, message: datasetError('refresh-dataset', located, datasetName) };
  }

  const block = content.slice(located.start, located.end);
  const fields = locateFields(block);
  if (!fields) {
    return {
      success: false,
      message:
        `❌ report-design(refresh-dataset): dataset '${located.name}' has no <Fields> collection. ` +
        'This document was not produced by the report scaffold and its shape is not one this ' +
        'operation can extend safely.',
    };
  }

  const existing = new Set(
    [...block.matchAll(/<AxReportDataSetField>[\s\S]*?<Name>([^<]+)<\/Name>/g)].map(m => m[1].trim().toLowerCase()),
  );
  const tableXml = await fs.readFile(tablePath, 'utf-8');
  const missing = tableFields(tableXml).filter(f => !existing.has(f.name.toLowerCase()));

  if (missing.length === 0) {
    return {
      success: true,
      message:
        `✅ report-design(refresh-dataset): dataset '${located.name}' already carries every field of ` +
        `'${tableName}' (${existing.size} field(s)) — nothing to add.`,
    };
  }

  const { indent } = fields;
  const added = missing.map(f =>
    `${indent}<AxReportDataSetField>\n` +
    `${indent}\t<Name>${f.name}</Name>\n` +
    `${indent}\t<Alias>${located.name}.1.${f.name}</Alias>\n` +
    `${indent}\t<DataType>${rdlDataType(f.iType, f.enumType)}</DataType>\n` +
    `${indent}\t<DisplayWidth>Auto</DisplayWidth>\n` +
    `${indent}\t<UserDefined>false</UserDefined>\n` +
    `${indent}</AxReportDataSetField>\n`,
  ).join('');

  const insertAt = lineStartBefore(content, located.start + fields.innerEnd);
  const next = `${content.slice(0, insertAt)}${added}${content.slice(insertAt)}`;
  await fs.writeFile(filePath, `﻿${next.replace(/^﻿/, '')}`, 'utf-8');

  return {
    success: true,
    message:
      `✅ report-design(refresh-dataset): added ${missing.length} field(s) to dataset '${located.name}' ` +
      `from table '${tableName}': ${missing.map(f => f.name).join(', ')}.\n` +
      '⚠️ The DESIGN does not show them yet. A dataset field the RDL does not bind is inert — open the ' +
      'Report Designer to place it, which is the half no tool here writes.',
  };
}

/**
 * Add a report parameter — both halves of it.
 *
 * A parameter is two elements in two collections: an `<AxReportParameterBase>`
 * that declares it and an `<AxReportDataSetParameter>` that binds it to the
 * dataset. Writing one without the other is the mistake this exists to prevent —
 * so both insertion sites are resolved BEFORE the first byte is written, and a
 * dataset that cannot be found is an error, not a success with a caveat.
 *
 * The property vocabulary is not invented. Across 1,057 shipped AxReport
 * documents and 13,833 parameters, `UserVisibility` holds only `Hidden` (8,972)
 * and `Internal` (5) — a VISIBLE parameter omits the element — and `AllowBlank`
 * and `Nullable` appear only as `true`, never `false`. So visibility is expressed
 * by presence, and the flags are written only when they are on.
 */
export async function addReportParameter(
  filePath: string,
  parameterName: string,
  opts: { dataType?: string; hidden?: boolean; promptString?: string; datasetName?: string } = {},
): Promise<ReportDesignResult> {
  const raw = await fs.readFile(filePath, 'utf-8');
  const content = raw.replace(/^﻿/, '');

  if (!/<AxReport\b/.test(content)) {
    return { success: false, message: `❌ report-design: '${filePath}' is not an AxReport — nothing was written.` };
  }
  if (nonIdentifier(parameterName)) {
    return {
      success: false,
      message: `❌ report-design(add-parameter): parameterName '${parameterName}' is not a valid AOT name.`,
    };
  }

  const dataType = opts.dataType?.trim() || 'System.String';
  if (nonDotNetTypeName(dataType)) {
    return {
      success: false,
      message:
        `❌ report-design(add-parameter): parameterDataType '${dataType}' is not a .NET type name. Shipped ` +
        'parameters carry System.String, System.DateTime, System.Int32, System.Int64 or System.Boolean.',
    };
  }

  const masked = content.replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, m => ' '.repeat(m.length));
  const isOurs = (name: string): boolean => name.trim().toLowerCase() === parameterName.toLowerCase();
  const declared = [...masked.matchAll(/<AxReportParameterBase\b[^>]*>[\s\S]*?<Name>([^<]+)<\/Name>/g)]
    .some(m => isOurs(m[1]));

  // ── Resolve BOTH halves before writing either ─────────────────────────────
  // The first version of this wrote the declaration, then looked for the
  // dataset, and reported success with "bound to (none)" when it found nothing.
  // The retry with the right datasetName then hit the "already declared" guard,
  // so the parameter could never be bound at all — the exact half-write this
  // operation exists to prevent. Nothing is written until both sites are known.
  const located = locateDataSet(content, opts.datasetName);
  if (!located.ok) {
    return { success: false, message: datasetError('add-parameter', located, opts.datasetName) };
  }
  const block = masked.slice(located.start, located.end);
  const paramsOpen = /<Parameters\b[^>]*>/.exec(block);
  const paramsClose = paramsOpen && !paramsOpen[0].endsWith('/>') ? block.indexOf('</Parameters>', paramsOpen.index) : -1;
  if (!paramsOpen || paramsClose < 0) {
    return {
      success: false,
      message:
        `❌ report-design(add-parameter): dataset '${located.name}' has no <Parameters> collection to bind ` +
        'into. This document was not produced by the report scaffold and its shape is not one this ' +
        'operation can extend safely.',
    };
  }
  const bound = [
    ...block.slice(paramsOpen.index, paramsClose).matchAll(/<AxReportDataSetParameter\b[^>]*>[\s\S]*?<Name>([^<]+)<\/Name>/g),
  ].some(m => isOurs(m[1]));

  if (declared && bound) {
    return {
      success: true,
      message:
        `✅ report-design(add-parameter): '${parameterName}' is already declared and bound to dataset ` +
        `'${located.name}' — nothing to do.`,
    };
  }

  let basesClose = -1;
  if (!declared) {
    const basesOpen = /<ReportParameterBases\b[^>]*>/.exec(masked);
    if (!basesOpen) {
      return {
        success: false,
        message:
          '❌ report-design(add-parameter): the document has no <ReportParameterBases> collection, so it ' +
          'was not produced by the report scaffold and its shape is not one this operation can extend safely.',
      };
    }
    basesClose = masked.indexOf('</ReportParameterBases>', basesOpen.index);
    if (basesClose < 0) {
      return { success: false, message: '❌ report-design(add-parameter): <ReportParameterBases> is not closed.' };
    }
  }

  // ── Write, later site first so the earlier offsets stay valid ─────────────
  let next = content;

  if (!declared) {
    const basesOpenEnd = masked.lastIndexOf('<ReportParameterBases', basesClose);
    const indent = /\n([ \t]+)</.exec(content.slice(basesOpenEnd, basesClose))?.[1] ?? '\t\t\t';
    // CHILD ORDER IS THE CONTRACT. The deserializer drops an element it meets
    // out of sequence without a word, the build stays green, and the parameter
    // silently loses its type. Census of all 13,911 parameters in the 1,063
    // shipped reports: Name, [AOTQuery], AllowBlank, DataType, Nullable,
    // [MultiValue], PromptString, UserVisibility, DefaultValue, Values — with
    // ZERO contradicting instances (DataType before PromptString 3,104:0,
    // DataType before Nullable 2,139:0). The first version wrote DataType last.
    //
    // Visibility is expressed by PRESENCE: `Hidden` when hidden, and the element
    // omitted entirely when the user should see it. There is no "Visible" value
    // in any shipped parameter, and an unknown one is dropped silently.
    const parameterXml =
      `${indent}<AxReportParameterBase xmlns=""\n` +
      `${indent}\t\ti:type="AxReportParameter">\n` +
      `${indent}\t<Name>${parameterName}</Name>\n` +
      `${indent}\t<AllowBlank>true</AllowBlank>\n` +
      `${indent}\t<DataType>${dataType}</DataType>\n` +
      `${indent}\t<Nullable>true</Nullable>\n` +
      (opts.promptString ? `${indent}\t<PromptString>${xmlText(opts.promptString)}</PromptString>\n` : '') +
      (opts.hidden ? `${indent}\t<UserVisibility>Hidden</UserVisibility>\n` : '') +
      `${indent}\t<DefaultValue />\n` +
      `${indent}\t<Values />\n` +
      `${indent}</AxReportParameterBase>\n`;
    const at = lineStartBefore(content, basesClose);
    next = `${next.slice(0, at)}${parameterXml}${next.slice(at)}`;
  }

  if (!bound) {
    const dsIndent = /\n([ \t]+)</.exec(block.slice(paramsOpen.index + paramsOpen[0].length, paramsClose))?.[1]
      ?? '\t\t\t\t';
    // Same order shipped dataset parameters use: Name, Alias, DataType, Parameter.
    const dsParam =
      `${dsIndent}<AxReportDataSetParameter>\n` +
      `${dsIndent}\t<Name>${parameterName}</Name>\n` +
      `${dsIndent}\t<Alias>${parameterName}</Alias>\n` +
      `${dsIndent}\t<DataType>${dataType}</DataType>\n` +
      `${dsIndent}\t<Parameter>${parameterName}</Parameter>\n` +
      `${dsIndent}</AxReportDataSetParameter>\n`;
    const at = lineStartBefore(content, located.start + paramsClose);
    next = `${next.slice(0, at)}${dsParam}${next.slice(at)}`;
  }

  await fs.writeFile(filePath, `\uFEFF${next.replace(/^\uFEFF/, '')}`, 'utf-8');

  const what = declared
    ? `'${parameterName}' was declared but bound to no dataset — bound it to '${located.name}'`
    : `declared '${parameterName}' (${dataType}${opts.hidden ? ', hidden' : ''}) and bound it to dataset '${located.name}'`;
  return {
    success: true,
    message:
      `✅ report-design(add-parameter): ${what}.\n` +
      '⚠️ The DESIGN does not use it yet. A parameter the RDL does not reference still appears in the ' +
      'dialog but changes nothing — open the Report Designer to wire it in.',
  };
}

function datasetError(
  action: string,
  located: { ok: false; reason: string; available: string[] },
  requested: string | undefined,
): string {
  if (located.reason === 'no-datasets') {
    return `❌ report-design(${action}): the document declares no datasets — nothing to extend.`;
  }
  if (located.reason === 'ambiguous') {
    return (
      `❌ report-design(${action}): the report has ${located.available.length} datasets ` +
      `(${located.available.join(', ')}), so datasetName is required. Guessing which one to extend is ` +
      'exactly the mistake that puts a field on the wrong dataset.'
    );
  }
  return (
    `❌ report-design(${action}): no dataset named '${requested}'. The report declares: ` +
    `${located.available.join(', ')}.`
  );
}
