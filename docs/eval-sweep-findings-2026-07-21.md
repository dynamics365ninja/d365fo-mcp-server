# Eval sweep — open defects

Findings from the 2026-07-21/22 golden-capture sweep. **Resolved items are deleted, not archived** —
git history is the record. Only open work lives here.

## VM-blocked (do NOT "fix" these in-repo)

The C# bridge cannot be compiled or run from this repo — it needs the VM's
`Microsoft.Dynamics.AX.Metadata` assemblies. Anything below is a VM-side task, and an unverifiable
C# edit is worse than an open ticket.

- **Same-session resolution root (#16/#23/#28/#29).** Bridge modify ops resolve the target BY NAME
  against a startup-fixed DiskProvider (`MetadataWriteService` `_provider.Tables.Read(name)`), so an
  object written this session is not in the model. `filePath` never reaches the bridge — it only
  steers the TS-side file lookup. Consequence: table-shaped composite cases still fall back to
  `create overwrite=true`, and a BP-clean table is unreachable through the modify surface.
  `add-index` and `add-control` have TS-side workarounds; `add-field-group`/`modify-field` do not.
- **C# halves of #35** — `add-data-source` `linkType` and `add-enum-value` `enumValueHelpText` are
  accepted but never serialised; `add-relation` properties are written on disk as a workaround
  rather than by the provider.
- **#14 residual** — the underlying `ReadEdt` behaviour. The tool is now honest about not knowing;
  why the bridge returns nothing is not diagnosable here.

## Needs a VM run

- **Two committed goldens enshrine defective output** and can never fail on what they exist to
  catch. `L4-entity-security` emits `AxSecurityRolePermissionSet`/`AxSecurityRoleDutyPermission`
  instead of `AxSecurityPrivilegeReference`/`AxSecurityDutyReference` (xppbp proves the chain is
  dead). `L1-form-detailsmaster` is missing the `<DataSource>` sibling and its own corpus record
  already has `build.succeeded=false`. **Re-capture both once the #31/#32 writer fixes land.**
- **#25 confirmation** — the `run_bp_check` scoping flags are fixed, but one VM run should confirm
  xppbp accepts the positional `<type>:<Name>` selector in practice.
- Only `fullBuild` runs metadata validation. An incremental build reported 0 errors on a model with
  2 real metadata errors, so `pass@build` from incremental runs is weaker than it looks.

## Open — validator

- **#7** — `validate_code(syntax)` raises `BPCheckAlternateKeyAbsent` as a hard ERROR (`XML001`)
  while xppbp treats it as a warning and the build is clean. A case that legitimately mandates one
  index cannot satisfy it at all: an error-severity rule a valid, building table cannot pass.

## Open — writers (in flight)

Being worked now; delete each as it lands.

- **#13** — AxTable XML is element-order-sensitive and misordered properties are SILENTLY dropped,
  while the xml-table validator reports no violations. Order (per `CustGroup.xml`): mandatory block
  `ConfigurationKey, DeveloperDocumentation, FormRef, Label, TableGroup, TitleField1, TitleField2`,
  then alphabetical `CacheLookup, ClusteredIndex, PrimaryIndex, ReplacementKey, …`. There is no
  table-level `<AlternateKey>` property (index-level only) and that is not flagged either.
- **#19** — `create objectType="table"` silently drops methods passed in `sourceCode`.
- **#20** — `create objectType="query"` omits `<DynamicFields>Yes</DynamicFields>` for an empty
  field list, so every "all fields" query fails the build.
- **#21** — `generate_object(scaffold, table)` demands `fieldsHint` despite `fields[]`, mines EDTs
  from field names, drops enum fields, and WRITES TO DISK despite being generation-only.
- **#22** — `create objectType="class"` corrupts declaration doc comments: `The <c>X</c> class <word>`
  has `<word>` replaced by the class name.
- **#26** — `overwrite=true` leaves `.backup-<timestamp>` residue even when `createBackup` was not asked for.
- **#30** — `add-menu-item-to-menu` emits `<AxMenuFunctionItem>`; all 73 standard `AxMenu` files use
  `<AxMenuElement i:type="AxMenuElementMenuItem">`.
- **#31** — security duty/role `create` emits non-resolving reference elements (see the golden
  re-capture above). Privileges (`AxSecurityEntryPointReference`) are already correct.
- **#32** — form scaffold emits `<DataGroup>Overview</DataGroup>` with no sibling `<DataSource>`
  (full build fails, incremental silently passes) and binds `TitleField` to the alphabetically-first
  field, ignoring `TitleField1`.
- **#36** — no operation exists for table DeleteActions, so a cascading delete action is inexpressible.
- **#37** — `modify-property` rejects `FormRef` on tables (making `BPErrorTableMissingFormRef`
  unfixable through the tool path) and is unimplemented for forms.
- **#38** — `create objectType="view"` defaults the field `DataSource` to the query name instead of
  the query's root data source.
- **#40** — `generate_object(scaffold, form, dataSource=<view>)` cannot bind a view: the scaffold's
  lookup consults tables only, even after a reindex reports the view indexed. `object_patterns`
  resolves it fine.

## Watch

- **#4** — the bridge silently fell back to direct-XML mid-session ("bridge was unavailable") on two
  calls while a third seconds later went through `Update`. No error surfaced and output was correct
  all three times. Silent degradation of the write path; not yet a proven defect.

## Recurring theme

Several of these were **the tool asserting a falsehood** rather than failing (#6, #14, #33, #34,
#35). Making the failure honest is a real fix and is provable in-repo even when the root cause is
not — prefer it over leaving a confident lie in place.
