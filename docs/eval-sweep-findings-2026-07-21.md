# Defects found during the 2026-07-21 golden-capture sweep

Feed these to `eval-improve` after the capture queue drains.

## !! HEADLINE — two committed goldens enshrine defective output !!
The oracle is currently blessing wrong metadata, so these cases can never fail on the very
thing they should catch. Fix before trusting the corpus.

**(a) `eval/goldens/L4-entity-security/ConDemoNoteHeaderDuty|Role.metadata.xml`** encode the
security-reference shape emitted by the broken `create` path — `AxSecurityRolePermissionSet` /
`AxSecurityRoleDutyPermission` instead of `AxSecurityPrivilegeReference` /
`AxSecurityDutyReference`. xppbp proves the chain is dead in the golden shape
(`BPErrorDutyHasNoPrivileges`, `BPErrorPrivilegeNotCoveredByDuty`, `BPErrorDutyNotCoveredByRole`);
correcting the element names makes all three vanish. **Re-capture required.**

**(b) `eval/goldens/L1-form-detailsmaster`** carries the same missing `<DataSource>` sibling to
`<DataGroup>` that breaks a full build — and its own corpus record already has
`build.succeeded=false`. A golden that never built should not be a golden. **Re-capture required.**

Related measurement trap: only `fullBuild` runs metadata validation. An incremental build
reported 0 errors on a model with 2 real metadata errors — so any case scored on an incremental
build has a weaker `pass@build` than the number suggests.

## !! HEADLINE 2 — the grounded tool path cannot complete a composite case !!
`L4-master-security-slice` needed `create overwrite=true` **7 times** plus one manual on-disk
patch to produce 8 artifacts; `L3-workflow-document-submit` needed it 3 times. The loop's whole
premise is that the agent works through surgical grounded ops, and today essentially every
table-, form- and security-shaped object was produced by whole-file rewrite instead. The
`bp_clean`/`golden_match` numbers stay green while the thing being measured — the tool path —
is not what produced the output. Defects #8/#16/#23/#28/#29 are the cause; treat them as one
cluster, not as scattered papercuts.

## 1. Scorer crashes instead of diffing a missing artifact (TOOL_DEFECT, confirmed) — ✅ FIXED 2026-07-22
Fix: `normalizeAotXml` now guards the `null`/non-object parse result (empty/whitespace-only
document → `parseStringPromise` returns `null`) and returns an empty map, so a genuinely missing
artifact registers every path as `missing` instead of aborting the run. Held by two regression
tests in `tests/eval/oracle.test.ts` (a unit test on `normalizeAotXml('')`, and an integration
test feeding the exact empty-string shape `buildActualArtifactsMap` produces through
`normalizeMultiArtifact`). Merged to `main` via PR #730.

`src/eval/oracle/actualArtifactResolution.ts` sets `actualArtifacts[name] = ''` for a
golden artifact with no resolvable actual file, and its doc comment promises the empty
content registers every path as `missing`. It does not:
`xml2js.parseStringPromise('')` → `null`, so `normalizeAotXml`
(`src/eval/oracle/normalize.ts:299`) does `Object.entries(null)` and throws
`TypeError: Cannot convert undefined or null to object`.
Effect: a genuinely missing artifact aborts the whole score run instead of scoring as a
mismatch — i.e. the loudest possible failure mode is the one that reports nothing.
Reproduced directly. VM-free repro is straightforward.
Found by: L2-enum-extension-empty-values run.

## 2. Golden filename prefix drift (legacy goldens vs scorer defaults)
Legacy golden dirs name files unprefixed (`DemoEnumExtProbe.AxClass.metadata.xml`) while
the file *content* is `Con`-prefixed. Scorer defaults are
`goldenPrefix = GOLDEN_CAPTURE_PREFIX = "Contoso"` and `actualPrefix` from
`resolveRegularObjectPrefixToken()` (unset in a plain shell → also `Contoso`).
Scoring L2-enum-extension-empty-values only worked with explicit
`--golden-prefix Con --actual-prefix Con`; the defaults produced a false 3-path mismatch
(`golden="PFXDemoEnumExtProbe" actual="ConDemoEnumExtProbe"`).
Newer goldens (L3-custom-service-basic) use prefixed `Con<Name>.metadata.xml`.
Fix direction: normalise the legacy dirs, or make prefix resolution tolerant.
Found by: L2-enum-extension-empty-values run.

## 3. bp_clean is not comparable across the corpus (measurement integrity)
Older class goldens (e.g. `eval/goldens/L1-class-basic/DemoNoteFormatter.AxClass.metadata.xml`)
carry no class-level `///` doc header, yet their corpus records recorded `bp_clean: 1` —
i.e. those earlier runs most likely never actually ran `xppbp`. Newer runs do, and a
faithful reproduction of such a golden now scores `bp_clean: 0` on
`BPXmlDocNoDocumentationComments`.
So `bp_clean` mixes "BP-clean" with "BP never checked" and cannot be trended.
Found by: L3-custom-service-basic + L2-enum-extension-empty-values runs.

## 5. `add-relation` drops its own documented relation properties (TOOL_DEFECT, high) — ⏳ ADDRESSED by PR #731 (on-disk write with documented defaults; proper C# serialisation still open, see #35)
The op's own parameter spec documents `relationCardinality` (default ZeroMore),
`relatedTableCardinality` (default ExactlyOne) and `relationshipType` (default Association).
All three were passed explicitly; the op reported `✅ Relation 'CustTable' added` and emitted
only `Name`/`RelatedTable`/`Constraints`. xppbp then raises
`BPErrorTableRelationshipPropertiesCompleteness` naming exactly those three properties.
No repair path exists: `modify-property` rejects `Relations/CustTable/RelationshipType`
("Unknown AxTable property … Supported: label, developerDocumentation, tableGroup, …").
=> A BP-complete table relation is UNREACHABLE through the modify surface, even though
standard tables (e.g. CustInvoiceJour) carry those properties.
Fix area: bridge table-modify handlers — serialise the relation properties, applying the
documented defaults when omitted.
Found by: L2-table-modify-lifecycle run.

## 6. `modify-field` claims success on a call with no recognised mutation param (TOOL_DEFECT, high) — ✅ FIXED by PR #731 (root cause: Zod strips unknown keys; now rejected + near-miss suggestion `mandatory`→`fieldMandatory`)
`params: {fieldName: "Description", mandatory: true}` returned
`✅ Field 'Description' modified via IMetaTableProvider.Update` while writing nothing —
verified against all 15 auto-backups that `Description` never gained `<Mandatory>`.
The correct key is `fieldMandatory`, discoverable only by tripping the missing-required-param
error path. An unrecognised param should be rejected, or a no-op must not claim success.
Found by: L2-table-modify-lifecycle run.

## 7. `BPCheckAlternateKeyAbsent` raised at ERROR severity by validate_code (VALIDATOR_GAP, needs a second opinion)
`validate_code(syntax)` flags a missing alternate key as a hard ERROR (`XML001`), but xppbp
treats it as a warning and the build is clean. When a case legitimately mandates exactly one
index, the table cannot satisfy the rule at all — an error-severity rule that a valid,
building table cannot satisfy.
Found by: L2-table-modify-lifecycle run.

## 8. BLOCKING: `add-control` cannot address the form design root (TOOL_DEFECT, top priority) — ✅ FIXED & PROVEN 2026-07-22
Fixed by PR #728 (`FormAuthoringDefaults.IsDesignRootSentinel`, merged to `main` as `6e252c6`).
Proven effective on the VM: `add-control parentControl="Design"` on a zero-control design now
returns `✅ Control 'ProbeGroup' added to 'Design' via IMetaFormProvider.Update`. All 3 form cases
subsequently passed and `form-lifecycle` closed to core 43/43. NOTE the operational trap that hid
this for hours: a bridge rebuild silently keeps the OLD binary if (a) the fix was never pulled into
local `main`, or (b) a running `D365MetadataBridge.exe` holds `bin/Release/…exe` (MSB3027) — and
killing that process requires an MCP reconnect before the server serves the new binary.

Blocks `L2-form-modify-controls` AND `L3-form-add-datasource-lines`, i.e. the whole
`form-lifecycle` core coverage leaf.
`bridge/D365MetadataBridge/Services/MetadataWriteService.cs:2296` does
`var parent = FindControlRecursive(design, parentControl); if (parent == null) throw ...`,
and `FindControlRecursive` (:2901) only iterates `container.Controls` — it can never return
the design itself. A form whose design has no controls can therefore never receive its FIRST
top-level control; every `parentControl` value fails by construction ("Design", the form name,
before/after `update_symbol_index`, after a clean build — all identical).
NOTE: the older mined defect this case targeted (`AxFormControl{Type}` vs `AxForm{Type}Control`
type resolution) IS fixed — proven with a probe form; `add-control` into an EXISTING container
writes correct XML. This is an adjacent, still-open defect.
Fix: treat a design-root sentinel ("Design", empty, form name, null) as the design container
before recursing.
Found by: L2-form-modify-controls run.

## 9. `properties.dataSource` silently dropped on form create (TOOL_DEFECT) — ✅ FIXED by PR #728 (merged)
`d365fo_file(action=create, objectType=form, properties={dataSource:"…"})` emits
`<DataSources />` empty. Same silent-drop shape as #5. Workaround: `modify add-data-source`.
Found by: L2-form-modify-controls run.

## 10. Bridge-created forms never compile — no `classDeclaration` (TOOL_DEFECT) — ✅ FIXED by PR #728 (merged)
The `d365fo_file` form create path emits `<Methods xmlns="" />` with no `classDeclaration`;
xppc fails with "The 'classDeclaration' is missing from element '<Form>'".
`generate_object(mode=scaffold)` DOES emit one, so only the `d365fo_file` create path is
affected. `modify add-method` repairs it and the build then goes green.
Found by: L2-form-modify-controls run.

## 11. Diagnostics steer the agent into the forbidden workaround (TOOL_DEFECT, trust issue) — ✅ FIXED by PR #728 (merged; the escape hatch is now explicitly ruled out in a comment and the diagnostic explains the real same-session cause)
A genuine parent-control-not-found is misreported as "could not resolve form 'X' / the C#
metadata bridge could not find it in its metadata model" — factually wrong, the bridge had
already read the form. The attached "Reliable fallback" then recommends
`d365fo_file(action="create", overwrite=true, xmlContent=...)`, i.e. exactly the
hand-authored-XML escape hatch the mined case exists to prevent.
Fix: in `src/tools/modifyD365File.ts`, separate "form not found" from "parent control not
found", and never suggest `create overwrite=true` as a modify remedy.
Found by: L2-form-modify-controls run.

## 12. `validate_code(mode="references")` rejects the kernel enum `Exception` (VALIDATOR_GAP, top severity) — ✅ FIXED 2026-07-22
Fix: `exception` added to `KERNEL_TYPES` in `src/tools/resolveReferences.ts`, so `Exception::Error`
/ `Exception::DuplicateKeyException` verify via the kernel-enum allow-list (their values aren't
indexed, same as any kernel enum). Held by a regression test in `tests/tools/resolve-references.test.ts`
that exercises typed catches with NO Exception symbol in the index. Merged via PR #730.

`Exception::Error` and `Exception::DuplicateKeyException` both fail as `unknown-static-member`
("Static method not found on Exception"). Reproduced on a minimal 10-line probe.
`Exception` is a compiler/kernel enum with no AOT `AxEnum`, so **every idiomatic X++ try/catch
in the product fails the static gate**. Under `GROUNDING_ENFORCE=true` this blocks the write.
Fix direction: seed the kernel/compiler enums (Exception, and audit siblings) into the
reference resolver's known-symbol set.
Found by: L2-error-handling-infolog run.

## 13. AxTable XML is element-order-sensitive and silently drops misordered properties (TOOL_DEFECT + VALIDATOR_GAP, dangerous for goldens)
Writing `CacheLookup`/`DeveloperDocumentation` before `Label`, or `ReplacementKey` after
`PrimaryIndex`, makes xppbp report `BPErrorTableTitleField1NotDeclared`,
`BPErrorLabelNotDefined`, `BPErrorDeveloperDocumentationNotDefined` for properties that are
physically present in the file — while `validate_code(mode="syntax", codeType="xml-table")`
reports `✅ no violations` on the misordered document.
Required order (confirmed against `CustGroup.xml`): mandatory block
`ConfigurationKey, DeveloperDocumentation, FormRef, Label, TableGroup, TitleField1, TitleField2`,
then the alphabetical extended block `CacheLookup, ClusteredIndex, PrimaryIndex, ReplacementKey, …`.
Also: there is NO table-level `<AlternateKey>` property (index-level only), and the XML
validator does not flag that either.
Fix direction: emit in canonical order from the writer, and teach the xml-table validator both
the ordering rule and the non-existent-property check.
Found by: L2-error-handling-infolog run.

## 14. `get_object_info(objectType="edt", …)` is broken wholesale (TOOL_DEFECT, high)
`Num`, `Notes` and `CustAccount` all return "Bridge returned no data", while the same EDTs
resolve fine through `validate_code(references)` and appear in `search`. The tool actively
tells the agent that a valid standard EDT does not exist.
Found by: L2-error-handling-infolog run.

## 15. `search` does not rank exact matches first (TOOL_DEFECT, medium)
`search(type="edt", query="Num")` at `limit=40` never surfaces the EDT `Num` — only
`NumberOf*`/`Numeric*` prefix hits. Exact-name matches must rank first.
Found by: L2-error-handling-infolog run.

## 16. `d365fo_file(action="modify")` cannot touch same-session objects (TOOL_DEFECT, high)
`add-index` failed three times with "Bridge operation could not resolve table 'ConDemoTicket'"
— including after a successful `update_symbol_index(filePath)`, and after a bare refresh that
itself reported "Bridge provider not available (skipped)". `filePath` was supplied and ignored.
Forced the documented whole-file-overwrite fallback, i.e. straight into the escape hatch the
loop forbids.
Found by: L2-error-handling-infolog run. Related to #8's staleness family.

## 17. `validate_code(references)` rejects `NoYes::No` / `NoYes::Yes` (VALIDATOR_GAP, highest blast radius) — ✅ FIXED 2026-07-22
Same family as #12 (`Exception`), but `NoYes` is the single most common enum in X++ — this
fires on a large share of all cases. Fixed with #12: `noyes` added to `KERNEL_TYPES` in
`src/tools/resolveReferences.ts`. Held by a regression test that proves it against a deliberately
EMPTY index (the shared test fixture happens to seed NoYes, which would have masked the fix).
Merged via PR #730.
Found by: L3-workflow-document-submit run.

## 18. `validate_code(references)` arity check ignores default parameter values (VALIDATOR_GAP) — ✅ ALREADY FIXED (locked 2026-07-22)
`Workflow::activateFromWorkflowType` called with 4 args → `arity-mismatch` claiming 5 required.
The 5th parameter is `WorkflowUser _submittingUser = curUserId()`. NOT REPRODUCED against current
code: `parseSignatureArity` (`resolveReferences.ts`) already counts any param containing `=` as
optional (`min = params.length - optional`), and `splitTopLevel` keeps a function-call default's
own parens balanced — so the finding predates that logic. Locked with two regression tests in
`tests/tools/resolve-references.test.ts` for the exact function-call-default shape (`= curUserId()`):
a call omitting the defaulted arg passes, and a too-few-args call still flags. No code change.
Found by: L3-workflow-document-submit run.

## 19. `create objectType="table"` silently drops methods passed in `sourceCode` (TOOL_DEFECT, silent data loss)
Full `canSubmitToWorkflow` body passed in `sourceCode` → `✅` returned, `<Methods />` empty on
disk. Only caught by reading the file back.
Found by: L3-workflow-document-submit run.

## 20. `create objectType="query"` produces an unbuildable query (TOOL_DEFECT)
A data source with an empty field list is written without `<DynamicFields>Yes</DynamicFields>`;
xppc then rejects it: "The field list of the data source 'X' cannot be empty if the dynamic
field is set to false". So every "all fields" query from this tool fails the build.
Found by: L3-workflow-document-submit run.

## 21. `generate_object(mode="scaffold", objectType="table")` ignores `fields[]` (TOOL_DEFECT, three faults in one call)
(a) demands `fieldsHint` although `fields[]` was supplied, contradicting its own spec
    ("fields takes priority over fieldsHint");
(b) mines EDTs from field NAMES (`RequestId_NL`, `smmSubject` instead of the requested `Num`,
    `Name`) and drops enum fields entirely;
(c) WRITES THE FILE TO DISK although `scaffold` is documented as generation-only and its own
    output says "DO NOT call d365fo_file". `undo_last_modification` cannot clean that up
    (`PackagesLocalDirectory` is not a git repo) — manual `rm` required.
Found by: L3-workflow-document-submit run.

## 22. `create objectType="class"` corrupts declaration doc comments (TOOL_DEFECT, narrow but reproducible)
Text matching `The <c>X</c> class <word>` has `<word>` replaced by the class name:
`class is the workflow document` → `class ConDemoWfRequestDocument the workflow document`.
Looks like an over-eager template substitution on the declaration comment.
Found by: L3-workflow-document-submit run.

## 23. `filePath` does not bypass the bridge lookup (TOOL_DEFECT, refines #16)
`modify(add-index)` with an explicit `filePath` STILL failed with "could not resolve table
'ConDemoWfRequest'". `filePath` is documented as the bypass for the symbol-DB lookup, but it
does not bypass the bridge's own resolution. This is why every table-shaped case in the sweep
ended up in the `create overwrite=true` escape hatch (3× in this case alone).
Found by: L3-workflow-document-submit run.

## 24. `///` doc comments are load-bearing in class goldens (ORACLE fragility, corpus-wide)
`normalize.ts` canonicalises only indentation and CRLF for `Source`/`Declaration`; `///` XmlDoc
lines are diffed verbatim. Case instructions do not pin doc-comment wording, and `d365fo_file`
auto-injects a class-level comment. So a rerun by an agent that writes different doc comments
reports `golden_match: 0` for a purely cosmetic reason. Affects all class goldens (L1-class-basic
included).
Fix direction: strip `///` lines from X++ source before diffing, in the normalizer — better than
per-case `ignore` lists.
Found by: L2-multi-company-changecompany run.

## 25. `run_bp_check(targetFilter=…)` does not scope (TOOL_DEFECT, minor)
With `targetFilter=ConDemoCompanyReader, targetElementType=class` it still processed 2 elements
and returned only table warnings. Attribution has to be done by reading rule names.
Found by: L2-multi-company-changecompany run.

## 26. `overwrite=true` leaves `.backup-<timestamp>` residue in PackagesLocalDirectory (hygiene)
The table overwrite path writes `*.xml.backup-<ts>` next to the object even when `createBackup`
was not requested. Left alone it becomes sandbox residue for every overwrite-based case.
Found by: L2-performance-set-based run.

## 27. `add-index` param typing is wrong-shaped (TOOL_DEFECT, minor but guarantees a first-try failure) — ✅ FIXED by PR #731 (`coerceNoYesFlag()` + widened Zod)
`indexAllowDuplicates` is a Zod BOOLEAN, but the AxTable XML value is `No`/`Yes`, so callers
naturally pass the string and get `expected boolean`.
Found by: L2-performance-set-based run.

## 28. `create objectType="table"` cannot express a BP-clean table (TOOL_DEFECT, design gap)
No way to pass indexes, `DeveloperDocumentation`, `CacheLookup`, `AllowEdit` or field-group
membership via `properties`. Combined with #16/#23 (modify can't reach same-session objects),
a BP-clean table is unreachable except through the forbidden whole-file overwrite. This is the
single biggest friction source across the whole sweep.
Found by: L2-performance-set-based, L3-workflow-document-submit runs.

## 29. ALL bridge modify ops are dead for same-session objects (TOOL_DEFECT, the core cluster) — ⏳ PARTIAL 2026-07-22
Root cause confirmed VM-free from the code: modify handlers resolve BY NAME against a
startup-fixed DiskProvider (`MetadataWriteService.cs` `_provider.Tables.Read(name)`), so a
same-session object isn't in the model; `filePath` never reaches the bridge (only steers the
TS file lookup — #23). The real C# fix (reload same-session on-disk objects into the provider)
**cannot be validated in-repo** — the bridge needs the VM's `Microsoft.Dynamics.AX.Metadata`
assemblies to compile/run. It is a VM-side task. Repo-side mitigations landed instead:
`add-index` got a TS direct-XML fallback (`directXmlAddIndex`, **PR #729**), `add-control`
design-root + #11 diagnostic via **PR #728**. Still open: `add-field-group` / `modify-field`
deferred (element-order corruption risk #13 can't be verified VM-free).

`modify-field`, `add-field-group`, `add-index`, `add-control` all fail `could not resolve
<object>` — after `update_symbol_index(filePath)` and with an explicit `filePath`. Only the two
ops that have a direct-XML fallback worked (`modify-property`, `add-menu-item-to-menu`).
`update_symbol_index()` without filePath reports "Bridge provider not available (skipped)".
This generalises #16/#23: it is not one op, it is the whole bridge-backed modify surface.
Found by: L4-master-security-slice run.

## 30. `add-menu-item-to-menu` emits the wrong element (TOOL_DEFECT — and it is the `menu` leaf)
It writes `<AxMenuFunctionItem>`. Zero of the 73 standard `AxMenu` files use that name; all use
`<AxMenuElement xmlns="" i:type="AxMenuElementMenuItem">`.
Found by: L4-master-security-slice run.

## 31. `create` for security duty/role emits non-resolving references (TOOL_DEFECT)
Emits `AxSecurityRolePermissionSet` / `AxSecurityRoleDutyPermission` instead of
`AxSecurityPrivilegeReference` / `AxSecurityDutyReference`. Proven dead by xppbp
(`BPErrorDutyHasNoPrivileges`, `BPErrorPrivilegeNotCoveredByDuty`, `BPErrorDutyNotCoveredByRole`);
all three vanish once the element names are corrected. Privileges themselves
(`AxSecurityEntryPointReference`) are correct. See HEADLINE (a) — this shape is baked into a
committed golden.
Found by: L4-master-security-slice run.

## 32. Form scaffold produces a non-building design (TOOL_DEFECT)
`generate_object(mode=scaffold, objectType=form)` emits a group with `<DataGroup>Overview</DataGroup>`
and no sibling `<DataSource>`; a full build fails "Field group 'Overview' does not exist" (an
incremental build silently passes it). It also binds the DetailsMaster `TitleField` control to the
alphabetically-first field via an `AxFormStringControl`, ignoring `TitleField1`.
See HEADLINE (a)(b) — `eval/goldens/L1-form-detailsmaster` has the same flaw.
Found by: L4-master-security-slice run.

## 33. `labels` tool suggests a syntax xppbp rejects (TOOL_DEFECT)
It advertises `<Label>@SYS:@SYS12345</Label>`; xppbp responds
`BPErrorLabelIsText: '@SYS:@SYS67433' is not a label ID`. Correct form is `@SYS67433`.
It also returns labels from label files not deployed here
(`@EnterpriseAssetManagementAppSuite:*` → "Unknown label").
Found by: L4-master-security-slice run.

## 34. `update_symbol_index` / `security_info` mis-index (TOOL_DEFECT, minor)
`update_symbol_index` indexed `AxMenu` as `type=class, model=Unknown`.
`security_info(mode=artifact)` reports "Duties: none indexed" for a freshly indexed role — its
own index table is not fed by `update_symbol_index` — so it cannot serve as a verification
oracle; xppbp had to.
Found by: L4-master-security-slice run.

# Addendum — 2026-07-22 form-capture sweep (after #728 landed)

All 3 form cases PASSED via the grounded path with **no `create overwrite=true` escape hatch**;
`form-lifecycle` closed and `npm run eval:coverage` reports **core 43/43 (100%)**. #728 is proven
live AND effective: `add-control parentControl="Design"` on a zero-control design returned
`✅ Control 'ProbeGroup' added to 'Design' via IMetaFormProvider.Update`. #8 is therefore CLOSED.
`L3-form-add-datasource-lines` went from 58 `refers to table ''` build errors to **0**.

## 35. Modify ops SILENTLY DISCARD parameters (TOOL_DEFECT, top priority) — ⏳ ADDRESSED by PR #731

**⚠️ CORRECTION (2026-07-22): the original "ONE class of bug" framing below was WRONG.**
The #731 audit traced each op and found **three distinct bugs in three different layers** — and
one of the three symptoms was not a parameter drop at all. Corrected root causes:

| op | param(s) | actual root cause |
|---|---|---|
| `add-relation` (#5) | `relationshipType`, `relationCardinality`, `relatedTableCardinality` | TS-side drop **and** C# gap — `modifyD365File.ts` never forwards them, `bridgeClient.addRelation` has no such params, and `MetadataWriteService.AddRelation` (:1812) writes `Name`/`RelatedTable`/constraints only |
| `modify-field` (#6) | any misspelled key (e.g. `mandatory`) | **Zod strips unknown keys** — the value vanished before any code saw it, yet the op still answered `✅ … modified via IMetaTableProvider.Update` |
| `add-index` (#35) | `allowDuplicates` / `alternateKey` | **NOT a param drop and NOT a C# bug** — `AddIndex` (:1765) serialises both. The observed absence was an artefact of the same-session dead-end (#29) forcing the whole-file overwrite |
| `add-index` (#27) | `indexAllowDuplicates` | Zod `boolean` vs XML `No`/`Yes` |
| `add-data-source` | `linkType` | **C#-side only** — `CreateFormDataSourceRoot` (:1126) ignores it; the value reaches the signature and stops |
| `add-enum-value` | `enumValueHelpText` | **NEW finding from the audit** — advertised, forwarded by nobody, no bridge param |

The lead that motivated the audit (the adapter passing only `objectName`, per #23) **did not
reproduce** on current `main`: `bridgeAddIndex`/`bridgeAddDataSource` do forward their params today.

What PR #731 shipped: the op-spec registry became a parameter ledger (`findIgnoredParams()` with
near-miss suggestions, `OP_UNHONOURED_PARAMS` as an explicit confession list), `modifyD365File.ts`
now reads the **raw** arguments pre-Zod-strip and accounts for every key (`⚠️ … did not reach the
written XML`), rejects mutation calls carrying no mutation param, writes the three relation
properties on disk with their documented defaults, and coerces the index NoYes flags. It also
folded in the orphaned `e94835f` (`directXmlAddIndex` from PR #729), which had never reached `main`.

**Still open, honestly unverifiable in-repo** (the bridge cannot compile without the VM's
`Microsoft.Dynamics.AX.Metadata` assemblies): the proper C#-side fixes for `add-data-source`
`linkType` and `add-enum-value` `enumValueHelpText`, and the proper C# `add-relation` property
serialisation. Those got the loud-warning treatment only — no unverified C# behavioural change.

Consequence for scoring (unchanged): the residual `bp_clean: 0` on the three form cases is
**tool-gap blocked, not output quality**.

## 36. No operation exists for table DeleteActions (TOOL_DEFECT, coverage gap)
A cascading delete action is simply inexpressible through the tool surface.

## 37. `modify-property` gaps: rejects `FormRef` on tables, unimplemented for forms (TOOL_DEFECT)
`FormRef` is rejected on tables — which also makes `BPErrorTableMissingFormRef` (the residual
warning across many cases) unfixable through the tool path. For forms, `modify-property` is not
implemented at all.

## 38. `d365fo_file(create, objectType="view")` mis-defaults the field DataSource (TOOL_DEFECT)
Field `DataSource` defaults to the QUERY NAME instead of the query's root data source name.

## 39. `trigger_db_sync(syncViews:true)` passes table names in `-viewlist` (TOOL_DEFECT)
SyncEngine aborts.

## 40. `generate_object(scaffold, form, dataSource=<view>)` cannot bind a view (TOOL_DEFECT)
Fails `Table "ConDemoActiveView" not found in the symbol index`, and still fails after an explicit
reindex that reported the view as indexed — the form scaffold's lookup consults TABLES only.
`object_patterns` resolves the same view fine. This is `L2-form-over-view`'s named defect and it
**still reproduces**; the case passed only via its other permitted grounded leg
(`d365fo_file(create form, dataSource=<view>)`), which binds the view correctly.
Found by: L2-form-over-view run (2026-07-22).

## 41. #33 (labels) independently reproduced, both halves
`@SYS:@SYS71455` is rejected by xppbp (correct form is `@SYS71455`), and the tool suggests labels
from non-deployed label files (`@RevenueRecognition:ItemName` → `BPErrorUnknownLabel`).

## 4. Bridge silently falls back mid-session (flaky, not yet a defect)
`d365fo_file(action="modify", operation="replace-code")` on two DataContract classes
reported "direct XML fallback (bridge was unavailable)" while the same call on a third
class seconds later went through `Update`. No error surfaced; output was correct all
three times. Worth a watch — silent degradation of the write path.
Found by: L3-custom-service-basic run.
