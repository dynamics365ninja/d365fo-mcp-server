# Golden: L4-ssrs-report-design-rdl — FROZEN (with two known generator defects, see below)

Captured 2026-08-31 on the D365FO dev VM. Model `fm-mcp`, `EXTENSION_PREFIX=Con`
(authored name `DemoCreditLimitReport` → AOT name `ConDemoCreditLimitReport`),
xppc 7.0.7996.33.

Corpus record: `eval/corpus/runs/2026-08-31T11__L4-ssrs-report-design-rdl__993eb10.json`
(classification `TOOL_DEFECT`; score build 1 / bp_clean 0 / golden_match 1).

## Artifacts (all 6 from ONE `generate_object(mode="scaffold", objectType="report", …)` call)

| File | Type | Notes |
|---|---|---|
| `ConDemoCreditLimitReportTmp.metadata.xml` | AxTable | `TableType=TempDB`; `CustGroup`/`AccountNum`/`CreditRating`/`CreditMax` |
| `ConDemoCreditLimitReportContract.metadata.xml` | AxClass | `[DataContractAttribute]`, no dialog params |
| `ConDemoCreditLimitReportDP.metadata.xml` | AxClass | `extends SrsReportDataProviderBase`; hand-completed `processReport()` |
| `ConDemoCreditLimitReportController.metadata.xml` | AxClass | `extends SrsReportRunController`; `ssrsReportStr(ConDemoCreditLimitReport, Report)` |
| `ConDemoCreditLimitReport.menuitem.metadata.xml` | AxMenuItemOutput | → Controller class |
| `ConDemoCreditLimitReport.metadata.xml` | AxReport | precision design + RDL (grouped tablix with totals) |

## What this golden pins (the case bar)

- The design is an XML **type**: `<AxReportDesign i:type="AxReportPrecisionDesign">`, name `Report`.
- RDL detail cells read the dataset: `=Fields!CustGroup.Value`, `=Fields!AccountNum.Value`,
  `=Fields!CreditRating.Value`, `=Fields!CreditMax.Value`.
- The page header shows the legal entity: `=Parameters!AX_CompanyName.Value`.
- Group total and grand total live in the **design**: `=Sum(Fields!CreditMax.Value)` twice, over
  `<GroupExpression>=Fields!CustGroup.Value</GroupExpression>`. `processReport()` inserts **detail
  rows only** (`insert_recordset` from `CustTable`) — no X++ aggregate, so no double count.
- The six platform parameters appear only where the framework declares them (`AxReportParameter`
  metadata + RDL `QueryParameters`); **no X++ declares or passes one**.
- No RDL `<Code>` block.

Two deviations from the raw scaffold output, both applied through `d365fo_file(action="modify")`:
`processReport()` was completed (the scaffold emits a TODO), and the tmp table's unique index was
widened from `[CustGroup]` to `[CustGroup, AccountNum]` — see defect 3.

## Known defects this golden ENSHRINES (re-capture when they are fixed)

1. **RDL title is a literal label id.** `<Textbox Name="ReportTitle"><Value>@SYS313987</Value>`.
   Shipped designs write `=Labels!@SYS313987`; a bare `@Id` is not label-transformed at deploy, so
   the header renders the raw id. The column-header cells have the same shape one level down
   (`<Value>CustGroup</Value>` instead of `=Labels!@…`).
2. **No write path to fix it.** `d365fo_file(action="modify", objectType="report",
   operation="replace-code")` is rejected — "not supported by the bridge" — and no report-shaped
   operation exists, so the grounded path cannot correct anything inside an AxReport. That is why
   the defect is frozen rather than repaired: the golden is the best the tool can currently emit.
3. **Unique index over the group field** (repaired here, so NOT enshrined). The scaffold made the
   first field a unique single-field index and pointed ClusteredIndex/PrimaryIndex/ReplacementKey at
   it; under `designStyle="GroupedWithTotals"` that field is by construction the repeating group key,
   so the table could hold only one row per group.

When defect 1 or 2 is fixed, this golden must be re-captured and this section updated.

## Re-run caveat (harness, not the artifact)

The RDL carries three per-generation GUIDs inside the CDATA — `rd:DataSourceID`, `rd:DataSetID`,
`rd:ReportID`. `src/eval/oracle/normalize.ts` does not mask GUIDs and the case `ignore` globs cannot
reach inside CDATA, so **any re-run reports a spurious mismatch on those three lines**. The same is
true of the other four report goldens. Fix the normalizer before trusting a report-case re-run.
