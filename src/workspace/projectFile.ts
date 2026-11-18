/**
 * Reading and writing the Visual Studio .rnrproj project file.
 *
 * ProjectFileFinder locates the project a model belongs to; ProjectFileManager
 * adds and removes the <Content Include> entries an AOT object needs to compile.
 *
 * Both lived in the CREATE tool, and six other modules imported them from there
 * — including the modify tool, which closed a direct createD365File <-> modify
 * cycle between the two largest files in the codebase. Neither class is about
 * creating an object; they are about the project file, which is workspace
 * state, so they live here.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { Parser } from '../utils/xml.js';
// The per-file mutex from the atomic-write work — same semantics as the private
// withProjectFileLock this used to carry, so the second copy is retired rather
// than moved along with the classes.
import { withFileLock } from '../utils/atomicFileWrite.js';
import { detectEol } from '../utils/eolUtils.js';
import {
  insertProjectItem, listProjectIncludes, removeProjectItems, type Eol, type ProjectItemSpec,
} from './rnrprojText.js';
import { recordCreatedProjectFolder, takeCreatedProjectFolder } from './createdArtifactLedger.js';
import {
  axFolderForObjectType, resolveMembership, projectDisplayName, includeKey, normalizeInclude,
  type Membership,
} from './projectMembership.js';
import { getConfigManager } from '../utils/configManager.js';
import { assertProjectPathAllowed } from '../utils/pathContainment.js';

/**
 * Register a file that is already on disk into the ACTIVE project, whenever the
 * active project is not already listing it.
 *
 * An object may legitimately be referenced by several .rnrproj of one model. A
 * project is an editing view over a model, not an ownership claim: the model is
 * the build unit, each element compiles once per model however many projects
 * name it, and teams routinely group one element into a feature project and a
 * maintenance project both. So "some other project has it" is not a reason to
 * leave it out of the one being worked in — you cannot build, check in, or hand
 * over a change through a project that does not contain the object it changed.
 *
 * Both halves of that are measured, not assumed (#882):
 *  • Compiler — xppc.exe takes `-modelmodule=<model>` and writes one assembly per
 *    module. There is no project-level input at all, so a .rnrproj cannot cause a
 *    second compilation. (X++ Compiler 7.0.7996.33.)
 *  • Visual Studio / ALM — surveyed a real 187-project ISV solution authored in VS
 *    over years: 280 of its 1899 AOT elements are listed in two or more projects of
 *    the SAME model, across 20 element types (92 AxClass, plus forms, tables,
 *    form/table extensions, security duties, EDTs…). Shared membership is routine
 *    practice in a shipping codebase, not an edge case, and that solution's own
 *    build projects list no elements whatsoever — they declare `<Model>` and let
 *    the build task compile the module, which is the packaging flow agreeing with
 *    the compiler.
 *
 * This used to stop at membership 'other' and report the sibling as the owner.
 * That inverted the rule: an object edited in the active project stayed absent
 * from it, and every later verify pass had to re-explain why the gap was fine.
 * The only case that still writes nothing is 'active' — it is already there.
 *
 * Shared by create and modify, which need it for the same reason: an object
 * that existed but was unregistered could never BECOME registered — create
 * bailed before its addToProject block, and modify's flag defaulted off against
 * a wire schema telling the caller to keep the default.
 *
 * Returns the line to append to the tool's response, or '' when there is
 * nothing worth saying. Never throws: the write it comments on has already
 * succeeded, and an unreadable project must not turn that into a failure.
 */
export async function registerFileInActiveProject(
  objectType: string,
  objectName: string,
  modelName: string | undefined,
  projectPath: string | undefined,
): Promise<string> {
  const axFolder = axFolderForObjectType(objectType);

  let membership: Membership;
  try {
    const siblings = (getConfigManager().getProjectsForModel?.(modelName) ?? [])
      .filter(p => p !== projectPath);
    membership = await resolveMembership(axFolder, objectName, projectPath, siblings);
  } catch {
    return '';
  }

  // Already in the project being written to — the quiet, common case.
  //
  // 'unknown' means no project could be read at all, usually because no
  // projectPath is configured. Saying so on every single write is noise about a
  // config gap the caller cannot fix mid-task, and it is the same silence
  // renderMembership keeps: the loud cases only mean something when the quiet
  // ones stay quiet.
  if (membership.status === 'active' || membership.status === 'unknown') return '';

  // Registered elsewhere but not here. Still add it — see the note above — and
  // name the sibling so the agent knows the entry it just made is a second
  // reference to one file rather than a rescue from oblivion.
  const alsoIn = membership.status === 'other'
    ? membership.owners.map(projectDisplayName).join(', ')
    : '';

  if (!projectPath) {
    // Nothing to add it TO. Only worth saying when no project has it at all:
    // it compiles either way (xppc builds the whole model folder), but a
    // sibling project already shows it in Visual Studio.
    if (alsoIn) return '';
    return `\n\n⚠️ No project of model "${modelName ?? '(unknown)'}" references \`${axFolder}\\${objectName}\`, ` +
      `and no active projectPath is configured to add it to. It still compiles (xppc builds the whole model folder), ` +
      `but no project shows it in Visual Studio.`;
  }
  try {
    const added = await new ProjectFileManager({ withinSolutionRoots: true }).addToProject(projectPath, objectType, objectName, '');
    if (!added) return '';
    const reload = `Right-click the project → Reload Project if VS is open.`;
    return alsoIn
      ? `\n\n✅ Added to the active project ${projectDisplayName(projectPath)} (also referenced by ${alsoIn} — ` +
        `an element may belong to several projects of a model; it still compiles once). ${reload}`
      : `\n\n✅ The file was on disk but in no project of this model — added it to ${projectDisplayName(projectPath)}. ` +
        reload;
  } catch (e: any) {
    return `\n\n⚠️ Could not add \`${axFolder}\\${objectName}\` to ` +
      `${projectDisplayName(projectPath)}: ${e?.message ?? e}`;
  }
}

/**
 * A `<Folder Include>` in the one comparable form: normalised like every other
 * include, and without its trailing backslash. Visual Studio writes `Classes\`,
 * but a hand-edited project may say `Classes`. Both are the same folder, and
 * comparing them as different strings added a second `Classes\` entry next to
 * the hand-written one.
 */
function folderKey(include: string): string {
  return normalizeInclude(include).replace(/\\+$/, '');
}

/** Whether the project already lists the folder `include`, however its backslash is written. */
function hasFolder(text: string, include: string): boolean {
  const wanted = folderKey(include);
  return listProjectIncludes(text, 'Folder').some(inc => folderKey(inc) === wanted);
}

/**
 * Project File Finder
 * Finds .rnrproj files in solution directory or specific paths
 */
export class ProjectFileFinder {
  /**
   * Find the .rnrproj of a model in a solution directory (up to 3 levels deep).
   *
   * `<Model>.rnrproj` wins wherever it sits. Otherwise a project whose file name
   * contains the model name is returned only when it is the ONLY one. This used to
   * return the first substring match in readdir order: in a solution whose projects
   * are named per feature (ContosoCoreBilling, ContosoCoreClaims, … for model
   * ContosoCore) every project matched, so every create, modify and label write
   * that fell back to this scan registered into the alphabetically first project.
   * That is the same arbitrary pick autoDetectProject stopped making when several
   * projects share a model (solutionsPathAmbiguity.test.ts), and null is the same
   * answer: the caller then leaves the project alone and says so.
   *
   * With no model name there is nothing to be ambiguous about, so the first
   * project found is still returned — callers use it to read the model name.
   */
  static async findProjectInSolution(
    solutionPath: string,
    modelName: string
  ): Promise<string | null> {
    const candidates: string[] = [];
    await ProjectFileFinder.collectRecursive(solutionPath, modelName, 0, 3, candidates);
    if (candidates.length === 0) return null;
    if (!modelName) return candidates[0];

    const exactName = `${modelName}.rnrproj`.toLowerCase();
    const exact = candidates.filter(p => path.basename(p).toLowerCase() === exactName);
    if (exact.length === 1) return exact[0];
    if (exact.length === 0 && candidates.length === 1) return candidates[0];

    console.error(
      `[ProjectFileFinder] ${exact.length || candidates.length} projects in ${solutionPath} match model ` +
      `"${modelName}" — not picking one. Set projectPath to the project to write to.`
    );
    return null;
  }

  /**
   * Why findProjectInSolution returned null, for the reply to the caller.
   *
   * "Could not find .rnrproj" was the only wording, and since several matching
   * projects also give null it read as a missing project when 45 were there.
   * Scans again, which costs one directory walk on a path that already failed.
   */
  static async describeNoProject(solutionPath: string, modelName: string): Promise<string> {
    const candidates: string[] = [];
    await ProjectFileFinder.collectRecursive(solutionPath, modelName, 0, 3, candidates);
    if (candidates.length > 1) {
      return `${candidates.length} projects in ${solutionPath} match model '${modelName}', so none was picked. ` +
        `Pass projectPath with the project to add it to.`;
    }
    return `No .rnrproj for model '${modelName}' in ${solutionPath}. Pass projectPath with the project to add it to.`;
  }

  private static async collectRecursive(
    dir: string,
    modelName: string,
    currentDepth: number,
    maxDepth: number,
    found: string[],
  ): Promise<void> {
    if (currentDepth > maxDepth) return;

    // Every candidate is needed now, not just the first, so the whole tree is
    // walked: entry types come with the listing instead of one stat per file.
    let entries: Array<{ name: string; isDirectory(): boolean; isSymbolicLink(): boolean }>;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.name.endsWith('.rnrproj') && entry.name.includes(modelName)) {
        found.push(path.join(dir, entry.name));
      }
    }

    for (const entry of entries) {
      // A Dirent does not follow links, where the fs.stat it replaced did: a project
      // folder linked into the solution (junction or symlink) is still walked. A link
      // to a file fails readdir, which returns quietly.
      if (entry.isDirectory() || entry.isSymbolicLink()) {
        await ProjectFileFinder.collectRecursive(path.join(dir, entry.name), modelName, currentDepth + 1, maxDepth, found);
      }
    }
  }
}

/**
 * Visual Studio Project (.rnrproj) Manipulator
 */
/**
 * Run a .rnrproj read or write, retrying while Visual Studio or another process
 * holds the file (EBUSY / EPERM / EACCES), with the same back-off as the inline
 * loops of the other project writers.
 */
async function retryWhileLocked<T>(op: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await op();
    } catch (err: any) {
      if ((err?.code === 'EBUSY' || err?.code === 'EPERM' || err?.code === 'EACCES') && attempt < 4) {
        await new Promise(r => setTimeout(r, 300 * (attempt + 1)));
        continue;
      }
      throw err;
    }
  }
}

export class ProjectFileManager {
  private parser: Parser;
  private readonly withinSolutionRoots: boolean;

  /**
   * withinSolutionRoots: refuse a project outside the configured solution roots
   * (assertProjectPathAllowed), the bound d365fo_file(action="project") applies.
   * Every tool that writes a .rnrproj on a caller's behalf turns it on: create's
   * addToProject used to write any .rnrproj it was handed while action="project"
   * refused the same file, so the guard held only for the caller who asked for it.
   */
  constructor(options: { withinSolutionRoots?: boolean } = {}) {
    this.withinSolutionRoots = options.withinSolutionRoots ?? false;
    this.parser = new Parser({
      explicitArray: false,
      mergeAttrs: false,
      trim: true,
    });
  }

  private async assertWithinRoots(projectPath: string): Promise<void> {
    if (!this.withinSolutionRoots) return;
    const contained = await assertProjectPathAllowed(projectPath);
    if (!contained.ok) throw new Error(contained.reason);
  }

  /**
   * Get friendly display folder name for project (used in Folder Include and Link)
   * e.g. class → Classes, enum → Base Enums
   */
  private getFolderName(objectType: string): string {
    const folderMap: Record<string, string> = {
      class: 'Classes',
      'class-extension': 'Classes',
      table: 'Tables',
      enum: 'Base Enums',
      form: 'Forms',
      query: 'Queries',
      view: 'Views',
      'data-entity': 'Data Entities',
      'table-extension': 'Table Extensions',
      'form-extension': 'Form Extensions',
      'data-entity-extension': 'Data Entity Extensions',
      report: 'Reports',
      // VS names these "<Kind> Menu Items", not "Menu Items <Kind>".
      'menu-item-display': 'Display Menu Items',
      'menu-item-action': 'Action Menu Items',
      'menu-item-output': 'Output Menu Items',
      'menu-item-display-extension': 'Display Menu Item Extensions',
      'menu-item-action-extension': 'Action Menu Item Extensions',
      'menu-item-output-extension': 'Output Menu Item Extensions',
      edt: 'Extended Data Types',
      'edt-extension': 'EDT Extensions',
      // "Base Enum Extensions" (matches the "Base Enums" base node), but
      // "EDT Extensions" — VS abbreviates only the EDT one.
      'enum-extension': 'Base Enum Extensions',
      menu: 'Menus',
      'menu-extension': 'Menu Extensions',
      'security-privilege': 'Security Privileges',
      'security-duty': 'Security Duties',
      'security-role': 'Security Roles',
      'security-duty-extension': 'Security Duty Extensions',
      'security-role-extension': 'Security Role Extensions',
      'business-event': 'Classes',
      tile: 'Tiles',
      kpi: 'KPIs',
      map: 'Maps',
      service: 'Services',
      'service-group': 'Service Groups',
      macro: 'Macros',
      'configuration-key': 'Configuration Keys',
      'security-policy': 'Security Policies',
      'aggregate-measurement': 'Aggregate Measurements',
      'license-code': 'License Codes',
      'ignore-diagnostic-list': 'Ignore Diagnostic Lists',
    };
    return folderMap[objectType] || 'Classes';
  }

  /**
   * Get AOT folder prefix for Content Include path (no .xml extension)
   * e.g. class → AxClass, enum → AxEnum, data-entity → AxDataEntityView
   */
  private getAxFolderPrefix(objectType: string): string {
    return axFolderForObjectType(objectType);
  }

  /**
   * Add file reference to Visual Studio project
   * D365FO projects use ABSOLUTE paths to XML files in PackagesLocalDirectory
   * Returns true if file was added, false if file already exists in project
   */
  async addToProject(
    projectPath: string,
    objectType: string,
    objectName: string,
    _absoluteXmlPath: string  // kept for API compatibility
  ): Promise<boolean> {
    await this.assertWithinRoots(projectPath);
    return withFileLock(projectPath, () => this._addToProjectLocked(projectPath, objectType, objectName));
  }

  /**
   * Read the project, apply `edit` to its text, and write the result back when
   * `edit` changed something.
   *
   * The edit sees the text without its BOM and gets the file's own line ending;
   * the BOM is put back on write. Everything `edit` does not touch is written back
   * byte for byte (see rnrprojText.ts for why the xml2js Builder is no longer
   * used here). xml2js still parses the file first, so a project it cannot read
   * is refused before anything is written, as it was.
   *
   * Visual Studio holds the .rnrproj open, so a locked read or write is retried.
   */
  private async editProjectText(
    projectPath: string,
    edit: (body: string, eol: Eol) => string | null,
  ): Promise<boolean> {
    const raw = await retryWhileLocked(() => fs.readFile(projectPath, 'utf-8'));
    const hadBom = raw.charCodeAt(0) === 0xFEFF;
    const body = hadBom ? raw.slice(1) : raw;
    const project = await this.parser.parseStringPromise(body);
    if (!project?.Project) throw new Error('Invalid .rnrproj file structure');

    const updated = edit(body, detectEol(body));
    if (updated === null || updated === body) return false;
    await retryWhileLocked(() => fs.writeFile(projectPath, hadBom ? '﻿' + updated : updated, 'utf-8'));
    return true;
  }

  private async _addToProjectLocked(
    projectPath: string,
    objectType: string,
    objectName: string
  ): Promise<boolean> {
    // Get folder names for project organization
    const displayFolderName = this.getFolderName(objectType);
    const axFolderPrefix = this.getAxFolderPrefix(objectType);

    // D365FO .rnrproj standard:
    //   Content Include = AxClass\ObjectName  (Ax prefix, NO .xml extension)
    //   Link            = Classes\ObjectName  (display name, NO .xml extension)
    const contentInclude = `${axFolderPrefix}\\${objectName}`;
    const linkPath = `${displayFolderName}\\${objectName}`;

    let folderAdded = false;
    const written = await this.editProjectText(projectPath, (body, eol) => {
      // Check if file already in project. Case-insensitively and `.xml`-tolerantly:
      // VS resolves `AxForm\Foo`, `axform\foo` and `AxForm\Foo.xml` to one item, so
      // an exact comparison here reads an existing entry as absent and writes a
      // second one for the same element — a duplicate MSBuild fails the build over.
      if (listProjectIncludes(body, 'Content').includes(normalizeInclude(contentInclude))) {
        console.error(`[ProjectFileManager] File ${objectName} is already in the project - skipping`);
        return null;
      }

      // Add folder if not exists (uses friendly display name, e.g. "Classes\")
      // A folder already there under another spelling must not be added again —
      // and must not be recorded as ours, or the ledger would let a later remove
      // prune an entry this session did not create.
      let text = body;
      const folderInclude = `${displayFolderName}\\`;
      if (!hasFolder(text, folderInclude)) {
        text = insertProjectItem(text, { type: 'Folder', include: folderInclude, metadata: [] }, eol);
        folderAdded = true;
      }

      return insertProjectItem(text, {
        type: 'Content',
        include: contentInclude,
        metadata: [['SubType', 'Content'], ['Name', objectName], ['Link', linkPath]],
      }, eol);
    });
    if (!written) return false;

    // Only an entry WE added may be pruned again on undo — see the ledger.
    if (folderAdded) recordCreatedProjectFolder(projectPath, displayFolderName);
    console.error(`[ProjectFileManager] Added ${contentInclude} to ${path.basename(projectPath)}`);
    return true; // File successfully added
  }

  /**
   * Reverse of {@link addToProject}: remove the <Content Include> entry that
   * addToProject wrote for `objectName`, and drop the <Folder Include> it added when
   * no other Content of the same AOT type remains. A folder entry that was already in
   * the project is left alone. Used by undo_last_modification to clean the .rnrproj
   * after deleting a file it created in a non-git sandbox.
   * Returns true when an entry was removed, false when nothing matched.
   */
  async removeFromProject(
    projectPath: string,
    objectType: string,
    objectName: string,
  ): Promise<boolean> {
    await this.assertWithinRoots(projectPath);
    return withFileLock(projectPath, () => this._removeFromProjectLocked(projectPath, objectType, objectName));
  }

  private async _removeFromProjectLocked(
    projectPath: string,
    objectType: string,
    objectName: string,
  ): Promise<boolean> {
    const displayFolderName = this.getFolderName(objectType);
    const axFolderPrefix = this.getAxFolderPrefix(objectType);
    // Compared through includeKey, NOT as a literal string. resolveMembership
    // decides which projects own the object with exactly that normalisation
    // (lowercased, `.xml` tolerated), so an exact-match removal here answers a
    // different question than the caller asked: the object reads as registered,
    // the removal silently matches nothing, and `delete` then reports "no
    // project referenced it" while unlinking the file — the dangling include it
    // exists to prevent. Case really does drift ("…CtsoFinExtension" on disk
    // against "…CtsoFINExtension" in the project XML); VS does not care, and
    // neither may we.
    const wantedKey = includeKey(axFolderPrefix, objectName);

    const written = await this.editProjectText(projectPath, (body) => {
      const content = removeProjectItems(body, 'Content', inc => inc === wantedKey);
      if (content.removed === 0) return null;

      // Drop the "<Type>\" folder entry only when THIS session added it and no
      // remaining Content of this AOT type references it. Both conditions matter:
      // the second protects folders still hosting siblings, the first protects
      // orphan entries that were in the project before we touched it.
      const weAddedFolder = takeCreatedProjectFolder(projectPath, displayFolderName);
      // Same normalisation as the removal above: a sibling spelled `axform\Other`
      // still occupies the folder, and pruning the folder entry out from under it
      // is the same silent breakage one level up.
      const stillUsesFolder = listProjectIncludes(content.text, 'Content')
        .some(inc => inc.startsWith(`${axFolderPrefix.toLowerCase()}\\`));
      if (!weAddedFolder || stillUsesFolder) return content.text;
      const wantedFolder = folderKey(displayFolderName);
      return removeProjectItems(content.text, 'Folder', inc => folderKey(inc) === wantedFolder).text;
    });
    if (written) console.error(`[ProjectFileManager] Removed '${objectName}' from project ${path.basename(projectPath)}`);
    return written;
  }

  /**
   * Remove the Content entry whose Include is exactly `include` (compared like every
   * other include, see normalizeInclude). For entries that are not `<AOT folder>\<name>`
   * — a label file's `AxLabelFile\<File>_<lang>` descriptor and its
   * `<File>.<lang>.label.txt` resource — which removeFromProject cannot address.
   * Folder entries are left alone. Returns true when an entry was removed.
   */
  async removeIncludeFromProject(projectPath: string, include: string): Promise<boolean> {
    await this.assertWithinRoots(projectPath);
    return withFileLock(projectPath, async () => {
      const wanted = normalizeInclude(include);
      const written = await this.editProjectText(projectPath, (body) => {
        const result = removeProjectItems(body, 'Content', inc => inc === wanted);
        return result.removed === 0 ? null : result.text;
      });
      if (written) console.error(`[ProjectFileManager] Removed '${include}' from project ${path.basename(projectPath)}`);
      return written;
    });
  }

  /**
   * Add label file entries to Visual Studio project.
   * Each language needs TWO entries:
   *   1. AxLabelFile descriptor:   Include="AxLabelFile\{id}_{lang}"  Link="Label Files\{id}_{lang}"
   *   2. LabelResources .label.txt: Include="{id}.{lang}.label.txt"  DependentUpon="AxLabelFile\{id}_{lang}"
   * Both are added inside a single file-lock + read/write cycle for efficiency.
   * Returns the list of descriptor names that were newly added.
   */
  async addLabelToProject(
    projectPath: string,
    labelFileId: string,
    languages: string[],
  ): Promise<string[]> {
    await this.assertWithinRoots(projectPath);
    return withFileLock(projectPath, () =>
      this._addLabelToProjectLocked(projectPath, labelFileId, languages));
  }

  private async _addLabelToProjectLocked(
    projectPath: string,
    labelFileId: string,
    languages: string[],
  ): Promise<string[]> {
    const added: string[] = [];
    const written = await this.editProjectText(projectPath, (body, eol) => {
      // Keyed like every other include comparison: a label file whose descriptor is
      // already listed as `AxLabelFile\Foo_EN-US` must not get a second entry under
      // `AxLabelFile\Foo_en-US`. Language tags are exactly where casing drifts.
      const existingIncludes = new Set<string>(listProjectIncludes(body, 'Content'));
      const entries: ProjectItemSpec[] = [];

      for (const lang of languages) {
        const descriptorName = `${labelFileId}_${lang}`;
        const descriptorInclude = `AxLabelFile\\${descriptorName}`;
        const resourceFileName = `${labelFileId}.${lang}.label.txt`;

        // 1. AxLabelFile descriptor entry
        if (!existingIncludes.has(normalizeInclude(descriptorInclude))) {
          entries.push({
            type: 'Content',
            include: descriptorInclude,
            metadata: [['SubType', 'Content'], ['Name', descriptorName], ['Link', `Label Files\\${descriptorName}`]],
          });
          existingIncludes.add(normalizeInclude(descriptorInclude));
          added.push(descriptorName);
        }

        // 2. LabelResources .label.txt entry with DependentUpon
        if (!existingIncludes.has(normalizeInclude(resourceFileName))) {
          entries.push({
            type: 'Content',
            include: resourceFileName,
            metadata: [['SubType', 'Content'], ['Name', resourceFileName], ['DependentUpon', descriptorInclude]],
          });
          existingIncludes.add(normalizeInclude(resourceFileName));
        }
      }

      if (entries.length === 0) {
        console.error(`[ProjectFileManager] All label entries already in project — skipping write`);
        return null;
      }

      // Ensure "Label Files\" folder entry
      let text = body;
      if (!hasFolder(text, 'Label Files\\')) {
        text = insertProjectItem(text, { type: 'Folder', include: 'Label Files\\', metadata: [] }, eol);
      }
      for (const entry of entries) text = insertProjectItem(text, entry, eol);
      return text;
    });

    if (written) {
      console.error(`[ProjectFileManager] Added ${added.length} label descriptor(s) + resource entries to project`);
    }
    return added;
  }

  /**
   * Extract ModelName from Visual Studio project file
   * Returns the actual model name from PropertyGroup/Model or PropertyGroup/ModelName
   */
  async extractModelName(projectPath: string): Promise<string | null> {
    try {
      console.error(
        `[ProjectFileManager] Extracting model name from: ${projectPath}`
      );

      // Read project file
      let projectXml = await fs.readFile(projectPath, 'utf-8');
      // Strip UTF-8 BOM if present
      if (projectXml.charCodeAt(0) === 0xFEFF) {
        projectXml = projectXml.slice(1);
      }
      const project = await this.parser.parseStringPromise(projectXml);

      // Look for PropertyGroup with Model or ModelName
      if (project.Project && project.Project.PropertyGroup) {
        const propertyGroups = Array.isArray(project.Project.PropertyGroup)
          ? project.Project.PropertyGroup
          : [project.Project.PropertyGroup];

        for (const group of propertyGroups) {
          // Try <Model> tag first (standard D365FO format)
          if (group.Model) {
            const modelName = group.Model;
            console.error(
              `[ProjectFileManager] Found Model in project: ${modelName}`
            );
            return modelName;
          }
          
          // Fallback to <ModelName> tag (alternative format)
          if (group.ModelName) {
            const modelName = group.ModelName;
            console.error(
              `[ProjectFileManager] Found ModelName in project: ${modelName}`
            );
            return modelName;
          }
        }
      }

      console.error(
        `[ProjectFileManager] No Model or ModelName found in project file`
      );
      return null;
    } catch (error) {
      console.error(
        `[ProjectFileManager] Error extracting model name:`,
        error
      );
      return null;
    }
  }
}
