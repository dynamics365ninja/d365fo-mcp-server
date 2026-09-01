# Golden: L3-sysoperation-dialog-attributes — RE-CAPTURED, PENDING HUMAN REVIEW (§6.4)

Re-captured 2026-08-31, server SHA 278eee3, xppc 7.0.7996.33 (VM), sandbox model
`fm-mcp`, effective prefix `ConDemo`. Written through the server's own
`d365fo_file(action="create")` path — no hand-edited XML — then full-built with
xppc (0 errors, 0 warnings) and checked with xppbp (0 errors; the only warnings
in the model belong to the pre-existing fixture table `ConDemoNoteHeader`). The
capture script refuses to copy a golden out of a build that was not clean, and
its four refusal paths were exercised before the real capture. Sandbox rolled
back afterwards.

**This replaces the 2026-08-30 capture (SHA f01dfa7), which commit `10a8fe2`
deleted.** That one was written while `create(class)` silently dropped every
multi-line method attribute block, so it contained NONE of the five method-level
attributes this README describes — for a case whose entire subject is "the
dialog is produced only by attributes on the contract". The contract table below
is unchanged; the artifacts are new.

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
stacking in one bracket, which is what the `sysoperation-ui-attributes`
knowledge entry claims.

Labels are shipped SYS ids, checked in the platform label file rather than
invented: raw text in a label slot fails xppbp with `BPErrorLabelIsText`. The
`@SYS100074` the previous capture passed to the service's `info()` was replaced
— it reads "There is no record with sorting ID %1 and sort code %2", which is
not what that message says. `defaultCaption` is declared `protected` here, as it
is on `SysOperationServiceController`.

**Regression guard — the whole point of this golden.** Every method-level
attribute block here was SENT as a multi-line block and read back off disk to
confirm it survived; that is the defect `10a8fe2` fixed and the deleted golden
is the evidence it once shipped. A future capture that comes back without
`[DataMemberAttribute]`, `[SysOperationLabelAttribute]`,
`[SysOperationGroupMemberAttribute]`, `[SysOperationDisplayOrderAttribute]` or
`[SysOperationControlVisibilityAttribute]` on the parm methods is that defect
returning, not a valid variant — a class with the attributes stripped still
compiles clean and still passes xppbp.

**Known cosmetic deviation, deliberately captured as-is.** The continuation
lines of each multi-line attribute block, and the method signature line that
follows the block, carry one extra indent level (8 spaces) while the method's
own `{` sits at 4. That is `reindentXppSource` in `src/utils/xppFormat.ts`:
`terminatesStatement()` only recognises a SINGLE-line `[Attr]` as terminating, so
the statement never closes. It is whitespace only — the golden diff normalises
both sides through the same function — so fixing it does not invalidate this
golden. See the corpus record for this capture.
