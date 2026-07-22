# Coverage — what "100%" means

<!-- GENERATED FILE — edit src/eval/coverage/taxonomy.ts, then run `npm run eval:coverage`. -->

A taxonomy leaf counts as covered only when all three hold: **K** a knowledge entry teaches it · **E** an eval case with a captured golden proves it · **T** the tool path can create/validate the artifact. Flags are derived from the live sources (`KNOWLEDGE_BASE`, `eval/cases`, the create/scaffold registry), so a deleted case or a renamed entry drops the number.

**core** = anything done at least once per project — the hard commitment. **total** = core plus exotics (license codes, XDS, aggregate measurements), a visible asymptote rather than a target.

| Tier | Covered | Leaves | % |
| --- | ---: | ---: | ---: |
| core | 43 | 43 | **100%** |
| total | 46 | 77 | 59.7% |

## Data model (11/12)

| Leaf | Tier | K | E | T | Evidence / gap |
| --- | --- | :-: | :-: | :-: | --- |
| Table | core | ✅ | ✅ | ✅ | L1-table-basic, L2-table-modify-lifecycle |
| Table extension | core | ✅ | ✅ | ✅ | L2-table-extension |
| Extended data type | core | ✅ | ✅ | ✅ | L0-edt-basic |
| EDT extension | total | ✅ | — | ✅ | No eval case yet — EDT extensions are rare in custom-model work. |
| Base enum | core | ✅ | ✅ | ✅ | L0-enum-basic |
| Enum extension | core | ✅ | ✅ | ✅ | L2-enum-extension-empty-values |
| View | core | ✅ | ✅ | ✅ | L1-query-view-basic, L2-form-over-view |
| AOT query | core | ✅ | ✅ | ✅ | L1-query-view-basic |
| Map | total | ✅ | ✅ | ✅ | L1-map-basic |
| Temporary tables (TempDB / InMemory) | core | ✅ | ✅ | ✅ | L4-ssrs-report-basic |
| Relations, indexes, field groups | core | ✅ | ✅ | ✅ | L2-table-modify-lifecycle, L3-form-detailstransaction |
| Table inheritance (SupportInheritance/Extends) | total | ✅ | ✅ | ✅ | L2-table-inheritance-basic |

## Code (14/21)

| Leaf | Tier | K | E | T | Evidence / gap |
| --- | --- | :-: | :-: | :-: | --- |
| Class | core | ✅ | ✅ | ✅ | L1-class-basic |
| Interface / abstract class | core | ✅ | ✅ | ✅ | L2-interface-abstract-basic |
| Chain of Command extension | core | ✅ | ✅ | ✅ | L2-coc-extension |
| Event handler subscription | core | ✅ | ✅ | ✅ | L2-event-handler-basic |
| Delegate | core | ✅ | ✅ | ✅ | L2-delegate-basic |
| Macro | total | — | — | — | Neither knowledge nor case: macros are legacy and discouraged in new code. |
| Transactions (ttsbegin/ttscommit) | core | ✅ | ✅ | ✅ | L2-form-modify-controls, L2-table-modify-lifecycle, L3-form-add-datasource-lines +1 |
| X++ select grammar | core | ✅ | ✅ | ✅ | L4-ssrs-report-advanced, L4-ssrs-report-basic |
| Set-based operations | core | ✅ | ✅ | ✅ | L4-ssrs-report-basic |
| SysDa fluent query API | total | ✅ | — | ✅ | Knowledge only — no eval case; SysDa is rare outside platform code. |
| Error handling & infolog | core | ✅ | ✅ | ✅ | L2-error-handling-infolog |
| SysExtension plug-in pattern | total | ✅ | — | ✅ | Knowledge only — no eval case yet. |
| Performance patterns | core | ✅ | ✅ | ✅ | L2-performance-set-based |
| Best-practice (BP) compliance | core | ✅ | ✅ | ✅ | L0-edt-basic, L0-enum-basic, L1-class-basic +22 |
| Deprecated APIs & migration | core | ✅ | ✅ | ✅ | L0-edt-basic, L0-enum-basic, L1-class-basic +22 |
| Optimistic concurrency & UnitOfWork | core | ✅ | ✅ | ✅ | L2-occ-retry-basic |
| Caching (CacheLookup, SysGlobalObjectCache, RecordViewCache) | total | ✅ | ✅ | ✅ | L2-table-caching-basic |
| X++ collections & containers (List/Map/Set/Struct) | total | — | — | ✅ | Known hole (audit 2026-07-20, C6): no knowledge entry and no eval case yet. |
| Date/time & time zones (utcdatetime, DateTimeUtil) | total | — | — | ✅ | Known hole (audit 2026-07-20, C7): scattered across bp-rules/deprecated; no dedicated knowledge entry or case. |
| .NET interop (CLRInterop, using alias, CLRError) | total | — | — | ✅ | Known hole (audit 2026-07-20, C8): no dedicated knowledge entry and no eval case. |
| Reflection / Dict* metadata API | total | — | — | ✅ | Known hole (audit 2026-07-20, C9): no dedicated knowledge entry and no eval case. |

## UI (6/7)

| Leaf | Tier | K | E | T | Evidence / gap |
| --- | --- | :-: | :-: | :-: | --- |
| Form | core | ✅ | ✅ | ✅ | L1-form-basic |
| Form patterns (ListPage, DetailsMaster, …) | core | ✅ | ✅ | ✅ | L1-form-detailsmaster, L1-form-dialog, L1-form-listpage +5 |
| Form extension | core | ✅ | ✅ | ✅ | L2-form-extension-basic |
| FormRun lifecycle & data sources | core | ✅ | ✅ | ✅ | L2-form-modify-controls, L3-form-add-datasource-lines |
| Menu items (display/action/output) | core | ✅ | ✅ | ✅ | L4-ssrs-report-advanced |
| Menus & submenu nesting | core | ✅ | ✅ | ✅ | L4-master-security-slice |
| Tiles & KPIs | total | — | — | ✅ | Deliberately deprioritised (roadmap P3): no knowledge, no case — rare in custom-model work. |

## Reporting (1/4)

| Leaf | Tier | K | E | T | Evidence / gap |
| --- | --- | :-: | :-: | :-: | --- |
| SSRS report (DP + contract + controller) | core | ✅ | ✅ | ✅ | L4-ssrs-report-advanced, L4-ssrs-report-basic |
| Multi-dataset SSRS report | total | ✅ | — | ✅ | missing E |
| Print management | total | ✅ | — | ✅ | Knowledge only — no eval case yet. |
| Electronic Reporting (ER) | total | ✅ | — | ✅ | Knowledge only — ER artifacts are configured in the UI, not authored in the AOT. |

## Frameworks (6/16)

| Leaf | Tier | K | E | T | Evidence / gap |
| --- | --- | :-: | :-: | :-: | --- |
| SysOperation / batch | core | ✅ | ✅ | ✅ | L3-batch-basic |
| Parallel batch processing | total | ✅ | — | ✅ | Knowledge only — no eval case yet. |
| Async & retryable batch (BatchRetryable/runAsync) | total | ✅ | — | ✅ | Eval case authored (L3-batch-retryable-basic) — golden capture pending on the VM. |
| Number sequences | core | ✅ | ✅ | ✅ | L2-numberseq-basic |
| Financial dimensions | core | ✅ | ✅ | ✅ | L2-dimension-basic |
| Posting engine (LedgerVoucher) | total | ✅ | — | ✅ | Knowledge only — posting cannot be scored without a full ledger fixture. |
| Workflow | core | ✅ | ✅ | ✅ | L3-workflow-document-submit |
| Business events & alerts | core | ✅ | ✅ | ✅ | L2-business-event-basic |
| Feature management | total | ✅ | — | ✅ | Knowledge only — no eval case yet. |
| Configuration keys | total | ✅ | — | — | Knowledge only — no eval case yet. |
| Multi-company / changeCompany | core | ✅ | ✅ | ✅ | L2-multi-company-changecompany |
| Global address book | total | ✅ | — | ✅ | Knowledge only — no eval case yet. |
| Currency & exchange rates | total | ✅ | — | ✅ | Knowledge only — no eval case yet. |
| Inventory (InventTrans / InventDim) | total | ✅ | — | ✅ | Knowledge only — no eval case yet. |
| Warehouse management (WHS) | total | ✅ | — | ✅ | Knowledge only — no eval case yet. |
| Trade agreements & pricing | total | ✅ | — | ✅ | Knowledge only — no eval case yet. |

## Integration (2/9)

| Leaf | Tier | K | E | T | Evidence / gap |
| --- | --- | :-: | :-: | :-: | --- |
| Data entity (OData) | core | ✅ | ✅ | ✅ | L4-entity-security |
| Data entity extension | total | ✅ | — | ✅ | No eval case yet. |
| Custom services / OData actions | core | ✅ | ✅ | ✅ | L3-custom-service-basic |
| Data management framework (DMF/DIXF) | total | ✅ | — | ✅ | Knowledge only — deeper DMF coverage is a known hole. |
| Dual-write (Dataverse) | total | ✅ | — | ✅ | Knowledge only — no eval case yet. |
| Power Platform / virtual entities | total | ✅ | — | ✅ | Knowledge only — no eval case yet. |
| Reading Excel / CSV files | total | ✅ | — | ✅ | Knowledge only — no eval case yet. |
| Direct SQL execution | total | ✅ | — | ✅ | Knowledge only — direct SQL is an escape hatch, deliberately not exercised. |
| Aggregate measurements / analytics | total | — | — | — | Known hole (roadmap P3): no knowledge, no case, no tool path. |

## Security (4/6)

| Leaf | Tier | K | E | T | Evidence / gap |
| --- | --- | :-: | :-: | :-: | --- |
| Security privilege | core | ✅ | ✅ | ✅ | L4-entity-security, L4-master-security-slice |
| Security duty | core | ✅ | ✅ | ✅ | L4-entity-security, L4-master-security-slice |
| Security role | core | ✅ | ✅ | ✅ | L4-entity-security, L4-master-security-slice |
| Data-entity security | core | ✅ | ✅ | ✅ | L4-entity-security |
| Extensible data security (XDS) | total | ✅ | — | — | Overview only in the security topic — deep XDS authoring (policy, context, XDS() query method) and an eval case remain a known hole. |
| License codes | total | — | — | — | Exotic — ISV licensing only. The visible asymptote of the "total" tier. |

## Quality (2/2)

| Leaf | Tier | K | E | T | Evidence / gap |
| --- | --- | :-: | :-: | :-: | --- |
| SysTest unit testing | core | ✅ | ✅ | ✅ | L2-coc-extension, L2-event-handler-basic, L3-batch-basic |
| Labels & localisation | core | ✅ | ✅ | ✅ | L0-edt-basic, L0-enum-basic, L1-class-basic +22 |

## Closure queue (uncovered, by frequency weight)

| Weight | Leaf | Missing |
| ---: | --- | --- |
| 3 | Date/time & time zones (utcdatetime, DateTimeUtil) | missing K+E |
| 3 | Inventory (InventTrans / InventDim) | missing E |
| 3 | X++ collections & containers (List/Map/Set/Struct) | missing K+E |
| 2 | Async & retryable batch (BatchRetryable/runAsync) | missing E |
| 2 | Configuration keys | missing E+T |
| 2 | Currency & exchange rates | missing E |
| 2 | Data entity extension | missing E |
| 2 | Data management framework (DMF/DIXF) | missing E |
| 2 | .NET interop (CLRInterop, using alias, CLRError) | missing K+E |
| 2 | Dual-write (Dataverse) | missing E |
| 2 | EDT extension | missing E |
| 2 | Feature management | missing E |
| 2 | Reading Excel / CSV files | missing E |
| 2 | Global address book | missing E |
| 2 | Parallel batch processing | missing E |
| 2 | Posting engine (LedgerVoucher) | missing E |
| 2 | Print management | missing E |
| 2 | Reflection / Dict* metadata API | missing K+E |
| 2 | Multi-dataset SSRS report | missing E |
| 2 | SysExtension plug-in pattern | missing E |
| 1 | Aggregate measurements / analytics | missing K+E+T |
| 1 | Direct SQL execution | missing E |
| 1 | Electronic Reporting (ER) | missing E |
| 1 | Macro | missing K+E+T |
| 1 | Power Platform / virtual entities | missing E |
| 1 | SysDa fluent query API | missing E |
| 1 | Tiles & KPIs | missing K+E |
| 1 | Trade agreements & pricing | missing E |
| 1 | Warehouse management (WHS) | missing E |
| 1 | Extensible data security (XDS) | missing E+T |
| 0 | License codes | missing K+E+T |

## Orphans

- Knowledge entries no leaf claims (**unproven knowledge**): none
- Eval cases no leaf claims (**unmapped proof**): L2-oracle-discriminator-random-wrapper-name, L4-headerlines-document-slice

_Generated 2026-07-22._
