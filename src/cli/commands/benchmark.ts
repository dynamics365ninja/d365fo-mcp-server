/**
 * `d365fo-mcp benchmark …` — model × MCP benchmark (docs/BENCHMARK.md).
 *
 *   benchmark run <prompt|all>   drive the matrix headlessly through `claude -p`
 *   benchmark ingest <log>       record a run from an agent-host debug log (Copilot Chat)
 *   benchmark report             HTML + markdown report from the recorded runs
 *   benchmark list               the recorded runs, one line each
 *   benchmark prompts            the prompt catalogue
 *
 * Records live in eval/benchmark/runs/ and are committed; reports are derived
 * and are not (eval/benchmark/reports/ is ignored). The report never reads a raw
 * host log — only the records — so nothing identifying leaves the machine the
 * log was captured on.
 */
import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Command } from 'commander';
import { formatMetric } from '../../benchmark/aggregate.js';
import { buildClaudeArgs, runClaudeCode, toBenchmarkRun, type ClaudeCodeOptions, type RecordContext } from '../../benchmark/claudeCode.js';
import { loadCreditsConfig } from '../../benchmark/credits.js';
import { sessionToBenchmarkRun } from '../../benchmark/ingest.js';
import {
  pruneStaleExtensionRows,
  resolveMcpTargets,
  sandboxTargetProblems,
  staleSandboxIndexFiles,
  staleServerScripts,
  syncSymbolIndex,
  writeFilteredMcpConfig,
  type McpServerTarget,
} from '../../benchmark/mcpTarget.js';
import {
  adHocPromptSpec,
  evaluateFileChecks,
  loadPromptSpec,
  loadPromptSpecs,
  renderPrompt,
  usesPlaceholders,
  type PromptVars,
} from '../../benchmark/prompts.js';
import { renderHtml } from '../../benchmark/report/html.js';
import { renderMarkdown } from '../../benchmark/report/markdown.js';
import { buildReportModel } from '../../benchmark/report/model.js';
import {
  benchmarkPaths,
  countRunFiles,
  filterRuns,
  headCommitTime,
  loadRuns,
  serverGitSha,
  writeRun,
  type RunFilter,
} from '../../benchmark/store.js';
import {
  authoredChanges,
  buildSandbox,
  describeSandbox,
  diffSandbox,
  isBuildOutput,
  restoreSandbox,
  snapshotSandbox,
  type SandboxInfo,
  type Snapshot,
} from '../../benchmark/sandbox.js';
import type { BenchmarkRun, BuildResult, PromptSpec } from '../../benchmark/types.js';
import { VERSION } from '../../version.js';
import { isWindows, repoRoot } from '../context.js';
import { readSessionLog } from '../session/sessionLog.js';
import { p } from '../ui.js';

interface CommonOptions {
  /** Benchmark root; default eval/benchmark in the checkout. */
  dir?: string;
}

function paths(opts: CommonOptions) {
  return benchmarkPaths(path.resolve(opts.dir ?? path.join(repoRoot, 'eval', 'benchmark')));
}

function fail(message: string): void {
  p.log.error(message);
  process.exitCode = 1;
}

// ---------------------------------------------------------------- run

interface RunOptions extends CommonOptions {
  models?: string;
  variants?: string;
  repeat?: string;
  mcpConfig?: string;
  cwd?: string;
  label?: string;
  notes?: string;
  timeout?: string;
  maxTurns?: string;
  maxBudgetUsd?: string;
  permissionMode?: string;
  allowedTools?: string;
  tools?: string;
  effort?: string;
  appendSystemPromptFile?: string;
  claudeBin?: string;
  prompt?: string;
  excerpt?: boolean;
  dryRun?: boolean;
  tag?: string;
  sandbox?: string;
  sandboxModel?: string;
  mcpServers?: string;
  /** false with --no-build. */
  build?: boolean;
  allowDirtyBaseline?: boolean;
}

const DEFAULT_MODELS = 'sonnet';
const DEFAULT_TIMEOUT_S = 900;

function splitList(value: string | undefined, fallback: string): string[] {
  return (value ?? fallback).split(',').map(s => s.trim()).filter(Boolean);
}

function parseVariants(value: string | undefined): boolean[] {
  const names = splitList(value, 'mcp,plain');
  const out: boolean[] = [];
  for (const n of names) {
    if (n === 'mcp' || n === 'with') out.push(true);
    else if (n === 'plain' || n === 'without' || n === 'no-mcp') out.push(false);
    else throw new Error(`Unknown variant '${n}' — use mcp and/or plain`);
  }
  return out;
}

function optionalInt(value: string | undefined, name: string): number | null {
  if (value === undefined) return null;
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`--${name} must be a positive integer`);
  return n;
}

function optionalNumber(value: string | undefined, name: string): number | null {
  if (value === undefined) return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`--${name} must be a positive number`);
  return n;
}

/** The claude CLI as the shell finds it; .cmd on Windows because spawn without a shell cannot run a shim. */
function defaultClaudeBin(): string {
  return isWindows ? 'claude.cmd' : 'claude';
}

/** The MCP config a with-MCP cell gets: --mcp-config, else the checkout's .mcp.json, else the setup wizard's suggestion. */
function resolveMcpConfig(explicit: string | undefined, root: string): string | null {
  const candidates = explicit
    ? [path.resolve(explicit)]
    : [path.join(process.cwd(), '.mcp.json'), path.join(root, '.mcp.json')];
  return candidates.find(c => fs.existsSync(c)) ?? null;
}

/**
 * Selection: a catalogue id, `all`, or `all --tag reference` (every prompt
 * carrying the tag). A one-off --prompt beats both.
 */
function selectSpecs(promptArg: string | undefined, opts: RunOptions, dir: string): PromptSpec[] | null {
  if (opts.prompt) return [adHocPromptSpec(promptArg ?? 'ad-hoc', opts.prompt)];
  if (!promptArg) return null;
  if (promptArg !== 'all') return [loadPromptSpec(dir, promptArg)];
  const all = loadPromptSpecs(dir);
  const tags = splitList(opts.tag, '');
  return tags.length === 0 ? all : all.filter(s => tags.some(t => s.tags.includes(t)));
}

/** Everything a sandbox run needs, resolved and checked before the first cell. */
interface SandboxRun {
  info: SandboxInfo;
  vars: PromptVars;
  /** The servers the with-MCP cells get — the ones whose index is re-synced. */
  targets: McpServerTarget[];
  /** Scratch folder: the filtered MCP config, the snapshot, the build logs. */
  scratch: string;
}

/** Edit rule a workspace cell gets: the sandbox package (its cwd) and nothing else — verified to hold in dontAsk mode. */
const SANDBOX_EDIT_RULE = 'Edit(./**)';
const SANDBOX_READ_TOOLS = ['Read', 'Glob', 'Grep'];
const BUILD_TIMEOUT_MS = 20 * 60 * 1000;

export async function benchmarkRunCommand(promptArg: string | undefined, opts: RunOptions): Promise<void> {
  const bp = paths(opts);
  let specs: PromptSpec[];
  try {
    const selected = selectSpecs(promptArg, opts, bp.prompts);
    if (!selected) {
      fail('Usage: d365fo-mcp benchmark run <promptId|all> [--tag reference] [--models sonnet,opus] [--variants mcp,plain] [--repeat 3] [--sandbox <package>] …\n   or: benchmark run <id> --prompt "<text>" for a one-off prompt');
      return;
    }
    specs = selected;
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
    return;
  }
  if (specs.length === 0) {
    fail(`No prompts in ${bp.prompts}${opts.tag ? ` tagged ${opts.tag}` : ''}. Add a <id>.json there (see eval/benchmark/README.md).`);
    return;
  }

  let models: string[], variants: boolean[], repeat: number, timeoutS: number | null, maxTurns: number | null, maxBudget: number | null;
  try {
    models = splitList(opts.models, DEFAULT_MODELS);
    variants = parseVariants(opts.variants);
    repeat = optionalInt(opts.repeat, 'repeat') ?? 1;
    timeoutS = optionalInt(opts.timeout, 'timeout');
    maxTurns = optionalInt(opts.maxTurns, 'max-turns');
    maxBudget = optionalNumber(opts.maxBudgetUsd, 'max-budget-usd');
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
    return;
  }

  const writing = specs.filter(s => s.workspace);
  if (writing.length > 0 && !opts.sandbox && !opts.dryRun) {
    fail(
      `${writing.map(s => s.id).join(', ')}: ${writing.length === 1 ? 'writes' : 'write'} AOT objects, so ${writing.length === 1 ? 'it runs' : 'they run'} only with --sandbox <package folder> ` +
        '(a throwaway package such as …\\PackagesLocalDirectory\\fm-mcp: every cell starts from a snapshot of it and is scored on what it wrote).',
    );
    return;
  }
  if (opts.sandbox && opts.cwd) {
    fail('--cwd cannot be combined with --sandbox: a sandbox cell runs in the sandbox package, which is the only folder it may edit.');
    return;
  }

  const mcpConfigFile = variants.includes(true) ? resolveMcpConfig(opts.mcpConfig, repoRoot) : null;
  if (variants.includes(true) && !mcpConfigFile) {
    fail('No MCP config for the with-MCP cells. Pass --mcp-config <file> (a {"mcpServers": {...}} JSON) or put .mcp.json in the current directory.');
    return;
  }

  // ---- sandbox: validate, pick the servers, prove where they write
  let sandbox: SandboxRun | null = null;
  let mcpConfig = mcpConfigFile;
  const scratch = path.join(os.tmpdir(), 'd365fo-mcp-benchmark', `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`);
  try {
    const serverNames = splitList(opts.mcpServers, '');
    if (mcpConfigFile && serverNames.length > 0) {
      mcpConfig = path.join(scratch, 'mcp-config.json');
      writeFilteredMcpConfig(mcpConfigFile, serverNames, mcpConfig);
    }
    if (opts.sandbox) {
      const info = describeSandbox(opts.sandbox, opts.sandboxModel);
      const targets = mcpConfig ? resolveMcpTargets(mcpConfig) : [];
      if (mcpConfig && targets.length > 1 && serverNames.length === 0) {
        throw new Error(
          `${mcpConfigFile} lists ${targets.length} MCP servers (${targets.map(t => t.name).join(', ')}). ` +
            'A sandbox run gives the with-MCP cells only the ones named with --mcp-servers, so a server that writes elsewhere cannot be reached.',
        );
      }
      const problems = sandboxTargetProblems(targets, info.modelDir);
      if (problems.length > 0) throw new Error(problems.join('\n'));
      sandbox = {
        info,
        targets,
        scratch,
        vars: { model: info.model, modelDir: info.modelDir, packageDir: info.packageDir, packagesRoot: info.packagesRoot },
      };
    }
  } catch (err) {
    fs.rmSync(scratch, { recursive: true, force: true });
    fail(err instanceof Error ? err.message : String(err));
    return;
  }

  const credits = loadCreditsConfig(bp.credits);
  const sha = serverGitSha(repoRoot);
  const head = headCommitTime(repoRoot);
  const stale = mcpConfig && head ? staleServerScripts(mcpConfig, head) : [];
  const cwd = sandbox ? sandbox.info.packageDir : path.resolve(opts.cwd ?? process.cwd());
  const cells = specs.length * models.length * variants.length * repeat;
  const wantBuild = opts.build !== false;
  const timeoutFor = (spec: PromptSpec) => timeoutS ?? spec.timeoutSeconds ?? DEFAULT_TIMEOUT_S;

  p.intro(`d365fo-mcp benchmark run — ${cells} cell${cells === 1 ? '' : 's'}`);
  p.note(
    [
      `prompts     ${specs.map(s => s.id).join(', ')}`,
      `models      ${models.join(', ')}`,
      `variants    ${variants.map(v => (v ? 'with MCP' : 'without MCP')).join(', ')}`,
      `repeat      ${repeat}×`,
      `MCP config  ${mcpConfig ?? '(none needed)'}${sandbox && sandbox.targets.length ? ` — ${sandbox.targets.map(t => `${t.name} → ${t.workspacePath}`).join(', ')}` : ''}`,
      `cwd         ${cwd}`,
      sandbox
        ? `sandbox     ${sandbox.info.packageDir} (model ${sandbox.info.model}) · reset after every cell${writing.some(s => s.workspace?.build) && wantBuild ? ' · xppc build check' : ''}`
        : 'sandbox     (none — answer-only prompts)',
      `timeout     ${timeoutS ? `${timeoutS} s per cell` : `per prompt (default ${DEFAULT_TIMEOUT_S} s)`}${maxTurns ? ` · max ${maxTurns} turns` : ''}${maxBudget ? ` · max $${maxBudget}` : ''}`,
      `records →   ${bp.runs}`,
    ].join('\n'),
    'Matrix',
  );
  if (stale.length > 0) {
    p.log.warn(`${stale.join(', ')} is older than HEAD (${sha}) — the with-MCP cells would run an older server than their records claim. Run npm run build first.`);
  }

  // ---- index hygiene: rows of the sandbox model whose files are gone (left by
  // earlier runs) would feed the MCP cells phantom objects and a wrong inferred
  // prefix; the plain cells never read the index. A dry run only reports them.
  if (sandbox) {
    try {
      for (const target of sandbox.targets) {
        const files = await staleSandboxIndexFiles(target, sandbox.info.model, sandbox.info.packagesRoot);
        const extensions = await pruneStaleExtensionRows(target, sandbox.info.model, sandbox.info.modelDir, { dryRun: opts.dryRun });
        if (files.length + extensions.length === 0) continue;
        if (opts.dryRun) {
          p.log.warn(`'${target.name}' index holds ${files.length} object row(s) and ${extensions.length} extension row(s) of ${sandbox.info.model} with no file on disk — a real run removes them before the first cell.`);
          continue;
        }
        const { failed } = await syncSymbolIndex(target, files);
        if (failed.length > 0) throw new Error(`Could not remove stale index rows from '${target.name}': ${failed.slice(0, 3).join('; ')}`);
        p.log.info(
          `Index of '${target.name}': removed ${files.length} stale object file(s) and ${extensions.length} stale extension row(s) of ${sandbox.info.model}` +
            `${extensions.length ? ` (${extensions.slice(0, 8).join(', ')}${extensions.length > 8 ? ', …' : ''})` : ''}`,
        );
      }
    } catch (err) {
      fs.rmSync(scratch, { recursive: true, force: true });
      fail(err instanceof Error ? err.message : String(err));
      return;
    }
  }

  // ---- baseline: the sandbox must build clean on its own, then it is snapshotted
  let snapshot: Snapshot | null = null;
  if (sandbox && !opts.dryRun) {
    try {
      if (wantBuild && writing.some(s => s.workspace?.build)) {
        p.log.step(`Baseline build of ${sandbox.info.packageName} (xppc, full)…`);
        fs.mkdirSync(sandbox.scratch, { recursive: true });
        const base = await buildSandbox(sandbox.info, path.join(sandbox.scratch, 'baseline-xppc.log'), BUILD_TIMEOUT_MS);
        if (!base.ok) {
          const msg = `The sandbox does not build clean before any cell ran (${base.errorCount} error line(s)):\n   ${base.errors.join('\n   ')}`;
          if (!opts.allowDirtyBaseline) throw new Error(`${msg}\nEvery "builds clean" check would fail for reasons no cell caused. Fix the sandbox, or pass --allow-dirty-baseline.`);
          p.log.warn(msg);
        } else {
          p.log.success(`Baseline clean in ${formatMetric('durationMs', base.durationMs)}`);
        }
      }
      snapshot = snapshotSandbox(sandbox.info.packageDir, path.join(sandbox.scratch, 'snapshot'));
      p.log.info(`Snapshot of ${snapshot.manifest.size} files → ${snapshot.dir}\n   (an interrupted run leaves the sandbox as the last cell left it; copy this folder back over it)`);
    } catch (err) {
      // Nothing ran and no snapshot exists that a manual restore would need.
      fs.rmSync(scratch, { recursive: true, force: true });
      fail(err instanceof Error ? err.message : String(err));
      return;
    }
  }

  // Repeats on the outside so a slow afternoon hits every cell, not one model.
  let done = 0, failed = 0;
  const started = Date.now();
  for (let rep = 0; rep < repeat; rep++) {
    for (const spec of specs) {
      const promptText = renderPrompt(spec, sandbox?.vars ?? null);
      for (const model of models) {
        for (const mcp of variants) {
          const allowedTools = [
            ...(sandbox ? SANDBOX_READ_TOOLS : []),
            ...(sandbox && spec.workspace ? [SANDBOX_EDIT_RULE] : []),
            ...splitList(opts.allowedTools, ''),
          ];
          const options: ClaudeCodeOptions = {
            prompt: promptText,
            model,
            mcpConfig: mcp ? mcpConfig : null,
            cwd,
            permissionMode: opts.permissionMode ?? 'dontAsk',
            allowedTools: [...new Set(allowedTools)],
            tools: opts.tools ?? null,
            maxTurns,
            maxBudgetUsd: maxBudget,
            effort: opts.effort ?? null,
            appendSystemPromptFile: opts.appendSystemPromptFile ? path.resolve(opts.appendSystemPromptFile) : null,
            addDirs: sandbox ? [sandbox.info.packagesRoot] : [],
            timeoutMs: timeoutFor(spec) * 1000,
            claudeBin: opts.claudeBin ?? defaultClaudeBin(),
          };
          const tag = `${spec.id} · ${model} · ${mcp ? 'with' : 'without'} MCP${repeat > 1 ? ` · #${rep + 1}` : ''}`;
          if (opts.dryRun) {
            const unfilled = !sandbox && usesPlaceholders(promptText) ? ' — placeholders unfilled without --sandbox' : '';
            p.log.step(`${tag}\n   ${options.claudeBin} ${buildClaudeArgs(options).map(a => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')}  < prompt (${promptText.length} chars${unfilled}, timeout ${timeoutFor(spec)} s)`);
            continue;
          }
          p.log.step(tag);
          const t0 = Date.now();
          const outcome = await runClaudeCode(options);

          let scored: Pick<RecordContext, 'extraChecks' | 'artifacts' | 'build'> = {};
          let moved: string[] = [];
          if (sandbox && snapshot) {
            const result = await scoreSandboxCell(spec, sandbox, snapshot, wantBuild, `${done + 1}`);
            scored = result.scored;
            moved = result.moved;
          }

          const record = toBenchmarkRun(outcome, {
            spec,
            modelRequested: model,
            mcp,
            serverVersion: VERSION,
            serverGitSha: sha,
            label: opts.label ?? null,
            notes: opts.notes ?? null,
            credits,
            excerpt: opts.excerpt !== false,
            timestamp: new Date(t0),
            ...scored,
          });
          const file = writeRun(bp.runs, record);
          // Keep what the cell wrote before the restore wipes it: a check found
          // wrong later (it happened — <Pattern xmlns="">) can then be re-scored.
          if (sandbox && record.artifacts?.length) keepArtifacts(sandbox.info.packageDir, record.artifacts, path.join(bp.root, 'artifacts', record.runId));
          done++;
          if (record.outcome !== 'completed') failed++;
          const line =
            `${record.outcome} in ${formatMetric('durationMs', record.durationMs)} · ${record.requests} turns · ${record.toolCalls} tool calls` +
            `${record.mcpToolCalls ? ` (${record.mcpToolCalls} MCP)` : ''} · ${formatMetric('outputTokens', record.outputTokens)} out tokens` +
            `${record.aic ? ` · ${formatMetric('aic', record.aic.value)} ${credits.unit}` : ''}` +
            `${record.score !== null ? ` · checks ${Math.round(record.score * 100)} %` : ''}` +
            `${record.artifacts ? ` · ${record.artifacts.length} file(s) written` : ''}` +
            `${record.build ? ` · build ${record.build.ok ? 'clean' : `${record.build.errorCount} error(s)`}` : ''}\n   → ${path.basename(file)}`;
          if (record.outcome === 'completed') p.log.success(line);
          else p.log.warn(`${line}\n   ${record.notes ?? ''}`);

          if (sandbox && snapshot) {
            try {
              await resetSandbox(sandbox, snapshot, moved);
            } catch (err) {
              fail(err instanceof Error ? err.message : String(err));
              return;
            }
          }
        }
      }
    }
  }
  // The filtered MCP config, the snapshot and the build logs; kept only by a run that stopped early.
  try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* best effort — it is in the temp folder */ }
  if (opts.dryRun) {
    p.outro(`Dry run — nothing executed, nothing recorded.${sandbox ? ' Sandbox and MCP write targets checked.' : ''}`);
    return;
  }
  p.outro(
    `${done} run${done === 1 ? '' : 's'} recorded in ${formatMetric('durationMs', Date.now() - started)}` +
      `${failed ? `, ${failed} did not complete` : ''} · next: d365fo-mcp benchmark report`,
  );
  if (failed > 0) process.exitCode = 1;
}

/**
 * Score what a cell left in the sandbox: the file checks, and — for a prompt
 * that asks for it — the build. "Builds clean" is a check only when the cell
 * wrote something: the untouched sandbox builds clean, and that is not the
 * cell's achievement.
 */
async function scoreSandboxCell(
  spec: PromptSpec,
  sandbox: SandboxRun,
  snapshot: Snapshot,
  wantBuild: boolean,
  cellNo: string,
): Promise<{ scored: Pick<RecordContext, 'extraChecks' | 'artifacts' | 'build'>; moved: string[] }> {
  const pkg = sandbox.info.packageDir;
  const diff = diffSandbox(pkg, snapshot);
  const artifacts = authoredChanges(diff);
  const changed = artifacts.map(rel => ({
    path: rel,
    read: () => {
      try { return fs.readFileSync(path.join(pkg, rel), 'utf8'); } catch { return null; }
    },
  }));
  const extraChecks = evaluateFileChecks(spec, changed);
  let build: BuildResult | null = null;
  if (spec.workspace?.build && wantBuild) {
    if (artifacts.length > 0) {
      p.log.info(`   building ${sandbox.info.packageName} with ${artifacts.length} written file(s)…`);
      build = await buildSandbox(sandbox.info, path.join(sandbox.scratch, `cell-${cellNo}-xppc.log`), BUILD_TIMEOUT_MS);
    }
    extraChecks.push({ name: 'builds clean (xppc)', passed: build?.ok === true });
  }
  // Every non-build path that moved, deletions included — the index re-sync list.
  const moved = [...diff.added, ...diff.modified, ...diff.deleted].filter(rel => !isBuildOutput(rel));
  // An answer-only prompt that wrote nothing keeps its record free of sandbox fields.
  const scored: Pick<RecordContext, 'extraChecks' | 'artifacts' | 'build'> = { extraChecks };
  if (spec.workspace || artifacts.length > 0) scored.artifacts = artifacts;
  if (spec.workspace?.build && wantBuild) scored.build = build;
  return { scored, moved };
}

/** Copy the cell's authored files to eval/benchmark/artifacts/<runId>/ (gitignored). Best effort. */
function keepArtifacts(packageDir: string, artifacts: string[], outDir: string): void {
  for (const rel of artifacts) {
    try {
      const target = path.join(outDir, ...rel.split('/'));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(packageDir, ...rel.split('/')), target);
    } catch { /* evidence, not the measurement */ }
  }
}

/** Restore the snapshot, then take what the cell put in the servers' indexes back out. */
async function resetSandbox(sandbox: SandboxRun, snapshot: Snapshot, moved: string[]): Promise<void> {
  restoreSandbox(sandbox.info.packageDir, snapshot);
  if (moved.length === 0 || sandbox.targets.length === 0) return;
  const files = moved.map(rel => path.join(sandbox.info.packageDir, ...rel.split('/')));
  for (const target of sandbox.targets) {
    const { synced, failed } = await syncSymbolIndex(target, files);
    if (failed.length > 0) {
      throw new Error(
        `Sandbox restored, but the symbol index of '${target.name}' could not be re-synced for ${failed.length} file(s): ${failed.slice(0, 3).join('; ')}. ` +
          "Stopping: the next with-MCP cell would find this cell's objects in search.",
      );
    }
    // extension_metadata is keyed by name, not path: a row whose name is not the
    // file's (seen once in the first reference run) survives the per-file re-sync.
    const extensions = await pruneStaleExtensionRows(target, sandbox.info.model, sandbox.info.modelDir);
    p.log.info(
      `   sandbox restored · ${synced} index entr${synced === 1 ? 'y' : 'ies'} re-synced in '${target.name}'` +
        `${extensions.length ? ` · ${extensions.length} extension row(s) with no file removed (${extensions.join(', ')})` : ''}`,
    );
  }
}

// ---------------------------------------------------------------- ingest

interface IngestOptions extends CommonOptions {
  prompt?: string;
  mcp?: string;
  score?: string;
  label?: string;
  notes?: string;
  format?: string;
}

export async function benchmarkIngestCommand(logPath: string | undefined, opts: IngestOptions): Promise<void> {
  const bp = paths(opts);
  if (!logPath || !opts.prompt) {
    fail('Usage: d365fo-mcp benchmark ingest <main.jsonl> --prompt <promptId> [--mcp yes|no] [--score 0..1] [--label …]');
    return;
  }
  try {
    const spec = loadPromptSpec(bp.prompts, opts.prompt);
    const session = readSessionLog(path.resolve(logPath), opts.format);
    let mcp: boolean | null = null;
    if (opts.mcp !== undefined) {
      if (!/^(yes|no|true|false|1|0)$/i.test(opts.mcp)) throw new Error('--mcp takes yes or no');
      mcp = /^(yes|true|1)$/i.test(opts.mcp);
    }
    let score: number | null = null;
    if (opts.score !== undefined) {
      score = Number(opts.score);
      if (!Number.isFinite(score) || score < 0 || score > 1) throw new Error('--score is a fraction between 0 and 1');
    }
    const record = sessionToBenchmarkRun(session, {
      spec,
      mcp,
      score,
      label: opts.label ?? null,
      notes: opts.notes ?? null,
      // The absolute path identifies the machine; the file name is enough to find the log again on it.
      logPath: path.basename(path.dirname(path.resolve(logPath))) + '/' + path.basename(logPath),
      serverVersion: VERSION,
      serverGitSha: serverGitSha(repoRoot),
      credits: loadCreditsConfig(bp.credits),
    });
    const file = writeRun(bp.runs, record);
    p.intro(`d365fo-mcp benchmark ingest — ${path.basename(logPath)}`);
    p.note(
      [
        `prompt     ${record.promptId}`,
        `host       ${record.host} (${session.format})`,
        `model      ${record.model}`,
        `MCP        ${record.mcp ? 'yes' : 'no'}${opts.mcp === undefined ? ' (detected from mcp_* tool calls)' : ''}`,
        `wall time  ${formatMetric('durationMs', record.durationMs)}`,
        `requests   ${record.requests} · tool calls ${record.toolCalls} (${record.mcpToolCalls} MCP)`,
        `tokens     ${formatMetric('inputTokens', record.inputTokens)} in (${formatMetric('inputTokens', record.cachedTokens)} cached) · ${formatMetric('outputTokens', record.outputTokens)} out`,
        `AIC        ${record.aic ? `${formatMetric('aic', record.aic.value)} (${record.aic.source})` : 'not priced'}`,
        `score      ${record.score === null ? '— (pass --score to grade by hand)' : `${Math.round(record.score * 100)} %`}`,
      ].join('\n'),
      'Recorded',
    );
    p.outro(`→ ${file}`);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
}

// ---------------------------------------------------------------- report / list / prompts

interface ReportOptions extends CommonOptions, RunFilter {
  out?: string;
  title?: string;
  open?: boolean;
  json?: boolean;
}

function describeFilters(f: RunFilter): string[] {
  const out: string[] = [];
  if (f.prompt) out.push(`prompt ${f.prompt}`);
  if (f.host) out.push(`host ${f.host}`);
  if (f.model) out.push(`model ~${f.model}`);
  if (f.label) out.push(`label ${f.label}`);
  if (f.since) out.push(`since ${f.since}`);
  if (f.until) out.push(`until ${f.until}`);
  return out;
}

/**
 * `explorer.exe <file>` on Windows, never `cmd /c start`: cmd re-parses its
 * whole command line, so a `&` in a user-chosen --out path would run a second
 * command (CodeQL js/shell-command-injection-from-environment). explorer, open
 * and xdg-open all receive the path as one argv entry with no shell in between.
 */
function openInBrowser(file: string): void {
  const [bin, args] = process.platform === 'win32'
    ? ['explorer.exe', [file]]
    : process.platform === 'darwin' ? ['open', [file]] : ['xdg-open', [file]];
  execFile(bin, args, { windowsHide: true }, () => { /* best effort */ });
}

export async function benchmarkReportCommand(opts: ReportOptions): Promise<void> {
  const bp = paths(opts);
  try {
    const all = loadRuns(bp.runs);
    const skipped = countRunFiles(bp.runs) - all.length;
    const runs = filterRuns(all, opts);
    const specs = loadPromptSpecs(bp.prompts);
    const credits = loadCreditsConfig(bp.credits);
    const model = buildReportModel(runs, specs, { title: opts.title, filters: describeFilters(opts), skippedFiles: skipped, credits });
    if (opts.json) {
      // The data the report is drawn from, for tracking in CI or a spreadsheet.
      const { slots, ...rest } = model;
      process.stdout.write(`${JSON.stringify({ ...rest, slots: Object.fromEntries(slots), prompts: rest.prompts.map(p => ({ ...p, spec: p.spec?.id ?? null, runs: p.runs.map(r => r.runId) })) }, null, 2)}\n`);
      return;
    }
    const outDir = path.resolve(opts.out ?? bp.reports);
    fs.mkdirSync(outDir, { recursive: true });
    const htmlFile = path.join(outDir, 'index.html');
    const mdFile = path.join(outDir, 'report.md');
    fs.writeFileSync(htmlFile, renderHtml(model), 'utf8');
    fs.writeFileSync(mdFile, renderMarkdown(model), 'utf8');
    p.intro('d365fo-mcp benchmark report');
    p.note(
      [
        `runs       ${runs.length}${runs.length !== all.length ? ` of ${all.length} (filtered)` : ''}${skipped ? ` · ${skipped} unreadable file(s) skipped` : ''}`,
        `prompts    ${model.prompts.length}`,
        `models     ${model.models.join(', ') || '—'}`,
        `hosts      ${model.hosts.join(', ') || '—'}`,
        `span       ${model.span ? `${model.span.from.slice(0, 10)} → ${model.span.to.slice(0, 10)}` : '—'}`,
        ...model.overviewKpis.slice(1).map(k => `${k.label.padEnd(10)} ${k.value}`),
      ].join('\n'),
      'Report',
    );
    p.outro(`${htmlFile}\n   ${mdFile}`);
    if (opts.open) openInBrowser(htmlFile);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
}

export async function benchmarkListCommand(opts: CommonOptions & RunFilter): Promise<void> {
  const bp = paths(opts);
  try {
    const runs = filterRuns(loadRuns(bp.runs), opts);
    if (runs.length === 0) {
      p.log.info(`No runs in ${bp.runs}${describeFilters(opts).length ? ` matching ${describeFilters(opts).join(', ')}` : ''}.`);
      return;
    }
    const line = (r: BenchmarkRun) =>
      `${r.timestamp.slice(0, 16).replace('T', ' ')}  ${r.promptId.padEnd(28)} ${r.model.padEnd(24)} ${(r.mcp ? 'mcp' : 'plain').padEnd(5)} ` +
      `${r.outcome.padEnd(9)} ${formatMetric('durationMs', r.durationMs).padStart(8)} ${String(r.requests).padStart(4)}t ${formatMetric('outputTokens', r.outputTokens).padStart(8)} out ` +
      `${(r.aic ? formatMetric('aic', r.aic.value) : '—').padStart(8)} AIC${r.score === null ? '' : ` ${Math.round(r.score * 100)}%`}${r.label ? `  [${r.label}]` : ''}`;
    process.stdout.write(`${runs.map(line).join('\n')}\n`);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
}

export async function benchmarkPromptsCommand(opts: CommonOptions): Promise<void> {
  const bp = paths(opts);
  try {
    const specs = loadPromptSpecs(bp.prompts);
    if (specs.length === 0) {
      p.log.info(`No prompts in ${bp.prompts}.`);
      return;
    }
    for (const s of specs) {
      const checks = (s.expects?.mustMatch?.length ?? 0) + (s.expects?.mustNotMatch?.length ?? 0);
      process.stdout.write(`${s.id.padEnd(32)} ${s.title}${s.tags.length ? `  [${s.tags.join(', ')}]` : ''}${checks ? `  · ${checks} check${checks === 1 ? '' : 's'}` : ''}\n`);
    }
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
}

/** Wire the subcommands onto the program (kept here so cli/index.ts stays a table of contents). */
export function registerBenchmarkCommands(program: Command): void {
  const bench = program.command('benchmark').description('Model × MCP benchmark: run a prompt matrix, ingest host logs, render the report (docs/BENCHMARK.md)');
  const dirOption = ['--dir <path>', 'benchmark root (default: eval/benchmark in the checkout)'] as const;

  bench.command('run')
    .argument('[prompt]', "prompt id from eval/benchmark/prompts, or 'all'")
    .option('--prompt <text>', 'one-off prompt text instead of a catalogue entry (the id argument names it)')
    .option('-m, --models <list>', `comma-separated --model values for claude (default: ${DEFAULT_MODELS})`)
    .option('-v, --variants <list>', 'mcp,plain (default both)')
    .option('-r, --repeat <n>', 'repetitions of the whole matrix (default 1)')
    .option('--tag <list>', "with 'all': only prompts carrying one of these tags (e.g. reference)")
    .option('--mcp-config <file>', 'MCP config JSON for the with-MCP cells (default: ./.mcp.json)')
    .option('--mcp-servers <list>', 'only these servers from the MCP config (required with --sandbox when it lists more than one)')
    .option('--sandbox <packageDir>', 'throwaway D365FO package the write prompts work in; snapshotted, scored and restored around every cell')
    .option('--sandbox-model <name>', 'model folder inside the sandbox package (default: the package name)')
    .option('--no-build', 'skip the xppc build check of prompts that ask for one')
    .option('--allow-dirty-baseline', 'run even when the sandbox does not build clean before the first cell')
    .option('--cwd <dir>', 'working directory for claude (default: current directory; the sandbox package with --sandbox)')
    .option('--label <text>', 'tag these runs ("release 1.20", "VM contoso")')
    .option('--notes <text>', 'free-text note stored on each record')
    .option('--timeout <seconds>', `kill a cell after this long (default: the prompt's timeoutSeconds, else ${DEFAULT_TIMEOUT_S})`)
    .option('--max-turns <n>', 'claude --max-turns')
    .option('--max-budget-usd <amount>', 'claude --max-budget-usd')
    .option('--permission-mode <mode>', 'claude --permission-mode (default dontAsk; MCP tools are allowed explicitly)')
    .option('--allowed-tools <list>', 'extra --allowedTools entries, comma-separated')
    .option('--tools <list>', 'claude --tools: restrict the built-in set ("" = none, for a pure MCP cell)')
    .option('--effort <level>', 'claude --effort')
    .option('--append-system-prompt-file <file>', 'claude --append-system-prompt-file (e.g. .github/copilot-instructions.md)')
    .option('--claude-bin <path>', 'the claude executable (default: claude / claude.cmd on PATH)')
    .option('--no-excerpt', 'do not store the opening of the answer in the record')
    .option('--dry-run', 'print the matrix and each claude command without running anything')
    .option(...dirOption)
    .description('Run a prompt against each model, with and without the MCP server, through claude -p')
    .action((prompt: string | undefined, opts: RunOptions) => benchmarkRunCommand(prompt, opts));

  bench.command('ingest')
    .argument('[log]', 'agent-host debug log (Copilot Chat: …/GitHub.copilot-chat/debug-logs/<id>/main.jsonl)')
    .requiredOption('-p, --prompt <id>', 'which catalogue prompt this session answered')
    .option('--mcp <yes|no>', 'override MCP detection (default: detected from mcp_* tool calls)')
    .option('--score <0..1>', 'manual grade of the answer')
    .option('--label <text>', 'tag for this run')
    .option('--notes <text>', 'free-text note')
    .option('--format <id>', 'force a log format (see d365fo-mcp session --help)')
    .option(...dirOption)
    .description('Record a run from a host debug log — for hosts that cannot be driven headlessly')
    .action((log: string | undefined, opts: IngestOptions) => benchmarkIngestCommand(log, opts));

  const filterOptions = (c: Command) => c
    .option('--prompt <id>', 'only this prompt')
    .option('--host <id>', 'only this host (claude-code, copilot-chat)')
    .option('--model <text>', 'only models whose id contains this text')
    .option('--label <text>', 'only runs with this label')
    .option('--since <date>', 'only runs on/after this date (YYYY-MM-DD)')
    .option('--until <date>', 'only runs on/before this date')
    .option(...dirOption);

  filterOptions(bench.command('report'))
    .option('-o, --out <dir>', 'output directory (default: eval/benchmark/reports)')
    .option('--title <text>', 'report title')
    .option('--open', 'open the HTML report in the default browser')
    .option('--json', 'print the report data instead of writing files')
    .description('Render the HTML report (+ markdown twin) from the recorded runs')
    .action((opts: ReportOptions) => benchmarkReportCommand(opts));

  filterOptions(bench.command('list'))
    .description('List recorded runs, one line each')
    .action((opts: CommonOptions & RunFilter) => benchmarkListCommand(opts));

  bench.command('prompts')
    .option(...dirOption)
    .description('List the prompt catalogue')
    .action((opts: CommonOptions) => benchmarkPromptsCommand(opts));
}
