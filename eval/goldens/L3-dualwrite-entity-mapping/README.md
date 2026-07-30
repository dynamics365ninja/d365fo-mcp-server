# Golden: L3-dualwrite-entity-mapping — FROZEN

`golden_pending: false` since 2026-07-30. Every byte comes from the grounded
`d365fo_file` path; nothing here is hand-authored. The 2026-07-29 draft was
blocked by three writer gaps, all now fixed and measured.

| Capture | Server SHA | Role |
|---|---|---|
| 2026-07-29 (draft) | `b4017cb` | first capture; entity change tracking hand-authored |
| 2026-07-30 07:36 | `1f842a6` | full grounded run, `Errors: 0`, 0 BP errors |
| 2026-07-30 (freeze) | `dataEntityXml` DataManagement fix | last residual diff closed |

Platform xppc 7.0.7858.27, model `Contoso`, `EXTENSION_PREFIX=Con`.

| Artifact | Role |
|---|---|
| `ConDemoSyncCustomer.metadata.xml` | AxTable, `TableGroup=Main`, `Label=@TaxTransactionInquiry:HeaderNote`, `CustomerCode` (EDT `Num`, mandatory) + `Name` (EDT `Name`), `ModifiedDateTime=Yes`, `AllowRowVersionChangeTracking=Yes`, unique alternate-key index `SyncCustomerIdx` (`AlternateKey=Yes`, `AllowDuplicates` omitted = unique) and `ReplacementKey=SyncCustomerIdx`. |
| `ConDemoSyncCustomerEntity.metadata.xml` | AxDataEntityView, `EntityCategory=Master`, `IsPublic=Yes`, `PublicEntityName=ConDemoSyncCustomer`, `PublicCollectionName=ConDemoSyncCustomers`, `AllowRowVersionChangeTracking=Yes`, `PrimaryKey=EntityKey` → `AxDataEntityViewKey[EntityKey]` over **`CustomerCode`, not RecId**, real `ViewMetadata` query over `ConDemoSyncCustomer`. |
| `ConDemoSyncCustomerEntityMaintain.metadata.xml` | AxSecurityPrivilege, `DataEntityPermissions` → the entity, Grant CRUD = Allow. |

## How each artifact is produced

- table — `d365fo_file(action="create")` for everything except the index, then
  `modify/add-index`. Property order out of `create` matches the golden exactly:
  `Label | TableGroup | TitleField1 | TitleField2 | AllowRowVersionChangeTracking |
  CacheLookup | ModifiedDateTime | ReplacementKey`.
- entity — `d365fo_file(action="create")` with `standardStructure: true`. Without
  that flag `create` omits `SourceCode`, `FieldGroups`, `DeleteActions` and
  `StateMachines`, present in 5859/5859 shipped entities.
- privilege — `d365fo_file(action="create")`.

`tests/tools/dataEntityXml.test.ts` asserts byte equality between
`buildAxDataEntityXml` and the entity golden, so writer drift breaks CI, not a
VM run.

## The privilege is in this golden on purpose

Without it xppbp raises the BP **error** `DataEntitySecurityPrivilegeCheck`, which
the case instruction ("zero BP errors") forbids. A golden that cannot pass its own
case gate is not a golden, so `target_artifact_types` names `AxSecurityPrivilege`.
(The siblings `L2-virtual-entity-power-platform` and `L3-dmf-entity-import-slice`
documented the same conflict but left the privilege out of their goldens.)

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

`get_knowledge(topic="dual-write")` now states the two-sided prerequisite (added in
`1e9ddb0`); before that an agent following the knowledge base alone could not
satisfy the instruction.

`EntityCategory=Master` is written explicitly even though `Master` is the enum's
default. Only the file-writer (`create`) path can express it: `modify-property
EntityCategory=Master` reports success but the bridge serializer omits the default,
so the element vanishes from the file the tool just claimed to update.

## No DataManagement elements

`<DataManagementEnabled>` and `<DataManagementStagingTable>` are absent. The writer
used to emit the `No` / empty default pair unconditionally, which was the sole
residual golden diff of the 2026-07-30 07:36 run. AOT census: **0 of 2662 shipped
`AxDataEntityView` files carry either default form** (1793 write `Yes` plus a named
staging table, 869 omit both — the two always travel together); reflection gives
`NoYes.No` and `""` as the metamodel defaults; and a bridge round-trip drops both.
The same reasoning already governed `IsPublic`. Fixed in `src/tools/dataEntityXml.ts`;
the sibling goldens `L4-entity-security` and `L2-virtual-entity-power-platform` were
updated to match.

## Negative proof that the green build is meaningful

Three independent probes, each a real `force + fullBuild` run:

1. Entity `AllowRowVersionChangeTracking=Yes` with the table property absent →
   `Errors: 1` (the metadata error quoted above). Adding it to the table → `Errors: 0`.
   Reproduced in the 2026-07-30 run after the writer fix, so the entity element is
   genuinely deserialized and enforced, not silently dropped.
2. The entity key's `<DataField>` pointed at `ZZZNoSuchEntityField` → `Errors: 2`:
   `Keys/EntityKey/Fields/ZZZNoSuchEntityField/DataField: Field 'ZZZNoSuchEntityField'
   does not exist` **plus** `PrimaryKey: The Primary Key must contain at least one
   public field, when the Is Public property is set to 'Yes'`.
3. Freshness: the 2026-07-30 build log and `Contoso/bin/*.md` were both rewritten at
   07:36:02 against a 2026-07-29 19:09:47 baseline — not a replayed log.

So `<Keys>`, `<Fields>` and the cross-object property are genuinely validated.
(Compare the sibling golden, where the writer's omissions stayed green precisely
because the deserializer defaults them.)

## Element verification in the compiled runtime metadata

`Contoso/bin/Contoso_AxDataEntityView.md` contains `public class
ConDemoSyncCustomerEntity extends common`, all five field groups, `EntityKey` twice
(key name + `PrimaryKey`), `ConDemoSyncCustomers`, `ConDemoSyncCustomer`.
`Contoso_AxTable.md` contains `SyncCustomerIdx` twice (index + `ReplacementKey`).
The natural key survived deserialization; RecId is not the key.

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

## Fixture

This case needs **no** fixture (`fixturesForCase("L3-dualwrite-entity-mapping")` is
empty) and creates none. `ConDemoNoteHeader` in the sandbox belongs to other cases.
