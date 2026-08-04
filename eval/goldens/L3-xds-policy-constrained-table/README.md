# Golden: L3-xds-policy-constrained-table - FROZEN

`golden_pending: false` since 2026-08-04. Every byte comes from the grounded
`d365fo_file` path; nothing here is hand-authored.

| Capture | Server SHA | Role |
|---|---|---|
| 2026-08-04 (first capture) | `dffe0dc` | first-time run, no prior draft for this case; full grounded run, `Errors: 0`, offline BP validator clean on both tables, golden captured from this run's own verified output |

Platform xppc 7.0.7858.27, model `Contoso`, `EXTENSION_PREFIX=Con` -> object
names are `ConDemoTerritory` / `ConDemoTerritoryLine` /
`ConDemoTerritoryPolicyQuery` / `ConDemoTerritoryPolicy`.

## Ground truth consulted first

Per the case instruction, `get_knowledge(topic="security")` was called
before implementing. Its rulebook is a one-paragraph conceptual overview
("XDS (Extensible Data Security): row-level security policies
(AxSecurityPolicy) that filter records via a constrained query + policy
context") - it names the artifact type but not the concrete XML shape or
the "current user" range idiom, so both were confirmed from the real,
shipped AxSecurityPolicy/AxQuery XML on disk before anything was
written (the symbol-index `search` tool returns NO hits at all for
`AxSecurityPolicy`, "XDS security policy example", or
"ConstrainedTable security policy" - security policies are not indexed as
code symbols in this project's SQLite/bridge index, so this case's ground
truth had to come from reading real XML files directly, not from
`search`):

- AxSecurityPolicy shape - read three real Microsoft policies under
  ApplicationSuite\Foundation\AxSecurityPolicy\:
  XDSCustTableOnCustGroup10Policy.xml (Name, ConstrainedTable,
  PrimaryTable, Query, an empty ConstrainedTables),
  VendProfileAccount.xml (a policy with a populated
  ConstrainedTables collection - confirmed the real element name is
  AxSecurityPolicyConstrainedEntity with xmlns="" and
  i:type="AxSecurityPolicyConstrainedTable", carrying Constrained,
  Name (the constrained table's own name), an empty nested
  ConstrainedTables, and TableRelation (the name of the relation on
  the constrained table that points back to the primary table - confirmed
  by cross-referencing VendProfileAccount's
  PurchAgreementHeaderDefault entry, TableRelation=VendInvoiceAccount,
  against that table's own relation names)), and RetailPurchTable.xml
  (a minimal policy: ConstrainedTable, ContextType, PrimaryTable,
  Query, RoleName, empty ConstrainedTables). get_object_info
  (objectType: "security-policy") on XDSCustTableOnCustGroup10Policy
  cross-confirmed the same core properties from the bridge's own reader,
  independent of the raw-XML read.
- Enabled is a real, optional AxSecurityPolicy property -
  confirmed by grepping every AxSecurityPolicy file in
  ApplicationSuite\Foundation\ and ApplicationFoundation\
  ApplicationFoundation\ for a literal <Enabled> tag: seven policies
  (HcmWorkerLegalEntityConstraints, NumberSequenceLegalEntity,
  RetailSalesOrder, both dirrestrictviewpartyin... policies,
  EventInbox) carry <Enabled>No</Enabled> explicitly; policies that
  omit the tag build and run as active policies (e.g. RetailPurchTable,
  XDSCustTableOnCustGroup10Policy), so the property defaults to enabled
  when absent and <Enabled>Yes</Enabled> is a legal, if redundant,
  explicit statement of that default - written here because the case asks
  for it literally.
- The "current user" range idiom - found by reading the query behind
  WorkflowApprovalWorkItemAssignedToMePolicy (a real, shipped "assigned
  to me" XDS policy): its query WorkflowApprovalWorkItemAssignedToMe.xml
  has a UserId range with <Value>(currentUserId())</Value> (a
  SysQueryRangeUtil/AxaptaUserManager global function reference
  used as a query-range literal, matching the query-range-value
  convention, not a class method call). The same literal
  (currentUserId()) also appears (multiple times, in nested
  DirPersonUser data sources) in RetailXDSPurchTable.xml, the query
  behind the real RetailPurchTable XDS policy, on a User range field
  of EDT-UserId-compatible type - two independent real precedents, not
  one. search(query="curUserId") and search(query="curUserId(") were
  tried first and only surfaced EMWebApplicationHelper.curUserId() (an
  unrelated instance method, not a global function usable in a query range
  literal) - confirming curUserId() was the WRONG idiom to guess, and
  currentUserId() (SysQueryRangeUtil::currentUserId() /
  AxaptaUserManager::currentUserId(), both str currentUserId()) is the
  real one, found only by reading a real query, not by symbol search.
- EDT UserId - the case asks for field OwnerUserId (EDT UserId).
  search(type="edt", query="UserId") and get_object_info(objectType:
  "edt", name: "UserId") both return NO data for the bare name
  UserId (neither the bridge nor the SQLite index resolves it directly -
  base/primitive EDTs are apparently under-indexed in this project's
  tooling). Existence was confirmed a different way:
  get_object_info(objectType: "edt", name: "SysUserId") reports
  Base Type: String (Extends: UserId) - i.e. a real, indexed EDT
  (SysUserId, model ApplicationPlatform) explicitly extends UserId,
  proving the base EDT exists in ApplicationPlatform even though it is
  not itself directly resolvable through search/get_object_info. This
  is flagged below as a tool-index gap, not treated as "the EDT doesn't
  exist" (the "an honest failure beats a confident lie" bias cuts both
  ways - absence of a search hit is not proof of absence for a
  system-level EDT).
- EDTs Num and LineNum - both confirmed directly via
  get_object_info(objectType: "edt", ...): Num (Base Type String,
  size 20, model ApplicationPlatform) and LineNum (Base Type Real,
  model ApplicationPlatform) - both already covered by Contoso's
  existing ApplicationPlatform ModuleReferences entry, so no
  Descriptor change was needed for this case (see below).

## What was explicitly rejected as NOT satisfying the case

suggest_edt(fieldName: "OwnerUserId", ...) returned RefRecId as its
top (0.85-confidence) suggestion, purely from the "ends with Id" heuristic
- this was rejected because the case's own instruction is explicit
("OwnerUserId (EDT UserId)") and the real EDT's existence was
independently confirmed via the SysUserId extends UserId relation above;
following the fuzzy suggester over the case's literal, verified
instruction would have produced a RecId-typed field that cannot hold a
(currentUserId()) string comparison.

A ContextType/RoleName pair (present on several real policies read
above, e.g. RetailPurchTable, XDSCustTableOnCustGroup10Policy) was
deliberately NOT added: the case's instruction lists exactly
PrimaryTable, Query, ConstrainedTable=Yes, Enabled=Yes and one
constrained-table entry, with no role/context scoping requested, and
several real policies (RetailPurchTable itself has ContextType, but
PayrollEssPayStatementPolicy and WorkflowApprovalWorkItemAssignedToMePolicy
have none) confirm ContextType/RoleName are optional, not a required
part of the shape.

## Artifacts captured (the case's target_artifact_types)

Both tables are scored under the single AxTable target_artifact_type
(the oracle's --actual-dir mode scores every *.metadata.xml golden
file present by filename, independent of how many share a
target_artifact_types entry - confirmed against the sibling
multi-table captures L3-dmf-entity-import-slice and
L2-virtual-entity-power-platform, which both list only two
target_artifact_types for a table+entity pair and hold exactly the real
per-object file count in their golden folders, not one file per listed
type). This golden folder holds four files, one per real AOT object:

- ConDemoTerritory.metadata.xml - AxTable, the PRIMARY (policy) table.
  Label=@TaxTransactionInquiry:HeaderNote, TableGroup=Main, fields
  TerritoryCode (AxTableFieldString, ExtendedDataType=Num,
  Mandatory=Yes) and OwnerUserId (AxTableFieldString,
  ExtendedDataType=UserId), one index TerritoryIdx
  (AlternateKey=Yes, no AllowDuplicates tag - real shipped unique
  indexes like CustGroup.GroupIdx, read directly for this property's
  spelling, carry AlternateKey=Yes with no separate uniqueness flag;
  uniqueness is the default absent an explicit AllowDuplicates=Yes).
- ConDemoTerritoryLine.metadata.xml - AxTable, the CONSTRAINED table.
  Fields TerritoryCode (ExtendedDataType=Num) and LineNum
  (AxTableFieldReal, ExtendedDataType=LineNum), one unique index
  TerritoryLineIdx on both fields (AlternateKey=Yes), and one
  AxTableRelation named ConDemoTerritory -> RelatedTable=
  ConDemoTerritory, field constraint TerritoryCode=TerritoryCode.
- ConDemoTerritoryPolicyQuery.metadata.xml - AxQuery
  (AxQuerySimple), root data source ConDemoTerritory over table
  ConDemoTerritory, DynamicFields=Yes, one range: Field=OwnerUserId,
  Value=(currentUserId()) - the real per-user idiom confirmed above, not
  a guess.
- ConDemoTerritoryPolicy.metadata.xml - AxSecurityPolicy,
  ConstrainedTable=Yes, Enabled=Yes, PrimaryTable=ConDemoTerritory,
  Query=ConDemoTerritoryPolicyQuery, one ConstrainedTables entry
  (AxSecurityPolicyConstrainedEntity, i:type=
  AxSecurityPolicyConstrainedTable, Constrained=Yes,
  Name=ConDemoTerritoryLine, TableRelation=ConDemoTerritory - the
  literal relation name created on ConDemoTerritoryLine above).

## How the objects were actually written (tool-path notes)

d365fo_file(action="create", objectType="table", ...) with a structured
properties.fields[] block handled both tables' fields and base
properties in one call. The unique alternate-key indexes needed a
modify/add-index follow-up call; the first attempt passed
alternateKey/allowDuplicates (guessed from the case's English
description) and both were silently reported as IGNORED, WRONG
parameter name by the tool's own response ("did you mean
'indexAlternateKey'"/"'indexAllowDuplicates'") - the index was still
created (unique-by-omission is not the same as an explicit
AlternateKey=Yes), so it was removed (remove-index) and re-added with
the corrected indexAlternateKey: true parameter, confirmed in the
written XML afterward. The table relation needed one corrective round
too: the first add-relation call used {field, relatedField}, which the
tool rejected with a Zod validation error naming the actual expected keys
(relationConstraints[].fieldName / .relatedFieldName); the corrected
call succeeded. Both corrections are exactly what the tool's own
"complete spec on a wrong parameter" contract promises, and both were
followed rather than worked around.

The query and the security policy do not expose a structured
properties shape for ranges / ConstrainedTables in this tool version
(the d365fo_file tool description's properties bullet list has no
entry for query ranges or for security-policy at all), so both were
written via d365fo_file(action="create", ..., xmlContent=...) - the
tool's own sanctioned "write exact XML text" path, not a hand-edit after
the fact. The XML text itself was built by directly reproducing the real,
disk-read shapes documented above (AxQuerySimpleDataSourceRange for the
range, AxSecurityPolicyConstrainedEntity/AxSecurityPolicyConstrainedTable
for the constrained-table entry), not invented. Two mechanical retries
were needed to get the raw-XML parameter right: the first attempt wrapped
the whole xmlContent value in a literal CDATA marker (a habit carried
over from the table field checks), which the tool wrote to disk VERBATIM
AS TEXT, corrupting the file's own XML declaration; the second attempt
HTML-entity-escaped the angle brackets ("&lt;AxQuery&gt;"), which the
tool explicitly rejected up front ("xmlContent appears to be
HTML-entity-escaped ... Pass raw XML ... this parameter is written to
disk verbatim, unparsed") before anything was written. The third, correct
attempt passed literal XML with no wrapper, and the file on disk was
byte-inspected (xxd) afterward to confirm it starts directly with the
XML declaration and carries no leading whitespace or stray marker text.

## Stale-index residue found and cleaned before implementing (environment, not a case defect)

Before any object was created, prepare(mode="create", ...) reported a
false collision: ConDemoTerritory (table) and ConDemoTerritoryPolicy
(security-policy) already existed in the SQLite symbol index and were
listed by search. get_object_info(objectType: "table", name:
"ConDemoTerritory") reported NOT FOUND ON DISK, and a filesystem
check under K:\AosService\PackagesLocalDirectory\Contoso\Contoso\Ax*
confirmed no real source XML existed anywhere for any of the four names.
Compiled build OUTPUT did exist for three of them under
Contoso\XppMetadata\Contoso\ (AxTable\ConDemoTerritory.xml,
AxTable\ConDemoTerritoryLine.xml, AxQuery\
ConDemoTerritoryPolicyQuery.xml) - stale artifacts from a prior,
incomplete attempt at this same case, left behind by a build that never
had matching real source, plus a symbol index that was never purged after
that attempt's rollback. None of the three stale files were referenced by
the .rnrproj. All three stale XppMetadata files were deleted before
implementing (ConDemoTerritoryPolicy's own stale index entry had no
backing file of any kind - it was purely a phantom SQLite row). This is
the same class of stale-index issue documented elsewhere in this project
(XppMetadata\<Model>\<Model> vs <Model>\<Model> confusion) - worth
flagging to the improver as a reminder that prepare's collision check
trusts the SQLite index, not disk state, and can false-positive on
leftover build output from an interrupted prior run. It did not block
implementation: d365fo_file(action="create") itself checks disk, not
just the index, and created all four objects without complaint despite
the stale collision warnings.

## Build at capture (2026-08-04, SHA dffe0dc)

FULL build (fullBuild: true): 0 ERRORS, 2 warnings, both
pre-existing and unrelated to the written code - the same two documented
in the L3-warehouse-work-slice golden from earlier in this session
(Foundation module has no standalone assembly on disk;
Microsoft.Dynamics.Commerce.Runtime.Entities.AttributeBasedPricing
external reference not found). The compiler log's "Metadata: validate
policy" stage ran with no errors reported next to it, confirming the new
AxSecurityPolicy was validated as part of the same pass as the tables
and query, not skipped.

## BP check: NOT independently confirmed (the same tool limitation the WHS golden already documented, re-confirmed here) - reported honestly, not glossed over

run_bp_check filtered to table:ConDemoTerritory reported "BP Check
passed", printing the exact same "The source for referenced module
'Foundation' is missing from the model store..." diagnostic already
documented in L3-warehouse-work-slice's README (Foundation was added
to Contoso's ModuleReferences by that earlier case in this session and
was never removed - it is a standing environment prerequisite, not case
residue). Per this project's stated rule that a green result needs
provenance, this was NOT taken on faith: a negative control was run
before writing anything to the corpus - run_bp_check filtered to
table:ThisTableDoesNotExist12345 (a name provably absent from the
model) returned the BYTE-IDENTICAL "BP Check passed" response with
the same missing-Foundation diagnostic, proving the checker processed
zero real elements for either filter. This is the same reproducible
Foundation-reference false-green already root-caused in the WHS golden
(xppbp needs a -packagesRoot binary-metadata fallback for a referenced
module whose source can't be loaded into its own model store, and the
tool wrapper does not expose that flag) - re-confirmed rather than
assumed, exactly as this task's own instructions required.

Per this project's own rule ("bp_clean: 1 means BP ran and was clean...
never 'BP was not run'"), the corpus record omits --bp-warnings
entirely, scoring bp_clean: null (genuinely not checked), not a
fabricated 1.

As a substitute (not a replacement) signal: the offline
validate_code(mode="syntax", codeType="xml-table") best-practice
validator (no xppc/xppbp.exe involved) reported 0 VIOLATIONS, 18
rule groups checked on both ConDemoTerritory and ConDemoTerritoryLine
- the exact XML that was written. There is no offline validate_code
codeType for AxQuery/AxSecurityPolicy XML (only xpp, xml-table,
and the generic xml-any), so the query and the security policy have no
independent offline BP substitute beyond the clean full build itself; this
gap is stated here rather than papered over with an xml-any result
dressed up as a BP check.

## Descriptor: no change needed for this case

Unlike the two prior cases in this session's batch,
K:\AosService\PackagesLocalDirectory\Contoso\Descriptor\Contoso.xml
ModuleReferences did NOT need a new entry: every EDT this case
names directly (Num, UserId via SysUserId's Extends relation,
LineNum) resolves to model ApplicationPlatform, already present in
Contoso's ModuleReferences from a prior case. The Foundation entry
added by L3-warehouse-work-slice earlier in this session was left in
place (this case's build did not require it, but removing it was never
attempted here since it is documented, additive environment
infrastructure another case may still depend on within the same session).

## Rollback (verified disk-side, not just via the tool's own claim)

All four objects were removed with undo_last_modification (each
reported "deleted session-created file outside git" + ".rnrproj entry
removed" + "stale index entries cleaned up"). Verified independently
afterward, not just trusted:
- A filesystem search for "*Territory*" under
  K:\AosService\PackagesLocalDirectory\Contoso returned only five
  .backup-* files left behind by the modify/add-index/add-relation
  calls (this tool auto-backs up any non-git-tracked file it modifies,
  since undo_last_modification "would not work" on those - the backups
  are a distinct, separate artifact from the modified file itself and
  undo_last_modification does not clean them up). These five backups
  were deleted manually; a follow-up search confirmed zero remaining
  "*Territory*" matches anywhere under the model, including
  XppMetadata (the full build had regenerated compiled output for all
  four objects, and that regenerated output was deleted alongside the
  backups).
- grep -c "Territory" ContosoDemo.rnrproj returned 0.
- Contoso.xml ModuleReferences was re-diffed against its pre-run state
  and found unchanged (no entry was added or removed by this case).

The sandbox was left holding only pre-existing fixtures/environment state
(the Foundation Descriptor entry from the earlier WHS case), no residue
from this case.

## Corpus record

eval/corpus/runs/2026-08-04T04__L3-xds-policy-constrained-table__dffe0dc.json
(first-capture record: build: 1, bp_clean: null (honestly "not
checked" - re-confirmed tool limitation, see above), golden_match: null
per the documented golden_pending degrade-gracefully convention,
classification PASS. The golden files in this folder were captured from
this run's own verified output and self-checked afterward with
npm run eval:score -- L3-xds-policy-constrained-table --actual-dir
eval/goldens/L3-xds-policy-constrained-table (after flipping
golden_pending to false), which reports golden_match: 1 with no
structural deltas against itself.)
