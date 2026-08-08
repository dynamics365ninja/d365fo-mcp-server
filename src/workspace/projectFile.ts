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
import { Parser, Builder } from '../utils/xml.js';
// The per-file mutex from the atomic-write work — same semantics as the private
// withProjectFileLock this used to carry, so the second copy is retired rather
// than moved along with the classes.
import { withFileLock } from '../utils/atomicFileWrite.js';
import { recordCreatedProjectFolder, takeCreatedProjectFolder } from './createdArtifactLedger.js';
import {
  axFolderForObjectType, resolveMembership, projectDisplayName, type Membership,
} from './projectMembership.js';
import { getConfigManager } from '../utils/configManager.js';

/**
 * Register a file that is already on disk into the active project, but only
 * when no project of its model references it.
 *
 * The "only when" is the whole design. A D365FO model is split across many
 * .rnrproj and each object belongs to exactly one of them, so registering a
 * file its owning project already lists would put one element in two projects
 * and build it twice. This closes a genuine gap and declines to open a new one.
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
export async function registerFileIfOrphaned(
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

  // 'unknown' means no project could be read at all — usually no projectPath is
  // configured. Saying so on every single write is noise about a config gap the
  // caller cannot fix mid-task, and it is the same silence renderMembership
  // keeps: the loud cases only mean something when the quiet ones stay quiet.
  if (membership.status === 'active' || membership.status === 'unknown') return '';
  if (membership.status === 'other') {
    const where = membership.owners.map(projectDisplayName).join(', ');
    return `\n\n✅ Already registered in ${where} — that project owns it. Nothing to add here.`;
  }

  if (!projectPath) {
    return `\n\n⚠️ No project of model "${modelName ?? '(unknown)'}" references \`${axFolder}\\${objectName}\`, ` +
      `and no active projectPath is configured to add it to. It will not compile until some project does.`;
  }
  try {
    const added = await new ProjectFileManager().addToProject(projectPath, objectType, objectName, '');
    return added
      ? `\n\n✅ The file was on disk but in no project of this model — added it to ${projectDisplayName(projectPath)}. ` +
        `Right-click the project → Reload Project if VS is open.`
      : '';
  } catch (e: any) {
    return `\n\n⚠️ The file is in no project of this model and could not be added to ` +
      `${projectDisplayName(projectPath)}: ${e?.message ?? e}`;
  }
}

/**
 * Project File Finder
 * Finds .rnrproj files in solution directory or specific paths
 */
export class ProjectFileFinder {
  /**
   * Find .rnrproj file in solution directory
   * Recursively searches for .rnrproj files matching the model name (up to 3 levels deep)
   */
  static async findProjectInSolution(
    solutionPath: string,
    modelName: string
  ): Promise<string | null> {
    return ProjectFileFinder.findRecursive(solutionPath, modelName, 0, 3);
  }

  private static async findRecursive(
    dir: string,
    modelName: string,
    currentDepth: number,
    maxDepth: number
  ): Promise<string | null> {
    if (currentDepth > maxDepth) return null;

    try {
      await fs.access(dir);
    } catch {
      return null;
    }

    let files: string[];
    try {
      files = await fs.readdir(dir);
    } catch {
      return null;
    }

    // Check .rnrproj files at this level first
    const projectFiles = files.filter(file =>
      file.endsWith('.rnrproj') &&
      (file.includes(modelName) || file === `${modelName}.rnrproj`)
    );

    if (projectFiles.length > 0) {
      return path.join(dir, projectFiles[0]);
    }

    // Recurse into subdirectories
    for (const file of files) {
      const fullPath = path.join(dir, file);
      try {
        const stat = await fs.stat(fullPath);
        if (stat.isDirectory()) {
          const found = await ProjectFileFinder.findRecursive(fullPath, modelName, currentDepth + 1, maxDepth);
          if (found) return found;
        }
      } catch {
        continue;
      }
    }

    return null;
  }
}

/**
 * Visual Studio Project (.rnrproj) Manipulator
 */
export class ProjectFileManager {
  private parser: Parser;
  private builder: Builder;

  constructor() {
    this.parser = new Parser({
      explicitArray: false,
      mergeAttrs: false,
      trim: true,
    });
    this.builder = new Builder({
      xmldec: { version: '1.0', encoding: 'utf-8' },
      renderOpts: { pretty: true, indent: '  ' },
    });
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
    return withFileLock(projectPath, () => this._addToProjectLocked(projectPath, objectType, objectName));
  }

  private async _addToProjectLocked(
    projectPath: string,
    objectType: string,
    objectName: string
  ): Promise<boolean> {
    // Read project file (with retry for transient VS file locks)
    let projectXml = '';
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        projectXml = await fs.readFile(projectPath, 'utf-8');
        break;
      } catch (err: any) {
        if ((err.code === 'EBUSY' || err.code === 'EPERM' || err.code === 'EACCES') && attempt < 4) {
          await new Promise(r => setTimeout(r, 300 * (attempt + 1)));
          continue;
        }
        throw err;
      }
    }
    // Strip UTF-8 BOM if present (VS writes BOM; Node fs.readFile keeps it)
    let hadBom = false;
    if (projectXml.charCodeAt(0) === 0xFEFF) {
      projectXml = projectXml.slice(1);
      hadBom = true;
    }
    const project = await this.parser.parseStringPromise(projectXml);

    // Ensure project structure exists
    if (!project.Project) {
      throw new Error('Invalid .rnrproj file structure');
    }

    // Initialize ItemGroup if not exists — insert BEFORE Import elements
    // so MSBuild/VS sees items before targets (xml2js preserves JS key order)
    if (!project.Project.ItemGroup) {
      const { Import, ...rest } = project.Project;
      project.Project = { ...rest, ItemGroup: [{ Folder: [] }, { Content: [] }] };
      if (Import) {
        project.Project.Import = Import;
      }
    }

    // Convert to array if single ItemGroup
    if (!Array.isArray(project.Project.ItemGroup)) {
      project.Project.ItemGroup = [project.Project.ItemGroup];
    }

    // Find or create Folder ItemGroup
    let folderGroup = project.Project.ItemGroup.find(
      (group: any) => group.Folder !== undefined
    );
    if (!folderGroup) {
      folderGroup = { Folder: [] };
      project.Project.ItemGroup.push(folderGroup);
    }

    // Find or create Content ItemGroup
    let contentGroup = project.Project.ItemGroup.find(
      (group: any) => group.Content !== undefined
    );
    if (!contentGroup) {
      contentGroup = { Content: [] };
      project.Project.ItemGroup.push(contentGroup);
    }

    // Ensure arrays
    if (!Array.isArray(folderGroup.Folder)) {
      folderGroup.Folder = folderGroup.Folder ? [folderGroup.Folder] : [];
    }
    if (!Array.isArray(contentGroup.Content)) {
      contentGroup.Content = contentGroup.Content ? [contentGroup.Content] : [];
    }

    // Get folder names for project organization
    const displayFolderName = this.getFolderName(objectType);
    const axFolderPrefix = this.getAxFolderPrefix(objectType);

    // Add folder if not exists (uses friendly display name, e.g. "Classes\")
    const folderExists = folderGroup.Folder.some(
      (folder: any) =>
        folder.$ && folder.$.Include === `${displayFolderName}\\`
    );
    if (!folderExists) {
      folderGroup.Folder.push({
        $: { Include: `${displayFolderName}\\` },
      });
      // Only an entry WE added may be pruned again on undo — see the ledger.
      recordCreatedProjectFolder(projectPath, displayFolderName);
    }

    // D365FO .rnrproj standard:
    //   Content Include = AxClass\ObjectName  (Ax prefix, NO .xml extension)
    //   Link            = Classes\ObjectName  (display name, NO .xml extension)
    const contentInclude = `${axFolderPrefix}\\${objectName}`;
    const linkPath = `${displayFolderName}\\${objectName}`;

    // Check if file already in project
    const fileExists = contentGroup.Content.some(
      (content: any) =>
        content.$ && content.$.Include === contentInclude
    );

    if (fileExists) {
      console.error(
        `[ProjectFileManager] File ${objectName} is already in the project - skipping`
      );
      return false; // File already exists in project
    }

    // Add file reference
    contentGroup.Content.push({
      $: { Include: contentInclude },
      SubType: 'Content',
      Name: objectName,
      Link: linkPath,
    });

    console.error(
      `[ProjectFileManager] Added file reference to project, Content items: ${contentGroup.Content.length}`
    );

    // Write back to project file (with retry for transient VS file locks)
    const updatedXml = this.builder.buildObject(project);
    // Restore UTF-8 BOM if the original file had one (VS 2022 writes .rnrproj with BOM)
    const output = hadBom ? '\uFEFF' + updatedXml : updatedXml;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await fs.writeFile(projectPath, output, 'utf-8');
        break;
      } catch (err: any) {
        if ((err.code === 'EBUSY' || err.code === 'EPERM' || err.code === 'EACCES') && attempt < 4) {
          await new Promise(r => setTimeout(r, 300 * (attempt + 1)));
          continue;
        }
        throw err;
      }
    }

    console.error(`[ProjectFileManager] Project file saved successfully`);
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
    return withFileLock(projectPath, () => this._removeFromProjectLocked(projectPath, objectType, objectName));
  }

  private async _removeFromProjectLocked(
    projectPath: string,
    objectType: string,
    objectName: string,
  ): Promise<boolean> {
    let projectXml = '';
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        projectXml = await fs.readFile(projectPath, 'utf-8');
        break;
      } catch (err: any) {
        if ((err.code === 'EBUSY' || err.code === 'EPERM' || err.code === 'EACCES') && attempt < 4) {
          await new Promise(r => setTimeout(r, 300 * (attempt + 1)));
          continue;
        }
        throw err;
      }
    }
    let hadBom = false;
    if (projectXml.charCodeAt(0) === 0xFEFF) {
      projectXml = projectXml.slice(1);
      hadBom = true;
    }
    const project = await this.parser.parseStringPromise(projectXml);
    if (!project.Project || !project.Project.ItemGroup) return false;

    const itemGroups = Array.isArray(project.Project.ItemGroup)
      ? project.Project.ItemGroup
      : [project.Project.ItemGroup];

    const displayFolderName = this.getFolderName(objectType);
    const axFolderPrefix = this.getAxFolderPrefix(objectType);
    const contentInclude = `${axFolderPrefix}\\${objectName}`;

    let removed = false;
    for (const group of itemGroups) {
      if (group.Content === undefined) continue;
      const contents = Array.isArray(group.Content) ? group.Content : [group.Content];
      const kept = contents.filter((c: any) => c?.$?.Include !== contentInclude);
      if (kept.length !== contents.length) {
        removed = true;
        group.Content = kept;
      }
    }

    if (!removed) return false;

    // Drop the "<Type>\" folder entry only when THIS session added it and no
    // remaining Content of this AOT type references it. Both conditions matter:
    // the second protects folders still hosting siblings, the first protects
    // orphan entries that were in the project before we touched it.
    const weAddedFolder = takeCreatedProjectFolder(projectPath, displayFolderName);
    const stillUsesFolder = itemGroups.some((group: any) => {
      if (group.Content === undefined) return false;
      const contents = Array.isArray(group.Content) ? group.Content : [group.Content];
      return contents.some((c: any) => typeof c?.$?.Include === 'string' && c.$.Include.startsWith(`${axFolderPrefix}\\`));
    });
    if (weAddedFolder && !stillUsesFolder) {
      for (const group of itemGroups) {
        if (group.Folder === undefined) continue;
        const folders = Array.isArray(group.Folder) ? group.Folder : [group.Folder];
        group.Folder = folders.filter((f: any) => f?.$?.Include !== `${displayFolderName}\\`);
      }
    }

    const updatedXml = this.builder.buildObject(project);
    const output = hadBom ? '\uFEFF' + updatedXml : updatedXml;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await fs.writeFile(projectPath, output, 'utf-8');
        break;
      } catch (err: any) {
        if ((err.code === 'EBUSY' || err.code === 'EPERM' || err.code === 'EACCES') && attempt < 4) {
          await new Promise(r => setTimeout(r, 300 * (attempt + 1)));
          continue;
        }
        throw err;
      }
    }
    console.error(`[ProjectFileManager] Removed '${objectName}' from project ${path.basename(projectPath)}`);
    return true;
  }

  /**
   * Add label file entries to Visual Studio project.
   * Each language needs TWO entries:
   *   1. AxLabelFile descriptor:   Include="AxLabelFile\{id}_{lang}"  Link="Label Files\{id}_{lang}"
   *   2. LabelResources .label.txt: Include="{id}.{lang}.label.txt"  DependentUpon="AxLabelFile\{id}_{lang}"
   * Both are added inside a single file-lock + parse/write cycle for efficiency.
   * Returns the list of descriptor names that were newly added.
   */
  async addLabelToProject(
    projectPath: string,
    labelFileId: string,
    languages: string[],
  ): Promise<string[]> {
    return withFileLock(projectPath, () =>
      this._addLabelToProjectLocked(projectPath, labelFileId, languages));
  }

  private async _addLabelToProjectLocked(
    projectPath: string,
    labelFileId: string,
    languages: string[],
  ): Promise<string[]> {
    // Read project file (with retry for transient VS file locks)
    let projectXml = '';
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        projectXml = await fs.readFile(projectPath, 'utf-8');
        break;
      } catch (err: any) {
        if ((err.code === 'EBUSY' || err.code === 'EPERM' || err.code === 'EACCES') && attempt < 4) {
          await new Promise(r => setTimeout(r, 300 * (attempt + 1)));
          continue;
        }
        throw err;
      }
    }
    let hadBom = false;
    if (projectXml.charCodeAt(0) === 0xFEFF) {
      projectXml = projectXml.slice(1);
      hadBom = true;
    }
    const project = await this.parser.parseStringPromise(projectXml);
    if (!project.Project) throw new Error('Invalid .rnrproj file structure');

    // Ensure ItemGroup structure
    if (!project.Project.ItemGroup) {
      const { Import, ...rest } = project.Project;
      project.Project = { ...rest, ItemGroup: [{ Folder: [] }, { Content: [] }] };
      if (Import) project.Project.Import = Import;
    }
    if (!Array.isArray(project.Project.ItemGroup)) {
      project.Project.ItemGroup = [project.Project.ItemGroup];
    }

    let folderGroup = project.Project.ItemGroup.find((g: any) => g.Folder !== undefined);
    if (!folderGroup) { folderGroup = { Folder: [] }; project.Project.ItemGroup.push(folderGroup); }

    let contentGroup = project.Project.ItemGroup.find((g: any) => g.Content !== undefined);
    if (!contentGroup) { contentGroup = { Content: [] }; project.Project.ItemGroup.push(contentGroup); }

    if (!Array.isArray(folderGroup.Folder)) folderGroup.Folder = folderGroup.Folder ? [folderGroup.Folder] : [];
    if (!Array.isArray(contentGroup.Content)) contentGroup.Content = contentGroup.Content ? [contentGroup.Content] : [];

    // Ensure "Label Files\" folder entry
    const folderExists = folderGroup.Folder.some(
      (f: any) => f.$ && f.$.Include === 'Label Files\\'
    );
    if (!folderExists) {
      folderGroup.Folder.push({ $: { Include: 'Label Files\\' } });
    }

    const added: string[] = [];
    let newEntries = 0;
    const existingIncludes = new Set(
      contentGroup.Content.map((c: any) => c.$?.Include).filter(Boolean)
    );

    for (const lang of languages) {
      const descriptorName = `${labelFileId}_${lang}`;
      const descriptorInclude = `AxLabelFile\\${descriptorName}`;
      const resourceFileName = `${labelFileId}.${lang}.label.txt`;

      // 1. AxLabelFile descriptor entry
      if (!existingIncludes.has(descriptorInclude)) {
        contentGroup.Content.push({
          $: { Include: descriptorInclude },
          SubType: 'Content',
          Name: descriptorName,
          Link: `Label Files\\${descriptorName}`,
        });
        existingIncludes.add(descriptorInclude);
        added.push(descriptorName);
        newEntries++;
      }

      // 2. LabelResources .label.txt entry with DependentUpon
      if (!existingIncludes.has(resourceFileName)) {
        contentGroup.Content.push({
          $: { Include: resourceFileName },
          SubType: 'Content',
          Name: resourceFileName,
          DependentUpon: descriptorInclude,
        });
        existingIncludes.add(resourceFileName);
        newEntries++;
      }
    }

    if (newEntries === 0) {
      console.error(`[ProjectFileManager] All label entries already in project — skipping write`);
      return added;
    }

    // Write back
    const updatedXml = this.builder.buildObject(project);
    const output = hadBom ? '\uFEFF' + updatedXml : updatedXml;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await fs.writeFile(projectPath, output, 'utf-8');
        break;
      } catch (err: any) {
        if ((err.code === 'EBUSY' || err.code === 'EPERM' || err.code === 'EACCES') && attempt < 4) {
          await new Promise(r => setTimeout(r, 300 * (attempt + 1)));
          continue;
        }
        throw err;
      }
    }

    console.error(`[ProjectFileManager] Added ${added.length} label descriptor(s) + resource entries to project`);
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
