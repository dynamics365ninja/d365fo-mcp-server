/**
 * Shared D365FO Project Utilities
 * Extracted from generateSmartTable.ts and generateSmartForm.ts
 * to avoid code duplication.
 */

import * as fs from 'fs';
import * as path from 'path';

/**
 * Extract model name from .rnrproj file.
 * Returns null if the file cannot be read (e.g. Windows path on Linux) or
 * if <ModelName> is not found — callers must handle null gracefully.
 */
export function extractModelFromProject(projectPath: string): string | null {
  // Windows paths (K:\...) are not accessible on non-Windows — skip silently
  if (process.platform !== 'win32' && /^[A-Z]:\\/i.test(projectPath)) {
    console.warn(`[projectUtils] Skipping .rnrproj read on non-Windows: ${projectPath}`);
    return null;
  }
  try {
    const content = fs.readFileSync(projectPath, 'utf-8');
    const match = content.match(/<ModelName>(.*?)<\/ModelName>/);
    if (match && match[1]) {
      return match[1];
    }
  } catch (error) {
    console.error(`Failed to extract model from ${projectPath}:`, error);
  }
  return null;
}

/**
 * Find .rnrproj file in solution directory
 */
export function findProjectInSolution(solutionPath: string): string | null {
  // Windows paths (K:\...) are not accessible on non-Windows — skip silently
  if (process.platform !== 'win32' && /^[A-Z]:\\/i.test(solutionPath)) {
    console.warn(`[projectUtils] Skipping solution scan on non-Windows: ${solutionPath}`);
    return null;
  }
  try {
    const files = fs.readdirSync(solutionPath, { recursive: true }) as string[];
    const projectFile = files.find(f => f.endsWith('.rnrproj'));
    return projectFile ? path.join(solutionPath, projectFile) : null;
  } catch (error) {
    console.error(`Failed to find project in ${solutionPath}:`, error);
    return null;
  }
}
