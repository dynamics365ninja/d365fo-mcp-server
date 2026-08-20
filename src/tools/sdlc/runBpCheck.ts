import { execFile } from 'child_process';
import util from 'util';
import path from 'path';
import fs from 'fs/promises';
import { getConfigManager } from '../../utils/configManager.js';
import { defaultPackagesRoot, findPackagesRoot } from '../../utils/packagesRoot.js';
import { withOperationLock } from '../../utils/operationLocks.js';
import { lookupSymbolsNocase, lookupSymbolNocase, type DbLike } from '../../utils/symbolLookup.js';
import { compileModelLabels } from '../write/compileLabels.js';
import { buildFreshness, type BuildFreshnessStatus } from '../../utils/buildMarker.js';
import { validateMoniker, BP_MONIKER_CATALOG } from '../../knowledge/bpMonikers/index.js';

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

/**
 * The verdict line for a run that found nothing, given what has compiled the model.
 *
 * "✅ BP Check passed" is the line a caller reads and acts on, and it said that
 * even when nothing had ever compiled the model — the caveat went on the line
 * below, where it contradicted a green tick that had already been believed.
 * Benchmark run 7b8de4ba spent 54 s on a check that answered "✅ BP Check passed
 * — 3 objects checked, 0 with findings" directly above "⚠️ Not compiled", and
 * then met two build failures. A verdict that depends on the next line being
 * read is not a verdict; when the state is known to be uncompiled, the tick does
 * not belong on it.
 *
 * The check itself still runs and still reports — xppbp findings are real
 * without a build, and refusing would throw away the half that works. What
 * changes is only the claim made about them.
 *
 * Unknown freshness (no dataDir, so no marker to read) stays green: nothing has
 * been learned that would justify a warning, and inventing one would train the
 * caller to ignore it.
 */
function passVerdict(status?: BuildFreshnessStatus): string {
  if (status === 'never') return '⚠️ BP clean, NOT compiled';
  if (status === 'stale') return '⚠️ BP clean, build is STALE';
  return '✅ BP Check passed';
}

/**
 * Translate a caller-supplied objectType into the token xppbp accepts.
 *
 * The map above existed but was only consulted when the caller OMITTED the
 * type; a supplied one was passed through `.toLowerCase()`. So the kebab-case
 * spelling every other tool in this server takes — `objectType:
 * "table-extension"`, exactly as verify_d365fo_project documents it — reached
 * xppbp verbatim and was rejected with "The element type 'table-extension' is
 * invalid". Same vocabulary, two tools, one of them wrong.
 *
 * Anything already in xppbp's own spelling ("TableExtension") still works: it
 * squashes to the same token.
 */
export function normalizeElementType(raw: string): string {
  const kebab = raw.trim().toLowerCase();
  const mapped = INDEX_TYPE_TO_ELEMENT_TYPE[kebab];
  if (mapped) return mapped;
  return kebab.replace(/[-_\s]/g, '');
}

/**
 * xppbp's "I did not run" responses, as a sentence — or '' when it ran.
 *
 * A rejected element type makes xppbp print a complaint and no findings, and
 * "no findings" is indistinguishable from a clean object unless something looks
 * for the complaint. It did not, so a check that never executed was reported as
 * `✅ clean`, which is the one BP outcome worse than a failure: it is a pass the
 * caller will act on.
 */
export function describeNonRun(output: string, targetName?: string): string {
  const invalidType = output.match(/The element type '([^']*)' is invalid/i);
  if (invalidType) {
    return `xppbp rejected the element type "${invalidType[1]}", so no rules were evaluated for this object. ` +
      `Use the kebab-case objectType the other tools take (e.g. "table-extension") and it will be translated.`;
  }
  if (/\b0 elements processed\b/i.test(output)) {
    return `xppbp processed 0 elements — the filter matched nothing, so this result is not evidence of a clean object.`;
  }
  // When xppbp cannot find an element's compiler metadata it still runs the metadata-only
  // rules and reports nothing for the rest — so a checked object can come back with no
  // findings from rules that never looked at its X++ at all. Only the requested object is
  // judged here: a module-wide run routinely carries this warning for unrelated elements
  // (e.g. extensions of a class the environment does not have installed).
  if (targetName && uncompiledElements(output).some(n => n.toLowerCase() === targetName.toLowerCase())) {
    return `xppbp found no compiled metadata for "${targetName}" (CompilerMetadataMissing), so every rule that reads compiled X++ was skipped — ` +
      `only the metadata-only rules ran. Build the model and check again. If it was just built successfully, then the -compilerMetadata root ` +
      `xppbp was given is not the root the build wrote its XppMetadata to.`;
  }
  return '';
}

/** Elements xppbp reported as not compiled (its CompilerMetadataMissing warning). */
export function uncompiledElements(output: string): string[] {
  const names = new Set<string>();
  for (const m of output.matchAll(/The element '([A-Za-z0-9_]+)'[^\n]*appears not to have been compiled/gi)) {
    names.add(m[1]);
  }
  return [...names];
}

// Tool registration (name, description, inputSchema) lives in
// src/server/toolSchemas/runBpCheck.ts — the single source of truth for tool
// instructions. It is NOT in mcpServer.ts; that file only spreads the
// aggregated toolSchemas array into the ListTools response.

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

export interface ParsedBpFinding {
  /**
   * The rule name, or null when the line only carried a severity prefix
   * ('BPError: …') and never named the rule — see BARE_PREFIXES below.
   */
  moniker: string | null;
  /** Whatever xppbp printed after the moniker — usually a file path, sometimes free text. */
  target: string;
  /** From the extracted catalog (src/knowledge/bpMonikers/), when the moniker is known there. */
  description: string | null;
  /** False for a moniker xppbp printed that the catalog does not recognise at all — worth a second look, not necessarily wrong. */
  knownMoniker: boolean;
}

// xppbp's plain-text mode prints one finding per line as `<Moniker>: <target>`.
//
// Two shapes appear in the real samples captured in tests/tools/runBpCheck.test.ts,
// and they are NOT the same:
//   BPErrorTableMissingFormRef: K:\Pkg\…\ConDemoTicket.xml   ← names the rule
//   BPError: LocalVariableNotUsed                            ← names only the severity
// The second is a bare severity prefix; treating its 'BPError' as a moniker
// produced a "not in the catalog — verify the spelling" flag on output the
// compiler itself had just emitted, which is the most expensive kind of false
// alarm: it invites a round trip to re-verify something already authoritative.
//
// A comment elsewhere in this file (`hasIssues`) also names a "BestPractices Warning: …"
// shape from a different xppbp verbosity/version; there is no real captured sample of it
// anywhere in this repo, so it is deliberately NOT matched here rather than guessed at —
// an unmatched real finding is a silent gap, but a wrong regex would misreport lines that
// are not findings at all.
const FINDING_LINE = /^\s*(BP[A-Za-z0-9]+)\s*:\s*(.+?)\s*$/;

// Severity/family prefixes that are not themselves monikers. Verified against
// the extracted catalog: none of these appears as a moniker in its own right.
const BARE_PREFIXES = new Set(['bperror', 'bpwarning', 'bpinfo', 'bpcheck']);

/**
 * Pull `{moniker, target}` out of every plain-text finding line in a BP check's
 * raw output, and cross-reference each moniker against the extracted catalog
 * (src/knowledge/bpMonikers/) so its real description travels with the finding
 * instead of being left as a name to look up by hand — the direct fix for a
 * moniker only ever being identifiable by eye from the raw log.
 *
 * Pure and independent of any live BP-check run — takes the same `output` text
 * this tool already produces, so it is unit-testable with no xppbp.exe needed.
 */
export function parseBpFindings(output: string): ParsedBpFinding[] {
  const findings: ParsedBpFinding[] = [];
  for (const rawLine of output.split('\n')) {
    const match = rawLine.match(FINDING_LINE);
    if (!match) continue;
    const [, name, target] = match;
    if (BARE_PREFIXES.has(name.toLowerCase())) {
      // Severity prefix only — the rule is not named on this line, so there is
      // nothing to cross-reference and nothing to flag as unrecognised.
      findings.push({ moniker: null, target, description: null, knownMoniker: false });
      continue;
    }
    const validation = validateMoniker(name);
    findings.push({
      moniker: name,
      target,
      description: validation.entry?.description ?? null,
      knownMoniker: validation.found,
    });
  }
  return findings;
}

/**
 * Findings section appended to a BP check's text output — the moniker and its
 * real description (when the catalog has one) laid out so the model never has
 * to re-derive the moniker by eyeballing the raw log below it.
 */
export function renderFindingsSection(output: string): string {
  const findings = parseBpFindings(output);
  if (findings.length === 0) return '';
  const lines = findings.map(f => {
    if (f.moniker === null) return `  • ${f.target} (rule not named on this line)`;
    const flag = f.knownMoniker ? '' : ' ⚠️ not in the extracted moniker catalog — verify the spelling';
    const desc = f.description ? ` — ${f.description}` : '';
    return `  • ${f.moniker}${desc} (${f.target})${flag}`;
  });
  return `\n\nFindings (moniker-checked against ${BP_MONIKER_CATALOG.length} known monikers):\n${lines.join('\n')}`;
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
        targets.push({ name: t.name, elementType: normalizeElementType(t.type) });
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

    // Paths for the build-freshness line below. Without them describeBuildFreshness
    // cannot compare "last built" against "last written", so it reports the newest
    // recorded success unqualified — a green verdict for objects written after it.
    // One indexed probe per target (a handful, sub-ms each) restores the ⚠️ Stale.
    const targetFiles: string[] = [];
    if (db) {
      for (const t of targets) {
        try {
          const hit = lookupSymbolNocase(db, t.name);
          if (hit?.file_path) targetFiles.push(hit.file_path);
        } catch {
          /* a missing path only costs the staleness comparison, not the run */
        }
      }
    }

    // metadataPath:         X++ source XML — the model store (UDE) or PLD (CHE).
    // frameworkPath:        Microsoft packages root — labelc.exe lives there, and it holds the
    //                       compiled binaries of the referenced Microsoft modules (-packagesRoot).
    // compilerMetadataPath: path xppbp passes to StaticRuntimeProvider and to XppMetadata lookup.
    //
    // WHY this points to the framework directory (not the model store):
    //
    // xppbp's StaticRuntimeProvider constructs static metadata paths as
    // {compilerMetadataPath}\StaticMetadata\AxView.md (used by DataEntityDuplicateLabelChecker
    // and others). Those compiled .md files are deployment artifacts that live in the framework
    // packages directory — they are never written to the source model store. Pointing
    // -compilerMetadata at the model store causes a BPFrameworkFatalException crash on every run.
    //
    // The trade-off: on UDE, PR #919 moved xppc's XppMetadata write-back to the model store, so
    // keeping -compilerMetadata on the framework directory means xppbp will report the model's
    // elements as CompilerMetadataMissing and skip rules that read compiled X++. That is a
    // warning, not a crash — the check still runs, metadata-only rules still fire, and
    // describeNonRun() below tells the caller exactly what happened and what to do.
    //
    // On CHE the two roots are the same path, so there is no trade-off there.
    const metadataPath = customPackagesPath || packagesRoot;
    const frameworkPath = microsoftPackagesPath || packagesRoot;
    const compilerMetadataPath = frameworkPath;

    // On UDE, xppbp's DataEntityDuplicateLabelChecker constructs a RuntimeMetadataProvider
    // using the -metadata path as runtimeRoot and then looks for
    // {runtimeRoot}\StaticMetadata\AxView.md. That file is a deployment artifact that only
    // exists in the FrameworkDirectory, never in the source ModelStoreFolder.
    // Fix: create an NTFS junction {metadataPath}\StaticMetadata → {frameworkPath}\StaticMetadata
    // once, so the path xppbp builds resolves to the real file. On CHE the paths are the same
    // directory and no junction is needed.
    if (metadataPath !== frameworkPath) {
      const junctionTarget = path.join(frameworkPath, 'StaticMetadata');
      const junctionLink   = path.join(metadataPath,  'StaticMetadata');
      try {
        await fs.access(junctionLink);
        // already exists — junction or real directory, either way xppbp can find the files
      } catch {
        try {
          await fs.access(junctionTarget);
          await fs.symlink(junctionTarget, junctionLink, 'junction');
          console.error(`[run_bp_check] created StaticMetadata junction: ${junctionLink} → ${junctionTarget}`);
        } catch (e: any) {
          // Non-fatal: log and continue. If the target doesn't exist the crash
          // will surface naturally; if the junction creation fails (e.g. permissions)
          // the same crash will occur with a clearer message from xppbp itself.
          console.error(`[run_bp_check] could not create StaticMetadata junction at ${junctionLink}: ${e.message}`);
        }
      }
    }

    // xppbp resolves @Model:Id against the compiled label assembly, so labels
    // that exist only as text in AxLabelFile are reported as BPErrorUnknownLabel
    // (with BPUnusedStrFmtArgument cascading from them). A BP check can be run
    // without a build in between — recompile stale labels here too, otherwise
    // creating a label and checking it immediately still produces the bogus
    // errors this costs about a second to prevent. Batch runs pay it once.
    const labelResult = await compileModelLabels(frameworkPath, metadataPath, modelName);
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
      // Referenced Microsoft modules resolve from their binaries here, so that
      // -compilerMetadata can stay on the model store where the module's own
      // XppMetadata lives. Same path as -compilerMetadata on CHE.
      `-packagesRoot:${frameworkPath}`,
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
      // -compilerMetadata= is the newer flag. When it is supported the two roots are passed
      // separately — compiler metadata from the model store, referenced binaries from the
      // framework directory. Older xppbp has only -packagesRoot, which then has to serve both;
      // the framework directory is the historical choice and stays, since no version old enough
      // to need it has been observed on a UDE split-root box.
      ...(compilerMetadata
        ? [`-compilerMetadata=${compilerMetadataPath}`, `-packagesRoot=${frameworkPath}`]
        : [`-packagesRoot=${frameworkPath}`]),
      // `-all` is mutually exclusive with the positional filter: passing both
      // checks the whole model (#25).
      selector(target),
    ];

    // Style C — fallback when -compilerMetadata is not recognized
    const buildArgsFallbackStyle = (target: { name: string; elementType: string } | null): string[] => [
      `-metadata:${metadataPath}`,
      `-packagesRoot:${frameworkPath}`,
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

    // A clean xppbp run is routinely read as "the task is done". It is not a compile:
    // run f2e7b71a shipped a CoC method that violates SYS10028 with this line reading
    // "0 with findings". Say what has actually compiled the model — for a batch and
    // for a single object alike; a one-object check is no more of a compile than a
    // three-object one, and it used to carry no caveat at all.
    const freshness = context?.symbolIndex?.dataDir
      ? buildFreshness(context.symbolIndex.dataDir, modelName, targetFiles)
      : undefined;
    const buildNote = freshness ? `\n\n${freshness.message}` : '';
    const cleanVerdict = passVerdict(freshness?.status);

    // Single target (and the whole-model run) keep the original layout — there
    // is no preamble to share and existing callers read this shape.
    if (runTargets.length === 1) {
      const combined = combinedByTarget[0];
      const target = runTargets[0];
      const notRun = describeNonRun(combined, target?.name);
      if (notRun) {
        return {
          content: [{
            type: 'text',
            text: `❌ BP Check did NOT run — nothing was verified.\n\n${header}` +
              (target ? `\nFilter: ${selector(target)}` : '') +
              `\n\n${notRun}\n\n${combined || '(no output)'}`,
          }],
          isError: true,
        };
      }
      // #25: report honestly whether the requested scope actually took effect —
      // attribution used to require reading rule names and guessing.
      const scopeNote = target ? describeScope(target.name, combined) : '';
      return {
        content: [{
          type: 'text',
          text: `${hasIssues(combined) ? '⚠️ BP Check completed with issues' : cleanVerdict}` +
            buildNote +
            `\n\n${header}` +
            (target ? `\nFilter: ${selector(target)}` : '') +
            scopeNote +
            labelNote +
            `\n\n${combined || '(no output)'}` +
            renderFindingsSection(combined)
        }]
      };
    }

    // Batch: one preamble, findings grouped per object (#828).
    const { preamble, bodies } = splitSharedPreamble(combinedByTarget);
    // Not `.map(describeNonRun)` — that would pass the array index as the target name.
    const nonRunByTarget = combinedByTarget.map((output, i) => describeNonRun(output, runTargets[i]?.name));
    const notRunCount = nonRunByTarget.filter(Boolean).length;
    const issueCount = combinedByTarget.filter((o, i) => !nonRunByTarget[i] && hasIssues(o)).length;

    const groups = runTargets.map((target, i) => {
      const combined = combinedByTarget[i];
      const body = bodies[i].join('\n').trim();
      const notRun = nonRunByTarget[i];
      if (notRun) {
        // A rejected element type produces no findings, and "no findings" used
        // to render as ✅ clean — a check that never ran, reported as a pass.
        return `── ${selector(target)} ── ❌ NOT CHECKED\n${notRun}\n${body || ''}`.trimEnd();
      }
      return (
        `── ${selector(target)} ── ${hasIssues(combined) ? '⚠️ issues' : '✅ clean'}` +
        (target ? describeScope(target.name, combined) : '') +
        `\n${body || '(no findings)'}` +
        renderFindingsSection(combined)
      );
    });

    const verdict =
      notRunCount > 0 ? `❌ BP Check incomplete — ${notRunCount} object(s) were NOT checked`
      : issueCount > 0 ? '⚠️ BP Check completed with issues'
      : cleanVerdict;

    return {
      content: [{
        type: 'text',
        text: `${verdict} — ` +
          `${runTargets.length} objects checked, ${issueCount} with findings` +
          buildNote +
          `\n\n${header}` +
          labelNote +
          (preamble.length > 0
            ? `\n\nShared xppbp preamble (identical for all ${runTargets.length} objects, shown once):\n${preamble.join('\n').trim()}`
            : '') +
          `\n\n${groups.join('\n\n')}`
      }],
      ...(notRunCount > 0 ? { isError: true } : {}),
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
