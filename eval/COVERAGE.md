# Coverage — what "100%" means

<!-- GENERATED FILE — edit src/eval/coverage/taxonomy.ts, then run `npm run eval:coverage`. -->

A taxonomy leaf counts as covered only when all three hold: **K** a knowledge entry teaches it · **E** an eval case with a captured golden proves it · **T** the tool path can create/validate the artifact. Flags are derived from the live sources (`KNOWLEDGE_BASE`, `eval/cases`, the create/scaffold registry), so a deleted case or a renamed entry drops the number.

**core** = anything done at least once per project — the hard commitment. **total** = core plus exotics (license codes, XDS, aggregate measurements), a visible asymptote rather than a target.

| Tier | Covered | Leaves | % |
| --- | ---: | ---: | ---: |
| core | 44 | 44 | **100%** |
| total | 67 | 78 | 85.9% |

## Data model (12/12)

| Leaf | Tier | K | E | T | Evidence / gap |
| --- | --- | :-: | :-: | :-: | --- |
| Table | core | ✅ | ✅ | ✅ | L1-table-basic, L2-table-modify-lifecycle |
| Table extension | core | ✅ | ✅ | ✅ | L2-table-extension |
| Extended data type | core | ✅ | ✅ | ✅ | L0-edt-basic |
| EDT extension | total | ✅ | ✅ | ✅ | L2-edt-extension-basic |
| Base enum | core | ✅ | ✅ | ✅ | L0-enum-basic |
| Enum extension | core | ✅ | ✅ | ✅ | L2-enum-extension-empty-values |
| View | core | ✅ | ✅ | ✅ | L1-query-view-basic, L2-form-over-view |
| AOT query | core | ✅ | ✅ | ✅ | L1-query-view-basic |
| Map | total | ✅ | ✅ | ✅ | L1-map-basic |
| Temporary tables (TempDB / InMemory) | core | ✅ | ✅ | ✅ | L4-ssrs-report-basic |
| Relations, indexes, field groups | core | ✅ | ✅ | ✅ | L2-table-modify-lifecycle, L3-form-detailstransaction |
| Table inheritance (SupportInheritance/Extends) | total | ✅ | ✅ | ✅ | L2-table-inheritance-basic |

## Code (22/22)

| Leaf | Tier | K | E | T | Evidence / gap |
| --- | --- | :-: | :-: | :-: | --- |
| Class | core | ✅ | ✅ | ✅ | L1-class-basic, L2-class-method-ops |
| Interface / abstract class | core | ✅ | ✅ | ✅ | L2-interface-abstract-basic |
| Class inheritance (extends chain, virtual dispatch) | core | ✅ | ✅ | ✅ | L2-coc-inherited-method |
| Chain of Command extension | core | ✅ | ✅ | ✅ | L2-coc-extension |
| Event handler subscription | core | ✅ | ✅ | ✅ | L2-event-handler-basic |
| Delegate | core | ✅ | ✅ | ✅ | L2-delegate-basic |
| Macro | total | ✅ | ✅ | ✅ | L1-macro-library-flight |
| Transactions (ttsbegin/ttscommit) | core | ✅ | ✅ | ✅ | L2-class-method-ops, L2-form-modify-controls, L2-table-modify-lifecycle +2 |
| X++ select grammar | core | ✅ | ✅ | ✅ | L4-ssrs-report-advanced, L4-ssrs-report-basic |
| Set-based operations | core | ✅ | ✅ | ✅ | L4-ssrs-report-basic |
| SysDa fluent query API | total | ✅ | ✅ | ✅ | L2-sysda-fluent-query |
| Error handling & infolog | core | ✅ | ✅ | ✅ | L2-error-handling-infolog |
| SysExtension plug-in pattern | total | ✅ | ✅ | ✅ | L2-sysextension-plugin |
| Performance patterns | core | ✅ | ✅ | ✅ | L2-performance-set-based |
| Best-practice (BP) compliance | core | ✅ | ✅ | ✅ | L0-edt-basic, L0-enum-basic, L1-class-basic +36 |
| Deprecated APIs & migration | core | ✅ | ✅ | ✅ | L0-edt-basic, L0-enum-basic, L1-class-basic +36 |
| Optimistic concurrency & UnitOfWork | core | ✅ | ✅ | ✅ | L2-occ-retry-basic |
| Caching (CacheLookup, SysGlobalObjectCache, RecordViewCache) | total | ✅ | ✅ | ✅ | L2-table-caching-basic |
| X++ collections & containers (List/Map/Set/Struct) | total | ✅ | ✅ | ✅ | L2-collections-map-list-container |
| Date/time & time zones (utcdatetime, DateTimeUtil) | total | ✅ | ✅ | ✅ | L2-datetime-timezone-range |
| .NET interop (CLRInterop, using alias, CLRError) | total | ✅ | ✅ | ✅ | L2-dotnet-interop-clrerror |
| Reflection / Dict* metadata API | total | ✅ | ✅ | ✅ | L2-reflection-dict-fieldwalk |

## UI (7/7)

| Leaf | Tier | K | E | T | Evidence / gap |
| --- | --- | :-: | :-: | :-: | --- |
| Form | core | ✅ | ✅ | ✅ | L1-form-basic |
| Form patterns (ListPage, DetailsMaster, …) | core | ✅ | ✅ | ✅ | L1-form-detailsmaster, L1-form-dialog, L1-form-listpage +5 |
| Form extension | core | ✅ | ✅ | ✅ | L2-form-extension-basic |
| FormRun lifecycle & data sources | core | ✅ | ✅ | ✅ | L2-form-modify-controls, L3-form-add-datasource-lines |
| Menu items (display/action/output) | core | ✅ | ✅ | ✅ | L4-ssrs-report-advanced, L4-ssrs-report-multidataset |
| Menus & submenu nesting | core | ✅ | ✅ | ✅ | L4-master-security-slice |
| Tiles & KPIs | total | ✅ | ✅ | ✅ | L2-tile-cue-over-query |

## Reporting (2/4)

| Leaf | Tier | K | E | T | Evidence / gap |
| --- | --- | :-: | :-: | :-: | --- |
| SSRS report (DP + contract + controller) | core | ✅ | ✅ | ✅ | L4-ssrs-report-advanced, L4-ssrs-report-basic |
| Multi-dataset SSRS report | total | ✅ | ✅ | ✅ | L4-ssrs-report-multidataset |
| Print management | total | ✅ | — | ✅ | Eval case authored (document node + settings resolution); golden pending VM capture. |
| Electronic Reporting (ER) | total | ✅ | — | ✅ | Eval case authored for the X++ half (ER data provider); the ER model/mapping/format stay UI-configured and out of scope. Golden pending VM capture. |

## Frameworks (12/16)

| Leaf | Tier | K | E | T | Evidence / gap |
| --- | --- | :-: | :-: | :-: | --- |
| SysOperation / batch | core | ✅ | ✅ | ✅ | L3-batch-basic |
| Parallel batch processing | total | ✅ | — | ✅ | Eval case authored (BatchHeader runtime tasks); golden pending VM capture. |
| Async & retryable batch (BatchRetryable/runAsync) | total | ✅ | ✅ | ✅ | L3-batch-retryable-basic |
| Number sequences | core | ✅ | ✅ | ✅ | L2-numberseq-basic |
| Financial dimensions | core | ✅ | ✅ | ✅ | L2-dimension-basic |
| Posting engine (LedgerVoucher) | total | ✅ | — | ✅ | Eval case authored; it scores the STRUCTURE of the LedgerVoucher call chain, not a posted result (no ledger fixture). Golden pending VM capture. |
| Workflow | core | ✅ | ✅ | ✅ | L3-workflow-document-submit |
| Business events & alerts | core | ✅ | ✅ | ✅ | L2-business-event-basic |
| Feature management | total | ✅ | ✅ | ✅ | L2-feature-management-flight |
| Configuration keys | total | ✅ | ✅ | ✅ | L2-config-key-gated-table |
| Multi-company / changeCompany | core | ✅ | ✅ | ✅ | L2-multi-company-changecompany |
| Global address book | total | ✅ | ✅ | ✅ | L3-gab-party-postaladdress |
| Currency & exchange rates | total | ✅ | ✅ | ✅ | L3-currency-exchange-conversion |
| Inventory (InventTrans / InventDim) | total | ✅ | ✅ | ✅ | L3-inventory-inventdim-onhand |
| Warehouse management (WHS) | total | ✅ | — | ✅ | Eval case authored for the X++ half (work creation through the WHS framework); templates/directives stay configured data. Golden pending VM capture. |
| Trade agreements & pricing | total | ✅ | — | ✅ | Eval case authored (PriceDisc price/discount resolution); golden pending VM capture. |

## Integration (5/9)

| Leaf | Tier | K | E | T | Evidence / gap |
| --- | --- | :-: | :-: | :-: | --- |
| Data entity (OData) | core | ✅ | ✅ | ✅ | L4-entity-security |
| Data entity extension | total | ✅ | ✅ | ✅ | L3-data-entity-extension-field |
| Custom services / OData actions | core | ✅ | ✅ | ✅ | L3-custom-service-basic |
| Data management framework (DMF/DIXF) | total | ✅ | — | ✅ | Eval case authored (import-ready entity + staging hook); golden pending VM capture. |
| Dual-write (Dataverse) | total | ✅ | — | ✅ | Eval case authored for the AOT half (business key + change tracking); the dual-write map itself is UI-authored. Golden pending VM capture. |
| Power Platform / virtual entities | total | ✅ | — | ✅ | Eval case authored (entity marked up for virtual-entity exposure); golden pending VM capture. |
| Reading Excel / CSV files | total | ✅ | ✅ | ✅ | L3-file-csv-import |
| Direct SQL execution | total | ✅ | ✅ | ✅ | L2-direct-sql-connection |
| Aggregate measurements / analytics | total | ✅ | — | ✅ | Knowledge entry + create path added; eval case authored, golden pending VM capture. |

## Security (5/6)

| Leaf | Tier | K | E | T | Evidence / gap |
| --- | --- | :-: | :-: | :-: | --- |
| Security privilege | core | ✅ | ✅ | ✅ | L4-entity-security, L4-master-security-slice |
| Security duty | core | ✅ | ✅ | ✅ | L4-entity-security, L4-master-security-slice |
| Security role | core | ✅ | ✅ | ✅ | L4-entity-security, L4-master-security-slice |
| Data-entity security | core | ✅ | ✅ | ✅ | L4-entity-security |
| Extensible data security (XDS) | total | ✅ | — | ✅ | Create path added (d365fo_file objectType "security-policy"); eval case authored (policy + policy query + constrained table), golden pending VM capture. |
| License codes | total | ✅ | ✅ | ✅ | L2-license-code-configkey |

## Quality (2/2)

| Leaf | Tier | K | E | T | Evidence / gap |
| --- | --- | :-: | :-: | :-: | --- |
| SysTest unit testing | core | ✅ | ✅ | ✅ | L2-coc-extension, L2-event-handler-basic, L3-batch-basic |
| Labels & localisation | core | ✅ | ✅ | ✅ | L0-edt-basic, L0-enum-basic, L1-class-basic +36 |

## Closure queue (uncovered, by frequency weight)

| Weight | Leaf | Missing |
| ---: | --- | --- |
| 2 | Data management framework (DMF/DIXF) | missing E |
| 2 | Dual-write (Dataverse) | missing E |
| 2 | Parallel batch processing | missing E |
| 2 | Posting engine (LedgerVoucher) | missing E |
| 2 | Print management | missing E |
| 1 | Aggregate measurements / analytics | missing E |
| 1 | Electronic Reporting (ER) | missing E |
| 1 | Power Platform / virtual entities | missing E |
| 1 | Trade agreements & pricing | missing E |
| 1 | Warehouse management (WHS) | missing E |
| 1 | Extensible data security (XDS) | missing E |

## Orphans

- Knowledge entries no leaf claims (**unproven knowledge**): none
- Eval cases no leaf claims (**unmapped proof**): L2-oracle-discriminator-random-wrapper-name, L4-headerlines-document-slice

_Generated 2026-07-28._
