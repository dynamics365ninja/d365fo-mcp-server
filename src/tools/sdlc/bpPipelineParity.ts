/**
 * Make a BP check on a UDE give the result the Azure DevOps build pipeline gives.
 *
 * Two differences were measured between xppbp on a UDE and the BP step of the
 * pipeline's X++ build, on a real ISV model (646 of 646 warnings on a nightly
 * build and 820 of 820 on a pull request, same object, rule and message):
 *
 * 1. Property rules. The pipeline restores newer Microsoft build packages whose
 *    BP extensions check OperationalDomain and SubscriberAccessLevel on tables and
 *    menu items. The UDE's xppbp (platform 7.0.8199.70, bin\BPExtensions) has no
 *    such rule, so a clean local check meets hundreds of these warnings in the
 *    pull request build. `checkPipelinePropertyRules` reproduces them with the
 *    pipeline's monikers and message texts. They are added only when the local
 *    xppbp reported none of them and its rule assemblies do not contain them, so
 *    a platform that ships the real rules keeps its own answer.
 *
 * 2. Labels. xppbp resolves a label used in X++ code through the compiled label
 *    assembly. When that is missing or out of date it reports BPErrorUnknownLabel
 *    for a label that exists, plus BPUnusedStrFmtArgument on every strFmt that uses
 *    it. run_bp_check compiles the labels first, and `findLabelArtifacts` marks
 *    any that still come through as likely false positives, so a caller does not
 *    create a label that is already there.
 */

import fs from 'fs/promises';
import path from 'path';
import { expectedTableBpDefaults, tableBpInputsFromXml } from '../../utils/bpCreateDefaults.js';
import { findLabelFileDirs } from '../write/compileLabels.js';
import { formDataSourceTables, tableOperationalDomain } from '../xml/formDataSourceDomain.js';

/** The monikers the pipeline's newer BP extensions report and the UDE's xppbp does not. */
export const PIPELINE_PROPERTY_MONIKERS = [
  'BPCheckTableOperationalDomainPropertyNotSpecified',
  'BPCheckTableOperationalDomainPropertyUnexpected',
  'BPCheckTableSubscriberAccessLevelPropertyNotSpecified',
  'BPCheckTableSubscriberAccessLevelPropertyUnexpected',
  'BPCheckMenuItemOperationalDomainPropertyNotSpecified',
  'BPCheckMenuItemOperationalDomainPropertyUnexpected',
  'BPCheckMenuItemSubscriberAccessLevelPropertyNotSpecified',
  'BPCheckMenuItemSubscriberAccessLevelPropertyUnexpected',
] as const;

/** The AOT folders whose objects the property rules look at. */
export const PROPERTY_RULE_FOLDERS = ['AxTable', 'AxMenuItemAction', 'AxMenuItemDisplay'] as const;

export interface ReproducedFinding {
  severity: 'Warning';
  /** AxTable, AxMenuItemAction or AxMenuItemDisplay. */
  elementType: string;
  /** dynamics://Table/<Name>, dynamics://MenuItemAction/<Name>, dynamics://MenuItemDisplay/<Name>. */
  path: string;
  moniker: string;
  message: string;
}

const PERMISSIONS = ['Correct', 'Create', 'Delete', 'Invoke', 'Read', 'Update'];

/** The text of a direct child element of the root (its property block), or undefined. */
function rootProperty(xml: string, name: string): string | undefined {
  const m = new RegExp(`^[ \\t]*<${name}>\\s*([^<]*?)\\s*</${name}>`, 'm').exec(xml);
  return m ? m[1] : undefined;
}

/** Whether the root has the element at all (also as an empty or self-closing one). */
function hasRootElement(xml: string, name: string): boolean {
  return new RegExp(`^[ \\t]*<${name}[\\s/>]`, 'm').test(xml);
}

/** The rights set under SubscriberAccessLevel, e.g. { Read: 'Allow' }. */
function accessRights(xml: string): Record<string, string> {
  const block = /<SubscriberAccessLevel>([\s\S]*?)<\/SubscriberAccessLevel>/.exec(xml)?.[1] ?? '';
  const rights: Record<string, string> = {};
  // Visual Studio writes each right with an empty namespace: <Read xmlns="">Allow</Read>.
  for (const m of block.matchAll(/<([A-Za-z]+)\b[^>]*>\s*([^<]*?)\s*<\/\1>/g)) rights[m[1]] = m[2];
  return rights;
}

function allRights(rights: Record<string, string>, value: string): boolean {
  return PERMISSIONS.every(p => rights[p] === value);
}

function rootName(xml: string): string | undefined {
  return /<(AxTable|AxMenuItemAction|AxMenuItemDisplay)[\s>]/.exec(xml)?.[1];
}

/** The pipeline's reason text for a table, which differs slightly from bpCreateDefaults' short form. */
function tableReason(xml: string): { domain: string; noAccess: boolean; why: string } {
  const inputs = tableBpInputsFromXml(xml);
  const expected = expectedTableBpDefaults(inputs);
  const noAccess = expected.subscriberAccessLevel.Read === 'Deny';
  return { domain: expected.operationalDomain, noAccess, why: `the value for property ${expected.reason}` };
}

export interface PropertyRuleInput {
  /** The object's file name without extension, used when the XML has no <Name>. */
  fileName: string;
  xml: string;
}

/**
 * Whether every data source of a form is a Local table. Undefined when the form or
 * one of its tables cannot be read: the rule then does not apply, as it cannot be
 * decided.
 */
export type FormAllLocalResolver = (formName: string) => Promise<boolean | undefined>;

/**
 * The pipeline's OperationalDomain and SubscriberAccessLevel findings for these
 * objects. Rules and texts as the pipeline reports them:
 *
 *   Table (not one that Extends another: it takes both from its base table)
 *     NotSpecified when the element is missing, Unexpected when it is missing or
 *     not the expected value (Company / Shared / Local from SaveDataPerCompany,
 *     TableType and TableGroup). SubscriberAccessLevel must be No Access on
 *     TempDB, InMemory and Staging tables, and must not be empty on the rest.
 *   Menu item (Action and Display)
 *     NotSpecified when either element is missing. An Action item on a class must
 *     be No Access. A Display item on a class must set some right. A Display item
 *     on a form whose data sources are all Local must be Local with No Access.
 */
export async function checkPipelinePropertyRules(
  inputs: PropertyRuleInput[],
  formAllLocal?: FormAllLocalResolver,
): Promise<ReproducedFinding[]> {
  const out: ReproducedFinding[] = [];
  for (const { fileName, xml } of inputs) {
    const root = rootName(xml);
    if (!root) continue;
    const name = rootProperty(xml, 'Name') || fileName;
    const od = rootProperty(xml, 'OperationalDomain');
    const hasOd = hasRootElement(xml, 'OperationalDomain');
    const hasSal = hasRootElement(xml, 'SubscriberAccessLevel');
    const rights = accessRights(xml);
    const add = (elementType: string, p: string, moniker: string, message: string) =>
      out.push({ severity: 'Warning', elementType, path: p, moniker, message });

    if (root === 'AxTable') {
      if (rootProperty(xml, 'Extends')) continue;
      const p = `dynamics://Table/${name}`;
      const { domain, noAccess, why } = tableReason(xml);
      if (!hasOd) add(root, p, 'BPCheckTableOperationalDomainPropertyNotSpecified', 'The OperationalDomain property is not set.');
      if (!hasOd || (od ?? '').toLowerCase() !== domain.toLowerCase()) {
        add(root, p, 'BPCheckTableOperationalDomainPropertyUnexpected',
          `The Expected value for OperationalDomain property is ${domain}, because ${why}.`);
      }
      if (!hasSal) add(root, p, 'BPCheckTableSubscriberAccessLevelPropertyNotSpecified', 'The SubscriberAccessLevel property is not set.');
      if (noAccess) {
        if (!allRights(rights, 'Deny')) {
          add(root, p, 'BPCheckTableSubscriberAccessLevelPropertyUnexpected',
            `The Expected value for SubscriberAccessLevel property is No Access, because ${why}.`);
        }
      } else if (Object.keys(rights).length === 0) {
        add(root, p, 'BPCheckTableSubscriberAccessLevelPropertyUnexpected',
          'The Expected value for SubscriberAccessLevel property is Read, because the value for property SubscriberAccessLevel is Unset.');
      }
      continue;
    }

    const kind = root === 'AxMenuItemAction' ? 'Action' : 'Display';
    const p = `dynamics://MenuItem${kind}/${name}`;
    const objectType = rootProperty(xml, 'ObjectType') || (kind === 'Display' ? 'Form' : 'Class');
    if (!hasOd) add(root, p, 'BPCheckMenuItemOperationalDomainPropertyNotSpecified', 'The OperationalDomain property is not set.');
    if (!hasSal) add(root, p, 'BPCheckMenuItemSubscriberAccessLevelPropertyNotSpecified', 'The SubscriberAccessLevel property is not set.');
    if (/^class$/i.test(objectType)) {
      if (kind === 'Action' && !allRights(rights, 'Deny')) {
        add(root, p, 'BPCheckMenuItemSubscriberAccessLevelPropertyUnexpected',
          'The Expected value for SubscriberAccessLevel property is No Access, because the menu item type is Action and ObjectType is Class.');
      }
      // A Display item on a class with any right set passes the pipeline; only an unset one is reported.
      if (kind === 'Display' && Object.keys(rights).length === 0) {
        add(root, p, 'BPCheckMenuItemSubscriberAccessLevelPropertyUnexpected',
          'The Expected value for SubscriberAccessLevel property is Read/Update/Create/Correct/Delete/Invoke, because the menu item type is Display and ObjectType is Class.');
      }
    } else if (kind === 'Display' && /^form$/i.test(objectType) && formAllLocal && hasOd) {
      // Only with an OperationalDomain set: on a ruleset where it is missing the
      // pipeline reports NotSpecified and nothing else, even for a form over TempDB
      // tables (three such items on the model this was checked against).
      const form = rootProperty(xml, 'Object');
      const allLocal = form ? await formAllLocal(form).catch(() => undefined) : undefined;
      if (allLocal) {
        const why = 'because the OperationalDomain property on all data sources is Local.';
        if (hasOd && (od ?? '').toLowerCase() !== 'local') {
          add(root, p, 'BPCheckMenuItemOperationalDomainPropertyUnexpected', `The Expected value for OperationalDomain property is Local, ${why}`);
        }
        if (!allRights(rights, 'Deny')) {
          add(root, p, 'BPCheckMenuItemSubscriberAccessLevelPropertyUnexpected', `The Expected value for SubscriberAccessLevel property is No Access, ${why}`);
        }
      }
    }
  }
  return out;
}

/** True when xppbp's own output already carries one of the property rules. */
export function xppbpReportsPropertyRules(output: string): boolean {
  return PIPELINE_PROPERTY_MONIKERS.some(m => output.includes(m));
}

const ruleAssemblyCache = new Map<string, boolean | undefined>();

/**
 * Whether the installed xppbp's rule assemblies contain the property rules:
 * true when one names them, false when none does, undefined when they could not
 * be read. Cached per framework directory, since the scan reads every BP DLL.
 */
export async function xppbpShipsPropertyRules(frameworkPath: string): Promise<boolean | undefined> {
  const key = frameworkPath.toLowerCase();
  if (ruleAssemblyCache.has(key)) return ruleAssemblyCache.get(key);
  let result: boolean | undefined;
  try {
    const bin = path.join(frameworkPath, 'bin');
    const files: string[] = [];
    for (const dir of [bin, path.join(bin, 'BPExtensions')]) {
      let names: string[] = [];
      try { names = await fs.readdir(dir); } catch { continue; }
      for (const n of names) {
        if (!/\.dll$/i.test(n)) continue;
        if (dir === bin && !/BestPractice/i.test(n)) continue;
        files.push(path.join(dir, n));
      }
    }
    if (files.length > 0) {
      const ascii = Buffer.from('OperationalDomainProperty', 'latin1');
      const utf16 = Buffer.from('OperationalDomainProperty', 'utf16le');
      result = false;
      for (const f of files) {
        const bytes = await fs.readFile(f);
        if (bytes.includes(ascii) || bytes.includes(utf16)) { result = true; break; }
      }
    }
  } catch {
    result = undefined;
  }
  ruleAssemblyCache.set(key, result);
  return result;
}

/** For tests: forget the cached assembly scans. */
export function resetPropertyRuleCache(): void {
  ruleAssemblyCache.clear();
}

/** Read the AxTable and menu item files of one model folder (`<store>\<Package>\<Model>`). */
export async function readPropertyRuleInputs(modelDir: string, only?: { folder: string; name: string }): Promise<PropertyRuleInput[]> {
  const inputs: PropertyRuleInput[] = [];
  for (const folder of PROPERTY_RULE_FOLDERS) {
    if (only && only.folder !== folder) continue;
    const dir = path.join(modelDir, folder);
    let names: string[] = [];
    try { names = await fs.readdir(dir); } catch { continue; }
    for (const n of names) {
      if (!/\.xml$/i.test(n)) continue;
      const fileName = n.slice(0, -4);
      if (only && fileName.toLowerCase() !== only.name.toLowerCase()) continue;
      try { inputs.push({ fileName, xml: await fs.readFile(path.join(dir, n), 'utf-8') }); } catch { /* unreadable: skip */ }
    }
  }
  return inputs;
}

/** The xppbp element type of a target, mapped to the AOT folder the property rules read. */
export function propertyRuleFolderFor(elementType: string): string | undefined {
  const t = elementType.toLowerCase().replace(/[-_\s]/g, '');
  if (t === 'table') return 'AxTable';
  if (t === 'menuitemaction') return 'AxMenuItemAction';
  if (t === 'menuitemdisplay') return 'AxMenuItemDisplay';
  return undefined;
}

/** The findings as xppbp's own detail lines, so parseBpFindings and the build summary read them. */
export function formatReproducedFindings(findings: ReproducedFinding[]): string {
  return findings
    .map(f => `BestPractices ${f.severity}: ${f.elementType} ${f.path}: ${f.moniker}: ${f.message}`)
    .join('\n');
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

/**
 * Every label of a package's label files, keyed `@file:id` in lower case, value =
 * the en-US text (else the first language found).
 */
export async function readModelLabelIndex(packageDir: string): Promise<Map<string, string>> {
  const index = new Map<string, string>();
  let dirs: string[] = [];
  try { dirs = await findLabelFileDirs(packageDir); } catch { return index; }
  const files: string[] = [];
  const stack = [...dirs];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: Array<{ name: string; isDirectory(): boolean }> = [];
    try { entries = await fs.readdir(dir, { withFileTypes: true }) as any; } catch { continue; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (/\.label\.txt$/i.test(e.name)) files.push(full);
    }
  }
  const rank = (f: string) => (/\.en-US\.label\.txt$/i.test(f) ? 0 : 1);
  files.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  for (const f of files) {
    const m = /^([^.]+)\.[^.]+\.label\.txt$/i.exec(path.basename(f));
    if (!m) continue;
    let text = '';
    try { text = await fs.readFile(f, 'utf-8'); } catch { continue; }
    for (const line of text.split(/\r?\n/)) {
      const l = /^([A-Za-z0-9_]+)=(.*)$/.exec(line.replace(/^﻿/, ''));
      if (!l) continue;
      const key = `@${m[1]}:${l[1]}`.toLowerCase();
      if (!index.has(key)) index.set(key, l[2]);
    }
  }
  return index;
}

export interface LabelArtifact {
  moniker: 'BPErrorUnknownLabel' | 'BPUnusedStrFmtArgument';
  path: string;
  /** The label the finding is about (for a strFmt finding, the label holding the placeholder). */
  label: string;
}

/**
 * The BPErrorUnknownLabel findings whose label exists in the model's label files,
 * and the BPUnusedStrFmtArgument findings in the same element whose placeholder
 * one of those labels contains. Both are what xppbp reports when it cannot read
 * the compiled label assembly, not defects in the source.
 */
export function findLabelArtifacts(
  findings: Array<{ moniker: string | null; path?: string; message?: string }>,
  labels: Map<string, string>,
): LabelArtifact[] {
  const artifacts: LabelArtifact[] = [];
  const labelsByPath = new Map<string, Array<{ id: string; text: string }>>();
  for (const f of findings) {
    if (f.moniker !== 'BPErrorUnknownLabel' || !f.path || !f.message) continue;
    const id = /'(@[A-Za-z0-9_]+:[A-Za-z0-9_]+)'/.exec(f.message)?.[1];
    if (!id) continue;
    const text = labels.get(id.toLowerCase());
    if (text === undefined) continue;
    artifacts.push({ moniker: 'BPErrorUnknownLabel', path: f.path, label: id });
    if (!labelsByPath.has(f.path)) labelsByPath.set(f.path, []);
    labelsByPath.get(f.path)!.push({ id, text });
  }
  for (const f of findings) {
    if (f.moniker !== 'BPUnusedStrFmtArgument' || !f.path || !f.message) continue;
    const ph = /'(%\d+)'/.exec(f.message)?.[1];
    const hit = ph ? labelsByPath.get(f.path)?.find(l => l.text.includes(ph)) : undefined;
    if (hit) artifacts.push({ moniker: 'BPUnusedStrFmtArgument', path: f.path, label: hit.id });
  }
  return artifacts;
}

/** The note that tells the caller which findings are label artifacts. */
export function renderLabelArtifacts(artifacts: LabelArtifact[], labelsCompiled: boolean): string {
  if (artifacts.length === 0) return '';
  const unknown = artifacts.filter(a => a.moniker === 'BPErrorUnknownLabel');
  const strFmt = artifacts.filter(a => a.moniker === 'BPUnusedStrFmtArgument');
  const shown = artifacts.slice(0, 20).map(a => `  • ${a.moniker} ${a.label} (${a.path})`);
  return (
    `\n\nLikely label false positives: ${unknown.length} BPErrorUnknownLabel and ${strFmt.length} BPUnusedStrFmtArgument ` +
    `finding(s) name labels that exist in the model's label files. xppbp reports them when it cannot read the ` +
    `compiled label assembly (<package>\\Resources)` +
    (labelsCompiled
      ? ', which can still happen after labelc when a label file was saved after the last compile or the assembly is locked.'
      : ', and the labels could not be compiled before this check.') +
    ` Do not create these labels again. The pipeline's BP step reports the same artefacts, so a gate that counts ` +
    `warnings one by one needs to ignore them.\n${shown.join('\n')}` +
    (artifacts.length > shown.length ? `\n  … and ${artifacts.length - shown.length} more` : '')
  );
}

// ---------------------------------------------------------------------------
// Putting it together for run_bp_check
// ---------------------------------------------------------------------------

/**
 * A form resolver that reads the form and its tables from the model folder on
 * disk, for a form the symbol index cannot answer for (a new, unindexed one).
 * A table outside the model folder makes the answer unknown.
 */
export function diskFormAllLocal(modelDir: string): FormAllLocalResolver {
  return async (formName: string) => {
    try {
      const formXml = await fs.readFile(path.join(modelDir, 'AxForm', `${formName}.xml`), 'utf-8');
      const tables = formDataSourceTables(formXml);
      if (tables.length === 0) return undefined;
      for (const t of tables) {
        const tableXml = await fs.readFile(path.join(modelDir, 'AxTable', `${t}.xml`), 'utf-8');
        if (tableOperationalDomain(tableXml) !== 'Local') return false;
      }
      return true;
    } catch {
      return undefined;
    }
  };
}

/** The model's best-practice suppressions (AxIgnoreDiagnosticList/*.xml), as `moniker|path` in lower case. */
export async function readBpSuppressions(modelDir: string): Promise<Set<string>> {
  const keys = new Set<string>();
  const dir = path.join(modelDir, 'AxIgnoreDiagnosticList');
  let names: string[] = [];
  try { names = await fs.readdir(dir); } catch { return keys; }
  for (const n of names) {
    if (!/\.xml$/i.test(n)) continue;
    let xml = '';
    try { xml = await fs.readFile(path.join(dir, n), 'utf-8'); } catch { continue; }
    for (const m of xml.matchAll(/<Diagnostic>([\s\S]*?)<\/Diagnostic>/g)) {
      const child = (tag: string) => new RegExp(`<${tag}>\\s*([^<]*?)\\s*</${tag}>`).exec(m[1])?.[1];
      if (child('DiagnosticType') !== 'BestPractices') continue;
      const moniker = child('Moniker');
      const target = child('Path');
      if (moniker && target) keys.add(`${moniker}|${target}`.toLowerCase());
    }
  }
  return keys;
}

export const REPRODUCED_HEADER =
  'Reproduced pipeline rules (not reported by this xppbp): the Azure DevOps build restores newer BP packages that check ' +
  'OperationalDomain and SubscriberAccessLevel, and this xppbp has no such rule. These findings reproduce them with the ' +
  "pipeline's monikers and messages, so they show up here before the pull request build reports them:";

export interface ParityOptions {
  frameworkPath: string;
  metadataPath: string;
  modelName: string;
  /** One entry per xppbp run; null is the whole-model run. */
  targets: Array<{ name: string; elementType: string } | null>;
  outputs: string[];
  /** Runs that did not execute (describeNonRun): nothing is added to them. */
  skip: boolean[];
  /** Index-backed form resolver, tried before the disk one. */
  indexFormAllLocal?: FormAllLocalResolver;
  labelsCompiled: boolean;
  /** Findings parser (parseBpFindings), passed in to avoid a module cycle. */
  parse: (output: string) => Array<{ moniker: string | null; path?: string; message?: string }>;
}

/**
 * What to add to each run's output: `appended` goes into the output (detail
 * lines, so the findings section and the build summary read them), `notes` goes
 * after the findings section. Never throws: parity is advisory, the xppbp result
 * stands on its own.
 */
export async function pipelineParitySections(o: ParityOptions): Promise<{ appended: string[]; notes: string[] }> {
  const appended = o.targets.map(() => '');
  const notes = o.targets.map(() => '');
  try {
    const modelDir = path.join(o.metadataPath, o.modelName, o.modelName);
    const reportsRules = o.outputs.some(xppbpReportsPropertyRules);
    const ships = reportsRules ? true : await xppbpShipsPropertyRules(o.frameworkPath);
    if (!reportsRules && ships !== true) {
      const disk = diskFormAllLocal(modelDir);
      const resolver: FormAllLocalResolver = async form =>
        (o.indexFormAllLocal ? await o.indexFormAllLocal(form).catch(() => undefined) : undefined) ?? disk(form);
      for (let i = 0; i < o.targets.length; i++) {
        if (o.skip[i]) continue;
        const t = o.targets[i];
        const folder = t ? propertyRuleFolderFor(t.elementType) : undefined;
        if (t && !folder) continue;
        const inputs = await readPropertyRuleInputs(modelDir, t && folder ? { folder, name: t.name } : undefined);
        // The pipeline's xppbp honours the model's suppression lists, so the reproduction does too:
        // run_bp_check prints a `path:` to suppress by, and a suppressed finding has to stop coming back.
        const suppressed = await readBpSuppressions(modelDir);
        const findings = (await checkPipelinePropertyRules(inputs, resolver))
          .filter(f => !suppressed.has(`${f.moniker}|${f.path}`.toLowerCase()));
        if (findings.length > 0) appended[i] = `\n\n${REPRODUCED_HEADER}\n${formatReproducedFindings(findings)}`;
      }
    }

    let labels: Map<string, string> | undefined;
    for (let i = 0; i < o.targets.length; i++) {
      if (o.skip[i] || !o.outputs[i].includes('BPErrorUnknownLabel')) continue;
      labels ??= await readModelLabelIndex(path.join(o.metadataPath, o.modelName));
      notes[i] = renderLabelArtifacts(findLabelArtifacts(o.parse(o.outputs[i]), labels), o.labelsCompiled);
    }
  } catch (e) {
    console.error(`[run_bp_check] pipeline parity skipped: ${(e as Error)?.message ?? e}`);
  }
  return { appended, notes };
}
