# Golden: L3-form-event-handler-class — CAPTURED, PENDING HUMAN REVIEW (§6.4)

Captured 2026-08-30, server SHA f01dfa7, xppc 7.0.7996.33 (VM), sandbox model
`fm-mcp`, `EXTENSION_PREFIX=Con`. Written through the server's own
`d365fo_file(action="create")` path — no hand-edited XML — then full-built with
xppc and checked with xppbp; the capture script refuses to copy a golden out of
a build that was not clean. Sandbox rolled back afterwards.

## Artifacts

_extending a form from outside, with the four sender types_

`ConDemoServiceCall.metadata.xml`

| | What it has to keep showing |
|---|---|
| the table | four fields and an `Overview` field group — the group the SimpleList grid binds to |

`ConDemoServiceCallForm.metadata.xml`

| | What it has to keep showing |
|---|---|
| the form | SimpleList over that table; the grid column for the date field is an `AxFormDateControl`, not a String one |

`ConDemoServiceCallFormHandler.metadata.xml`

| | What it has to keep showing |
|---|---|
| `_OnInitialized` | `[FormEventHandler]` with `(xFormRun _sender, FormEventArgs _e)` — **xFormRun**, not FormRun |
| `_OnValidatingWrite` | `[FormDataSourceEventHandler]` with `(FormDataSource, FormDataSourceEventArgs)`, rejecting the row through `FormDataSourceCancelEventArgs.cancel(true)` |
| `_OnModified` | `[FormDataFieldEventHandler]` with `(FormDataObject, FormDataFieldEventArgs)`, deriving a second field from the modified one |
| `_OnLookup` | `[FormControlEventHandler]` with `(FormControl, FormControlEventArgs)`, a `SysTableLookup`, and `CancelSuperCall()` — without which BOTH lookups run |

## Notes from the capture

This capture found three defects; it is the reason the case was worth running.

**1. The knowledge base was wrong about `CancelSuperCall`.** The
`form-event-handlers` entry said to call `_e.CancelSuperCall()`. xppc: "Class
'FormControlEventArgs' does not contain a definition for 'CancelSuperCall'".
The args have to be narrowed to `FormControlCancelableSuperEventArgs` first. The
rule and its example are fixed, and the type is on the knowledge-audit allowlist
with the compiler message as its evidence.

**2. Table create silently dropped `properties.fieldGroups`.** The `<FieldGroups>`
block in `buildAxTableXml` was a hardcoded literal holding only the five Auto*
groups. A table with no groups of its own still builds clean, so this stayed
invisible until the form template emitted `<DataGroup>Overview</DataGroup>` and
the build failed with "Field group 'Overview' does not exist" — on the FORM,
pointing away from the table that actually lost it.

**3. Form create never resolved field control types.** Every grid column came out
`AxFormStringControl`. Harmless for a string field; for the date field it was
"AxForm/.../DataField: Data type mismatch". The templates have accepted a
`fieldTypes` map all along and `generate_object` supplies one — the
`d365fo_file(action="create")` builder simply never did. It now resolves the
types off disk, which also works for a table written moments earlier in the same
call and therefore absent from the symbol index.

Both write-path fixes are covered by `tests/tools/xml/formTableCreateFidelity.test.ts`.
After them the slice built clean and xppbp clean.
