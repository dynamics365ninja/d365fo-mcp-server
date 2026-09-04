# Changelog

Notable changes per release. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions are
[semantic](https://semver.org/) with the caveat noted under *Versioning* below.

This file starts at v1.0.0 (first public release, 2026-07-21). Entries before
2026-08-08 were reconstructed from git history and release tags — they name what
changed and why it mattered, but they are a summary, not an exhaustive log. Run
`git log v1.7.0..v1.8.0` for the complete set.

**Add an entry in the same PR as the change.** Put it under `[Unreleased]`; the
release PR moves the block under a version heading. A change nobody can find is
indistinguishable from one that never shipped — nine releases went out in the
first three weeks with no human-readable notes at all, which is why this file
exists.

## Versioning

Minor versions carry behavioural changes to the MCP tool surface (tools added,
merged or retired; parameter contracts changed). Patch versions are fixes that
do not move that surface. Because the tool surface *is* the API here, a
consolidation that retires a tool name is a **breaking change for any prompt or
instruction file that named it**, even though the version only moves a minor —
those are called out explicitly below.

---

## [Unreleased]

### Changed
- **Workspace detection prints only conflicts.** The four-line
  `Auto-detection successful` block (ProjectPath / ModelName / SolutionPath /
  Source) went to stderr on every start, and VS Code shows every stderr line as
  `[warning]` - four warnings per session on every machine, working or not,
  which made a healthy resolution look like a fault. The routine outcome (and
  the cache-hit, root-match, git-branch and BFS-fallback lines around it) now
  goes to the debug log (`DEBUG_LOGGING=true`); `get_workspace_info` and
  `d365fo-mcp doctor` still report the resolution with its source. What IS
  printed, once per distinct case, is the one state that was never reported
  before: the model named in `D365FO_MODEL_NAME` / `.mcp.json` disagreeing
  with the `<Model>` of the project the workspace scan picked - the state in
  which writes target one model while new files are registered into a project
  of another. Silent when a `projectPath` is configured too, because the
  detected project is unused then. The per-call `Using explicit packagePath`
  line, printed on most tool requests, moves to the debug log as well.
- **The AosService drive scan is bounded.** It probed C: to Z: with one
  synchronous stat per letter, lazily on the first tool call that needed a
  packages path - and a stat on a disconnected mapped network drive stalls for
  the SMB timeout, which is how `get_workspace_info` could hang for tens of
  seconds and then be instant for the rest of the session. C:, K:, J: and I:
  are now probed first and always, the other letters only inside a 2 s budget;
  `D365FO_SCAN_DRIVES` (e.g. `C,K`) pins the probed set. `doctor` and the
  not-found messages name the letters that were skipped and any probe that
  took over a second, so a missed volume is reported rather than silent.
- **The .rnrproj walk skips profile and system folders.** The workspace it
  starts from is whatever the client reported - `process.cwd()` when VS Code
  gives nothing better - and that has been `C:\Users\<user>` itself, where
  five levels of `AppData` is hundreds of thousands of entries walked to find
  nothing. `AppData`, `$Recycle.Bin`, `Windows`, `Program Files`, `ProgramData`
  and the package caches are skipped now, case-insensitively.
- **First-start metadata indexing runs on a worker thread.** With an empty
  symbol database and `METADATA_PATH` set, the server indexes before it
  declares itself ready - synchronously, end to end, and inline on the main
  thread, so every tool call (`get_workspace_info` included) hung for the whole
  build on exactly the machine where the server was being tried for the first
  time. The same build now runs in `startupIndexWorker` on its own WAL
  connection; `dbReady` is still held until it completes, so symbol-backed
  tools keep answering "still loading" instead of returning empty results, but
  the event loop is free and the tools that need no symbols answer at once.
  The worker's console output is routed to stderr (stdout is the protocol
  channel in stdio mode), and a failed build is reported by name rather than
  as "metadata path not accessible".


---

## [1.17.1] — 2026-09-04

### Fixed
- **`install.ps1` failed on every machine without a `K:` drive** (#1010). The
  installer probes `K:\d365fo-mcp-server` for a pre-npm checkout, and Windows
  PowerShell 5.1's `Join-Path` validates the drive and throws
  `DriveNotFoundException` before the npm install ever starts - which is the
  case on a stock D365FO VHD. The `.git` probe now composes the path without
  drive validation; a candidate on a missing drive is simply skipped.

---

## [1.17.0] — 2026-09-03

### Removed
- `docs/XPP_LANGUAGE_COVERAGE_PLAN.md` (the **v4** plan) is **deleted**, under the
  lifecycle rule it carried itself: all phases H0-H6 shipped, core coverage 74/74,
  total 124/124, 0 `golden_pending`, and the full-install validator sweep clean at
  105,686 files with zero error-severity findings.

  The durable record is where it belongs and not in a plan file: the census
  figures are inside the knowledge rules that use them, the rejected options are
  in the source that implements the alternative (`reportDesignXml.ts` explains why
  there is no `add-column` and no provenance fingerprint; the TST rule comments
  explain why they are not what the plan specified), the evidence is in the
  goldens and the two committed SysTest documents of `L2-tdd-red-green-cycle`, and
  the reasoning per phase is in PRs #999-#1006.

  Its non-goals, its measurement-rejected rules, the six eval cases deliberately
  not authored and the one noted-but-unfixed defect moved to `docs/BACKLOG.md`
  rather than disappearing with it. This is the second plan file to go the same
  way; the v3 one was deleted 2026-09-01.


### Added
- **`report-design` — the first write path an AxReport has ever had.**
  `d365fo_file(action="modify", objectType="report", operation="report-design")`
  with `reportAction="refresh-dataset"` (copy the temp table's fields onto the
  report's dataset — the information is on disk, nothing about it is a design
  decision) or `reportAction="add-parameter"` (declare a parameter AND bind it
  to the dataset in one write, because the two elements must agree). New
  parameters: `reportAction`, `tableName`, `datasetName`, `parameterName`,
  `parameterDataType`, `parameterHidden`, `promptString`. Layout stays with the
  Report Designer: there is deliberately no `add-column`, because an RDL error
  surfaces only in the SSRS renderer where no build and no test can see it. The
  operation is metadata-only and additive-only, and that guarantee is a property
  of the operation, not of the file's provenance — a fingerprint that refused
  "foreign" designs was rejected for having the wrong shape.

  It paid for its schema bytes with a measured trim: tool annotations that only
  repeat the MCP spec default (`readOnlyHint: false` on 6 tools,
  `idempotentHint: false` on 4) are no longer sent. `destructiveHint: true` is
  also a default and is kept on purpose: a client that reads absence as
  "unknown" becomes MORE cautious about a missing `readOnlyHint` and LESS
  cautious about a missing `destructiveHint`, and only the first direction is
  safe. ListTools headroom 49 → 251 chars. (PR #1001)

- **`add-field` can write a container field.** `fieldBaseType="Container"` was
  refused as a parameter that changes nothing and `fieldType="Container"` as a
  missing EDT; the C# bridge had handled it since it was written and only the
  TypeScript side never routed to it. A census settled the type question on the
  way: 280 of 332 shipped container fields DO carry an EDT (`Bitmap` is what a
  shipped report temp table uses for a company logo), and typing the field with
  it silences `BPErrorTableFieldNotDefinedUsingType`. (PR #1002)

- **Reports, the runtime half.** `get_knowledge` topics for the report runtime
  API (contracts, print destinations, pre-processing) and for the RDL people
  actually write, from a census over the 961 shipped designs: `IIf` 29,703 uses
  across 775 reports; `Avg` and `Lookup` zero — an aggregation belongs in the
  data provider, where it can be tested. `generate_object(pattern="systest")`
  gains `testTargetType="report-dp"`, and four eval cases were captured from
  clean builds, one of them (`L4-tdd-report-dp`) with a red-then-green run under
  `SysTestConsole.exe`. That red run corrected the case's own premise:
  `assertNotNull(dp.getTmp())` takes `Object`, an empty buffer boxes to null,
  and the assertion tests whether the last select found a row. (PR #1002)

- **SysTest attributes and ATL, both re-derived from usage.** The scaffold takes
  `attributes: string[]` and `arrange: "buffer" | "atl"`; `prepare(mode="test")`
  names the ATL packages a model is missing and what each costs. The catalogue is
  a census of the 884 shipped test classes, and it inverted the plan: the two
  most-used attributes (`[SysTestCheckInTest]` 1,875 uses, `[SysTestGranularity]`
  165) were missing from it, most of what it listed has zero shipped uses, and
  `SysTestSuiteCompanyIsolateClass` — named as THE isolation mechanism — has been
  `[SysObsolete]` since 2014. The ATL tree is read from the AOT
  (`src/knowledge/atlNodes.generated.ts`, 1,105 data classes, 351
  record-producing nodes); 107 of them hand back an `AtlEntity` wrapper that
  needs `.record()`, which the oracle's own header example had omitted. (PR #1003)

- **Six knowledge catalogues written from censuses, and every one got SMALLER.**
  `form-runtime-api` (of `FormRun`'s 209 methods, 49 are ever called through
  `element.` across 9,442 shipped forms; `args()` alone is 92% of platform calls;
  `UpdateDesignMode` appears in zero files), `data-entity-methods` (ranked over
  5,805 entities; `mapEntityToDataSource` outnumbers its "pair" 11 to 1), CoC
  target kinds (`queryStr` has zero shipped uses; `mapStr` and `viewStr`, which
  the plan omitted, both ship), `IncludedColumns` (zero in 18,377 tables),
  relation types and index properties. The censuses H2 and H3 had shipped were
  re-measured first: a hand-rolled `<root>/<pkg>/<pkg>/<AxType>` walk silently
  skipped the 12 model folders not named after their package, ApplicationSuite/
  Foundation among them. `npm run oracle:usage` and `npm run oracle:atl` now walk
  models the way the server does. (PR #1004)

- **H5 breadth: twelve gaps, three validator rules, one refuted claim.** Topics
  `email-sending`, `file-io-write`, `http-json-xml`, `xrecord-buffer-api` and
  eight extended ones. `validate_code` gains **TST001** (`assertExpectedException`
  does not exist; 0 of 66,754 shipped classes), **TST002** (`[SysTestMethod]` in
  a class that extends NOTHING — not "does not extend SysTestCase", because 31 of
  the 56 shipped classes reach it through a chain and the literal rule would fire
  on more shipped classes than it caught) and **TST003** (a test method with no
  `assert*(`, warning; triggered by the attribute, since only 2.4% of shipped
  test methods are named `test*`). Whole-install sweep: 105,686 files, zero
  error-severity findings. An R-only case measured that an `anytype` CAN be
  re-typed at run time, contrary to the folklore. `get_knowledge` topic
  `tdd-workflow` — asked for by the plan, logged as shipped, never written until
  the taxonomy's dangling-id check caught it. (PRs #1005, #1006)

- **`L2-tdd-red-green-cycle` commits the RED run beside the green one**, from one
  uninterrupted cycle on the VM: the assertion failed for the stated reason, then
  passed with only the implementation changed. Every other case commits a green
  document, and a green document alone cannot tell a working test from an empty
  one. (PR #1006)

- **The red-first loop, made findable.** It was complete and unused: across 1,603
  real MCP calls in 47 sessions, `prepare(mode="test")` was called 0 times and
  `run_systest_class` 0 times, while `prepare(mode="change")` ran 54 and
  `d365fo_file(modify)` 195 — and roughly thirty-five of about fifty genuine
  knowledge questions were the table `validateWrite` Chain of Command contract,
  the exact rule the loop was built to test. A feature nobody finds is
  indistinguishable from one that does not exist.

  `prepare(mode="change")` now carries a `### Test first?` section and a write
  that lands X++ on an untested object gets one `> **Untested.**` line. Both cost
  zero ListTools bytes — they are response text, not schema.

  The trigger is BEHAVIOUR, never structure. A testable object family is
  necessary and not sufficient: the deciding signal is the operation, so
  `add-method` and `replace-code` fire and `add-field` on the same table
  extension does not. Adding a field is metadata, its oracle is the golden diff,
  and a SysTest asserting it would only check that the compiler did its job.

- **Three more SysTest shapes** (`testTargetType`: `coc`, `event-handler`,
  `service`, beside `class` and `table`), because they observe the behaviour in
  three different places and the wrong one produces a test that compiles, runs,
  passes and proves nothing:
  - `coc` exercises the BASE class and never names the wrapper — Chain of Command
    is transparent at the call site, so a test that references the `_Extension`
    class passes with `next` never reached. Two inputs, because a wrapper that
    ignores `next` and returns a constant passes a single assertion.
  - `event-handler` performs the write and reads back what the handler changed; a
    handler fires out of band and cannot return a value.
  - `service` calls a SysOperation service directly with a hand-built contract —
    no controller, no dialog, no batch queue.

  All three are promoted from SysTests that actually EXECUTED on the VM
  (2026-08-31, 2/2 each) and were then compiled by
  `scripts/oracles/probes/coverage-v4.ts` — green without a TestEssentials
  reference, which is what the scaffold's own warning promises.

  `prepare(mode="test")` picks the shape and prints the call that selects it, so
  the two halves of the loop cannot disagree. It reduces an extension name to its
  base first, index-verified: the infix between base and `_Extension` is a
  per-model convention, so stripping the suffix alone leaves a name that is not
  an object.

- **ATTR003 — two attributes stacked on a method.** X++ takes several attributes
  on a method only inside one bracket, comma-separated. Two bracketed lines is a
  parse error, and the compiler answers `Invalid token '['` with a column number
  and abandons the whole file — it names a token, not a rule. That is the precise
  opposite of the case that got DECL001 and CONV001 rejected, where the
  compiler's own message was exact and local.

  The exemption is the hard half and it was measured, not reasoned: a census
  found 2,163 shipped AxClass files stacking attributes on a CLASS declaration
  and **0 of 760,583 shipped methods** doing it. Our own knowledge base invites
  the mistake by listing `[SysTestMethod]`, `[SysTestCategory]` and
  `[SysTestPriority]` one under another; both entries now say it is a menu, not a
  stack.

- **The measurement harness the coverage work runs on is in the repo**, after two
  rounds of losing it to a session scratchpad: `npm run oracle:terms` (1,165
  language constructs matched against what the server teaches, checks, writes and
  proves — no D365FO install needed), `npm run oracle:demand` (what callers
  actually ask for, redacted to values the server itself defines because the logs
  hold customer object names), `scripts/capture-golden.ts` (the eval step that had
  no script, with four gates and tests), and `eval/api-members.snapshot.json` over
  a committed list of the API surface.

### Fixed
- **`report-design(add-parameter)` wrote `DataType` where the deserializer drops
  it.** The writer emitted `Nullable, PromptString, DataType`; a census of all
  13,911 parameters in the 1,063 shipped reports puts `DataType` between
  `AllowBlank` and `Nullable` with zero contradicting instances (before
  `PromptString` 3,104:0, before `Nullable` 2,139:0). An element met out of
  sequence is dropped without a word and the build stays green, so a
  `System.DateTime` parameter reached the dialog as a `String` — in the committed
  golden of `L4-ssrs-report-parameters`, too, which was corrected by hand and
  says so in its README. The order is now the shipped one, the tests pin it
  against what the scaffold itself emits, and the `axreport-anatomy` topic
  carries the census and no longer claims the operation does not exist.

- **`add-parameter` wrote half a parameter and called it success.** The
  declaration was written BEFORE the dataset was resolved; when no dataset could
  be found (several datasets and no `datasetName`, a wrong name, a self-closing
  `<Parameters />`) the reply was ✅ "bound it to dataset '(none — no dataset
  resolved)'", and the retry with the right name hit the "already declared"
  guard, so the parameter could never be bound at all — the exact half-write the
  operation exists to prevent. Both insertion sites are now resolved before the
  first byte is written, an unresolved dataset is an error that writes nothing,
  and a parameter left declared-but-unbound by the old version is bound on the
  next call rather than refused. Also: `promptString` is XML-escaped,
  `parameterDataType` must look like a .NET type name, inserted elements take
  the closing tag's line instead of doubling its indentation, and
  `refresh-dataset` drops the memoised table listing before looking the temp
  table up, so one created a moment ago is no longer "not found on disk".

- **ATTR003 fired on a legal class-level attribute stack** whenever a comment
  sat between the attributes and `class`. `maskStringsAndComments` keeps the
  comment opener and blanks the rest, so a `///` line comes back as `//` and
  spaces: the `startsWith('///')` skip never matched, `//` and `/* */` lines were
  not skipped at all, and the comment became the "declaration". Shipped code
  puts its doc comment above the attributes, which is why the 105,686-file sweep
  was clean. TST003 had the same skip and silently did NOT check a test method
  behind a comment; both share one masked-line helper now.

- **TST002 reported `extends nothing` when the `extends` clause sat on the next
  line.** The header regex stopped at the newline; it now runs to the opening
  brace.

- **`testTargetType` was invisible.** It shipped in 1.16.0 as the selector for the
  table test shape and was absent from the `pattern` mode's op-spec `optional`
  list — and since these parameters are deliberately kept off the wire schema, the
  op-spec is the only place they are documented. The mirror image of the failure
  this repo has twice paid for, where an error demanded a parameter the caller had
  no way to send.
- **`docs/ARCHITECTURE.md` claimed 40 validator rules** and listed their ids, for
  months after the count was 50 — it had missed two entire coverage waves
  (COC006, BP005, DOC001, OP001, SET001, RPT101/102, XML008-010). A stale roster
  is worse than none: it is what a reader consults to decide whether a check
  already exists, so the answer it gives sends them to write a duplicate.
  `tests/tools/validatorRuleInventory.test.ts` now derives both sides.
- **Seven coverage-taxonomy notes claimed a case did not exist** when it had been
  captured on 2026-08-31, so `eval/COVERAGE.md` rendered a green row beside a
  sentence saying the proof was missing. The existing gate only knew the word
  "pending"; these said "No case yet", "no captured case yet", "is the one to
  author". The gate now matches future-tense phrasings, and was verified against
  the pre-fix taxonomy.
- **Two testing topics that both explained SysTestCase** and disagreed about the
  naming convention. The base is read one topic at a time, so a contradiction
  between two of them is invisible to the reader. `unit-testing` is now
  authoritative and absorbed the two facts only `testing` had — that
  `[SysTestTarget]`'s second argument is the element TYPE, and the ATL entry
  point; `testing` keeps the one question it uniquely owns, which kind of test to
  write at all.

### Changed
- Dependencies: `@biomejs/biome` 2.5.11 → 2.5.12, `@types/node` 26.4.0 → 26.4.1,
  `tsx` 4.23.12 → 4.23.13 (30 lockfile entries, no major). `npm update` on
  Windows had dropped the two Linux `@biomejs` optional-dependency entries from
  the lockfile, which broke `npm ci` on the Linux CI runners; they are restored.
  (PR #1007)


---

## [1.16.2] — 2026-09-01

### Fixed
- **The installed server would not start: `ERR_MODULE_NOT_FOUND` on
  `dist/eval/oracle/systest.js`.** `run_systest_class` reads per-method results
  out of the XML document SysTestConsole writes, and since the TDD-loop work it
  imported that parser from the eval oracle — `src/eval/oracle/systest.ts`.
  But `src/eval/**` is a dev-only tree that package.json keeps out of the
  published tarball (`"!dist/eval/**"`), so every `npm i -g d365fo-mcp` got a
  `sysTestRunner.js` importing a file that is not there, and the MCP server died
  on load with the whole tool surface gone.

  Nothing in the repo could see it: typecheck, lint and the test suite all
  resolve against `src/`, where the excluded tree is present. It only exists in
  the tarball.

  The parser moved to `src/tools/sdlc/sysTestXml.ts` — beside the runner that
  loads it, inside a published tree — and the eval oracle re-exports it, so the
  dependency now runs eval → tools and never back. The published `files` list is
  unchanged; the eval tree stays out.

  `tests/packaging/publishedFiles.test.ts` now walks the import closure of every
  packed `dist/**/*.js` and fails on any specifier that resolves to a file the
  tarball excludes, so the next tree cut out of the package is covered too, not
  just this pair.

---

## [1.16.1] — 2026-09-01

### Fixed
- **`d365fo-mcp setup` died on a database lock it took out on itself.** Opening an
  existing large index hands the deferred `file_path` index builds to worker
  threads, and each worker opens its own *write* connection to the same file.
  `build-database` then sets `locking_mode = EXCLUSIVE` on the writer, which
  cannot coexist with a second writer — whoever lost the race failed with
  SQLITE_BUSY, on a machine where the build had already run for minutes. The
  script did call `closeReadPool()` first, exactly as that method's doc comment
  instructs, but the pool is not the only other connection the class opens: it
  drains readers and knows nothing about the workers.

  Three separate things were wrong and all three are fixed:
  - `XppSymbolIndex` takes `{ backgroundIndexBuilds: false }`, and both
    `build-database` and `build-fts` pass it. The worker exists to keep the
    server's event loop answering; a one-shot CLI has no event loop to protect,
    so it builds inline on the connection that already holds the lock.
  - The worker dispatch no longer *assumes* WAL — it checks `journal_mode` and
    refuses to spawn off it. Build scripts switch to `journal_mode = MEMORY` two
    steps later, where a second connection cannot work by construction, so the
    race is now closed even if a future caller forgets the flag.
  - `closeReadPool()` documents what it does not cover and warns on stderr when
    it is called with index builds still running; `close()` tears them down.

  Deliberately not fixed by raising `busy_timeout` (masks the race) or by
  retrying `createFTSTriggers` (one of many places that hit the same lock).

### Changed
- Build scripts defer the `file_path` indexes past their bulk load
  (`{ deferFilePathIndexes: true }`) and build them once at the end. Every row of
  the load previously maintained two extra B-trees, and a full rebuild threw the
  result away in `clear()` anyway.
- `XppSymbolIndex` accepts a `largeDbThresholdBytes` override. The existing tests
  could not have caught this bug: they run on databases far below the 200 MB
  threshold, where the worker never starts. With the threshold injectable, the
  worker path is reachable in a unit test — and the new tests fail against the
  old code.

---

## [1.16.0] — 2026-09-01

### Added
- **TDD for a TABLE method — the loop's most-asked task had no red-first path.**
  Across 1,593 real MCP calls the single most-requested X++ topic was the table
  Chain of Command contract (`validateWrite`, where `next` goes, `checkFailed` vs
  `error`, `orig()`): roughly thirty `get_knowledge` calls were variations of that
  one question. Both `prepare(mode="test")` and
  `generate_object(pattern="systest")` resolved **classes only**, so the rule a
  developer most wants to pin down could not be tested through the server at all.
  `prepare(mode="test", objectName="CustTable.validateWrite")` now resolves
  tables (dotted form included) and emits the scaffold call with
  `testTargetType: "table"` already set. The scaffold arranges a buffer with
  `initValue()`, asserts the boolean verdict **and** the infolog line the rule
  writes, and adds the ACCEPTING case beside the rejecting one — without it a rule
  that refuses every row passes its own test. Write methods get a transaction and
  a re-read from the database. Compiler-verified before it was written
  (`UtilElementType::Table`, `assertExpectedInfoLogMessage` after the act), and it
  costs no ListTools bytes: the parameter lives in the op-spec.
- **Six knowledge topics for constructs nothing could measure**: `lookups`,
  `global-class-statics`, `system-objects`, `report-print-destinations`,
  `document-attachments`, `rdl-design-expressions` — plus extensions to
  `query-object-model` (range vs filter on an outer join, the range expression
  language, `[QueryRangeFunction]`), `sysoperation` (the packed query parameter),
  `bp-rules` (`SuppressBPWarning`), `deprecated` (the RunBase lifecycle and its
  `#CurrentVersion` bump) and `ssrs-rdp-preprocess` (`AX_RdpPreProcessedId`).
- **The oracle harness is in the repo** (`npm run oracle:sweep|census|probe|members`).
  The census, the validator sweep and the xppc probe harness had lived only in
  session scratchpads: the measurements behind the compiler-verified wave could
  not be re-run. `--dry` runs the sweep against `tests/fixtures/oracles` so CI can
  hold the zero-error bar with no D365FO install.
- **The runtime oracle runs, and it discriminates.** X++ test code had never once
  executed in this project: `SysTestConsole.exe` stopped at `Login failed for user
  'AOSUser'`, diagnosed twice as a rotated credential and twice wrong — the shipped
  `SysTestConsole.exe.config` had simply never been configured for the machine. With
  the four `DataAccess.*` values copied from the AOS's own `web.config`, the runner
  opens a real AOS session. A passing run only proves the instrument is on, so a
  negative control was built and run in one pass: a deliberate assertion failure and
  a deliberate throw come back **failed** beside a passing method, and
  `parseSysTestXml` reports all three. That real failing document is committed as
  `tests/fixtures/systest/negative-control.xml` — every earlier parser test used
  synthetic XML, which only proves the parser handles what its author imagined.
  All twelve remaining goldens and every runtime-tagged case have since run:
  **0 of 120 cases are `golden_pending`, 0 are `systest_pending`**, both for the
  first time.

### Fixed
- **Thirty-one defects the golden-capture runs found, and a green 5,700-test suite
  could not.** Each eval case was implemented on the VM through the grounded tool
  path, which is the only thing in this repo that compares INTENT against OUTPUT;
  the test suite compares code against expectations someone already held. Twenty-one
  runs across the wave, and the passes are the least interesting part — these are
  the defects the runs produced on the way:
  - `create(class)` **silently dropped every multi-line method attribute block**.
    Attributes are syntactically optional, so xppc and xppbp stayed green — a data
    contract with no data members, a SysOperation dialog with no fields, and no
    message anywhere. It had already corrupted a committed golden
    (`L3-sysoperation-dialog-attributes` contained none of the five attributes its
    own README describes); that golden is removed and queued for re-capture, and a
    blast-radius audit confirmed it was the only one.
  - A member list **renamed methods out of existence**: the completion formatter
    printed the signature instead of the name, so `SysQuery::range` appeared as
    `#ISOCountryRegionCodes` and `RunBaseBatch.dialog()` as a doc-comment sentence.
    Runs concluded the APIs did not exist and worked around them.
  - `search(type="report")` **did not filter to reports** — the bridge's type map
    has no entry for that kind, so the query ran unfiltered and answered with
    tables and queries. Now enforced adapter-side, for every unmapped type.
  - `validate_code(mode="references")` reported **code that compiles** as errors:
    kernel enums (`AccessType`, `MenuItemType`, `JoinMode`) and a class calling its
    own statics — the only spelling X++ accepts. With `GROUNDING_ENFORCE` on, both
    would have refused the write.
  - `get_object_info(form, searchControl)` **did nothing**: implemented on the XML
    path while the bridge answers first, and every existing test used the
    explicit-`filePath` branch, which returns before the bridge.
  - `create(class)` doubled the prefix on any `_Extension` name already carrying
    one, making `SysQueryRangeUtil_Extension`-shaped names unreachable.
  - Two refusals **named a parameter the caller cannot send** (`query` on
    bp-moniker search, `baseObjectName` on `prepare`).
- **Five knowledge errors, all written in this same wave**, caught by the first
  independent use of the topics: `attachFile` takes nine arguments, not eight, and
  the short call compiles while storing the notes as the attachment name;
  `registerOverrideMethod` lives on the concrete `FormStringControl`, not
  `FormControl`/`FormReferenceControl`; `SysTableLookup` *does* have
  `addLookupMethod` (inherited); `infolog.num()` and `setPrefix` are not where the
  entry said to look for them; and RunBase needs `canRunInNewSession()` plus a
  retained `#CurrentList<n>` — "bump the version" alone makes saved batch jobs stop
  running rather than run wrong.
- **The lesson behind most of them:** "it compiles" is not "it is correct". The
  `attachFile` error came from a probe that passed eight arguments and built clean.
  For a call with optional tail parameters the compiler cannot answer the question
  being asked; read the signature and count. Now stated in the probe harness.
- **Seven validator false positives on Microsoft's own X++**, found by the first
  full-install sweep (105,686 files, 615 MB): `ATTR001` on an attribute argument
  carrying an inline comment (72 hits), `SEL010` on `validTimeState` used as an
  ordinary method name in the SysDa API (14), `FN001` on `new Info()` and on a
  local function shadowing a predefined name (7), `CS001` on a C#-looking type the
  file legally aliased with `using string = System.String;` (3, and 448 shipped
  files use that form), `COC003` on the lower-case `_extension` suffix the
  platform itself ships (1), `RPT001` on an abstract DP base class (1), and
  `SEL008` reading a select across a `#localmacro` boundary (1).
- The shared X++ lexer had **no tests**, which is how its documented "delimiters
  survive" contract could be false for `*/` without anyone noticing — the reason
  the `ATTR001` fix initially matched nothing. 16 tests now pin the behaviour.
- **The scoring oracle could diff a form against the menu item that opens it.**
  `resolveActualFile` matched on a lossy logical key with `find()` — first match
  wins — and `artifactKey` strips the `.Ax<Type>` infix, so a golden folder holding
  a form and its display menu item reduced both to one key. Swept over all 119
  committed golden folders: 10 artifacts mispair under canonical capture naming and
  18 under the other assignment of the undecorated filename, 8 of them outright
  cross-pairings — two unrelated objects compared against each other, or one
  artifact silently vanishing from the run. Pairing now resolves in three ranked
  stages (the golden's own filename, type-CHECKED · the identity each document
  DECLARES plus its root element · the legacy key with ties broken by type), and an
  undecidable pairing is **reported and scored missing, never guessed**. In the same
  pass: `canonicalizePrefix` could not see a prefix used as an INFIX, which is
  Microsoft's own `{Base}{Prefix}_Extension` convention — a differential sweep over
  326 golden files x 5 prefix specs shows that silently cost 7 golden folders, and a
  collision sweep over 7,095 identifiers adds no new collision. The fix proposed for
  this eight weeks ago in a corpus record was measured here and does **not** work.
- **Capture runs recorded `generated_artifacts: []` for eight weeks.** The CLI's
  golden-pending branch kept a private "what counts as an artifact" filter
  (`*.metadata.xml`) while the resolver accepted both shapes, and a capture points
  `--actual-dir` at an AOT folder, which holds bare `<Name>.xml`. One shared filter
  now, and the list is printed.
- **A golden captured before the writer documented classes can never match.** The
  create path started injecting a class-level `///` block in August; goldens
  captured in July could not be reproduced by any faithful re-run — 34 of the 159
  goldens carrying a class or interface `<Declaration>` have no doc comment, 32 of
  which the writer would inject into. The presence signal is **directional** now: a
  doc comment on the ACTUAL side only compares equal
  (`BPXmlDocNoDocumentationComments` fires on ABSENCE, and the content was already
  canonicalised to a placeholder), while one present in the GOLDEN and missing from
  the actual still fails — that is a real regression. Replayed over the whole
  corpus, this and a symmetric blank-line rule resolve 14 real false-mismatches
  across 69 stored `changed` entries and suppress nothing else. Deliberately not a
  batch re-capture: each case refreshes its own golden the next time it runs.
- **Report goldens were unreproducible by construction.** An AxReport carries its
  RDL inside CDATA and the RDL carries `rd:DataSourceID` / `rd:DataSetID` /
  `rd:ReportID`, minted afresh on every generation — text inside a payload, which a
  case's `ignore` globs cannot reach. Six committed goldens carry them. Masked at
  comparison time only; the stored artifact is never rewritten and a real design
  change still fails.
- **The report scaffold made a temp table's first column unique.**
  `buildPrimaryKeyIndex` always emits a unique index and the report path handed it
  `tableFields[0]` — which under `designStyle="GroupedWithTotals"` is by
  construction the GROUP key, so the second row in a group failed on a duplicate key
  at RUN time, from metadata that builds clean. A report temp table has no natural
  key; it is `RecId` now, confirmed on live scaffold output.
- **A corpus record had been silently dropped since July.** A writer put Windows
  paths into JSON without escaping the backslashes, so a strict parser rejected the
  whole document — and `loadJsonRecords` skips an unparseable file without a word.
  A record classified `TOOL_DEFECT` was therefore invisible to every cluster, report
  and held-out check for eight weeks: the improver had been ranking failures over a
  corpus it did not know was short. Repaired by **escaping only** — the separators
  the original writer dropped are not reconstructed, because guessing them would
  turn damaged data into something that reads as evidence.
  `tests/eval/corpusRecordsParse.test.ts` now fails on any unparseable record, and
  asserts the corpus is of real size so a broken path cannot make it pass forever.
- **A root element could be read out of an XML comment** (CodeQL,
  `js/incomplete-multi-character-sanitization`, 2 high). `aotRootElement` found the
  root by `replace()`-ing the prologue away, and a single-pass strip leaves an
  unterminated `<!--` in place — so the type deciding which golden pairs with which
  file could come out of a comment. Replaced with an ordered token scan; ordered
  alternation alone was not enough, which the new test caught before it was pushed.
  `tests/eval/oracleScoringIntegrity.test.ts` carried its own copy of both readers
  (the second alert) and imports the shipped ones now, so it cannot drift from the
  code under test.
- **Two `js/regex-injection` findings in the oracle CLIs** (high, CodeQL):
  `census.ts --grep` compiled its argument as a regex and is a literal substring
  match now; `xppcProbe.ts` interpolated a probe's class name into a regex, and the
  name is validated as an identifier before use. Testing that guard is what made it
  worth doing — the first version captured `Bad` out of `class Bad.Name`, a valid
  identifier producing an artifact whose `<Name>` disagrees with its own source,
  which is exactly the silence the harness exists to prevent.

- **An enum whose members were all 0 — and nothing said so.** `create(enum)`
  suppressed every explicit `<Value>` whenever the resolved mode was
  UseEnumValue=No, on the premise that "plain 0,1,2 numbering states nothing the
  order does not". The premise is false: an `<AxEnumValue>` with no `<Value>` is
  **0**, not the next ordinal. A four-tier ladder came out with None = Silver =
  Gold = Platinum = 0, compiled with 0 errors, passed xppbp and matched its golden,
  while `enum2int()` returned 0 for every tier — the runtime oracle is the only
  thing that could see it (2026-08-31, `L3-enum-field-form-downgrade-guard`,
  "expected False, actual True"). Every member now carries its number, the 0
  excepted, which is the shape the serialiser and all 3,913 shipped AxEnum files
  use. Two claims went with it, both checked rather than reasoned about: a census
  of shipped metadata (of 3,818 multi-member enums, exactly six omit `<Value>`
  everywhere, and all six are extensible) and an xppc probe on the VM —
  `IsExtensible=true` + `UseEnumValue=No` + non-positional values **compiles
  clean**, while the same enum with `UseEnumValue=Yes` fails with the documented
  message. So the knowledge entry's "an explicit `<Value>` forces UseEnumValue=Yes
  at compile time" was wrong, the refusal built on it is gone, and the one pairing
  xppc really rejects is the only one still refused.
- **A delete action that read as Cascade on disk and as nothing to the platform.**
  The XML writer emitted `<AxTableDeleteAction>` as Name → Table → DeleteAction,
  a shape copied from a C# object initialiser. All 126 entries Microsoft ships are
  Name → **DeleteAction** → Relation → Table, and the metadata deserializer drops
  a misordered element in silence — so the provider read the entry with
  DeleteAction at its default and the next bridge-backed `Update()` serialised it
  back without the element. The 2026-08-31 run recorded this as "the bridge
  destroyed the delete action"; the bridge only wrote back what it had been able
  to read. Canonical order now, `<Relation>` supported (`deleteActionRelation` —
  without it xppbp reports BPUpgradeMetadataDeleteAction), and re-sending the same
  action with a different type **rewrites it in place** instead of answering
  "already present — skipped", which is what left the run with no forward-only
  repair path at all.
- **A create scheduled its provider refresh before its own last write.** The table
  property reconcile patches the file on disk after the bridge create, but the
  refresh was requested *first*, so the provider rebuilt from the pre-patch bytes
  and the next modify's `flush()` saw a refresh newer than its own request and did
  nothing. The first bridge-backed `Update()` then wrote the cached copy over the
  patch — reproduction 1 of the same run (`CacheLookup=None`, gone). The refresh
  now happens after the last byte the call writes.
- **One object, three different names.** `create(class, xmlContent=…)` applied the
  model prefix to the file name and to the X++ declaration but not to the metadata
  `<Name>`, reported "Created" plus "Verified: on disk", and the next build died
  with "must be named X instead of Y to be consistent with its file name". The
  prefix rewrite now covers `<Name>` too, and a last gate before the write refuses
  any document whose file name, `<Name>` and declaration disagree — a build cycle
  earlier, and with all three spelled out. (The declaration is read through the
  shared X++ lexer: the first version matched the word "class" inside a `///`
  comment and refused correct creates, which the full suite caught the same hour.)
- **`CacheLookup=None` was an element the platform never writes** — and the entry
  that said otherwise cost two defects pointing opposite ways. The omitted-default
  table named `NotInTTS` as the value the AxTable serialiser leaves out. It is
  `None`: reflection over `Microsoft.Dynamics.AX.Metadata.Core.dll` gives
  `RecordCacheLevel.None = 0`, the .NET type default, and the census agrees — of
  the 1,444 `<CacheLookup>` elements in 6,995 shipped tables **not one says None**
  (Found 758 · NotInTTS 301 · FoundAndEmpty 209 · EntireTable 176), while 95 of the
  231 shipped Transaction tables carry no element at all, which IS None. So a
  create asking for `None` had an element patched in that every later metadata
  round trip normalised away again — the behaviour the 2026-08-31 run recorded as
  "a bridge modify destroys properties this server wrote" — and a create asking for
  `NotInTTS`, a real non-default value, was told it had been honoured and got None.
  Found by the verification run below: the new preservation guard fired on it, and
  a guard firing on a non-event is how the wrong default came to light. The guard
  now ignores any value whose absence means the same thing, so it cannot cry wolf.
  The other seven entries in that table were checked against the same census and
  are correct.
- **Two guards, because the class of defect matters more than the three
  instances.** Every bridge-backed write now compares the file before and after:
  a top-level property that vanished without being asked about is put back, in the
  position it held, and said so in the response. And "✅ Verified: on disk" is no
  longer the only claim a write makes — where the operation names an unambiguous
  result (a modify-property value, a delete action's type, an enum member's
  number), the value is looked for in the file that was actually written, and its
  absence is reported as a failure instead of a byte count.

### Changed
- Five new validator rules: `XML008` (an `AxTableExtension` carrying `<Methods>`,
  which the deserializer drops silently), `XML009` (a control bound to a field
  group the table does not declare — a full build catches it, an incremental build
  does not), `DOC001` (a bare `&` or `<` in a `///` comment → `BPXmlDocMalformed`;
  a **warning**, because Microsoft ships it too), `SET001`
  (`update_recordset`/`delete_from` with no `where`) and `OP001` (`&&` mixed with
  `||` unparenthesised — they have equal precedence in X++, unlike C#).
- Coverage fell to **core 90.8% / total 91.7%** mid-wave and finished at **core
  100% (65/65) / total 109/109**. Nine leaves were added for constructs the
  artifact-indexed taxonomy had no way to count, each starting `golden_pending`,
  and the number climbed one captured golden at a time. It was never 100% for those
  constructs before; there was nothing to count.
- Two standing claims in the docs were false and were quietly steering work: that
  the runtime oracle had never executed because `SysTestConsole.exe` gates on an
  interactive console (it does not — that was configuration drift), and the eval
  README's standing "capture the pending goldens" queue. Both closed. One survivor
  is left alone as out of scope: `src/server/serverMode.ts` still repeats the
  interactive-console claim in a tool-tiering rationale, where the tiering decision
  is unaffected but the sentence is wrong.
- `docs/XPP_LANGUAGE_COVERAGE_PLAN.md` is **deleted**, under the lifecycle rule it
  carried itself: the capture it was waiting on is done. The durable record is
  `eval/COVERAGE.md`, `eval/README.md`, the goldens' READMEs and this entry; its
  non-goals and still-open decisions moved to `docs/BACKLOG.md` rather than
  disappearing with it.

### Known issues
- `L3-warehouse-work-slice` has a captured golden and `build: 1`, but its corpus
  record still carries `bp_clean: null` — BP never ran for it. A small, real gap,
  named rather than papered over.
- Four defects the verification runs found or re-confirmed are **open, with
  issues**, all in the form/scaffold path and none of them touched by this
  release: the scaffold writes explicit child controls under a `<DataGroup>`-bound
  group, which its own `add-control` op-spec refuses (#977); `generateControls`
  changes nothing and the reported control count is not the number written (#978);
  `get_object_info(form)` hides the children of such a group, reporting 14 controls
  where the XML holds 16 (#979); and every scaffolded form starts BP-dirty because
  the tab captions are raw text (#980).

### Verified on the VM
All three write-path defects were re-run end to end through the grounded tool
path on the sandbox model, against a server running this build:

| Case | Score | What it proves |
|---|---|---|
| `L3-enum-field-form-downgrade-guard` | build 1 · golden 1 · **systest 3/3** | One `create(enum)` call — no `useEnumValue`, no `modify-enum-value` repair — wrote `<Value>1/2/3</Value>` and the runtime downgrade guard passes. The runtime oracle was the only thing that could ever see this defect. |
| `L2-event-handler-basic` | build 1 · golden 1 · **systest 2/2** | `create(class, xmlContent=…)` canonicalised all three identities instead of writing three different ones; the build that used to die with the naming-consistency error is 0 errors. `golden_match` is 1 against the untouched 2026-07-01 golden, which retires the plan to re-capture the seven other pre-doc-comment class goldens. |
| `L4-headerlines-document-slice` | build 1 · golden 1 | `<DeleteAction>Cascade</DeleteAction>` read back intact after the write, after **two** further bridge-backed `Update()` calls on the same table, and after a full rebuild — no guard needed, the ordering fix is a root fix. `BPUpgradeMetadataDeleteAction` is gone. The golden was re-captured from that build, so the two lines the fix PR had hand-repaired are now real captured bytes. |

Each run rolled the sandbox back and left a corpus record
(`eval/corpus/runs/2026-09-01T06__*__0fba518.json`).

---

## [1.15.0] — 2026-08-30

### Added
- **The TDD loop for X++: `prepare(mode="test")` and a red-first SysTest scaffold.**
  The server could teach SysTest and run a class; it could not help write one, and
  part of what it taught was an API the platform does not have.
  `generate_object(mode="pattern", pattern="systest")` now emits a `SysTestCase`
  subclass with one `[SysTestMethod]` per named method, each ending in
  `this.fail(...)` so the first run is red on purpose — a scaffolded test that
  passes before the behaviour exists has proven nothing about the assertion inside
  it. Only verified API is emitted (the second argument of `SysTestTarget` is a
  `utilElementType`, an expected exception is declared with
  `parmExceptionExpected`, and there is no rollback attribute because rollback is
  the default); the generated class compiles under xppc 7.0.7996.33 with 0 errors
  and 0 warnings. `prepare(mode="test")` answers in one call what used to take
  three tools and a guess: the methods worth covering with their real signatures,
  the test classes that already cover the target, whether the model references
  `TestEssentials`, the scaffold call, the red-first order and a grounding token.
  Its index lookup cost one measurement to get right — `parent_name = ? COLLATE
  NOCASE` cannot use the index on that column, so it degraded to a full scan of a
  2.5 GB table (74 s cold); plain equality with the existing nocase fallback is
  ~1 ms.
- **Ten more `validate_code(mode="syntax")` rules, taken from real compiler
  diagnostics** — static set 30 → 40. Each exists because xppc answered a probe,
  and each quotes that message in its fix text so the developer reads what the
  build would have said: `FN002` (a predefined function this platform removed —
  `corrFlagGet`, `dateMin`, `int2Enum` and friends read as AX 2012 habits),
  `BP006` (`pause`/`window`/`tableLock`/`changeSite`, which the compiler reports
  only as `Invalid token '10'`), `MAC001` (`#define X(1)` defines nothing),
  `SEL008` (order by / group by after the where of the same segment), `SEL009`
  (`in` with an inline container literal), `SEL010` (a select expression on a
  buffer whose name differs from its table), `ATTR001` (a non-literal attribute
  argument), `ATTR002` (`[SysObsolete]` without all three arguments), `EXT001`
  (a non-static extension-method class) and `KW001`. All ten were swept over
  7,649 shipped `AxClass`/`AxTable`/`AxForm` files — 51 MB of compiling X++ —
  and the sweep ends with zero error-severity findings.
- **Knowledge written from compiler probes rather than memory:**
  `runtime-functions` (~170 predefined functions by category with the argument
  counts the compiler stated, including the optional trailing parameters the
  language reference presents as fixed, the four variadic ones no arity rule may
  police, the five AX 2012 names that are gone and the four reported obsolete),
  `form-event-handlers` (built from the platform's own handlers: the sender of a
  `[FormEventHandler]` is `xFormRun`, not `FormRun`), `args-object`,
  `display-edit-methods`, `sysoperation-ui-attributes`, and three techniques for
  extending a report that already ships. Writing them disproved two things this
  repo already said — among them `xpp-class-rules`' claim that `display static`
  compiles, which came from a probe whose method name did not match its XML
  entry, so the body was never compiled.
- **Nine coverage leaves for the language surface the artifact taxonomy hid.**
  The old taxonomy asked whether the server can create each kind of AOT object,
  and the answer was yes for all 51 core leaves; it never asked whether the server
  knows what the **compiler** accepts inside them — which is where this wave found
  twenty-two wrong knowledge rules and five false-positive validator rules. Adding
  the question dropped core coverage to 86.4% on purpose before the VM goldens
  took it back to 100% (59/59); total closed to 100/100 once the mobile-app
  goldens were captured at the end of the cycle (see *Fixed*).
- **`object_patterns(domain="mobile-app")` — warehouse-app screen recipes, and the
  framework choice they hang on.** D365FO builds the SAME mobile device screens
  with **two frameworks**, and picking the wrong one is a rewrite rather than a
  refactor: `ProcessGuide` (current — controller → step → page builder → data
  processor → navigation agent → action, each one an extension point, and no
  `WHS` prefix because production and inventory flows use it too) and the legacy
  `WHSWorkExecuteDisplay` hierarchy (one `displayForm()` per `WHSWorkExecuteMode`
  that processes input, runs logic, increments the step and builds the next
  screen). Both are instantiated by `SysExtension` off the same attribute, so the
  only way to tell which owns a flow is what the registered class derives from —
  the new domain's list view leads with exactly that, then offers 7 recipes:
  `processguide-flow` (create a flow), `processguide-page-control` (add a control
  to a standard screen), `processguide-page-replace`, `processguide-step-insert`,
  `app-step-identity` (the step ID, icon and title the app shows — the step ID is
  the control name of the screen's primary input), `legacy-workexecutedisplay`,
  and `gs1-scan-input`. Each ships copy-ready X++, and every skeleton is run
  through the offline BP validator in CI — a template that emits BP-failing X++
  is worse than no template. The addition was paid for inside the same schema
  (redundant prose trimmed), so the ListTools budget is unchanged.
- **Knowledge topic `process-guide-framework`.** The class model and its traps:
  registration is by attribute, so a class with the right base and no attribute
  compiles and never runs; the base marks a screen complete on OK alone, so a
  screen that collects a value without overriding `isComplete` moves on before
  its validation ran; inserting a step means re-pointing BOTH edges of the route;
  an exception is the framework's rollback, not yours to catch.
- **Four eval cases for the mobile surface**, one per framework plus the two
  scanning halves: `L3-processguide-flow-slice`, `L2-processguide-page-control`,
  `L3-legacy-workexecutedisplay-extend` and the reframed
  `L3-warehouse-scan-resolve-slice`. All four were captured on the VM before this
  release shipped — see *Fixed*. A new VM-free gate,
  `tests/eval/mobileAppCaseGrounding.test.ts`, executes each case's own grounding
  calls and asserts the answer names what the case then asks the implementer to
  write — a case whose ground truth is missing now fails here instead of on the
  VM after a paid run. Coverage taxonomy gains `warehouse-app-screens`, the
  second of the two leaves this release adds to the closure queue.

- **Warehouse-scanner knowledge pack (SCM audit).** D365FO drives barcode
  scanners through Warehouse management, and the base was silent on it: querying
  `get_knowledge` for `barcode`, `gs1` or `scanning` returned *"No matching
  knowledge entries found"*, `item barcode` returned the **menus** topic (the
  token `item` hits the keyword `menu item`), `license plate` returned ISV
  **license codes**, and `scanner` returned **Electronic Reporting** — `scoreEntry`
  credits `token.includes(keyword)` and "scanner" contains "er". A wrong topic
  reads as authoritative, so this was worse than a gap. Two new topics close it:
  `warehouse-mobile-app` (the warehouse app is a stateless container protocol, not
  a form: screen state travels in the round-tripped payload and never in member
  variables; menu items and app steps are configured data, not AOT elements; work
  is posted through the work-execution hierarchy or it loses its undo) and
  `barcode-scanning` (printing and scanning share no code; a scan resolves through
  the barcode setup, never against `ItemId`; GS1-128 is parsed application
  identifier by application identifier with the FNC1 separator, never sliced at
  fixed offsets; a GTIN carries unit and pack quantity; an unresolved scan is a
  business case, not a throw). `warehouse-mobile-app` also covers the half that
  makes a scanner a scanner rather than a parser — it reads a code and then DOES
  something: what runs is chosen by the menu item's mode and activity
  (configuration, so "the scanner does nothing" is a setup question before it is
  an X++ one), the action must complete inside the one server call that received
  the scan (a device that walks out of range mid-conversation must not leave a
  half-posted document), it must be idempotent with the guard inside the
  transaction because devices retry and operators re-scan, and it ends in a
  document posted through the journal/posting framework rather than a raw insert.
  `warehouse-management` lost its one vague mobile
  line — it named a flow class that the audit could not confirm — and now points
  at both. Routing is pinned by regression tests, in both directions: the scanner
  queries above must land on the new topics, and the neighbours they used to be
  answered by must keep their own.
- **Eval case `L3-warehouse-scan-resolve-slice`** — GS1-128
  application-identifier parse, item-barcode resolution restricted to input codes,
  batch/serial applied through the `InventDim` find-or-create API, and the action
  itself: an inventory movement journal posted through the journal framework in a
  single transaction, idempotent on the action key. Fixed-offset slicing, an
  `ItemId` string compare, a raw `InventDim` insert, a direct journal-transaction
  insert and an idempotency guard outside the transaction each fail the case.
- **Coverage taxonomy leaves `warehouse-mobile-scanning` and
  `warehouse-app-screens`** (w2 each, total tier). The scanner half of WHS was
  uncovered while looking covered under `warehouse`, whose case exercises
  wave/work creation only; the screen half was not modelled at all. Both leaves
  are honest gaps rather than closures, so they reopened the total tier that the
  golden capture above had just closed: **core 59/59 (100%), total 98/100 (98%)**
  at the time, with both named in the weight-ordered closure queue. Both closed
  before the release — the four cases were captured on the VM and total reads
  **100/100** (see *Fixed*).
- **X++ language-core knowledge pack (Phase B).** The knowledge base was strong
  on frameworks and data access and silent on the language itself, so an agent
  could look up `SysOperation` but not how `switch` falls through. Seven new
  topics — `xpp-data-types`, `xpp-declarations`, `operators-precedence`,
  `switch-loops`, `attributes-authoring`, `intrinsic-functions`,
  `date-effective` — plus six expansions: `select-statement` (firstOnly
  variants, exists/notexists semi-join semantics), `xpp-class-rules` (no
  overloading, properties, generics or lambdas), `event-handlers` (delegate
  declaration vs eventhandler subscription, no firing-order guarantee), `coc`
  (next-in-try/catch PU21+, implicit system-method wrapping PU22+),
  `transactions` (the precise in-tts catchability matrix, replacing the
  overbroad "never try/catch inside tts"), `error-handling` (retry semantics,
  infolog discard, `finally` — and a correction: the literal is
  `DuplicateKeyException`, not "DuplicateKeyConflict").
- **Ten new `validate_code(mode="syntax")` rules (Phase C)**, taking the static
  set from 20 to 30. `CS001` rejects C# constructs that cannot compile in X++
  (`$"…"` interpolation, `=>` lambdas, `foreach`, `??`, the `string` type), each
  with the X++ equivalent in the fix message. `TTS002` catches a dead catch
  inside an open tts scope — only `Exception::UpdateConflict` and
  `DuplicateKeyException` reach an inner catch, everything else unwinds outside
  the transaction. `TTS003` flags a `retry` with no guard in its catch, which
  loops forever on a deterministic error. `SEL006` (index hint without
  `allowIndexHint(true)`, silently ignored) and `SEL007` (`left`/`right join`,
  `join…on` — SQL syntax X++ does not have). `RPT001`/`RPT002` catch SSRS data
  providers that compile clean and fail at report run time. A new
  `codeType="xml-report"` runs report-only checks (`RPT101` missing design node,
  `RPT102` dataset without `<Query>`) and pointedly does not run the X++ keyword
  rules over RDL CDATA. `FN001`'s fixed-arity catalog grew from 4 builtins to
  27, including `ssrsReportStr`'s two arguments — the missing-design-argument
  mistake now fails at write time instead of at build.
- **`object_patterns(domain="report")` — SSRS implementation recipes (Phase D).**
  Seven patterns (SimpleList, GroupedWithTotals, HeaderDetail, PreProcess,
  PrintMgmtFormLetter, QueryBased, UIBuilderDialog). Unlike a form pattern there
  is no pattern XML to validate, so a report pattern is a *recipe*: the object
  roster with base classes, the one `generate_object` scaffold call that
  produces it, method guidance, and the checks to run afterwards. Alongside it:
  `validate_object_naming(objectType="report")` warns when an AxReport name
  carries a companion-class suffix and returns the full roster;
  `generate_object(mode="scaffold", objectType="report")` gained `uiBuilder`,
  and its op-spec now advertises `aotQuery`, `callerTableName`, `preProcess`,
  `controllerType` and `uiBuilder` — all implemented already, none of them
  visible to an agent before.
- **Index warm-up at startup** (`INDEX_WARMUP`, `INDEX_WARMUP_BUDGET_MS`).
  87% of a 23-minute benchmark run was tool time over SQL that takes
  milliseconds once the pages are cached. Measured on the reference VM
  (1.19M symbols / 2.5 GB): the `idx_symbols_name` covering scan is 83 s cold
  and 0.11 s warm; the run's own 189 s search batch and 174 s first label search
  are that same cold cost. A worker thread now reads the hot indexes on its own
  connection, budget-capped and never awaited. It buys the session's first
  questions, not the whole session — the two databases are larger than the cache
  they compete for, and a build evicts them again.
- **A running tool call now says which phase it is in** (`SLOW_CALL_HEARTBEAT_MS`,
  default 30 s, 0 to turn it off). The phase block in the reply is only ever read
  afterwards, and the create that took 341 s reported all of it as
  `(unmeasured)` — so there was nothing to look at either way, during or after.
- **Op-spec topics for the build/verify/BP overrides.** `packagePath` on
  `build_d365fo_project`, `verify_d365fo_project` and `run_bp_check` was
  unpublished to pay for schema cost and had nowhere to be discovered — it
  points those tools at metadata outside the configured PackagesLocalDirectory
  and has no published equivalent, so the capability existed and nothing could
  tell a caller it was there.
- **Eval catalog 87 → 98 cases, and both coverage tiers closed at 100%**
  (core 51/51, total 89/89). Phase E added the grammar and reporting leaves,
  Phase F captured their goldens on the VM, five language cases and a final
  attribute/reflection case closed the queue — each built, xppbp-clean,
  golden-matched and rolled back on the VM.
- **Three scaffolds for extending a report that already ships**, closing the last
  G4 gap — the technique was knowledge-only, so an agent could read what to do
  and still had to hand-write it. `generate_object(mode="pattern", pattern=…)`
  now emits `report-dataset-extension`, `report-custom-design` and
  `report-menu-redirect`, each paired with a recipe in
  `object_patterns(domain="report")` (10 recipes now: seven that create a report,
  three that change one). Every emitted shape was compiled on the VM against real
  standard objects — `AssetBarCodeDP`/`AssetBarCodeTmp`,
  `AssetBarCodeController`, `SalesInvoiceController` — **with a negative control
  in the same build**, because a probe that reports nothing is not a probe that
  passed. Three details the compiler settled and the scaffolds now carry:
  - the dataset accessor is a *parameter*, never derived from the temp-table
    name: the platform's own `AssetBarCodeDP` spells its getter
    `geAssetBarCodeTmp`, a shipped typo. Give it and you get the bulk
    `[PostHandlerFor]` shape; omit it and you get the per-row
    `[DataEventHandler]`, which needs no accessor at all;
  - `linkPhysicalTableInstance` is load-bearing in the bulk shape — a temp-table
    buffer merely declared in the handler is a *different, empty* table, so the
    handler would appear to work while updating nothing;
  - a catalog recipe can no longer name a `generate_object` pattern that does not
    exist: `CODE_GEN_PATTERNS` is exported and the catalog gate checks every
    pattern name in the file against it.
- **Nine eval goldens captured on the VM**, taking core coverage from 86.4% back
  to 100% (59/59) — this time on goldens that exist rather than on leaves marked
  pending. Every artifact was written through the server's own
  `d365fo_file(action="create")` path (no hand-edited XML), full-built with xppc
  7.0.7996.33, checked with xppbp and rolled back; a golden is only committed out
  of a build that was clean. 15 files across `L2-runtime-functions-arity`,
  `L2-implicit-conversions`, `L2-select-find-options-joins`,
  `L2-args-record-caller`, `L2-display-edit-methods`,
  `L2-systest-authoring-basic`, `L3-form-event-handler-class`,
  `L3-sysoperation-dialog-attributes` and `L3-report-dataset-extension`, each with
  a README recording what it has to keep showing and what the capture taught.
  One case spec was wrong and the platform said so: `L2-display-edit-methods`
  asked for an `AxTableExtension`, and an `AxTableExtension` carries no
  `<Methods>` element at all — not one shipped table extension in ApplicationSuite
  has one — so display and edit methods on a table you do not own belong in an
  `[ExtensionOf(tableStr(…))] final class`.

### Fixed
- **`run_systest_class` was recorded as blocked by a platform limitation it does
  not have.** This repo stated that `SysTestConsole.exe` requires an interactive
  console session (an unconditional `WaitForDebugger`/`Console.ReadKey`). It does
  not: the binary documents `/unattended` in its own `/?` output, and with the
  flag it skips the prompt and reaches "Executing test(s) ...."  — the tool passes
  it now. What actually stopped a run on the reference VM is named instead of
  blamed on the test model: `Bin\SysTestConsole.exe.config` redirects
  `Microsoft.ApplicationInsights` to a version the install does not have, and once
  that is corrected the next assembly (`System.ValueTuple` 4.0.3.0) is correctly
  redirected but simply absent from `Bin`. Both are config-only fixes on the
  platform installation, so they are described rather than made here; the tool
  recognises the failure and explains it.
- **`barcode-scanning` told the agent to write a GS1 parser it must not write.**
  Inside a warehouse-app flow the platform parses GS1 before the scan reaches the
  flow — global prefix/group-separator/unknown-identifier options on Warehouse
  management parameters, the application-identifier list, and a bar-code data
  policy on the mobile device menu item for one scan filling several fields. The
  topic now leads with that, keeps the hand-written parser only for the paths
  with no menu item behind them (rich client, integrations), and adds the two
  facts that decide whether scanning works at all: the scanner hardware must add
  a recognised AIM prefix and convert the ASCII 29 group separator to a printable
  character, and multiple-field scanning changes *when* a flow has its values, so
  a custom step can be skipped. The eval case was reframed to match. Sourced from
  Microsoft's own documentation rather than recall.
- **`labels(action="search")` recommended labels that are not on disk.**
  `action="info"` has checked a single id against the `.label.txt` since August;
  search — the call an agent makes *before* it reuses a label — never did. One
  benchmark run took all three labels it needed from a single search, every one
  a resolvable index hit left behind by a rolled-back session and none of them
  on disk. xppc does not check labels, so the 115 s build passed and
  `run_bp_check` found them two steps later (`BPErrorUnknownLabel` ×2, plus two
  bogus `BPUnusedStrFmtArgument` — an unresolvable label reads as a format
  string with no placeholders). Recovery cost a second build and a second BP
  run. Search now confirms hits against disk, marks a phantom row, and never
  picks one as the recommendation.
- **An EDT read back its constructor default instead of its inherited
  `StringSize`.** `IMetadataProvider` returns an EDT exactly as its own XML
  declares it and fills in nothing it inherits, so a derived string EDT that
  declares no size reported 10: `ItemFreeTxt` is really 1000, `ItemId` and
  `CustAccount` really 20. The table reader carried the same defect and is the
  higher-traffic consumer — across ten core tables **310 of 564 string fields
  (55%) reported the wrong size**. A derived EDT that *declares* its own size is
  authoritative (228 in the shipped corpus do) and is left untouched; only the
  unset case is filled in. A follow-up audit also bound the two hand-rolled
  fallbacks by name: the CLR resolves a method token when it JITs the
  *containing* method, so the `MissingMethodException` they existed for surfaced
  one frame up and their inner catch never ran — verified on .NET Framework 4
  x64 against an assembly with the helper removed.
- **SSRS scaffolding produced reports that could not compile or bind.** The
  `ssrs-report-full` pattern emitted `ssrsReportStr(X, Design)` while every
  scaffolded AxReport names its design `Report`, and `ssrsReportStr` is
  compile-time checked against that name — so the generated controller could
  never compile against the generated report; a regression test now pins the two
  paths together. The pre-process scaffold paired a TempDB table with the wrong
  data-provider base, and the print-management controller did not implement the
  abstract `runPrintMgmt`, so it did not compile. Report EDT resolution is now
  model-aware: a field of that name already in the target model wins, and a
  candidate that is another model's prefix glued onto the field name is demoted
  — which is what made a bare `fieldsHint` pick an un-migrated
  `PlCorrNoteId` (`BPErrorEDTNotMigrated`).
- **Write-path gaps found while capturing a date-effective case on the VM:**
  `add-index`/`create` could not set `ValidTimeStateKey`/`Mode`, `add-field`
  handed the bridge the root EDT name for a Date EDT (`Data type mismatch`), and
  a `modify-property` with an empty value left an empty element behind.
- **Options a tool accepted and then quietly dropped.** An option silently
  ignored is worse than one refused, because the caller draws a conclusion from
  the absence. `get_object_info(objectType="table", options:{relations:true})`
  is read only by the bridge renderer; on the symbol-index and disk fallbacks
  the knobs were parsed, defaulted and dropped, so the answer came back with no
  relations and nothing to explain it — which reads as "this table has none".
  Those paths now name what they could not honour, and why. Separately,
  `workspace://active` and `workspace://files` rendered from the NON-blocking
  context snapshot and never read its pending flags, so a scan still running was
  reported as an empty result — at session start, exactly when the caches are
  cold, a workspace full of recent edits could come back as "no recent edits". A
  resource read is not on the latency path a tool call is, so it now waits.
- **`d365fo_file(action="create", objectType="table")` silently dropped
  `properties.fieldGroups`.** The `<FieldGroups>` block was a hardcoded literal
  holding only the five `Auto*` groups. A table with no groups of its own still
  builds clean, so this stayed invisible until the SimpleList form template
  emitted `<DataGroup>Overview</DataGroup>` and the build failed with *"Field
  group 'Overview' does not exist"* — on the **form**, pointing away from the
  table that had actually lost it.
- **`d365fo_file(action="create", objectType="form")` never resolved field
  control types**, so every grid column came out `AxFormStringControl` —
  invisible for a string field, and a build error for anything else (a date
  column fails with *"DataField: Data type mismatch"*, again naming the form
  rather than the type it disagrees with). The templates have accepted a
  `fieldTypes` map all along and `generate_object` supplies one; only this
  builder did not. It now resolves them off disk, which also covers a table
  written moments earlier in the same call and therefore absent from the symbol
  index. `createTablePropertyHonesty` needed no change and got none — it reads
  the XML that was actually written rather than a maintained capability list, so
  it stopped reporting field groups by itself, and its test now asserts that
  silence.
- **The knowledge base told agents to call two methods that do not exist.** Both
  were found by compiling what it recommends rather than by reading it again.
  `form-event-handlers` said a control lookup ends with `_e.CancelSuperCall()`;
  xppc answers *"Class 'FormControlEventArgs' does not contain a definition for
  'CancelSuperCall'"* — the args have to be narrowed to
  `FormControlCancelableSuperEventArgs` first (and a data source write is
  cancelled through its own `FormDataSourceCancelEventArgs.cancel(true)`).
  `report-extension-patterns` said a custom-design controller's `main()` calls
  `initArgs(...)`; there is no `initArgs` on `SrsReportRunController` or anywhere
  in its hierarchy. Shipped controllers use `parmArgs` + `parmReportName` +
  `startOperation`, which is what both the rule and the scaffold now do.
- **`run_systest_class` blamed the wrong thing for a failed database login.** It
  reported `Login failed for user '…'` as "a deployment credential", which sent
  the reader hunting a rotated password. On the machine this was recorded from,
  nothing had rotated: `Bin\SysTestConsole.exe.config` is the shipped template,
  never configured for that install, and it disagreed with the AOS's own
  `WebRoot\web.config` on **all four** DataAccess settings — database, user,
  server, and a password still reading `$CREDENTIAL_PLACEHOLDER$`. The tool now
  compares the two files itself and names the settings that differ, and it never
  puts the password in its answer: only "the shipped placeholder" or "set, N
  chars, not shown". Applying the fix edits the platform install and moves a
  secret between files, so it stays the operator's call — the four
  `systest_pending` eval cases remain pending, now with an accurate reason.

- **A write did not invalidate the workspace scan cache.** `WorkspaceScanner`'s
  own doc comment said its 15s TTL was "paired with invalidate() (called after
  writes)"; `invalidate()` had no production caller at all — only tests and its
  own `clearCache()` alias. So for up to 15 seconds after a create, the
  workspace-backed readers and the `workspace://files` / `workspace://active`
  resources could not see a file this same server had just written. The
  dispatcher now clears it at the same choke point that bumps the write epoch,
  which is the sibling cache with the same failure mode and the same fix.
- **Four served MCP methods were logged as if unimplemented.** The HTTP
  transport's `SILENT_PROBES` set carried `resources/list`,
  `resources/templates/list`, `prompts/list` and `logging/setLevel` under a
  comment reading "capability-probe methods that always return Method not
  found". All four are served — the first three since resources and prompts got
  handlers, and `logging/setLevel` by the SDK itself off the declared
  `logging: {}` capability, which is why no grep for a request schema in this
  repo ever found it. Nothing was broken for clients; what it cost was evidence.
  A client that reads `workspace://active` and one that ignores our resources
  produced byte-identical logs, and that difference is precisely the trigger two
  `docs/BACKLOG.md` entries (context-pipeline Phase 3b, VSIX shim) have been
  waiting on. The resource and prompt handlers now log each list/read
  themselves, so the signal survives stdio too — where VS Code and VS 2022, i.e.
  every target client, connect and the transport logs nothing per request.
  `SILENT_PROBES` is now pinned against the SDK's real handler registry.
- **Docs and the architecture diagram re-aligned with the code.** The numbers
  drift audit: the SVG still advertised 26 tools (it is 20 — the same fold this
  block documents), TESTING.md still said 23 tools and ~2,900 tests across ~220
  files (5,000+ across ~350), ARCHITECTURE.md carried a pre-fold "80 cases"
  (87), "~19 patterns + ~20 sub-patterns" (36 + 30), "11 static rules" (20),
  "31 modify ops" (27 distinct C# dispatcher ops) and a `/health` rate limit
  that does not exist (`/health` is exempt). MCP_TOOLS.md now documents
  `labels(action="update")` and `get_knowledge(kind="bp-moniker")`, the
  extension objectTypes of `get_object_info`, the per-mode tool counts
  (read-only 14 / write-only 9), and gained a short section on the 8 MCP
  prompts and 5 workspace resources nothing user-facing listed before. The
  heaviest table cells (`get_object_info`, `generate_object`, `d365fo_file`,
  `object_patterns`) were unpacked into bullet lists — same facts, readable
  shape. CUSTOM_EXTENSIONS.md and SETUP_AZURE.md stopped teaching the legacy
  `.env`/`PACKAGES_PATH` configuration as the primary route now that the
  wizard writes `config/d365fo-mcp.json`. Re-run against the Phase B–F work
  that landed after it: 87 → 98 eval cases, 20 → 30 static rules, coverage
  44/44 + 78/78 → 51/51 + 89/89, and the `object_patterns` report domain,
  report naming and `uiBuilder` scaffold documented for the first time.
- **Writes silently landed in whichever project scanned first.** When workspace
  heuristics resolved nothing, the `D365FO_SOLUTIONS_PATH` fallback pinned
  `all[0]` — so in a solution where several `.rnrproj` build one model (the
  ordinary D365FO shape: one real solution here has 190 projects across 31
  models, the largest model built by 20 of them), every file registered itself
  into an arbitrary project nobody chose, on every fresh session. The model still
  resolves — every candidate agrees on it — but the project is now left unset,
  and the projects it is between are NAMED: by `get_workspace_info` (`Project :
  (not selected — N projects build this model)` plus their file names) and by the
  create warning, which listed nothing before. `d365fo-mcp doctor` no longer
  prints the project that was deliberately not selected. When the scan root holds
  several custom models, the log now says the model was picked by scan order
  rather than deduced — the pick itself stands, because for many workspaces this
  scan is the only model source.
- **`get_workspace_info` answered a refused `projectName` with nothing else.**
  It is the first call of every session, and the parameter is one the agent is
  told to pass from context, so a miss is expected traffic — and it cost the whole
  call plus a round trip to ask again without the argument. The refusal now comes
  first, still with `isError` so it cannot read as a completed switch, followed by
  the workspace facts the call was made for.
- **A bridge provider that FAILED was reported as "object not found".**
  `PickProvider` swallowed the exception from both metadata providers and
  returned null, and every caller maps null to `-32001 Object not found`. So a
  metamodel mismatch, a `TypeLoadException` or an unreadable model reached the
  agent as "that object does not exist" — and an agent told an object is absent
  creates it, which is how you end up with two. The catch stays (the primary
  provider legitimately throws for an object only the UDE reference provider
  carries, and swallowing that is what makes the fallback work), but a failure is
  now remembered and surfaced when NEITHER provider said yes.
- Bridge write wrappers logged their exception to stderr and returned a plain
  failure message, bypassing the per-call failure sink the read wrappers use — so
  a write that threw reached the model with nothing saying the bridge was what
  broke. 27 of them now record into it. Same stderr line, same return shape.
- **`d365fo_file(action="generate")` produced X++ that could not compile.**
  `XmlTemplateGenerator` was declared twice — once in `createD365File.ts`, once
  in `generateD365Xml.ts` — with a comment on each half asserting the two were
  mirrors. They were not: **26 of the 27 shared methods had diverged**, every
  divergence a fix made on the create side that never reached the generate
  mirror. The one users could feel: the generate copy's "a member variable is a
  line ending in `;`" rule dropped `#Library` / `#define` / `#localmacro`
  directives out of a class declaration, so the XML it handed back referenced an
  undefined macro. The others were quieter and no smaller — the generate copy
  ignored `sourceCode` on tables entirely (methods and declaration never reached
  the XML), skipped self-reference normalisation on classes and data entities,
  and wrote `<DataField>undefined</DataField>` for the documented
  `fields: ["AccountNum"]` shape on a table extension.
  There is now ONE implementation, in `src/tools/xml/xmlTemplateGenerator.ts`,
  imported by both former homes and by `generateSmartReport`. Verified live
  against the VM: for a class carrying a `#Library` include, an enum and a
  security privilege, `generate` output and what `create` writes to disk are now
  identical **after line-ending normalisation** — same elements, same values,
  macro directives included. They are NOT byte-identical, and cannot be:
  `create` writes through `normalizeD365Xml` (LF to CRLF, trailing newline
  stripped) while `generate` returns the text unnormalised, so the same class
  measures 636 B returned against 668 B on disk. `generate` also does not apply
  the model-name prefix that `create` does, so the documented
  generate-then-create flow must pass the final name if it wants the same
  `<Name>`. An earlier claim of "byte-identical" here was wrong: the probe that
  produced it normalised `\r\n` and trailing whitespace away before comparing,
  i.e. it erased exactly the difference it was meant to detect.
  `tests/tools/xmlTemplateGeneratorSingleton.test.ts` fails if a second class or
  a second `generateAx*Xml` implementation ever appears — output-comparison
  tests cannot catch this, because a fork drifts in the methods nobody thought
  to compare.
- Seven rewrites moved onto the atomic write helper: in `createD365File.ts` the
  two post-create reconciliations and the primary create write; in
  `createLabel.ts` the `.label.txt` rewrite; in `renameLabel.ts` the `.label.txt`,
  the `.xpp` sources and the XML metadata it rewrites when a label id changes.
  A torn write to a `.label.txt` does not corrupt one label, it corrupts every
  label in that model's file, and that file has no undo outside git. The two
  remaining plain writes in `createLabel.ts` create a NEW file behind an
  `fs.access` miss and are correctly left alone.
- **`d365fo_file(action="create", objectType="table")` also dropped
  `properties.indexes`** — the third collection it lost after field groups, and
  the one with no way back: `createTablePropertyHonesty` correctly reported the
  loss and offered `add-index` as the repair, but that operation requires the C#
  bridge, so a create running on the XML-template path could not produce an index
  at all. `<Indexes>` is now rendered by a builder shared with the
  table-extension path, so the two cannot drift. `<Relations />` is still a
  literal and stays reported by that same honesty check.
- **The form templates named a field group they had no reason to believe
  existed.** `<DataGroup>Overview</DataGroup>` was hardcoded on the grid in three
  patterns. Binding a grid to a field group is right — shipped forms do it, and
  `CustGroup` and `VendGroup` both bind `Overview` — but naming a group the table
  does not declare is a build error, and an *incremental* build passes it
  silently, which is how it survived several captures. The builder now reads the
  bound table and omits the element only when it has **positively** established
  the group is absent; a table it cannot read leaves the binding alone, because
  absence of evidence is not evidence of absence.
- **Three goldens that could not build have been re-captured on the VM**, closing
  the "Fixture ⇄ golden mismatch" row of `eval/golden-build-verification.json`.
  `L1-form-basic`'s table golden did not satisfy its own case instruction, which
  asks for an `Overview` field group *and spells out why* ("a form whose grid
  names a field group the table does not declare fails FormPatternValidation at
  build time") — it carried `<FieldGroups />`, because the create path had
  silently dropped it. `L1-form-simplelistdetails`'s form carried a `<DataGroup>`
  with no sibling `<DataSource>`, so the group could not be resolved against any
  table. `L1-form-detailsmaster` needed no re-capture and went green once the
  fixture table was correct. All three now build clean in isolation, and
  `eval/fixtures/ConDemoNoteHeader.metadata.xml` is re-synchronised with the
  re-captured golden — a copy of a golden again rather than a hand repair of one.
  Golden re-verification: **93/100 clean over 224 artifacts** (was 57/65 over
  143; the catalog grew by 35 cases in between, so a third of it got its first
  isolated verdict here). Exactly three cases changed state — the three above.
  Nothing regressed.
- **`find_references` answered "0 references — symbol might be unused" for a
  method that is called twice.** With the cross-reference bridge down, the
  fallback matches call sites against `source_snippet`, which is a method's
  **first ten lines** by construction — so a call on line 11 or later of any
  caller is structurally invisible, and `WHSWorkExecuteDisplayAdjustIn.displayForm`
  (hundreds of lines) calls `buildAdjustIn` twice from well below the cut. An
  eval run whose scored requirement was "run `find_references` FIRST and record
  what you found" recorded a confident falsehood. The coverage gap first
  suspected was not the cause — Foundation has 351,660 method rows and
  `buildAdjustIn` is one of them. Intra-type calls, the commonest miss and the
  cheapest to recover, are now read from the declaring type's own source (one
  indexed lookup, at most three files, size-capped, best-effort); a degraded zero
  names its own blind spot instead of concluding "unused"; and an `ownerName` the
  fallback cannot honour is reported rather than swallowed — the note used to
  print only when no owner was given, so a caller who *did* scope the lookup got
  an unscoped answer that looked scoped.
- **`search` returned nothing for a multi-word query whose answer was in the
  index.** `search(query="ProcessGuide AdjustIn")` found 0 rows while
  `InventProcessGuideAdjustInController` — a name carrying both tokens — sat in
  the index and an exact-name search returned it. The substring-scan guard
  skipped every query containing whitespace, on the premise that "no name can
  contain a space": right about the SQL it guarded, wrong about the query, which
  never meant one verbatim string but *a name containing all of these* — one AND
  of LIKEs over the same single covering scan. A selective token is now defined
  in one place (at least 3 characters, at most 4 of them), so a query with
  nothing selective left still does not scan, and the term count is part of the
  statement-cache key, without which a two-token query would reuse the one-token
  statement. The eval run that hit this took the empty answer as evidence,
  targeted an obsolete class instead, caught the `[SysObsolete]` only as a
  compile warning, and rolled back.
- **`labels(action="create")` wrote labels under a file id nothing can
  reference.** A model named `fm-mcp` gets the label file id `fm-mcp`; create
  accepted it, wrote the label into every language file, reported success and
  advertised `literalStr("@fm-mcp:ScanContainer")` — a reference that resolves to
  nothing, because the hyphen ends the identifier. Two witnesses agreed the write
  was useless: `labels(action="info")` could not find the label it had just
  created, and xppbp raised `BPErrorLabelIsText`. The charset was never in doubt
  — `parseLabelReference` has always refused to parse `@fm-mcp:X` — the read side
  and the write side disagreed and the write side won silently. The create schema
  now rejects an unusable id and names the one that would work (`fm-mcp` →
  `fmmcp`) rather than restating the rule, the default pick prefers a
  referenceable file over the one named after the model, and the auto-label path
  returns null instead of a broken reference: the caller keeps its raw text and
  the BP advisory, which is worse copy but true.
- **`prepare` and `validate_object_naming` demanded opposite things, and no name
  satisfied both.** Extending `whsWorkExecuteDisplayChangeBatchDisp` — one of the
  camelCase classes the product ships — `prepare` refused the lowercase extension
  name ("Name must start with an uppercase letter (PascalCase)") while
  `validate_object_naming` refused the PascalCase one ("Class extension names
  must start with the base class name"), prescribing exactly the name `prepare`
  had just refused. The write succeeded at all only because
  `d365fo_file(action="create")` ignored the caller's input and derived the
  correct lowercase form itself. PascalCase is a rule for a name you **invent**;
  an extension name is derived from one you did not, and `{Base}{Prefix}_Extension`
  inherits its first letter from the base. `prepare` now defers to the base's
  casing when the proposed name starts with the object being changed, in both the
  `_Extension` and the dotted element-extension forms. A name that does not start
  with a letter at all is still an error, and a name the caller invented is still
  held to PascalCase. `validate_object_naming` is unchanged — it was the one in
  the right.
- **`object_patterns` truncated a recipe in half.** It ran on the generic
  5,000-character response cap: measured live, the mobile-app `processguide-flow`
  spec renders 9,328 characters and lost 4,406 of them — the `addActionControls`
  half of the page-builder skeleton and the entire silent-step skeleton never
  reached the agent, which rebuilt both from Microsoft source at several round
  trips each. A pattern recipe is a code skeleton, and half a skeleton is not a
  smaller answer but a wrong one; a round trip re-bills the whole cached context,
  so the cut cost more than it saved. The cap is 12,000, which clears the largest
  recipe in the catalog (next: `app-step-identity` at 3,853, report
  `PrintMgmtFormLetter` at 3,051) and still bounds a runaway render. The
  truncation advice is this tool's own now — the generic text pointed at
  `methodOffset`/`fieldsOffset`, parameters `object_patterns` does not accept, and
  this file already records that advice naming a knob the tool lacks gets
  followed. A ratchet test fails when a new recipe outgrows the cap, so the cap is
  raised deliberately with the measurement in hand rather than discovered by an
  agent silently reconstructing what it did not receive.
- **The `processguide-flow` skeleton routed through a confirm step it never
  creates.** The shipped recipe routed prompt → confirm → register → prompt and
  the eval case asked for the same cycle, but neither ever creates a confirm
  screen: the case names five artifacts and the pattern's own object roster four
  roles, none of them a confirm step. `classStr()` is compile-time checked, so the
  skeleton does not compile as printed — `classStr(MyDemoProcessGuideConfirmStep)`
  resolves to nothing — and there is no reusable framework confirm step to borrow,
  because every `ProcessGuide*Confirm*Step` in the product is process-specific
  with its own page builder. Both sides now route prompt → register → prompt, and
  the skeleton says why a route may name only steps the flow actually creates. The
  `processguide-page-replace` and `processguide-step-insert` recipes are untouched
  — they reference *standard* Microsoft confirm classes, which is the point of
  those patterns.
- **The four warehouse mobile-app goldens are captured**, so this release ships no
  `golden_pending` case from that wave. All four ran on the VM and passed —
  `L2-processguide-page-control` (1 artifact), `L3-processguide-flow-slice` (5),
  `L3-legacy-workexecutedisplay-extend` (1), `L3-warehouse-scan-resolve-slice`
  (1) — build clean and xppbp clean (0 errors / 0 warnings, incremental and full,
  plus an object-scoped BP check on every artifact). The two leaves those cases
  were opened for close with them: **core 59/59 (100%), total 100/100**, and the
  README badge follows. Their taxonomy notes still claimed "goldens pending VM
  capture" and are rewritten to what the runs actually showed — `coverage.test.ts`
  has a gate for exactly that lie, and 37 notes had told it before, one of them in
  the published `COVERAGE.md`. Two gaps the runs found are recorded in the corpus
  records and **not** fixed here: `validate_code(mode="references")` accepts
  `methodStr()` where xppc requires `staticMethodStr()` for a static method, and a
  stale `visibilityCache` in `metadata/modelDescriptor.ts` makes a `Descriptor`
  edit invisible for the rest of a server session.

### Changed
- **The compiler is the oracle for the validator now.** Measured against the
  platform this server writes for — 7,649 shipped files (51 MB of X++) swept
  through `runRules`, plus ~700 probe classes compiled by xppc — the validator
  used to report 5 error-severity findings on Microsoft's own compiling code. It
  now reports none while checking six times more. Two causes: every one of those
  false positives came from maskers that recognised only double-quoted strings
  (`strFind(text, ',', 1, len)` read as a wrong arity, a GUID mask as a C# `??`,
  an SQL string as a `left join`), so all five are replaced by one lexer in
  `src/utils/xppLexer.ts` that handles both quote styles, verbatim literals and
  doubled/escaped quotes while preserving offsets; and reserved words, intrinsics
  and function arities are now captured from the shipped parser and compiler
  assemblies into `eval/compiler-facts.snapshot.json` (115 keywords, 80
  intrinsics, 170 functions) instead of 28 hand-typed entries — so `FN001` knows
  that `date2Str` takes 7 **or** 8 arguments and that `strFmt`/`conIns`/`max`/`min`
  are variadic. Several rules were narrowed by the shipped code that disproved
  their old shape, `COC001` (which fired on new methods an extension class merely
  adds) among them.
- **Knowledge claims re-verified against xppc on the VM (Phase F).** `conIns`
  left `FIXED_ARITY_BUILTINS` (xppc accepts 2 and 4 arguments), `protected
  internal` compiles while `private protected` does not, `forceLaterals` is not
  a keyword, and the attribute is spelled `SrsReportParameterAttribute` per its
  own `<Name>`. Examples added to the SSRS and attribute topics against real
  symbols — 309 references audited, 0 defects.
- **A write no longer sweeps the whole metadata root to resolve its package.**
  `PackageResolver.buildMap()` reads every package directory, every descriptor
  and every subdirectory again — ~5 s on a 214-package PackagesLocalDirectory,
  paid on every write because both paths build a fresh resolver. It now probes
  `<root>/<modelName>` first (two readdirs): **5,073 ms → 6 ms**, agreeing with
  the full sweep on 211 of 212 models, and the sweep still runs for a package
  not named after its model. The fallback write path also names its phases, so
  a slow create can no longer attribute five minutes to `(unmeasured)`.
- The direct-XML writers moved out of `modifyD365File.ts` into
  `src/tools/write/directXmlWriters.ts`.
- An event-loop lag monitor ships behind `DEBUG_LOGGING`. The audit could
  measure the symptom — 268 real `labels` calls averaging 5.6 s server time
  while the FTS query inside them takes 6-11 ms, a first call after the
  handshake taking 1.3 s and the same call 18 ms eight seconds later, and the
  tool's own phase timer reporting 0.0 s throughout — but not the cause. Measured
  from outside on this VM with a warm OS file cache, the loop is barely blocked:
  three ~140 ms stalls in the first 5.5 s, 415 ms in total across 25 s, on top of
  a 1,749 ms `initialize`. The corpus averages come from cold caches, which
  cannot be recreated on demand. So rather than invent a fix for blocking that
  cannot currently be measured, the measurement now lives in the server.
- A successful bridge `create` no longer rebuilds the metadata provider twice.
  The C# dispatcher runs `RefreshProvider()` itself after `createObject` /
  `createSmartTable`, and the TypeScript side then scheduled and flushed another
  full `DiskProvider` rebuild of the same tree. The adapter now records the
  bridge-side refresh, and the second one runs only for the direct-XML create
  path, which genuinely has nothing else to schedule it. Measured live, A/B over
  the same call: create + 3 operations 5,754 → 5,452 ms and 3,455 → 3,138 ms.
- **The published tool surface is 20 tools, down from 23.** Every tool schema is
  sent on every request, so a merge only pays when the merged description is
  shorter than the sum of the parts. Three were, and each fold went into the tool
  that already owned the subject and already had the parameter:
  - `undo_last_modification` → **`d365fo_file(action="undo", filePath)`**.
    `filePath` was already there, the tool is already annotated destructive, and
    the warning that carried the tool — *git checkout HEAD discards ALL
    uncommitted changes to that file, not just the last edit* — moved with it.
  - `review_workspace_changes` → **`get_workspace_info(changes=true)`**. Both were
    local, read-only and about the same workspace. The description was corrected
    in the move: the retired tool advertised "BP violations, missing labels, CoC
    patterns" and its handler only ever ran `git diff HEAD --unified=3`. It also
    no longer needs a directory argument (it derives one from the workspace) and
    says plainly that there is nothing to show when the workspace is not a git
    work tree, instead of failing — 2 of its 7 recorded real calls failed exactly
    that way.
  - `trigger_db_sync` → **`build_d365fo_project(dbSync)`**, mirroring the existing
    `bpCheck` knob: a sync always follows a successful build, so it should not
    cost a second round trip. `dbSync: true` syncs the project's syncable
    objects (full-model when it has none); `dbSync: ["CustTable"]` syncs exactly
    those.
- Schema trims paying for the folds: `get_object_info` stopped inlining the
  object-type enum a second time inside `objects[]`, four discriminator
  parameters stopped restating the bullet list their own tool description already
  carries (`generate_object.mode`, `security_info.mode`, `object_patterns.domain`,
  `validate_code.mode`), and `update_symbol_index` dropped the half of its
  description that had become an essay. `ListTools` fell from 48,019 to 44,919
  characters.
- The base-object XML locator moved out of `modifyD365File.ts` into
  `src/utils/baseObjectXml.ts`. `generateSmartForm` had been importing a
  5,600-line write tool to read a form's XML; `tests/utils/layering.test.ts` now
  fails if a generator imports a write tool again (the 93-line write-anchor
  guard stays allowed and says why), and pins the two remaining upward imports
  so a third cannot appear unnoticed.

### Breaking
- **`undo_last_modification`, `review_workspace_changes` and `trigger_db_sync` are
  no longer published.** Any prompt, instruction file or `MCP_EXTRA_TOOLS` list
  that names one must be updated to the folded form above; this repo's own
  `.github/copilot-instructions.md` and system prompt were. All three names stay
  **routable**, so an agent still holding one gets its answer rather than an
  unknown-tool error — and `trigger_db_sync` remains the way to run a partial
  sync with no rebuild in front of it.

---

## [1.14.0] — 2026-08-24

_Reconstructed from `git log` and the release tag: this version shipped without
notes, so the entries below name what changed and why it mattered, not every commit._

### Added
- `d365fo_file`: `operations[]` on **`action="create"`** as well as modify, applied
  against the name the create actually wrote (which is not always the name passed —
  the model's naming style decides it).

### Changed
- **Round trips became the unit of optimisation.** A session audit fitted the real
  billing of a 19-minute agent session and established that cached context is
  re-billed on *every* request, so the number of calls a task needs dominates cost.
  The four dominant serial patterns gained plural forms, framing the caller cannot
  act on was removed from responses, four fixed costs came off every tool call, and
  schemas stopped advertising knobs nobody turns and stopped stating the same rule
  twice. `ListTools` fell to 25 tools / ~53 KB, and `MCP_TOOL_PROFILE=core` (18
  tools) arrived for setups that want less.
- Bridge metadata **reads now overlap**; writes stay exclusive. `SearchObjects` no
  longer materialises every collection's primary-key list per search.
- `d365fo_file`: a wrong parameter **shape** now answers with the operation's full
  contract instead of a bare validation message.
- Naming rules are one shared implementation, used by `prepare` as well as by
  `validate_object_naming`. The duplication that made unpublishing the latter look
  attractive is gone; the tool stays published because `prepare` never covered
  extensions.

### Fixed
- **Kernel enums were reported as hallucinated symbols.** 44 enum names that shipped
  metadata uses (`NoYes`, `TableGroup`, `AccessRight`, ...) have no AOT artifact, so
  an index-only existence check could not find them and failed a call it was in no
  position to judge. Such a check now warns instead of erroring.
- `add-entry-point` silently dropped `accessLevel`, granting Read only.
- FP002 crashed on a `Custom` form pattern and advised "undefined".
- The duplicate-call advisory called a legitimate re-read-after-write a loop.
- A bridge read that cannot print no longer takes the request loop down with it.

---

## [1.13.0] — 2026-08-21

### Added
- `d365fo_file`: `remove-control` (form / form-extension) and `remove-entry-point`
  (security-privilege) — the missing inverse of `add-control` and of the entry
  point `create` writes for `targetObject`, neither backed by a bridge op (no
  `RemoveControl`, and security objects have no bridge write path at all), so
  both are XML-only writers admitted through a new `XML_ONLY_MODIFY_PAIRS` gate
  in `bridgeAdapter.ts`. Plus `action="delete"` — removes an object's XML and
  un-registers it from every `.rnrproj` of the model that lists it.
- `d365fo_file`: `remove-diagnostic-suppression` and `add-diagnostic-suppression`
  (`ignore-diagnostic-list`) — add/remove a `<Diagnostic>` in a model's
  `{Model}_BPSuppressions.xml` by its `<Path>` (+ `<Moniker>` when the same path
  carries more than one). `add-diagnostic-suppression` builds the block with the
  same `buildSuppressionXml` the `get_knowledge(kind="bp-moniker",
  action="suppress")` render-only helper already used (that helper now points at
  this operation instead of telling you to paste the block by hand), refuses a
  duplicate (same path + moniker) instead of writing a second copy, and creates
  the file — and its `AxIgnoreDiagnosticList` folder — for a model that has
  never suppressed anything before, in the shape measured from the 339
  suppression lists of a shipped PackagesLocalDirectory. `delete` now also
  strips any suppression whose `<Path>` targets the object being deleted
  automatically, across **every** list in that folder (a model routinely carries
  several, under names tied to neither the model nor a convention), closing the
  gap where deleting an object by hand left its BP-check suppression behind,
  silencing a rule against nothing.

### Fixed
- One definition of `.rnrproj` include identity, on the add side too.
- An XML writer whose first-match replace ranged over a block whose collection also
  nests could land a write on the wrong object and still report success.

---

## [1.12.0] — 2026-08-17

_Reconstructed from `git log` and the release tag: this version shipped without
notes, so the entries below name what changed and why it mattered, not every commit._

### Added
- `get_knowledge(kind="bp-moniker")` — validate an exact best-practice moniker,
  search by scenario when there is no moniker yet, or render a `_BPSuppressions.xml`
  `<Diagnostic>` block. Backed by names extracted from the **local** D365FO install
  and regenerated per instance from that instance's own version, so it never invents
  a moniker or claims one from a different install.

### Fixed
- `add-control` on a **form extension**: values interpolated into the control XML are
  escaped, placement and refusal errors name the right source, a control is placed by
  resolving its parent, and files damaged by the old writer stay usable.
- `run_bp_check` / `build`: `-compilermetadata` points at the model store rather than
  the framework directory, and cleans up after itself.
- `search` falls back to LIKE when FTS5 returns **zero rows**, not only on a syntax
  error — bounded to the queries that fallback can actually answer.
- Guidance stopped telling agents to call method readers that are not published, and
  the class reader stopped promising method bodies a follow-up call cannot deliver.

---

## [1.11.0] — 2026-08-13

### Changed
- `EXTENSION_PREFIX_SOURCE` is now the config key **`naming.prefixSource`**
  (`model` | `config`), asked in the advanced pass of the `naming` section
  (#893). It was `env-only` — a tier meant for values whose reader the
  wizard-managed JSON cannot honestly describe: the cross-model consent
  switches, re-read from the `.env` before every guard decision, and the lock
  heartbeat, read in a process the wizard never configures. This one is a static
  naming preference with no hot-reload path; it landed in that group only
  because registering it was how the docs generator stopped deleting it. The
  cost fell on multi-instance installs, where pinning a prefix meant adding an
  `instances/<name>/.env` holding one line next to the
  `instances/<name>/d365fo-mcp.json` holding everything else. Precedence is
  unchanged — the environment variable still works and still outranks the config
  file — and a legacy `.env` that sets it now migrates into the JSON instead of
  being skipped.

- `d365fo-mcp doctor` reported a prefix conflict that the server does not have
  to anyone who had already pinned their prefix, and offered as the fix the
  setting they had already applied. The check called `inferPrefixFromObjectNames`
  directly, one level below `getInferredModelPrefix`, which is where the pin is
  honoured. It now states the pinned value and names the model's own prefix as
  ignored rather than winning — and warns when the pin has nothing to pin
  because `naming.prefix` is empty.

### Added
- `validate_code`: **COC006** (a table CoC re-reading the record it already holds) and
  **FN001** (a fixed-arity built-in called with the wrong argument count).
- `prepare` answers for the table methods a **kernel type** declares.
- Knowledge: enum conversions documented, and an absent name admitted rather than
  guessed.

### Fixed
- **`extension_metadata` is written on a reindex, not only on a full build.** Until
  this, a field added to a table extension — or a method added to a CoC class — was
  invisible to every reader keyed on the base object until the next rebuild, and
  `resolve_references` reported it as an error that refuses the write carrying it.
- `create` discloses in the response the name the write actually used.
- A class-extension name in element style is rewritten rather than suffixed twice.
- `undo` removes the `.rnrproj` entry on the git path too.
- `run_bp_check` withholds the green tick when nothing has compiled the model.
- `labels` budgets searches by call count, on both verdicts.
- The index stopped trusting a `file_path` that points at the JSON cache.

---

## [1.10.1] — 2026-08-11

_Reconstructed from `git log` and the release tag: this version shipped without
notes, so the entries below name what changed and why it mattered, not every commit._

### Fixed
- Follow-ups to the 1.10.0 audit landing (PRs #889, #890). No tool-surface change.

---

## [1.10.0] — 2026-08-10

_The 2026-08-08 full-repo audit, executed as 23 PRs (#847-#869) plus follow-ups._

### Added
- `CHANGELOG.md` (this file).
- `biome.jsonc` + `npm run lint` — first linter in the project's history.
  Configured as an adoptable subset: rules where a hit is a defect or dead code
  are on, and every rule left off carries the finding count that made it
  unadoptable. Notably this is the only automated check `tests/` and `scripts/`
  receive — `tsconfig.json` `include` is `src/**/*` only.
- `.github/workflows/ci.yml` — `tsc --noEmit` fast-fail, the lint gate, v8 test
  coverage with an enforced ratchet, and the VM-free `*.integration.test.ts`
  tier, which previously had no runner at all.
- Knowledge topic **`extensible-enums`**: `IsExtensible=true` requires
  `UseEnumValue=No` and forbids `<Value>` elements. The create path has enforced
  that (and bypassed the C# bridge over it) since the beginning, but nothing
  taught it, so the only way to learn the rule was to ship XML that xppc rejects.
- `docs/KNOWLEDGE_AUTHORING.md` — how to get a knowledge topic past its three CI
  gates, including the snapshot scoping rule that blocks any new AOT reference.
- `tests/knowledge/entryIntegrity.test.ts` — gates knowledge-entry shape and, in
  particular, that every `related:` id resolves.
- `npm run config:docs -- --check` — fails when `docs/CONFIGURATION.md` has
  drifted from the setting registry.
- `docs/BACKLOG.md` restored: deleted by `5ef1413` with three items still open
  and never migrated, taking their deferral rationale and design sketches with it.
- First tests for four previously-uncovered risk modules: `securityPrivilegeXml`
  (the exact path of the silent empty-privilege incident), `formInfo` (561 lines,
  zero coverage, and the tool the agent reads control names from before every
  form extension), `repairFormControls`, and `fsExtensionScanner` (the fallback
  that exists to stop the agent shelling out to PowerShell).

### Fixed
- `get_method`'s Chain-of-Command template copied the base method's **default
  parameter values** into the wrapper signature — the exact defect `validate_code`
  reports as `COC001` and the `coc-authoring` topic forbids. It was also
  undetectable: the template strips access modifiers and `COC001`'s regex only
  fired on lines carrying one. Both halves fixed.
- Knowledge base said `curExt()` was deprecated (topic `deprecated`), mandated it
  (topic `multi-company`), and used it without comment (topic `direct-sql`) — and
  the stated "replacement" called `curExt()` itself while returning a different
  type. The `deprecated` topic now carries an explicit *NOT DEPRECATED* block for
  the APIs models most often hallucinate as obsolete.
- `crosscompany` container rule taught syntax that does not parse.
- Five dangling `related:` topic ids. The default (concise) formatter prints
  related ids without resolving them, so each one cost a wasted round trip.
- `docs/MCP_TOOLS.md`: 32 → **39** AOT object types, 25 → **31** modify
  operations, and `GROUNDING_ENFORCE` documented as defaulting **off** (it does).
- `docs/NEW_TOOL_CHECKLIST.md` rewritten — it had never been updated after
  `a49488a` moved tool schemas out of `mcpServer.ts`, so following it literally
  failed at three separate steps.
- `docs/CONFIGURATION.md` regeneration is now lossless. It had been hand-edited
  after generation, so `npm run config:docs` deleted three real environment
  variables (`EXTENSION_PREFIX_SOURCE`, `D365FO_CROSS_MODEL_WRITE_MODELS`,
  `D365FO_ALLOW_CROSS_MODEL_WRITE`) and reintroduced a wrong tool count.
- `QUICK_START.md` and `SETUP.md` disagreed on which setup scenario is D and
  which is E; two dead `SETUP.md#…` anchors.
- Every remaining place that still advertised the pre-consolidation tool
  surface. README's **first line** said "25 AI tools"; `MCP_EXTRA_TOOLS` was
  documented with `security_info,get_method` in README, `MCP_CONFIG.md` and the
  `server.extraTools` placeholder (which generates `CONFIGURATION.md`); `SETUP.md`
  promised the write-only companion exposes `get_method`; and
  `.github/copilot-instructions.md` — handed to the agent verbatim — taught
  `get_method(include="signature")` as *the* route to a CoC signature, which is a
  guaranteed unknown-tool call. `get_method`, `suggest_edt` and `batch_get_info`
  have been folded into `get_object_info`/`prepare` since 1.9.0; their handlers
  still route, so nothing broke loudly — it just cost a round trip each time.
- The tool-count gate could not see either shape that had drifted. It matched
  only a count directly adjacent to "tools", so `"25 AI tools"`,
  `"25 specialized MCP tools"` and `"18 tools instead of 25"` all passed. It now
  bridges up to three intervening words and reads the second number of a
  comparison, and a companion gate forbids naming a retired-but-routable tool in
  the eight files a reader or an agent is actually pointed at.
- `tests/utils/loadEnvDepth.test.ts` measured the developer's machine rather than
  `loadEnv`: with no config in the temp tree, precedence rule 4 falls back to
  `process.cwd()/.env`, which under vitest is the repo root. Any working
  (gitignored) `.env` therefore supplied a real `D365FO_PACKAGE_PATH` and the
  "no configuration anywhere" case failed locally while passing in CI. The test
  now runs from its own temp directory.

### Removed
- README's *"Keep the tool catalogue small"* section. The advice it carried
  (turn off unused tool sets; `MCP_TOOL_PROFILE=core`) is documented where it is
  configured — [`docs/CONFIGURATION.md`](docs/CONFIGURATION.md) and
  [`docs/MCP_CONFIG.md`](docs/MCP_CONFIG.md).

---

---

## [1.9.0] — 2026-08-07

### Changed
- **Round-trip cost work.** Per-call boilerplate cut out of tool responses;
  cached context is re-billed on every round trip, so payload trimming and
  round-trip elimination were both pursued.

### Fixed
- Guidance text no longer tells the agent to call tools that no longer exist.
- `setup` stopped writing `README.md` into the solutions folder.

## [1.8.5] — 2026-08-07
Write-anchor handling and `add-field` on enums.

## [1.8.4] — 2026-08-07
### Changed
- **Cross-model write consent moved to configuration** and extended to cover
  `create`. Consent deliberately lives in the environment rather than in a tool
  parameter: a parameter is something the agent can grant itself.

## [1.8.3] — 2026-08-07
### Added
- Writes into another custom model are refused by default, with the extension
  route in the active model offered instead.

## [1.8.2] — 2026-08-07
### Fixed
- `workspaceDetector` no longer silently picks the wrong `.rnrproj` when a
  solution holds several; ambiguous workspaces now resolve the model and list the
  candidates instead of guessing.
- Project-folder names corrected for enum extensions ("Base Enum Extensions"),
  menu items ("&lt;Kind&gt; Menu Items") and security duty/role extensions.
- `symbols.file_path` indexed; the prefix is taken from the active model.

## [1.8.1] — 2026-08-04
Test-timeout fix. (Tagged without a `package.json` bump — 1.8.0 → 1.8.2 in the
manifest.)

## [1.8.0] — 2026-08-04
### Added
- Bridge and DB handles are released on shutdown.
### Fixed
- Transport errors return under the client's own request id.
- Configuration loads before the modules that read it.
- Remaining single-op RPC dispatch gaps in the bridge.
- Three tool queries no longer scan the symbol table.
### Docs
- Architecture diagram corrected — the bridge is not the sole write path; the
  eval loop gets its own block.

## [1.7.0] — 2026-07-30
### Added
- `AxTable` audit system fields and `AllowRowVersionChangeTracking` exposed to
  the writers; `modify-property` for data entities.
- `AxDataEntityView` writer expresses change tracking, key naming, `IsPublic`
  and the canonical skeleton.
### Fixed
- Grounding: `Type::member` is recognised even when a local is named after the
  type; an unknown parameter list is distinguished from an empty one.
- Extension write gaps across table/form/data-entity extensions; base-table
  relations routed to `RelationExtensions`.
- `undo` no longer deletes `<Folder Include>` entries it never added.
- Labels are compiled with `labelc.exe` before the X++ compile.

## [1.6.0] — 2026-07-29
### Fixed
- `AosService` is found by scanning drives instead of assuming `K:`; platform is
  read per call rather than once at import.
- `prepare` walks the extends chain for inherited methods.
- A finished build is never replayed as a fresh result.
- `get_object_info` falls back to the symbol index when the bridge is silent.

## [1.5.2] / [1.5.1] / [1.5.0] — 2026-07-27
### Added
- `setup` generates `.mcp.json` and stages the Copilot setup files.
- Adaptive concurrency in metadata extraction.
### Changed
- Repo cleanup and doc consolidation (`5ef1413`) — this is the commit that
  deleted `docs/BACKLOG.md` and five other docs.

## [1.4.0] — 2026-07-23
### Fixed
- Line endings of bridge-written artifacts normalised.
- Query writer emits ranges instead of inventing a literal `Title`.
- Macro, aggregate-measurement and license-code writers corrected against what
  the Microsoft serializer actually produces.
- `get_object_info` for classes stopped rendering `/// <summary>` as the method
  signature.

## [1.3.0] — 2026-07-22
### Changed
- **`better-sqlite3` replaced with core `node:sqlite`** — removed the native
  build dependency that was blocking App Service startup.
### Fixed
- Search prioritises custom/ISV models so they are not buried under Microsoft
  objects.

## [1.2.0] — 2026-07-22
### Fixed
- `d365fo_file(modify)` stopped discarding parameters in silence.
- The create/generate path stopped emitting metadata that cannot build.
- The read/search/info tools stopped misreporting metadata.
- The golden oracle and `bp_clean` became honest measurements — a never-run BP
  check no longer reads as a pass.

## [1.1.0] — 2026-07-21
First iteration after the public release.

## [1.0.0] — 2026-07-21
First public release.
