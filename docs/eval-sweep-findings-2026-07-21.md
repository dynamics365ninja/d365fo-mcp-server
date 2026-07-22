# Eval sweep — open defects

Findings from the 2026-07-21/22 golden-capture sweep. **Resolved items are deleted, not archived** —
git history is the record. Only open work lives here.

## Working on the C# bridge

**The bridge builds and runs on this VM.** The old "VM-blocked, do NOT fix in-repo" heading meant
"from a machine without the D365FO assemblies" — on the dev VM `dotnet build -c Release` in
`bridge/D365MetadataBridge` takes ~3 s against `K:\AosService\PackagesLocalDirectory\bin`.

Two gotchas, both cost real time:
- `bin/Release/D365MetadataBridge.exe` is **locked by the running bridge child process**, so the
  build fails with MSB3027. Build to a scratch dir (`-p:OutputPath=K:/tmp/bridge-work/`) and drive
  that exe directly; the committed binary only needs replacing when the MCP server restarts.
- The bridge types `BridgeRequest.Id` as **string** — a numeric `id` is a parse error, not a
  mismatched response. And every read method has its own parameter name (`edtName`, not `name`).

## Needs a VM run

- **Two committed goldens enshrine defective output** and can never fail on what they exist to
  catch. `L4-entity-security` emits `AxSecurityRolePermissionSet`/`AxSecurityRoleDutyPermission`
  instead of `AxSecurityPrivilegeReference`/`AxSecurityDutyReference` (xppbp proves the chain is
  dead). `L1-form-detailsmaster` is missing the `<DataSource>` sibling and its own corpus record
  already has `build.succeeded=false`. **Re-capture both** — PR #735 has merged, so this is now
  only an eval-run task.

## Corrected attribution

- **"Same-session resolution root" (#16/#23/#28/#29) is stale.** The premise was that
  `MetadataWriteService` reads against a DiskProvider fixed at startup, so an object written this
  session is invisible. Probed on the VM against the live bridge: `createObject` runs through
  `HandleWrite(..., refreshAfterSuccess: true)`, which calls `MetadataReadService.RefreshProvider()`
  and pushes the new provider into the write service via `OnProviderRefreshed`. A table created and
  then modified in the same bridge session resolves — `add-field-group` **and** `modify-field` both
  succeed, including after a deliberately failed lookup of the name beforehand (no negative caching).
  What was really broken is below.
- **#14 is closed, and it was never `ReadEdt`.** `Num`, `Notes` and `CustAccount` — the exact three
  EDTs the finding named — all read correctly through the bridge and through
  `get_object_info(objectType="edt")`, sourced from `IMetadataProvider`. `RecId` reports "Object not
  found" because it is not an EDT. So "Bridge returned no data" was the bridge being **unreachable**
  at that moment, which makes **#4 (silent direct-XML fallback) the real open item**, not a read bug.
- **A modify that changed nothing reported success.** Found while probing the above: `modifyField`
  answered `success: true, api: IMetaTableProvider.Update` over a byte-identical file whenever its
  properties did not land — the wrong payload shape (flat instead of nested under `properties`, which
  is what the single-op dispatcher path requires), an unknown key, or a key that does not apply to
  that field type (`enumType` on a string field). `ModifyEnumValue` had the same hole. Both now refuse
  to report a write they did not make, and list what they support.
- **`enumValueHelpText` can never be honoured.** Not a pending C# task: an enum VALUE has no help
  text in the metamodel. Reflected on platform 7.0.7858.27, `AxEnumValue` exposes Name, Tags, Label,
  ConfigurationKey, Value, CountryRegionCodes, FeatureClass — no HelpText; only `AxEnum` has
  Help/HelpText, and real AOT enum XML agrees. `OP_UNHONOURED_PARAMS` now says so instead of
  promising a fix.
- **#25 confirmed on the VM.** xppbp documents `[elementtype]:(* or Name)` and accepts it positionally
  without `-all`: `xppbp -metadata=… -module=Contoso -model=Contoso -compilerMetadata=… table:ConDemoNoteHeader`
  reports `1 elements processed` and warnings for that table only. The usage text claims `-rules` is
  required when `-all` is omitted; in practice it defaults to `Enabled rules: *`.
- **Incremental builds are scope-limited by design, not by a missing flag.** xppc documents
  `-incremental` as "Compile only the elements that have been changed", so an unchanged element's
  metadata errors are never revisited — which is exactly how a run scored `pass@build` on a model
  that does not compile. There is no validation switch to turn on; the build result now says what a
  green incremental run did and did not cover.
- **The `-viewlist` finding was misdiagnosed.** It was filed as "tables and views are both put in
  `-viewlist`; they must be split by object type". Verified on the VM against SyncEngine 7.0.30743
  / platform 7.0.7858.27: **`-viewlist` is not a SyncEngine argument at all.** The parameter dump
  lists one `TableOrViewList` (fed by `-synclist`), plus `DropTableOrViewList`,
  `TableExtensionList`, `CompositeEntityList` and `ADEsList` — no view list of any kind. Passing it
  prints `Invalid argument -viewlist=<names> specified` and the run **continues** with those names
  dropped, so the requested view was never synced and nothing failed. The fix is one list, not two;
  splitting them would have reproduced the original bug in a tidier shape.
  Two things fell out of that VM run and are fixed alongside it: `trigger_db_sync` scored the
  outcome by grepping the whole log for `error|failed|exception`, and SyncEngine logs a benign
  startup warning (`Failed to abort paused PostServiceync resumable index … Invalid column name
  'DEFERREDOPERATIONSTATE'`) on **every** sync in this environment — so every green run was reported
  ❌. The verdict now comes from SyncEngine's own completion line, with a rejected argument and an
  explicit failure line as overrides.
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
