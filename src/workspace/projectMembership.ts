/**
 * "Is this object registered in a Visual Studio project?" — asked model-wide.
 *
 * Two callers used to answer this independently and both got it wrong in a
 * different way.
 *
 * `verify_d365fo_project` compared the right thing (the raw `Content Include`)
 * but only ever looked at the ACTIVE project, so an object registered in the
 * project that owns it reported `❌ Not in project`. Acting on that is worse
 * than the warning: adding the entry to the active project too puts one file in
 * two projects of one model and the element gets compiled twice.
 *
 * `inlineWriteVerification` looked at the active project as well, and compared
 * a resolved absolute path against the include:
 *
 *   path.resolve(projectDir, include) === path.resolve(filePath)
 *
 * Includes are neither project-dir-relative nor extension-bearing — the writer
 * emits `AxEnum\Name` (see projectFile.ts) against a file at
 * `<packages>\<pkg>\<model>\AxEnum\Name.xml`. The two can never be equal, so
 * every write reported "the .rnrproj does NOT reference this file". Twelve of
 * those in one run taught the agent to disregard the warning, and it then
 * disregarded the one that was true.
 *
 * Hence one implementation, comparing include-to-include, over every project of
 * the model, with a definite answer for "registered, but somewhere else".
 */

import * as fs from 'fs/promises';
import { Parser } from '../utils/xml.js';

export type MembershipStatus =
  /** Referenced by the project we are writing into. */
  | 'active'
  /** Referenced by another project of the same model — registered, not missing. */
  | 'other'
  /** Referenced by no project of this model. This one really does not compile. */
  | 'missing'
  /** No project could be read; say nothing rather than guess. */
  | 'unknown';

export interface Membership {
  status: MembershipStatus;
  /** Projects that reference the object, active one first. Paths, as found. */
  owners: string[];
}

/**
 * Object type → the AOT folder its `Content Include` starts with.
 *
 * One copy, because the writer and the membership check disagreeing is a bug
 * that looks exactly like a missing registration. ProjectFileManager builds the
 * Include from this; verify_d365fo_project and the inline check look it up with
 * the same function.
 */
const AX_FOLDER_BY_OBJECT_TYPE: Record<string, string> = {
  class: 'AxClass',
  'class-extension': 'AxClass',
  table: 'AxTable',
  enum: 'AxEnum',
  form: 'AxForm',
  query: 'AxQuery',
  view: 'AxView',
  'data-entity': 'AxDataEntityView',
  'table-extension': 'AxTableExtension',
  'form-extension': 'AxFormExtension',
  'data-entity-extension': 'AxDataEntityViewExtension',
  report: 'AxReport',
  'menu-item-display': 'AxMenuItemDisplay',
  'menu-item-action': 'AxMenuItemAction',
  'menu-item-output': 'AxMenuItemOutput',
  'menu-item-display-extension': 'AxMenuItemDisplayExtension',
  'menu-item-action-extension': 'AxMenuItemActionExtension',
  'menu-item-output-extension': 'AxMenuItemOutputExtension',
  edt: 'AxEdt',
  'edt-extension': 'AxEdtExtension',
  'enum-extension': 'AxEnumExtension',
  menu: 'AxMenu',
  'menu-extension': 'AxMenuExtension',
  'security-privilege': 'AxSecurityPrivilege',
  'security-duty': 'AxSecurityDuty',
  'security-role': 'AxSecurityRole',
  'security-duty-extension': 'AxSecurityDutyExtension',
  'security-role-extension': 'AxSecurityRoleExtension',
  'business-event': 'AxClass',
  tile: 'AxTile',
  kpi: 'AxKPI',
  map: 'AxMap',
  service: 'AxService',
  'service-group': 'AxServiceGroup',
  macro: 'AxMacroDictionary',
  'configuration-key': 'AxConfigurationKey',
  'security-policy': 'AxSecurityPolicy',
  'aggregate-measurement': 'AxAggregateMeasurement',
  'license-code': 'AxLicenseCode',
};

export function axFolderForObjectType(objectType: string): string {
  return AX_FOLDER_BY_OBJECT_TYPE[objectType] || 'AxClass';
}

/** AOT folder name (any case) → object type. Used to read objects back out of a project. */
export function objectTypeForAxFolder(axFolder: string): string | undefined {
  const needle = axFolder.toLowerCase();
  for (const [type, folder] of Object.entries(AX_FOLDER_BY_OBJECT_TYPE)) {
    // First wins, so 'class' is returned for AxClass rather than 'class-extension'.
    if (folder.toLowerCase() === needle) return type;
  }
  return undefined;
}

/**
 * The `Content Include` a given object has in a .rnrproj: AOT folder, backslash,
 * object name, no extension. Lowercased — VS is case-insensitive here and the
 * generators are not consistent about it ("…CtsoFinExtension" on disk against
 * "…CtsoFINExtension" in the XML, say), which is not a reason to report a miss.
 */
export function includeKey(axFolder: string, objectName: string): string {
  return `${axFolder}\\${objectName}`.toLowerCase();
}

/**
 * A project path as a human names it: leaf, no extension.
 *
 * Splits on both separators instead of path.basename, which on a POSIX host
 * treats the backslashes of a Windows project path as ordinary characters and
 * hands the whole path back — so "registered in <project>" would print an
 * absolute path where a name belongs.
 */
export function projectDisplayName(projectPath: string): string {
  const leaf = projectPath.split(/[\\/]/).pop() ?? projectPath;
  return leaf.replace(/\.rnrproj$/i, '');
}

/** Parsed includes per project file, invalidated by mtime. */
const includeCache = new Map<string, { mtimeMs: number; includes: Set<string> }>();

/**
 * Every `Content Include` in a .rnrproj, lowercased. Throws only if the file
 * cannot be read or parsed; callers treat that as `unknown`, never as `missing`.
 */
export async function readProjectIncludes(projectPath: string): Promise<Set<string>> {
  const stat = await fs.stat(projectPath);
  const cached = includeCache.get(projectPath);
  if (cached && cached.mtimeMs === stat.mtimeMs) return cached.includes;

  const xml = await fs.readFile(projectPath, 'utf-8');
  const parsed = await new Parser({ explicitArray: true }).parseStringPromise(xml);

  const includes = new Set<string>();
  for (const group of (parsed?.Project?.ItemGroup ?? []) as any[]) {
    const contents: any[] = Array.isArray(group?.Content) ? group.Content : [];
    for (const c of contents) {
      const inc: string | undefined = c?.$?.Include;
      // Includes are written without .xml, but tolerate one: a hand-edited
      // project should not read as a miss.
      if (inc) includes.add(inc.replace(/\.xml$/i, '').toLowerCase());
    }
  }

  includeCache.set(projectPath, { mtimeMs: stat.mtimeMs, includes });
  return includes;
}

/**
 * Which projects of this model reference the object.
 *
 * `activeProjectPath` is checked first and reported first; `siblingProjectPaths`
 * are the other .rnrproj of the SAME model — pass them and a file registered in
 * its owning project stops looking missing. Pass none and this degrades to the
 * old active-project-only answer, which is still correct, just less useful.
 */
export async function resolveMembership(
  axFolder: string,
  objectName: string,
  activeProjectPath: string | undefined,
  siblingProjectPaths: readonly string[] = [],
): Promise<Membership> {
  const key = includeKey(axFolder, objectName);

  const ordered = [
    ...(activeProjectPath ? [activeProjectPath] : []),
    ...siblingProjectPaths.filter(p => p && p !== activeProjectPath),
  ];
  if (ordered.length === 0) return { status: 'unknown', owners: [] };

  const owners: string[] = [];
  let readAny = false;
  for (const projectPath of ordered) {
    let includes: Set<string>;
    try {
      includes = await readProjectIncludes(projectPath);
    } catch {
      continue; // unreadable sibling is not evidence of anything
    }
    readAny = true;
    if (includes.has(key)) owners.push(projectPath);
  }

  if (!readAny) return { status: 'unknown', owners: [] };
  if (activeProjectPath && owners[0] === activeProjectPath) return { status: 'active', owners };
  if (owners.length > 0) return { status: 'other', owners };
  return { status: 'missing', owners: [] };
}

/**
 * The one line a write response spends on project membership, or '' when there
 * is nothing worth saying. Silence is the common case: the file is registered
 * where it should be and the caller does not need to be told so again.
 */
export function renderMembership(m: Membership, axFolder: string, objectName: string): string {
  switch (m.status) {
    case 'active':
    case 'unknown':
      return '';
    case 'other': {
      const where = m.owners.map(projectDisplayName).join(', ');
      return `\nℹ️ Registered in ${where}, not in the active project — that is where this object belongs; do not add it again here.`;
    }
    case 'missing':
      return `\n⚠️ No .rnrproj of this model references \`${axFolder}\\${objectName}\` — it will not compile until one does.`;
  }
}
