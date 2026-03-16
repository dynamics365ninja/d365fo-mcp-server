# Usage Examples

Five real-world scenarios that show how GitHub Copilot chains multiple MCP tools together
to complete complex D365FO tasks in a single conversation.

---

## Scenario 1 — Implement a Safe Chain of Command Extension

**Goal:** Safely extend `SalesFormLetter.run()` to write an audit record after every sales
posting — without breaking other ISV extensions or producing a duplicate wrapper.
Includes creating a dedicated audit table with correct EDTs and the CoC extension class.

**Prompt:**
```
I need to extend SalesFormLetter.run() in my MyPackage\MyModel model.
Before writing anything:
1. Check if CoC extensions already exist for this method
2. Show me what other extension points SalesFormLetter has
3. Get the exact method signature I need to match
Then create an audit table MySalesFormLetterAuditLog
(fields: SalesId, PostingType, PostedAt, PostedBy, Success)
with correct labels and EDTs, and generate the CoC extension class that inserts
an audit record after the base call completes.
```

**Tools Copilot chains:**
1. `get_workspace_info` — workspace config check (model name, prefix, paths); mandatory first call
2. `find_coc_extensions` + `analyze_extension_points` — parallel: checks whether `run()` is already CoC-wrapped; lists all eligible methods, delegates, and blocked members on `SalesFormLetter`
3. `get_method_signature` ×2 — first call returns the exact signature (return type, parameters, modifiers); second call with `includeCocTemplate: true` returned only the signature (CoC template not supported in this server version) — skeleton written manually from the first call's output
4. `analyze_code_patterns` + `search_extensions` ×2 + `search` — parallel research: audit log insert patterns in existing code; all custom `SalesFormLetter` extensions (prefix/model context); existence check for an audit table in the symbol index
5. `get_label_info` + `search_labels` — parallel pre-label checks: resolves the correct `labelFileId`; confirms none of the planned label IDs already exist
6. `create_label` ×6 — creates `SalesFormLetterAuditLog`, `PostingType`, `SalesId`, `PostedAt`, `PostedBy`, `Success` in en-US, cs, and de
7. `generate_smart_table` + `get_table_info` — generates and writes `MySalesFormLetterAuditLog` to disk; immediately reads it back to verify what fields and EDTs were actually written
8. `batch_search` + `search` + `get_enum_info` ×2 — parallel: resolves EDT `SalesId`, `TransDateTime`, `UserId`, enum `NoYes`; checks `SalesUpdate` (too narrow — missing Confirmation/Invoice); confirms `DocumentStatus` covers all posting types
9. `modify_d365fo_file` ×2 + `create_d365fo_file` — `replace-all-fields` rewrites all fields with correct EDTs (`SalesId`, `DocumentStatus`, `TransDateTime`, `UserId`, `NoYes`); `modify-property` sets `TitleField1 = SalesId`; creates CoC extension class `SalesFormLetterMy_Extension` with `run()` and registers it in the `.rnrproj`
10. `verify_d365fo_project` — confirms both objects (`MySalesFormLetterAuditLog` table and `SalesFormLetterMy_Extension` class) are on disk and in the project  ✅

**Why this matters:**
- `find_coc_extensions` and `analyze_extension_points` (step 2) run in parallel — they answer different questions but neither depends on the other's output, so there is no reason to sequence them.
- `get_method_signature` ×2 (step 3): the second call with `includeCocTemplate: true` is worth trying even if support is uncertain — if it fails, the first call's output is already sufficient to write the skeleton manually.
- `get_table_info` immediately after `generate_smart_table` (step 7) is a critical verification step: the generator may write different EDTs than requested; reading back the actual table before searching for correct types saves a redundant fix-up round.
- `replace-all-fields` (step 9) is more reliable than individual `remove-field` + `add-field` calls when multiple fields are wrong — it rewrites the entire `<Fields>` block atomically, avoiding FieldGroup reference errors from partial intermediate states.
- The enum investigation in step 8 shows why `search` + `get_enum_info` is needed before committing — `SalesUpdate` looked correct by name but lacked `Confirmation` and `Invoice` values, making `DocumentStatus` the right choice.

---

## Scenario 2 — Design and Build a Complete SysOperation Batch Job

**Goal:** Create a full batch job from scratch, following the exact patterns already used in the codebase — including correct labels and EDT types.

**Prompt:**
```
I need to create a SysOperation batch job that recalculates vendor payment terms
for all active vendors. The job should:
- Run nightly as a recurring batch
- Report progress and write errors to the infolog
- Use labelled parameters in the DataContract dialog
- Follow the same patterns as existing batch jobs in the codebase

Analyse the existing patterns first, look up the right EDT types for the
parameters, resolve labels, then generate the DataContract, Controller,
and Service classes, and create all three files in my project.
```

**Tools Copilot chains:**
1. `get_workspace_info` — workspace config check (model name, prefix, paths); mandatory first call
2. `analyze_code_patterns` ×2 + `search_extensions` ×2 + `search` — parallel research: SysOperation DataContract/Controller/Service patterns in the codebase; existing batch extensions in custom models; broader VendPaymTerms and related class candidates
3. `batch_search` (7 parallel queries) — resolves `SysOperationServiceController`, `SysOperationServiceBase`, `VendTable`, `PaymTerm`, `PaymTermId`, `VendAccount`, `DimensionStructureSynchronization` in one round-trip
4. `get_class_info` + `get_api_usage_patterns` + `analyze_code_patterns` — deep-dive into `SysOperationServiceController` API; typical DataContract/Controller/Service wiring sequence; parm method and attribute conventions
5. `generate_code` with `pattern: sysoperation` — generates DataContract/Controller/Service skeleton for `VendPaymTermsRecalculate` following the discovered patterns
6. `get_table_info` + `batch_search` (4 parallel) + `get_edt_info` ×2 — `VendTable` field overview; resolves `VendPaymTermId`, `VendAccount`, `Blocked`, `NoYesId` EDTs; confirms base types and lookup constraints for each DataContract parm
7. `search_extensions` ×4 + `get_class_info` + `get_method_signature` + `suggest_method_implementation` — finds existing My* DataContract class as a structural template; reads an exact `parm` method body; gets a `processOperation` implementation suggestion derived from the codebase
8. `get_class_info` + `get_table_info` + `batch_search` (2 parallel) — `SysOperationServiceBase` method overview (base calls to replicate); `PaymTerm` table structure; resolves `VendGroup` and `PaymTermId` EDTs for remaining parms
9. `search_labels` ×10 — exhaustive search across model label file, SYS global labels, and all scopes using 10 different phrasings to ensure no reusable label is missed before creating new ones
10. `create_label` ×2 — creates `VendPaymTermRecalcParmVendGroup` and `VendPaymTermRecalcParmNewPaymTerm` in en-US, cs, and de
11. `create_d365fo_file` ×3 — DataContract, Controller, and Service classes; each registered in the `.rnrproj`
12. `verify_d365fo_project` — confirms all three objects are on disk and in the project  ✅

**Why this matters:**
- The two `batch_search` rounds (steps 3 and 8) reflect a real discovery dependency: the first round identifies the framework classes to study; the second fills in the gaps that only became apparent after reading the `generate_code` skeleton and the `VendTable` structure.
- `search_extensions` ×4 (step 7) is the most efficient way to find an existing My* DataContract as a structural template — a real class from the same model gives exact attribute placement and parm boilerplate that no documentation can match.
- 10 `search_labels` queries (step 9) before two `create_label` calls reflects real label hygiene: D365FO has thousands of SYS labels that overlap with custom domains, and a single search rarely covers all phrasings. Running all variants up front is cheaper than discovering a duplicate after writing code that references a new label ID.
- `generate_code` (step 5) produces a compilable skeleton but not a finished service — EDT types, base class calls, and `processOperation` logic all require the subsequent research in steps 6–8 before the files can be written.

---

## Scenario 3 — New Feature with Labels, Table Extension, and Form Extension

**Goal:** Add a custom field to an existing table, label it in all supported languages,
and expose it on the standard form.

**Prompt:**
```
I want to add a "Customer priority tier" field (enum: Standard, Silver, Gold, Platinum)
to CustTable in my MyPackage\MyModel model. Steps:
1. Check if a label for "Customer priority tier" already exists in my model
2. If not, create it in en-US, cs, and de
3. Create the enum AxEnum CustPriorityTier
4. Create a table extension CustTable.MyModel_Extension with the new field using the label
5. Show me the CustTable form structure, then create a form extension that adds
   the field to the General tab
6. Verify everything is in place
```

**Tools Copilot chains:**
1. `get_workspace_info` — reads model name, package path, effective object prefix, and EXTENSION_PREFIX; mandatory first call
2. `search_labels` — checks if a label matching "Customer priority tier" already exists in the model's label file
3. `get_label_info` — inspects the label file to confirm which languages are already covered and what the label file ID is
4. `batch_search` — parallel lookup of `CustPriorityTier` (enum candidate), `CustTable` (table info), and existing table extensions in one call
5. `get_form_info` — reads `CustTable` form datasources, tab hierarchy, and control names to confirm the exact name of the General tab before touching the form extension
6. `search_labels` — second search for any closely related labels that could be reused for the enum value captions
7. `create_label` — creates the missing `CustPriorityTier` label in en-US, cs, and de
8. `search_labels` — confirms the newly created label is resolvable before referencing it in XML
9. `create_d365fo_file` — creates the `AxEnum` XML with value labels
10. `create_d365fo_file` — creates the table extension `CustTable.MyModel_Extension` with the new field bound to the label
11. `create_d365fo_file` — creates the empty form extension `CustTable.MyModel_Extension` (controls are added in the next step)
12. `modify_d365fo_file` with `operation: add-control` — adds the `MyCustPriorityTier` field control inside the `TabGeneral` group in the form extension (no PowerShell needed)
13. `verify_d365fo_project` — confirms all objects (enum, table extension, form extension) are on disk and registered in the `.rnrproj`

**Why this matters:** Calling `get_form_info` before touching the form extension — and using
`modify_d365fo_file add-control` instead of PowerShell — ensures the control is added with
the correct parent tab name and proper XML structure, without risk of corrupting the extension file.
The double `search_labels` pattern (before and after `create_label`) catches the edge case
where the label already existed under a slightly different ID.

---

## Scenario 4 — Security Audit and Minimal-Privilege Extension

**Goal:** Before releasing a new feature, understand who already has access and create
a correctly scoped privilege without duplicating existing ones.

**Prompt:**
```
I'm adding a new "Vendor Payment Terms" maintenance page in my model.
Before I create security objects:
1. Show me how the existing VendPaymTerms form is secured —
   which roles and duties already grant access
2. Check if a privilege for VendPaymTerms maintenance already exists
3. Validate that "MY_VendPaymTermsMaintain" is a valid privilege name
   that won't clash with anything in the symbol index
Then create the privilege, add it to the VendPaymentTermsMaintain duty,
and verify the objects are in place.
```

**Tools Copilot chains:**
1. `get_workspace_info` ×2 — workspace config check (called twice: once at start, once after user fixed `.mcp.json` mid-session)
2. `get_security_coverage_for_object` ×3 — full chain for `VendPaymTerms` form and `PaymTerm` menu item (form → menu items → privileges → duties → roles); repeated after each discovery round to confirm no `MY_` collision
3. `search` + `batch_search` ×9 — parallel searches across name variants (`VendPaymTerms`, `VendPaymentTerms`, `PaymTerm*`, `MY_VendPaymTermsMaintain`) for privileges, duties, and menu items
4. `get_menu_item_info` ×2 — `VendPaymTerms` menu item detail (target form, security chain); called again for display-type variant
5. `get_security_artifact_info` ×8 — reads full entry lists for candidate duties: `VendPaymentTermsMaintain`, `VendPaymTermsMaintain`, `LedgerPaymTermsMaintain`, `PaymTermsMaintain`, `VendVendorMasterMaintain`, `VendInvoiceVendorMaintain`, and privileges `PaymTermMaintain`, `PaymTermView`
6. `validate_object_naming` ×2 — confirms `MY_VendPaymTermsMaintain` follows D365FO conventions and has no collision in 584K+ symbols
   (prefix separator `MY_` is valid — `{Prefix}_{Name}` is a supported D365FO naming pattern)  ✅
7. `generate_code` — generates security-privilege XML skeleton for `VendPaymTerms`
8. `search_labels` ×2 — label lookup for "vendor payment terms maintain" (with and without model filter)
9. `create_d365fo_file` ×2 — creates `MY_VendPaymTermsMaintain` (`security-privilege`) and `MY_VendPaymentTermsMaintain` (`security-duty`)
10. `verify_d365fo_project` — confirms both objects exist on disk and in `.rnrproj`  ✅

**Why this matters:**
- Running `get_security_coverage_for_object` first often reveals an existing privilege already grants the right access — no new security object needed.
- The dense search phase (steps 3–6) reflects a real-world security audit: standard duties have overlapping names, and Copilot must exhaustively verify no collision exists before committing to a name.
- `validate_object_naming` confirms the `{Prefix}_{Name}` underscore separator is valid and checks for symbol-index collisions.
- `get_workspace_info` is called twice because the workspace `.mcp.json` had a placeholder model name that the user fixed mid-session.

---

## Scenario 5 — Understand and Port a Financial Process

**Goal:** Understand how a complex standard process works, then replicate its pattern
for a custom business requirement.

**Prompt:**
```
I need to create a process that posts custom adjustment journal entries
for inventory revaluation. I've never worked with ledger journals before.

1. Show me the structure of LedgerJournalTable and LedgerJournalTrans
   (fields, relations, relevant methods)
2. Find how LedgerJournalCheckPost is used in the codebase —
   what parameters it needs and how existing code calls it
3. Analyse ledger journal creation patterns in my MyPackage model
4. Generate a service class LedgerInventAdjustmentService with methods to:
   - Create the journal header
   - Add lines with the correct dimension defaulting from InventTable
   - Post using LedgerJournalCheckPost
5. Show how financial dimensions are copied from InventTable to the journal line
6. Create the service class file in my project
```

**Tools Copilot chains:**
1. `get_workspace_info` — workspace config check, model and prefix detection
2. `get_table_info` ×3 — `LedgerJournalTable`, `LedgerJournalTrans`, `InventTable` (fields, relations; `InventTable` specifically for `DefaultDimension` field)
3. `get_api_usage_patterns` ×3 — typical call sequences for `LedgerJournalCheckPost`, `LedgerJournalEngine`, `DimensionAttributeValueSetStorage`; `DimensionDefaultingService` returned no results
4. `analyze_code_patterns` ×2 — journal creation patterns in the codebase; dimension defaulting patterns from `InventTable.DefaultDimension` to `LedgerJournalTrans`
5. `get_class_info` ×3 — full method overview for `LedgerJournalCheckPost`, `JournalTableData`, `JournalTransData`
6. `get_method_signature` ×6 — exact signatures for: `LedgerJournalCheckPost.newLedgerJournalTable`, `.parmJournalNum`, `.processOperation`; `LedgerDimensionFacade.serviceCreateLedgerDimension`, `.createLedgerDimension`; `JournalTransData.create`; `JournalTableData.construct`; `MyBankSett_LedgerJournalTransAutoSettleService.run` (as a pattern reference)
7. `get_class_info("LedgerDimensionFacade")` — dimension facade methods for merging ledger dimensions
8. `search_extensions` ×4 — existing custom journal extensions and `My*` service class patterns; `MyBankSett_LedgerJournalTransAutoSettleService` found and studied as a structural template
9. `search_labels` ×4 + `get_label_info` — label lookup for journal/adjustment/error strings; confirmed 4 existing labels in the model and available languages (en-US, cs, de)
10. `batch_search` ×1 (3 parallel) — `JournalTableData`, `JournalTransData`, `InventItemSalesSetup DefaultDimension`
11. `create_label` ×3 — `MyInventAdjItemNotFound`, `MyInventAdjMainAccountMissing`, `MyInventAdjPostFailed`
12. `create_d365fo_file` — creates `MyLedgerInventAdjustmentService` class and registers it in the project
13. `verify_d365fo_project` — confirms the file exists on disk and in `.rnrproj`  ✅

**Why this matters:**
- `get_method_signature` is called 7× (steps 6–7) because Copilot must know the exact parameter order for `JournalTransData.create(doInsert, initVoucherList)` and `LedgerDimensionFacade.createLedgerDimension` before writing a single line of service code — guessing these produces uncompilable X++.
- Studying an existing `My*` service class (`MyBankSett_LedgerJournalTransAutoSettleService`) via `get_class_info` + `get_method_signature` gives a proven structural template in the same model, avoiding the need to invent a pattern from scratch.
- `search_labels` before `create_label` ensures no duplicate label IDs are created — the 4 found labels guided the naming of the 3 new ones.

---

## Scenario 6 — Create a Complete SSRS Report from Scratch

**Goal:** Create a full SSRS report for inventory by storage zones — including TmpTable,
Contract, DP, Controller, and AxReport XML — in a single conversation.

**Prompt:**
```
Create an SSRS report "InventByZones" that shows inventory by warehouse zones.
Fields: ItemId, ItemName, InventLocationId, WHSZoneId, OnHandQty, ReservedQty, AvailableQty.
Dialog parameters: InventLocationId (mandatory), FromDate, ToDate.
The report should have a Controller class so we can attach a menu item.
```

**Tools Copilot chains:**
1. `get_workspace_info` — workspace config check (model name, prefix, paths); mandatory first call
2. `get_report_info("InventOnHand")` — study an existing inventory report to understand the DP/TmpTable/Contract naming conventions and dataset structure used in this codebase
3. `search_labels` ×2 — check whether labels for "Inventory by zones", "Warehouse", "Zone" already exist; re-use to avoid duplicates
4. `create_label` ×3 — create labels for caption, InventLocationId prompt, and report header
5. `generate_smart_report` — one call generates all 5 objects:
   - `InventByZonesTmp` (TempDB table, 7 fields with auto-suggested EDTs: `ItemId`, `Name`, `InventLocationId`, `WHSZoneId`, `InventQty` ×3)
   - `ContosoInventByZonesContract` (`[DataContractAttribute]` with `parmInventLocationId`, `parmFromDate`, `parmToDate` — `InventLocationId` marked mandatory)
   - `ContosoInventByZonesDP` (`extends SrsReportDataProviderBase`, `processReport()` skeleton, `getContosoInventByZonesTmp()` getter)
   - `ContosoInventByZonesController` (`main(Args)`, `prePromptModifyContract()`)
   - `ContosoInventByZones.xml` (AxReport + full RDL with Tablix for 7 fields, all AX system hidden parameters, DynamicParameter)
6. `create_d365fo_file` ×5 — one call per returned XML block: TmpTable → Contract → DP → Controller → Report (in this order, Azure/Linux path)
7. `verify_d365fo_project` — confirms all 5 files exist on disk and are in the `.rnrproj`  ✅

**After generation — implement the DP logic:**
8. `get_table_info("InventSum")` — check fields and relations on InventSum (on-hand quantities)
9. `get_table_info("WHSZone")` — check WHSZone fields and join conditions
10. `modify_d365fo_file` — add the actual `processReport()` body to the DP class using a `join` query on `InventSum`, `WHSLocation`, `WHSZone`

**Why this matters:**
- `generate_smart_report` replaces what previously required 15+ tool calls (separate table, 3 class creations, report XML assembly, RDL generation) with a single call that returns all 5 object blocks.
- The order in step 6 matters: TmpTable must be created before the DP class so the `[SRSReportDataSetAttribute(tableStr(...))]` reference resolves at build time.
- `processReport()` is intentionally a skeleton — the actual query logic (join InventSum + WHSLocation + WHSZone) requires understanding the source tables first (steps 8–9), which is why the tool generates a `// TODO` placeholder rather than guessing the query.
- On a Windows VM, step 6 is skipped entirely — `generate_smart_report` writes all files directly; Copilot only needs to confirm with `verify_d365fo_project`.

