# Golden: L2-virtual-entity-power-platform — DRAFT, NOT FROZEN

The case is still `golden_pending: true`. This capture enshrines the
AxDataEntityView writer gap described at the bottom of this file, so it is kept
as a draft reference only — "fix first, capture second". Re-capture and flip
`golden_pending` off once the writer emits `SourceCode` / `FieldGroups` /
`DeleteActions` / `StateMachines`.

Captured 2026-07-27, server SHA b28515f, platform xppc 7.0 (VM), model `Contoso`,
`EXTENSION_PREFIX=Con` -> object names are `ConDemoVirtualSource` /
`ConDemoVirtualSourceEntity`.

Artifacts (the case's `target_artifact_types`):

- `ConDemoVirtualSource.metadata.xml` — AxTable, TableGroup Main, `SourceCode`
  (EDT Num, mandatory) + `Description` (EDT Name), unique alternate-key index
  `VirtualSourceIdx` (`AlternateKey=Yes`, no `AllowDuplicates` = unique) and
  `ReplacementKey=VirtualSourceIdx`.
- `ConDemoVirtualSourceEntity.metadata.xml` — AxDataEntityView, `IsPublic=Yes`,
  `PublicEntityName=ConDemoVirtualSource`, `PublicCollectionName=ConDemoVirtualSources`,
  `EntityCategory=Master`, `PrimaryKey=EntityKey` -> `AxDataEntityViewKey[EntityKey]`
  over `SourceCode` (natural key, **not** RecId), real `ViewMetadata` query over
  `ConDemoVirtualSource`.

## Required companion NOT in this golden

`AxSecurityPrivilege ConDemoVirtualSourceEntityMaintain` (DataEntityPermissions ->
`ConDemoVirtualSourceEntity`, Grant CRUD = Allow). Without it xppbp raises the BP
**error** `DataEntitySecurityPrivilegeCheck`, which the case instruction forbids.
It is omitted here only because `AxSecurityPrivilege` is not in the case's
`target_artifact_types`; a re-run must still create it.

## Known deviations from standard-model shape (writer gap, see corpus record)

The generated AxDataEntityView omits `<SourceCode>` (entity class declaration),
`<FieldGroups>` (incl. `AutoIdentification`), `<DeleteActions/>` and
`<StateMachines/>` — all present in 3236/3236 AxDataEntityView files in
ApplicationSuite/Foundation. The build is green because the deserializer defaults
them. **This golden must be refreshed once that writer gap is fixed.**

BP result at capture: 0 errors, 3 warnings attributable to this case
(`BPErrorPrivilegeNotCoveredByDuty`, `BPErrorDeveloperDocumentationNotDefined`,
`BPErrorTableMissingFormRef`) — all out of the case's declared scope.
