# Golden: L3-print-management-report — FROZEN

Captured 2026-07-29, server SHA 33f6418, xppc 7.0.7858.27 (VM), model `Contoso`,
`EXTENSION_PREFIX=Con`. Every artifact was written through
`prepare(create)` -> `d365fo_file(action="create")`. No `overwrite`, no hand-edited
XML, no filesystem writes.

## Artifacts

- `ConDemoPrintDocType.metadata.xml` — AxEnum, `IsExtensible=true`,
  label `@Contoso:DemoPrintDocTypeName`, single element `DemoConfirmation`
  (label `@Contoso:DemoPrintDocTypeConfirmation`).
- `ConDemoPrintMgmtDocType.metadata.xml` — AxClass **extending `PrintMgmtDocType`**
  (ApplicationFoundation). Overrides the two framework members:
  `public PrintMgmtReportFormatName getDefaultReportFormat()` returning the SSRS
  report design name as a plain single-quoted str constant
  (ConDemoConfirmation.Report), and `public str getDisplayName()` returning the
  node description label `"@Contoso:DemoPrintMgmtNodeDescription"` (double quotes =
  compile-time label resolution). Plus `newDemoDocType()` (factory; the base
  `new()` is `protected`, and the base `construct(PrintMgmtDocumentType)` name is
  deliberately not reused) and `getDemoDocumentType()` tying the class to the new
  base enum.
- `ConDemoPrintMgmtRunner.metadata.xml` — AxClass with
  `public static void printFor(Num _documentId)`. Resolves the setup by asking the
  doc-type class for its format name, joining `PrintMgmtReportFormat` to
  `PrintMgmtSettings`, and — when nothing is set up — infologs the labelled message
  `@Contoso:DemoPrintNoSettingConfigured` through `strFmt` with the document id.
  The `SRSPrintDestinationSettings` instance is **never constructed**: it is taken
  from `SrsReportRunController.parmReportContract().parmPrintSettings()` and loaded
  with the stored print-management job settings via
  `unpack(PrintMgmtSettings.PrintJobSettings)`, then handed back through
  `PrintMgmtPrintSettingDetail.parmPrintJobSettings()`.

## Grounding (every signature confirmed, none guessed)

`get_knowledge(topic="print-management")` first, then against the real AOT:

| Member used | Confirmed signature | Source |
|---|---|---|
| `PrintMgmtDocType.getDefaultReportFormat()` | `public PrintMgmtReportFormatName getDefaultReportFormat()` | `get_method` |
| `PrintMgmtDocType.getDisplayName()` | `public str getDisplayName()` | `get_method` |
| `PrintMgmtDocType.new()` | `protected void new()` | `get_object_info` |
| `PrintMgmtPrintSettingDetail.parmPrintJobSettings()` | takes/returns `SRSPrintDestinationSettings` | `get_object_info` |
| `PrintMgmtPrintSettingDetail.parmReportFormatName / parmInstanceName / parmNumberOfCopies` | as listed on the class | `get_object_info` |
| `PrintMgmtSettings` (TABLE, not a class) | fields `ReportFormat`, `PrintJobSettings` (`PrintJobSettingsPacked`), `NumberOfCopies`, `Description`, `ParentId`, `PriorityId` | `get_object_info(objectType="table")` |
| `PrintMgmtReportFormat` (TABLE) | `Name` (`PrintMgmtReportFormatName`), `RecId`, `DocumentType`, `System` | `get_object_info(objectType="table")` |
| `SrsReportRunController.parmReportContract()` | `public SrsReportDataContract parmReportContract(...)`; the getter lazily calls `getReportContract()`, so it is safe right after `parmReportName()` | `get_method` (read the body) |
| `SrsReportDataContract.parmPrintSettings()` | `public SRSPrintDestinationSettings parmPrintSettings(...)` | `get_object_info(members="names")` |
| `SRSPrintDestinationSettings.unpack()` | `public boolean unpack(container _pack)` | `get_object_info(members="names")` |
| `SysOperationController.startOperation()` | `public SysOperationStartResult startOperation()` | `get_method` |

Notable grounding corrections against the naive guess:

- `PrintMgmtSettings` and `PrintMgmtDocInstance` are **tables**, not classes
  (`search(type="class")` returns nothing for either).
- `PrintMgmtDocType` has **no subclasses in the standard model** and no abstract
  members; the standard extension seam is the delegate
  `getDefaultReportFormatDelegate(PrintMgmtDocumentType, EventHandlerResult)`.
- `PrintMgmtNode` (abstract) is a different concept — hierarchy nodes, with
  `getDisplayCaptionImplementation` / `getNodeType` — and is not what a
  `...PrintMgmtDocType` class implements.

## Design decision worth challenging

A production print-management registration extends the **`PrintMgmtDocumentType`**
enum and subscribes to `PrintMgmtDocType.getDefaultReportFormatDelegate`; settings
are then resolved by
`PrintMgmtPrintContext.setHierarchyContext(PrintMgmtHierarchyType, PrintMgmtNodeType, PrintMgmtDocumentType, Common)`
plus `PrintMgmt::getSettings()`. The case instruction instead asks for a **base
enum** `DemoPrintDocType`, and every one of those APIs is typed on
`PrintMgmtDocumentType`, so the delegate/context path is closed to a custom base
enum. The capture therefore registers the node by **subclassing `PrintMgmtDocType`
and overriding the two members by name**, which is what "the members the framework
expects" means here and — unlike a delegate handler — is enforced by the compiler
(see negative probe 1). The `PrintMgmtReportFormat` -> `PrintMgmtSettings` join is
the resolution path a custom document type can actually take.

## Negative probes (a green build is not proof)

Three deliberate breakages, each applied with
`d365fo_file(action="modify", operation="replace-code")` and followed by a
`fullBuild: true` build. All were restored, and the restored files were verified
byte-identical to these goldens.

1. **Member signature** — `getDefaultReportFormat` return type changed from
   `PrintMgmtReportFormatName` to `boolean`. Build **FAILED**, 3 errors, headed by:
   "Method 'boolean ConDemoPrintMgmtDocType.getDefaultReportFormat()' does not
   override 'str(PrintMgmtReportFormatName) PrintMgmtDocType.getDefaultReportFormat()'
   because the return type must be 'str(PrintMgmtReportFormatName)' instead of
   'boolean'." — plus "Cannot implicitly convert from type 'boolean' to type
   'str(PrintMgmtReportFormatName)'" in `ConDemoPrintMgmtRunner.printFor`. This
   proves the class genuinely OVERRIDES a framework member rather than merely
   declaring a same-named one, and that the runner is type-bound to it.
2. **Resolved-settings call** — `printSettingDetail.parmPrintJobSettings(printDestinationSettings)`
   changed to pass the raw packed container `printMgmtSettings.PrintJobSettings`.
   Build **FAILED**, 1 error: "Type mismatch in
   'PrintMgmtPrintSettingDetail.parmPrintJobSettings' argument 1. The expected type
   is 'SRSPrintDestinationSettings', but the actual type is
   'container(PrintJobSettingsPacked)'." The settings really must travel as a
   resolved `SRSPrintDestinationSettings`; the packed field cannot be
   short-circuited.
3. **Label** — the infolog label swapped for a non-existent
   `@Contoso:DemoPrintNoSettingConfiguredBogus`. The build still **succeeded**
   (unknown labels are not compile errors) and the FILTERED BP run reported exactly
   the historical poison pair: `BPErrorUnknownLabel: 1` and
   `BPUnusedStrFmtArgument: 1`. Restoring the real label made the same filtered BP
   run clean. So xppbp does validate the label (the clean result below means
   something), and the labelc-before-build/BP fix works: a label created with
   `labels(action="create")` now compiles.

## Build / BP at capture

- FULL build (`fullBuild: true`, target model): **0 errors**, 1 unrelated warning
  (Commerce `PricingEngine` external assembly — present on every build of this VM).
  The build log shows "Labels compiled for Contoso — Done compiling 1 label files!"
  before xppc runs.
- BP: one FILTERED run per object (`targetFilter` + `targetElementType`, each
  reporting "1 elements processed"): `class:ConDemoPrintMgmtDocType` 0 errors /
  0 warnings, `class:ConDemoPrintMgmtRunner` 0/0, `enum:ConDemoPrintDocType` 0/0.

## Labels

Created for this case with `labels(action="create")` in label file `Contoso`
(model `Contoso`, en-US) and removed again at rollback, because
`Contoso.en-US.label.txt` is shared across cases and is kept empty:

- `DemoPrintDocTypeName` = "Demo print document type"
- `DemoPrintDocTypeConfirmation` = "Demo confirmation"
- `DemoPrintMgmtNodeDescription` = "Demo confirmation document"
- `DemoPrintNoSettingConfigured` = "No print management setting is configured for document %1."

A re-run must re-create them before creating the objects.

## Descriptor

No package reference added. `PrintMgmtDocType`, `PrintMgmtSettings`,
`PrintMgmtReportFormat`, `PrintMgmtPrintSettingDetail`, `SrsReportRunController`,
`SrsReportDataContract` and `SRSPrintDestinationSettings` all live in
**ApplicationFoundation**, which `Contoso.xml` already references.
