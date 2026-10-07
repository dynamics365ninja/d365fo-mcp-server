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
import * as path from 'node:path';
import type { Command } from 'commander';
import { formatMetric } from '../../benchmark/aggregate.js';
import { runClaudeCode, toBenchmarkRun, type ClaudeCodeOptions } from '../../benchmark/claudeCode.js';
import { buildClaudeArgs } from '../../benchmark/claudeCode.js';
import { loadCreditsConfig } from '../../benchmark/credits.js';
import { sessionToBenchmarkRun } from '../../benchmark/ingest.js';
import { adHocPromptSpec, loadPromptSpec, loadPromptSpecs } from '../../benchmark/prompts.js';
import { renderHtml } from '../../benchmark/report/html.js';
import { renderMarkdown } from '../../benchmark/report/markdown.js';
import { buildReportModel } from '../../benchmark/report/model.js';
import {
  benchmarkPaths,
  countRunFiles,
  filterRuns,
  loadRuns,
  serverGitSha,
  writeRun,
  type RunFilter,
} from '../../benchmark/store.js';
import type { BenchmarkRun, PromptSpec } from '../../benchmark/types.js';
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

export async function benchmarkRunCommand(promptArg: string | undefined, opts: RunOptions): Promise<void> {
  const bp = paths(opts);
  let specs: PromptSpec[];
  try {
    if (opts.prompt) {
      specs = [adHocPromptSpec(promptArg ?? 'ad-hoc', opts.prompt)];
    } else if (!promptArg) {
      fail('Usage: d365fo-mcp benchmark run <promptId|all> [--models sonnet,opus] [--variants mcp,plain] [--repeat 3] …\n   or: benchmark run <id> --prompt "<text>" for a one-off prompt');
      return;
    } else {
      specs = promptArg === 'all' ? loadPromptSpecs(bp.prompts) : [loadPromptSpec(bp.prompts, promptArg)];
    }
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
    return;
  }
  if (specs.length === 0) {
    fail(`No prompts in ${bp.prompts}. Add a <id>.json there (see eval/benchmark/README.md).`);
    return;
  }

  let models: string[], variants: boolean[], repeat: number, timeoutS: number, maxTurns: number | null, maxBudget: number | null;
  try {
    models = splitList(opts.models, DEFAULT_MODELS);
    variants = parseVariants(opts.variants);
    repeat = optionalInt(opts.repeat, 'repeat') ?? 1;
    timeoutS = optionalInt(opts.timeout, 'timeout') ?? DEFAULT_TIMEOUT_S;
    maxTurns = optionalInt(opts.maxTurns, 'max-turns');
    maxBudget = optionalNumber(opts.maxBudgetUsd, 'max-budget-usd');
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
    return;
  }

  const mcpConfig = variants.includes(true) ? resolveMcpConfig(opts.mcpConfig, repoRoot) : null;
  if (variants.includes(true) && !mcpConfig) {
    fail('No MCP config for the with-MCP cells. Pass --mcp-config <file> (a {"mcpServers": {...}} JSON) or put .mcp.json in the current directory.');
    return;
  }

  const credits = loadCreditsConfig(bp.credits);
  const sha = serverGitSha(repoRoot);
  const cwd = path.resolve(opts.cwd ?? process.cwd());
  const cells = specs.length * models.length * variants.length * repeat;

  p.intro(`d365fo-mcp benchmark run — ${cells} cell${cells === 1 ? '' : 's'}`);
  p.note(
    [
      `prompts     ${specs.map(s => s.id).join(', ')}`,
      `models      ${models.join(', ')}`,
      `variants    ${variants.map(v => (v ? 'with MCP' : 'without MCP')).join(', ')}`,
      `repeat      ${repeat}×`,
      `MCP config  ${mcpConfig ?? '(none needed)'}`,
      `cwd         ${cwd}`,
      `timeout     ${timeoutS} s per cell${maxTurns ? ` · max ${maxTurns} turns` : ''}${maxBudget ? ` · max $${maxBudget}` : ''}`,
      `records →   ${bp.runs}`,
    ].join('\n'),
    'Matrix',
  );

  // Repeats on the outside so a slow afternoon hits every cell, not one model.
  let done = 0, failed = 0;
  const started = Date.now();
  for (let rep = 0; rep < repeat; rep++) {
    for (const spec of specs) {
      for (const model of models) {
        for (const mcp of variants) {
          const options: ClaudeCodeOptions = {
            prompt: spec.prompt,
            model,
            mcpConfig: mcp ? mcpConfig : null,
            cwd,
            permissionMode: opts.permissionMode ?? 'dontAsk',
            allowedTools: splitList(opts.allowedTools, ''),
            tools: opts.tools ?? null,
            maxTurns,
            maxBudgetUsd: maxBudget,
            effort: opts.effort ?? null,
            appendSystemPromptFile: opts.appendSystemPromptFile ? path.resolve(opts.appendSystemPromptFile) : null,
            timeoutMs: timeoutS * 1000,
            claudeBin: opts.claudeBin ?? defaultClaudeBin(),
          };
          const tag = `${spec.id} · ${model} · ${mcp ? 'with' : 'without'} MCP${repeat > 1 ? ` · #${rep + 1}` : ''}`;
          if (opts.dryRun) {
            p.log.step(`${tag}\n   ${options.claudeBin} ${buildClaudeArgs(options).map(a => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')}  < prompt (${spec.prompt.length} chars)`);
            continue;
          }
          p.log.step(tag);
          const t0 = Date.now();
          const outcome = await runClaudeCode(options);
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
          });
          const file = writeRun(bp.runs, record);
          done++;
          if (record.outcome !== 'completed') failed++;
          const line =
            `${record.outcome} in ${formatMetric('durationMs', record.durationMs)} · ${record.requests} turns · ${record.toolCalls} tool calls` +
            `${record.mcpToolCalls ? ` (${record.mcpToolCalls} MCP)` : ''} · ${formatMetric('outputTokens', record.outputTokens)} out tokens` +
            `${record.aic ? ` · ${formatMetric('aic', record.aic.value)} ${credits.unit}` : ''}` +
            `${record.score !== null ? ` · checks ${Math.round(record.score * 100)} %` : ''}\n   → ${path.basename(file)}`;
          if (record.outcome === 'completed') p.log.success(line);
          else p.log.warn(`${line}\n   ${record.notes ?? ''}`);
        }
      }
    }
  }
  if (opts.dryRun) {
    p.outro('Dry run — nothing executed, nothing recorded.');
    return;
  }
  p.outro(
    `${done} run${done === 1 ? '' : 's'} recorded in ${formatMetric('durationMs', Date.now() - started)}` +
      `${failed ? `, ${failed} did not complete` : ''} · next: d365fo-mcp benchmark report`,
  );
  if (failed > 0) process.exitCode = 1;
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

function openInBrowser(file: string): void {
  const [bin, args] = process.platform === 'win32'
    ? ['cmd', ['/c', 'start', '', file]]
    : process.platform === 'darwin' ? ['open', [file]] : ['xdg-open', [file]];
  execFile(bin, args, () => { /* best effort */ });
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
    .option('--mcp-config <file>', 'MCP config JSON for the with-MCP cells (default: ./.mcp.json)')
    .option('--cwd <dir>', 'working directory for claude (default: current directory)')
    .option('--label <text>', 'tag these runs ("release 1.20", "VM contoso")')
    .option('--notes <text>', 'free-text note stored on each record')
    .option('--timeout <seconds>', `kill a cell after this long (default ${DEFAULT_TIMEOUT_S})`)
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
