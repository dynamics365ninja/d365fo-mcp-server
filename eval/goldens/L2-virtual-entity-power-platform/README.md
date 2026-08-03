# Golden: L2-virtual-entity-power-platform — FROZEN

`golden_pending: false` since 2026-08-03. Every byte in this golden comes from
the grounded `d365fo_file` path; nothing here is hand-authored.

| Capture | Server SHA | Role |
|---|---|---|
| 2026-07-27 (draft) | `b28515f` | first attempt; AxDataEntityView writer omitted `SourceCode`/`FieldGroups`/`DeleteActions`/`StateMachines` |
| 2026-08-03 (freeze) | `6257ed4` | full grounded re-run with `properties.standardStructure: true`; golden byte-matched |

Platform xppc 7.0.7858.27, model `Contoso`, `EXTENSION_PREFIX=Con` -> object
names are `ConDemoVirtualSource` / `ConDemoVirtualSourceEntity`.

## The writer gap the draft found is fixed

The draft README recorded a TOOL_DEFECT: `d365fo_file(action="create",
objectType="data-entity", ...)` produced an `AxDataEntityView` missing
`<SourceCode>`, `<FieldGroups>` (incl. `AutoIdentification`),
`<DeleteActions/>` and `<StateMachines/>` — present in 3236/3236 (and, per the
current `dataEntityXml.ts` census, 5859/5859) shipped `AxDataEntityView`
files. The build was green anyway because the deserializer defaults the
missing elements, so the draft golden was kept unfrozen ("fix first, capture
second").

This is now fixed on server SHA `6257ed4` (`src/tools/dataEntityXml.ts`,
`buildAxDataEntityXml`): an opt-in `properties.standardStructure: true` (also
implied by passing `declaration`/`methods`/`fieldGroups`) emits the canonical
`<SourceCode>` (class declaration + `<Methods />`), the five standard
`<FieldGroups>` (`AutoReport`/`AutoLookup`/`AutoIdentification`/`AutoSummary`/
`AutoBrowse`), `<DeleteActions />` and `<StateMachines />`. Verified live: the
call

```
d365fo_file(action="create", objectType="data-entity", objectName="DemoVirtualSourceEntity",
  properties={ primaryTable: "ConDemoVirtualSource", fields: [...], primaryKeyField: "SourceCode",
    entityCategory: "Master", isPublic: true, publicEntityName: "ConDemoVirtualSource",
    publicCollectionName: "ConDemoVirtualSources", label: "@TaxTransactionInquiry:HeaderNote",
    standardStructure: true })
```

wrote `ConDemoVirtualSourceEntity.xml` with a full `<SourceCode>` block, all
five `<FieldGroups>`, `<DeleteActions />` and `<StateMachines />` — read back
from disk (`K:\AosService\PackagesLocalDirectory\Contoso\Contoso\AxDataEntityView\ConDemoVirtualSourceEntity.xml`)
and confirmed byte-for-byte, not just trusted from the tool's own success
message. This golden is the re-capture.

## Artifacts captured (the case's `target_artifact_types`)

- `ConDemoVirtualSource.metadata.xml` — `AxTable`, `TableGroup=Main`, label
  `@TaxTransactionInquiry:HeaderNote`, `SourceCode` (EDT `Num`, mandatory) +
  `Description` (EDT `Name`), unique alternate-key index `VirtualSourceIdx`
  (`AlternateKey=Yes`, no `AllowDuplicates` = unique), `ReplacementKey=VirtualSourceIdx`.
  Produced via `d365fo_file(action="create", objectType="table", ...)` +
  `operation="add-index"` (`indexAlternateKey`/`indexAllowDuplicates` are the
  correct parameter names — a first attempt with `alternateKey`/
  `allowDuplicates` was silently ignored by the bridge, see below) +
  `operation="modify-property"` for `ReplacementKey`.
- `ConDemoVirtualSourceEntity.metadata.xml` — `AxDataEntityView`,
  `IsPublic=Yes`, `PublicEntityName=ConDemoVirtualSource`,
  `PublicCollectionName=ConDemoVirtualSources`, `EntityCategory=Master`,
  `PrimaryKey=EntityKey` -> `AxDataEntityViewKey[EntityKey]` over `SourceCode`
  (natural key, **not** RecId), real `ViewMetadata` query over
  `ConDemoVirtualSource`, plus the standard-structure elements described above.

## Required companion NOT in this golden

`AxSecurityPrivilege ConDemoVirtualSourceEntityMaintain` (`DataEntityPermissions`
-> `ConDemoVirtualSourceEntity`, Grant CRUD = Allow, created via
`d365fo_file(action="create", objectType="security-privilege",
properties={ dataEntity: "ConDemoVirtualSourceEntity", accessLevel: "maintain" })`).
Without it xppbp raises the BP **error** `DataEntitySecurityPrivilegeCheck`,
which the case instruction forbids ("zero BP errors"). It is omitted here
only because `AxSecurityPrivilege` is not in the case's `target_artifact_types`;
a re-run must still create it.

## Minor tool friction found this run (not a scoring blocker)

`d365fo_file(action="modify", operation="add-index", params={alternateKey,
allowDuplicates})` accepted the call and reported success, but silently
dropped both parameters with an explicit warning naming the correct keys
(`indexAlternateKey`, `indexAllowDuplicates`) in the same response. The
warning was accurate and actionable, so this is not a defect — the tool told
the caller exactly what to fix — but the parameter-name mismatch itself
(`alternateKey` vs `indexAlternateKey`) is worth aligning with
`generate_object`'s own vocabulary (which uses bare `alternateKey`) to avoid
the extra round trip.

## Build / BP at capture (2026-08-03, SHA 6257ed4)

- FULL build (`fullBuild: true`): **0 errors**, 1 unrelated warning (Commerce
  PricingEngine external assembly not found — pre-existing, unrelated to this
  case).
- BP, filtered per object (`run_bp_check` with an explicit `targetFilter` +
  `targetElementType` — the unfiltered call reports a false "BP Check passed"
  with zero elements processed, do not trust it):
  - `ConDemoVirtualSource` (table): 2 warnings, 0 errors —
    `BPErrorDeveloperDocumentationNotDefined`, `BPErrorTableMissingFormRef` —
    both out of the case's declared scope (same pattern warnings every
    Demo table in this catalog carries).
  - `ConDemoVirtualSourceEntity` (DataEntityView): **0 warnings, 0 errors** —
    "1 elements processed."
  - `ConDemoVirtualSourceEntityMaintain` (privilege, companion): 1 warning
    (`BPErrorPrivilegeNotCoveredByDuty`), 0 errors.

The case's own gate is "zero BP **errors**" — satisfied. `bp_clean` in the
corpus score is `0` because that dimension counts *warnings* too; the residual
2 warnings on the table are the same out-of-scope, pre-existing pattern
warnings the frozen `L3-dmf-entity-import-slice` golden also carries, and
this run is classified `PASS` on the same convention.

## Descriptor

No package added. `TaxTransactionInquiry` (label file for
`@TaxTransactionInquiry:HeaderNote`) lives in **Foundation**, which `Contoso.xml`
already references (same label already used by other Demo tables in this
catalog).

## Corpus record

`eval/corpus/runs/2026-08-03T19__L2-virtual-entity-power-platform__6257ed4.json`
