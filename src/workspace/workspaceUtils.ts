/**
 * Workspace utilities
 * Path validation and security helpers
 */

import * as fs from 'fs/promises';
import * as path from 'path';

/**
 * Validate workspace path
 * Ensures path is safe and accessible
 */
export async function validateWorkspacePath(workspacePath: string): Promise<{
  valid: boolean;
  error?: string;
}> {
  try {
    // Check for path traversal attempts
    const normalizedPath = path.normalize(workspacePath);
    if (normalizedPath.includes('..')) {
      return {
        valid: false,
        error: 'Path traversal detected - workspace path cannot contain ".."',
      };
    }

    // Check if path exists
    try {
      const stats = await fs.stat(workspacePath);
      if (!stats.isDirectory()) {
        return {
          valid: false,
          error: 'Workspace path must be a directory',
        };
      }
    } catch (error) {
      return {
        valid: false,
        error: `Workspace path does not exist or is not accessible: ${workspacePath}`,
      };
    }

    // Check if path is too deep (security limit)
    const depth = workspacePath.split(path.sep).length;
    if (depth > 20) {
      return {
        valid: false,
        error: 'Workspace path is too deep (max 20 levels)',
      };
    }

    // Check if path contains too many files (prevent DoS)
    const files = await fs.readdir(workspacePath);
    if (files.length > 50000) {
      return {
        valid: false,
        error: 'Workspace contains too many files (max 50,000). Please use a more specific path.',
      };
    }

    return { valid: true };
  } catch (error) {
    return {
      valid: false,
      error: `Error validating workspace path: ${error instanceof Error ? error.message : 'Unknown error'}`,
    };
  }
}

/**
 * Sanitize workspace path
 * Remove any potentially dangerous characters
 */
export function sanitizeWorkspacePath(workspacePath: string): string {
  // Normalize path separators
  let sanitized = path.normalize(workspacePath);

  // Remove any null bytes
  sanitized = sanitized.replace(/\0/g, '');

  // Ensure absolute path
  if (!path.isAbsolute(sanitized)) {
    sanitized = path.resolve(sanitized);
  }

  return sanitized;
}

/**
 * Check if path is within allowed bounds
 */
export function isPathWithinBounds(basePath: string, targetPath: string): boolean {
  const normalizedBase = path.normalize(basePath);
  const normalizedTarget = path.normalize(targetPath);

  const relative = path.relative(normalizedBase, normalizedTarget);
  return !relative.startsWith('..') && !path.isAbsolute(relative);
}
