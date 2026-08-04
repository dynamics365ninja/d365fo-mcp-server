# Golden: L3-aggregate-measurement-basic - FROZEN

`golden_pending: false` since 2026-08-03. Every byte comes from the grounded
`d365fo_file` path; nothing here is hand-authored.

| Capture | Server SHA | Role |
|---|---|---|
| 2026-08-03 (first capture) | `dffe0dc` | first-time run, no prior draft for this case; full grounded run, `Errors: 0`, 0 BP errors on all four objects, golden captured from this run's own verified output |

Platform xppc 7.0.7858.27, model `Contoso`, `EXTENSION_PREFIX=Con` -> object
names are `ConDemoRequestFact` / `ConDemoRequestFactEntity` / `ConDemoRequestMeasure`.

## Ground truth consulted first

Per the case instruction, `get_knowledge(topic="aggregate-measurements")` was
called before implementing. Its rulebook and minimal example matched exactly
what the writer (`generateAxAggregateMeasurementXml`,
`src/tools/createD365File.ts`) produced:

- The element is `<DefaultAggregate>`, not `AggregateFunction` (the latter
  does not exist in the schema and is dropped silently by the deserializer,
  leaving a measure defaulted to `Sum`).
- The legal `DefaultAggregate` values are `Sum`, `DistinctCount`,
  `AverageOfChildren`, `Max`, `Min`. `resolveDefaultAggregate` (same file,
  ~line 3073) accepts `"Avg"` as an alias for `AverageOfChildren` - its source
  comment explicitly names this case (`L3-aggregate-measurement-basic`) as the
  scenario the alias exists for, i.e. this was already fixed before this
  capture session started.
- `<Table>` inside `AxMeasureGroup` must be the entity
  (`ConDemoRequestFactEntity`), not the raw table - confirmed both by the
  knowledge base guidance ("model the fact source as a data entity or a view,
  not the raw transaction table") and by reading the written XML back from
  disk.

## Artifacts captured (the case's `target_artifact_types`)

- `ConDemoRequestFact.metadata.xml` - `AxTable`, `TableGroup=Main`, label
  `@TaxTransactionInquiry:HeaderNote`, `RequestCode` (EDT `Num`, mandatory),
  `RequestType` (EDT `Name`), `DaysToClose` (Integer), unique alternate-key
  index `RequestFactIdx` (`AlternateKey=Yes`, `AllowDuplicates=No`) on
  `RequestCode`, set as `PrimaryIndex`/`ClusteredIndex`/`ReplacementKey` (same
  pattern as the sibling `L3-dmf-entity-import-slice` and
  `L2-virtual-entity-power-platform` goldens).
- `ConDemoRequestFactEntity.metadata.xml` - `AxDataEntityView`, `IsPublic=Yes`,
  `PublicEntityName=ConDemoRequestFactEntity`,
  `PublicCollectionName=ConDemoRequestFactEntities`, `EntityCategory=Master`,
  `PrimaryKey=EntityKey` -> `AxDataEntityViewKey[EntityKey]` over `RequestCode`
  (natural key, not `RecId`), real `ViewMetadata` query over
  `ConDemoRequestFact`, written with `properties.standardStructure: true` so it
  carries the full standard shape (`<SourceCode>`, the five standard
  `<FieldGroups>`, `<DeleteActions/>`, `<StateMachines/>`) for parity with the
  two sibling goldens referenced above - the case does not itself require
  entity methods, but the standard skeleton was chosen for consistency since
  there was no reason to diverge.
- `ConDemoRequestMeasure.metadata.xml` - `AxAggregateMeasurement`,
  `Usage=StagedEntityStore`, exactly one `AxMeasureGroup`
  (`ConDemoRequestMeasureGroup`) whose `<Table>` is `ConDemoRequestFactEntity`
  (the entity, not the raw table - the case's explicit fail condition),
  one `AxDimensionAttribute` (`RequestType` -> `KeyFields/DimensionField =
  RequestType`), one `AxMeasure` (`AvgDaysToClose`,
  `<DefaultAggregate>AverageOfChildren</DefaultAggregate>`,
  `<Field>DaysToClose</Field>`).

## Required companion NOT in this golden

`AxSecurityPrivilege ConDemoRequestFactEntityMaintain` (`DataEntityPermissions`
-> `ConDemoRequestFactEntity`, Grant CRUD = Allow, created via
`d365fo_file(action="create", objectType="security-privilege",
properties={ dataEntity: "ConDemoRequestFactEntity", accessLevel: "maintain" })`).
Without it xppbp raises the BP error `DataEntitySecurityPrivilegeCheck`,
which the case instruction forbids ("zero BP errors"). It is omitted here
only because `AxSecurityPrivilege` is not in the case's `target_artifact_types`;
a re-run must still create it.

## Minor writer-shape gap found this run (not a scoring blocker)

The written `AxAggregateMeasurement` XML omits the empty `<CalculatedMeasures
/>` and `<Dimensions />` collections that shipped platform files carry (e.g.
`ApplicationSuite/Foundation/AxAggregateMeasurement/AssetTransactionMeasure.xml`,
`PayrollBIWorkerMeasurement.xml` - both have them even when `<Dimensions>` or
`<Attributes>` is otherwise empty). The XML deserializer defaults the missing
collections with no observed build or BP consequence: the full build reported
0 errors and `run_bp_check` did not flag the omission on the measurement
object. This is analogous in kind to the `AxDataEntityView` `DeleteActions`/
`StateMachines` gap fixed for the two sibling goldens, but unlike that one it
has no observed effect here, so it is recorded as a candidate for a future
`standardStructure`-style opt-in rather than something this run needed to
force through.

## Symbol-index false positive (stale build cache, not a tool defect)

`prepare(mode="create")` reported a collision for all three new object names
(`ConDemoRequestFact`, `ConDemoRequestFactEntity`, `ConDemoRequestMeasure`)
before anything was created this session. Tracing it: `XppMetadata/Contoso/
AxTable/ConDemoRequestFact.xml` and `XppMetadata/Contoso/AxDataEntityView/
ConDemoRequestFactEntity.xml` were stale 234-byte build-cache placeholder
files left over from an earlier, rolled-back attempt at this same case - the
real AOT source folders (`Contoso/Contoso/AxTable`, `.../AxDataEntityView`)
held none of these objects before this run. `update_symbol_index` after each
`d365fo_file(create)` reported "Removed N stale entries / Inserted N symbols",
confirming the index self-corrected once the real object existed. This did
not block creation - it only required verifying the real source tree on disk
(`find ... XppMetadata`) rather than trusting the `prepare()` warning at face
value.

## Build / BP at capture (2026-08-03, SHA dffe0dc)

- FULL build (`fullBuild: true`): 0 errors, 1 unrelated warning (Commerce
  PricingEngine external assembly not found - pre-existing, unrelated to this
  case).
- BP, filtered per object (`run_bp_check` with an explicit `targetFilter` +
  `targetElementType` - the unfiltered call reports a false "BP Check passed"
  with zero elements processed, do not trust it):
  - `ConDemoRequestFact` (table): 5 warnings, 0 errors -
    `BPErrorTableFieldNotDefinedUsingType`, `BPErrorTablePrimaryKeyEditable`,
    `BPErrorLabelNotDefined`, `BPErrorDeveloperDocumentationNotDefined`,
    `BPErrorTableMissingFormRef` - all out of the case's declared scope (same
    pattern warnings every Demo table in this catalog carries).
  - `ConDemoRequestFactEntity` (DataEntityView): 0 warnings, 0 errors -
    "1 elements processed."
  - `ConDemoRequestMeasure` (AggregateMeasurement): 2 warnings, 0 errors -
    `BPMeasureGroupWithOnlyOneMeasure`, `BPUnrelatedMeasureGroup` - both
    inherent to the case's own scope (it explicitly asks for exactly one
    measure and one dimension attribute on one measure group).
  - `ConDemoRequestFactEntityMaintain` (privilege, companion): 1 warning
    (`BPErrorPrivilegeNotCoveredByDuty`), 0 errors.

The case's own gate is "zero BP errors" - satisfied on all four objects.
`bp_clean` in the corpus score is `0` because that dimension counts
warnings too; the residual warnings are the same out-of-scope, pre-existing
pattern warnings (table) and case-inherent-scope warnings (measurement) the
sibling frozen goldens in this catalog also carry, and this run is classified
`PASS` on the same convention.

## Descriptor

No package added. `TaxTransactionInquiry` (label file for
`@TaxTransactionInquiry:HeaderNote`) lives in Foundation, which
`Contoso.xml` already references (same label already used by other Demo
tables in this catalog).

## Corpus record

`eval/corpus/runs/2026-08-03T19__L3-aggregate-measurement-basic__dffe0dc.json`
