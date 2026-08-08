/**
 * get_workspace_info — the workspace/config/index diagnostic.
 *
 * This was ~320 lines living INSIDE the dispatcher's switch statement, which
 * made toolHandler.ts both the router and the largest single tool
 * implementation in the codebase. Every other tool is a function in its own
 * file; this one now is too, and its dispatcher case is one line like the rest.
 *
 * Behaviour is unchanged — this is a move.
 */

import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import type { XppServerContext } from '../../types/context.js';
import * as nodePath from 'path';
import { getConfigManager } from '../../utils/configManager.js';
import { getStdioSessionInfo } from '../../utils/stdioSessionInfo.js';
import { checkIndexStaleness } from '../../utils/indexStaleness.js';
import {
  isCustomModel, getObjectSuffix, getExtensionNamingStyle, deriveExtensionInfix,
} from '../../utils/modelClassifier.js';
import { buildPrefixDiagnostics, modelWritesLandIn } from '../analysis/prefixDiagnostics.js';
import {
  buildContextSnapshot, renderContextSnapshotSection, renderContextSnapshotCompact,
} from '../../workspace/contextSnapshot.js';

/** Models named inline by the compact project list before it summarises the rest. */
const PROJECT_NAMES_SHOWN = 12;

export async function getWorkspaceInfoTool(
  request: CallToolRequest,
  context: XppServerContext,
): Promise<any> {
  // The dispatcher held this in its own scope; the extracted function binds it.
  const configManager = getConfigManager();
  const args = (request as any).params?.arguments || {};

  // projectName: resolve by name from known projects list (user-friendly switch)
  if (args.projectName && !args.projectPath) {
    const needle = (args.projectName as string).toLowerCase();
    const allProjects = configManager.getAllDetectedProjects();
    const match = allProjects.find(p => p.modelName.toLowerCase() === needle)
      ?? allProjects.find(p => p.modelName.toLowerCase().includes(needle));
    if (!match) {
      const names = allProjects.map(p => p.modelName).join(', ') || '(none — set D365FO_SOLUTIONS_PATH)';
      return {
        content: [{ type: 'text', text: `❌ No project found matching "${args.projectName}".\nAvailable: ${names}` }],
        isError: true,
      };
    }
    args.projectPath = match.projectPath;
  }

  // projectPath: force-switch to specific .rnrproj
  if (args.projectPath) {
    const forced = await configManager.forceProject(args.projectPath);
    if (!forced) {
      return {
        content: [{ type: 'text', text: `❌ Could not read model name from: ${args.projectPath}\nMake sure the path points to a valid .rnrproj file.` }],
        isError: true,
      };
    }
  }

  const {
    modelName, modelSource, isModelSourceAutoDetected,
    projectPath, projectSource,
    packagePath, packageSource,
    customPackagesPath, customPackagesSource,
  } = await configManager.getWorkspaceInfoDiagnostics();
  const envType = await configManager.getDevEnvironmentType();
  const frameworkDirectory = await configManager.getMicrosoftPackagesPath();

  // Naming is reported for the model WRITES land in, not the one reads come
  // from — after a project switch those are different models (see
  // buildPrefixDiagnostics and ConfigManager.getWriteAnchorModel).
  const writeModel = modelWritesLandIn(configManager.getWriteAnchorModel() ?? modelName, modelName);
  const {
    lines: prefixLines, verboseLines: prefixVerboseLines, effectivePrefix,
  } = buildPrefixDiagnostics(writeModel, modelName);
  const objectSuffixEnv = process.env.EXTENSION_SUFFIX?.trim() || null;
  const effectiveSuffix = getObjectSuffix();

  const PLACEHOLDER_NAMES = new Set([
    'mymodel', 'mypackage', 'model', 'package', 'modelname', 'packagename',
    'yourmodel', 'yourpackage', 'custommodel', 'custompackage',
    'testmodel', 'testpackage', 'samplemodel', 'samplepackage',
    // Microsoft tutorial/demo models shipped with D365FO — never a valid target model.
    'fleetmanagement', 'fleetmanagementextension',
    'fleetmanagementunittests', 'tutorial',
  ]);
  const isPlaceholder = !modelName || PLACEHOLDER_NAMES.has(modelName.toLowerCase());
  // The "Microsoft standard model" warning only applies to an auto-detected model —
  // an explicitly configured model was named deliberately and shouldn't be second-guessed.
  const isAutoDetectedSource = isModelSourceAutoDetected;
  const isStandardMsModel = modelName
    ? !isCustomModel(modelName) && !isPlaceholder && isAutoDetectedSource
    : false;

  // Effective custom write root: D365FO_CUSTOM_PACKAGES_PATH > D365FO_PACKAGE_PATH (read-only MS root).
  const effectiveWritePath = customPackagesPath ?? packagePath;
  const effectiveWriteSource = customPackagesPath ? customPackagesSource : packageSource;

  // MS framework path shown in diagnostics; omitted for single-root traditional setups.
  const msFrameworkPath = frameworkDirectory ?? (!customPackagesPath ? null : packagePath);

  // get_workspace_info is called at the start of every session, so every
  // line here is paid for on a cold context. The default output carries
  // only what changes what the agent does next — identity, where writes
  // land, the naming it must apply, and anything that is actually wrong.
  // Sources, confirmations and the per-project path table are diagnostics.
  const diagnostics = args.diagnostics === true;

  const lines: string[] = diagnostics
    ? [
        `## D365FO Workspace Configuration`,
        ``,
        `Model name      : ${modelName ?? '(not configured)'}  (source: ${modelSource})`,
        `Custom write path: ${effectiveWritePath ?? '(not configured)'}  (custom metadata, source: ${effectiveWriteSource})`,
        `Framework dir   : ${msFrameworkPath ?? '(not applicable — single-root setup)'}  (Microsoft metadata, read-only)`,
        `Project path    : ${projectPath ?? '(not detected)'}  (source: ${projectSource})`,
        `Env type        : ${envType}`,
        ``,
        ...prefixVerboseLines,
      ]
    : [
        `## D365FO Workspace`,
        ``,
        `Model       : ${modelName ?? '(not configured)'}  (${modelSource})`,
        ...prefixLines,
        `Write path  : ${effectiveWritePath ?? '(not configured)'}`,
        `Project     : ${projectPath ?? '(not detected)'}`,
        `Env         : ${envType}`,
      ];

  if (diagnostics) {
    lines.push(
      `## Suffix Configuration`,
      ``,
      `EXTENSION_SUFFIX: ${objectSuffixEnv ?? '(not set)'}`,
      `Effective suffix: ${effectiveSuffix || '(none)'}`,
      effectiveSuffix
        ? `✅ EXTENSION_SUFFIX is set — new objects will have suffix "${effectiveSuffix}" appended (e.g. MyTable${effectiveSuffix}).`
        : `ℹ️  EXTENSION_SUFFIX is not set. No suffix will be applied. This is normal — most projects use prefixes only.`,
      ``,
    );
  } else if (effectiveSuffix) {
    lines.push(`Suffix      : "${effectiveSuffix}" appended to new objects (EXTENSION_SUFFIX)`);
  }

  // Extension naming: prefix is the infix unless EXTENSION_NAMING_STYLE="model-name"
  // (embeds the model name instead, VS default). Tool always normalises the token —
  // pass the BASE object name and let the tool name it.
  const extNamingStyle = getExtensionNamingStyle();
  // Against the WRITE model, for both reasons: these samples are names a
  // write would produce, and passing the model lets the infix come from the
  // extensions that model already has ("…DEMOExtension") instead of being
  // derived from the prefix ("…DemoExtension").
  const extInfix = deriveExtensionInfix(effectivePrefix, writeModel ?? undefined);
  const sampleClassExt = extNamingStyle === 'model-name' && writeModel
    ? `CustTable_${writeModel}_Extension`
    : `CustTable${extInfix}_Extension`;
  const sampleElemExt = extNamingStyle === 'model-name' && writeModel
    ? `CustTable.${writeModel}`
    : `CustTable.${extInfix}Extension`;
  if (diagnostics) {
    lines.push(
      `## Extension Naming`,
      ``,
      `EXTENSION_NAMING_STYLE: ${process.env.EXTENSION_NAMING_STYLE?.trim() || '(not set → "prefix")'}`,
      extNamingStyle === 'model-name'
        ? `✅ model-name style — extension token is the MODEL NAME (Visual Studio default).`
        : `ℹ️  prefix style (default) — extension token is the EXTENSION_PREFIX infix.`,
      `  • Extension class  → ${sampleClassExt}`,
      `  • Element extension → ${sampleElemExt}`,
      `  ⚠️  Pass the BASE object name (e.g. "CustTable") to d365fo_file(action="create") and let the tool apply the token — any infix you embed will be normalised to the above.`,
      ``,
    );
  } else {
    // The samples ARE the instruction: the style name and the token rule
    // add nothing once the two produced names are in front of the agent.
    lines.push(
      `Extensions  : ${sampleClassExt} · ${sampleElemExt}  ` +
      `(pass the BASE name to d365fo_file(create) — the tool applies the token)`,
    );
  }

  const allProjects = configManager.getAllDetectedProjects();
  if (allProjects.length > 1) {
    if (diagnostics) {
      lines.push(``);
      lines.push(`## Available Projects`);
      lines.push(``);
      for (const p of allProjects) {
        const active = p.projectPath === projectPath ? '▶ ' : '  ';
        lines.push(`${active}${p.modelName.padEnd(40)} ${p.projectPath}`);
      }
      lines.push(``);
      lines.push(`To switch project: call get_workspace_info with projectName = "<ModelName>"`);
    } else {
      // Names only: a switch is by projectName, so the paths are dead
      // weight — and one solution can hold dozens of them. Duplicated
      // model names (several projects, one model) collapse to one entry.
      const seen = new Set<string>();
      const names: string[] = [];
      for (const p of allProjects) {
        const key = p.modelName.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        names.push(p.projectPath === projectPath ? `▶${p.modelName}` : p.modelName);
      }
      const shown = names.slice(0, PROJECT_NAMES_SHOWN);
      const rest = names.length - shown.length;
      lines.push(
        `Projects    : ${shown.join(', ')}${rest > 0 ? `, +${rest} more` : ''}  ` +
        `(switch: get_workspace_info(projectName="<ModelName>"))`,
      );
    }
  }

  // Index freshness — compare workspace mtimes vs last_indexed_at.
  try {
    const lastIndexedAt = context.symbolIndex.getLastIndexedAt?.() ?? null;
    const modelMetadataDir = effectiveWritePath && modelName
      ? nodePath.join(effectiveWritePath, modelName)
      : null;
    const staleness = checkIndexStaleness(lastIndexedAt, modelMetadataDir);
    lines.push(...(diagnostics ? ['', ...staleness.lines] : staleness.compactLines));
  } catch {
    // Freshness reporting is best-effort — never break get_workspace_info
  }

  // Stdio session info — what VS 2022 sent during the MCP handshake. Debugging aid only.
  if (diagnostics) {
  const sio = getStdioSessionInfo();
  lines.push(``);
  lines.push(`## Stdio Session Info`);
  lines.push(``);
  if (!sio.initializedAt) {
    lines.push(`_Not in stdio mode (or initialize not yet received)._`);
  } else {
    lines.push(`Client name     : ${sio.clientName    ?? '(not sent)'}`);
    lines.push(`Client version  : ${sio.clientVersion ?? '(not sent)'}`);
    lines.push(`MCP protocol    : ${sio.protocolVersion ?? '(not sent)'}`);
    lines.push(`Roots listChanged cap: ${sio.supportsRootsListChanged ? 'yes ✅' : 'no ❌'}`);
    lines.push(`Initialize at   : ${sio.initializedAt}`);
    lines.push(``);
    if (sio.lastRoots.length === 0) {
      lines.push(`Roots (last roots/list): _none received yet_`);
    } else {
      lines.push(`Roots (last roots/list) @ ${sio.rootsLastAt}:`);
      sio.lastRoots.forEach((u, i) => lines.push(`  [${i}] ${u}`));
    }
    lines.push(``);
    if (sio.rootsListChangedCount === 0) {
      lines.push(`roots/list_changed events: 0 (VS 2022 has NOT changed solution since startup)`);
      if (sio.supportsRootsListChanged) {
        lines.push(`  ℹ️  Client declared roots.listChanged=true — it WILL send this notification`);
        lines.push(`     when you open/switch a solution. Switch now and call get_workspace_info again.`);
      } else {
        lines.push(`  ⚠️  Client did NOT declare roots.listChanged capability — automatic`);
        lines.push(`     solution-switch detection may not be available.`);
      }
    } else {
      lines.push(`roots/list_changed events: ${sio.rootsListChangedCount} ✅`);
      lines.push(`Last change at  : ${sio.rootsListChangedLastAt}`);
      lines.push(`✅ VS 2022 IS sending roots/list_changed — solution switching IS detectable.`);
    }
  }
  }

  // Context Snapshot — recently edited objects + uncommitted X++ changes. Best-effort.
  try {
    const snapshot = await buildContextSnapshot(context);
    lines.push(...(diagnostics
      ? ['', ...renderContextSnapshotSection(snapshot)]
      : renderContextSnapshotCompact(snapshot)));
  } catch {
    // Snapshot is additive — omit silently on failure.
  }

  // Everything below is a broken/unusual state. It sits last so the facts
  // above stay one uninterrupted block in the normal case, and so the
  // instruction the agent must act on is the last thing it reads.

  // A switch moves which project is ACTIVE — nothing else. Reads never
  // needed it (they span every model regardless) and writes stay anchored
  // to the model the workspace resolved on its own, so switching cannot be
  // used to reach an object the cross-model guard refused. Say both here,
  // before anything is written, so the switch is not mistaken for access.
  const toolSwitch = configManager.getToolProjectSwitch();
  if (toolSwitch) {
    lines.push(
      ``,
      `## ⚠️  Project switched — writes are NOT switched`,
      ``,
      `"${toolSwitch.forcedModel}" is now the ACTIVE project. This did not change what you ` +
      `can read: get_object_info, search and find_references span every model, switched or ` +
      `not, so a switch is never needed to look at another model's code. Writes stay ` +
      `anchored to "${toolSwitch.anchorModel}" — the model the open workspace targets — and ` +
      `a create/modify into "${toolSwitch.forcedModel}" will be refused.`,
      `Tell the user the model they asked about is owned by "${toolSwitch.forcedModel}" and let ` +
      `THEM decide: extend it from "${toolSwitch.anchorModel}", or allow the write by adding ` +
      `D365FO_CROSS_MODEL_WRITE_MODELS=${toolSwitch.forcedModel} to the server's .env — that ` +
      `applies to the next attempt, no restart. Do not decide this on your own.`,
    );
  }

  if (isPlaceholder) {
    const rawDetectedModel = await configManager.getRawAutoDetectedModelName();
    const detectedHint = rawDetectedModel
      ? `> ✅ Auto-detected from .rnrproj: **${rawDetectedModel}**\n` +
        `> Update your .mcp.json: set \`modelName\` to \`"${rawDetectedModel}"\``
      : `> ⚠️ No .rnrproj was found — make sure the MCP server is running in the right directory.`;
    lines.push(
      ``,
      `⛔ CONFIGURATION PROBLEM — model name "${modelName}" is a placeholder, not a real D365FO model.`,
      ``,
      `**YOU MUST STOP** and tell the user:`,
      `> The configured model name "${modelName}" is a placeholder.`,
      detectedHint,
      `>`,
      `> Please check that:`,
      `> 1. The MCP server is running in the correct workspace directory`,
      `> 2. The .mcp.json / mcp.json file has the correct modelName`,
      `> 3. The projectPath points to a valid .rnrproj file`,
      `>`,
      `> Do you want to fix the configuration first, or continue with built-in tools (limited functionality)?`,
    );
  } else if (isStandardMsModel) {
    const customCandidates = allProjects.filter(p => isCustomModel(p.modelName));
    const hint = customCandidates.length > 0
      ? `Available custom models: ${customCandidates.map(p => p.modelName).join(', ')}\n` +
        `Switch with: get_workspace_info(projectName="<model>")`
      : `No custom models found under D365FO_SOLUTIONS_PATH. Check your project configuration.`;
    lines.push(
      ``,
      `⛔ CONFIGURATION PROBLEM — model name "${modelName}" is a Microsoft standard/demo model, not a custom model.`,
      ``,
      `**YOU MUST STOP** and tell the user:`,
      `> The auto-detected model "${modelName}" is a Microsoft standard model.`,
      `> This usually happens when a new VS project was created and the default model`,
      `> in the project wizard ("FleetManagement") was not changed to the correct custom model.`,
      `>`,
      `> How to fix:`,
      `> 1. In Visual Studio, open the .rnrproj file and change <Model>FleetManagement</Model>`,
      `>    to the correct model name (e.g. <Model>ContosoCore</Model>).`,
      `> 2. OR explicitly switch to a known project:`,
      `>    ${hint}`,
      `> 3. OR add the correct modelName to .mcp.json.`,
    );
  } else if (diagnostics) {
    lines.push(``, `✅ Configuration looks valid. Proceed with D365FO operations using model "${modelName}".`);
  }

  return { content: [{ type: 'text', text: lines.join('\n') }] };
}
