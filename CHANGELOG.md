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

### Fixed
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
  security privilege, `generate` output is now byte-identical to what `create`
  writes to disk, macro directives included.
  `tests/tools/xmlTemplateGeneratorSingleton.test.ts` fails if a second class or
  a second `generateAx*Xml` implementation ever appears — output-comparison
  tests cannot catch this, because a fork drifts in the methods nobody thought
  to compare.
- Seven rewrites of EXISTING files moved onto the atomic write helper: the two
  post-create reconciliations in `createD365File.ts`, and the `.label.txt`
  rewrites in `createLabel.ts` and `renameLabel.ts`. A torn write to a
  `.label.txt` does not corrupt one label, it corrupts every label in that
  model's file, and that file has no undo outside git.

### Changed
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
  description that had become an essay. `ListTools` fell from 48,019 to 44,932
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
