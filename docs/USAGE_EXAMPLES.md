# Usage Examples

Five real-world scenarios that show how GitHub Copilot chains multiple MCP tools together
to complete complex D365FO tasks in a single conversation.

---

## Scenario 1 — Implement a Safe Chain of Command Extension

**Goal:** Safely extend an existing D365FO method without breaking other ISV extensions
or producing a duplicate wrapper.

**Prompt:**
```
I need to extend SalesFormLetter.run() in my MyPackage\MyModel model.
Before writing anything:
1. Check if CoC extensions already exist for this method
2. Show me what other extension points SalesFormLetter has
3. Get the exact method signature I need to match
Then generate the CoC extension class that logs a custom audit record
after the base call completes, and create the file in my project.
```

**Tools Copilot chains:**
1. `find_coc_extensions` — lists all existing wrappers for `SalesFormLetter.run()`
2. `analyze_extension_points` — shows CoC-eligible methods, `final` blocks, and delegate hooks on `SalesFormLetter`
3. `get_method_signature` — returns the exact return type and parameters to match
4. `generate_code` with `pattern: coc-extension` — produces the complete extension class
5. `search_labels` — checks whether labels needed for audit record fields already exist in the model's label file
6. `validate_object_naming` — confirms the generated class name (e.g. `SalesFormLetterContoso_Extension`) follows D365FO naming conventions and has no collision in the symbol index
7. `create_d365fo_file` — writes the XML to the model's `AxClass\` folder and adds it to the `.rnrproj`
8. `verify_d365fo_project` — confirms the file is on disk and in the project

**Why this matters:** Calling `find_coc_extensions` first prevents creating a duplicate wrapper
that would shadow an existing ISV extension and cause a build conflict.

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
1. `analyze_code_patterns` — finds existing SysOperation batch jobs in the codebase and extracts the common structure (DataContract, Controller, Service pattern)
2. `get_method_signature` + `batch_search` — retrieves signatures of `SysOperationServiceController`, `SysOperationDataContractBase`, and `BatchHeader` in parallel
3. `search_labels` + `get_label_info` — checks whether labels for dialog captions (e.g. "Vendor", "Payment terms") already exist in the model's label file
4. `get_class_info` — reads the full class definition of a representative existing batch job to confirm the exact method signatures and attribute usage
5. `generate_code` with `pattern: sysoperation` — produces all three classes (DataContract, Controller, Service) following the discovered patterns
6. `create_label` — creates any missing labels for the DataContract parameter captions in all supported languages
7. `get_edt_info` — looks up the correct base EDT for each DataContract parameter (e.g. `VendAccount`, `PaymTermId`) to ensure proper validation and lookup behaviour
8. `create_d365fo_file` × 3 — writes the DataContract, Controller, and Service XML files and registers each in the project
9. `verify_d365fo_project` — confirms all three objects are on disk and correctly included in the `.rnrproj`

**Why this matters:** Fetching EDT types before generating ensures each DataContract
parameter has the correct base type, so the dialog renders the right lookup and
the compiler validates assignments — not just a plain `str` or `int`.

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
1. `search_labels` — checks if a matching label already exists (avoids duplication)
2. `create_label` — creates `CustPriorityTier` in en-US, cs, and de across all label files
3. `get_method_signature` / `get_edt_info` — looks up the correct base EDT to extend for the enum
4. `create_d365fo_file` — creates the `AxEnum` XML
5. `get_table_info` — reads `CustTable` fields and relations to choose the right field group
6. `create_d365fo_file` — creates the table extension XML with the field and label reference
7. `get_form_info` — reads `CustTable` form datasources, tabs, and field groups
8. `create_d365fo_file` — creates the form extension that adds the field to the General tab
9. `verify_d365fo_project` — checks all four objects (label, enum, table extension, form extension) are on disk and in the project

**Why this matters:** Searching for the label first is always safer — duplicate labels waste
translation budget and cause merge conflicts in label files.

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
3. Validate that "MyModel_VendPaymTermsMaintain" is a valid privilege name
   that won't clash with anything in the symbol index
Then create the privilege, add it to the VendPaymentTermsMaintain duty,
and verify the objects are in place.
```

**Tools Copilot chains:**
1. `get_security_coverage_for_object` — returns the full chain: form → menu items → privileges → duties → roles
2. `search` with `objectType: SecurityPrivilege` — checks if a maintenance privilege already exists
3. `validate_object_naming` — confirms `MyModel_VendPaymTermsMaintain` follows D365FO naming conventions and has no collision in 584K+ symbols
4. `get_security_artifact_info` for the existing duty — reads its current privileges to understand what to add to
5. `create_d365fo_file` — creates the privilege XML
6. `modify_d365fo_file` — adds the privilege reference to the existing duty extension
7. `verify_d365fo_project` — confirms both objects exist and are registered

**Why this matters:** Running `get_security_coverage_for_object` first often reveals that
an existing privilege already grants exactly the right access — no new security object needed.

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
1. `get_table_info` × 2 — reads `LedgerJournalTable` and `LedgerJournalTrans` fields, relations, and methods in parallel
2. `search` — finds all usages of `LedgerJournalCheckPost` in the codebase
3. `get_class_info` — reads the class methods and signatures for `LedgerJournalCheckPost`
4. `search` — finds existing ledger journal creation code in `MyPackage`
5. `get_table_info` — reads `InventTable` to find the dimension attribute field
6. `batch_search` — fetches `DimensionAttributeValueSet`, `DimensionDefaultingEngine`, and `LedgerDimensionFacade` in parallel to understand dimension defaulting APIs
7. `generate_code` — produces the service class with header creation, line creation, dimension defaulting, and posting
8. `create_d365fo_file` — writes the class and registers it in the project
9. `verify_d365fo_project` — confirms the file is on disk and in the project

**Why this matters:** Fetching `DimensionAttributeValueSet`, `DimensionDefaultingEngine`,
and `LedgerDimensionFacade` in one batch call gives Copilot the full dimension API picture
before generating code — otherwise it guesses at method signatures and produces code that
does not compile.
