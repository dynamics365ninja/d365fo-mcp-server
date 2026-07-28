# Golden: L3-data-entity-extension-field — FROZEN

`golden_pending: false`. Re-captured 2026-07-28 on the VM (xppc 7.0.7858.27) after the
extension writer landed in PR #776. Full build: `Errors: 0`.

The previous draft was held back under **fix first, capture second**: the entity extension
had no grounded tool path at all, so the only way to produce it was hand-written XML.
That is no longer true — both artifacts below are now verbatim tool output.

## What changed since the draft

`CustCustomerV3Entity.ConExtension.metadata.xml` is now produced by
`d365fo_file(action="create", objectType="data-entity-extension", properties.fields=[…])`
and is **byte-identical to the hand-corrected shape the draft carried** (the only delta was
a stray UTF-8 BOM on the hand-written file; no shipped `AxDataEntityViewExtension`, and no
other file this tool writes, carries one).

Before PR #776 that call routed to `generateAxSimpleExtensionXml(rootElement, name)`, which
took no `properties` and emitted a 2-element stub (`Name` + `PropertyModifications`) behind a
success banner. `d365fo_file(action="modify", …, operation="add-field")` was not supported by
the bridge for this type, so there was no repair route either.

`CustTable.ConExtension.metadata.xml` is unchanged — it was already verbatim tool output.

## Grounding the DataSource value

`<DataSource>CustTable</DataSource>` is the entity's ROOT data-source **name**, read from
`ApplicationSuite\Foundation\AxDataEntityView\CustCustomerV3Entity.xml`:
`ViewMetadata/DataSources/AxQuerySimpleRootDataSource/Name = CustTable` (Table = `CustTable`).
It was not inferred from the entity name.

Reference for the mapped-field shape:
`ApplicationSuite\Foundation\AxDataEntityViewExtension\BankAccountEntity.CH_QRBill_Extension.xml`
(`AxDataEntityViewField` with `i:type="AxDataEntityViewMappedField"`, Name/DataField/DataSource).
Element census over all 396 `AxDataEntityViewExtension` files: `Name` 395/396,
`FieldGroupExtensions` 395, `Relations`/`PropertyModifications`/`Fields`/`DataSources` 394,
`FieldGroups` 392, `Mappings` 388, `FieldModifications` 368. The golden emits all 9.

## Oracle negative tests (this golden discriminates)

Both re-verified against the frozen golden:

| Injected shape | `eval:score` result |
|---|---|
| `DataSource` → `DirPartyBaseEntity` (a real but wrong data source) | `1 changed` — the `DataSource` path alone |
| the pre-fix 2-element stub | `4 missing` — `@type`, `Name`, `DataField`, `DataSource` of the mapped field |

## The case instruction's premise was wrong — corrected

The case used to say a wrong `DataSource` "compiles but breaks at runtime". On xppc
7.0.7858.27 it is a **hard compile error**, re-confirmed on this run with a real full build:

```
Metadata Error: AxDataEntityViewExtension/CustCustomerV3Entity.ConExtension/Fields/
                ConDemoLoyaltyCode/DataField:
                Field 'ConDemoLoyaltyCode' does not exist on data source 'DirPartyBaseEntity'.
Errors: 1
```

(The 2026-07-27 draft additionally recorded `DataSource=CustGroup` — a table that is not a
data source of this entity at all — failing with
`Data source 'CustGroup' does not exist or is not part of the first root data source in the query.`)
The instruction text has been corrected accordingly.

## BP coverage is genuinely partial — `bp_clean: null`, not 0

`run_bp_check` was run per object with an explicit `targetFilter`:

| Target | Element type | Result |
|---|---|---|
| `CustTable.ConExtension` | `tableextension` | 0 warnings, 0 errors |
| `CustCustomerV3Entity.ConExtension` | `dataentityviewextension` | **not checkable** |

xppbp has no `DataEntityViewExtension` element type. Its supported list is Class, Table, Form,
View, Enum, ExtendedDataType, Menu, ConfigurationKey, LicenseCode, Macro, Map, Query, Service,
ServiceGroup, MenuItem{Display,Action,Output}, SecurityPrivilege, Infopart, IgnoreList, Report,
AggregateDimension, AggregateMeasurement, SecurityRole, DataEntityView, AggregateDataEntity,
SecurityDuty, CompositeDataEntityView, **TableExtension, FormExtension, MenuExtension** — entity
view extensions are absent. Targeting the merged base entity instead
(`DataEntityView:CustCustomerV3Entity`) also fails: xppbp runs scoped to the sandbox model and
the base entity lives in `Foundation` (`DataEntityView 'CustCustomerV3Entity' not found`).

Since the artifact under test is precisely the one xppbp cannot see, the corpus record carries
`bp_clean: null` (BP not checked) rather than a `0` that would mint a false clean for the case
as a whole.

**Tool defect found while measuring this:** `run_bp_check` with an unsupported
`targetElementType` returns the banner `✅ BP Check passed` with `Warnings: 0 / Errors: 0`,
while the body of the same response says `The element type 'dataentityviewextension' is
invalid.` Nothing was checked. This is the same false-clean class as the already-documented
filterless `run_bp_check`.

## Other observation

`d365fo_file(action="create")` auto-applies `EXTENSION_PREFIX` to **objectName only**, never to
`properties.fields[].name`. Passing `DemoLoyaltyCode` yields `CustTable.ConExtension` (prefixed)
containing an **unprefixed** field `DemoLoyaltyCode` — which in a real model is a cross-model
collision risk, since extension fields must be prefixed. The caller has to hand-build the field
prefix (`ConDemoLoyaltyCode`) even though the tool documents "NEVER hand-build the prefix" for
object names.

## Descriptor prerequisite (not part of the golden)

Extending `CustCustomerV3Entity` forces xppc to validate the WHOLE merged entity inside the
sandbox model's reference closure. `Contoso\Descriptor\Contoso.xml` needs the ModuleReferences
`Dimensions` (owns `DimensionSetEntity`) and `PersonnelCore` (owns EDT `HcmPersonnelNumberId`);
without them the build fails with 6 metadata errors attributed to this extension even though it
names neither type. Both were already present for this run.
