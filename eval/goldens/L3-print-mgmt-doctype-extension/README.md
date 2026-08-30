# Golden: L3-print-mgmt-doctype-extension — CAPTURED, PENDING HUMAN REVIEW (§6.4)

Captured 2026-08-30 (Phase F), server SHA 93d6658 + the Phase F working tree (the
generator correction below is in that tree), xppc 7.0.7996.33 (VM), sandbox model
`fm-mcp`, `EXTENSION_PREFIX=Con`. Written in the order the case prescribes: enum
extension via `prepare(change)` -> `d365fo_file(action="create", objectType="enum-extension")`,
the six report objects via ONE `generate_object(mode="scaffold", …, controllerType="printMgmt")`,
one `replace-code` on the controller, and the handler via `prepare(create)` ->
`validate_code(mode="both")` -> `d365fo_file(action="create")`. No hand-edited XML.

## Artifacts (8)

- `PrintMgmtDocumentType.ConExtension.metadata.xml` — AxEnumExtension on the STANDARD
  `PrintMgmtDocumentType` with the single value `DemoEvalReceipt`, label `@SYS4007767`
  ("Receipt"). Read back after the write with `get_object_info(include="xml")`:
  `<EnumValues>` is NON-EMPTY.
- `ConDemoEvalReceiptTmp.metadata.xml` — TempDB table, `SalesId` (`SalesIdBase`),
  `CustAccount` (`CustAccount`), label `@SYS4007767`.
- `ConDemoEvalReceiptContract.metadata.xml`, `ConDemoEvalReceiptDP.metadata.xml` — scaffold output.
- `ConDemoEvalReceiptController.metadata.xml` — **`extends SrsPrintMgmtController`**;
  `main()` = parmArgs / parmReportName(`ssrsReportStr(ConDemoEvalReceipt, Report)`) /
  startOperation; `initPrintMgmtReportRun()` =
  `PrintMgmtReportRun::construct(PrintMgmtHierarchyType::Sales, PrintMgmtNodeType::SalesTable,
  PrintMgmtDocumentType::DemoEvalReceipt)` + `parmReportRunController(this)` + `super()`;
  `runPrintMgmt()` = `printMgmtReportRun.load(this.parmArgs().record(), this.parmArgs().record(),
  Global::currentUserLanguage())` + `this.outputReports()`.
- `ConDemoEvalReceipt.menuitem.metadata.xml`, `ConDemoEvalReceipt.metadata.xml` — menu item
  and AxReport (design `Report`; RDL text is in the case's ignore list).
- `ConDemoEvalReceiptDocTypeHandler.metadata.xml` — two static handlers decorated
  `[SubscribesTo(classStr(PrintMgmtDocType), delegateStr(PrintMgmtDocType, getDefaultReportFormatDelegate))]`
  and `…getQueryTableIdDelegate…`, both guarded on
  `_docType == PrintMgmtDocumentType::DemoEvalReceipt`, answering
  `_result.result(ssrsReportStr(ConDemoEvalReceipt, Report))` and `_result.result(tableNum(SalesTable))`.
  Delegate signatures confirmed with `get_object_info(options={method, include:"signature"})`:
  `void …Delegate(PrintMgmtDocumentType _docType, EventHandlerResult _result)`;
  `EventHandlerResult.result(anytype _value = null)`.

## The scaffold defect this case exposed (fixed in the same tree)

The pre-Phase-F `controllerType="printMgmt"` scaffold did not compile — build 1:

```
Class 'ConDemoEvalReceiptController' does not implement the abstract method 'runPrintMgmt' from the class 'SrsPrintMgmtController'.
ClassDoesNotContainMethod: Class 'ConDemoEvalReceiptController' does not contain a definition for method 'parmPrintMgmtDocType' …
```

`SrsPrintMgmtController` (read on the VM) declares `protected abstract void runPrintMgmt()`
and has NO `parmPrintMgmtDocType`. All 24 shipped direct subclasses
(`BankPaymAdviceCustController`, `CustAccountStatementController_FR`,
`TMSLoadTenderController`, …) fix the document type in `initPrintMgmtReportRun()` through
`PrintMgmtReportRun::construct(hierarchy, node, documentType)` and implement
`runPrintMgmt()` as `printMgmtReportRun.load(…)` + `outputReports()`. The generator, the
`controllerType` op-spec, the `PrintMgmtFormLetter` catalog entry, the
`print-management` / `ssrs-reports` topics and this case's instruction were corrected
(`tests/tools/generateSmartReport.test.ts` pins the shape). The corrected scaffold built
with **0 errors**.

Two smaller deviations, also recorded in the case file: the scaffold is called with
`caption="@SYS4007767"` (without a caption it writes raw-text labels — `BPErrorLabelIsText`)
and with explicit `fields` mirroring `SalesTable` (a bare `fieldsHint` lets the name-based
EDT suggestion pick unrelated EDTs, as the two L4 report captures showed).

## Build / BP at capture

- Build 1 (old scaffold): **2 errors** (above). Build 2 (corrected scaffold, raw labels): 0
  errors. Build 3 (FINAL, with caption): **0 errors**, 1 unrelated warning (Commerce
  PricingEngine assembly).
- BP, filtered per object: **Errors 0, Warnings 9** — Tmp table 7
  (`BPErrorEDTNotMigrated` ×2 on SalesIdBase/CustAccount + the two EDT-relation notes,
  PK editable, PK not mandatory, FormRef), controller 1 ("local variable 'contract' is
  not used" in the scaffolded `prePromptModifyContract()` — pre-existing generator wart),
  menu item 1 (`BPErrorMenuItemNotCoveredByPrivilege`). Contract, DP, report, handler: 0/0.
- The enum extension is **not BP-checkable**: xppbp has no element type for enum
  extensions (its own rejection lists every type it knows; `EnumExtension` is absent).
  `run_bp_check` used to advertise `enum-extension` as translatable — fixed in this tree
  to say so and point at the base enum. Its values are validated by the build.

## Descriptor / labels

Descriptor as in `L2-exception-tts-retry/README.md` (ApplicationSuite is what
PrintMgmtDocumentType, PrintMgmtDocType, SrsPrintMgmtController and SalesTable need).
No labels created; `@SYS4007767` is a standard "Receipt" label.
