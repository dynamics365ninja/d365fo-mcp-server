# Golden: L3-report-dataset-extension — CAPTURED, PENDING HUMAN REVIEW (§6.4)

Captured 2026-08-30, server SHA f01dfa7, xppc 7.0.7996.33 (VM), sandbox model
`fm-mcp`, `EXTENSION_PREFIX=Con`. Written through the server's own
`d365fo_file(action="create")` path — no hand-edited XML — then full-built with
xppc and checked with xppbp; the capture script refuses to copy a golden out of
a build that was not clean. Sandbox rolled back afterwards.

## Artifacts

_adding a column to a standard report through extension points only_

`AssetBarCodeTmp.ConExtension.metadata.xml`

| | What it has to keep showing |
|---|---|
| the table extension | one field added to the report's TempDB temp table — the standard table itself is untouched |

`ConDemoAssetBarCodeDPHandler.metadata.xml`

| | What it has to keep showing |
|---|---|
| `_Post_processReport` | `[PostHandlerFor(classStr(AssetBarCodeDP), methodStr(AssetBarCodeDP, processReport))]` with `(XppPrePostArgs _args)` — any other parameter type is "cannot be used as an event handler ... because the parameter profile does not match" |
| the body | `_args.getThis()` downcast with `as` before use, and `linkPhysicalTableInstance` to reach the provider's temp table rather than a fresh, empty one |

## Notes from the capture

Built clean on the first attempt, xppbp clean. Nothing standard was modified:
not the RDP class, not the temp table, not the report.

The target was read off disk rather than recalled —
`ApplicationSuite/Foundation/AxClass/AssetBarCodeDP.xml` extends
`SRSReportDataProviderPreProcessTempDB`, has a public `processReport()`, and
declares its dataset as `AssetBarCodeTmp` (TableType TempDB). Its accessor is
spelled `geAssetBarCodeTmp` — a typo shipped by the platform, and exactly the
kind of name that has to be read rather than guessed.

`linkPhysicalTableInstance` is the load-bearing line: a TempDB buffer declared
in the handler would be a DIFFERENT, empty table, and the handler would appear
to work while updating nothing.
