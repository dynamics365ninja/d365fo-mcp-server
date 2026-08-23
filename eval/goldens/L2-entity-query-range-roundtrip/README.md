# Golden - L2-entity-query-range-roundtrip

Golden metadata for [`L2-entity-query-range-roundtrip`](../../cases/L2-entity-query-range-roundtrip.json).

Captured 2026-08-23 on the D365FO VM (model `fm-mcp`, prefix `Con`, xppc 7.0.7996.33,
server SHA 4203716) through the grounded tool path only - no hand-edited ViewMetadata,
no `create overwrite=true`.
Corpus record: `eval/corpus/runs/2026-08-23T10__L2-entity-query-range-roundtrip__4203716.json`.

## What the two artifacts record

| file | what it pins |
|---|---|
| `ConDemoRangeSource.metadata.xml` | source table: `NoteId` mandatory/`Num`, `Subject`/`Name`, `IsActive`/`NoYes`, unique alternate-key index `NoteIdx` |
| `ConDemoRangeSourceEntity.metadata.xml` | public data entity in the **post-remove** state of step 6 |

The entity artifact is the load-bearing one. Four things must hold in it:

1. **Placement.** The surviving range lives in
   `ViewMetadata/DataSources/AxQuerySimpleRootDataSource/Ranges` - *not* in the
   entity-level `<Ranges />` sibling that `AxDataEntityView` also carries directly
   under the root element. Both elements are literally named `Ranges`; writing into
   the wrong one builds clean and filters nothing. The golden keeps the entity-level
   one as an empty `<Ranges />` on purpose.
2. **`<Value>` is present.** `<AxQuerySimpleDataSourceRange>` with `Name`/`Field` but
   no `Value` is the specific shape this case exists to catch. It parses, and it
   filters nothing.
3. **Idempotency by absence.** Exactly **one** `IsActive` range. The run issued
   `add-query-range` for it twice, verbatim; the second call reported
   `Range 'IsActive' already present ... skipped (idempotent)` and the file stayed at
   2738 bytes.
4. **Selective removal, no collapse.** `remove-query-range` with
   `rangeName: "SubjectPrefix"` removed only that range. `<Ranges>` still has an
   open/close pair with the `IsActive` child - it was **not** collapsed to
   `<Ranges />`. (The op *does* collapse when the last range goes; that path is not
   what this golden pins.)

## The root data source name

`get_object_info(objectType="data-entity", options={"include":"xml"})` reported the
root data source `<Name>` as **`ConDemoRangeSource`** - equal to the table name for a
single-table entity generated this way. The case still requires reading it back rather
than assuming it, because the ops address a data source by `<Name>` and the equality is
a property of this generator, not a contract.

**Read-back hazard, observed twice now (this run and one earlier run):** that exact
`get_object_info` call is served from a dedup cache keyed on call shape. Re-issuing it
after intervening `d365fo_file(action="modify")` writes returned the **pre-write** body
and appended `Duplicate call ... the result above is identical. Use the data you already
have instead of re-querying.` Cross-check the byte count the modify result reports
against the file before trusting a post-write read-back.

## Known non-goals

* **`bp_clean=0` is expected and is not an implementation defect.** Three table
  warnings (`BPTableWithRecIdIndexMissingReplacementKey`,
  `BPErrorDeveloperDocumentationNotDefined`, `BPErrorTableMissingFormRef` - the case
  admits no `AxForm`, so `FormRef` is unreachable) plus one BP **error** on the entity,
  `DataEntitySecurityPrivilegeCheck`, which fires on any public data entity with no
  `AxSecurityPrivilege`; the case admits none. The table was deliberately left at
  exactly what the instruction asks for, so a faithful re-run reproduces the golden
  byte-for-byte; polishing it to BP-clean would make the golden unreproducible without
  buying a clean BP score anyway.
* **`run_bp_check` cannot check the entity through `objects[]`.** It maps
  `data-entity` to the xppbp element type `dataentity`, which xppbp rejects; the real
  token is `DataEntityView`. The BP figure above came from
  `targetElementType: "DataEntityView"` passed by hand.
* **The joined-data-source half of the PR #927/#928 trap is not reachable here.** No
  tool operation adds an `AxQuerySimpleEmbeddedDataSource` to a data entity - the
  create contract exposes only `primaryTable`. That half stays covered by
  `tests/tools/queryRangeOps.test.ts`.
* **`.rnrproj` membership is NOT OBSERVED.** The eval sandbox carries no project file
  (`build_d365fo_project` builds by `modelName`). Record it as not observed.

## Normalization

Per the case `ignore[]`: `**/@Id`, `**/ModelSaveInfo`. Neither is present in the
generated XML, so nothing was stripped. The provenance comment at the top of each file
is dropped by the oracle's XML normalizer and does not affect `golden_match`.
