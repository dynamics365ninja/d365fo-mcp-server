import { z } from 'zod';
import { exec } from 'child_process';
import util from 'util';

const execAsync = util.promisify(exec);

export const reviewWorkspaceChangesToolDefinition = {
  name: 'review_workspace_changes',
  description: 'Fetches uncommitted X++ changes (git diff) and processes them into a clean format for AI Code Review against D365 Best Practices.',
  parameters: z.object({
    directoryPath: z.string().describe('The absolute path to the local repository')
  })
};

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
      const abs = repoRoot.replace(/[\\/]$/, '') + '\\' + rel.replace(/\//g, '\\');
      if (!seen.has(abs)) {
        seen.add(abs);
        paths.push(abs);
      }
    }
  }
  return paths;
}

export const reviewWorkspaceChangesTool = async (params: any, _context: any) => {
  const { directoryPath } = params;
  try {
    const { stdout } = await execAsync('git diff HEAD --unified=3', { cwd: directoryPath });
    if (!stdout.trim()) {
      return { content: [{ type: 'text', text: 'No uncommitted changes found for review.' }] };
    }

    const changedFiles = extractChangedFiles(stdout, directoryPath);
    let undoSection = '';
    if (changedFiles.length > 0) {
      const fileList = changedFiles.map(f => `  • ${f}`).join('\n');
      const undoExamples = changedFiles
        .slice(0, 3)
        .map(f => `  undo_last_modification(filePath="${f}")`)
        .join('\n');
      undoSection = `\n\n---\n## Changed files (${changedFiles.length})\n${fileList}\n\n` +
        `## Selective undo\n` +
        `To revert a specific file to its last committed state, use \`undo_last_modification\`:\n` +
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
