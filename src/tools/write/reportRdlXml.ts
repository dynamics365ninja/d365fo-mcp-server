/**
 * Edits to the RDL inside an existing AxReport — `report-design` operations
 * `fix-labels` and `add-column`.
 *
 * `reportDesignXml.ts` deliberately never touches the RDL, because a malformed
 * RDL builds fine and fails only in the SSRS renderer at run time. This module
 * lifts that restriction under three conditions, all enforced in code:
 *
 *  1. **Targeted, byte-preserving edits.** The RDL is NOT parsed and re-serialised
 *     (that would renumber namespaces, drop `rd:` GUIDs' formatting and reflow every
 *     line). It is parsed only to learn where things are; each edit is a splice at a
 *     known offset, so everything not named by the operation survives byte for byte.
 *  2. **Validate before write.** The edited RDL must be well-formed XML, every
 *     `Fields!X` must resolve to a dataset field, every `Parameters!X` to a declared
 *     parameter, and textbox / tablix / group names must be unique. Problems the
 *     edit INTRODUCED refuse the write; the file is never touched.
 *  3. **Refuse what is not recognised.** `add-column` only edits a tablix whose
 *     shape it fully understands (one header row, one detail row, summary rows made
 *     of the aggregates it knows, no spans, no column groups). Anything else is
 *     reported with the reason, never guessed at.
 *
 * ── TWO STORAGE FORMS ────────────────────────────────────────────────────────
 * The RDL lives in `<Text>` of an `<AxReportDesign>`. This server's scaffold writes
 * a `<![CDATA[…]]>` block; shipped reports write XML-ESCAPED text. Both are read
 * and written back in the form they were found in. For the escaped form the exact
 * escaping convention (which of `" ' >` and CR are entities) is detected by
 * requiring `encode(decode(original)) === original`; a document that does not
 * round-trip is refused instead of being rewritten with a different convention.
 */

import * as fs from 'fs/promises';
import { parseStringPromise } from '../../utils/xml.js';
import { locateDataSet } from './reportDesignXml.js';

export interface ReportRdlResult {
  success: boolean;
  message: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Locating and (de)coding the RDL text inside the AxReport
// ─────────────────────────────────────────────────────────────────────────────

interface EscapeStyle { quot: boolean; apos: boolean; gt: boolean; cr: boolean }

interface RdlSlot {
  /** Offsets of the `<Text>` element's INNER text in the file content. */
  innerStart: number;
  innerEnd: number;
  form: 'cdata' | 'escaped';
  style?: EscapeStyle;
  rdl: string;
}

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9A-Fa-f]+|#\d+|lt|gt|amp|quot|apos);/g, (_m, e: string) => {
    switch (e) {
      case 'lt': return '<';
      case 'gt': return '>';
      case 'amp': return '&';
      case 'quot': return '"';
      case 'apos': return "'";
      default:
        return String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    }
  });
}

function encodeEntities(s: string, st: EscapeStyle): string {
  let out = s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  if (st.gt) out = out.replace(/>/g, '&gt;');
  if (st.quot) out = out.replace(/"/g, '&quot;');
  if (st.apos) out = out.replace(/'/g, '&apos;');
  if (st.cr) out = out.replace(/\r/g, '&#xD;');
  return out;
}

/** Find the escape convention that reproduces `raw` exactly, if any. */
function detectEscapeStyle(raw: string, decoded: string): EscapeStyle | undefined {
  for (let bits = 0; bits < 16; bits++) {
    const st = { quot: !!(bits & 1), apos: !!(bits & 2), gt: !!(bits & 4), cr: !!(bits & 8) };
    if (encodeEntities(decoded, st) === raw) return st;
  }
  return undefined;
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function maskCdata(content: string): string {
  return content.replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, m => ' '.repeat(m.length));
}

function locateRdl(content: string):
  | { ok: true; slot: RdlSlot }
  | { ok: false; reason: string } {
  const masked = maskCdata(content);
  const designs = [...masked.matchAll(/<AxReportDesign\b[^>]*>([\s\S]*?)<\/AxReportDesign>/g)];
  const withText = designs.filter(d => /<Text\b[^>]*>/.test(d[1]) && !/<Text\b[^>]*\/>/.test(d[1]));
  if (withText.length === 0) {
    return { ok: false, reason: 'the report has no design carrying RDL text (<Text>).' };
  }
  if (withText.length > 1) {
    return {
      ok: false,
      reason: `the report has ${withText.length} designs with RDL; which one to edit is a choice this operation will not guess.`,
    };
  }
  const d = withText[0];
  const designStart = d.index! + d[0].indexOf(d[1]);
  const open = /<Text\b[^>]*>/.exec(d[1])!;
  const innerStart = designStart + open.index + open[0].length;
  const closeRel = d[1].indexOf('</Text>', open.index);
  if (closeRel < 0) return { ok: false, reason: '<Text> is not closed.' };
  const innerEnd = designStart + closeRel;
  const raw = content.slice(innerStart, innerEnd);

  const cd = /^\s*<!\[CDATA\[([\s\S]*)\]\]>\s*$/.exec(raw);
  if (cd) {
    if (cd[1].includes(']]>')) return { ok: false, reason: '<Text> holds several CDATA sections.' };
    // Only the CDATA payload is the RDL; keep the surrounding whitespace out of the slot.
    const cdStart = innerStart + raw.indexOf('<![CDATA[') + '<![CDATA['.length;
    return {
      ok: true,
      slot: { innerStart: cdStart, innerEnd: cdStart + cd[1].length, form: 'cdata', rdl: cd[1] },
    };
  }
  if (raw.includes('<')) return { ok: false, reason: '<Text> mixes markup and escaped text.' };
  const decoded = decodeEntities(raw);
  const style = detectEscapeStyle(raw, decoded);
  if (!style) {
    return {
      ok: false,
      reason: 'the escaped RDL does not round-trip through a known escaping convention, so writing it back would change bytes this operation did not mean to touch.',
    };
  }
  return { ok: true, slot: { innerStart, innerEnd, form: 'escaped', style, rdl: decoded } };
}

function encodeRdl(slot: RdlSlot, rdl: string): string {
  return slot.form === 'cdata' ? rdl : encodeEntities(rdl, slot.style!);
}

// ─────────────────────────────────────────────────────────────────────────────
// A tiny element tree with source offsets (the RDL is well-formed by the time
// this runs, so a tag scanner is enough — and it keeps every offset exact).
// ─────────────────────────────────────────────────────────────────────────────

interface Node {
  name: string;
  /** Offset of `<`. */
  start: number;
  /** Offset just past the opening tag. */
  openEnd: number;
  /** Offset of `</` of the closing tag (= openEnd for self-closing). */
  closeStart: number;
  /** Offset just past the closing tag. */
  end: number;
  selfClosing: boolean;
  children: Node[];
  parent?: Node;
}

function maskNonElements(text: string): string {
  return text.replace(/<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[[\s\S]*?\]\]>/g, m => ' '.repeat(m.length));
}

function buildTree(text: string): Node | undefined {
  const masked = maskNonElements(text);
  const re = /<(\/?)([A-Za-z_][\w:.-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;
  const root: Node = { name: '#root', start: 0, openEnd: 0, closeStart: text.length, end: text.length, selfClosing: false, children: [] };
  let cur = root;
  let m: RegExpExecArray | null;
  while ((m = re.exec(masked)) !== null) {
    const [whole, closing, name, , selfClose] = m;
    if (closing) {
      if (cur.name !== name || !cur.parent) return undefined;
      cur.closeStart = m.index;
      cur.end = m.index + whole.length;
      cur = cur.parent;
    } else {
      const n: Node = {
        name, start: m.index, openEnd: m.index + whole.length,
        closeStart: m.index + whole.length, end: m.index + whole.length,
        selfClosing: !!selfClose, children: [], parent: cur,
      };
      cur.children.push(n);
      if (!selfClose) cur = n;
    }
  }
  return cur === root ? root.children[0] : undefined;
}

function descendants(n: Node, name: string, out: Node[] = []): Node[] {
  for (const c of n.children) {
    if (c.name === name) out.push(c);
    descendants(c, name, out);
  }
  return out;
}

const child = (n: Node, name: string): Node | undefined => n.children.find(c => c.name === name);
const kids = (n: Node | undefined, name: string): Node[] => (n ? n.children.filter(c => c.name === name) : []);
const inner = (text: string, n: Node): string => text.slice(n.openEnd, n.closeStart);

// ─────────────────────────────────────────────────────────────────────────────
// Static validator
// ─────────────────────────────────────────────────────────────────────────────

export interface RdlValidation {
  ok: boolean;
  /** `fatal` = not well-formed / not a report: nothing else could be checked. */
  fatal: boolean;
  errors: string[];
}

const NAMED_ITEMS = ['Textbox', 'Tablix', 'Rectangle', 'Image', 'Line', 'Chart', 'Subreport', 'GaugePanel', 'Map'];

/**
 * Checks an RDL document without rendering it. This is a floor, not a proof: it
 * catches the mistakes an edit here could introduce (a column bound to a field
 * that does not exist, a parameter nobody declared, a duplicated name, a tablix
 * whose rows and columns disagree) — it cannot know the SSRS renderer is happy.
 */
export async function validateRdl(rdl: string): Promise<RdlValidation> {
  const errors: string[] = [];
  let doc: any;
  try {
    doc = await parseStringPromise(rdl.replace(/^﻿/, ''), { strict: true });
  } catch (e) {
    return { ok: false, fatal: true, errors: [`not well-formed XML: ${(e as Error).message.split('\n')[0]}`] };
  }
  const root = doc && doc.Report;
  if (!root) return { ok: false, fatal: true, errors: ['the root element is not <Report>.'] };
  const ns: string = root.$?.xmlns ?? '';
  if (!/\/reportdefinition$/.test(ns)) {
    return { ok: false, fatal: true, errors: [`unrecognised report namespace '${ns || '(none)'}'.`] };
  }

  // Dataset fields and declared parameters.
  const fieldNames = new Set<string>();
  for (const ds of root.DataSets?.[0]?.DataSet ?? []) {
    for (const f of ds.Fields?.[0]?.Field ?? []) if (f.$?.Name) fieldNames.add(f.$.Name);
  }
  const paramNames = new Set<string>();
  for (const p of root.ReportParameters?.[0]?.ReportParameter ?? []) if (p.$?.Name) paramNames.add(p.$.Name);

  const text = maskNonElements(rdl);
  // Expressions only: skip the XML declaration/comments, nothing else is masked,
  // so a `Fields!X` in a string literal is checked too — a false positive there is
  // far cheaper than a missed binding.
  const missingFields = new Set<string>();
  for (const m of text.matchAll(/\bFields!([A-Za-z_]\w*)/g)) if (!fieldNames.has(m[1])) missingFields.add(m[1]);
  for (const f of missingFields) errors.push(`Fields!${f} does not resolve to a dataset field.`);
  const missingParams = new Set<string>();
  for (const m of text.matchAll(/\bParameters!([A-Za-z_]\w*)/g)) if (!paramNames.has(m[1])) missingParams.add(m[1]);
  for (const p of missingParams) errors.push(`Parameters!${p} does not resolve to a declared report parameter.`);

  // Unique names.
  const seen = new Map<string, number>();
  const itemRe = new RegExp(`<(${NAMED_ITEMS.join('|')})\\s+[^>]*?\\bName="([^"]*)"`, 'g');
  for (const m of text.matchAll(itemRe)) seen.set(m[2], (seen.get(m[2]) ?? 0) + 1);
  for (const [n, c] of seen) if (c > 1) errors.push(`report item name '${n}' is used ${c} times; names must be unique.`);
  const groups = new Map<string, number>();
  for (const m of text.matchAll(/<Group\s+[^>]*?\bName="([^"]*)"/g)) groups.set(m[1], (groups.get(m[1]) ?? 0) + 1);
  for (const [n, c] of groups) if (c > 1) errors.push(`group name '${n}' is used ${c} times; names must be unique.`);

  // Tablix integrity: every row, and the column hierarchy, must agree with the column count.
  const tree = buildTree(rdl);
  if (tree) {
    for (const t of descendants(tree, 'Tablix')) {
      const tname = /\bName="([^"]*)"/.exec(rdl.slice(t.start, t.openEnd))?.[1] ?? '?';
      const body = child(t, 'TablixBody');
      const cols = kids(child(body ?? t, 'TablixColumns'), 'TablixColumn').length;
      const rows = kids(child(body ?? t, 'TablixRows'), 'TablixRow');
      for (const [i, r] of rows.entries()) {
        const cells = kids(child(r, 'TablixCells'), 'TablixCell').length;
        if (cells !== cols) errors.push(`tablix '${tname}' row ${i + 1} has ${cells} cell(s) but the tablix has ${cols} column(s).`);
      }
      const members = kids(child(child(t, 'TablixColumnHierarchy') ?? t, 'TablixMembers'), 'TablixMember').length;
      if (members !== cols) errors.push(`tablix '${tname}' has ${members} column member(s) but ${cols} column(s).`);
    }
  }
  return { ok: errors.length === 0, fatal: false, errors };
}

/** Errors in `after` that `before` did not already have. */
function introduced(before: RdlValidation, after: RdlValidation): string[] {
  const had = new Set(before.errors);
  return after.errors.filter(e => !had.has(e));
}

// ─────────────────────────────────────────────────────────────────────────────
// Splice helper
// ─────────────────────────────────────────────────────────────────────────────

interface Edit { at: number; del: number; ins: string }

function applyEdits(text: string, edits: Edit[]): string {
  const sorted = [...edits].sort((a, b) => b.at - a.at);
  let out = text;
  for (const e of sorted) out = out.slice(0, e.at) + e.ins + out.slice(e.at + e.del);
  return out;
}

/** The whitespace run between two sibling nodes, when it is whitespace only. */
function gapBetween(text: string, a: Node, b: Node): string {
  const g = text.slice(a.end, b.start);
  return /^\s*$/.test(g) ? g : '';
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared load / validate / write
// ─────────────────────────────────────────────────────────────────────────────

interface Loaded { content: string; slot: RdlSlot; before: RdlValidation }

async function load(filePath: string, action: string): Promise<Loaded | ReportRdlResult> {
  const content = (await fs.readFile(filePath, 'utf-8')).replace(/^﻿/, '');
  if (!/<AxReport\b/.test(content)) {
    return { success: false, message: `❌ report-design(${action}): '${filePath}' is not an AxReport — nothing was written.` };
  }
  const located = locateRdl(content);
  if (!located.ok) {
    return { success: false, message: `❌ report-design(${action}): ${located.reason} Nothing was written.` };
  }
  const before = await validateRdl(located.slot.rdl);
  if (before.fatal) {
    return {
      success: false,
      message: `❌ report-design(${action}): the existing RDL is not one this operation can edit — ${before.errors.join('; ')} Nothing was written.`,
    };
  }
  return { content, slot: located.slot, before };
}

async function validateAndWrite(
  filePath: string, action: string, l: Loaded, nextRdl: string,
): Promise<ReportRdlResult | undefined> {
  const after = await validateRdl(nextRdl);
  const problems = after.fatal ? after.errors : introduced(l.before, after);
  if (problems.length > 0) {
    return {
      success: false,
      message:
        `❌ report-design(${action}): the edited RDL failed validation, so NOTHING was written:\n` +
        problems.map(p => `  - ${p}`).join('\n'),
    };
  }
  const next =
    l.content.slice(0, l.slot.innerStart) + encodeRdl(l.slot, nextRdl) + l.content.slice(l.slot.innerEnd);
  await fs.writeFile(filePath, `﻿${next}`, 'utf-8');
  return undefined;
}

const isResult = (x: Loaded | ReportRdlResult): x is ReportRdlResult => 'success' in x;

// ─────────────────────────────────────────────────────────────────────────────
// fix-labels
// ─────────────────────────────────────────────────────────────────────────────

const BARE_LABEL = /^@[A-Za-z_]\w*(?::[A-Za-z_]\w*)?$/;

/**
 * A textbox `<Value>` of exactly `@SYS313987` renders the raw id: label ids are
 * resolved only inside the `=Labels!@…` expression form, which is what shipped
 * designs use. Rewrites each such value; touches nothing else.
 */
export async function fixReportLabelIds(filePath: string): Promise<ReportRdlResult> {
  const l = await load(filePath, 'fix-labels');
  if (isResult(l)) return l;
  const rdl = l.slot.rdl;
  const tree = buildTree(rdl);
  if (!tree) return { success: false, message: '❌ report-design(fix-labels): the RDL could not be scanned. Nothing was written.' };

  const edits: Edit[] = [];
  const fixed: string[] = [];
  for (const tb of descendants(tree, 'Textbox')) {
    // Only the text itself: a textbox's own <Value> (scaffold shape) and the <Value>
    // of each <TextRun> (shipped shape). A deeper <Value>, such as a drillthrough
    // parameter in <ActionInfo>, is not display text and must never be rewritten.
    const textValues = [
      ...kids(tb, 'Value'),
      ...descendants(tb, 'TextRun').flatMap(run => kids(run, 'Value')),
    ];
    for (const v of textValues) {
      if (v.selfClosing) continue;
      const raw = inner(rdl, v);
      const id = decodeEntities(raw).trim();
      if (BARE_LABEL.test(id)) {
        edits.push({ at: v.openEnd, del: raw.length, ins: `=Labels!${id}` });
        fixed.push(id);
      }
    }
  }
  if (edits.length === 0) {
    return { success: true, message: '✅ report-design(fix-labels): no textbox holds a bare label id — nothing to fix.' };
  }
  const failed = await validateAndWrite(filePath, 'fix-labels', l, applyEdits(rdl, edits));
  if (failed) return failed;
  return {
    success: true,
    message:
      `✅ report-design(fix-labels): rewrote ${fixed.length} textbox value(s) to the =Labels! form: ` +
      `${[...new Set(fixed)].join(', ')}. The edited RDL passed static validation (well-formed, fields and ` +
      'parameters resolve, names unique); it has not been rendered.',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// add-column
// ─────────────────────────────────────────────────────────────────────────────

type RowKind = 'header' | 'detail' | 'summary';

const FIELD_VALUE = /^=Fields!([A-Za-z_]\w*)\.Value$/;
const SUM_VALUE = /^=Sum\(Fields!([A-Za-z_]\w*)\.Value\)$/;
const NUMERIC_TYPES = new Set(['System.Double', 'System.Int32', 'System.Int64', 'System.Decimal', 'System.Single', 'System.Int16']);

function refuse(why: string): ReportRdlResult {
  return {
    success: false,
    message:
      `❌ report-design(add-column): ${why} Nothing was written. This operation only edits tablixes of a ` +
      'shape it fully recognises; place the column in the Report Designer instead.',
  };
}

function cellTextbox(cell: Node): Node | undefined {
  const contents = child(cell, 'CellContents');
  const boxes = kids(contents, 'Textbox');
  return contents && contents.children.length === 1 && boxes.length === 1 ? boxes[0] : undefined;
}

/**
 * Append a column, bound to a dataset field, to the report's tablix.
 *
 * Each new cell is a CLONE of the last cell of its row with only the name and the
 * value replaced, so fonts, borders, padding and the textbox shape (scaffold's flat
 * `<Value>` or shipped `Paragraphs/TextRuns`) match the neighbours. The consequence
 * is that the new cell inherits its neighbour's alignment and number format too.
 */
export async function addReportColumn(
  filePath: string,
  fieldName: string,
  opts: { datasetName?: string; caption?: string } = {},
): Promise<ReportRdlResult> {
  if (!fieldName || !/^[A-Za-z_]\w*$/.test(fieldName)) {
    return { success: false, message: `❌ report-design(add-column): fieldName '${fieldName}' is not a valid AOT name.` };
  }
  const caption = opts.caption?.trim() || fieldName;
  // A value starting with "=" is an SSRS expression, and the validator only checks
  // Fields!/Parameters! references, so a typo here would build and fail at render.
  if (caption.startsWith('=')) {
    return refuse('the header caption starts with "=", which SSRS evaluates as an expression. Pass a label id (@Model:Key) or plain text.');
  }
  const l = await load(filePath, 'add-column');
  if (isResult(l)) return l;
  const { content, slot } = l;
  const rdl = slot.rdl;
  const tree = buildTree(rdl);
  if (!tree || tree.name !== 'Report') return refuse('the RDL could not be scanned.');

  // ── Which tablix ─────────────────────────────────────────────────────────
  const tablixes = descendants(tree, 'Tablix');
  if (tablixes.length === 0) return refuse('the design has no tablix.');
  if (tablixes.some(t => descendants(t, 'Tablix').length > 0)) return refuse('a tablix is nested inside another.');
  const tablixDataset = (t: Node): string | undefined => {
    const ds = t.children.find(c => c.name === 'DataSetName');
    return ds ? decodeEntities(inner(rdl, ds)).trim() : undefined;
  };
  const tablixName = (t: Node): string => /\bName="([^"]*)"/.exec(rdl.slice(t.start, t.openEnd))?.[1] ?? '?';
  let candidates = tablixes;
  if (opts.datasetName) {
    candidates = tablixes.filter(t => tablixDataset(t)?.toLowerCase() === opts.datasetName!.trim().toLowerCase());
  }
  if (candidates.length !== 1) {
    return refuse(
      candidates.length === 0
        ? `no tablix reads dataset '${opts.datasetName}'. Tablixes: ${tablixes.map(t => `${tablixName(t)} (${tablixDataset(t) ?? 'no dataset'})`).join(', ')}.`
        : `${candidates.length} tablixes match (${candidates.map(tablixName).join(', ')}); pass datasetName to pick ` +
          'one — and a dataset with several tablixes is not something this operation will choose between.',
    );
  }
  const tablix = candidates[0];
  const dsName = tablixDataset(tablix);
  if (!dsName) return refuse(`tablix '${tablixName(tablix)}' names no dataset.`);

  // ── Recognise the tablix shape ───────────────────────────────────────────
  const body = child(tablix, 'TablixBody');
  const colsEl = child(body ?? tablix, 'TablixColumns');
  const columns = kids(colsEl, 'TablixColumn');
  const rows = kids(child(body ?? tablix, 'TablixRows'), 'TablixRow');
  const colMembersEl = child(child(tablix, 'TablixColumnHierarchy') ?? tablix, 'TablixMembers');
  const colMembers = kids(colMembersEl, 'TablixMember');
  if (columns.length === 0 || rows.length < 2) return refuse(`tablix '${tablixName(tablix)}' needs at least a header and a detail row.`);
  if (colMembers.length !== columns.length || colMembers.some(m => m.children.length > 0)) {
    return refuse(`tablix '${tablixName(tablix)}' has column groups or headers; its column hierarchy is not one plain member per column.`);
  }
  if (/<(ColSpan|RowSpan)\b/.test(rdl.slice(tablix.start, tablix.end))) {
    return refuse(`tablix '${tablixName(tablix)}' uses cell spans.`);
  }

  interface RowInfo { row: Node; cells: Node[]; last: Node; kind: RowKind; values: string[] }
  const rowInfos: RowInfo[] = [];
  for (const [i, row] of rows.entries()) {
    const cells = kids(child(row, 'TablixCells'), 'TablixCell');
    if (cells.length !== columns.length) return refuse(`row ${i + 1} has ${cells.length} cell(s) for ${columns.length} column(s).`);
    const values: string[] = [];
    for (const c of cells) {
      const tb = cellTextbox(c);
      if (!tb) return refuse(`row ${i + 1} holds a cell that is not a single textbox.`);
      const vs = descendants(tb, 'Value');
      if (vs.length !== 1) return refuse(`row ${i + 1} holds a textbox with ${vs.length} values.`);
      values.push(vs[0].selfClosing ? '' : decodeEntities(inner(rdl, vs[0])).trim());
    }
    const allField = values.every(v => FIELD_VALUE.test(v));
    const summaryish = values.every(v => v === '' || v === '""' || v === '"Total"' || FIELD_VALUE.test(v) || SUM_VALUE.test(v));
    const headerish = values.every(v => v !== '' && (/^=Labels!@\S+$/.test(v) || !/^[="]/.test(v)));
    let kind: RowKind;
    if (i === 0 && headerish) kind = 'header';
    else if (allField) kind = 'detail';
    else if (summaryish) kind = 'summary';
    else return refuse(`row ${i + 1} (${values.map(v => v || '(empty)').join(' | ')}) is neither a header, a detail nor a summary row it recognises.`);
    rowInfos.push({ row, cells, last: cells[cells.length - 1], kind, values });
  }
  if (rowInfos[0].kind !== 'header') return refuse('the first row is not a recognisable header row.');
  const details = rowInfos.filter(r => r.kind === 'detail');
  if (details.length !== 1) return refuse(`found ${details.length} rows that look like a detail row; expected exactly one.`);

  // Already there?
  if (details[0].values.some(v => FIELD_VALUE.exec(v)?.[1].toLowerCase() === fieldName.toLowerCase())) {
    return {
      success: true,
      message: `✅ report-design(add-column): tablix '${tablixName(tablix)}' already shows '${fieldName}' — nothing to add.`,
    };
  }

  // ── The dataset field ────────────────────────────────────────────────────
  const edits: Edit[] = [];
  const rdlDs = descendants(tree, 'DataSet').find(d => new RegExp(`\\bName="${dsName}"`).test(rdl.slice(d.start, d.openEnd)));
  if (!rdlDs) return refuse(`the RDL declares no dataset '${dsName}'.`);
  const rdlFieldsEl = child(rdlDs, 'Fields');
  const rdlField = kids(rdlFieldsEl, 'Field')
    .find(f => new RegExp(`\\bName="${fieldName}"`, 'i').test(rdl.slice(f.start, f.openEnd)));
  let typeName = rdlField && child(rdlField, 'rd:TypeName')
    ? decodeEntities(inner(rdl, child(rdlField, 'rd:TypeName')!)).trim() : undefined;
  let addedToRdlDataset = false;

  if (!rdlField) {
    // The field may exist in the AxReport metadata (refresh-dataset adds it there)
    // but not in the RDL's own copy of the dataset; add it, from the metadata.
    const meta = locateDataSet(content, dsName);
    let alias: string | undefined;
    if (meta.ok) {
      const block = maskCdata(content).slice(meta.start, meta.end);
      const fm = [...block.matchAll(/<AxReportDataSetField>([\s\S]*?)<\/AxReportDataSetField>/g)]
        .find(m => new RegExp(`<Name>\\s*${fieldName}\\s*</Name>`, 'i').test(m[1]));
      if (fm) {
        alias = /<Alias>([^<]+)<\/Alias>/.exec(fm[1])?.[1]?.trim();
        typeName = /<DataType>([^<]+)<\/DataType>/.exec(fm[1])?.[1]?.trim() ?? 'System.String';
        alias ??= `${dsName}.1.${fieldName}`;
      }
    }
    if (!alias) {
      return refuse(`'${fieldName}' is not a field of dataset '${dsName}' in the RDL or in the report's dataset metadata. Run refresh-dataset first if it lives on the temp table.`);
    }
    const hasRd = /\sxmlns:rd="/.test(rdl.slice(tree.start, tree.openEnd));
    const sampleField = kids(rdlFieldsEl, 'Field')[0];
    const fIndent = sampleField ? (/\n([ \t]*)$/.exec(rdl.slice(0, sampleField.start))?.[1] ?? '        ') : '        ';
    const fieldXml =
      `<Field Name="${fieldName}">\n${fIndent}  <DataField>${xmlEscape(alias)}</DataField>\n` +
      (hasRd ? `${fIndent}  <rd:TypeName>${xmlEscape(typeName!)}</rd:TypeName>\n` : '') +
      `${fIndent}</Field>`;
    if (rdlFieldsEl && !rdlFieldsEl.selfClosing) {
      const lastF = kids(rdlFieldsEl, 'Field').pop();
      if (lastF) edits.push({ at: lastF.end, del: 0, ins: `\n${fIndent}${fieldXml}` });
      else edits.push({ at: rdlFieldsEl.openEnd, del: 0, ins: `\n${fIndent}${fieldXml}\n${fIndent.slice(2)}` });
    } else if (rdlFieldsEl) {
      edits.push({ at: rdlFieldsEl.start, del: rdlFieldsEl.end - rdlFieldsEl.start, ins: `<Fields>\n${fIndent}${fieldXml}\n${fIndent.slice(2)}</Fields>` });
    } else {
      const q = child(rdlDs, 'Query');
      if (!q) return refuse(`dataset '${dsName}' has no <Query> to anchor a <Fields> collection after.`);
      edits.push({ at: q.end, del: 0, ins: `\n${fIndent.slice(2)}<Fields>\n${fIndent}${fieldXml}\n${fIndent.slice(2)}</Fields>` });
    }
    addedToRdlDataset = true;
  }
  const numeric = NUMERIC_TYPES.has(typeName ?? '') || /^(Double|Int32|Int64|Decimal)$/.test((typeName ?? '').replace(/^System\./, ''));

  // ── New cells, one per row, cloned from the row's last cell ──────────────
  const captionValue = /^@[A-Za-z_]\w*(?::[A-Za-z_]\w*)?$/.test(caption) ? `=Labels!${caption}` : caption;
  for (const [i, ri] of rowInfos.entries()) {
    const tb = cellTextbox(ri.last)!;
    const cellText = rdl.slice(ri.last.start, ri.last.end);
    if (/<ActionInfo\b|<ToolTip\b|<Visibility\b/.test(cellText)) {
      return refuse(`row ${i + 1}'s last cell carries an action, tooltip or visibility rule, which a clone would copy.`);
    }
    const valueNode = descendants(tb, 'Value')[0];
    const [rowPrefix, newValue] =
      ri.kind === 'header' ? ['Hdr', captionValue]
        : ri.kind === 'detail' ? ['Det', `=Fields!${fieldName}.Value`]
          : [`Sum${i + 1}`, numeric ? `=Sum(Fields!${fieldName}.Value)` : ''];
    const newName = `${rowPrefix}_${fieldName}`;
    // Offsets inside the cell text.
    const rel = (n: number) => n - ri.last.start;
    const nameAttr = /\bName="([^"]*)"/.exec(rdl.slice(tb.start, tb.openEnd));
    if (!nameAttr) return refuse(`row ${i + 1}'s last cell has a textbox whose Name is not a double-quoted attribute.`);
    const nameAbs = tb.start + nameAttr.index + nameAttr[0].indexOf('"') + 1;
    const cellEdits: Edit[] = [
      { at: rel(valueNode.openEnd), del: valueNode.selfClosing ? 0 : valueNode.closeStart - valueNode.openEnd, ins: xmlEscape(newValue) },
      { at: rel(nameAbs), del: nameAttr[1].length, ins: newName },
    ];
    const dn = descendants(tb, 'rd:DefaultName')[0];
    if (dn && !dn.selfClosing) cellEdits.push({ at: rel(dn.openEnd), del: dn.closeStart - dn.openEnd, ins: newName });
    if (valueNode.selfClosing) {
      cellEdits[0] = { at: rel(valueNode.start), del: valueNode.end - valueNode.start, ins: `<Value>${xmlEscape(newValue)}</Value>` };
    }
    const cloned = applyEdits(cellText, cellEdits);
    const prev = ri.cells[ri.cells.length - 2];
    edits.push({ at: ri.last.end, del: 0, ins: `${prev ? gapBetween(rdl, prev, ri.last) : ''}${cloned}` });
  }

  // ── Column, column member, tablix width ──────────────────────────────────
  const lastCol = columns[columns.length - 1];
  const colText = rdl.slice(lastCol.start, lastCol.end);
  edits.push({ at: lastCol.end, del: 0, ins: `${columns.length > 1 ? gapBetween(rdl, columns[columns.length - 2], lastCol) : ''}${colText}` });
  const lastMember = colMembers[colMembers.length - 1];
  edits.push({ at: lastMember.end, del: 0, ins: `${colMembers.length > 1 ? gapBetween(rdl, colMembers[colMembers.length - 2], lastMember) : ''}${rdl.slice(lastMember.start, lastMember.end)}` });

  const wRe = /^(\d+(?:\.\d+)?)(in|cm|mm|pt)$/;
  const colW = child(lastCol, 'Width') ? wRe.exec(inner(rdl, child(lastCol, 'Width')!).trim()) : null;
  const tabW = child(tablix, 'Width');
  if (tabW) {
    const tw = wRe.exec(inner(rdl, tabW).trim());
    if (!colW || !tw || colW[2] !== tw[2]) {
      return refuse(`the tablix width ('${inner(rdl, tabW).trim()}') and the column width are not in the same unit, so the new width cannot be computed.`);
    }
    const total = +(parseFloat(tw[1]) + parseFloat(colW[1])).toFixed(4);
    edits.push({ at: tabW.openEnd, del: tabW.closeStart - tabW.openEnd, ins: `${total}${tw[2]}` });
  }

  const failed = await validateAndWrite(filePath, 'add-column', l, applyEdits(rdl, edits));
  if (failed) return failed;
  return {
    success: true,
    message:
      `✅ report-design(add-column): appended column '${fieldName}' to tablix '${tablixName(tablix)}' (dataset '${dsName}')` +
      `${addedToRdlDataset ? ', and added the field to the RDL dataset' : ''}. Header "${captionValue}", detail =Fields!${fieldName}.Value` +
      `${rowInfos.some(r => r.kind === 'summary') ? `, ${numeric ? 'Sum() in' : 'empty'} summary row(s)` : ''}.\n` +
      'The edited RDL passed static validation (well-formed, fields and parameters resolve, names unique, tablix ' +
      'rows match its columns); it has NOT been rendered. The new cells copy the last column\'s styling, and the ' +
      'page width is not checked — open the Report Designer to confirm the layout fits.',
  };
}
