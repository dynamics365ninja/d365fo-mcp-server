# Golden: L3-dualwrite-entity-mapping — DRAFT, NOT FROZEN

The case stays `golden_pending: true`. Two of the three artifacts had to be
finished by **hand-authored XML** because no tool path can express the case's
central requirement (entity change tracking). Freezing now would bake a writer
gap into the reference. Re-capture and flip `golden_pending` off once
`AllowRowVersionChangeTracking` is settable through `d365fo_file` on both
`AxDataEntityView` and `AxTable`.

Captured 2026-07-29, server SHA `b4017cb`, xppc 7.0.7858.27, model `Contoso`,
`EXTENSION_PREFIX=Con`.

| Artifact | Role |
|---|---|
| `ConDemoSyncCustomer.metadata.xml` | AxTable, `TableGroup=Main`, `Label=@TaxTransactionInquiry:HeaderNote`, `CustomerCode` (EDT `Num`, mandatory) + `Name` (EDT `Name`), `ModifiedDateTime=Yes`, `AllowRowVersionChangeTracking=Yes`, unique alternate-key index `SyncCustomerIdx` (`AlternateKey=Yes`, `AllowDuplicates` omitted = unique) and `ReplacementKey=SyncCustomerIdx`. |
| `ConDemoSyncCustomerEntity.metadata.xml` | AxDataEntityView, `EntityCategory=Master`, `IsPublic=Yes`, `PublicEntityName=ConDemoSyncCustomer`, `PublicCollectionName=ConDemoSyncCustomers`, `AllowRowVersionChangeTracking=Yes`, `PrimaryKey=EntityKey` → `AxDataEntityViewKey[EntityKey]` over **`CustomerCode`, not RecId**, real `ViewMetadata` query over `ConDemoSyncCustomer`. |
| `ConDemoSyncCustomerEntityMaintain.metadata.xml` | AxSecurityPrivilege, `DataEntityPermissions` → the entity, Grant CRUD = Allow. |

## The privilege is in this golden on purpose

`AxSecurityPrivilege` is **not** in the case's `target_artifact_types`, but without
it xppbp raises the BP **error** `DataEntitySecurityPrivilegeCheck`, which the case
instruction ("zero BP errors") forbids. A golden that cannot pass its own case gate
is not a golden. `target_artifact_types` should gain `AxSecurityPrivilege`.
(The sibling case `L2-virtual-entity-power-platform` omitted it and documented the
same conflict.)

## Change tracking: the property, and the cross-object rule

`ChangeTrackingEnabled` — which 22 shipped files still carry — **does not exist** on
`AxDataEntityView` in this platform. Reflection over
`Microsoft.Dynamics.AX.Metadata.dll`,
`Microsoft.Dynamics.AX.Metadata.MetaModel.AxDataEntityView`, lists
`AllowRowVersionChangeTracking : NoYes` and no `ChangeTrackingEnabled`; the
deserializer drops the legacy element silently. 1484 shipped entities set
`<AllowRowVersionChangeTracking>Yes</AllowRowVersionChangeTracking>` and none set
`No`.

The non-obvious part, and the reason this case is tier 3: **the entity property is
rejected unless the source table carries it too.** Enabling it only on the entity
fails the full build with

```
Metadata Error: AxDataEntityView/ConDemoSyncCustomerEntity/DataSources/ConDemoSyncCustomer/AllowRowVersionChangeTracking:
Change tracking cannot be enabled since the Allow Row Version Change Tracking property
is not set to Yes for the table 'ConDemoSyncCustomer' in the F&O entity ConDemoSyncCustomerEntity.
```

`get_knowledge(topic="dual-write")` does not mention `AllowRowVersionChangeTracking`
at all — it only advises `DataManagementEnabled=Yes, IsPublic=Yes,
PublicEntityName/CollectionName`. An agent following the knowledge base alone cannot
satisfy the instruction.

`EntityCategory=Master` is written explicitly even though `Master` is the enum's
default (hence 0 occurrences in 5900 shipped files, while Reference/Document/
Transaction/Parameters/Configuration all appear). The value is what the case pins.

## Negative proof that the green build is meaningful

Two independent probes, each a real `force + fullBuild` run:

1. Entity `AllowRowVersionChangeTracking=Yes` with the table property absent →
   `Errors: 1` (the metadata error quoted above). Adding it to the table → `Errors: 0`.
2. The entity key's `<DataField>` pointed at `ZZZNoSuchEntityField` → `Errors: 2`:
   `Keys/EntityKey/Fields/ZZZNoSuchEntityField/DataField: Field 'ZZZNoSuchEntityField'
   does not exist` **plus** `PrimaryKey: The Primary Key must contain at least one
   public field, when the Is Public property is set to 'Yes'`.

So `<Keys>`, `<Fields>` and the cross-object property are genuinely deserialized and
validated — the clean build on the real artifacts is evidence, not silence. (Compare
the sibling golden, where the writer's omissions stayed green precisely because the
deserializer defaults them.)

## Element verification in the compiled runtime metadata

`Contoso/bin/Contoso_AxDataEntityView.md` (regenerated 12:44:28, after the last
source write at 12:44:09) contains `public class ConDemoSyncCustomerEntity extends
common`, all five field groups, `EntityKey` twice (key name + `PrimaryKey`),
`ConDemoSyncCustomers`, `ConDemoSyncCustomer`. `Contoso_AxTable.md` contains
`SyncCustomerIdx` twice (index + `ReplacementKey`). The natural key survived
deserialization; RecId is not the key.

## Accepted BP warnings (`bp_clean: 0`, **0 BP errors**)

Measured per element with a supported `targetElementType` and a confirmed
`1 elements processed.` line in every run:

- entity (`DataEntityView`): **0 warnings, 0 errors**
- table (`Table`): `BPErrorDeveloperDocumentationNotDefined`, `BPErrorTableMissingFormRef`
  — no form is in scope for this case, and `DeveloperDocumentation` would need a
  fresh label
- privilege (`SecurityPrivilege`): `BPErrorPrivilegeNotCoveredByDuty` — no duty/role
  is in scope

The case's own gate is zero BP *errors*, which is met exactly.

## Hand-authored portions (the reason this is DRAFT)

- Entity `<SourceCode>`, `<FieldGroups>`, `<DeleteActions/>`, `<StateMachines/>` —
  the create writer omits all four (present in 5900/5900, 5899/5900, 5899/5900,
  5899/5900 shipped `AxDataEntityView` files respectively).
- Entity `<AllowRowVersionChangeTracking>` — passed to
  `d365fo_file(action="create")` in `properties` and **silently discarded**, with no
  warning. Every `action="modify"` operation on `objectType="data-entity"` is
  rejected by the bridge (`modify-property`, `add-field-group`, `add-method` all
  tested).
- Table `<AllowRowVersionChangeTracking>` — `modify-property` rejects it against a
  hardcoded 16-property allowlist, although `AxTable.AllowRowVersionChangeTracking`
  exists in the metamodel.

Everything else came through the grounded path: table via `action="create"`, index
via `modify/add-index` (after `remove-index`, see the corpus record), `ModifiedDateTime`
and `ReplacementKey` via `modify-property`, entity and privilege via `action="create"`.

## Fixture

This case needs **no** fixture (`fixturesForCase("L3-dualwrite-entity-mapping")` is
empty) and creates none. `ConDemoNoteHeader` in the sandbox belongs to other cases.
