import { execFile } from 'child_process';
import util from 'util';
import path from 'path';
import { getConfigManager } from '../../utils/configManager.js';

const execFileAsync = util.promisify(execFile);

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    windowsHide: true,
    maxBuffer: 1024 * 1024 * 10,
    // Bound runtime so a misbehaving git process (large repo, hung transport,
    // credential prompt) can never hold the tool thread indefinitely.
    timeout: 30_000,
  });
  return stdout;
}

// This is no longer a published tool: it is the handler behind
// get_workspace_info(changes=true) (src/server/toolSchemas/getWorkspaceInfo.ts),
// and stays routable under its old name `review_workspace_changes` for agents
// still holding it from an earlier session.

/**
 * First candidate directory that is inside a git work tree, or null.
 *
 * The published tool required an explicit `directoryPath`, and 2 of its 7 real
 * corpus calls failed with "not a git repository" because the caller guessed
 * one. Folded into get_workspace_info the directory is no longer the caller's
 * problem: the server already knows the workspace and the active project.
 */
async function resolveRepoRoot(candidates: Array<string | null | undefined>): Promise<string | null> {
  for (const dir of candidates) {
    if (!dir) continue;
    try {
      const root = (await git(['rev-parse', '--show-toplevel'], dir)).trim();
      if (root) return root;
    } catch {
      /* not a work tree (or git missing) — try the next candidate */
    }
  }
  return null;
}

/** Directories worth probing when the caller named none. */
async function defaultCandidates(): Promise<Array<string | null | undefined>> {
  const configManager = getConfigManager();
  let projectDir: string | null = null;
  try {
    const projectPath = await configManager.getProjectPath();
    if (projectPath) projectDir = path.dirname(projectPath);
  } catch {
    /* project detection best-effort */
  }
  return [
    configManager.getWorkspacePath(),
    projectDir,
    process.env.D365FO_WORKSPACE_PATH,
    process.cwd(),
  ];
}

/**
 * Extract absolute file paths from a git diff header ("+++ b/..." lines)
 */
function extractChangedFiles(diff: string, repoRoot: string): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ b/')) {
      const rel = line.slice(6); // strip "+++ b/"
      if (rel === '/dev/null') continue;
      // Use posix.join to avoid path.resolve() adding a Windows drive letter to POSIX-style paths
      const abs = path.posix.join(repoRoot.replace(/\\/g, '/'), rel);
      if (!seen.has(abs)) {
        seen.add(abs);
        paths.push(abs);
      }
    }
  }
  return paths;
}

export const reviewWorkspaceChangesTool = async (params: any, _context?: any) => {
  const { directoryPath } = params ?? {};
  try {
    const repoRoot = await resolveRepoRoot(
      directoryPath ? [directoryPath] : await defaultCandidates(),
    );
    // Graceful, and NOT an error: a D365FO model under PackagesLocalDirectory is
    // very often not under source control at all, and "there is no diff to show"
    // is the honest answer to that, not a failure the agent should retry.
    if (!repoRoot) {
      return {
        content: [{
          type: 'text',
          text: 'ℹ️ No uncommitted changes to review: ' +
            (directoryPath
              ? `"${directoryPath}" is not inside a git work tree.`
              : 'the workspace is not inside a git work tree.') +
            '\nVerify a write with verify_d365fo_project + get_object_info instead.',
        }],
      };
    }
    const stdout = await git(['diff', 'HEAD', '--unified=3'], repoRoot);
    if (!stdout.trim()) {
      return { content: [{ type: 'text', text: 'No uncommitted changes found for review.' }] };
    }

    const changedFiles = extractChangedFiles(stdout, repoRoot);
    let undoSection = '';
    if (changedFiles.length > 0) {
      const fileList = changedFiles.map(f => `  • ${f}`).join('\n');
      const undoExamples = changedFiles
        .slice(0, 3)
        .map(f => `  d365fo_file(action="undo", filePath="${f}")`)
        .join('\n');
      undoSection = `\n\n---\n## Changed files (${changedFiles.length})\n${fileList}\n\n` +
        `## Selective undo\n` +
        `To revert a specific file to its last committed state, use \`d365fo_file(action="undo")\`:\n` +
        `\`\`\`\n${undoExamples}\n\`\`\`\n` +
        `⚠️  This runs \`git checkout HEAD -- <file>\` — it discards ALL uncommitted changes in that file.\n` +
        `For untracked (newly created) files, the tool deletes the file entirely.`;
    }

    return {
      content: [{ type: 'text', text: 'Code Review Target (Git Diff):\n' + stdout + undoSection }]
    };
  } catch (error: any) {
    return {
      content: [{ type: 'text', text: 'Error fetching changes: ' + error.message }],
      isError: true
    };
  }
};
