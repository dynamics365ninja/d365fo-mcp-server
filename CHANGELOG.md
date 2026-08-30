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

### Added
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

### Fixed
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

### Changed
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
