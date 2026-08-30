# Golden: L4-ssrs-report-advanced — PARTLY STALE since 2026-08-30

This folder had no README; it records only what the 2026-08-30 generator change
did to it, and what it did not. For the case itself read
`eval/cases/L4-ssrs-report-advanced.json`.

**Updated here.** `ConDemoNoteReportAdvController.metadata.xml` —
`prePromptModifyContract()` no longer opens with a contract local nothing reads
(`BPLocalVariableNotUsed`); the fetch is in the example instead. The edit is
mechanical, has no index dependency, and is pinned by
`tests/tools/generateSmartReport.test.ts`.

**Left stale on purpose.** `ConDemoNoteReportAdvTmp.metadata.xml`. The case
passes `fieldsHint="NoteId, Subject"`, and EDT resolution is now model-aware, so
a re-run would resolve `NoteId` → `Num` and `Subject` → `Name` (from the
workspace fixture `ConDemoNoteHeader`) instead of the foreign-module
`PlCorrNoteId` / `smmSubject` this golden froze — `PlCorrNoteId` being the EDT
that trips `BPErrorEDTNotMigrated`. Those values cannot be produced without the
live index and the provisioned fixture, so the golden stays as captured and
visibly stale until the case is re-run through `eval-run` on the VM, per the
`L4-entity-security` rule in `eval/README.md`. `L4-ssrs-report-basic`'s golden
already shows the target shape: a human read the source table and typed
`Num`/`Name`.
