import { execFile } from 'child_process';
import util from 'util';
import path from 'path';
import fs from 'fs/promises';
import { getConfigManager } from '../utils/configManager.js';
import { withOperationLock } from '../utils/operationLocks.js';

const execFileAsync = util.promisify(execFile);

// Keyword that xppbp.exe prints when it doesn't recognise the arguments
const HELP_TEXT_PATTERN = /^usage:|BPCheck Tool|^xppbp\.exe|unrecognized|missing required|X\+\+ Best Practice Options/im;

// Tool registration (name, description, inputSchema) lives inline in
// src/server/mcpServer.ts - the single source of truth for tool instructions.

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

/**
 * Element names xppbp mentions in its output. Recognises the two shapes it
 * emits: an AOT file path (`…\AxTable\ConDemoTicket.xml`) and a quoted element
 * reference (`element 'ConDemoTicket'` / `Table 'ConDemoTicket'`).
 */
export function extractReportedElements(output: string): string[] {
  const names = new Set<string>();
  for (const m of output.matchAll(/[\\/]Ax[A-Za-z]+[\\/]([A-Za-z0-9_]+)\.xml/g)) names.add(m[1]);
  for (const m of output.matchAll(/\b(?:element|table|class|form|query|view|enum|edt)\s+'([A-Za-z0-9_]+)'/gi)) {
    names.add(m[1]);
  }
  return [...names];
}

/**
 * Scope-verification note for a filtered run (#25). xppbp silently ignores an
 * unknown filter flag, so a scoped call can quietly return whole-model results;
 * saying so is better than leaving the agent to attribute findings by hand.
 */
export function describeScope(targetFilter: string, output: string): string {
  const reported = extractReportedElements(output);
  const foreign = reported.filter(n => n.toLowerCase() !== targetFilter.toLowerCase());
  if (foreign.length === 0) {
    return reported.length > 0 ? `\nScope: honoured — findings are for ${targetFilter} only.` : '';
  }
  return (
    `\n⚠️ Scope NOT honoured: xppbp also reported on ${foreign.slice(0, 5).join(', ')}` +
    `${foreign.length > 5 ? ` (+${foreign.length - 5} more)` : ''}. ` +
    `Findings below are NOT all attributable to "${targetFilter}" — check each element name before acting.`
  );
}

export const runBpCheckTool = async (params: any, _context: any) => {
  const { targetFilter, targetElementType } = params;
  try {
    const configManager = getConfigManager();
    await configManager.ensureLoaded();

    const modelName = params.modelName || configManager.getModelName();
    if (!modelName) {
      return {
        content: [{ type: 'text', text: '❌ Cannot determine model name.\n\nProvide modelName parameter or set it in .mcp.json.' }],
        isError: true
      };
    }

    // Optional in UDE environments, where xppbp no longer requires -vsproj
    const resolvedProjectPath = params.projectPath || await configManager.getProjectPath();

    // Path resolution mirrors build_d365fo_project: (1) XPP config file if present — authoritative,
    // .mcp.json custom/microsoft packages paths are ignored in that case; (2) configManager
    // (.mcp.json overrides, then XPP auto-detection); (3) well-known PackagesLocalDirectory probe (CHE).
    // In UDE, customPackagesPath (ModelStoreFolder) is metadata root, microsoftPackagesPath
    // (FrameworkDirectory) is binaries root; in CHE both roles share packagesRoot.
    let customPackagesPath: string | null = null;
    let microsoftPackagesPath: string | null = null;
    const xppConfig = await configManager.getActiveXppConfig();
    if (xppConfig) {
      customPackagesPath = xppConfig.customPackagesPath;
      microsoftPackagesPath = xppConfig.microsoftPackagesPath;
    }

    if (!customPackagesPath)    customPackagesPath    = await configManager.getCustomPackagesPath();
    if (!microsoftPackagesPath) microsoftPackagesPath = await configManager.getMicrosoftPackagesPath();

    if (!microsoftPackagesPath) {
      for (const candidate of [
        'C:\\AOSService\\PackagesLocalDirectory',
        'K:\\AOSService\\PackagesLocalDirectory',
        'J:\\AOSService\\PackagesLocalDirectory',
        'I:\\AOSService\\PackagesLocalDirectory',
      ]) {
        try { await fs.access(candidate); microsoftPackagesPath = candidate; break; } catch { /* next */ }
      }
    }

    if (!customPackagesPath && microsoftPackagesPath) customPackagesPath = microsoftPackagesPath;

    // packagesRoot priority: explicit param → microsoft path → custom path → legacy env var → hardcoded default
    const packagesRoot = params.packagePath
      || microsoftPackagesPath
      || customPackagesPath
      || configManager.getPackagePath()
      || 'K:\\AosService\\PackagesLocalDirectory';

    // xppbp.exe always lives in the Microsoft/framework packages Bin, not the custom model folder.
    const xppbpPath = path.join(packagesRoot, 'Bin', 'xppbp.exe');
    try {
      await fs.access(xppbpPath);
    } catch {
      return {
        content: [{ type: 'text', text: `❌ xppbp.exe not found at: ${xppbpPath}\n\nMake sure XPP_CONFIG_NAME is set correctly in your instance .env so the FrameworkDirectory is resolved automatically.` }],
        isError: true
      };
    }

    // metadataPath: X++ source XML (custom model metadata). compilerMetadataPath: compiled
    // binaries + framework metadata (UDE: Microsoft packages root; CHE: same as metadataPath).
    const metadataPath = customPackagesPath || packagesRoot;
    const compilerMetadataPath = microsoftPackagesPath || packagesRoot;

    /**
     * xppbp.exe CLI flag styles vary by version — tried in order (A → B → C), stopping at
     * the first that doesn't return help text: A) colon separator (older), B) equals
     * separator with positional "type:Name" filter (10.0.24+), C) -packagesRoot fallback
     * when -compilerMetadata is not recognized.
     */

    // Style A — colon separator with -compilerMetadata
    //
    // #25: `-all` means "check the whole model" and xppbp does NOT recognise
    // `-filter:` — so this style silently ignored the requested scope (a run
    // filtered to one class returned warnings for two unrelated table elements).
    // With a targetFilter we therefore drop `-all` and append the positional
    // `<type>:<Name>` element selector this xppbp understands.
    const buildArgsColonStyle = (metadataFlag: string, compilerMetadataFlag: string): string[] => {
      const a: string[] = [
        `${metadataFlag}${metadataPath}`,
        `-module:${modelName}`,
        `-model:${modelName}`,
        `${compilerMetadataFlag}${compilerMetadataPath}`,
      ];
      if (targetFilter) {
        a.push(`${(targetElementType ?? 'class').toLowerCase()}:${targetFilter}`);
      } else {
        a.push(`-all`);
      }
      return a;
    };

    // Style B — equals separator (xppbp 10.0.24+: positional "<type>:<Name>" filter, no leading dash)
    const buildArgsEqStyle = ({ compilerMetadata }: { compilerMetadata: boolean }): string[] => {
      const a: string[] = [
        `-metadata=${metadataPath}`,
        `-module=${modelName}`,
        `-model=${modelName}`,
      ];

      // -compilerMetadata= is the newer flag; fall back to -packagesRoot= for older xppbp
      if (compilerMetadata) {
        a.push(`-compilerMetadata=${compilerMetadataPath}`);
      } else {
        a.push(`-packagesRoot=${compilerMetadataPath}`);
      }

      // Positional element filter: "<type>:<Name>" — type comes from targetElementType
      // (defaults to 'class' when omitted for backwards compatibility). `-all` is
      // mutually exclusive with it: passing both checks the whole model (#25).
      if (targetFilter) {
        const elemType = (targetElementType ?? 'class').toLowerCase();
        a.push(`${elemType}:${targetFilter}`);
      } else {
        a.push(`-all`);
      }
      return a;
    };

    // Style C — fallback when -compilerMetadata is not recognized
    const buildArgsFallbackStyle = (): string[] => {
      const a: string[] = [
        `-metadata:${metadataPath}`,
        `-packagesRoot:${compilerMetadataPath}`,
        `-module:${modelName}`,
        `-model:${modelName}`,
      ];
      if (targetFilter) {
        a.push(`${(targetElementType ?? 'class').toLowerCase()}:${targetFilter}`);
      } else {
        a.push(`-all`);
      }
      return a;
    };

    let stdout = '';
    let stderr = '';

    const { combined, lastStdout, lastStderr } = await withOperationLock(
      `bp:${modelName}`,
      async () => {
        // Attempt 1: colon style with -compilerMetadata: (UDE: separates custom and framework paths)
        const args1 = buildArgsColonStyle('-metadata:', '-compilerMetadata:');
        console.error(`[run_bp_check] Attempt 1 (-compilerMetadata: colon): "${xppbpPath}" ${args1.join(' ')}`);
        try {
          ({ stdout, stderr } = await tryXppbp(xppbpPath, args1));
        } catch (e: any) {
          stdout = e.stdout ?? '';
          stderr = e.stderr ?? '';
        }
        let localCombined = [stdout, stderr].filter(Boolean).join('\n').trim();

        // Attempt 2: equals style with -compilerMetadata= (xppbp 10.0.24+)
        if (HELP_TEXT_PATTERN.test(localCombined) || localCombined === '') {
          const args2 = buildArgsEqStyle({ compilerMetadata: true });
          console.error(`[run_bp_check] Attempt 2 (-compilerMetadata= equals): "${xppbpPath}" ${args2.join(' ')}`);
          try {
            ({ stdout, stderr } = await tryXppbp(xppbpPath, args2));
          } catch (e: any) {
            stdout = e.stdout ?? '';
            stderr = e.stderr ?? '';
          }
          localCombined = [stdout, stderr].filter(Boolean).join('\n').trim();
        }

        // Attempt 3: equals style with -packagesRoot= (fallback for older xppbp)
        if (HELP_TEXT_PATTERN.test(localCombined) || localCombined === '') {
          const args3 = buildArgsEqStyle({ compilerMetadata: false });
          console.error(`[run_bp_check] Attempt 3 (-packagesRoot= equals fallback): "${xppbpPath}" ${args3.join(' ')}`);
          try {
            ({ stdout, stderr } = await tryXppbp(xppbpPath, args3));
          } catch (e: any) {
            stdout = e.stdout ?? '';
            stderr = e.stderr ?? '';
          }
          localCombined = [stdout, stderr].filter(Boolean).join('\n').trim();
        }

        // Attempt 4: colon style with -packagesRoot: (oldest fallback)
        if (HELP_TEXT_PATTERN.test(localCombined) || localCombined === '') {
          const args4 = buildArgsFallbackStyle();
          console.error(`[run_bp_check] Attempt 4 (-packagesRoot: colon fallback): "${xppbpPath}" ${args4.join(' ')}`);
          try {
            ({ stdout, stderr } = await tryXppbp(xppbpPath, args4));
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
          text: `❌ xppbp.exe returned its help text for all four flag-style attempts (-compilerMetadata:, -compilerMetadata=, -packagesRoot= with equals, -packagesRoot: with colon).\n\nThis usually means the installed xppbp.exe version uses an unrecognised CLI format.\n\nRaw output:\n\n${combined}`
        }],
        isError: true
      };
    }

    // xppbp prints violations as plain text on stdout/stderr (-car: generates an Excel file instead).
    const logContent = combined;

    // xppbp emits either "BPError..."/XML <Diagnostic severity="error"> or
    // "BestPractices Warning/Error: ..." — both count as a violation.
    const hasIssues = /BPError|<Diagnostic|severity="error"|BestPractices (Warning|Error):/i.test(logContent)
      || /BPError|severity\s*[:=]\s*error/i.test(combined)
      || /^Warnings:\s*[1-9]/m.test(combined)
      || /^Errors:\s*[1-9]/m.test(combined);

    const summary = hasIssues ? '⚠️ BP Check completed with issues' : '✅ BP Check passed';
    const details = logContent || combined || '(no output)';

    // #25: report honestly whether the requested scope actually took effect —
    // attribution used to require reading rule names and guessing.
    const scopeNote = targetFilter ? describeScope(targetFilter, combined) : '';

    return {
      content: [{
        type: 'text',
        text: `${summary}\n\nModel: ${modelName}` +
          (resolvedProjectPath ? `\nProject: ${resolvedProjectPath}` : '') +
          (targetFilter ? `\nFilter: ${(targetElementType ?? 'class').toLowerCase()}:${targetFilter}` : '') +
          scopeNote +
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
