# Golden: L2-args-record-caller — CAPTURED, PENDING HUMAN REVIEW (§6.4)

Captured 2026-08-30, server SHA f01dfa7, xppc 7.0.7996.33 (VM), sandbox model
`fm-mcp`, `EXTENSION_PREFIX=Con`. Written through the server's own
`d365fo_file(action="create")` path — no hand-edited XML — then full-built with
xppc and checked with xppbp; the capture script refuses to copy a golden out of
a build that was not clean. Sandbox rolled back afterwards.

## Artifacts

_reading the record an entry point was opened with, and refusing the rest_

`ConDemoOrderEntryPoint.metadata.xml`

| | What it has to keep showing |
|---|---|
| `main` | `dataset()` checked against `tableNum(CustTable)` BEFORE `record()` is touched, a labelled `throw error(...)` otherwise, `parm()` for the string argument, and `caller() as FormRun` tested for null before use |
| `openFrom` | an `Args` built in code and run through `new MenuFunction(menuItemDisplayStr(CustTable), MenuItemType::Display)` |

## Notes from the capture

Built clean on the first attempt, xppbp clean.

The guard is the case. Any caller can pass any table, so `record()` read without
a `dataset()` check is how an entry point silently acts on the wrong buffer —
and because `caller()` is typed `Object` and late bound, a wrong-type call
surfaces at RUN time, not here. Both are things a build cannot catch, which is
why they are pinned in a golden instead.

`menuItemDisplayStr(CustTable)` was confirmed against
`ApplicationSuite/Foundation/AxMenuItemDisplay/CustTable.xml` before it was
written; the intrinsic would have failed the build otherwise, but the point of
the case is that it should not take a build to find out.
