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
| `--tag a,b` | — | with `all`: only prompts carrying one of the tags (`--tag reference`) |
| `--mcp-config <file>` | `./.mcp.json` | `{"mcpServers": {...}}` — the same file your editor uses |
| `--mcp-servers a,b` | all in the file | only these servers; **required with `--sandbox`** when the file lists more than one |
| `--sandbox <package>` | — | throwaway package the write prompts work in — see [Prompts that write](#prompts-that-write-the-sandbox) |
| `--sandbox-model <name>` | package name | the model folder inside the sandbox package |
| `--no-build` | — | skip the xppc build check (the file checks still run) |
| `--allow-dirty-baseline` | — | run although the sandbox does not build clean before the first cell |
| `--cwd <dir>` | current dir | run claude from your solution folder so `CLAUDE.md` / the workspace apply (not with `--sandbox`) |
| `--timeout s` | prompt's `timeoutSeconds`, else 900 | a cell that overruns is killed and recorded as `timeout` |
| `--max-turns`, `--max-budget-usd`, `--effort`, `--tools`, `--append-system-prompt-file` | — | passed through to claude |
| `--permission-mode` | `dontAsk` | nothing may prompt in a benchmark; the MCP tools are allowed explicitly |
| `--label`, `--notes` | — | stored on every record of the batch |
| `--no-excerpt` | — | leave the first 400 chars of the answer out of the record |
| `--prompt "<text>"` | — | one-off prompt instead of a catalogue entry (`benchmark run my-id --prompt "…"`) |

A record is written after every cell, so an interrupted matrix keeps what it
measured. Exit code 1 when any cell did not complete. Every cell runs with
`CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`: a cell that saved "the table is called X"
as a memory would hand the answer to every later cell started from the same
folder.

### Prompts that write: the sandbox

A prompt with a `workspace` block (all three reference prompts) creates AOT
objects, and only runs with `--sandbox <package folder>` — a throwaway package
such as `K:\AosService\PackagesLocalDirectory\fm-mcp`, never a customer model.
Around the matrix and every cell the runner:

1. **Checks the write target.** `--mcp-servers` selects the servers the with-MCP
   cells get (written to a filtered copy of the config). For each, the runner
   reads the server's effective `D365FO_WORKSPACE_PATH` the way the server does
   — entry `env`, then the inherited environment, then the config file named by
   `D365FO_CONFIG` — and refuses unless it is the sandbox model. A variable set
   in the launching shell outranks the server's config file; on the VM this
   feature was built on, the session environment carried
   `D365FO_WORKSPACE_PATH=K:\AosService`, which would have sent every with-MCP
   write there. Unset it (`env -u D365FO_WORKSPACE_PATH …`, PowerShell
   `Remove-Item Env:D365FO_WORKSPACE_PATH`) or set it in the server's `env` block.
2. **Cleans the index of the sandbox model**: object rows whose file is gone and
   extension rows with no file in the model folder are removed (a dry run only
   reports them). The plain cells never read the index, so a dirty one skews only
   the MCP side — on the VM, 27 of 28 fm-mcp object rows and all 18 extension
   rows were left over from earlier eval runs; the server's prefix inference
   learned `ConDemo` from them and every with-MCP create of
   `ConCustOverdueSnapshot` came out as `ConDemoConCustOverdueSnapshot`.
3. **Builds a baseline** (xppc full build of the sandbox module) when a prompt
   asks for the build check, and stops if the sandbox does not build clean on
   its own — otherwise every "builds clean" check fails for a reason no cell
   caused.
4. **Snapshots the package** (Descriptor, the model folder, `bin`; a sandbox is
   a few MB and more than 5,000 files is refused) into the temp folder.
5. **Runs the cell in the package**: cwd is the package, the built-in tools are
   `Read Glob Grep` plus `Edit(./**)` — in `dontAsk` mode that rule lets the file
   tools write inside the package and nowhere else (checked on the VM: a write
   to an `--add-dir` folder is denied) — and `--add-dir <PackagesLocalDirectory>`
   makes the standard metadata readable, so the plain cell can look up CustTable
   the way a developer without the server would. Shells are not allowed: a plain
   cell cannot run xppc, a with-MCP cell builds through the server. That gap is
   part of what is being measured; add `--allowed-tools PowerShell` to close it.
6. **Scores what the cell wrote**: the package is diffed against the snapshot,
   the added/changed files (build output left out) become the record's
   `artifacts`, each `expects.files` entry is one check, and with
   `workspace.build` the module is built and "builds clean (xppc)" is one more
   check (failed when the cell wrote nothing — the untouched sandbox building is
   not the cell's achievement). The record's `build` keeps the first error lines.
7. **Restores the package** byte for byte and re-diffs to prove it; a failed
   restore stops the matrix (the snapshot stays in the temp folder).
8. **Re-syncs the symbol index** of every selected server for every path that
   moved — the server upserts what it writes into its SQLite index, and the next
   with-MCP cell would otherwise find the previous cell's table in `search`.

The files each cell wrote are copied to `eval/benchmark/artifacts/<runId>/`
(gitignored) before the restore, so a check that turns out wrong can be
re-scored against them — the first reference run needed exactly that: the form
check asked for a bare `<Pattern>`, while AxForm XML writes
`<Pattern xmlns="">SimpleList</Pattern>`. What the permission fence refused
(tool and file name) is noted on the record.

A run warns when the server's `dist/index.js` is older than HEAD: the cells
would measure an older server than the `serverGitSha` on their records. Run
`npm run build` first.

```powershell
# On the VM: drop the inherited workspace; the dry run validates the sandbox,
# the write targets and every command without running a cell
Remove-Item Env:D365FO_WORKSPACE_PATH -ErrorAction SilentlyContinue
npm run cli -- benchmark run all --tag reference --dry-run `
  --sandbox K:\AosService\PackagesLocalDirectory\fm-mcp --mcp-servers d365fo-eval
npm run cli -- benchmark run all --tag reference --models sonnet,opus --repeat 3 `
  --sandbox K:\AosService\PackagesLocalDirectory\fm-mcp --mcp-servers d365fo-eval --label "reference v1"
```

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

The page leads with the difference, not the absolute values. At the top, for
all prompts, and again inside every prompt:

- **MCP effect per model** — one small panel per metric (run time, output
  tokens, AIC, round trips, checks), one bar per model: *with MCP relative to
  without*, as a signed percentage from a zero baseline. Green ▼ = better with
  MCP, red ▲ = worse. Across prompts the bar is the median of the per-prompt
  effects, so a prompt with many repeats does not outvote one with few.
- **MCP effect over time** — per metric, one line per model: for every day
  that has both cells, the relative difference of the two daily medians. Zero
  is "no difference". A new release of the server moves these lines; a new
  model version moves the absolute values but not necessarily the effect.
- **KPI tiles** — runs, fastest and cheapest cell, and the MCP effect summarised
  over models.

Everything else is one click away under **Details**: dumbbells of the absolute
medians (without → with, per model), absolute trends with / without side by
side (faceted per host — an editor session and a headless run are not one
scale), the stats table (medians, p90, completion rate, AIC source), the
MCP-effect table and every run. `--json` prints the data instead.

## The reference prompts

Three prompts tagged `reference` are the benchmark's standing use-cases. They
were picked from what F&O projects implement most often — the extension types
Microsoft's extensibility guidance and the MB-500 curriculum are built around
(table/form extensions, CoC and event handlers, SysOperation, SSRS) — and from
this server's own demand data: across 1,603 MCP calls mined from real Copilot
sessions (`eval/demand-digest.json`) the top write shapes are new enums,
table-extension fields + field groups, form-extension controls and CoC classes.
Each prompt is a realistic business request that touches several change types
at once, names the objects (so the file checks are deterministic) and leaves
the platform details — control names, signatures, XML shapes — to be found.

| Prompt | Change types | Objects | Checks |
|---|---|---|---|
| `ref-credit-hold-extension` | extensible enum, table extension (fields + field group), form extension, data-event handler, CoC on a standard table, labels | 5 + label file | 6 files + build |
| `ref-vendor-certificate-register` | EDT, enum, new table (index, relation, find/exist, validateWrite), SimpleList form, display menu item, menu extension, 2 privileges, form extension, labels | 10 + label file | 10 files + build |
| `ref-overdue-batch-ssrs` | regular table, SysOperation batch (contract / service / controller / action menu item), TempDB table, RDP SSRS report (contract / DP / AxReport + design / output menu item) | 10 + label file | 10 files + build |

Every reference prompt shares one preamble (model and folders via
placeholders, prefix `Con`, labels instead of text, no `today()`, extensions
only, must build) so the three differ only in the business request.

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
difference means something.

A prompt that writes adds `workspace` and file checks:

```json
{
  "id": "my-write-prompt",
  "prompt": "Work in the model `{{model}}` (metadata folder `{{modelDir}}`; standard metadata under `{{packagesRoot}}`) …",
  "workspace": { "build": true },
  "timeoutSeconds": 1800,
  "expects": {
    "files": [
      { "name": "the table", "path": "/AxTable/ConMyTable\\.xml$", "contains": ["<Name>MyField</Name>"], "notContains": ["\\btoday\\s*\\(\\)"] }
    ]
  }
}
```

`{{model}}`, `{{modelDir}}`, `{{packageDir}}` and `{{packagesRoot}}` are filled
from `--sandbox`; the prompt hash is taken over the template, so the experiment
is the same on any machine. A file check's `path` is a regex over the path
relative to the sandbox package (forward slashes); it passes when a file the
cell added or changed matches the path, every `contains` and no `notContains`.
Name the objects in the prompt — a check cannot find a table whose name the
model was free to choose.

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

For the write prompts, step 3 becomes the sandbox run above (`--tag reference
--sandbox … --mcp-servers …`), and a Copilot session of a reference prompt must
start from the same clean sandbox: restore it by hand before each one.

Open questions to settle there, in order: the `creditsPerUsd` reading against
the real Copilot billing page; whether a with-MCP cell should also get
`--append-system-prompt-file .github/copilot-instructions.md` (it changes what
the model knows about the tools — a fair comparison either gives it to both
cells or to neither); and which prompts deserve a SysTest-backed oracle through
the eval loop rather than regex checks.
