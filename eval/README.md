# Agent eval loop

The self-improving agent eval loop. Full design in
[docs/AGENT_EVAL_LOOP.md](../docs/AGENT_EVAL_LOOP.md); live coverage status in
[COVERAGE.md](COVERAGE.md).

All phases described in the design doc are implemented: the golden + SysTest
oracle, the corpus, and the improver toolchain (clustering, held-out
regression, knowledge feedback, flake detection, case mining, fix-brief
generation) are all live. This file covers the mechanics of running a case by
hand and the standing work queues.

## Layout

```
eval/
├── README.md                     ← this file
├── cases/
│   ├── schema.json               ← JSON Schema for a use-case spec
│   └── <case-id>.json            ← one file per case (catalog listing: COVERAGE.md)
├── goldens/
│   └── <case-id>/                ← committed, reviewed golden metadata (one or more *.metadata.xml)
├── systests/
│   └── <case-id>.xml             ← SysTest class for code-heavy cases (runtime oracle)
└── corpus/
    ├── schema.json               ← JSON Schema for a run record
    └── runs/                     ← one .json run record per run (committed — what the improver clusters)
```

## Sandbox prerequisites (VM)

The sandbox model's `Descriptor/<Model>.xml` must list in `ModuleReferences`
every package a case **names directly** — xppc does not resolve package
references transitively for directly-named types. Today that is
`ApplicationSuite`, `Directory`, `Ledger`, `ContactPerson`, `Currency` and
`FleetManagement` (`L2-coc-extension` wraps `FMVehicleDataContract`). A missing
entry makes the case unbuildable in a way that reads like a tool defect — it is
a recurring `ENV_FLAKE`, so check the descriptor before triaging one.

## Manual run checklist (implementer path, on the VM)

Run with the mcp-server in `full` mode + C# bridge, pointed at a **throwaway
sandbox model** (never a real customisation model).

1. **Isolate** — create/confirm an empty sandbox model for this run.
2. **Implement (grounded only)** — drive the case `instruction` through the
   tool path: `prepare` → query tools (`search`, `object_info`, …) →
   `validate_code(mode="references")` → `generate_object` → write via
   `d365fo_file(action=create)`. No hand-edited XML.
3. **Static gate** — record `validate_code` references + syntax results.
4. **Build** — `build_d365fo_project`; capture `errors[]` and `bpWarnings[]`.
5. **Oracle** — normalise the produced metadata and diff against
   `goldens/<case-id>/` (see `eval/goldens/L1-table-basic/README.md` for a
   worked example of capturing a golden the first time).
6. **Score & record** — fill one record matching `corpus/schema.json` and drop
   it in `corpus/runs/`.
7. **Roll back** — undo the write / wipe the sandbox model.
8. **Triage** — classify any failure per the rubric in the design doc (§9);
   record the hypothesis, not a fix.

Each run produces **one corpus record + a verdict** on whether the case passed
build / BP-clean / golden — and, if not, which rubric class it fell into. The
improver toolchain clusters these to prioritize the next fix.

## Automated oracle

Steps 5–6 (normalise → diff golden → score) are automated and VM-free in
[`src/eval/oracle/`](../src/eval/oracle/):

```
npm run eval:score -- <caseId> <actualXml.xml> [--bp-warnings N] [--build-failed] [--systest <file>] [--write]
npm run eval:score -- <caseId> --actual-dir <dir> [...]   # multi-artifact cases
```

It flattens both the actual and the golden to an order-independent `path → value`
map (collection members keyed by `<Name>`/`<DataField>`; `ModelSaveInfo`/`@Id` and
per-case `ignore` globs stripped), diffs them into `missing/extra/changed`, and
prints the scorecard. `--write` appends a corpus record to `corpus/runs/`.

### Runtime oracle

For code-heavy cases, "compiles + golden shape" is not enough — correctness IS the
behaviour. Such a case carries a SysTest class (`eval/systests/<id>.xml`); after the
build, run it with the `run_systest_class` tool, save its text output to a file, and
pass `--systest <file>`. The oracle parses it into `{ ran, passed, failures }`
(via `src/eval/oracle/systest.ts`) and folds `systest` into the scorecard.

## Triage bias: an honest failure beats a confident lie

The most damaging defects the sweeps have found were **the tool asserting a
falsehood** rather than failing: claiming a standard EDT did not exist when the
bridge was merely unreachable, returning `✅ success` for a parameter that was
silently discarded, scoring `bp_clean: 1` from absent evidence, naming the wrong
cause in a fallback message, recommending a label syntax the compiler rejects.
Each one sent the agent off to "fix" something that was already correct.

Two consequences for triage:

- **Making the failure honest is a real fix**, not a placeholder for one. It is
  also provable in-repo even when the root cause is not, so prefer it over
  leaving a confident lie in place while the deeper fix waits.
- **A green dimension needs provenance.** `bp_clean: 1` means BP ran and was
  clean (`build.bp_checked: true`), never "BP was not run". A golden that was
  captured from defective output can never fail on the thing its case exists to
  catch — score the live behaviour (a chain walk, a SysTest), not just the shape.

## Corpus integrity

`loadJsonRecords` **silently skips** a record it cannot parse — its own doc
comment says so and asks the caller to compare the returned count against the
directory listing. Nobody did, so a `TOOL_DEFECT` record written on 2026-07-07
(`L4-headerlines-document-slice`) sat unreadable for eight weeks: invisible to
every cluster, report and held-out check, which were all computed over a corpus
that was quietly one run short. The cause was a writer emitting Windows paths
into JSON without escaping the backslashes.

`tests/eval/corpusRecordsParse.test.ts` is the check that doc comment asked for.
A BOM is a different, already-handled hazard — `stripBom` covers it, and 52
records rely on that.

## Improver toolchain

`npm run eval:clusters` (prioritized failure clusters) · `eval:report` (corpus
scoreboard) · `eval:knowledge` (MODEL_ERROR → knowledge-base proposals) ·
`eval:flakes` (flake detection) · `eval:mine` (draft a case from a failure
description) · `eval:brief` (top-priority cluster → Markdown fix brief).

## Golden compile re-verification

`npx tsx scripts/verify-goldens-build.ts` (VM) writes every captured golden into
the sandbox **one case at a time**, full-builds it with xppc directly, and
records the verdict in [`golden-build-verification.json`](golden-build-verification.json).
Isolation is not optional: a bulk pass both hides failures (one case's object
satisfies another's dangling reference) and invents them (cases legitimately
reuse names that never coexist in a real run) — measured at 12 bulk errors, 0
real. Pre-existing files are never overwritten, so a fixture the case reads is
reported as `skipped` rather than compile-verified.

**Current record: 93/100 clean over 224 artifacts** (2026-08-30, xppc
7.0.7996.33, model `fm-mcp`). The catalog grew by 35 cases since the previous
record, so this is the first isolated verdict for a third of it. Exactly three
cases changed state, and they are the three this sweep set out to fix
(`L1-form-basic`, `L1-form-detailsmaster`, `L1-form-simplelistdetails`); nothing
regressed. Of the seven that still fail, five are the pre-existing classes below
and two (`L3-dmf-entity-import-slice`, `L3-trade-agreement-price-lookup`) are
first-time results for cases the previous record never covered.

The previous record was **57/65 clean over 143 artifacts** (2026-07-29, xppc
7.0.7858.27). A sweep on 2026-07-28 reported **65/65** over the same 65 cases,
the same 143 artifacts and the same two fixture skips; it does not reproduce
against a sandbox that holds only the fixture. The 07-28 number therefore rested
on **catalog residue** — objects earlier runs had created and not rolled back,
sitting in the sandbox and satisfying references the goldens do not carry
themselves. A clean `--baseline` does not prove an empty sandbox: it only proves
that whatever is in there compiles. Inventory `<Model>/<Model>/Ax*` before
trusting an isolated verdict.

The failures (per-case errors in the JSON), by class — the table below was
written against the eight of the 2026-07-29 record; the fixture row is now
closed, and the two first-time failures are not in it:

| Class | Cases | Evidence |
|---|---|---|
| Golden defect, environment-independent | `L1-map-basic`, `L1-form-workspace`, `L3-form-detailstransaction` | a map field named `CreatedDateTime` (reserved for system fields); 4 `FormPatternValidation` errors on the workspace Design; `ConDemoNoteHeaderLine.LineNum` EDT data-type mismatch |
| ~~Fixture ⇄ golden mismatch~~ **CLOSED 2026-08-30** | ~~`L1-form-basic`, `L1-form-detailsmaster`, `L1-form-simplelistdetails`~~ | all three bound a grid to field group **`Overview`** on `ConDemoNoteHeader`, which no fixture and no golden declared. Root cause was a create-path defect (`<FieldGroups>` was a hardcoded literal, so `properties.fieldGroups` was dropped) — see below |
| Cross-case dependency the case never creates | `L4-entity-security`, `L2-oracle-discriminator-random-wrapper-name` | menu item → form `ConDemoNoteHeaderList` (created by `L1-form-basic`); form extension → field `ConHasNotes` (created by `L2-form-extension-basic`'s table extension) |

The last class cannot pass a *real* case run either — the protocol rolls back
every case, so the dependency is gone by the time the next one starts. Each of
the eight needs the question settled first and only then a re-capture through
the tool path (`eval-run`); re-capturing straight from output that may itself be
defective is how a golden stops being able to fail on the thing its case exists
to catch.

**2026-08-23 catalog audit — four of the eight now have their question settled**,
in the spec and the fixture only. None of them is re-captured; each still needs a
VM `eval-run`, and until that lands the case will diff against a golden that no
longer matches its own instruction. That is the intended state: the instruction is
now right and the golden is visibly stale, rather than both being quietly wrong.

**The `Overview` half is no longer a hypothesis — it is measured** (VM, model
`fm-mcp`, xppc 7.0.7996.33, 2026-08-23). Provisioning the fixture and building it
gives 0 errors, and the group survives a read-back byte for byte. Adding
`L1-form-basic`'s golden FORM on top of that fixture also builds 0 errors. Taking
the group back out of the fixture and rebuilding reproduces the recorded failure
exactly:

```
Metadata Error: AxForm/ConDemoNoteHeaderList/Design/Controls/Grid/DataGroup:
  Field group 'Overview' does not exist.
```

So the fixture is the artifact that was wrong, the three form cases were right,
and what remains for them is only the table-golden re-capture — not a question.
The one warning in every build above is the environment's pre-existing
`AttributeBasedPricing` external reference, which an empty sandbox carries too.

| Case | What was settled | Still to do |
|---|---|---|
| `L1-map-basic` | The instruction demanded a map field `CreatedDateTime` mapped 1:1 to `ConDemoNoteHeader` — a name reserved for system fields (which `L1-table-basic` already forbids in its own wording) *and* a column that table never declares, so the mapping pointed at nothing. The map is now two fields, `NoteId` + `Subject`. | Re-capture the golden. |
| `L1-form-basic`, `L1-form-detailsmaster`, `L1-form-simplelistdetails` | The `Overview` field group the three grids bind to via `<DataGroup>` existed in no fixture and no golden. The form goldens are the evidence it existed when they were captured, so the **table** golden is what drifted: `eval/fixtures/ConDemoNoteHeader.metadata.xml` now declares the group, and `L1-form-basic`'s instruction requires the case to create it. | **Done 2026-08-30** — re-captured; all three build clean. |

### 2026-08-30 — the fixture class is closed, and it was a tool defect

The 08-23 audit settled the question and named the remaining work as "re-capture
`L1-form-basic`'s table golden". That capture has now happened, on the VM
(xppc 7.0.7996.33, sandbox `fm-mcp`), and it turned up **why** the golden had
drifted rather than just repairing it:

- `d365fo_file(action="create", objectType="table")` rendered `<FieldGroups>` as a
  hardcoded literal, so `properties.fieldGroups` was dropped without a word. The
  golden faithfully recorded the loss. Fixed in #963.
- The same builder dropped `properties.indexes` too, and that one had no way
  back: the repair `createTablePropertyHonesty` offered (`add-index`) needs the C#
  bridge, so a create on the template path could not produce an index at all.
- `L1-form-simplelistdetails` was a **second, separate** defect that the first one
  had been masking: its golden's `<DataGroup>` carried no sibling `<DataSource>`,
  so the group could not be resolved against any table. It too was re-captured.
- The three form templates hardcoded `<DataGroup>Overview</DataGroup>` whether or
  not the bound table declared the group. The builder now reads the table and
  omits the element only on **positive** evidence of absence — a table it cannot
  read leaves the binding alone.

`L1-form-detailsmaster` needed no re-capture: it went green as soon as the
fixture table was right, which is the evidence that the fixture, not that form,
was the broken artifact. `eval/fixtures/ConDemoNoteHeader.metadata.xml` is
re-synchronised with the re-captured golden, so it is a copy of a golden again
rather than a hand repair of one.

The remaining four (`L1-form-workspace`, `L3-form-detailstransaction`,
`L4-entity-security`, `L2-oracle-discriminator-random-wrapper-name`) are
unchanged and still need their question settled first.

**A fifth golden is now known-wrong, for a different reason —
`L4-entity-security/ConDemoNoteHeaderMaintain.metadata.xml`.** Its entry-point
`<Grant>` reads `Read, Update, Create, Delete`. The Microsoft deserializer is
sequence-ordered, so `Create` and `Delete` were dropped: the privilege granted
read+update, built clean and passed xppbp. The generator was fixed on 2026-08-23
(both emitters — `securityPrivilegeXml.ts` and the `security-privilege` scaffold
in `codeGen.ts`), so the golden no longer matches what the tool produces.

Do **not** hand-edit it. It is the textbook instance of the warning at the top of
this section: the golden was captured from the real `create` path, its header
records a live chain walk (`role -> duty -> privilege -> entry point`) — and that
walk verified the chain's *shape* while the permissions on it were silently
wrong, so the golden could never fail on it. Re-capture through `eval-run` once
the case's own cross-case dependency is settled. Until then the case is expected
to diff here, and that diff is the fix working.

**One golden WAS updated in place, and the distinction matters —
`L2-form-control-removal-lifecycle/ConDemoRemovalNoteForm.DemoExt.metadata.xml`.**
It carried an empty `<ControlModifications />` because it was captured from a run
in which that step **could not be performed at all**: `modify-property` on a form
extension had no writer for that collection, so it wrote a form-level property
instead and hid the whole form under a ✅. §6.4 covers this — "an intentional
behaviour change updates the golden in the same PR" — and the writer added here is
exactly that.

That is the opposite situation to `L4-entity-security` above, and the two must not
be treated alike. The `L4` golden was captured from a path that *worked* and
emitted silently wrong content, so re-capturing it would launder a bug into the
contract. This one recorded a MISSING FEATURE, and the content that replaces it is
specified independently by the case instruction, which calls that control
modification "the correct completion of this step". It was regenerated by running
the shipped writer against the golden's own prior state rather than typed by hand,
and the same three nodes were verified on the VM: 0 build errors, correct
`xmlns=""`, correct sibling indentation, and idempotent on a second call.

Re-running the writer over the golden also exposed a defect nothing else could
see: it emitted `\n` into a CRLF document, leaving real AOT files with mixed line
endings. xppc does not care — which is why the live run still built clean — so it
took a byte-level look to find. Fixed, with the writer now taking the host
document's ending from `detectEol`.

**Five controller goldens were updated in place on 2026-08-30, and two report
goldens were deliberately left stale in the same commit.** The generator stopped
emitting a contract local that `prePromptModifyContract()` never reads, which is
the `BPLocalVariableNotUsed` warning every captured report carried. That method
body has no index dependency, so the five controller files
(`L4-ssrs-report-advanced`, `-multidataset`, `-preprocess`, `-uibuilder`,
`L3-print-mgmt-doctype-extension`) were rewritten to what the generator now
emits and pinned by `tests/tools/generateSmartReport.test.ts` — the
`L2-form-control-removal-lifecycle` case above, not the `L4-entity-security` one.

The same commit made EDT resolution model-aware (a field of that name already in
the target model wins; another module's prefix + the field name is demoted). The
tmp tables of `L4-ssrs-report-advanced` and `L4-ssrs-report-multidataset`, the
only report goldens captured from a bare `fieldsHint`, would therefore re-run to
`Num` / `Name` / `Counter` instead of `PlCorrNoteId` / `smmSubject` /
`PurchLineCount`. Those values need the live index and the provisioned fixture,
so both goldens stay as captured, are marked stale in their own READMEs, and
wait for an `eval-run` re-capture. `L4-ssrs-report-basic`'s golden — typed by a
human reading the source table — already holds the expected shape.

All five edited goldens, plus the two goldens frozen back in July
(`L3-print-management-report`, `L3-electronic-reporting-integration`, whose
compilers and sandbox have both moved on since), were re-verified the same day
with `scripts/verify-goldens-build.ts --case <id>` — a new flag that runs the
isolated per-case build for named cases only and, like `--limit`, writes to the
scratch record so a targeted check can never overwrite the committed one.
Result: **7/7 clean over 38 artifacts**, xppc 7.0.7996.33, model `fm-mcp`, after
a clean `--baseline`. The two July goldens needed no re-run: neither goes near
the report scaffold (one subclasses `PrintMgmtDocType` on its own base enum, the
other is a single ER data-provider class), so the Phase F generator corrections
could not have touched them.

The sweep exists because the `build_d365fo_project` stale-result defect
(`tests/tools/buildStaleResult.test.ts`) had made every non-`force` `pass@build`
weaker evidence than it looked.

## Status & open work

**Coverage is generated, never hand-maintained.** `npm run eval:coverage`
rewrites [COVERAGE.md](COVERAGE.md) + `coverage.json` from the live catalog,
knowledge base and tool schema; `-- --check` is the CI gate. Read the numbers
and the weight-ordered closure queue there, not from prose.

**What that 100% does and does not measure.** The taxonomy in
`src/eval/coverage/taxonomy.ts` is indexed by the **artifact** a case produces
(table, form, SSRS report, …) and by cross-cutting X++ topics. It is not indexed
by the **write operation** that produced the artifact, so `d365fo_file`'s
`operation` enum is invisible to the number: as of the 2026-08-23 audit, 16 of
its 37 operations appeared in no case instruction and coverage still read
core 44/44. The three newest families are the ones that matter — `remove-control`
/ `remove-entry-point` / `action="delete"` (PR #922), the BP-suppression ops
(PR #924) and the query-range ops (PR #927) each shipped, then needed a follow-up
audit PR to close real defects, and the catalog had nothing to say about any of
them. Four cases now cover the first three families end-to-end
(`L2-form-control-removal-lifecycle`, `L2-object-delete-and-entry-point-cleanup`,
`L2-bp-suppression-lifecycle`, `L2-entity-query-range-roundtrip`, all
`golden_pending` and tagged `write-op-coverage`). They land in COVERAGE.md's
**Orphans** list, because no leaf claims them — which is the honest reading:
until the taxonomy grows a write-operation axis, a missing op cannot make the
percentage fall. Still uncovered by any case: `replace-all-fields`,
`add-full-text-index` / `remove-full-text-index`, `add-table-mapping` /
`remove-table-mapping`, `remove-relation`, `add-delete-action` /
`remove-delete-action`, `remove-field-group`, `add-field-modification`.

**The catalog itself is gated.** `tests/eval/caseCatalog.test.ts` (VM-free)
validates every spec against `cases/schema.json`, checks `golden_pending`
against the actual golden folder, checks `target_artifact_types` against the
root element of each committed golden, and refuses an instruction that names a
tool the published tool list does not contain. It exists because the audit found
all three drifting at once: 15 instructions still pointed the implementer at
`get_method` / `suggest_edt` (unpublished — `toolHandler.ts` keeps the routes
only as a recovery hint) or at `get_form_info` / `get_label_info` /
`find_object`, which were never tool names at all, and 7 specs under-declared
their own golden.

**Warehouse-app screen cases — CAPTURED 2026-08-30 (`09dfcc2`, PR #970).** All
four ran on the VM: `L3-processguide-flow-slice`,
`L2-processguide-page-control`, `L3-legacy-workexecutedisplay-extend` and
`L3-warehouse-scan-resolve-slice` are `golden_pending: false`, their goldens are
committed under `eval/goldens/`, and each has a corpus record scoring `build: 1`
and `bp_clean: 1`. Nothing is owed on them.

*(One neighbour is not quite finished: `L3-warehouse-work-slice` has a captured
golden and `build: 1`, but its corpus record carries `bp_clean: null` — BP never
ran for it. That is a real, small gap, not a claim to fix in prose.)*

The dry-run table below is kept because it is what could honestly be claimed
BEFORE the capture, and because the asymmetry it describes is the point: a
grounding test proves the ground truth is reachable, and nothing more.

<details>
<summary>What ran VM-free first, and what it proved (2026-08-30, before the capture)</summary>

| Ran | Result |
|---|---|
| `tests/eval/mobileAppCaseGrounding.test.ts` — executes each case's own grounding calls (`get_knowledge`, `object_patterns(domain="mobile-app")`) in process and asserts the answer names the identifiers the case then asks for | 5/5 pass — the ground truth each case depends on is reachable and complete |
| `tests/knowledge/mobileAppPatternCatalog.test.ts` — every shipped X++ skeleton through the same offline BP validator behind `validate_code(mode="syntax")` | 16/16 pass, 0 error-severity violations across 6 skeletons |
| `tests/eval/caseCatalog.test.ts` | schema-valid, `golden_pending` consistent, no unpublished tool named in an instruction |
| `npm run eval:knowledge-audit` | 0 refs outside the audited snapshot — the new topics name AOT elements in prose only, so no re-capture is owed |
| `npm run eval:coverage -- --check` | core 100%, total 98/100 — the two new leaves are the visible gap |

**Why nothing more could be claimed then:** the implement → build → score →
record cycle needs the D365FO VM (full-mode server, C# bridge, sandbox model,
`xppc`). That authoring session had no VM attached, so there was no build result,
no BP result, no golden and no corpus record — and none was written, because a
corpus record asserts that a run happened. `eval-run` on the VM is what closed
them, the next day.

</details>

Standing queues:

- **Capture the pending goldens (VM).** Cases with `golden_pending: true` have
  been authored but never run; coverage counts them as uncovered because they
  prove nothing until captured. `eval-run` captures each on the VM — flip the
  flag as each lands.

  Nine of them arrived together on 2026-08-30 with the compiler-verified language
  work, and they are why core coverage reads 86.4% rather than 100%:
  `L2-runtime-functions-arity`, `L2-implicit-conversions`,
  `L2-select-find-options-joins`, `L2-args-record-caller`,
  `L2-display-edit-methods`, `L3-form-event-handler-class`,
  `L3-sysoperation-dialog-attributes`, `L2-systest-authoring-basic`,
  `L3-report-dataset-extension`. Each has a knowledge entry written from a
  compiler probe and a tool path that can produce it; what none of them has yet is
  a build that proves the two agree. The number is supposed to fall when the
  taxonomy grows honestly — it climbs back one captured golden at a time.
- **Coverage closure loop** (~2–4 leaves/week): `eval-author` drafts a case for
  each leaf missing **E** → `eval-run` captures the golden → MODEL_ERROR
  clusters flow through `knowledgeFeedback` into proposed knowledge entries
  (human review stays mandatory, as the module enforces) → TOOL_DEFECT /
  VALIDATOR_GAP go down the standard improver path. Where model training data
  is weak, the knowledge entry's canonical example is mined from the real AOT,
  not written from memory.
- **Platform drift**: 100% is relative to the current platform version. A
  monthly release-notes check adds new leaves flagged `uncovered`, so staleness
  is visible instead of hidden.
- **Knowledge audit** — closed against this repo (`npm run eval:knowledge-audit`
  + `tests/knowledge/apiSymbols.test.ts` + `exampleValidation.test.ts`), with
  two gaps still open: the `d365fo-cli` skill files (separate repo) have never
  had the `apiSymbols` treatment, and proving knowledge code examples actually
  *compile* needs a real VM build — only the offline BP slice is automated.

Blocked / declined (not planned):

- ~~`SysTestConsole.exe` requires an interactive console session~~ — **wrong, corrected
  2026-08-30.** The binary documents `/unattended` in its own `/?` output, and with that
  flag it skips the debugger-attach prompt and reaches "Executing test(s) ....". The tool
  passes it now. What blocks a run on THIS VM is a different, and specific, thing: the
  telemetry logger the runner touches on its way into `ExecuteTest` fails with
  `Could not load file or assembly 'Microsoft.ApplicationInsights, Version=2.22.0.997'`,
  because `Bin\SysTestConsole.exe.config` redirects that assembly to 2.22.0.997 while the
  DLL shipped in `Bin` is 2.23.0.0. Fixing it is a one-line edit to a Microsoft-owned
  config file — a change to the platform installation, deliberately NOT made here.
  Both assembly faults were fixed on this VM by CONFIG edits only, each with a backup
  beside the file: the redirect now names 2.23.0.29, and `ModelUtilDlls` was added to the
  `<probing privatePath>` so the correctly-redirected System.ValueTuple 4.0.3.0 is found.
  The runner then reaches the DATABASE and stops at `Login failed for user 'AOSUser'`.
  **That was read as a rotated credential for weeks, and it is not one.** Nothing has
  rotated: `Bin\SysTestConsole.exe.config` is the SHIPPED TEMPLATE, never configured for
  this machine, and it disagrees with the AOS's own `WebRoot\web.config` on all four
  DataAccess settings — database (`AxDbRain` vs `AxDB`), user (`AOSUser` vs `axdbadmin`),
  server (`.` vs the real host) and password (`$CREDENTIAL_PLACEHOLDER$` vs an 828-char
  encrypted blob). The fix is to copy the four values across, keeping a backup; it edits
  the PLATFORM install and handles a secret, so it is the owner's call to make, not a
  tool's. `run_systest_class` now performs that comparison itself and reports which
  settings differ (never the password — only "placeholder" or "set, N chars"), so the
  next reader is not sent hunting a password again.
  **Applied and verified 2026-08-31 — the runner CONNECTS.** The owner copied the
  four values; `compareSysTestDataAccess` reports no drift, and
  `SysTestConsole.exe /test:<a class that does not exist> /unattended` now answers

      [SysTestSuite.Rainier Test Suite] [initial partition: [UT01], initial company: [DAT] …] Suite started
      Rainier Test Suite : 0 Run, 0 Failed

  instead of `Login failed`. That is real AOS session data, so the connection is
  open — and it closes the one unknown this entry carried: the encrypted password
  blob **is** decryptable by the account the runner executes as, so no second
  blocker was hiding behind the first. **The runtime oracle is live for the first
  time.**

  **And a SysTest has now actually EXECUTED** (2026-08-31 12:05, during the
  `L2-coc-extension` runtime run). `SysTestListenerXML` wrote real per-method
  results with real timings:

      EvalL2CocCarFactsTest.testCarFactsSummaryAppendsVerifiedSuffix   success  1704 ms
      EvalL2CocCarFactsTest.testWrapperPreservesBaseValueForDifferentInput  success  390 ms

  That is the first time in this project's history that X++ test code ran and
  reported.

  **The negative control then proved the oracle DISCRIMINATES** (2026-08-31 16:33).
  A run of "success" only tells you the instrument is on, so `ConDemoOracleControlTest`
  was built with three methods — one that must pass, one that fails an assertion,
  one that fails by throwing — and run in a single pass:

  | method | reported |
  |---|---|
  | `testControlPasses` | **true** |
  | `testControlFailsByAssertion` | **false** — "DELIBERATE: … (Expected: 99; Actual: 2)" |
  | `testControlFailsByThrow` | **false** — "An unknown exception caught! (Actual: DELIBERATE: …)" |

  Suite `success="false"`, and `run_systest_class` returned `❌ Tests failed`. Both
  failure modes are distinguished from the pass IN THE SAME RUN, so the result is
  not a coincidence of ordering. `parseSysTestXml` was then run over that document
  and returned the same 3 outcomes with both messages — so the repo's own reader
  agrees with the runner, which is the half a passing run cannot show.

  **The runtime oracle is therefore trustworthy, not merely alive.** What remains
  is ordinary work: the four `systest_pending` cases still have to RUN their own
  tests, because the control proves the instrument, not those cases. The sandbox
  was restored and a full build is green.
  The four cases (`L2-coc-extension`, `L3-batch-basic`, `L2-event-handler-basic`,
  `L3-enum-field-form-downgrade-guard`) keep `systest_pending: true` until each one
  actually RUNS: their test classes were rolled back after their goldens were
  captured, so re-running them means an `eval-run` per case. `L2-tdd-red-green-cycle`
  — the case that proves the loop rather than the authoring — can now be authored
  honestly, which it could not be while no test had ever executed.
  `vstest.console.exe` + `RunnableDropSysTest.TestAdapter.dll` discovers zero
  tests: still a dead end, and no longer needed as a fallback.
- CI-workflow half of the autonomous improver. The VM-free fix-brief generator
  (`npm run eval:brief`) is done; running Claude Code unattended on top of it in
  GitHub Actions was **explicitly declined** as a new autonomous-agent surface
  needing its own sign-off. Not planned unless asked again.

The isolation invariant (all eval writes pinned to the sandbox model, never a
real customisation model, never `D365FO_CUSTOM_PACKAGES_PATH` at one) is
[AGENT_EVAL_LOOP.md §11](../docs/AGENT_EVAL_LOOP.md) and is not negotiable.
