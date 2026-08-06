/**
 * Workspace Detector
 * Automatically detects D365FO project paths from GitHub Copilot workspace
 */

import * as fs from 'fs/promises';
import { existsSync } from 'fs';
import * as path from 'path';
import { debugLog } from './logger.js';

export interface D365ProjectInfo {
  /** Path to the .rnrproj file. May be undefined when model was detected from PackagesLocalDirectory path. */
  projectPath?: string;
  modelName: string;
  /** Path to the VS solution folder. May be undefined when model was detected from PackagesLocalDirectory path. */
  solutionPath?: string;
  /** Base PackagesLocalDirectory path, if known */
  packagePath?: string;
  packageName?: string;     // Package containing this model (may differ from model name in UDE)
}

/**
 * Microsoft tutorial / demo model names that ship with D365FO.
 * A new VS project's <Model> tag defaults to "FleetManagement" when the developer
 * forgets to change it in the project wizard. These model names must never be
 * auto-selected as the target custom model for create/modify operations.
 */
const MICROSOFT_DEMO_MODELS = new Set([
  'fleetmanagement',
  'fleetmanagementextension',
  'fleetmanagementunittests',
  'tutorial',
]);

/**
 * Returns true when the model name is a well-known Microsoft tutorial/demo model
 * that should never be auto-selected as a custom project target.
 */
export function isMicrosoftDemoModel(modelName: string): boolean {
  return MICROSOFT_DEMO_MODELS.has(modelName.toLowerCase());
}

/**
 * Find all .rnrproj files in a directory (recursive search)
 * Limited to reasonable depth to avoid performance issues
 */
async function findProjectFiles(
  dir: string,
  maxDepth: number = 5,
  currentDepth: number = 0
): Promise<string[]> {
  if (currentDepth >= maxDepth) {
    return [];
  }

  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const projectFiles: string[] = [];

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      // Skip common directories that won't contain .rnrproj
      const skipDirs = [
        'node_modules', 'bin', 'obj', '.git', '.vs', 'PackagesLocalDirectory',
        // AOT artifact folders inside model directories — skip to avoid crawling thousands of XML files
        'AxClass', 'AxTable', 'AxForm', 'AxEnum', 'AxQuery', 'AxView',
        'AxDataEntityView', 'AxTableExtension', 'AxFormExtension',
        'AxMenuItemAction', 'AxMenuItemDisplay', 'AxMenuItemOutput',
        'AxMenu', 'AxSecurityRole', 'AxSecurityDuty', 'AxSecurityPrivilege',
        'AxLabel', 'AxResource', 'AxReport',
        'AxEdt', 'AxExtendedDataType',
      ];
      if (entry.isDirectory() && skipDirs.includes(entry.name)) {
        continue;
      }

      if (entry.isFile() && entry.name.endsWith('.rnrproj')) {
        projectFiles.push(fullPath);
      } else if (entry.isDirectory()) {
        const subProjects = await findProjectFiles(fullPath, maxDepth, currentDepth + 1);
        projectFiles.push(...subProjects);
      }
    }

    return projectFiles;
  } catch (error) {
    // Directory not accessible or doesn't exist
    return [];
  }
}

/**
 * Extract ModelName from .rnrproj file
 * Tries <Model> tag first (standard), then falls back to <ModelName>
 */
export async function extractModelNameFromProject(projectPath: string): Promise<string | null> {
  try {
    const content = await fs.readFile(projectPath, 'utf-8');
    
    // Try <Model> tag first (standard D365FO project format)
    const modelMatch = content.match(/<Model>(.*?)<\/Model>/);
    if (modelMatch && modelMatch[1]) {
      return modelMatch[1];
    }
    
    // Fallback to <ModelName> tag (alternative format)
    const modelNameMatch = content.match(/<ModelName>(.*?)<\/ModelName>/);
    return modelNameMatch ? modelNameMatch[1] : null;
  } catch {
    return null;
  }
}

/**
 * Detect D365FO project information from workspace path
 * This is automatically called when GitHub Copilot provides workspace context
 */
export async function detectD365Project(workspacePath: string, maxDepth: number = 5): Promise<D365ProjectInfo | null> {
  try {
    debugLog(`[WorkspaceDetector] Searching for .rnrproj files in: ${workspacePath}`);

    // Find all .rnrproj files in workspace
    const projectFiles = await findProjectFiles(workspacePath, maxDepth);

    if (projectFiles.length === 0) {
      debugLog('[WorkspaceDetector] No .rnrproj files found in workspace');
      return null;
    }

    debugLog(`[WorkspaceDetector] Found ${projectFiles.length} .rnrproj file(s):`);
    projectFiles.forEach(p => debugLog(`   - ${p}`));

    // Prefer the .rnrproj whose own folder name matches the workspace base name
    // (D365FO multi-project solution convention). With exactly one candidate,
    // use it. With multiple candidates and no unambiguous match, refuse to
    // guess — silently picking projectFiles[0] previously caused new files to
    // be registered into an arbitrary, unrelated "first found" project.
    let primaryProject: string;
    if (projectFiles.length === 1) {
      primaryProject = projectFiles[0];
    } else {
      const wpBase = path.basename(workspacePath).toLowerCase();
      const nameMatch = projectFiles.find(
        p => path.basename(path.dirname(p)).toLowerCase() === wpBase,
      );
      if (nameMatch) {
        primaryProject = nameMatch;
        debugLog(`[WorkspaceDetector] Solution-name match → ${path.basename(nameMatch)}`);
      } else {
        console.error(
          `[WorkspaceDetector] ⚠️ Ambiguous: ${projectFiles.length} .rnrproj files found and none match ` +
          `the workspace name — refusing to auto-select one. Candidates:\n` +
          projectFiles.map(p => `   - ${p}`).join('\n') +
          `\nCaller must pass projectPath explicitly.`
        );
        return null;
      }
    }

    // Prefer a non-demo model when the initially selected primaryProject has a
    // Microsoft demo model name (e.g. FleetManagement).
    const modelName = await extractModelNameFromProject(primaryProject);
    if (modelName && isMicrosoftDemoModel(modelName) && projectFiles.length > 1) {
      debugLog(`[WorkspaceDetector] Primary .rnrproj has MS demo model "${modelName}" — looking for better candidate`);
      for (const pf of projectFiles) {
        if (pf === primaryProject) continue;
        const altModel = await extractModelNameFromProject(pf);
        if (altModel && !isMicrosoftDemoModel(altModel)) {
          debugLog(`[WorkspaceDetector] Skipping demo model "${modelName}", using "${altModel}" from ${path.basename(pf)}`);
          primaryProject = pf;
          break;
        }
      }
    }

    if (!modelName) {
      console.error('[WorkspaceDetector] Could not extract ModelName from .rnrproj');
      return null;
    }

    // Extract solution path (parent directory of .rnrproj)
    const solutionPath = path.dirname(path.dirname(primaryProject));

    const result: D365ProjectInfo = {
      projectPath: primaryProject,
      modelName,
      solutionPath,
    };

    debugLog('[WorkspaceDetector] ✅ Detected D365FO project:');
    debugLog(`   Project: ${result.projectPath}`);
    debugLog(`   Model: ${result.modelName}`);
    debugLog(`   Solution: ${result.solutionPath}`);

    return result;
  } catch (error) {
    console.error('[WorkspaceDetector] Error detecting project:', error);
    return null;
  }
}

/**
 * Auto-detect project from multiple possible workspace sources:
 * 1. Explicitly provided workspacePath parameter
 * 2. Current working directory (process.cwd())
 * 3. Environment variable WORKSPACE_PATH
 * 4. Well-known VS project directories (%USERPROFILE%\Documents\VS 2022\Projects, K:\VSProjects, K:\Projects, K:\repos, C:\VSProjects, C:\Projects)
 * 5. PackagesLocalDirectory path regex extraction (last resort, no .rnrproj)
 */
export async function autoDetectD365Project(
  explicitWorkspacePath?: string
): Promise<D365ProjectInfo | null> {
  // Priority 1: Explicit workspace path
  if (explicitWorkspacePath) {
    debugLog(`[WorkspaceDetector] Using explicit workspace path: ${explicitWorkspacePath}`);
    const result = await detectD365Project(explicitWorkspacePath);
    if (result) return result;
  }

  // Priority 2: Current working directory (skip if it's a Node.js project —
  // VS 2022 starts the stdio subprocess from the server's own directory).
  const cwd = process.cwd();
  const cwdIsNodeProject = existsSync(path.join(cwd, 'package.json'));
  if (cwdIsNodeProject) {
    debugLog(`[WorkspaceDetector] Skipping cwd (Node.js project): ${cwd}`);
  } else {
    debugLog(`[WorkspaceDetector] Trying current working directory: ${cwd}`);
    const cwdResult = await detectD365Project(cwd);
    if (cwdResult) return cwdResult;
  }

  // Priority 3: Explicit env vars
  const envWorkspace = process.env.WORKSPACE_PATH;
  if (envWorkspace) {
    debugLog(`[WorkspaceDetector] Trying WORKSPACE_PATH env var: ${envWorkspace}`);
    const envResult = await detectD365Project(envWorkspace);
    if (envResult) return envResult;
  }

  // Priority 3b: D365FO_SOLUTIONS_PATH — scan root for ALL D365FO projects, use
  // first as primary (recommended for multi-solution setups; full list is
  // available via scanAllD365Projects()).
  const solutionsRoot = process.env.D365FO_SOLUTIONS_PATH;
  if (solutionsRoot) {
    debugLog(`[WorkspaceDetector] Scanning D365FO_SOLUTIONS_PATH: ${solutionsRoot}`);
    const result = await detectD365Project(solutionsRoot, 6);
    if (result) return result;
  }

  // Priority 4: Well-known VS project directories (Windows only).
  // %USERPROFILE%\source\repos is intentionally excluded — it often contains the
  // MCP server repo itself alongside D365FO projects, making the first-found
  // result unpredictable; use D365FO_SOLUTIONS_PATH instead.
  if (process.platform === 'win32') {
    const userProfile = process.env.USERPROFILE || (process.env.USERNAME ? `C:\\Users\\${process.env.USERNAME}` : undefined);
    const wellKnownPaths = [
      userProfile ? `${userProfile}\\Documents\\Visual Studio 2022\\Projects` : undefined,
      // K: is the data drive in most LCS-provisioned VMs
      `K:\\VSProjects`,
      `K:\\Projects`,
      `K:\\repos`,
      `C:\\VSProjects`,
      `C:\\Projects`,
    ].filter((p): p is string => !!p);
    const sanitizePathForLog = (p: string): string => {
      if (userProfile && p.startsWith(userProfile)) {
        return p.replace(userProfile, '<UserProfile>');
      }
      return p;
    };
    for (const searchRoot of wellKnownPaths) {
      try {
        const files = await findProjectFiles(searchRoot);
        if (files.length > 0) {
          const loggedSearchRoot = sanitizePathForLog(searchRoot);
          debugLog(`[WorkspaceDetector] Found ${files.length} .rnrproj file(s) in ${loggedSearchRoot}`);
          const projectPath = files[0]; // take first (most likely the user's project)
          const modelName = await extractModelNameFromProject(projectPath);
          if (modelName) {
            const solutionPath = path.dirname(path.dirname(projectPath));
            const packagePath = explicitWorkspacePath
              ? path.normalize(explicitWorkspacePath).match(/^(.+[\\\/]PackagesLocalDirectory)(?:[\\\/]|$)/i)?.[1] || null
              : null;
            debugLog(`[WorkspaceDetector] ✅ Found project via well-known path: ${projectPath}`);
            debugLog(`[WorkspaceDetector]    ModelName: ${modelName}`);
            return {
              modelName,
              projectPath,
              solutionPath,
              packagePath: packagePath || undefined,
            };
          }
        }
      } catch {
        // directory doesn't exist or not accessible — skip silently
      }
    }
  }

  // Priority 5: Extract model name directly from a PackagesLocalDirectory path,
  // e.g. K:\AOSService\PackagesLocalDirectory\MyEnhancedDataSharing → "MyEnhancedDataSharing"
  if (explicitWorkspacePath) {
    const normalized = path.normalize(explicitWorkspacePath);

    // K:\...\PackagesLocalDirectory\PackageName\ModelName
    const twoLevelMatch = normalized.match(
      /^(.+[\\\/]PackagesLocalDirectory)[\\\/]([^\\\/]+)[\\\/]([^\\\/]+)\\?\/?$/i
    );
    if (twoLevelMatch) {
      const packagePath = twoLevelMatch[1];
      const packageName = twoLevelMatch[2];
      const modelName = twoLevelMatch[3];
      return {
        modelName,
        packageName,
        packagePath,
      };
    }

    const match = normalized.match(/^(.+[\\]PackagesLocalDirectory)[\\]([^\\]+)\\?$/i);
    if (match) {
      const packagePath = match[1];
      const modelName = match[2];
      debugLog(`[WorkspaceDetector] ✅ Extracted model name from PackagesLocalDirectory path: ${modelName}`);
      debugLog(`[WorkspaceDetector]    Package path: ${packagePath}`);
      debugLog(`[WorkspaceDetector]    Note: projectPath unknown — addToProject=true requires projectPath in .mcp.json`);
      // projectPath and solutionPath omitted — not derivable from this path form
      return {
        modelName,
        packagePath,
      };
    }
  }

  console.error('[WorkspaceDetector] ⚠️ Could not auto-detect D365FO project from any source');
  return null;
}

/**
 * Get the currently checked-out git branch name for a directory.
 * Returns null if the directory is not a git repository, git is unavailable,
 * or HEAD is detached (detached HEAD is unhelpful for project matching).
 */
export async function detectGitBranch(workspaceRoot: string): Promise<string | null> {
  try {
    const { execFile } = await import('child_process');
    const { promisify } = await import('util');
    const execFileAsync = promisify(execFile);
    const { stdout } = await execFileAsync(
      'git',
      ['-C', workspaceRoot, 'rev-parse', '--abbrev-ref', 'HEAD'],
      { timeout: 5000, windowsHide: true, encoding: 'utf8' } as any
    );
    const branch = (stdout as unknown as string).trim();
    // 'HEAD' means detached HEAD — not useful for project matching
    return branch && branch !== 'HEAD' ? branch : null;
  } catch {
    return null;
  }
}

/**
 * Scan a root directory for ALL D365FO projects (.rnrproj files).
 * Used when D365FO_SOLUTIONS_PATH is configured — lists every project available
 * so the user can pick the active one via get_workspace_info(projectPath).
 */
export async function scanAllD365Projects(rootPath: string): Promise<D365ProjectInfo[]> {
  try {
    const projectFiles = await findProjectFiles(rootPath, 6);
    const results: D365ProjectInfo[] = [];
    for (const pf of projectFiles) {
      const modelName = await extractModelNameFromProject(pf);
      if (modelName) {
        results.push({
          projectPath: pf,
          modelName,
          solutionPath: path.dirname(path.dirname(pf)),
        });
      }
    }
    return results;
  } catch {
    return [];
  }
}
