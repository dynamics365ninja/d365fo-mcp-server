import { execFile } from 'child_process';
import util from 'util';
import fs from 'fs';
import { promises as fsp } from 'fs';
import path from 'path';
import type { XppServerContext } from '../types/context.js';
import { bridgeRefreshProvider } from '../bridge/index.js';

const execFileAsync = util.promisify(execFile);

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    windowsHide: true,
    maxBuffer: 1024 * 1024 * 10,
    // Prevent a hung git from blocking the tool indefinitely.
    timeout: 30_000,
  });
  return stdout.trim();
}

function isInsideRepo(repoRoot: string, targetPath: string): boolean {
  const relative = path.relative(repoRoot, targetPath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function toRepoRelative(repoRoot: string, absolutePath: string): string {
  return path.relative(repoRoot, absolutePath).split(path.sep).join('/');
}

// Tool registration (name, description, inputSchema) lives inline in
// src/server/mcpServer.ts - the single source of truth for tool instructions.

export const undoLastModificationTool = async (params: any, context: XppServerContext) => {
  const { filePath } = params;
  try {
    if (!filePath || typeof filePath !== 'string') {
      return {
        content: [{ type: 'text', text: 'Invalid filePath. Provide an absolute file path.' }],
        isError: true,
      };
    }

    // Use filePath as-is (already absolute); path.resolve() would add a Windows drive letter
    // to POSIX-style paths like /repo/src/a.ts → C:\repo\src\a.ts
    const absolutePath = filePath;
    const cwd = path.posix.dirname(filePath.replace(/\\/g, '/'));

    let repoRoot = '';
    try {
      repoRoot = await git(['rev-parse', '--show-toplevel'], cwd);
    } catch {
      return {
        content: [{ type: 'text', text: 'File is not inside a git repository: ' + absolutePath }],
        isError: true,
      };
    }

    if (!isInsideRepo(repoRoot, absolutePath)) {
      return {
        content: [{ type: 'text', text: 'Refusing operation outside repository root: ' + absolutePath }],
        isError: true,
      };
    }

    const relativePath = toRepoRelative(repoRoot, absolutePath);
    if (!relativePath || relativePath === '.') {
      return {
        content: [{ type: 'text', text: 'Refusing operation on repository root. Provide a file path.' }],
        isError: true,
      };
    }

    let tracked = false;
    try {
      await git(['ls-files', '--error-unmatch', '--', relativePath], repoRoot);
      tracked = true;
    } catch {
      tracked = false;
    }

    if (tracked) {
      await git(['checkout', 'HEAD', '--', relativePath], repoRoot);
      // Re-index the reverted file so the symbol index reflects the restored version
      await cleanupIndexAfterUndo(context, absolutePath, 'reverted');
      return {
        content: [{ type: 'text', text: 'Successfully reverted tracked file modification: ' + absolutePath + '\nSymbol index updated to reflect the reverted state.' }],
      };
    }

    if (!fs.existsSync(absolutePath)) {
      return {
        content: [{ type: 'text', text: 'File not found and not tracked by git: ' + absolutePath }],
        isError: true,
      };
    }

    const stat = await fsp.stat(absolutePath);
    if (!stat.isFile()) {
      return {
        content: [{ type: 'text', text: 'Refusing to delete non-file path: ' + absolutePath }],
        isError: true,
      };
    }

    let untracked = false;
    try {
      const out = await git(['ls-files', '--others', '--exclude-standard', '--', relativePath], repoRoot);
      untracked = out.split('\n').map(s => s.trim()).includes(relativePath);
    } catch {
      untracked = false;
    }

    if (!untracked) {
      return {
        content: [{ type: 'text', text: 'Refusing to delete file that is not a git-untracked file: ' + absolutePath }],
        isError: true,
      };
    }

    fs.unlinkSync(absolutePath);
    // Clean up stale index entries for the deleted file
    await cleanupIndexAfterUndo(context, absolutePath, 'deleted');
    return {
      content: [{ type: 'text', text: 'Successfully undid file creation (deleted untracked file): ' + absolutePath + '\nStale index entries cleaned up.' }],
    };
  } catch (error: any) {
    return {
      content: [{ type: 'text', text: 'Error undoing modifications: ' + error.message }],
      isError: true
    };
  }
};

// ── Index cleanup after undo ───────────────────────────────────────────────

/**
 * Clean up the symbol index, label index, and bridge after
 * a file is reverted or deleted by undo_last_modification.
 *
 * - For DELETED files: remove all stale symbols + labels.
 * - For REVERTED files: re-index from the restored file content.
 */
async function cleanupIndexAfterUndo(
  context: XppServerContext,
  filePath: string,
  action: 'deleted' | 'reverted',
): Promise<void> {
  const { symbolIndex } = context;

  try {
    // 1. Remove stale symbols from SQLite
    const { deletedCount } = symbolIndex?.removeSymbolsByFile?.(filePath) ?? { deletedCount: 0 };
    console.error(`[undo] Removed ${deletedCount} stale symbol(s) for ${path.basename(filePath)}`);

    // 2. Remove stale labels (label .txt files have the same path pattern)
    const labelCount = symbolIndex?.removeLabelsByFile?.(filePath) ?? 0;
    if (labelCount > 0) {
      console.error(`[undo] Removed ${labelCount} stale label(s) for ${path.basename(filePath)}`);
    }

    // 3. Refresh bridge metadata provider
    try {
      await bridgeRefreshProvider(context.bridge);
    } catch { /* bridge not available */ }

    // 4. For reverted files: re-index the restored content
    if (action === 'reverted' && fs.existsSync(filePath)) {
      // Import dynamically to avoid circular dependency
      const { updateSymbolIndexTool } = await import('./updateSymbolIndex.js');
      await updateSymbolIndexTool({ filePath }, context);
      console.error(`[undo] Re-indexed reverted file: ${path.basename(filePath)}`);
    }
  } catch (e) {
    console.error(`[undo] Index cleanup failed (non-fatal): ${e}`);
  }
}
