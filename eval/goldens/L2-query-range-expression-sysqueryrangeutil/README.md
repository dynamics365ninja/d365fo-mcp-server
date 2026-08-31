# Golden - L2-query-range-expression-sysqueryrangeutil

Golden metadata for [`L2-query-range-expression-sysqueryrangeutil`](../../cases/L2-query-range-expression-sysqueryrangeutil.json).

Captured 2026-08-31 on the D365FO VM (model `fm-mcp`, prefix `Con`, xppc 7.0.7996.33,
server SHA 9045b22) through the grounded tool path only - `prepare` -> `get_knowledge`/
`get_object_info` -> `validate_code` -> `labels(create)` -> `d365fo_file(action="create")`.
No hand-edited XML, no `overwrite=true`.
Corpus record: `eval/corpus/runs/2026-08-31T09__L2-query-range-expression-sysqueryrangeutil__9045b22.json`.

## What the two artifacts record

| file | what it pins |
|---|---|
| `ConDemoQueryRanges.metadata.xml` | the range-vs-filter contrast on one and the same outer join, plus every `SysQuery::` value builder |
| `ConDemoRangesCon_Extension.metadata.xml` | `[ExtensionOf(classStr(SysQueryRangeUtil))] public static class` with two `[QueryRangeFunction()] public static str` methods |

Four things must hold in `ConDemoQueryRanges`:

1. **The two builders differ in exactly one statement.** `buildQueryWithChildRange` and
   `buildQueryWithChildFilter` share the same parent range and the same
   `addTransactionDataSource` helper (`joinMode(JoinMode::OuterJoin)` + `relations(false)`
   + `addLink`). The only delta is
   `SysQuery::findOrCreateRange(custTransDs, fieldNum(CustTrans, CurrencyCode))` versus
   `query.addQueryFilter(custTransDs, fieldStr(CustTrans, CurrencyCode))` - that single
   line is what turns the outer join into an inner join.
2. **The filter is added on the QUERY, the range on the DATA SOURCE.** `addQueryFilter`
   is a `Query` method taking the qbds plus the field as a **string** (`fieldStr`);
   `addRange`/`findOrCreateRange` is a data-source method taking a **field id**
   (`fieldNum`). Getting these two mixed up is the failure this case exists to catch.
3. **No range value is concatenated.** `SysQuery::value`, `::valueNot`,
   `::range(from, to)` and `::valueEmptyString()` build all four expression kinds,
   including the enum value (`SysQuery::value(CustVendorBlocked::No)`).
4. **Distinct-parent counting.** `countCustomers` collects `AccountNum` into a `Set`.
   Counting `QueryRun.next()` iterations would count parent/child PAIRS on the outer
   join and would not show the effect the case is about.

## Kernel types on this path

`QueryFilter` and `JoinMode` are kernel artifacts with no AOT metadata.
`validate_code(mode="references")` therefore reports `JoinMode::OuterJoin` as an ERROR
(`unknown-static-member`) - a false positive: the model builds with 0 errors and 0
warnings. `QueryFilter` as a variable type resolved fine. See the corpus record's
`static_gate` for the full list.

## The extension class name is the tool's, not the case's

The instruction asks for `<Prefix>Ranges_Extension`. That name is **unreachable**
through `d365fo_file(action="create")` at this SHA: any `objectName` ending in
`_Extension` goes through the class-extension naming heuristic, which infixes the model
prefix before the suffix. Passing the already-prefixed `ConDemoRanges_Extension`
produced `ConDemoRangesCon_Extension` (prefix at both ends) and the tool rewrote the
`<Name>` and the class declaration to match. The golden pins the tool's output, because
renaming it would have meant a hand edit. If the naming path is fixed, this golden's
filename and `<Name>` are the thing to re-capture.

## Known non-goals

* **The label file is not a golden artifact.** `info(strFmt("@ConDemo:QueryRangeVersusFilter", ...))`
  needs a real label (`BPErrorLabelIsText` otherwise), so the run created the
  `ConDemo` label file in `fm-mcp`. It is run residue, removed at rollback, and the
  case's `target_artifact_types` is `AxClass` only.
* **No runtime oracle.** The case has no `systest`; the range/filter difference is only
  observable against a company with customer transactions, which the sandbox does not
  guarantee. `systest: null`.
* **`.rnrproj` membership is NOT OBSERVED** - the eval sandbox carries no project file.

## Normalization

Per the case `ignore[]`: `**/@Id`, `**/ModelSaveInfo`. Neither appears in the generated
XML. The provenance comment at the top of each file is dropped by the oracle's XML
normalizer and does not affect `golden_match`.
