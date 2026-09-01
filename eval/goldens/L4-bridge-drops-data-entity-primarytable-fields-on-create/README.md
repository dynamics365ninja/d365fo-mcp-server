# Golden: L4-bridge-drops-data-entity-primarytable-fields-on-create — CAPTURED, PENDING HUMAN REVIEW (§6.4)

Captured 2026-08-31, server SHA `278eee3`, xppc 7.0.7996.33 (VM), sandbox model
`fm-mcp`, effective prefix `ConDemo`. Produced by **one**
`d365fo_file(action="create", objectType="data-entity")` call — no
`overwrite=true` rewrite, no `modify`, no hand-edited XML — then full-built with
xppc (0 errors, 0 warnings), best-practice-checked with xppbp, and DB-synced
(SyncEngine actually created the SQL view). The capture script refuses to copy a
golden out of a build that was not clean, or out of a source file whose mtime is
newer than its compiled `XppMetadata` artifact. Sandbox rolled back afterwards;
the backing table is a harness fixture and was kept (§4a).

## Artifacts

_one public data entity over the committed fixture table `ConDemoNoteHeader`_

`ConDemoNoteHeaderProbeEntity.metadata.xml`

| | What it has to keep showing |
|---|---|
| `<Fields>` | **two** `AxDataEntityViewField` / `i:type="AxDataEntityViewMappedField"` entries — `NoteId`, `Subject` — each with `<DataSource>ConDemoNoteHeader</DataSource>`. **Never `<Fields />`.** This is the whole point of the case |
| `<ViewMetadata><DataSources>` | an `AxQuerySimpleRootDataSource` whose `<Name>` **and** `<Table>` are `ConDemoNoteHeader`, carrying both `AxQuerySimpleDataSourceField`s. **Never `<ViewMetadata />`** |
| `<Keys>` | `EntityKey` over `NoteId` — from `primaryKeyFields`; the empty-skeleton branch cannot produce it either |
| `<DataManagementEnabled>` / `<DataManagementStagingTable>` | **both ABSENT** — the 2026-07-07 regression emitted `Yes` + `<Name>Staging` for a staging table nothing creates, and every generated entity then failed its next build with "Table '…Staging' does not exist" |
| `<Label>` | `@TaxTransactionInquiry:HeaderNote` — a real `@Ref`, reused from the backing table. Supplied explicitly, because `label` defaults to the **entity name as raw text**, which trips `BPErrorLabelIsText` |
| `<IsPublic>` + the two public names | present — the instruction asks for a *public* entity |
| element order | `Name, Label, EntityCategory, IsPublic, PrimaryKey, PublicCollectionName, PublicEntityName, Fields, Keys, Mappings, Ranges, Relations, ViewMetadata` — the platform deserializer silently DROPS mis-ordered elements, so a green build proves nothing about this row |

## Notes from the capture

**The mined defect does not reproduce.** This case was mined from a 2026-06-30
`TOOL_DEFECT` in which the data-entity create path silently dropped
`properties.primaryTable` and `properties.fields` and wrote an entity with
`<Fields />` and no `ViewMetadata` query — which compiled, synced and returned
nothing, so neither xppc nor xppbp ever flagged it. On `278eee3` both properties
are honoured; the golden above is the proof, read back off disk rather than
inferred from a green build.

**A negative control was run in the same session, deliberately.** The same
`create` with `primaryTable` and `fields` omitted is now *refused* by
`assertDataEntityIsFunctional` — "missing primaryTable and fields — nothing was
written" — and no file appears on disk. The silent-empty-entity failure mode is
unreachable, not merely unobserved this time.

**Runtime corroboration beyond the metadata.** `SyncEngine` built the SQL view
from this metadata; an earlier identical run logged the DDL verbatim —
`CREATE VIEW [DBO].[CONDEMONOTEHEADERENTITY] AS SELECT T1.NOTEID, T1.SUBJECT …
FROM CONDEMONOTEHEADER T1` — which an entity with no data source cannot produce.

**Why `ConDemoNoteHeader` and not a standard table.** It lives in the same model
as the entity (no Descriptor package reference can confound the build), it is
repo-committed and byte-stable (`eval/fixtures/ConDemoNoteHeader.metadata.xml`),
and it is fixture-excluded from rollback — so the case writes exactly the one
`AxDataEntityView` file its `target_artifact_types` declares.

**Why the odd name.** The obvious `ConDemoNoteHeaderEntity` is already owned by
`L4-entity-security` (artifact 1 of its 5). `tests/eval/goldenNameCollision.test.ts`
caught the clash after the first capture and the artifact was renamed to
`ConDemoNoteHeaderProbeEntity` and re-created through the same path.
`prepare(mode="create")` had said "No collision" — correctly, since it consults
the live sandbox index, which the previous rollback had emptied. That is exactly
the blind spot the collision test exists to cover. For the record, the first
capture was byte-identical to `L4-entity-security`'s independently captured
2026-07-23 golden apart from the name and the two explicitly-passed public names.

**`bp_clean` is 0 by construction, and that is not a defect.** xppbp raises
`DataEntitySecurityPrivilegeCheck` (severity **Error**) for *any* data entity not
covered by an `AxSecurityPrivilege`, and this case may write only one artifact
file. The other six BP warnings are all on the fixture table and are present in
the post-rollback baseline build too. Scoring this case `bp_clean: 1` would
require widening it into the entity+privilege chain `L4-entity-security` covers.
