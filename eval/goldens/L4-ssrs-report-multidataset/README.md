# Golden: L4-ssrs-report-multidataset — DRAFT, NOT FROZEN

The case stays `golden_pending: true`. This capture would enshrine the
`generateSmartReport` field-typing gap described below, so it is kept as a draft
reference only — **fix first, capture second**.

Captured 2026-07-28 on the D365FO dev VM. Model `Contoso`, `EXTENSION_PREFIX=Con`
(authored name `DemoNoteReportMulti` → AOT name `ConDemoNoteReportMulti`),
xppc 7.0.7858.27.

**Provenance caveat:** the corpus record stamps `server_git_sha: 39adafe` (live
repo HEAD), but the *running* MCP server binary was built from **`b28515f`** — a
later commit rebuilt `dist/` while the server process still holds the old
modules. The behaviour captured here is `b28515f`'s.

Corpus record: `eval/corpus/runs/2026-07-28T04__L4-ssrs-report-multidataset__39adafe.json`.

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
the one scaffold call. Full build: **0 errors**. BP: **0 errors, 8 warnings**.

## Why this is a draft (writer defect it would bake in)

`suggestEdtFromFieldName()` in `src/tools/generateSmartReport.ts:1303-1327` is a
hardcoded keyword ladder that **never consults the EDT index** and falls through
to `String255`. The `generateObject` schema documents `fieldsHint` for
`scaffold:report` as *"EDTs auto-suggested from the index"* — the same wording as
`scaffold:table`, which does hit the index. In this run `prepare(mode="create")`
returned `NoteId → Num`, `Subject → smmSubject/EventSubject`, `LineCount → Counter`
from the index for the identical field names, yet all three fields were emitted as
`<ExtendedDataType>String255</ExtendedDataType>`.

It hurts most on the summary dataset: `LineCount`, a count, becomes a string, its
`AxReportDataSetField/DataType` becomes `System.String` (SSRS cannot format or
aggregate it numerically), and the DP must wrap the aggregate in `int642Str()`.

The same `String255` shape is **already frozen** in the sibling goldens
`L4-ssrs-report-basic/ConDemoNoteReportTmp.metadata.xml` and
`L4-ssrs-report-advanced/ConDemoNoteReportAdvTmp.metadata.xml` — so this is
pre-existing behaviour, not a regression. When the writer is fixed, all three
report goldens should be re-captured together.

## Build oracle blind spot found here (negative test)

`pass@build` does **not** certify AxReport dataset wiring. Repointing the Summary
dataset's `<Query>` at a non-existent provider —

```
<Query>SELECT * FROM ConBogusNoSuchDP.ConBogusNoSuchTmp</Query>
```

— still produced `Build succeeded / Errors: 0` under a **full** build with
Metadata Validation running (`Metadata: validate report` executed). The contrast
test proves the oracle is otherwise live: pointing
`AxMenuItemOutput/ConDemoNoteReportMulti/Object` at `ConBogusNoSuchController`
failed the very next full build with

```
Metadata Error: AxMenuItemOutput/ConDemoNoteReportMulti/Object: Class 'ConBogusNoSuchController' does not exist.
```

Correctness of the report XML here was therefore established structurally, plus an
element-vocabulary diff against the standard multi-dataset RDP reports
`ApplicationSuite/Foundation/AxReport/AgreementConfirmation.xml` and
`AssetStatementRowSetup.xml` (no unexpected elements; `<Caption>` under
`AxReportPrecisionDesign` is used by 92 Foundation reports).

## BP warnings (8, all from the scaffold shape — 0 errors)

- `BPLocalVariableNotUsed` ×1 — the scaffolded `prePromptModifyContract()` declares
  `contract` and leaves the body a TODO comment.
- `BPErrorTablePrimaryKeyEditable`, `BPErrorTablePrimaryKeyNotMandatory`,
  `BPErrorTableMissingFormRef` ×2 tables — the scaffold gives report tmp tables a
  Main-table shape (unique alternate-key index on the first field, `ReplacementKey`).
- `BPErrorMenuItemNotCoveredByPrivilege` ×1 — no privilege is in
  `target_artifact_types`.

Each was obtained with an explicit `targetFilter` (a filterless `run_bp_check`
mints a false clean).
