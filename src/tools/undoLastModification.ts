import { execFile } from 'child_process';
import util from 'util';
import fs from 'fs';
import { promises as fsp } from 'fs';
import path from 'path';
import type { XppServerContext } from '../types/context.js';
import { bridgeRefreshProvider } from '../bridge/index.js';
import { isFileUnderRoot } from '../utils/pathContainment.js';
import { lookupCreatedArtifact, forgetCreatedArtifact, type CreatedArtifact } from './createdArtifactLedger.js';

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

function realpathOrSelf(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p; // not on disk (yet) — the as-given form is all we have
  }
}

/**
 * Containment check for the undo target, using the same lexical-OR-realpath rule the
 * write path applies (utils/pathContainment.isUnder).
 *
 * A D365FO model directory under PackagesLocalDirectory is commonly a symlink to a
 * repo checkout, and `git rev-parse --show-toplevel` answers with the RESOLVED root.
 * A purely lexical path.relative() between the two therefore climbs out of the repo
 * ("..\\..\\…") and undo refused every file reached through the symlink — the write
 * path was fixed for exactly this and undo was left behind.
 *
 * Exported for unit tests.
 */
export function isInsideRepo(repoRoot: string, targetPath: string): boolean {
  return isFileUnderRoot(targetPath, repoRoot);
}

/**
 * Repo-relative path of the undo target. Prefers the lexical form (it preserves the
 * casing/spelling git already knows) and falls back to comparing both sides resolved,
 * which is the form that works when the target was reached through a symlinked
 * package or model directory.
 *
 * Exported for unit tests.
 */
export function toRepoRelative(repoRoot: string, absolutePath: string): string {
  const toPosix = (p: string) => p.split(path.sep).join('/');
  const lexical = path.relative(repoRoot, absolutePath);
  if (lexical && !lexical.startsWith('..') && !path.isAbsolute(lexical)) {
    return toPosix(lexical);
  }
  return toPosix(path.relative(realpathOrSelf(repoRoot), realpathOrSelf(absolutePath)));
}

// Tool registration (name, description, inputSchema) lives in
// src/server/toolSchemas/undoLastModification.ts — the single source of truth for tool
// instructions. It is NOT in mcpServer.ts; that file only spreads the
// aggregated toolSchemas array into the ListTools response.

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
      // Not inside a git repository — e.g. the D365FO sandbox
      // K:\AosService\PackagesLocalDirectory. The git-based revert/delete cannot
      // help here. Fall back to the create-artifact ledger: undo may delete a file
      // ONLY when d365fo_file(action="create") recorded creating it (genuinely new)
      // in THIS server session. Anything not in the ledger keeps the original
      // "not inside a git repository" error — the non-git path never deletes an
      // arbitrary or pre-existing file.
      // (Corpus: eval/corpus/runs/2026-07-21T__L3-custom-service-basic__a2a4131.json.)
      const ledgerResult = await undoViaLedger(absolutePath, context);
      if (ledgerResult) return ledgerResult;
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

/**
 * Non-git undo path. Safe by construction: it acts ONLY on a file that
 * d365fo_file(action="create") recorded creating (genuinely new) in this session.
 * Returns null when the path is not in the ledger, so the caller can fall back to
 * the original "not inside a git repository" error. Deletes the created file and
 * cleans its .rnrproj entry (when the create recorded a project) plus the index.
 */
async function undoViaLedger(
  absolutePath: string,
  context: XppServerContext,
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean } | null> {
  const entry = lookupCreatedArtifact(absolutePath);
  if (!entry) return null;

  if (!fs.existsSync(absolutePath)) {
    // Already gone (e.g. removed by hand). Still clean the project + index and
    // forget the ledger entry so the run's state is consistent.
    await removeFromProjectSafe(entry);
    forgetCreatedArtifact(absolutePath);
    await cleanupIndexAfterUndo(context, absolutePath, 'deleted');
    return {
      content: [{ type: 'text', text: 'File already removed; cleaned project + index entries for session-created object: ' + absolutePath }],
    };
  }

  const stat = await fsp.stat(absolutePath);
  if (!stat.isFile()) {
    return {
      content: [{ type: 'text', text: 'Refusing to delete non-file path: ' + absolutePath }],
      isError: true,
    };
  }

  fs.unlinkSync(absolutePath);
  await removeFromProjectSafe(entry);
  forgetCreatedArtifact(absolutePath);
  await cleanupIndexAfterUndo(context, absolutePath, 'deleted');

  const projectNote = entry.projectPath
    ? '\nRemoved its project entry from ' + path.basename(entry.projectPath) + '.'
    : '';
  return {
    content: [{ type: 'text', text: 'Successfully undid file creation (deleted session-created file outside git): ' + absolutePath + projectNote + '\nStale index entries cleaned up.' }],
  };
}

/**
 * Best-effort reversal of create_d365fo_file's addToProject. Non-fatal: a failure
 * to touch the .rnrproj must never abort the file deletion that already succeeded.
 * Uses a dynamic import to avoid a static dependency cycle with createD365File.ts.
 */
async function removeFromProjectSafe(entry: CreatedArtifact): Promise<void> {
  if (!entry.projectPath || !entry.objectType || !entry.objectName) return;
  try {
    const { ProjectFileManager } = await import('./createD365File.js');
    await new ProjectFileManager().removeFromProject(entry.projectPath, entry.objectType, entry.objectName);
  } catch (e) {
    console.error(`[undo] Non-git project cleanup failed (non-fatal): ${e}`);
  }
}

/**
 * Clean up the symbol index, label index, and bridge after a file is reverted or
 * deleted by undo_last_modification. Deleted files: remove stale symbols + labels.
 * Reverted files: re-index from the restored content.
 */
async function cleanupIndexAfterUndo(
  context: XppServerContext,
  filePath: string,
  action: 'deleted' | 'reverted',
): Promise<void> {
  const { symbolIndex } = context;

  try {
    const { deletedCount } = symbolIndex?.removeSymbolsByFile?.(filePath) ?? { deletedCount: 0 };
    console.error(`[undo] Removed ${deletedCount} stale symbol(s) for ${path.basename(filePath)}`);

    const labelCount = symbolIndex?.removeLabelsByFile?.(filePath) ?? 0;
    if (labelCount > 0) {
      console.error(`[undo] Removed ${labelCount} stale label(s) for ${path.basename(filePath)}`);
    }

    try {
      await bridgeRefreshProvider(context.bridge);
    } catch { /* bridge not available */ }

    if (action === 'reverted' && fs.existsSync(filePath)) {
      // Dynamic import to avoid a circular dependency
      const { updateSymbolIndexTool } = await import('./updateSymbolIndex.js');
      await updateSymbolIndexTool({ filePath }, context);
      console.error(`[undo] Re-indexed reverted file: ${path.basename(filePath)}`);
    }
  } catch (e) {
    console.error(`[undo] Index cleanup failed (non-fatal): ${e}`);
  }
}
