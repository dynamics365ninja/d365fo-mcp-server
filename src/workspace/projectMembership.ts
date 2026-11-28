/**
 * "Is this object registered in a Visual Studio project?" — asked model-wide.
 *
 * Two callers used to answer this independently and both got it wrong in a
 * different way.
 *
 * `verify_d365fo_project` compared the right thing (the raw `Content Include`)
 * but only ever looked at the ACTIVE project, so an object registered in a
 * sibling project of the same model reported `❌ Not in project` — a hard error
 * for something that compiles perfectly. It is a real distinction, just not a
 * fatal one: 'other' means registered somewhere, 'missing' means registered
 * nowhere, and only the second stops the build.
 *
 * (An element referenced by two projects of one model is fine. The model is the
 * build unit; it compiles once either way. Projects are editing views, and the
 * one you are working in has to contain the object you are changing.)
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
import { AOT_FOLDER_BY_OBJECT_TYPE, aotFolderFor } from '../metadata/aotFolders.js';

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
 * the same function. The map itself is metadata/aotFolders.ts, which the create
 * tool and the on-disk lookup use too.
 */
export function axFolderForObjectType(objectType: string): string {
  return aotFolderFor(objectType) || 'AxClass';
}

/**
 * Does this object type live in an Ax* folder at all?
 *
 * The 'AxClass' fallback above is a convenience for callers that need SOME
 * folder, and a trap for callers that need a TRUE one: `model-descriptor` is
 * absent from the map because a descriptor is the package's manifest, sitting
 * beside the model folder rather than in an AOT folder inside it. Asked for its
 * folder, the fallback answers 'AxClass', and a .rnrproj membership question
 * built on that reports a missing `AxClass\<Model>` — inventing both a location
 * and a defect, underneath a write that succeeded.
 *
 * Callers deciding WHETHER to ask a membership question gate on this; callers
 * that already know the type has a folder keep using axFolderForObjectType.
 */
export function hasAxFolder(objectType: string): boolean {
  return Object.hasOwn(AOT_FOLDER_BY_OBJECT_TYPE, objectType);
}

/** AOT folder name (any case) → object type. Used to read objects back out of a project. */
export function objectTypeForAxFolder(axFolder: string): string | undefined {
  const needle = axFolder.toLowerCase();
  for (const [type, folder] of Object.entries(AOT_FOLDER_BY_OBJECT_TYPE)) {
    // First wins, so 'class' is returned for AxClass rather than 'class-extension'.
    if (folder.toLowerCase() === needle) return type;
  }
  return undefined;
}

/**
 * An `Include` attribute reduced to the identity Visual Studio actually gives it.
 *
 * Two spellings, one item. VS matches includes case-insensitively and the
 * generators are not consistent ("…CtsoFinExtension" on disk against
 * "…CtsoFINExtension" in the XML), and the writer emits `AxEnum\Name` while a
 * hand-edited project may carry `AxEnum\Name.xml`. Every question this module and
 * ProjectFileManager ask about an include — does the project list it, is it
 * already there, remove it — has to be asked in this form, or two of them answer
 * differently about the same entry: one reports the object registered while the
 * other adds a duplicate or fails to remove it.
 *
 * THE definition. Anything comparing an Include goes through this or through a
 * key built by includeKey, never through `===` on the raw attribute.
 */
export function normalizeInclude(include: string): string {
  return include.replace(/\.xml$/i, '').toLowerCase();
}

/**
 * The `Content Include` a given object has in a .rnrproj: AOT folder, backslash,
 * object name, no extension — in normalizeInclude form, ready to compare.
 */
export function includeKey(axFolder: string, objectName: string): string {
  return normalizeInclude(`${axFolder}\\${objectName}`);
}

/**
 * The languages a set of includes lists for one label file: every
 * `AxLabelFile\<labelFileId>_<lang>` descriptor entry, as the `<lang>` part of
 * the include passed in. Includes in normalizeInclude form give lowercased
 * languages; raw includes give them as spelled. A language tag has no `_`, so
 * the descriptors of a label file `Foo_Bar` never count as languages of `Foo`.
 */
export function labelLanguagesInIncludes(includes: Iterable<string>, labelFileId: string): string[] {
  const prefix = normalizeInclude(`AxLabelFile\\${labelFileId}_`);
  const langs: string[] = [];
  for (const inc of includes) {
    if (!normalizeInclude(inc).startsWith(prefix)) continue;
    const lang = inc.replace(/\.xml$/i, '').slice(prefix.length);
    if (lang && !/[_\\/]/.test(lang)) langs.push(lang);
  }
  return langs;
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
      if (inc) includes.add(normalizeInclude(inc));
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
 * Which project a write registers an existing object in (`D365FO_PROJECT_MEMBERSHIP`).
 *
 * `active` (default): the active project gets a reference too, even when a sibling
 * already has one. `owner`: an object referenced by exactly ONE project of the model
 * stays there — for solutions split into many feature projects where every object has
 * one home and a second reference is noise in every pull request. New objects (no
 * project references them) and objects referenced by several projects behave as in
 * `active` mode either way.
 */
export function projectMembershipMode(): 'owner' | 'active' {
  return process.env.D365FO_PROJECT_MEMBERSHIP?.trim().toLowerCase() === 'owner' ? 'owner' : 'active';
}

/** True when owner mode applies: referenced by exactly one project, and it is not the active one. */
export function keepsInOwnerProject(m: Membership): boolean {
  return projectMembershipMode() === 'owner' && m.status === 'other' && m.owners.length === 1;
}

/**
 * The one line a write response spends on project membership, or '' when there
 * is nothing worth saying. Silence is the common case: the file is registered
 * where it should be and the caller does not need to be told so again.
 *
 * 'other' used to read "that is where this object belongs; do not add it again
 * here". That was the wrong rule: an element may be referenced by several
 * .rnrproj of one model, it still compiles once, and an object being changed in
 * the active project has to be IN the active project to be built or handed over
 * from it. So the line now names the gap instead of blessing it — and normally
 * never fires on a write at all, because registerFileInActiveProject has just
 * closed it. It survives for writes made with addToProject off.
 */
export function renderMembership(m: Membership, axFolder: string, objectName: string): string {
  switch (m.status) {
    case 'active':
    case 'unknown':
      return '';
    case 'other': {
      if (keepsInOwnerProject(m)) {
        return `\nℹ️ Left in ${projectDisplayName(m.owners[0])}, the one project that references it ` +
          `(D365FO_PROJECT_MEMBERSHIP=owner) — the active project was not changed.`;
      }
      const where = m.owners.map(projectDisplayName).join(', ');
      return `\nℹ️ Referenced by ${where} but NOT by the active project — it compiles, but the active ` +
        `project does not contain what you just changed. Re-send with addToProject=true to add it here too.`;
    }
    case 'missing':
      return `\n⚠️ No .rnrproj of this model references \`${axFolder}\\${objectName}\` — it still compiles (xppc builds the whole model folder), but no project shows it in Visual Studio. ` +
        `Re-send with addToProject=true to add it to the active project.`;
  }
}
