# Coverage — what "100%" means

<!-- GENERATED FILE — edit src/eval/coverage/taxonomy.ts, then run `npm run eval:coverage`. -->

A taxonomy leaf counts as covered only when all three hold: **K** a knowledge entry teaches it · **E** an eval case with a captured golden proves it · **T** the tool path can create/validate the artifact. Flags are derived from the live sources (`KNOWLEDGE_BASE`, `eval/cases`, the create/scaffold registry), so a deleted case or a renamed entry drops the number.

**core** = anything done at least once per project — the hard commitment. **total** = core plus exotics (license codes, XDS, aggregate measurements), a visible asymptote rather than a target.

| Tier | Covered | Leaves | % |
| --- | ---: | ---: | ---: |
| core | 67 | 67 | **100%** |
| total | 111 | 111 | 100% |

## Data model (12/12)

| Leaf | Tier | K | E | T | Evidence / gap |
| --- | --- | :-: | :-: | :-: | --- |
| Table | core | ✅ | ✅ | ✅ | L1-table-basic, L2-table-modify-lifecycle |
| Table extension | core | ✅ | ✅ | ✅ | L2-table-extension |
| Extended data type | core | ✅ | ✅ | ✅ | L0-edt-basic |
| EDT extension | total | ✅ | ✅ | ✅ | L2-edt-extension-basic |
| Base enum | core | ✅ | ✅ | ✅ | L0-enum-basic, L3-enum-field-form-downgrade-guard |
| Enum extension | core | ✅ | ✅ | ✅ | L2-enum-extension-empty-values, L2-enum-modify-values |
| View | core | ✅ | ✅ | ✅ | L1-query-view-basic, L2-form-over-view |
| AOT query | core | ✅ | ✅ | ✅ | L1-query-view-basic |
| Map | total | ✅ | ✅ | ✅ | L1-map-basic |
| Temporary tables (TempDB / InMemory) | core | ✅ | ✅ | ✅ | L4-ssrs-report-basic |
| Relations, indexes, field groups | core | ✅ | ✅ | ✅ | L2-table-modify-lifecycle, L3-form-detailstransaction |
| Table inheritance (SupportInheritance/Extends) | total | ✅ | ✅ | ✅ | L2-table-inheritance-basic |

## Code (37/37)

| Leaf | Tier | K | E | T | Evidence / gap |
| --- | --- | :-: | :-: | :-: | --- |
| Class | core | ✅ | ✅ | ✅ | L1-class-basic, L2-class-method-ops |
| Interface / abstract class | core | ✅ | ✅ | ✅ | L2-interface-abstract-basic |
| Class inheritance (extends chain, virtual dispatch) | core | ✅ | ✅ | ✅ | L2-coc-inherited-method |
| Chain of Command extension | core | ✅ | ✅ | ✅ | L2-coc-extension |
| Event handler subscription | core | ✅ | ✅ | ✅ | L2-event-handler-basic |
| Delegate | core | ✅ | ✅ | ✅ | L2-delegate-basic |
| Macro | total | ✅ | ✅ | ✅ | L1-macro-library-flight |
| Transactions (ttsbegin/ttscommit) | core | ✅ | ✅ | ✅ | L2-exception-tts-retry, L2-occ-retry-basic |
| X++ select grammar | core | ✅ | ✅ | ✅ | L2-date-effective-table, L2-multi-company-changecompany, L2-sysda-fluent-query +2 |
| Set-based operations | core | ✅ | ✅ | ✅ | L2-performance-set-based, L4-ssrs-report-basic |
| SysDa fluent query API | total | ✅ | ✅ | ✅ | L2-sysda-fluent-query |
| Error handling & infolog | core | ✅ | ✅ | ✅ | L2-error-handling-infolog |
| SysExtension plug-in pattern | total | ✅ | ✅ | ✅ | L2-sysextension-plugin |
| Performance patterns | core | ✅ | ✅ | ✅ | L2-performance-set-based |
| Best-practice (BP) compliance | core | ✅ | ✅ | ✅ | L0-edt-basic, L0-enum-basic, L1-class-basic +63 |
| Deprecated APIs & migration | core | ✅ | ✅ | ✅ | L0-edt-basic, L0-enum-basic, L1-class-basic +62 |
| Optimistic concurrency & UnitOfWork | core | ✅ | ✅ | ✅ | L2-occ-retry-basic |
| Caching (CacheLookup, SysGlobalObjectCache, RecordViewCache) | total | ✅ | ✅ | ✅ | L2-table-caching-basic |
| X++ collections & containers (List/Map/Set/Struct) | total | ✅ | ✅ | ✅ | L2-collections-map-list-container |
| Date/time & time zones (utcdatetime, DateTimeUtil) | total | ✅ | ✅ | ✅ | L2-datetime-timezone-range |
| .NET interop (CLRInterop, using alias, CLRError) | total | ✅ | ✅ | ✅ | L2-dotnet-interop-clrerror |
| Reflection / Dict* metadata API | total | ✅ | ✅ | ✅ | L2-reflection-dict-fieldwalk |
| Data types, literals & conversions | core | ✅ | ✅ | ✅ | L2-data-types-conversions |
| Declarations & scope (var/const/readonly/using) | core | ✅ | ✅ | ✅ | L2-declarations-scope |
| Operators & precedence (&&/|| trap, like, is/as) | core | ✅ | ✅ | ✅ | L2-operators-precedence |
| Statements & flow (switch fallthrough, loops) | core | ✅ | ✅ | ✅ | L2-statements-switch-loops |
| Exceptions inside transactions (catchability, retry) | core | ✅ | ✅ | ✅ | L2-exception-tts-retry |
| Attribute authoring & reflection | total | ✅ | ✅ | ✅ | L2-attribute-authoring-reflection |
| Compile-time (intrinsic) functions | core | ✅ | ✅ | ✅ | L2-intrinsic-functions |
| Table buffer API (xRecord/Common members) | core | ✅ | ✅ | ✅ | L2-table-modify-lifecycle |
| Date-effective tables (validTimeState) | total | ✅ | ✅ | ✅ | L2-date-effective-table |
| Run-time (predefined) functions | core | ✅ | ✅ | ✅ | L2-runtime-functions-arity |
| Implicit conversions & explicit converters | core | ✅ | ✅ | ✅ | L2-implicit-conversions |
| select find options, join kinds and clause order | core | ✅ | ✅ | ✅ | L2-select-find-options-joins |
| Global:: statics (query values, access checks) | core | ✅ | ✅ | ✅ | L2-global-statics-access-checks |
| System objects (infolog, Box, Debug, session) | core | ✅ | ✅ | ✅ | L2-system-objects-infolog-box |
| Query filters, range expressions, custom range functions | total | ✅ | ✅ | ✅ | L2-query-range-expression-sysqueryrangeutil |

## UI (11/11)

| Leaf | Tier | K | E | T | Evidence / gap |
| --- | --- | :-: | :-: | :-: | --- |
| Form | core | ✅ | ✅ | ✅ | L1-form-basic |
| Form patterns (ListPage, DetailsMaster, …) | core | ✅ | ✅ | ✅ | L1-form-detailsmaster, L1-form-dialog, L1-form-listpage +5 |
| Form extension | core | ✅ | ✅ | ✅ | L2-form-extension-basic |
| FormRun lifecycle & data sources | core | ✅ | ✅ | ✅ | L2-form-modify-controls, L3-form-add-datasource-lines |
| Menu items (display/action/output) | core | ✅ | ✅ | ✅ | L2-config-key-gated-table, L3-batch-basic, L4-ssrs-report-advanced +3 |
| Menus & submenu nesting | core | ✅ | ✅ | ✅ | L4-master-security-slice |
| Tiles & KPIs | total | ✅ | ✅ | ✅ | L2-tile-cue-over-query |
| Args — record, caller and parameters | core | ✅ | ✅ | ✅ | L2-args-record-caller |
| display / edit methods | core | ✅ | ✅ | ✅ | L2-display-edit-methods |
| Form event handlers | core | ✅ | ✅ | ✅ | L3-form-event-handler-class |
| Lookups (table, reference, multi-select, override) | core | ✅ | ✅ | ✅ | L2-lookup-reference-multiselect |

## Reporting (11/11)

| Leaf | Tier | K | E | T | Evidence / gap |
| --- | --- | :-: | :-: | :-: | --- |
| SSRS report (DP + contract + controller) | core | ✅ | ✅ | ✅ | L4-ssrs-report-advanced, L4-ssrs-report-basic |
| Multi-dataset SSRS report | total | ✅ | ✅ | ✅ | L4-ssrs-report-multidataset |
| Print management | total | ✅ | ✅ | ✅ | L3-print-management-report, L3-print-mgmt-doctype-extension |
| Report contracts (RDP/RDL/print/composite) | core | ✅ | ✅ | ✅ | L4-ssrs-report-advanced |
| Pre-processed RDP (long-running reports) | total | ✅ | ✅ | ✅ | L4-ssrs-report-preprocess |
| Report dialog UI builders | total | ✅ | ✅ | ✅ | L4-ssrs-report-uibuilder |
| Electronic Reporting (ER) | total | ✅ | ✅ | ✅ | L3-electronic-reporting-integration |
| Extending a standard report | core | ✅ | ✅ | ✅ | L3-report-dataset-extension |
| Report design & RDL expressions | core | ✅ | ✅ | ✅ | L4-ssrs-report-design-rdl |
| Report parameters and dataset upkeep (after the scaffold) | core | ✅ | ✅ | ✅ | L4-ssrs-report-parameters |
| Report print destinations (file, e-mail, archive, batch) | core | ✅ | ✅ | ✅ | L4-ssrs-report-print-destinations |

## Frameworks (21/21)

| Leaf | Tier | K | E | T | Evidence / gap |
| --- | --- | :-: | :-: | :-: | --- |
| SysOperation / batch | core | ✅ | ✅ | ✅ | L3-batch-basic |
| Parallel batch processing | total | ✅ | ✅ | ✅ | L3-parallel-batch-tasks |
| Async & retryable batch (BatchRetryable/runAsync) | total | ✅ | ✅ | ✅ | L3-batch-retryable-basic |
| Number sequences | core | ✅ | ✅ | ✅ | L2-numberseq-basic, L3-numberseq-module-slice |
| Financial dimensions | core | ✅ | ✅ | ✅ | L2-dimension-basic |
| Posting engine (LedgerVoucher) | total | ✅ | ✅ | ✅ | L4-posting-ledgervoucher-slice |
| Workflow | core | ✅ | ✅ | ✅ | L3-workflow-document-submit |
| Business events & alerts | core | ✅ | ✅ | ✅ | L2-business-event-basic |
| Feature management | total | ✅ | ✅ | ✅ | L2-feature-management-flight |
| Configuration keys | total | ✅ | ✅ | ✅ | L2-config-key-gated-table |
| Multi-company / changeCompany | core | ✅ | ✅ | ✅ | L2-multi-company-changecompany |
| Global address book | total | ✅ | ✅ | ✅ | L3-gab-party-postaladdress |
| Currency & exchange rates | total | ✅ | ✅ | ✅ | L3-currency-exchange-conversion |
| Inventory (InventTrans / InventDim) | total | ✅ | ✅ | ✅ | L3-inventory-inventdim-onhand |
| Warehouse management (WHS) | total | ✅ | ✅ | ✅ | L3-warehouse-work-slice |
| Warehouse app / barcode scanning | total | ✅ | ✅ | ✅ | L3-warehouse-scan-resolve-slice |
| Warehouse-app screens (ProcessGuide / legacy) | total | ✅ | ✅ | ✅ | L2-processguide-page-control, L3-legacy-workexecutedisplay-extend, L3-processguide-flow-slice |
| Trade agreements & pricing | total | ✅ | ✅ | ✅ | L3-trade-agreement-price-lookup |
| SysOperation dialog from contract attributes | total | ✅ | ✅ | ✅ | L3-sysoperation-dialog-attributes |
| SysOperation query parameter (batch with a filter) | core | ✅ | ✅ | ✅ | L3-sysoperation-query-parameter-batch |
| RunBase lifecycle & packed state | total | ✅ | ✅ | ✅ | L3-runbase-coc-pack-unpack |

## Integration (10/10)

| Leaf | Tier | K | E | T | Evidence / gap |
| --- | --- | :-: | :-: | :-: | --- |
| Data entity (OData) | core | ✅ | ✅ | ✅ | L4-bridge-drops-data-entity-primarytable-fields-on-create, L4-entity-security |
| Data entity extension | total | ✅ | ✅ | ✅ | L3-data-entity-extension-field |
| Custom services / OData actions | core | ✅ | ✅ | ✅ | L3-custom-service-basic |
| Data management framework (DMF/DIXF) | total | ✅ | ✅ | ✅ | L3-dmf-entity-import-slice |
| Dual-write (Dataverse) | total | ✅ | ✅ | ✅ | L3-dualwrite-entity-mapping |
| Power Platform / virtual entities | total | ✅ | ✅ | ✅ | L2-virtual-entity-power-platform |
| Reading Excel / CSV files | total | ✅ | ✅ | ✅ | L3-file-csv-import |
| Direct SQL execution | total | ✅ | ✅ | ✅ | L2-direct-sql-connection |
| Aggregate measurements / analytics | total | ✅ | ✅ | ✅ | L3-aggregate-measurement-basic |
| Attachments (DocuRef / DocumentManagement) | total | ✅ | ✅ | ✅ | L3-attachment-docuref-pdf |

## Security (6/6)

| Leaf | Tier | K | E | T | Evidence / gap |
| --- | --- | :-: | :-: | :-: | --- |
| Security privilege | core | ✅ | ✅ | ✅ | L4-entity-security, L4-master-security-slice |
| Security duty | core | ✅ | ✅ | ✅ | L4-entity-security, L4-master-security-slice |
| Security role | core | ✅ | ✅ | ✅ | L4-entity-security, L4-master-security-slice |
| Data-entity security | core | ✅ | ✅ | ✅ | L4-entity-security |
| Extensible data security (XDS) | total | ✅ | ✅ | ✅ | L3-xds-policy-constrained-table |
| License codes | total | ✅ | ✅ | ✅ | L2-license-code-configkey |

## Quality (3/3)

| Leaf | Tier | K | E | T | Evidence / gap |
| --- | --- | :-: | :-: | :-: | --- |
| SysTest unit testing | core | ✅ | ✅ | ✅ | L2-coc-extension, L2-event-handler-basic, L2-systest-authoring-basic +1 |
| Labels & localisation | core | ✅ | ✅ | ✅ | L0-edt-basic, L0-enum-basic, L1-class-basic +62 |
| TDD loop (red-first SysTest authoring) | core | ✅ | ✅ | ✅ | L2-systest-authoring-basic |

## Closure queue (uncovered, by frequency weight)

Nothing uncovered.

## Orphans

- Knowledge entries no leaf claims (**unproven knowledge**): none
- Eval cases no leaf claims (**unmapped proof**): L0-create-readback-no-reindex, L2-batched-object-reads, L2-entity-query-range-roundtrip, L2-form-control-removal-lifecycle, L2-object-delete-and-entry-point-cleanup, L2-oracle-discriminator-random-wrapper-name, L4-headerlines-document-slice

_Generated 2026-09-02._
