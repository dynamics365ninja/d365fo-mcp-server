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
    targetFilter: z.string().optional().describe('Optional: filter results to a specific object name (class, table, form, enum, ...).'),
    targetElementType: z.string().optional().describe('Element type for the filter, used with xppbp 10.0.24+ (equals-style CLI). Common values: class, table, form, enum, view, query. Defaults to "class" when targetFilter is set but targetElementType is omitted.'),
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
  const { targetFilter, targetElementType } = params;
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

    // Resolve project path — optional in UDE environments where xppbp no longer requires -vsproj
    const resolvedProjectPath = params.projectPath || await configManager.getProjectPath();

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
     * xppbp.exe CLI flag styles observed across versions:
     *
     *   Style A — colon separator (older):
     *     -metadata:<path>  -module:<name>  -model:<name>  -packagesRoot:<path>  -all
     *     -filter:<name>  (filter by element name)
     *
     *   Style B — equals separator (newer, 10.0.24+):
     *     -metadata=<path>  -module=<name>  -model=<name>  -packagesRoot=<path>  -all
     *     class:<Name>  (positional element-type filter, e.g. "class:MyClass")
     *
     *   Style C — legacy packagesroot only (no -metadata flag):
     *     -packagesroot:<path>  -module:<name>  -model:<name>  -all
     *
     * We try A → B → C in order, stopping at the first that doesn't return help text.
     */

    // Style A — colon separator
    const buildArgsColonStyle = (metadataFlag: string): string[] => {
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

    // Style B — equals separator (xppbp 10.0.24+: positional "<type>:<Name>" filter, no leading dash)
    const buildArgsEqStyle = (): string[] => {
      const a: string[] = [
        `-metadata=${metadataPath}`,
        `-module=${modelName}`,
        `-model=${modelName}`,
        `-packagesRoot=${packagesRootPath}`,
        `-all`,
      ];
      // Positional element filter: "<type>:<Name>" — type comes from targetElementType
      // (defaults to 'class' when omitted for backwards compatibility).
      if (targetFilter) {
        const elemType = (targetElementType ?? 'class').toLowerCase();
        a.push(`${elemType}:${targetFilter}`);
      }
      return a;
    };

    let stdout = '';
    let stderr = '';

    const { combined, lastStdout, lastStderr } = await withOperationLock(
      `bp:${modelName}`,
      async () => {
        // --- Attempt 1: colon style with -metadata: ---
        const args1 = buildArgsColonStyle('-metadata:');
        console.error(`[run_bp_check] Attempt 1 (-metadata: colon): "${xppbpPath}" ${args1.join(' ')}`);
        try {
          ({ stdout, stderr } = await tryXppbp(xppbpPath, args1));
        } catch (e: any) {
          stdout = e.stdout ?? '';
          stderr = e.stderr ?? '';
        }
        let localCombined = [stdout, stderr].filter(Boolean).join('\n').trim();

        // --- Attempt 2: equals style (-metadata=, -module=, ...) ---
        if (HELP_TEXT_PATTERN.test(localCombined) || localCombined === '') {
          const args2 = buildArgsEqStyle();
          console.error(`[run_bp_check] Attempt 2 (-metadata= equals): "${xppbpPath}" ${args2.join(' ')}`);
          try {
            ({ stdout, stderr } = await tryXppbp(xppbpPath, args2));
          } catch (e: any) {
            stdout = e.stdout ?? '';
            stderr = e.stderr ?? '';
          }
          localCombined = [stdout, stderr].filter(Boolean).join('\n').trim();
        }

        // --- Attempt 3: legacy -packagesroot: (no -metadata flag) ---
        if (HELP_TEXT_PATTERN.test(localCombined) || localCombined === '') {
          const args3 = buildArgsColonStyle('-packagesroot:');
          console.error(`[run_bp_check] Attempt 3 (legacy -packagesroot:): "${xppbpPath}" ${args3.join(' ')}`);
          try {
            ({ stdout, stderr } = await tryXppbp(xppbpPath, args3));
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
          text: `❌ xppbp.exe returned its help text for all three flag-style attempts (-metadata:, -metadata=, -packagesroot:).\n\nThis usually means the installed xppbp.exe version uses an unrecognised CLI format.\n\nRaw output:\n\n${combined}`
        }],
        isError: true
      };
    }

    // Use stdout/stderr directly — xppbp prints violations as plain text.
    // (-car: generates an Excel file which is not human-readable as text.)
    const logContent = combined;

    // Detect violations in output.
    // xppbp emits two distinct line patterns:
    //   Errors:   "BPError..." or XML <Diagnostic severity="error">
    //   Warnings: "BestPractices Warning: ..." or "BestPractices Error: ..."
    // Both must trigger the warning status — a warning is still a violation.
    const hasIssues = /BPError|<Diagnostic|severity="error"|BestPractices (Warning|Error):/i.test(logContent)
      || /BPError|severity\s*[:=]\s*error/i.test(combined)
      || /^Warnings:\s*[1-9]/m.test(combined)
      || /^Errors:\s*[1-9]/m.test(combined);

    const summary = hasIssues ? '⚠️ BP Check completed with issues' : '✅ BP Check passed';
    const details = logContent || combined || '(no output)';

    return {
      content: [{
        type: 'text',
        text: `${summary}\n\nModel: ${modelName}` +
          (resolvedProjectPath ? `\nProject: ${resolvedProjectPath}` : '') +
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
