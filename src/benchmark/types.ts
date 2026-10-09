/**
 * Model × MCP benchmark — the record one run leaves behind.
 *
 * One record per (prompt, host, model, with/without MCP, moment). The record is
 * the whole unit of evidence: the report is derived from a directory of these,
 * nothing else, so a run captured on the VM through Copilot Chat and a run made
 * headlessly through Claude Code on a laptop land in the same shape and are
 * compared by the same arithmetic.
 *
 * Costs come in two flavours and the record keeps both:
 *   - `hostCost` is what the host itself said it billed, in the host's own unit
 *     (Claude Code: USD; Copilot Chat: its AI-credit figure).
 *   - `aic` is the AI-Credits figure the report plots — the host's own when the
 *     host bills in credits, otherwise derived (see credits.ts), with `source`
 *     saying which, so a derived number is never mistaken for a billed one.
 */

export const BENCHMARK_SCHEMA_VERSION = 1;

export type BenchmarkOutcome = 'completed' | 'error' | 'timeout' | 'max_turns' | 'budget_exceeded';

/**
 * Where the AIC figure came from.
 *   host       — the host bills in AI credits and recorded the figure itself.
 *   host-cost  — converted from the host's native cost (USD) with `creditsPerUsd`.
 *   rates      — computed from token counts with the per-model rate table.
 */
export type AicSource = 'host' | 'host-cost' | 'rates';

export interface ModelRates {
  /** USD per million tokens. */
  cached: number;
  uncached: number;
  output: number;
}

export interface CheckResult {
  name: string;
  passed: boolean;
}

export interface BenchmarkRun {
  schemaVersion: typeof BENCHMARK_SCHEMA_VERSION;
  runId: string;
  /** ISO-8601, when the run started. */
  timestamp: string;
  promptId: string;
  /** Short hash of the prompt text — an edited prompt is a different experiment. */
  promptHash: string;
  /** 'claude-code' | 'copilot-chat' | any other reader's id. */
  host: string;
  /** Model id as the host resolved it (e.g. claude-sonnet-5-5), or the alias asked for. */
  model: string;
  /** What was asked for on the command line, when that differs from `model`. */
  modelRequested: string | null;
  /** True when the d365fo MCP server was available to the agent. */
  mcp: boolean;
  /** MCP servers the host reported as connected (empty when mcp=false). */
  mcpServers: string[];
  serverVersion: string | null;
  serverGitSha: string | null;
  /** Free tag for a series of runs ("release 1.20", "VM contoso", …). */
  label: string | null;

  durationMs: number;
  /** Time spent inside model calls, when the host reports it. */
  apiMs: number | null;
  /** Model round trips. */
  requests: number;
  toolCalls: number;
  mcpToolCalls: number;
  /** Per-tool call counts, names as the host logged them. */
  tools: Record<string, number>;

  /** Prompt tokens, cached ones included. */
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;

  hostCost: { value: number; unit: string } | null;
  aic: { value: number; source: AicSource; rates?: ModelRates } | null;

  outcome: BenchmarkOutcome;
  /** 0..1 fraction of the prompt's checks that passed; null when the prompt defines none. */
  score: number | null;
  checks: CheckResult[];
  resultChars: number | null;
  /** Opening of the final answer — opt-out with --no-excerpt when answers may name customer objects. */
  resultExcerpt: string | null;
  notes: string | null;
  evidence: { sessionId: string | null; logPath: string | null };
  /**
   * Sandbox runs only: files the cell added or changed in the sandbox package,
   * relative to it with forward slashes, build output left out. Absent for a
   * run that wrote nothing it was asked to write anywhere (answer-only prompts).
   */
  artifacts?: string[];
  /** Sandbox runs only: the xppc full build of the sandbox model after the cell; null when not built. */
  build?: BuildResult | null;
}

export interface BuildResult {
  ok: boolean;
  /** Error lines in the xppc log (compile, metadata and validation errors). */
  errorCount: number;
  /** The first few error lines, trimmed — enough to see what broke. */
  errors: string[];
  durationMs: number;
}

/**
 * A file the cell must have written into the sandbox. One check per entry:
 * passed when at least one added or changed file's relative path matches
 * `path` and its content matches every `contains` and none of `notContains`.
 * Pre-existing files the cell did not touch never satisfy it.
 */
export interface FileExpectation {
  /** Check name in the record; defaults to the path regex. */
  name?: string;
  /** Regex (flags `i`) over the path relative to the sandbox package, forward slashes. */
  path: string;
  contains?: string[];
  notContains?: string[];
}

export interface PromptExpectations {
  /** Regexes (flags `is`) the final answer must match — each one is a check. */
  mustMatch?: string[];
  /** Regexes the final answer must NOT match. */
  mustNotMatch?: string[];
  /** Files the cell must have written into the sandbox (needs `workspace`). */
  files?: FileExpectation[];
}

export interface PromptSpec {
  id: string;
  title: string;
  /**
   * The text the model receives. `{{model}}`, `{{modelDir}}`, `{{packageDir}}`
   * and `{{packagesRoot}}` are filled from --sandbox at run time; the hash is
   * taken over the template, so the experiment is the same on every machine.
   */
  prompt: string;
  tags: string[];
  expects?: PromptExpectations;
  /**
   * Present when the prompt writes AOT objects. Such a prompt runs only with
   * --sandbox: the agent may edit nothing but the sandbox package, every cell
   * starts from the same snapshot of it, and with `build` the result is
   * compiled and "builds clean" becomes one of the checks.
   */
  workspace?: { build?: boolean };
  /** Per-cell timeout for this prompt; overrides --timeout when larger work needs longer. */
  timeoutSeconds?: number;
  notes?: string;
}

export interface CreditsConfig {
  /** Display unit, 'AIC'. */
  unit: string;
  /** Units the hosts' own cost figures are accepted as credits without conversion. */
  creditUnits: string[];
  /** Conversion for a host that bills in USD. */
  creditsPerUsd: number;
  /** Per-model USD rates, matched by case-insensitive substring of the model id, first match wins. */
  modelRates: Array<{ match: string; rates: ModelRates }>;
}
