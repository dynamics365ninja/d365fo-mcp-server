# Model × MCP benchmark

**Question:** what does the D365FO MCP server change about a model's answer to
one prompt — run time, output tokens, AI Credits, round trips, correctness — and
how is that moving over time, model by model?

`d365fo-mcp benchmark` answers it with a committed set of run records and a
report derived from them. It is a *measurement* tool: it does not judge X++ the
way the [eval loop](AGENT_EVAL_LOOP.md) does (build + golden + SysTest); it
measures what a prompt *costs* on each model with and without the server, and
keeps the history.

> The unit tests say whether the server is correct; `d365fo-mcp session` says
> what one session cost; this says how models compare on the same prompt, and
> how that changes release over release.

## Concepts

| Term | Meaning |
|---|---|
| **prompt** | one experiment — `eval/benchmark/prompts/<id>.json` (text + optional regex checks). The record stores the id **and a hash of the text**: edit the prompt and older runs are flagged as a different experiment. |
| **host** | who ran the agent: `claude-code` (headless `claude -p`, automated) or `copilot-chat` (VS / VS Code, recorded from its debug log). |
| **variant** | `mcp` (the D365FO server was available) or `plain` (it was not). Everything else held equal. |
| **cell** | one (prompt, host, model, variant). Repeats land in the same cell; the report shows the **median** and p90. |
| **AIC** | AI Credits — the cost axis. Copilot bills in them and logs them; Claude Code reports USD, converted at `creditsPerUsd` (default 100, i.e. one credit per cent). Every AIC figure carries its `source` (`host`, `host-cost`, `rates`) and the report says which. Pricing lives in `eval/benchmark/credits.json`. |
| **score** | fraction of the prompt's `expects` checks the final answer passed (headless runs), or a `--score` grade given by hand (ingested runs). |

## Quick start

```bash
npm run cli -- benchmark prompts                      # what is in the catalogue
npm run cli -- benchmark run all --dry-run            # the matrix and every claude command, nothing executed
npm run cli -- benchmark run all --models sonnet,opus --repeat 3 --label "release 1.20"
npm run cli -- benchmark report --open                # eval/benchmark/reports/index.html (+ report.md)
```

`npm run benchmark -- …` is the same as `npm run cli -- benchmark …`.

### Headless runs (`benchmark run`)

Each cell is one `claude -p` process, prompt on stdin, `--output-format
stream-json` so the per-tool call counts are captured, `--strict-mcp-config` so
nothing but the given `--mcp-config` can connect, `--no-session-persistence` so
the runs do not pile up in the resume list. The with-MCP cells get `--mcp-config
<file>` plus `--allowedTools mcp__<server>` for every server in it; the plain
cells get neither.

| Option | Default | Notes |
|---|---|---|
| `--models a,b` | `sonnet` | anything `claude --model` accepts (aliases or full ids). The record stores the id the host resolved. |
| `--variants mcp,plain` | both | |
| `--repeat n` | 1 | repeats are the outer loop, so a slow hour hits every cell, not one model |
| `--mcp-config <file>` | `./.mcp.json` | `{"mcpServers": {...}}` — the same file your editor uses |
| `--cwd <dir>` | current dir | run claude from your solution folder so `CLAUDE.md` / the workspace apply |
| `--timeout s` | 900 | a cell that overruns is killed and recorded as `timeout` |
| `--max-turns`, `--max-budget-usd`, `--effort`, `--tools`, `--append-system-prompt-file` | — | passed through to claude |
| `--permission-mode` | `dontAsk` | nothing may prompt in a benchmark; the MCP tools are allowed explicitly |
| `--label`, `--notes` | — | stored on every record of the batch |
| `--no-excerpt` | — | leave the first 400 chars of the answer out of the record |
| `--prompt "<text>"` | — | one-off prompt instead of a catalogue entry (`benchmark run my-id --prompt "…"`) |

A record is written after every cell, so an interrupted matrix keeps what it
measured. Exit code 1 when any cell did not complete.

### Recording a Copilot Chat session (`benchmark ingest`)

Copilot cannot be driven headlessly, so its runs are recorded from the debug log
the [`session` command](TESTING.md#measuring-round-trip-cost) already reads:

```bash
# %APPDATA%\Code\User\workspaceStorage\*\GitHub.copilot-chat\debug-logs\<id>\main.jsonl
npm run cli -- benchmark ingest <main.jsonl> --prompt coc-salesline-validatewrite --score 0.8 --label "VM contoso"
```

MCP is detected from `mcp_*` tool calls (`--mcp yes|no` overrides); the model
and the AI-credit figure come from the log; the answer cannot be checked
automatically, so grade it with `--score`. **The log itself is never copied**:
the record keeps derived numbers, the catalogue prompt id and the log's file
name.

### The report (`benchmark report`)

One self-contained HTML file (works from disk, light/dark) and a markdown twin.
Filters are command-line flags — `--prompt`, `--host`, `--model`, `--label`,
`--since`, `--until` — and the page has a prompt switcher.

Per prompt:

- **KPI tiles** — runs, fastest and cheapest cell, and the MCP effect (median
  of per-model deltas) on time, AIC, output tokens and checks.
- **With MCP vs without** — one dumbbell per metric: a row per model, the
  without-MCP median at the light end, the with-MCP median at the dark end.
- **Over time** — per metric, two panels (with / without) sharing one scale,
  one line per model through the daily median, dots for single runs. This is
  the "where are the models going" view: a new release of the server moves the
  with-MCP panel; a new model version moves both.
- **Numbers** — the medians, p90 run time, completion rate and AIC source per
  cell; the MCP-effect table with ▼/▲ glyphs; every run in a collapsible table.

An overview across prompts sits at the top. `--json` prints the data instead.

## Adding a prompt

```json
{
  "id": "my-prompt",
  "title": "Short title",
  "prompt": "The full text the model receives.",
  "tags": ["coc", "L2"],
  "expects": { "mustMatch": ["ExtensionOf\\(tableStr\\(SalesLine\\)\\)"], "mustNotMatch": ["today\\(\\)"] }
}
```

The file name must equal `id`. Checks are regexes with flags `is` (X++ is
case-insensitive). Pick prompts that have a *grounded* answer the server can
supply — an EDT name, a method signature, a knowledge topic — so the with/without
difference means something. Prompts that write into a model must point `--cwd`
at a **sandbox** model, never a customer one.

## Reading the numbers honestly

- **Medians, not means.** Agent runs have a long tail; one wandering run must not
  speak for a model. p90 is beside the median so the tail is still visible.
- **Compare within a prompt.** Different prompts have different shapes; the
  overview table is for orientation, the per-prompt sections are for conclusions.
- **A hash warning means two experiments.** The prompt text changed; do not read a
  trend across the change.
- **AIC for Claude Code is derived.** `creditsPerUsd` is an assumption (see
  `credits.json`); the Copilot figures are what the host billed. Compare hosts on
  tokens and time first, credits second.
- **Repeat.** One run per cell is an anecdote. Three is where a median starts to
  mean something.

## Where things live

```
src/benchmark/            types, credits, prompts, store, claudeCode (runner), ingest, aggregate, report/
src/cli/commands/benchmark.ts   the subcommands
eval/benchmark/           prompts/, runs/ (committed), credits.json, schema.json, reports/ (ignored)
tests/benchmark/          unit tests, incl. a captured claude stream fixture
```

## Running it on the D365FO VM (Windows)

Everything is TypeScript on Node ≥ 24; nothing native. The runner spawns
`claude.cmd` through the shell on Windows, record file names avoid characters
NTFS rejects, and JSON with a PowerShell BOM is read fine.

1. `npm ci` (or `d365fo-mcp update`) on the VM, then `npm run build` if you want
   `d365fo-mcp benchmark …` from the installed CLI rather than `npm run cli -- …`.
2. `claude --version` and `claude -p "say ok"` once, to confirm the CLI is logged
   in — a benchmark cell that cannot authenticate is recorded as `error` with the
   CLI's message in `notes`.
3. From your **solution folder**, with the `.mcp.json` your editor uses:
   `npm run cli -- benchmark run all --dry-run --mcp-config .mcp.json` — read the
   commands; then drop `--dry-run` with `--models sonnet --repeat 1` for a first
   pass, and only then the full matrix.
4. For Copilot: turn on chat debug logging, run the catalogue prompt by hand,
   `benchmark ingest` the `main.jsonl`, grade with `--score`.
5. `benchmark report --open`, commit `eval/benchmark/runs/*.json`, never a log.

Open questions to settle there, in order: the `creditsPerUsd` reading against
the real Copilot billing page; whether a with-MCP cell should also get
`--append-system-prompt-file .github/copilot-instructions.md` (it changes what
the model knows about the tools — a fair comparison either gives it to both
cells or to neither); and which prompts deserve a SysTest-backed oracle through
the eval loop rather than regex checks.
