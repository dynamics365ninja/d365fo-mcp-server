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
| `--no-bp` | — | skip the xppbp best-practice check after a clean build |
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
   `Read Glob Grep` plus an **absolute** edit rule for the package
   (`Edit(//k/AosService/PackagesLocalDirectory/fm-mcp/**)`) — in `dontAsk` mode
   it lets the file tools write inside the package and nowhere else (checked on
   the VM: a write next to the package is refused) — and
   `--add-dir <PackagesLocalDirectory>` makes the standard metadata readable, so
   the plain cell can look up CustTable the way a developer without the server
   would. The rule must not be relative: `./**` follows the session's current
   directory, Claude Code runs read-only shell commands such as `cd …; ls`
   without asking even in `dontAsk` mode, and one such `cd` into ApplicationSuite
   got every later sandbox write of a plain cell refused (0 files written).
   Other shell commands are refused: a plain cell cannot run xppc, a with-MCP
   cell builds through the server. That gap is part of what is being measured;
   add `--allowed-tools PowerShell` to close it. Every cell's raw stream is kept
   in `eval/benchmark/artifacts/<runId>/stream.jsonl` (gitignored).
6. **Scores what the cell wrote** — see [Output validity and rework](#output-validity-and-rework).
7. **Restores the package** byte for byte and re-diffs to prove it. Before it
   copies anything back it checks the snapshot against its manifest: a damaged
   snapshot stops the matrix *without touching the sandbox*. (On the VM both
   snapshots then kept under `%TEMP%` lost their `Descriptor` and model folder in
   the same 100 ms, mid-run, from outside the benchmark; the half-done restore
   that followed is why the working folder now lives in `eval/benchmark/.work/`,
   gitignored.) The server build tool's state file in `%TEMP%` is cleared too.
8. **Re-syncs the symbol index** of every selected server for every path that
   moved — the server upserts what it writes into its SQLite index, and the next
   with-MCP cell would otherwise find the previous cell's table in `search`.

The files each cell wrote are copied to `eval/benchmark/artifacts/<runId>/`
(gitignored) before the restore, so a check that turns out wrong can be
re-scored against them — the first reference run needed exactly that: the form
check asked for a bare `<Pattern>`, while AxForm XML writes
`<Pattern xmlns="">SimpleList</Pattern>`. What the permission fence refused
(tool and file name) is noted on the record.

### Output validity and rework

A final "builds clean" answers only half the question. A server that writes
content the model then has to diagnose and repair costs turns, time and credits
on the way, and content can build and still be wrong. So every sandbox cell is
judged on both:

**What it left behind** (checks, and `quality` on the record):

| Check | How |
|---|---|
| files | each `expects.files` entry — path and content regexes over the files the cell added or changed (build output left out) |
| written XML is well-formed | every written `.xml` parses (xml2js) |
| builds clean (xppc) | labels compiled (labelc, as the server's build does), then a full xppc build of the sandbox module; failed when the cell wrote nothing |
| no new best-practice errors (xppbp) | after a clean build, xppbp over the module; a cell is charged only with findings the clean sandbox did not already have (baseline taken once per matrix). After a failed build it fails as "not shown clean" |

**How it got there** (`rework` on the record, from the stream): tool calls that
came back as errors (an MCP result starting `❌` counts), builds inside the cell
— the server's build tool or a shell command that *runs* xppc — and how many
failed, and writes per target (a file, or `objectType:name` for the server's
writes). A **rewrite** is a write that repairs: the target was written before
and something failed since — a build, or that target's previous write. Building
an object in steps (create the table, add a field, add a field group — the
server's normal flow) is not counted; the first version counted every repeated
write and charged the MCP side for its own workflow. A call the host refused is
not a build.

The page's verdict uses **valid output** = builds clean, well-formed XML, no new
BP errors, and **rework per run** = tool errors + failed builds + rewrites.

### Evidence and re-deriving

Each cell's raw stream and the files it wrote are kept in
`eval/benchmark/artifacts/<runId>/` (gitignored). When a parser or a check turns
out wrong after the fact — it has happened twice: a form check that did not allow
`<Pattern xmlns="">`, a build counter that took `ls … | grep xppc` for a build —

```bash
npm run cli -- benchmark rederive --label "reference v2" --dry-run   # what would change
npm run cli -- benchmark rederive --label "reference v2"
```

recomputes the rework trace and the answer and file checks from that evidence
and appends what changed to the record's notes. The build and xppbp checks and
every measured number (time, tokens, cost) are kept as recorded: they need the
sandbox state the restore removed.

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

One self-contained HTML file (works from disk, light/dark, phone width) and a
markdown twin. Filters are command-line flags — `--prompt`, `--host`, `--model`,
`--label`, `--since`, `--until` — and the page has a prompt switcher.

The page follows the question order:

1. **Verdict** — four cards, with MCP against without, over all prompts: *valid
   output* (share of runs), *run time* and *AI Credits* (medians, as a signed
   difference), *rework per run*; each with both values as bars, green ▼ when
   MCP is better, red ▲ when worse; and one sentence that says it ("With MCP, 9
   of 9 runs delivered valid output, against 4 of 9 without; it took 34 % longer…").
2. **Per prompt** — a scoreboard: one row per prompt, the two sides as pills for
   valid output, checks, time, AIC and rework, ✓ on the better side.
3. **MCP effect per model** — one panel per metric, one signed bar per model
   (with relative to without, median of the per-prompt effects).
4. **Each prompt** — a with/without table (valid output, builds, checks, time,
   AIC, round trips, tool errors and the MCP share of them, failed builds,
   rewrites, new BP errors and warnings), a heat strip of every check's pass
   rate per side, and the build/BP errors that recur, counted, positions stripped.
5. **Details** under each prompt — the MCP effect over time, dumbbells of the
   absolute medians, absolute trends faceted per host, the stats and effect
   tables and every run (with build, BP and rework columns).

Cards rise in as they scroll into view, bars grow from zero and the headline
numbers count up; nothing moves under `prefers-reduced-motion`, and every number
is in the HTML without the script. `--json` prints the data instead.

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
