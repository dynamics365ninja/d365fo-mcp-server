# Golden: L3-warehouse-work-slice - FROZEN

`golden_pending: false` since 2026-08-03. Every byte comes from the grounded
`d365fo_file` path; nothing here is hand-authored.

| Capture | Server SHA | Role |
|---|---|---|
| 2026-08-03 (first capture) | `dffe0dc` | first-time run, no prior draft for this case; full grounded run, `Errors: 0`, offline BP validator clean; golden captured from this run's own verified output |

Platform xppc 7.0.7858.27, model `Contoso`, `EXTENSION_PREFIX=Con` -> object
name is `ConDemoWhsWorkService`.

## Ground truth consulted first

Per the case instruction, `get_knowledge(topic="warehouse-management")` was
called before implementing. Its rulebook is high-level (WHSWorkTable/
WHSWorkLine are the core work tables, work templates define the action
sequence, "NEVER directly update WHSWorkTable.WorkStatus - use the
WHSWorkExecute class hierarchy") but does not name a concrete work-creation
API surface, so the real, shipped class/method signatures were found and
confirmed one at a time via `search` + `get_object_info` + `get_method`
(source, not just signature) before any line was written - nothing below was
guessed:

- `WhsWorkCreate` (abstract, `Foundation` model, physically
  `ApplicationSuite\Foundation\AxClass\WhsWorkCreate.xml`) is the framework's
  work-creation base class. Its `static WHSWorkCreate construct(Common _common)`
  (full source read via `get_method`) dispatches on `_common.TableId` to one
  concrete subclass per source-document type
  (`WHSWaveTable`->`WHSWorkCreateWave`, `WHSUOMStructure`->`WhsWorkCreateLP`,
  `PurchLine`->`WhsWorkCreatePurchLine`, `WHSTmpMovementWork`->
  `WhsWorkCreateMovement`, `SalesLine`->`WHSWorkCreateReturnOrder`,
  `Kanban`->`WhsWorkCreateKanbanPut`) and `throw error("@WAX678")` for
  anything else - confirming there is deliberately no direct
  `SalesLine`/`WHSLoadLine` -> work bypass for outbound (shipping) work: it
  goes through a wave.
- `WhsWorkCreate.processTempTable()` (full source read via `get_method`) is
  the method that actually resolves the applicable `WHSWorkTemplateTable`
  record and creates the work: it calls
  `this.createWorkTemplateTableQueryRun(workTransType)`, which queries
  `WHSWorkTemplateTable` ordered by `WorkTemplatePriority` for the wave's
  work transaction type (the framework's own template-priority walk, backed
  by the table's real `WorkTransTypeWorkTemplatePriorityI` unique index
  `[WorkTransType, WorkTemplatePriority]`), then loops the resulting temp
  work lines, calling `this.createWorkTable(...)` and
  `this.createRemainingWorkLines(...)` (never a raw `insert()` on
  `WHSWorkTable`/`WHSWorkLine` from caller code) and returns a
  `WHSWorkBuildId`. This is the case's "work-template resolution through the
  WHS work-template API" requirement: the resolution happens *inside* the
  framework call, exactly the same shape as the sibling
  `L3-trade-agreement-price-lookup` golden relying on `PriceDisc.findPrice()`'s
  internal agreement-hierarchy walk instead of reimplementing it.
- `WHSWorkCreateWave` (extends `WhsWorkCreate`, also abstract) is the
  concrete family for wave-driven work. Its
  `static WHSWorkCreateWave constructNoThrow(WHSWaveTable _whsWaveTable, WHSWorkCreateId _workCreateId)`
  (full source read) uses `SysExtensionAppClassFactory` keyed off
  `_whsWaveTable.waveTemplate().WaveTemplateType` to pick the concrete
  processor - confirmed the concrete subclass for outbound/shipping waves is
  `WHSWorkCreateWaveShipping` (`get_object_info`: `Extends: WHSWorkCreateWave`,
  methods `createTempTable()`/`allocatedLoadLines()`/`new(Common,
  WHSWorkCreateId)`). Its `createTempTable()` (full source read) calls
  `WHSLoadLineAllocationProcessor::newFromPostEngineAndWorkCreateId(...)
  .allocateLoadLinesByWave(this.parmWaveTable())` - i.e. the load lines
  belonging to the wave's shipments are allocated by the framework's own
  allocation processor, not by this class.
- `WHSWaveLine` (table) carries a `LoadId` field alongside `WaveId`/
  `ShipmentId` and a real `WHSLoadTable` relation on `LoadId = LoadId`
  (`get_object_info`) - confirmed this is the sanctioned join key from a
  `WHSLoadId` to the wave that was built for it (an existing wave, built by
  the standard "release to warehouse" flow, is a precondition the same way
  the case scopes work templates/location directives as out-of-scope
  configured data - no case artifact creates a wave; `createWorkForLoad`
  consumes one that already exists).
- `WHSLoadTable::find(WHSLoadId _loadId, boolean _forupdate = false, boolean _disableCache = false)`,
  `WHSWaveTable::find(WHSWaveId _waveId, boolean _forupdate = false)` and
  `WHSWorkTable::find(WHSWorkId _workId, boolean _forupdate = false)` -
  signatures confirmed via `get_method(include="signature")`, not guessed.
- `WHSWorkTable` indexes (`get_object_info`): `WorkIdx` = `[WorkId]`
  **(unique)** and `WorkBuildIdIdx` = `[WorkBuildId]` - both real, both used
  with an explicit `index hint` in the written code (`isWorkClosed` on
  `WorkIdx`, the work-id lookup after `processTempTable()` on
  `WorkBuildIdIdx`), satisfying the case's "indexed, firstonly select"
  requirement literally, not just in spirit.
- `WHSWorkStatus` enum values (`get_object_info`): `Open=0, InProcess=1,
  PendingReview=2, Skipped=3, Closed=4, Cancelled=5, Combined=6` - `Closed=4`
  confirmed before writing `isWorkClosed`.

## What was explicitly rejected as NOT satisfying the case

A raw `insert()` on `WHSWorkTable`/`WHSWorkLine` was never written anywhere
in this class - that is the case's stated fail condition. The alternative
that was considered and rejected was hand-writing the
`WHSWorkTemplateTable` priority query ourselves (replicating what
`createWorkTemplateTableQueryRun` already does internally); that was
rejected because (a) it would duplicate framework logic the case says to
rely on ("resolves ... through the WHS work-template API") and (b) several
of the fields that query joins in (grouping fields, location-specific
range handling) are not part of the public contract, so a hand-rolled
version would silently diverge from the framework's real behavior over
time.

## Artifact captured (the case's target_artifact_type)

`ConDemoWhsWorkService.metadata.xml` - `AxClass`, two public static methods:

- `WHSWorkId createWorkForLoad(WHSLoadId _loadId)` - `WHSLoadTable::find`
  validates the load exists; `select firstonly WHSWaveLine where LoadId ==
  _loadId` finds the wave already built for that load (out of scope to
  create, same as work templates/location directives); inside
  `ttsbegin`/`ttscommit`, `WHSWaveTable::find(..., true)` locks the wave
  header, `WHSWorkCreateWave::constructNoThrow(whsWaveTable, '')` selects
  the concrete work-creation processor for the wave's template type,
  `.createTempTable()` allocates the load lines, `.processTempTable()`
  resolves the work template and creates the work (returns a
  `WHSWorkBuildId`); after commit, an indexed `WorkBuildIdIdx` lookup
  returns a representative `WHSWorkId` for the created work.
- `boolean isWorkClosed(WHSWorkId _workId)` - `select firstonly WorkStatus
  from whsWorkTable index hint WorkIdx where whsWorkTable.WorkId ==
  _workId` (the table's unique primary index), compares to
  `WHSWorkStatus::Closed`.

Two new labels were created in the `Contoso` label file (not an
`_Extension` file) to back the two error paths and satisfy `BPErrorLabelIsText`
(no literal strings in `error()`): `WhsWorkServiceLoadNotFound`,
`WhsWorkServiceNoWaveForLoad`, `WhsWorkServiceNoEligibleWorkCreator`.

## Build at capture (2026-08-03, SHA dffe0dc)

FULL build (`fullBuild: true`): **0 errors**, 2 warnings, both benign and
unrelated to the written code:
- `ExternalReference Warning: ... Microsoft.Dynamics.Commerce.Runtime...
  AttributeBasedPricing ... failed to load` - the same pre-existing Commerce
  PricingEngine warning already documented in the
  `L3-trade-agreement-price-lookup` golden.
- `Generation Warning: Assembly Foundation: No assembly matching referenced
  module 'Foundation' is found` - see the Descriptor section below; this is
  a late compiler stage (assembly/type-forwarder generation) complaining
  that the `Foundation` AOT model has no *standalone* netmodule of its own
  (its compiled code ships inside `Dynamics.AX.ApplicationSuite.*.netmodule`
  - confirmed on disk: no `Foundation.netmodule`/`.dll` exists anywhere
  under `K:\AosService`, only `ApplicationSuite\bin\Dynamics.AX.
  ApplicationSuite.*.netmodule`). It does not block compilation: `Errors: 0`
  both times the full build was run (once immediately after adding
  `Foundation` to `ModuleReferences`, once again after a diagnostic
  round-trip removing and restoring it - see below).

## BP check: NOT independently confirmed (tool limitation, not a code defect) - documented, not glossed over

`run_bp_check` reported `"BP Check passed"` for `ConDemoWhsWorkService` with
a printed message: `"The source for referenced module 'Foundation' is
missing from the model store. Please specify the -packagesRoot parameter to
instead use binary metadata for referenced modules."` - the exact xppbp
diagnostic explained above (no standalone `Foundation` assembly on disk).

This "passed" result could **not** be trusted at face value, and it was not
taken on faith: it was falsified by two follow-up experiments run before
writing anything to the corpus -

1. `run_bp_check` filtered to `class:ThisClassDoesNotExist12345` (a name
   that is provably not in the model) returned the **identical** `"BP Check
   passed"` / same missing-Foundation message - proving the checker was not
   distinguishing "0 issues on a real element" from "processed nothing",
   the same "zero-elements false green" class of trap already documented
   for unfiltered `run_bp_check` calls in this project's memory, here
   triggered by a filtered call instead.
2. Diagnostic round-trip: `Foundation` was temporarily removed from
   `Contoso.xml` `ModuleReferences` and `run_bp_check` was re-run against
   the already-frozen `ConDemoPriceResolver` (a class with zero WHS/
   Foundation dependency, previously confirmed genuinely BP-clean in the
   `L3-trade-agreement-price-lookup` capture). With `Foundation` absent, the
   checker printed `"1 elements processed."` - i.e. it only produces the
   real, provenance-bearing "N elements processed" line when `Foundation`
   is NOT in `ModuleReferences`. `Foundation` was then restored (required
   for this case's build) and the model was rebuilt (`fullBuild: true`,
   `Errors: 0`) before re-running `run_bp_check` on
   `ConDemoWhsWorkService`, which reproduced the original silent
   "passed"/zero-elements-processed behavior.

Conclusion: referencing the `Foundation` model (needed for the build to
resolve WHS types) makes `run_bp_check` on this project's `xppbp.exe`
invocation silently stop processing any element in the whole `Contoso`
model, while still printing `"BP Check passed"`. This is a real,
reproducible tool/environment limitation (xppbp needs `-packagesRoot` for
binary-metadata fallback when a referenced module's source can't be loaded
into its own model store, and the tool wrapper does not expose that flag),
**not** evidence that the class is BP-clean. Per this project's own stated
rule ("`bp_clean: 1` means BP ran and was clean... never 'BP was not
run'"), the corpus record for this capture omits `--bp-warnings` entirely,
which scores `bp_clean: null` (BP genuinely not checked) rather than a
fabricated `1`.

As a substitute (not a replacement) signal: the offline
`validate_code(mode="syntax")` best-practice validator (no `xppc`/`xppbp.exe`
involved) reported **0 violations, 13 rule groups checked** on the exact
source that was written. Both class and method doc comments are present
and meaningful (avoiding `BPXmlDocNoDocumentationComments`), both `error()`
calls use `strFmt("@Contoso:...")` labels rather than literal text
(avoiding `BPErrorLabelIsText`), and no `today()`/nested-`while select`/
function-in-where patterns are present. This is real evidence of a
best-effort BP-clean artifact, but it is explicitly weaker than a genuine
`xppbp.exe` pass and is reported as such rather than conflated with one.

This finding (env limitation in `run_bp_check` when a package-satellite
model like `Foundation` is referenced) is worth flagging to the improver as
a `TOOL_DEFECT`/`VALIDATOR_GAP` hypothesis: expose a `-packagesRoot` (or
equivalent binary-metadata-fallback) passthrough on the underlying xppbp
invocation so referencing a satellite model with no standalone assembly
does not silently disable BP checking for the whole target model.

## Descriptor change (environment prerequisite, not part of the scored artifact)

`K:\AosService\PackagesLocalDirectory\Contoso\Descriptor\Contoso.xml`
`ModuleReferences` gained one entry: `Foundation`. All of the WHS
classes/tables used here (`WhsWorkCreate`, `WHSWorkCreateWave`,
`WHSWorkCreateWaveShipping`, `WHSLoadTable`, `WHSWaveTable`, `WHSWaveLine`,
`WHSWorkTable`, `WHSWorkTemplateTable`, ...) report `Model: Foundation` via
`get_object_info`, and `Foundation` is a genuinely separate AOT model
(its own `AxModelInfo` at
`K:\AosService\PackagesLocalDirectory\ApplicationSuite\Descriptor\
Foundation.xml`, `<Name>Foundation</Name>`) bundled inside the
`ApplicationSuite` **package** alongside (but distinct from) the
`ApplicationSuite` **model** that was already referenced - i.e. the same
class of gap the `L3-trade-agreement-price-lookup` golden already
documents for `ApplicationCommon`/`UnitOfMeasure` (xppc does not resolve
package references transitively for directly-named types; each AOT
*model*, not just each *package*, needs its own `ModuleReferences` entry).
This edit is infrastructure, not a case output, and was left in place
(not rolled back) - it is a correctly-scoped, additive environment fix
that any future case referencing WHS/Foundation types will also need.
(It was also the direct cause of the `run_bp_check` limitation documented
above - reverting it is not an option since the case's build genuinely
requires it, and reverting was only ever done for a few minutes as a
controlled diagnostic, then undone before the final build/capture.)

## Corpus record

`eval/corpus/runs/2026-08-03T20__L3-warehouse-work-slice__dffe0dc.json`
(first-capture record: `build: 1`, `bp_clean: null` (honestly "not
checked" - see above), `golden_match: null` per the documented
`golden_pending` degrade-gracefully convention, classification `PASS`. The
golden file in this folder was captured from this run's own verified
output and self-checked afterward with `npm run eval:score`, which
reports `golden_match: 1` with no structural deltas against itself.)
