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
  already has `build.succeeded=false`. **Re-capture both once PR #735 (the #31/#32 writer fixes) merges.**
- **#25 confirmation** — the `run_bp_check` scoping flags are fixed, but one VM run should confirm
  xppbp accepts the positional `<type>:<Name>` selector in practice.
- Only `fullBuild` runs metadata validation. An incremental build reported 0 errors on a model with
  2 real metadata errors, so `pass@build` from incremental runs is weaker than it looks.

## Open — validator

- **#7** — `validate_code(syntax)` raises `BPCheckAlternateKeyAbsent` as a hard ERROR (`XML001`)
  while xppbp treats it as a warning and the build is clean. A case that legitimately mandates one
  index cannot satisfy it at all: an error-severity rule a valid, building table cannot pass.

## Open — writers

- **#21** — `generate_object(scaffold, table)` demands `fieldsHint` despite `fields[]`, mines EDTs
  from field names, drops enum fields, and WRITES TO DISK despite being generation-only
  (`undo_last_modification` cannot clean that up — `PackagesLocalDirectory` is not a git repo).
- **#36** — no operation exists for table DeleteActions, so a cascading delete action is
  inexpressible.
- **#37 (forms half)** — `modify-property` is unimplemented for forms. The table half is done.

## Corrected attribution

- **#26 was misfiled** and is NOT overwrite hygiene. There is no backup writer on the
  create/overwrite path at all. The only `.backup-<ts>` writer is `createFileBackup`
  (`modifyD365File.ts`), reached from `ensureRecoverableModification`, which *deliberately* forces
  a backup when `createBackup=false` and the target is not in a git work tree —
  `PackagesLocalDirectory` never is, and `undo_last_modification` relies on `git checkout`. So the
  residue is modify's recoverability guarantee, not litter. Do not "clean it up" by removing the
  safety net; if the residue is genuinely unwanted, register the backup path in the
  created-artifact ledger instead.

## Watch

- **#4** — the bridge silently fell back to direct-XML mid-session ("bridge was unavailable") on two
  calls while a third seconds later went through `Update`. No error surfaced and output was correct
  all three times. Silent degradation of the write path; not yet a proven defect.

## Recurring theme

The most damaging defects in this sweep were **the tool asserting a falsehood** rather than
failing: claiming a standard EDT did not exist when the bridge was merely unreachable, returning
`✅ success` for a parameter that was silently discarded, scoring `bp_clean: 1` from absent
evidence, recommending a label syntax the compiler rejects. Each one sent the agent to "fix"
something that was already correct. Making the failure honest is a real fix in its own right, and
is provable in-repo even when the root cause is not — prefer it over leaving a confident lie.
