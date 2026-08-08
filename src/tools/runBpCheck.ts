import { execFile } from 'child_process';
import util from 'util';
import path from 'path';
import fs from 'fs/promises';
import { getConfigManager } from '../utils/configManager.js';
import { defaultPackagesRoot, findPackagesRoot } from '../utils/packagesRoot.js';
import { withOperationLock } from '../utils/operationLocks.js';
import { lookupSymbolsNocase, type DbLike } from '../utils/symbolLookup.js';
import { compileModelLabels } from './compileLabels.js';

const execFileAsync = util.promisify(execFile);

// Label compilation is a precondition for the checker, not a separate concern —
// see compileLabels.ts for why an uncompiled label reads as a source defect.

// Keyword that xppbp.exe prints when it doesn't recognise the arguments
const HELP_TEXT_PATTERN = /^usage:|BPCheck Tool|^xppbp\.exe|unrecognized|missing required|X\+\+ Best Practice Options/im;

// Lines that carry an actual finding — never folded into the shared preamble.
const FINDING_LINE_PATTERN = /BPError|BPWarning|<Diagnostic|BestPractices (Warning|Error):/i;

/**
 * Symbol-index type → xppbp element-type token, used when the caller omits the
 * type (#828). A class extension is an AxClass file carrying [ExtensionOf], so
 * it checks as `class`; the remaining Ax*Extension kinds use the concatenated
 * AOT spelling. Index types with no xppbp equivalent are deliberately absent —
 * an unmapped name errors instead of being guessed at.
 */
const INDEX_TYPE_TO_ELEMENT_TYPE: Record<string, string> = {
  class:             'class',
  'class-extension': 'class',
  table:             'table',
  'table-extension': 'tableextension',
  form:              'form',
  'form-extension':  'formextension',
  enum:              'enum',
  'enum-extension':  'enumextension',
  edt:               'edt',
  'edt-extension':   'edtextension',
  view:              'view',
  query:             'query',
  map:               'map',
  report:            'report',
  menu:              'menu',
  service:           'service',
  macro:             'macro',
};

const RESOLVABLE_INDEX_TYPES = Object.keys(INDEX_TYPE_TO_ELEMENT_TYPE);

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

/** One object as the caller asked for it — the type may still be missing. */
export interface RequestedTarget {
  name: string;
  /** Explicit element type, when the caller supplied one. */
  type?: string;
}

/**
 * Normalize the two accepted call shapes into one list: the batch form
 * `objects: [{objectType, objectName}]` (mirrors verify_d365fo_project) and the
 * original single-target `targetElementType` + `targetFilter`. A bare string is
 * accepted wherever an object entry is — `objects: "MyClass"` and
 * `objects: ["MyClass"]` both mean a one-element list.
 */
export function normalizeTargets(params: any): RequestedTarget[] {
  const raw = Array.isArray(params?.objects)
    ? params.objects
    : params?.objects
    ? [params.objects]
    : [];

  const targets: RequestedTarget[] = [];
  for (const entry of raw) {
    if (typeof entry === 'string') {
      if (entry.trim()) targets.push({ name: entry.trim() });
    } else if (entry && typeof entry === 'object' && typeof entry.objectName === 'string' && entry.objectName.trim()) {
      const type = typeof entry.objectType === 'string' && entry.objectType.trim()
        ? entry.objectType.trim()
        : undefined;
      targets.push({ name: entry.objectName.trim(), type });
    }
  }

  if (targets.length === 0 && typeof params?.targetFilter === 'string' && params.targetFilter.trim()) {
    const type = typeof params?.targetElementType === 'string' && params.targetElementType.trim()
      ? params.targetElementType.trim()
      : undefined;
    targets.push({ name: params.targetFilter.trim(), type });
  }
  return targets;
}

/**
 * Element type for a name the caller did not type, looked up in the symbol
 * index. `run_bp_check` used to fall back to `class`, which silently checked
 * the wrong element kind and cost a round trip (#828) — an ambiguous or
 * unknown name now errors instead.
 */
export function resolveElementType(
  name: string,
  db: DbLike | undefined,
): { elementType?: string; error?: string } {
  if (!db) {
    return {
      error:
        `Cannot determine the element type of "${name}" — the symbol index is not available here.\n` +
        `Pass the type explicitly, e.g. { objects: [{ objectType: "table", objectName: "${name}" }] }.`,
    };
  }

  let hits: Array<{ type: string }> = [];
  try {
    hits = lookupSymbolsNocase(db, name, { types: RESOLVABLE_INDEX_TYPES, limit: 5 });
  } catch {
    /* index unusable — treated the same as "not found" below */
  }

  const elementTypes = [...new Set(hits.map(h => INDEX_TYPE_TO_ELEMENT_TYPE[h.type]).filter(Boolean))];
  if (elementTypes.length === 1) return { elementType: elementTypes[0] };

  if (elementTypes.length > 1) {
    return {
      error:
        `"${name}" is ambiguous — the index has it as ${elementTypes.join(' and ')}.\n` +
        `Say which one, e.g. { objects: [{ objectType: "${elementTypes[0]}", objectName: "${name}" }] }.`,
    };
  }
  return {
    error:
      `Cannot determine the element type of "${name}" — no object of a checkable type is indexed under that name.\n` +
      `Pass the type explicitly, e.g. { objects: [{ objectType: "table", objectName: "${name}" }] }, ` +
      `or run update_symbol_index if the object is new.`,
  };
}

/**
 * Split the preamble xppbp repeats on every invocation (banner, memory counter,
 * enabled-rules list) off the front of a batch's outputs, so it can be printed
 * once instead of once per object (#828). Lines are compared with digits
 * masked, because the memory counter differs by a megabyte between runs.
 * A single output has nothing to share and is returned untouched.
 */
export function splitSharedPreamble(outputs: string[]): { preamble: string[]; bodies: string[][] } {
  const lineSets = outputs.map(o => o.split(/\r?\n/));
  if (lineSets.length < 2) return { preamble: [], bodies: lineSets };

  const shape = (line: string) => line.replace(/\d+/g, '#').trimEnd();
  const preamble: string[] = [];
  let i = 0;
  scan: while (true) {
    const first = lineSets[0][i];
    if (first === undefined || FINDING_LINE_PATTERN.test(first)) break;
    const key = shape(first);
    for (const lines of lineSets) {
      if (lines[i] === undefined || shape(lines[i]) !== key) break scan;
    }
    preamble.push(first);
    i++;
  }
  return { preamble, bodies: lineSets.map(lines => lines.slice(i)) };
}

export const runBpCheckTool = async (params: any, context: any) => {
  try {
    const requested = normalizeTargets(params);
    if (params?.objects !== undefined && requested.length === 0) {
      return {
        content: [{ type: 'text', text: '❌ `objects` was supplied but contained no usable entry.\n\nEach entry needs an `objectName`, e.g. { objects: [{ objectType: "table", objectName: "MyTable" }] }.' }],
        isError: true
      };
    }

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
    // (.mcp.json overrides, then XPP auto-detection); (3) drive scan for AosService (CHE).
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
      microsoftPackagesPath = findPackagesRoot();
    }

    if (!customPackagesPath && microsoftPackagesPath) customPackagesPath = microsoftPackagesPath;

    // packagesRoot priority: explicit param → microsoft path → custom path → legacy env var → detected default
    const packagesRoot = params.packagePath
      || microsoftPackagesPath
      || customPackagesPath
      || configManager.getPackagePath()
      || defaultPackagesRoot();

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

    // Every requested object needs a concrete element type before anything runs —
    // a partially resolvable batch is reported as one error, not half-checked.
    let db: DbLike | undefined;
    try {
      db = context?.symbolIndex?.getReadDb?.();
    } catch {
      /* index unavailable — resolveElementType says so instead of guessing */
    }
    const targets: Array<{ name: string; elementType: string }> = [];
    const resolveErrors: string[] = [];
    for (const t of requested) {
      if (t.type) {
        targets.push({ name: t.name, elementType: t.type.toLowerCase() });
        continue;
      }
      const { elementType, error } = resolveElementType(t.name, db);
      if (elementType) targets.push({ name: t.name, elementType });
      else resolveErrors.push(error!);
    }
    if (resolveErrors.length > 0) {
      return {
        content: [{ type: 'text', text: `❌ ${resolveErrors.join('\n\n')}` }],
        isError: true
      };
    }

    // metadataPath: X++ source XML (custom model metadata). compilerMetadataPath: compiled
    // binaries + framework metadata (UDE: Microsoft packages root; CHE: same as metadataPath).
    const metadataPath = customPackagesPath || packagesRoot;
    const compilerMetadataPath = microsoftPackagesPath || packagesRoot;

    // xppbp resolves @Model:Id against the compiled label assembly, so labels
    // that exist only as text in AxLabelFile are reported as BPErrorUnknownLabel
    // (with BPUnusedStrFmtArgument cascading from them). A BP check can be run
    // without a build in between — recompile stale labels here too, otherwise
    // creating a label and checking it immediately still produces the bogus
    // errors this costs about a second to prevent. Batch runs pay it once.
    const labelResult = await compileModelLabels(compilerMetadataPath, metadataPath, modelName);
    if (!labelResult.success) {
      console.error(`[run_bp_check] label compilation failed: ${labelResult.message}`);
    }
    const labelNote = labelResult.success
      ? ''
      : `\n⚠️ Labels could not be compiled (${labelResult.message}) — any BPErrorUnknownLabel ` +
        `below may be an artefact of that, not of the source.\n`;

    /**
     * xppbp.exe CLI flag styles vary by version — tried in order (A → B → C), stopping at
     * the first that doesn't return help text: A) colon separator (older), B) equals
     * separator with positional "type:Name" filter (10.0.24+), C) -packagesRoot fallback
     * when -compilerMetadata is not recognized.
     */

    /** Positional element selector, or `-all` for a whole-model run. */
    const selector = (target: { name: string; elementType: string } | null): string =>
      target ? `${target.elementType}:${target.name}` : '-all';

    // Style A — colon separator with -compilerMetadata
    //
    // #25: `-all` means "check the whole model" and xppbp does NOT recognise
    // `-filter:` — so this style silently ignored the requested scope (a run
    // filtered to one class returned warnings for two unrelated table elements).
    // With a target we therefore drop `-all` and append the positional
    // `<type>:<Name>` element selector this xppbp understands.
    const buildArgsColonStyle = (
      metadataFlag: string,
      compilerMetadataFlag: string,
      target: { name: string; elementType: string } | null,
    ): string[] => [
      `${metadataFlag}${metadataPath}`,
      `-module:${modelName}`,
      `-model:${modelName}`,
      `${compilerMetadataFlag}${compilerMetadataPath}`,
      selector(target),
    ];

    // Style B — equals separator (xppbp 10.0.24+: positional "<type>:<Name>" filter, no leading dash)
    const buildArgsEqStyle = (
      { compilerMetadata }: { compilerMetadata: boolean },
      target: { name: string; elementType: string } | null,
    ): string[] => [
      `-metadata=${metadataPath}`,
      `-module=${modelName}`,
      `-model=${modelName}`,
      // -compilerMetadata= is the newer flag; fall back to -packagesRoot= for older xppbp
      compilerMetadata ? `-compilerMetadata=${compilerMetadataPath}` : `-packagesRoot=${compilerMetadataPath}`,
      // `-all` is mutually exclusive with the positional filter: passing both
      // checks the whole model (#25).
      selector(target),
    ];

    // Style C — fallback when -compilerMetadata is not recognized
    const buildArgsFallbackStyle = (target: { name: string; elementType: string } | null): string[] => [
      `-metadata:${metadataPath}`,
      `-packagesRoot:${compilerMetadataPath}`,
      `-module:${modelName}`,
      `-model:${modelName}`,
      selector(target),
    ];

    const styles: Array<{ label: string; build: (t: { name: string; elementType: string } | null) => string[] }> = [
      { label: '-compilerMetadata: colon',        build: t => buildArgsColonStyle('-metadata:', '-compilerMetadata:', t) },
      { label: '-compilerMetadata= equals',       build: t => buildArgsEqStyle({ compilerMetadata: true }, t) },
      { label: '-packagesRoot= equals fallback',  build: t => buildArgsEqStyle({ compilerMetadata: false }, t) },
      { label: '-packagesRoot: colon fallback',   build: t => buildArgsFallbackStyle(t) },
    ];

    // One entry per object; `null` is the unfiltered whole-model run.
    const runTargets: Array<{ name: string; elementType: string } | null> = targets.length > 0 ? targets : [null];

    const combinedByTarget = await withOperationLock(
      `bp:${modelName}`,
      async () => {
        // The flag style is a property of the installed xppbp, not of the object:
        // once one works, later objects in the batch start from it instead of
        // paying the fallback chain again.
        let preferredStyle = 0;
        const outputs: string[] = [];

        for (const target of runTargets) {
          let combined = '';
          for (let i = preferredStyle; i < styles.length; i++) {
            const args = styles[i].build(target);
            console.error(`[run_bp_check] Attempt ${i + 1} (${styles[i].label}) for ${selector(target)}: "${xppbpPath}" ${args.join(' ')}`);
            let stdout = '';
            let stderr = '';
            try {
              ({ stdout, stderr } = await tryXppbp(xppbpPath, args));
            } catch (e: any) {
              stdout = e.stdout ?? '';
              stderr = e.stderr ?? '';
            }
            combined = [stdout, stderr].filter(Boolean).join('\n').trim();
            if (!HELP_TEXT_PATTERN.test(combined) && combined !== '') {
              preferredStyle = i;
              break;
            }
          }
          outputs.push(combined);
        }

        return outputs;
      },
    );

    // If the first target still shows help text, no flag style works on this
    // xppbp at all — report that once rather than per object.
    if (HELP_TEXT_PATTERN.test(combinedByTarget[0])) {
      return {
        content: [{
          type: 'text',
          text: `❌ xppbp.exe returned its help text for all four flag-style attempts (-compilerMetadata:, -compilerMetadata=, -packagesRoot= with equals, -packagesRoot: with colon).\n\nThis usually means the installed xppbp.exe version uses an unrecognised CLI format.\n\nRaw output:\n\n${combinedByTarget[0]}`
        }],
        isError: true
      };
    }

    // xppbp emits either "BPError..."/XML <Diagnostic severity="error"> or
    // "BestPractices Warning/Error: ..." — both count as a violation.
    const hasIssues = (output: string) =>
      /BPError|<Diagnostic|severity="error"|BestPractices (Warning|Error):/i.test(output)
      || /severity\s*[:=]\s*error/i.test(output)
      || /^Warnings:\s*[1-9]/m.test(output)
      || /^Errors:\s*[1-9]/m.test(output);

    const header = `Model: ${modelName}` + (resolvedProjectPath ? `\nProject: ${resolvedProjectPath}` : '');

    // Single target (and the whole-model run) keep the original layout — there
    // is no preamble to share and existing callers read this shape.
    if (runTargets.length === 1) {
      const combined = combinedByTarget[0];
      const target = runTargets[0];
      // #25: report honestly whether the requested scope actually took effect —
      // attribution used to require reading rule names and guessing.
      const scopeNote = target ? describeScope(target.name, combined) : '';
      return {
        content: [{
          type: 'text',
          text: `${hasIssues(combined) ? '⚠️ BP Check completed with issues' : '✅ BP Check passed'}\n\n${header}` +
            (target ? `\nFilter: ${selector(target)}` : '') +
            scopeNote +
            labelNote +
            `\n\n${combined || '(no output)'}`
        }]
      };
    }

    // Batch: one preamble, findings grouped per object (#828).
    const { preamble, bodies } = splitSharedPreamble(combinedByTarget);
    const issueCount = combinedByTarget.filter(hasIssues).length;

    const groups = runTargets.map((target, i) => {
      const combined = combinedByTarget[i];
      const body = bodies[i].join('\n').trim();
      return (
        `── ${selector(target)} ── ${hasIssues(combined) ? '⚠️ issues' : '✅ clean'}` +
        (target ? describeScope(target.name, combined) : '') +
        `\n${body || '(no findings)'}`
      );
    });

    return {
      content: [{
        type: 'text',
        text: `${issueCount > 0 ? '⚠️ BP Check completed with issues' : '✅ BP Check passed'} — ` +
          `${runTargets.length} objects checked, ${issueCount} with findings\n\n${header}` +
          labelNote +
          (preamble.length > 0
            ? `\n\nShared xppbp preamble (identical for all ${runTargets.length} objects, shown once):\n${preamble.join('\n').trim()}`
            : '') +
          `\n\n${groups.join('\n\n')}`
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
