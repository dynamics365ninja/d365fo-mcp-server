# Golden: L4-ssrs-report-uibuilder — CAPTURED, PENDING HUMAN REVIEW (§6.4)

Captured 2026-08-30 (Phase F), server SHA 93d6658 + the Phase F working tree, xppc
7.0.7996.33 (VM), sandbox model `fm-mcp`, `EXTENSION_PREFIX=Con`. All seven objects
come from ONE `generate_object(mode="scaffold", objectType="report", …, uiBuilder=true,
generateController=true)` call; the three follow-up edits went through
`d365fo_file(action="modify")` — `replace-code` on `build()` and `processReport()`,
`add-method` for `custGroupLookup()`. No hand-edited XML.

## Artifacts

- `ConDemoCustGroupReportTmp.metadata.xml` — TempDB table, `GroupId` (`CustGroupId`),
  `Description` (`Description`).
- `ConDemoCustGroupReportContract.metadata.xml` — `[DataContractAttribute,
  SysOperationContractProcessing(classStr(ConDemoCustGroupReportUIBuilder))]`, one
  `str custGroup` member with `parmCustGroup()` (labelled `@TaxTransactionInquiry:HeaderNote`).
- `ConDemoCustGroupReportUIBuilder.metadata.xml` — `extends SrsReportDataContractUIBuilder`;
  `build()` calls `super()` first, then `this.dataContractObject()`,
  `this.bindInfo().getDialogField(contract, methodStr(…, parmCustGroup))` and
  `registerOverrideMethod(methodStr(FormStringControl, lookup), methodStr(…, custGroupLookup), this)`;
  `custGroupLookup(FormStringControl _control)` builds a `SysTableLookup` over `CustGroup`
  with `addLookupfield` (lower-case **f** — the real member name) for CustGroup + Name, a
  Query whose CustGroup range on `PaymTermId` is `SysQuery::valueNotEmptyString()`,
  `parmQuery()`, `performFormLookup()`.
- `ConDemoCustGroupReportDP.metadata.xml` — `extends SRSReportDataProviderBase`,
  `[SRSReportParameterAttribute]`, `processReport()` = `delete_from` + `while select
  CustGroup, Name from custGroupTable where custGroup == '' || custGroupTable.CustGroup == custGroup`
  inserting one tmp row per record.
- `ConDemoCustGroupReportController.metadata.xml`, `ConDemoCustGroupReport.menuitem.metadata.xml`,
  `ConDemoCustGroupReport.metadata.xml` — scaffold output, untouched.

## Deviations from the authored instruction (recorded in the case file)

1. **`SysQuery::valueNotEmpty()` does not exist.** The authored instruction named it;
   build 1 failed with exactly one error ("Class 'SysQuery' does not contain the static
   method 'valueNotEmpty'"). The real member is `SysQuery::valueNotEmptyString()`.
   `validate_code(mode="references")` on the hand-written lookup method reports it as
   `unknown-static-member` — the implementer had skipped the static gate on the three
   hand-written bodies, which is the process lapse the corpus record names.
2. **Explicit `fields` instead of a bare `fieldsHint`.** With `fieldsHint="GroupId,
   Description"` the name-based EDT suggestion picked the master-planning EDT
   `ReqGroupId` for GroupId; the report copies `CustGroup.CustGroup`, so the case now
   passes `fields=[{name:"GroupId", edt:"CustGroupId"}, {name:"Description", edt:"Description"}]`.

## Build / BP at capture

- Build 1: **1 error** (the SysQuery member above). Build 2 (FULL): **0 errors**, 1
  unrelated warning (Commerce PricingEngine assembly).
- BP, filtered per case object: **Errors 0, Warnings 7** — Tmp table 5
  (`BPErrorEDTNotMigrated` on `CustGroupId`, PK editable, PK not mandatory, FormRef,
  EDT-relation note), controller 1 ("local variable 'contract' is not used" in the
  scaffolded `prePromptModifyContract()` — pre-existing generator wart), menu item 1
  (`BPErrorMenuItemNotCoveredByPrivilege`). UIBuilder, DP, contract and report: 0/0.
  `bp_clean` is scored 0 because warnings exist; the case's own bar ("build clean") is met.

## Descriptor / labels

Descriptor as in `L2-exception-tts-retry/README.md`. No labels created; captions reuse
`@TaxTransactionInquiry:HeaderNote`.
