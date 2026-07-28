# Golden: L4-ssrs-report-multidataset — FROZEN

`golden_pending: false`. This is the re-capture taken **after** the two
`generateSmartReport` EDT fixes landed (`b3d7856`, `b6f50c9`); the earlier draft
of this golden was deliberately not frozen because it would have enshrined the
writer defect described in §"What the re-capture changed".

Captured 2026-07-28 on the D365FO dev VM. Model `Contoso`, `EXTENSION_PREFIX=Con`
(authored name `DemoNoteReportMulti` → AOT name `ConDemoNoteReportMulti`),
xppc 7.0.7858.27.

Corpus record: `eval/corpus/runs/2026-07-28T09__L4-ssrs-report-multidataset__538cab2.json`.
Superseded drafts: `…T04__…__39adafe.json` (pre-fix behaviour) and
`…T06__…__b3d7856.json` (the half-fixed state that broke the build).

## Artifacts (all 7 from a single `generate_object(mode="scaffold", objectType="report", …)` call)

| File | Type | Notes |
|---|---|---|
| `ConDemoNoteReportMultiTmp.metadata.xml` | AxTable | `TableType=TempDB`, detail dataset (`NoteId`, `Subject`) |
| `ConDemoNoteReportMultiSummaryTmp.metadata.xml` | AxTable | `TableType=TempDB`, summary dataset (`Subject`, `LineCount`) |
| `ConDemoNoteReportMultiContract.metadata.xml` | AxClass | `[DataContractAttribute]`, no dialog params |
| `ConDemoNoteReportMultiDP.metadata.xml` | AxClass | `extends SrsReportDataProviderBase`; **one `[SRSReportDataSetAttribute]` getter per tmp table**; hand-completed `processReport()` |
| `ConDemoNoteReportMultiController.metadata.xml` | AxClass | `extends SrsReportRunController`, `main()` + `prePromptModifyContract()` stub |
| `ConDemoNoteReportMulti.menuitem.metadata.xml` | AxMenuItemOutput | → Controller class |
| `ConDemoNoteReportMulti.metadata.xml` | AxReport | two `<AxReportDataSet>`; RDL carries two `<DataSet>` + two `<Tablix>` |

The `additionalDatasets` feature under test works: both tmp tables, both DP
getters, both `AxReportDataSet` entries and both RDL tablixes were produced by
the one scaffold call. Full build: **0 errors** (`Contoso compilation completed`,
elapsed 00:01:37).

## What the re-capture changed

`suggestEdtFromFieldName()` in `generateSmartReport.ts` was a hardcoded keyword
ladder that never consulted the EDT index and fell through to `String255`, even
though the `generateObject` schema documents `fieldsHint` for `scaffold:report`
identically to `scaffold:table` ("EDTs auto-suggested from the index"). Fixing
that (`b3d7856`) exposed a second fault one function over: `generateSmartReport`
carried its **own** duplicate `resolveEdtBaseType` whose comment claimed it was
"same as generateSmartTable" — it was not. The shared copy returns `undefined`
for a ROOT EDT with no `string_size`; the local copy collapsed that to `'String'`.

The two halves then went wrong in **opposite** directions on the same field:

| | pre-fix (`39adafe`) | half-fixed (`b3d7856`) | frozen here (`b6f50c9`) |
|---|---|---|---|
| `SummaryTmp/Fields/LineCount/@type` | `AxTableFieldString` | `AxTableFieldInt` (Int32) | `AxTableFieldInt64` |
| `LineCount/ExtendedDataType` | `String255` | `PurchLineCount` | `PurchLineCount` |
| `AxReportDataSetField[LineCount]/DataType` | `System.String` | `System.String` | `System.Int64` |
| full build | 0 errors | **`Metadata Error: … /LineCount/ExtendedDataType: Data type mismatch`** | 0 errors |

`PurchLineCount` roots in the Int64 EDT `NumberOfRecords`, so `SmartXmlBuilder`'s
EDT-**name** heuristic (`includes('count')` → `AxTableFieldInt`) contradicted the
EDT chain. Both sides now read one cached primitive per EDT
(bridge → index → heuristic) and cannot disagree.

**`validate_code` was clean in both modes.** Only a full build ever caught it.

## Oracle negative test (this golden actually discriminates)

Re-injecting the exact regression shape into the scored artifacts — `LineCount`
back to `AxTableFieldInt` and its `AxReportDataSetField/DataType` back to
`System.String` — makes `npm run eval:score` fail on precisely those two paths:

```
❌ golden mismatch — 0 missing, 0 extra, 2 changed.
  ~ AxReport/DataSets/AxReportDataSet[…SummaryTmp]/Fields/AxReportDataSetField[LineCount]/DataType  (golden="System.Int64" actual="System.String")
  ~ AxTable/Fields/AxTableField[LineCount]/@type                                                     (golden="AxTableFieldInt64" actual="AxTableFieldInt")
```

Neither path is swallowed by the case's `ignore` list.

## Known build-oracle blind spot (carried over from the draft capture)

`pass@build` does **not** certify AxReport dataset wiring. Repointing the Summary
dataset's `<Query>` at a non-existent provider —

```
<Query>SELECT * FROM ConBogusNoSuchDP.ConBogusNoSuchTmp</Query>
```

— still produced `Errors: 0` under a **full** build with Metadata Validation
running (`Metadata: validate report` executed). The contrast test proves the
oracle is otherwise live: pointing
`AxMenuItemOutput/ConDemoNoteReportMulti/Object` at `ConBogusNoSuchController`
failed the very next full build with

```
Metadata Error: AxMenuItemOutput/ConDemoNoteReportMulti/Object: Class 'ConBogusNoSuchController' does not exist.
```

Correctness of the report XML was therefore established structurally, plus an
element-vocabulary diff against the standard multi-dataset RDP reports
`ApplicationSuite/Foundation/AxReport/AgreementConfirmation.xml` and
`AssetStatementRowSetup.xml`.

## Open quality observation (not a blocker, not frozen as correct)

`NoteId` resolves to **`PlCorrNoteId`** — a Polish-localization EDT — via
`resolveBestEdt`'s fuzzy path. This is not a resolver defect: the index holds no
EDT literally named `NoteId`, and the whole candidate list is fuzzy/localization
noise (`RefRecId` 0.85 by the "ends with Id" heuristic, then `PlCorrNoteId` 0.84,
`CustDebitNoteId` 0.81, …). `PlCorrNoteId` extends `Num`, so the *primitive* is
right and the build is clean. But it drags in a country-specific EDT carrying an
EDT relation, which is where 2 of the 10 BP warnings below come from. Worth a
future improver pass on how fuzzy candidates are ranked against localization
suffixes.

## BP warnings (10, all from the scaffold shape — 0 errors)

Per-object, each obtained with an explicit `targetFilter` (a filterless
`run_bp_check` mints a false clean):

| Object | Warnings |
|---|---|
| `ConDemoNoteReportMultiTmp` (table) | 5 — `BPErrorEDTNotMigrated`, `BPUpgradeMetadataEDTRelation`, `BPErrorTablePrimaryKeyEditable`, `BPErrorTablePrimaryKeyNotMandatory`, `BPErrorTableMissingFormRef` |
| `ConDemoNoteReportMultiSummaryTmp` (table) | 3 — `BPErrorTablePrimaryKeyEditable`, `BPErrorTablePrimaryKeyNotMandatory`, `BPErrorTableMissingFormRef` |
| `ConDemoNoteReportMultiController` (class) | 1 — `BPLocalVariableNotUsed` (`prePromptModifyContract()` leaves `contract` unused behind a TODO) |
| `ConDemoNoteReportMultiDP` (class) | 0 |
| `ConDemoNoteReportMultiContract` (class) | 0 |
| `ConDemoNoteReportMulti` (menu item output) | 1 — `BPErrorMenuItemNotCoveredByPrivilege` (no privilege in `target_artifact_types`) |

The primary-key/form-ref trio per table is the scaffold giving report tmp tables a
Main-table shape (unique alternate-key index on the first field, `ReplacementKey`).
The count rose from 8 (draft capture) to 10 purely because `NoteId` now resolves to
a real EDT that carries a relation, instead of the inert `String255`.
