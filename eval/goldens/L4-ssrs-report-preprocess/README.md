# Golden: L4-ssrs-report-preprocess — CAPTURED, PENDING HUMAN REVIEW (§6.4)

Captured 2026-08-30 (Phase F), server SHA 93d6658 + the Phase F working tree (the
generator correction below is in that tree), xppc 7.0.7996.33 (VM), sandbox model
`fm-mcp`, `EXTENSION_PREFIX=Con`. All six objects come from ONE
`generate_object(mode="scaffold", objectType="report", …, preProcess=true,
generateController=true)` call; the only edit is the `processReport()` body, applied
with `d365fo_file(action="modify", operation="replace-code")`. No hand-edited XML.
The `ConDemoNoteHeader` fixture (eval/fixtures) was provisioned first and is not part
of the golden.

## Artifacts

- `ConDemoNoteReportPreTmp.metadata.xml` — AxTable, `TableType=TempDB`, fields
  `NoteId` (`Num`) and `Subject` (`Name`) mirroring the fixture, index
  `ConDemoNoteReportPreTmpIdx`.
- `ConDemoNoteReportPreContract.metadata.xml` — empty `[DataContractAttribute]` class.
- `ConDemoNoteReportPreDP.metadata.xml` — **`extends SrsReportDataProviderPreProcessTempDB`**,
  decorated `[SRSReportParameterAttribute(classStr(ConDemoNoteReportPreContract))]`,
  `[SRSReportDataSetAttribute(tableStr(ConDemoNoteReportPreTmp))]` getter, and
  `processReport()` = `delete_from` + `insert_recordset … select NoteId, Subject from
  noteHeader` over a local `ConDemoNoteHeader` buffer. NO `preProcess()` method.
- `ConDemoNoteReportPreController.metadata.xml` — `extends SrsReportRunController`,
  `main()` with `ssrsReportStr(ConDemoNoteReportPre, Report)`.
- `ConDemoNoteReportPre.menuitem.metadata.xml` — AxMenuItemOutput pointing at the controller.
- `ConDemoNoteReportPre.metadata.xml` — AxReport, design `Report`
  (`AxReport/Designs/AxReportDesign/Text` is in the case's ignore list).

## The Phase F verification this case doubles as

The coverage plan's open question was whether `SrsReportDataProviderPreProcess`
pairs with the scaffold's TempDB table. Answer, in two parts:

1. **xppc does not decide it.** The ORIGINAL scaffold shape — `extends
   SrsReportDataProviderPreProcess`, TempDB table, NO parameter attribute, an
   invented `preProcess()` stub — built with **0 errors**. The corrected shape also
   built with 0 errors. The pairing is a runtime contract the compiler never checks.
2. **The framework does.** Evidence read from the shipped metadata on this VM:
   - `SrsReportDataProviderPreProcessInterface` declares only `cleanUp`, `initialize`,
     `parmUseDefaultTransactionOnly`, `parmUserConnection`, `parmSkipReportTransaction`
     — there is no `preProcess()` hook; the only DP method of that name in the whole
     AOT was the one the scaffold used to emit. `processReport()` IS the
     pre-processing step (it runs on the AOS before the render request).
   - `SrsReportDataProviderPreProcess` carries `createdTransactionId transactionId`
     (regular-table staging); `SrsReportDataProviderPreProcessTempDB` carries
     `takeOwnershipOfTempTable` / `releaseOwnershipOfTempTable` (TempDB staging).
   - The symbol index counts **332** shipped DPs on the TempDB base vs **38** on the
     regular one; a TempDB tmp table pairs with the TempDB base.
   - Every shipped pre-processed DP keeps `[SrsReportParameterAttribute]`
     (`AssetCardDP`, `AgreementFollowUpDP`, `AssetDepreciationSummaryDP`,
     `AgreementConfirmationDP`); "the controller passes the contract instead" was
     not a real mechanism.

The generator (`src/tools/smart/generateSmartReport.ts`), the `preProcess` op-spec,
the `PreProcess` report-pattern entry, the `ssrs-reports` / `ssrs-rdp-preprocess`
topics and this case's instruction were corrected on that evidence
(`tests/tools/generateSmartReport.test.ts` pins the new shape). AOT spelling note:
the attribute's `<Name>` is `SrsReportParameterAttribute` (the file is
`SRSReportParameterAttribute.xml`); X++ is case-insensitive, and the generator keeps
emitting `SRSReportParameterAttribute` so the older report goldens stay byte-stable.

## Why explicit `fields` instead of a bare `fieldsHint`

The first scaffold (bare `fieldsHint="NoteId, Subject"`) let the name-based EDT
suggestion pick `PlCorrNoteId` and `smmSubject` — localisation EDTs, one of which
carries an un-migrated EDT relation (`BPErrorEDTNotMigrated`). Mirroring the
fixture's EDTs (`Num`, `Name`) is what the report actually copies, so the case now
passes `fields=[{name:"NoteId", edt:"Num"}, {name:"Subject", edt:"Name"}]`. The
suggestion gap (prefer an existing same-named field in the workspace model) is
recorded in the corpus, not fixed here.

## Build / BP at capture

- FULL build: **0 errors**, 1 unrelated warning (Commerce PricingEngine assembly).
- BP, filtered per case object (`run_bp_check`, 6 objects, "1 elements processed"
  each): **Errors 0, Warnings 5** — Tmp table: `BPErrorTablePrimaryKeyEditable`,
  `BPErrorTablePrimaryKeyNotMandatory`, `BPErrorTableMissingFormRef`; Controller: "The
  local variable 'contract' is not used" in the scaffolded `prePromptModifyContract()`
  (a pre-existing generator wart when there are no contract params — left alone so the
  July report goldens stay stable); Menu item: `BPErrorMenuItemNotCoveredByPrivilege`.
  The same family of warnings the earlier report goldens carry; `bp_clean` is scored 0.

## Descriptor / labels

Descriptor as in `L2-exception-tts-retry/README.md`. No labels created; the caption
reuses `@TaxTransactionInquiry:HeaderNote`.
