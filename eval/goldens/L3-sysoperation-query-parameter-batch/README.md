# Golden: L3-sysoperation-query-parameter-batch — CAPTURED, PENDING HUMAN REVIEW (§6.4)

Captured 2026-08-31, server SHA 06f974f, xppc 7.0.7996.33 (VM), sandbox model
`fm-mcp`, `EXTENSION_PREFIX=Con`. Written through the server's own
`d365fo_file` path — no hand-edited XML — then full-built with xppc (0 errors,
0 warnings) and checked with xppbp (0 errors; the only warnings in the model
belong to the pre-existing fixture table `ConDemoNoteHeader`). Sandbox rolled
back afterwards.

## Artifacts

_a batch job whose dialog offers query ranges, with the query stored PACKED_

`ConDemoJobHistoryScanContract.metadata.xml`

| | What it has to keep showing |
|---|---|
| class | `[DataContractAttribute]`, one `private str packedQuery` member — a STRING, never a `Query` object |
| `parmQuery` | BOTH `[DataMemberAttribute('Query')]` and `[AifQueryTypeAttribute('_packedQuery', queryStr(BatchJobHistoryCleanUp))]`; the first attribute argument of `AifQueryTypeAttribute` is the PARAMETER name with its underscore, the second names the AOT query whose ranges the dialog renders |

`ConDemoJobHistoryScanService.metadata.xml`

| | What it has to keep showing |
|---|---|
| `scanHistory` | `new Query(SysOperationHelper::base64Decode(_contract.parmQuery()))` fed into a `QueryRun`, iterated with `queryRun.next()` / `queryRun.get(tableNum(BatchJobHistory))`; extends `SysOperationServiceBase`; no `[SysEntryPointAttribute]` (obsolete in AX7) |

`ConDemoJobHistoryScanController.metadata.xml`

| | What it has to keep showing |
|---|---|
| `construct` / `main` | `SysOperationServiceController` bound to the service method by `classStr` + `methodStr`, `parmDialogCaption` with a real label id |

## Notes from the capture

The AOT query is `BatchJobHistoryCleanUp` (ApplicationFoundation, referenced by
the sandbox Descriptor) — an unreferenced query is a compile error, not a syntax
one. Labels are real ids in the `ConDemo` label file: raw text in a label slot
fails xppbp with `BPErrorLabelIsText`.

**Regression guard.** The attribute block on `parmQuery` is the whole point of
this case. It reached the file only because it was written as a SINGLE-LINE
attribute list: at capture time `d365fo_file(action="create", objectType="class")`
silently DROPPED any attribute block that spanned more than one line (probe
`ConProbeAttrStrip`: single-line `[DataMemberAttribute]` survived, the two-line
`[DataMemberAttribute('C'),\n SysOperationDisplayOrderAttribute('1')]` did not),
and the resulting class still compiles clean. A future capture of this golden
that comes back WITHOUT the two attributes is that defect, not a valid variant.
