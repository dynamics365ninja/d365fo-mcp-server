/**
 * Workspace Detector
 * Automatically detects D365FO project paths from GitHub Copilot workspace
 */

import * as fs from 'fs/promises';
import * as path from 'path';

export interface D365ProjectInfo {
  /** Path to the .rnrproj file. May be undefined when model was detected from PackagesLocalDirectory path. */
  projectPath?: string;
  modelName: string;
  /** Path to the VS solution folder. May be undefined when model was detected from PackagesLocalDirectory path. */
  solutionPath?: string;
  /** Base PackagesLocalDirectory path, if known */
  packagePath?: string;
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
      const skipDirs = ['node_modules', 'bin', 'obj', '.git', '.vs', 'PackagesLocalDirectory'];
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
async function extractModelNameFromProject(projectPath: string): Promise<string | null> {
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
export async function detectD365Project(workspacePath: string): Promise<D365ProjectInfo | null> {
  try {
    console.error(`[WorkspaceDetector] Searching for .rnrproj files in: ${workspacePath}`);

    // Find all .rnrproj files in workspace
    const projectFiles = await findProjectFiles(workspacePath);

    if (projectFiles.length === 0) {
      console.error('[WorkspaceDetector] No .rnrproj files found in workspace');
      return null;
    }

    console.error(`[WorkspaceDetector] Found ${projectFiles.length} .rnrproj file(s):`);
    projectFiles.forEach(p => console.error(`   - ${p}`));

    // Use the first project found (most common case: single project in workspace)
    const primaryProject = projectFiles[0];
    const modelName = await extractModelNameFromProject(primaryProject);

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

    console.error('[WorkspaceDetector] ✅ Detected D365FO project:');
    console.error(`   Project: ${result.projectPath}`);
    console.error(`   Model: ${result.modelName}`);
    console.error(`   Solution: ${result.solutionPath}`);

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
 */
export async function autoDetectD365Project(
  explicitWorkspacePath?: string
): Promise<D365ProjectInfo | null> {
  // Priority 1: Explicit workspace path
  if (explicitWorkspacePath) {
    console.error(`[WorkspaceDetector] Using explicit workspace path: ${explicitWorkspacePath}`);
    const result = await detectD365Project(explicitWorkspacePath);
    if (result) return result;
  }

  // Priority 2: Current working directory
  const cwd = process.cwd();
  console.error(`[WorkspaceDetector] Trying current working directory: ${cwd}`);
  const cwdResult = await detectD365Project(cwd);
  if (cwdResult) return cwdResult;

  // Priority 3: Environment variable
  const envWorkspace = process.env.WORKSPACE_PATH;
  if (envWorkspace) {
    console.error(`[WorkspaceDetector] Trying WORKSPACE_PATH env var: ${envWorkspace}`);
    const envResult = await detectD365Project(envWorkspace);
    if (envResult) return envResult;
  }

  // Priority 4: Extract model name directly from a PackagesLocalDirectory path
  // e.g. K:\AOSService\PackagesLocalDirectory\AslEnhancedDataSharing → modelName: "AslEnhancedDataSharing"
  if (explicitWorkspacePath) {
    const normalized = path.normalize(explicitWorkspacePath);
    const match = normalized.match(/^(.+[\\]PackagesLocalDirectory)[\\]([^\\]+)\\?$/i);
    if (match) {
      const packagePath = match[1];
      const modelName = match[2];
      console.error(`[WorkspaceDetector] ✅ Extracted model name from PackagesLocalDirectory path: ${modelName}`);
      console.error(`[WorkspaceDetector]    Package path: ${packagePath}`);
      console.error(`[WorkspaceDetector]    Note: projectPath unknown — addToProject=true requires projectPath in .mcp.json`);
      return {
        modelName,
        packagePath,
        // projectPath and solutionPath intentionally omitted — not derivable from PackagesLocalDirectory path
      };
    }
  }

  console.error('[WorkspaceDetector] ⚠️ Could not auto-detect D365FO project from any source');
  return null;
}
