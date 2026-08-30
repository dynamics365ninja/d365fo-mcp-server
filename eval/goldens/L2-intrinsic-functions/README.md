# Golden: L2-intrinsic-functions — CAPTURED, PENDING HUMAN REVIEW (§6.4)

Captured 2026-08-30, server SHA d212f3e, xppc 7.0.7996.33 (VM), sandbox model
`fm-mcp`, `EXTENSION_PREFIX=Con`. One `d365fo_file(action="create")` call, no
hand-edited XML, no follow-up edit. Full build 0 errors, xppbp 0/0, golden
self-match. Corpus record:
`eval/corpus/runs/2026-08-30T07__L2-intrinsic-functions__d212f3e.json`.

## Artifact

`ConDemoMetadataRefs.metadata.xml` — AxClass, seven static methods. Every
metadata name in the class is reached through a checked intrinsic; there is no
bare string literal and no `identifierStr`.

| Method | Intrinsics |
|---|---|
| `tableReferences` | `tableStr` / `fieldStr` / `tableNum` / `fieldNum` over `CustTable.AccountNum` |
| `ownReferences` | `classStr` + `staticMethodStr` — self-references, so a rename breaks this build |
| `enumReferences` | `enumStr` / `enumLiteralStr(SalesStatus, Backorder)` / `enumCnt` |
| `indexReference` | `indexStr(CustTable, AccountIdx)` |
| `menuItemReferences` | `menuItemDisplayStr(CustTableListPage)` + `menuItemActionStr(CustWriteOff)` |
| `edtReference` | `extendedTypeStr(CustAccount)` |
| `hardLimits` | `maxInt()` |

Every element above was confirmed with `get_object_info` before it was written —
`CustTableListPage` is a display item, `CustWriteOff` an action item, `AccountIdx`
is a real CustTable index, `Backorder` a real `SalesStatus` literal.

## Notes from the capture

The build is most of the oracle here: a wrong element name, or the display form
handed an action item, is a compile error by construction. That makes this the
one golden of the five whose value is mostly in what it *proves compiles*.

`staticMethodStr` is the correct self-reference form because every method is
static; `methodStr` covers instance methods. The instruction now says so — the
distinction is exactly the sort of thing an implementer gets wrong once.
