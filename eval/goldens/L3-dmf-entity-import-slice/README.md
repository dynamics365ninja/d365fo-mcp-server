# Golden: L3-dmf-entity-import-slice — DRAFT, NOT FROZEN

The case stays `golden_pending: true`. This capture is **functionally incomplete**
and is kept only as a draft reference / regression baseline — "fix first,
capture second". Do NOT flip `golden_pending` off against these files.

Captured 2026-07-27, server SHA e8e2eb9, xppc 7.0.7858.27 (VM), model `Contoso`,
`EXTENSION_PREFIX=Con`.

## Why it is not frozen

The case asks the data entity to carry two methods:

- `public boolean validateWrite()` — reject a non-positive `Amount` with a labelled error
- `public static void postGetStagingData(DMFDefinitionGroupExecution)` — the DMF
  hook after the staging load, normalising `DocumentCode` to upper case
  (name+signature confirmed against `CashDiscountEntity` / `AgingPeriodDefinitionEntity`,
  not guessed)

**Neither could be written.** There is no grounded tool path that puts X++ on an
`AxDataEntityView`:

- `d365fo_file(action="create", objectType="data-entity", sourceCode=…)` silently
  drops `sourceCode` (`createD365File.ts:1550` → `generateAxDataEntityXml(objectName, properties)`;
  `dataEntityXml.ts` emits no `<SourceCode>` element at all).
- `d365fo_file(action="modify", objectType="data-entity", operation="add-method")`
  → *"Operation add-method on object type data-entity is not supported by the
  bridge"*. `data-entity` is in the modify tool's own objectType enum and in its
  advertised description, but missing from `BRIDGE_MODIFY_TYPES`
  (`bridgeAdapter.ts:1210`) — every modify op on a data entity dead-ends.

So the captured `ConDemoImportTargetEntity.metadata.xml` has the right DMF
metadata and **no behaviour**. Re-capture once the writer emits `<SourceCode>`.

## Artifacts captured (the case's `target_artifact_types`)

- `ConDemoImportTarget.metadata.xml` — AxTable, `TableGroup=Main`,
  label `@TaxTransactionInquiry:HeaderNote`, `DocumentCode` (EDT `Num`, mandatory),
  `Description` (EDT `Name`), `Amount` (EDT `AmountCur`), unique alternate-key index
  `ImportTargetIdx` (`AlternateKey=Yes`, no `AllowDuplicates` ⇒ unique) with
  `PrimaryIndex`/`ClusteredIndex`/`ReplacementKey=ImportTargetIdx`.
- `ConDemoImportTargetEntity.metadata.xml` — AxDataEntityView, `IsPublic=Yes`,
  `PublicEntityName=ConDemoImportTarget`, `PublicCollectionName=ConDemoImportTargets`,
  `EntityCategory=Master`, `DataManagementEnabled=Yes`,
  `DataManagementStagingTable=ConDemoImportTargetEntityStaging`,
  `PrimaryKey=EntityKey` → `AxDataEntityViewKey[EntityKey]` over `DocumentCode`
  (natural key, **not** RecId), real `ViewMetadata` query over `ConDemoImportTarget`.
  **Missing the two required methods — see above.**

## Required companions NOT in this golden

1. `AxTable ConDemoImportTargetEntityStaging` — the create writer hard-codes
   `DataManagementStagingTable = <Entity>Staging` whenever
   `dataManagementEnabled: true` and offers no way to leave it empty. xppc
   **rejects a dangling staging table** during the full build:
   `Metadata Error: AxDataEntityView/ConDemoImportTargetEntity/DataManagementStagingTable:
   Table 'ConDemoImportTargetEntityStaging' does not exist.`
   (Negative test satisfied: the property is load-bearing.) The table was therefore
   created — `TableGroup=Staging`, `DefinitionGroup`/`ExecutionId`/`IsSelected`/
   `TransferStatus` control fields + the three entity fields, alternate key
   `StagingIdx` — modelled on `ApplicationSuite/Foundation/AxTable/CashDiscountStaging.xml`.
   It is not in `target_artifact_types`, so it is not captured here.
2. `AxSecurityPrivilege ConDemoImportTargetEntityMaintain` — without it xppbp raises
   the BP **error** `DataEntitySecurityPrivilegeCheck`, which the case instruction
   forbids ("zero BP errors"). Also out of `target_artifact_types`; a re-run must
   still create it.

## Known deviations from standard-model shape (writer gap)

The generated AxDataEntityView omits `<SourceCode>`, `<FieldGroups>`,
`<DeleteActions/>` and `<StateMachines/>` — all present in the standard
AxDataEntityView files of ApplicationSuite/Foundation. The deserializer defaults
them, so build and BP stay green while the object diverges from every standard
model. Same gap as `eval/goldens/L2-virtual-entity-power-platform/README.md`,
but here it is case-fatal rather than cosmetic.

## Build / BP at capture

- FULL build (`fullBuild: true`): **0 errors**, 1 unrelated warning
  (Commerce PricingEngine external assembly).
  An *incremental* build of the same XML reported "Build succeeded / Errors: 0"
  even while the staging-table metadata error existed — the Metadata Validation
  phase only runs on a full build. Never accept an incremental green build here.
- BP: **0 errors**, 9 warnings — `BPErrorTablePrimaryKeyEditable` ×4,
  `BPErrorTablePrimaryKeyNotMandatory`, `BPErrorDeveloperDocumentationNotDefined` ×2,
  `BPErrorTableMissingFormRef`, `BPErrorPrivilegeNotCoveredByDuty` — all out of the
  case's declared scope. NOTE: `run_bp_check` *without* `targetFilter` reported
  "BP Check passed" and found nothing; only the filtered runs surfaced these.

## Descriptor

No package added. `DMFDefinitionGroupExecution`, `DMFEntity`,
`DMFDefinitionGroupName`, `DMFExecutionId`, `DMFIsSelected` and `DMFTransferStatus`
all live in **ApplicationFoundation**, which `Contoso.xml` already references.
