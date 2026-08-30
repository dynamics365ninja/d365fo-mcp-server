# Golden: L3-sysoperation-dialog-attributes — CAPTURED, PENDING HUMAN REVIEW (§6.4)

Captured 2026-08-30, server SHA f01dfa7, xppc 7.0.7996.33 (VM), sandbox model
`fm-mcp`, `EXTENSION_PREFIX=Con`. Written through the server's own
`d365fo_file(action="create")` path — no hand-edited XML — then full-built with
xppc and checked with xppbp; the capture script refuses to copy a golden out of
a build that was not clean. Sandbox rolled back afterwards.

## Artifacts

_a SysOperation dialog produced only by attributes on the contract_

`ConDemoRebateContract.metadata.xml`

| | What it has to keep showing |
|---|---|
| class attributes | `[DataContractAttribute]` plus a class-level `[SysOperationGroupAttribute(name, label, sequence)]` |
| `parmCustGroup`, `parmIncludeBlocked` | `[DataMemberAttribute]`, `[SysOperationLabelAttribute(literalStr(...))]`, `[SysOperationGroupMemberAttribute]` and `[SysOperationDisplayOrderAttribute(...)]` — the display order is a STRING |
| `parmCallerRecId` | `[SysOperationControlVisibilityAttribute(false)]`: on the contract, not in the dialog |
| `initialize` | `SysOperationInitializable` — defaults filled before the dialog is shown |
| `validate` | `checkFailed` with a label, returning false so the dialog stays open |

`ConDemoRebateService.metadata.xml`

| | What it has to keep showing |
|---|---|
| `process` | the work — and NO `[SysEntryPointAttribute]`, which xppc calls obsolete and deprecated in AX7 |

`ConDemoRebateController.metadata.xml`

| | What it has to keep showing |
|---|---|
| `construct` / `main` | `SysOperationServiceController` bound to the service method by `classStr` + `methodStr` |

## Notes from the capture

Built clean on the first attempt, xppbp clean — all six SysOperation attributes
stacking in one bracket, which was the part the knowledge entry claimed and this
now compiles.

Labels are shipped SYS ids, checked in the platform label file rather than
invented: raw text in a label slot fails xppbp with `BPErrorLabelIsText`.
