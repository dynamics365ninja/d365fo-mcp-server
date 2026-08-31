# L4-ssrs-report-print-destinations

Golden captured 2026-08-31 on the VM (model `fm-mcp`, prefix `Con`, xppc 7.0.7996.33).
One artifact: `ConDemoReportDestinationController.metadata.xml` (`AxClass`).

## What the golden must keep showing

An `SrsReportRunController` subclass that decides the print destination **in code**, in
`preRunModifyContract()` — after the dialog, before the render — so every dialog choice the
class does not override survives:

- **`preRunModifyContract()`** declares `SRSPrintDestinationSettings`, calls `super()`, and only
  then reads `this.parmReportContract().parmPrintSettings()`. It switches on the requested
  medium and leaves `Screen` / `Printer` / `Custom` exactly as the user configured them.
- **File / PDF** (`applyFileDestination`): `printMediumType(SRSPrintMediumType::File)` **first**,
  then `fileFormat(SRSReportFileFormat::PDF)`, `fileName(...)`, `overwriteFile(true)`.
- **E-mail** (`applyEmailDestination`): `printMediumType(SRSPrintMediumType::Email)`, then
  `settings.parmEMailContract()` — which lazily constructs the `SrsReportEMailDataContract` and
  seeds it from the settings, so the dialog values are preserved — followed by `parmTo`,
  `parmSubject`, `parmAttachmentFileFormat(SRSReportFileFormat::PDF)` and `removeInvalidEmails()`.
- **Archive** (`applyArchiveDestination`): `printMediumType(SRSPrintMediumType::Archive)` plus
  `parmPrintToArchive(true)`.
- `main()` grounds the run on a real report design: `ssrsReportStr(FMCustomerList, Report)`
  (FleetManagement; the design really is named `Report`).

Every enum member used is one that exists — mediums `Screen/Printer/File/Email/Custom/Archive`,
formats `CSV/Excel/HTML4_0/Image/MHTML/PDF/XML/Word`. `SrsProxy.renderReportToByteArray` is
**not** used (it is `InternalUseOnly`).

## Result

xppc 0 errors / 0 warnings (incremental **and** full build); `run_bp_check` scoped to this class
alone: 1 element processed, 0 warnings / 0 errors. The 6 BP warnings visible on a model-wide
check belong to the shared fixture table `ConDemoNoteHeader`, not to this artifact.
