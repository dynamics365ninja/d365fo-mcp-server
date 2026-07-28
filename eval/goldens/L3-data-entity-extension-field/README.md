# Golden: L3-data-entity-extension-field — CAPTURED BUT `golden_pending` STAYS TRUE

Captured 2026-07-27 on the VM (xppc 7.0.7858.27). Build green, `run_bp_check` 0 errors
and 0 case-scope warnings for BOTH artifacts.

## Why `golden_pending` is NOT cleared — fix first, capture second

`CustTable.ConExtension.metadata.xml` is verbatim tool output
(`d365fo_file(action="create", objectType="table-extension")`, bridge
`IMetaTableExtensionProvider.Create`). It matches the standard AxTableExtension
vocabulary exactly (12/12 elements; 961/963 standard AxTableExtension files carry the
same six mandatory ones). Nothing pending here.

`CustCustomerV3Entity.ConExtension.metadata.xml` is the CORRECTED shape — **no grounded
tool path can produce it today**:

* `d365fo_file(action="create", objectType="data-entity-extension")` routes to
  `GenerateD365XmlTool.generateAxSimpleExtensionXml('AxDataEntityViewExtension', name)`
  (`src/tools/generateD365Xml.ts:1035`, `:1109`). That helper takes only `(rootElement, name)`
  — it **ignores `properties` entirely** and emits a 4-line stub:
  `<Name>` + `<PropertyModifications />`. The `fields` spec is dropped silently, with a
  success banner and `⛔ TASK COMPLETE`.
* `d365fo_file(action="modify", objectType="data-entity-extension", operation="add-field")`
  → `Operation 'add-field' on object type 'data-entity-extension' is not supported by the bridge.`

So the only route to a working entity extension is hand-written XML / `overwrite=true` —
the escape hatch the loop forbids. Refresh this golden (and drop `golden_pending`) once the
writer emits the mapped field.

## Ground truth the golden was checked against

Element census over all 396 `AxDataEntityViewExtension` files in
`K:\AosService\PackagesLocalDirectory`: `Name` 395/396, `FieldGroupExtensions` 395,
`Relations`/`PropertyModifications`/`Fields`/`DataSources` 394, `FieldGroups` 392,
`Mappings` 388, `FieldModifications` 368. The stub emits 2 of those 9; the golden emits all 9.
Reference file for the mapped-field shape:
`ApplicationSuite\Foundation\AxDataEntityViewExtension\BankAccountEntity.CH_QRBill_Extension.xml`
(`AxDataEntityViewField` with `i:type="AxDataEntityViewMappedField"`, Name/DataField/DataSource).

## The DataSource value, and the case's silent-failure premise

`<DataSource>CustTable</DataSource>` is the entity's ROOT data source **name**, read from
`ApplicationSuite\Foundation\AxDataEntityView\CustCustomerV3Entity.xml`:
`ViewMetadata/DataSources/AxQuerySimpleRootDataSource/Name = CustTable` (Table = CustTable).
It was NOT inferred from the entity name.

NEGATIVE TESTS (each a real xppc full build) show the case instruction's premise —
"a wrong DataSource value compiles but breaks at runtime" — is **FALSE on this build**:

* `DataSource=CustGroup` (real table, not a data source of this entity) →
  `Metadata Error: .../Fields/ConDemoLoyaltyCode/DataSource: Data source 'CustGroup' does not
  exist or is not part of the first root data source in the query.`
* `DataSource=DirPartyBaseEntity` (a REAL nested data source of this entity, wrong one) →
  `Metadata Error: .../Fields/ConDemoLoyaltyCode/DataField: Field 'ConDemoLoyaltyCode' does not
  exist on data source 'DirPartyBaseEntity'.`

Both flavours are compile-detected. The case text should be corrected.

## Descriptor prerequisite (not part of the golden)

Extending `CustCustomerV3Entity` forces xppc to validate the WHOLE merged entity inside the
sandbox model's reference closure. `Contoso\Descriptor\Contoso.xml` needed two ModuleReferences
added — `Dimensions` (owns `DimensionSetEntity`) and `PersonnelCore` (owns EDT
`HcmPersonnelNumberId`) — otherwise the build fails with 6 metadata errors attributed to
`AxDataEntityViewExtension/CustCustomerV3Entity.ConExtension/...` even though the extension
itself names neither type.
