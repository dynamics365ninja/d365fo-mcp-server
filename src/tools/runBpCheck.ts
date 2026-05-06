import { z } from 'zod';
import { execFile } from 'child_process';
import util from 'util';
import path from 'path';
import fs from 'fs/promises';
import { getConfigManager } from '../utils/configManager.js';
import { withOperationLock } from '../utils/operationLocks.js';

const execFileAsync = util.promisify(execFile);

// Keyword that xppbp.exe prints when it doesn't recognise the arguments
const HELP_TEXT_PATTERN = /^usage:|BPCheck Tool|^xppbp\.exe|unrecognized|missing required|X\+\+ Best Practice Options/im;

export const runBpCheckToolDefinition = {
  name: 'run_bp_check',
  description: 'Runs xppbp.exe against the project to enforce Microsoft Best Practices.',
  parameters: z.object({
    projectPath: z.string().optional().describe('The absolute path to the .rnrproj file to check. Auto-detected from .mcp.json if omitted.'),
    targetFilter: z.string().optional().describe('Optional: filter results to a specific class, table, or object name'),
    modelName: z.string().optional().describe('Model name to check. Auto-detected from .mcp.json if omitted.'),
    packagePath: z.string().optional().describe('PackagesLocalDirectory root. Auto-detected if omitted.')
  })
};

/**
 * Attempt to run xppbp.exe with a given set of args.
 * Returns { stdout, stderr } or throws on non-zero exit / timeout.
 */
async function tryXppbp(xppbpPath: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(xppbpPath, args, {
    maxBuffer: 10 * 1024 * 1024,
    timeout: 300_000 // 5 minutes
  });
}

export const runBpCheckTool = async (params: any, _context: any) => {
  const { targetFilter } = params;
  try {
    const configManager = getConfigManager();
    await configManager.ensureLoaded();

    // Resolve model name
    const modelName = params.modelName || configManager.getModelName();
    if (!modelName) {
      return {
        content: [{ type: 'text', text: '❌ Cannot determine model name.\n\nProvide modelName parameter or set it in .mcp.json.' }],
        isError: true
      };
    }

    // Resolve project path — required by most xppbp.exe versions
    const resolvedProjectPath = params.projectPath || await configManager.getProjectPath();
    if (!resolvedProjectPath) {
      return {
        content: [{
          type: 'text',
          text: '❌ Cannot determine project path.\n\nProvide projectPath parameter or set it in .mcp.json:\n```json\n{ "servers": { "context": { "projectPath": "C:\\\\path\\\\to\\\\MyProject.rnrproj" } } }\n```'
        }],
        isError: true
      };
    }

    // In UDE the custom packages path (ModelStoreFolder) is the metadata root,
    // while the framework packages path (FrameworkDirectory) is the binaries root.
    // For traditional environments both roles are served by packagesRoot.
    const microsoftPackagesPath = await configManager.getMicrosoftPackagesPath();
    const customPackagesPath = await configManager.getCustomPackagesPath();

    // Explicit override from params takes priority; otherwise derive from XPP config
    // so the version is never hardcoded — it comes from XPP_CONFIG_NAME in the instance .env.
    const packagesRoot = params.packagePath
      || microsoftPackagesPath
      || configManager.getPackagePath()
      || 'K:\\AosService\\PackagesLocalDirectory';

    // Locate xppbp.exe — always in the Microsoft/framework packages Bin, not the custom model folder.
    const xppbpPath = path.join(packagesRoot, 'Bin', 'xppbp.exe');
    try {
      await fs.access(xppbpPath);
    } catch {
      return {
        content: [{ type: 'text', text: `❌ xppbp.exe not found at: ${xppbpPath}\n\nMake sure XPP_CONFIG_NAME is set correctly in your instance .env so the FrameworkDirectory is resolved automatically.` }],
        isError: true
      };
    }

    // metadataPath: where X++ source XML lives (custom model metadata)
    const metadataPath = customPackagesPath || packagesRoot;
    // packagesRootPath: where compiled binaries live (framework packages)
    const packagesRootPath = microsoftPackagesPath || packagesRoot;

    /**
     * Build the args array for one invocation attempt.
     * Required flags (modern xppbp.exe):
     *   -metadata:<path>     — custom model metadata root (ModelStoreFolder in UDE)
     *   -module:<name>       — package/module name (same as model for single-model packages)
     *   -model:<name>        — model name
     *   -packagesRoot:<path> — framework binaries root (FrameworkDirectory in UDE)
     *   -all                 — check all element types
     * Note: -car: generates an Excel (.xlsx) file, not XML — we rely on stdout instead.
     */
    const buildArgs = (metadataFlag: string): string[] => {
      const a: string[] = [
        `${metadataFlag}${metadataPath}`,
        `-module:${modelName}`,
        `-model:${modelName}`,
        `-packagesRoot:${packagesRootPath}`,
        `-all`,
      ];
      if (targetFilter) a.push(`-filter:${targetFilter}`);
      return a;
    };

    let stdout = '';
    let stderr = '';

    // --- First attempt: modern -metadata: flag ---
    const args = buildArgs('-metadata:');
    const { combined, lastStdout, lastStderr } = await withOperationLock(
      `bp:${resolvedProjectPath}`,
      async () => {
        console.error(`[run_bp_check] Attempt 1: "${xppbpPath}" ${args.join(' ')}`);
        try {
          ({ stdout, stderr } = await tryXppbp(xppbpPath, args));
        } catch (e: any) {
          stdout = e.stdout ?? '';
          stderr = e.stderr ?? '';
        }

        let localCombined = [stdout, stderr].filter(Boolean).join('\n').trim();

        // --- Fallback: legacy -packagesroot: flag (older xppbp without -metadata) ---
        if (HELP_TEXT_PATTERN.test(localCombined) || localCombined === '') {
          const fallbackArgs = buildArgs('-packagesroot:');
          console.error(`[run_bp_check] Attempt 2 (legacy flag): "${xppbpPath}" ${fallbackArgs.join(' ')}`);
          try {
            ({ stdout, stderr } = await tryXppbp(xppbpPath, fallbackArgs));
          } catch (e: any) {
            stdout = e.stdout ?? '';
            stderr = e.stderr ?? '';
          }
          localCombined = [stdout, stderr].filter(Boolean).join('\n').trim();
        }

        return { combined: localCombined, lastStdout: stdout, lastStderr: stderr };
      },
    );

    stdout = lastStdout;
    stderr = lastStderr;

    // If still showing help text, report a useful diagnostic
    if (HELP_TEXT_PATTERN.test(combined)) {
      return {
        content: [{
          type: 'text',
          text: `❌ xppbp.exe returned its help text for both -metadata: and -packagesroot: flags.\n\nThis usually means the installed xppbp.exe version uses a different CLI.\n\nRaw output:\n\n${combined}`
        }],
        isError: true
      };
    }

    // Use stdout/stderr directly — xppbp prints violations as plain text.
    // (-car: generates an Excel file which is not human-readable as text.)
    const logContent = combined;

    // Detect violations in XML log or plain text output
    const hasErrors = /BPError|<Diagnostic|severity="error"/i.test(logContent)
      || /BPError|severity\s*[:=]\s*error/i.test(combined);

    const summary = hasErrors ? '⚠️ BP Check completed with issues' : '✅ BP Check passed';
    const details = logContent || combined || '(no output)';

    return {
      content: [{
        type: 'text',
        text: `${summary}\n\nModel: ${modelName}\nProject: ${resolvedProjectPath}` +
          (targetFilter ? `\nFilter: ${targetFilter}` : '') +
          `\n\n${details}`
      }]
    };
  } catch (error: any) {
    console.error('Error running BP Check:', error);
    const output = [error.stdout, error.stderr, error.message].filter(Boolean).join('\n');
    return {
      content: [{ type: 'text', text: '❌ BP Check failed:\n\n' + output }],
      isError: true
    };
  }
};
