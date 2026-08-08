/**
 * Workspace utilities
 * Path validation and security helpers
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { assertReadRootAllowed } from '../utils/pathContainment.js';

/**
 * Validate workspace path.
 * Ensures the path is safe and accessible, and that it resolves under one of
 * the configured D365FO package roots (not just a ".." substring check).
 */
export async function validateWorkspacePath(workspacePath: string): Promise<{
  valid: boolean;
  error?: string;
}> {
  try {
    const resolved = path.resolve(workspacePath);

    // Reject any path that does not resolve under a configured package root.
    const containment = await assertReadRootAllowed(resolved);
    if (!containment.ok) {
      return {
        valid: false,
        error: containment.reason ?? 'workspacePath escapes configured workspace roots',
      };
    }

    try {
      const stats = await fs.stat(resolved);
      if (!stats.isDirectory()) {
        return {
          valid: false,
          error: 'Workspace path must be a directory',
        };
      }
    } catch (error) {
      return {
        valid: false,
        error: `Workspace path does not exist or is not accessible: ${resolved}`,
      };
    }

    // Prevent DoS via directories with excessive file counts.
    const files = await fs.readdir(resolved);
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
