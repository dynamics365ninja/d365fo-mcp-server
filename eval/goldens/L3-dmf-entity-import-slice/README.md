# Golden: L3-dmf-entity-import-slice - FROZEN

`golden_pending: false` since 2026-08-03. Every byte comes from the grounded
`d365fo_file` path; nothing here is hand-authored.

| Capture | Server SHA | Role |
|---|---|---|
| 2026-07-27 (draft) | `e8e2eb9` | first attempt; both AxDataEntityView writer defects still present, entity had no methods |
| 2026-08-03 (freeze) | `44e7380` | full grounded run, `Errors: 0`, 0 BP errors, both methods present, golden byte-matched |

Platform xppc 7.0.7858.27, model `Contoso`, `EXTENSION_PREFIX=Con`.

## The two defects the draft found are fixed

The draft README recorded two TOOL_DEFECTs blocking this case:

1. `d365fo_file(action="create", objectType="data-entity", sourceCode=...)` used
   to silently drop the X++.
2. `d365fo_file(action="modify", objectType="data-entity", operation="add-method")`
   used to reject with "Operation add-method on object type data-entity is not
   supported by the bridge" - `data-entity` was in the tool's own objectType enum
   but missing from the bridge's internal allowlist.

Both are verified fixed on server SHA `44e7380` against the live MCP server
(checked directly in the running `dist/`, not just `src/`, per the project's
stale-dist caution):

- `dist/tools/dataEntityXml.js` now has `buildSourceCodeXml` and a
  `standardStructure` flag (implied whenever `declaration`/`methods`/`fieldGroups`
  are passed) that emits `<SourceCode>`, the five standard `<FieldGroups>`, empty
  `<DeleteActions/>` and `<StateMachines/>`.
- `dist/tools/createD365File.js` (data-entity create case) now splits the
  top-level `sourceCode` X++ argument via `parseSourceForBridge` and forwards
  `{declaration, methods}` into the shared builder, instead of discarding it.
- `dist/bridge/bridgeAdapter.js`'s `BRIDGE_MODIFY_TYPES` now includes
  `data-entity` (this path was not exercised this run - `create` carried the
  X++ directly - but it is confirmed present for the add-method/replace-code
  repair path other cases may need).

The write was verified end to end, not just trusted: after
`d365fo_file(action="create", objectType="data-entity", sourceCode=<X++ with both
methods>, ...)` reported success, the written
`ConDemoImportTargetEntity.xml` was read back from disk and confirmed to contain
a full `<SourceCode><Declaration>...</Declaration><Methods>...` block with both
`validateWrite` and `postGetStagingData` verbatim.

## Artifacts captured (the case's `target_artifact_types`)

- `ConDemoImportTarget.metadata.xml` - AxTable, `TableGroup=Main`,
  label `@TaxTransactionInquiry:HeaderNote`, `DocumentCode` (EDT `Num`, mandatory),
  `Description` (EDT `Name`), `Amount` (EDT `AmountCur`), unique alternate-key index
  `ImportTargetIdx` (`AlternateKey=Yes`, `AllowDuplicates=No`), `PrimaryIndex`/
  `ClusteredIndex`/`ReplacementKey=ImportTargetIdx`.
- `ConDemoImportTargetEntity.metadata.xml` - AxDataEntityView, `IsPublic=Yes`,
  `PublicEntityName=ConDemoImportTarget`, `PublicCollectionName=ConDemoImportTargets`,
  `EntityCategory=Master`, `DataManagementEnabled=Yes`,
  `DataManagementStagingTable=ConDemoImportTargetEntityStaging`,
  `PrimaryKey=EntityKey` over `DocumentCode` (natural key, not RecId), real
  `ViewMetadata` query over `ConDemoImportTarget`, and a real `<SourceCode>` block
  with:
  - `public boolean validateWrite()` - calls `super()`, then rejects a
    non-positive `Amount` via `checkFailed("@SYS23986")` ("Amount must be
    positive.", ApplicationPlatform/SYS - always resolvable, no new label needed).
  - `public static void postGetStagingData(DMFDefinitionGroupExecution
    _dmfDefinitionGroupExecution)` - the exact name and signature confirmed
    against the shipped `CashDiscountEntity`/`AgingPeriodDefinitionEntity`, not
    guessed. Loops the staging table filtered by `DefinitionGroup`/`ExecutionId`
    and upper-cases `DocumentCode` via `strUpr`.

## Required companions NOT in this golden

Same two companions the draft already identified and created (still required,
still out of `target_artifact_types`):

1. `AxTable ConDemoImportTargetEntityStaging` - the create writer sets
   `DataManagementStagingTable = <Entity>Staging` whenever
   `dataManagementEnabled: true`; xppc rejects a dangling reference to it during
   a FULL build. Modeled on
   `ApplicationSuite/Foundation/AxTable/CashDiscountStaging.xml`: TableGroup=Staging,
   `DefinitionGroup`/`ExecutionId`/`IsSelected`/`TransferStatus` control fields +
   the three entity fields, alternate key `StagingIdx`.
2. `AxSecurityPrivilege ConDemoImportTargetEntityMaintain` - without it xppbp
   raises the BP **error** `DataEntitySecurityPrivilegeCheck`, which the case
   instruction forbids ("zero BP errors").

## Build / BP at capture (2026-08-03, SHA 44e7380)

- FULL build (`fullBuild: true`): **0 errors**, 1 unrelated warning (Commerce
  PricingEngine external assembly not found).
- BP, filtered per object (`run_bp_check` with an explicit `targetFilter` +
  `targetElementType` - the unfiltered call reports a false "BP Check passed"
  with zero elements processed, do not trust it):
  - `ConDemoImportTarget` (table): 3 warnings, 0 errors -
    `BPErrorTablePrimaryKeyEditable`, `BPErrorDeveloperDocumentationNotDefined`,
    `BPErrorTableMissingFormRef` - all out of the case's declared scope.
  - `ConDemoImportTargetEntity` (DataEntityView): **0 warnings, 0 errors** -
    "1 elements processed."
  - `ConDemoImportTargetEntityStaging` (table, companion): 2 warnings, 0 errors.
  - `ConDemoImportTargetEntityMaintain` (privilege, companion): 1 warning
    (`BPErrorPrivilegeNotCoveredByDuty`), 0 errors.
  - `targetElementType` must be a value from xppbp's own vocabulary
    (`DataEntityView`, `table`, `SecurityPrivilege`, ...) - passing the
    `d365fo_file` objectType spelling (`data-entity-view`) is rejected with an
    explanatory line inside a nominally "passed" response; easy to miss.

The case's own gate is "zero BP **errors**" - satisfied. `bp_clean` in the
corpus score is `0` because that dimension counts *warnings* too; the residual
3 warnings on the table are the same out-of-scope, pre-existing pattern warnings
the frozen `L3-dualwrite-entity-mapping` golden also carries, and this run is
classified `PASS` on the same convention.

## Descriptor

No package added. `DMFDefinitionGroupExecution`, `DMFEntity`,
`DMFDefinitionGroupName`, `DMFExecutionId`, `DMFIsSelected` and `DMFTransferStatus`
all live in **ApplicationFoundation**, which `Contoso.xml` already references.

## Corpus record

`eval/corpus/runs/2026-08-03T18__L3-dmf-entity-import-slice__44e7380.json`
