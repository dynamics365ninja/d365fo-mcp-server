/**
 * Coverage taxonomy (ROADMAP P2) — the definition of "100%".
 *
 * Three sources, per the roadmap:
 *  1. AOT element types the metadata parser knows about — the mechanically
 *     complete list of everything developable (`source: 'aot'`). The
 *     `aotTypes` of these leaves are the internal type names used by the
 *     symbol index and by d365fo_file/generate_object, so the T flag can be
 *     derived rather than asserted.
 *  2. Cross-cutting X++ development topics that are not AOT elements
 *     (transactions, CoC rules, performance, …) — `source: 'topic'`.
 *  3. Real-world frequency `weight` (0–5): how often a leaf shows up in
 *     customization work. Weights order the P7 closure queue; they are not
 *     used to fudge the percentage.
 *
 * Two published tiers:
 *  - **core**  — anything done at least once per project. A hard commitment;
 *                core coverage is the number we defend publicly.
 *  - **total** — includes exotics (license codes, aggregate measurements).
 *                A visible asymptote, so the metric neither corrupts
 *                (by excluding what is merely hard) nor demotivates.
 *
 * A leaf is covered when K ∧ E ∧ T:
 *   K — a KNOWLEDGE_BASE entry teaches it        (matched via knowledgeIds)
 *   E — a green eval case exercises it           (matched via caseIds/caseTags)
 *   T — the tool path can create/validate it     (matched via aotTypes)
 * The matchers below are *declared here*; the flags themselves are computed
 * from the live sources in coverage.ts, so a deleted case or knowledge entry
 * drops the number instead of going unnoticed.
 */

export type CoverageTier = 'core' | 'total';
export type CoverageSource = 'aot' | 'topic';

export interface CoverageLeaf {
  /** Stable id, kebab-case. Appears in COVERAGE.md and coverage.json. */
  id: string;
  /** Human-readable leaf name. */
  label: string;
  /** Grouping for the per-domain table. */
  domain: string;
  source: CoverageSource;
  tier: CoverageTier;
  /** Real-world frequency weight, 0 (exotic) – 5 (every project). */
  weight: number;
  /**
   * Internal AOT type names this leaf covers. A leaf is T-covered when at
   * least one of them is creatable through the tool path.
   */
  aotTypes?: string[];
  /** KNOWLEDGE_BASE entry ids that teach this leaf (K). */
  knowledgeIds?: string[];
  /** Eval case ids that prove it (E). Exact ids — a rename must show up. */
  caseIds?: string[];
  /** …or any case carrying all of these tags (E). */
  caseTags?: string[];
  /** Why this leaf is deprioritised / what is missing. Shown in COVERAGE.md. */
  note?: string;
}

export const TAXONOMY: CoverageLeaf[] = [
  // ── Data model ──────────────────────────────────────────────────────────
  {
    id: 'table', label: 'Table', domain: 'Data model', source: 'aot', tier: 'core', weight: 5,
    aotTypes: ['table'], knowledgeIds: ['xpp-class-rules'], caseIds: ['L1-table-basic', 'L2-table-modify-lifecycle'],
  },
  {
    id: 'table-extension', label: 'Table extension', domain: 'Data model', source: 'aot', tier: 'core', weight: 5,
    aotTypes: ['table-extension'], knowledgeIds: ['coc'], caseIds: ['L2-table-extension'],
  },
  {
    id: 'edt', label: 'Extended data type', domain: 'Data model', source: 'aot', tier: 'core', weight: 5,
    aotTypes: ['edt'], knowledgeIds: ['xpp-class-rules'], caseIds: ['L0-edt-basic'],
  },
  {
    id: 'edt-extension', label: 'EDT extension', domain: 'Data model', source: 'aot', tier: 'total', weight: 2,
    aotTypes: ['edt-extension'], knowledgeIds: ['coc'],
    caseIds: ['L2-edt-extension-basic'],
    note: 'Eval case authored (EDT + EDT extension via PropertyModifications); golden pending VM capture.',
  },
  {
    id: 'enum', label: 'Base enum', domain: 'Data model', source: 'aot', tier: 'core', weight: 5,
    aotTypes: ['enum'], knowledgeIds: ['xpp-class-rules'], caseIds: ['L0-enum-basic'],
  },
  {
    id: 'enum-extension', label: 'Enum extension', domain: 'Data model', source: 'aot', tier: 'core', weight: 4,
    aotTypes: ['enum-extension'], knowledgeIds: ['coc'],
    caseIds: ['L2-enum-extension-empty-values', 'L2-enum-modify-values'],
  },
  {
    id: 'view', label: 'View', domain: 'Data model', source: 'aot', tier: 'core', weight: 3,
    aotTypes: ['view'], knowledgeIds: ['query-patterns'], caseIds: ['L1-query-view-basic', 'L2-form-over-view'],
  },
  {
    id: 'query', label: 'AOT query', domain: 'Data model', source: 'aot', tier: 'core', weight: 4,
    aotTypes: ['query'], knowledgeIds: ['query-object-model', 'query-patterns'], caseIds: ['L1-query-view-basic'],
  },
  {
    id: 'map', label: 'Map', domain: 'Data model', source: 'aot', tier: 'total', weight: 2,
    aotTypes: ['map'], knowledgeIds: ['xpp-class-rules'], caseIds: ['L1-map-basic'],
  },
  {
    id: 'temp-tables', label: 'Temporary tables (TempDB / InMemory)', domain: 'Data model', source: 'topic', tier: 'core', weight: 4,
    aotTypes: ['table'], knowledgeIds: ['temp-tables'], caseTags: ['temptable'],
  },
  {
    id: 'relations-indexes', label: 'Relations, indexes, field groups', domain: 'Data model', source: 'topic', tier: 'core', weight: 5,
    aotTypes: ['table'], knowledgeIds: ['xpp-class-rules'], caseTags: ['relation'],
  },
  {
    id: 'table-inheritance', label: 'Table inheritance (SupportInheritance/Extends)', domain: 'Data model', source: 'topic', tier: 'total', weight: 2,
    aotTypes: ['table'], knowledgeIds: ['table-inheritance'], caseIds: ['L2-table-inheritance-basic'],
    note: 'Golden captured on the Contoso VM (2026-07-20).',
  },

  // ── Code ────────────────────────────────────────────────────────────────
  {
    id: 'class', label: 'Class', domain: 'Code', source: 'aot', tier: 'core', weight: 5,
    aotTypes: ['class'], knowledgeIds: ['xpp-class-rules'], caseIds: ['L1-class-basic', 'L2-class-method-ops'],
  },
  {
    id: 'interface', label: 'Interface / abstract class', domain: 'Code', source: 'aot', tier: 'core', weight: 3,
    aotTypes: ['class'], knowledgeIds: ['xpp-class-rules'], caseIds: ['L2-interface-abstract-basic'],
  },
  {
    id: 'coc-extension', label: 'Chain of Command extension', domain: 'Code', source: 'aot', tier: 'core', weight: 5,
    aotTypes: ['class-extension'], knowledgeIds: ['coc', 'coc-authoring'], caseIds: ['L2-coc-extension'],
  },
  {
    id: 'event-handler', label: 'Event handler subscription', domain: 'Code', source: 'topic', tier: 'core', weight: 5,
    aotTypes: ['class'], knowledgeIds: ['event-handlers'], caseIds: ['L2-event-handler-basic'],
  },
  {
    id: 'delegate', label: 'Delegate', domain: 'Code', source: 'topic', tier: 'core', weight: 3,
    aotTypes: ['class'], knowledgeIds: ['event-handlers'], caseIds: ['L2-delegate-basic'],
  },
  {
    id: 'macro', label: 'Macro', domain: 'Code', source: 'aot', tier: 'total', weight: 1,
    aotTypes: ['macro'], knowledgeIds: ['macros'], caseIds: ['L1-macro-library-flight'],
    note: 'Knowledge entry teaches the legacy status and the modern replacement; eval case authored, golden pending VM capture.',
  },
  {
    id: 'transactions', label: 'Transactions (ttsbegin/ttscommit)', domain: 'Code', source: 'topic', tier: 'core', weight: 5,
    aotTypes: ['class'], knowledgeIds: ['transactions'], caseTags: ['modify'],
  },
  {
    id: 'select-grammar', label: 'X++ select grammar', domain: 'Code', source: 'topic', tier: 'core', weight: 5,
    aotTypes: ['class'], knowledgeIds: ['select-statement', 'query-patterns'],
    caseIds: ['L4-ssrs-report-basic', 'L4-ssrs-report-advanced'],
  },
  {
    id: 'set-based', label: 'Set-based operations', domain: 'Code', source: 'topic', tier: 'core', weight: 4,
    aotTypes: ['class'], knowledgeIds: ['set-based'], caseIds: ['L4-ssrs-report-basic'],
  },
  {
    id: 'sysda', label: 'SysDa fluent query API', domain: 'Code', source: 'topic', tier: 'total', weight: 1,
    aotTypes: ['class'], knowledgeIds: ['sysda'],
    caseIds: ['L2-sysda-fluent-query'],
    note: 'Eval case authored (SysDa fluent select); golden pending VM capture.',
  },
  {
    id: 'error-handling', label: 'Error handling & infolog', domain: 'Code', source: 'topic', tier: 'core', weight: 5,
    aotTypes: ['class'], knowledgeIds: ['error-handling', 'telemetry'],
    caseIds: ['L2-error-handling-infolog'],
    note: 'Case authored (checkFailed validation + typed catches + exceptionTextFallThrough + infolog capture); golden pending VM capture.',
  },
  {
    id: 'sysextension', label: 'SysExtension plug-in pattern', domain: 'Code', source: 'topic', tier: 'total', weight: 2,
    aotTypes: ['class'], knowledgeIds: ['sysextension'],
    caseIds: ['L2-sysextension-plugin'],
    note: 'Eval case authored (attribute-driven SysExtension factory); golden pending VM capture.',
  },
  {
    id: 'performance', label: 'Performance patterns', domain: 'Code', source: 'topic', tier: 'core', weight: 4,
    aotTypes: ['class'], knowledgeIds: ['performance', 'set-based'],
    caseIds: ['L2-performance-set-based'],
    note: 'Case authored; it asserts a STRUCTURAL performance property (insert_recordset / RecordInsertList / firstonly / delete_from instead of row-by-row) rather than a wall-clock measurement, which is not reproducible across VM load. Golden pending VM capture.',
  },
  {
    id: 'bp-rules', label: 'Best-practice (BP) compliance', domain: 'Code', source: 'topic', tier: 'core', weight: 4,
    aotTypes: ['class'], knowledgeIds: ['bp-rules'], caseTags: ['deterministic'],
  },
  {
    id: 'deprecated-apis', label: 'Deprecated APIs & migration', domain: 'Code', source: 'topic', tier: 'core', weight: 3,
    aotTypes: ['class'], knowledgeIds: ['deprecated'], caseTags: ['deterministic'],
  },
  {
    id: 'occ-unitofwork', label: 'Optimistic concurrency & UnitOfWork', domain: 'Code', source: 'topic', tier: 'core', weight: 4,
    aotTypes: ['class'], knowledgeIds: ['occ-unitofwork'], caseIds: ['L2-occ-retry-basic'],
    note: 'Golden captured on the Contoso VM (2026-07-20).',
  },
  {
    id: 'caching', label: 'Caching (CacheLookup, SysGlobalObjectCache, RecordViewCache)', domain: 'Code', source: 'topic', tier: 'total', weight: 3,
    aotTypes: ['class', 'table'], knowledgeIds: ['caching'], caseIds: ['L2-table-caching-basic'],
    note: 'Golden captured on the Contoso VM (2026-07-20).',
  },
  {
    id: 'xpp-collections', label: 'X++ collections & containers (List/Map/Set/Struct)', domain: 'Code', source: 'topic', tier: 'total', weight: 3,
    aotTypes: ['class'], knowledgeIds: ['xpp-collections'], caseIds: ['L2-collections-map-list-container'],
    note: 'Knowledge entry written (audit hole C6 closed); eval case authored, golden pending VM capture.',
  },
  {
    id: 'datetime-timezones', label: 'Date/time & time zones (utcdatetime, DateTimeUtil)', domain: 'Code', source: 'topic', tier: 'total', weight: 3,
    aotTypes: ['class'], knowledgeIds: ['datetime-timezones'], caseIds: ['L2-datetime-timezone-range'],
    note: 'Knowledge entry written (audit hole C7 closed); eval case authored, golden pending VM capture.',
  },
  {
    id: 'dotnet-interop', label: '.NET interop (CLRInterop, using alias, CLRError)', domain: 'Code', source: 'topic', tier: 'total', weight: 2,
    aotTypes: ['class'], knowledgeIds: ['dotnet-interop'], caseIds: ['L2-dotnet-interop-clrerror'],
    note: 'Knowledge entry written (audit hole C8 closed); eval case authored, golden pending VM capture.',
  },
  {
    id: 'reflection-dict', label: 'Reflection / Dict* metadata API', domain: 'Code', source: 'topic', tier: 'total', weight: 2,
    aotTypes: ['class'], knowledgeIds: ['reflection-dict'], caseIds: ['L2-reflection-dict-fieldwalk'],
    note: 'Knowledge entry written (audit hole C9 closed); eval case authored, golden pending VM capture.',
  },

  // ── UI ──────────────────────────────────────────────────────────────────
  {
    id: 'form', label: 'Form', domain: 'UI', source: 'aot', tier: 'core', weight: 5,
    aotTypes: ['form'], knowledgeIds: ['form-patterns'], caseIds: ['L1-form-basic'],
  },
  {
    id: 'form-patterns', label: 'Form patterns (ListPage, DetailsMaster, …)', domain: 'UI', source: 'topic', tier: 'core', weight: 5,
    aotTypes: ['form'], knowledgeIds: ['form-patterns'],
    caseIds: [
      'L1-form-listpage', 'L1-form-detailsmaster', 'L1-form-simplelistdetails',
      'L1-form-tableofcontents', 'L1-form-workspace', 'L1-form-lookup',
      'L1-form-dialog', 'L3-form-detailstransaction',
    ],
  },
  {
    id: 'form-extension', label: 'Form extension', domain: 'UI', source: 'aot', tier: 'core', weight: 5,
    aotTypes: ['form-extension'], knowledgeIds: ['form-patterns', 'coc'], caseIds: ['L2-form-extension-basic'],
  },
  {
    id: 'form-lifecycle', label: 'FormRun lifecycle & data sources', domain: 'UI', source: 'topic', tier: 'core', weight: 5,
    aotTypes: ['form'], knowledgeIds: ['formrun-lifecycle'],
    caseIds: ['L2-form-modify-controls', 'L3-form-add-datasource-lines'],
  },
  {
    id: 'menu-item', label: 'Menu items (display/action/output)', domain: 'UI', source: 'aot', tier: 'core', weight: 5,
    aotTypes: ['menu-item-display', 'menu-item-action', 'menu-item-output'],
    knowledgeIds: ['menu-navigation'], caseTags: ['menu-item-output'],
  },
  {
    id: 'menu', label: 'Menus & submenu nesting', domain: 'UI', source: 'aot', tier: 'core', weight: 3,
    aotTypes: ['menu', 'menu-extension'], knowledgeIds: ['menu-navigation'], caseTags: ['menu'],
  },
  {
    id: 'tiles-kpis', label: 'Tiles & KPIs', domain: 'UI', source: 'aot', tier: 'total', weight: 1,
    aotTypes: ['tile', 'kpi'], knowledgeIds: ['tiles-kpis'], caseIds: ['L2-tile-cue-over-query'],
    note: 'Knowledge entry written; eval case authored (count tile over an AOT query), golden pending VM capture.',
  },

  // ── Reporting ───────────────────────────────────────────────────────────
  {
    id: 'ssrs-report', label: 'SSRS report (DP + contract + controller)', domain: 'Reporting', source: 'aot', tier: 'core', weight: 4,
    aotTypes: ['report'], knowledgeIds: ['ssrs-reports'],
    caseIds: ['L4-ssrs-report-basic', 'L4-ssrs-report-advanced'],
  },
  {
    id: 'ssrs-multidataset', label: 'Multi-dataset SSRS report', domain: 'Reporting', source: 'topic', tier: 'total', weight: 2,
    aotTypes: ['report'], knowledgeIds: ['ssrs-reports'], caseIds: ['L4-ssrs-report-multidataset'],
  },
  {
    id: 'print-management', label: 'Print management', domain: 'Reporting', source: 'topic', tier: 'total', weight: 2,
    aotTypes: ['report'], knowledgeIds: ['print-management'],
    caseIds: ['L3-print-management-report'],
    note: 'Eval case authored (document node + settings resolution); golden pending VM capture.',
  },
  {
    id: 'electronic-reporting', label: 'Electronic Reporting (ER)', domain: 'Reporting', source: 'topic', tier: 'total', weight: 1,
    aotTypes: ['class'], knowledgeIds: ['electronic-reporting'],
    caseIds: ['L3-electronic-reporting-integration'],
    note: 'Eval case authored for the X++ half (ER data provider); the ER model/mapping/format stay UI-configured and out of scope. Golden pending VM capture.',
  },

  // ── Business logic frameworks ───────────────────────────────────────────
  {
    id: 'sysoperation', label: 'SysOperation / batch', domain: 'Frameworks', source: 'topic', tier: 'core', weight: 5,
    aotTypes: ['class'], knowledgeIds: ['sysoperation'], caseIds: ['L3-batch-basic'],
  },
  {
    id: 'parallel-batch', label: 'Parallel batch processing', domain: 'Frameworks', source: 'topic', tier: 'total', weight: 2,
    aotTypes: ['class'], knowledgeIds: ['parallel-batch'],
    caseIds: ['L3-parallel-batch-tasks'],
    note: 'Eval case authored (BatchHeader runtime tasks); golden pending VM capture.',
  },
  {
    id: 'async-retryable-batch', label: 'Async & retryable batch (BatchRetryable/runAsync)', domain: 'Frameworks', source: 'topic', tier: 'total', weight: 2,
    aotTypes: ['class'], knowledgeIds: ['async-retryable-batch'], caseIds: ['L3-batch-retryable-basic'],
    note: 'Eval case authored (L3-batch-retryable-basic) — golden capture pending on the VM.',
  },
  {
    id: 'number-sequences', label: 'Number sequences', domain: 'Frameworks', source: 'topic', tier: 'core', weight: 5,
    aotTypes: ['class'], knowledgeIds: ['number-sequences'],
    caseIds: ['L2-numberseq-basic', 'L3-numberseq-module-slice'],
  },
  {
    id: 'financial-dimensions', label: 'Financial dimensions', domain: 'Frameworks', source: 'topic', tier: 'core', weight: 4,
    aotTypes: ['class'], knowledgeIds: ['financial-dimensions'], caseIds: ['L2-dimension-basic'],
  },
  {
    id: 'posting-engine', label: 'Posting engine (LedgerVoucher)', domain: 'Frameworks', source: 'topic', tier: 'total', weight: 2,
    aotTypes: ['class'], knowledgeIds: ['posting-engine'],
    caseIds: ['L4-posting-ledgervoucher-slice'],
    note: 'Eval case authored; it scores the STRUCTURE of the LedgerVoucher call chain, not a posted result (no ledger fixture). Golden pending VM capture.',
  },
  {
    id: 'workflow', label: 'Workflow', domain: 'Frameworks', source: 'topic', tier: 'core', weight: 3,
    aotTypes: ['class'], knowledgeIds: ['workflow'],
    caseIds: ['L3-workflow-document-submit'],
    note: 'Case authored for the X++/tool-path-reachable half (WorkflowDocument subclass + query, canSubmitToWorkflow, submit manager, action menu item). The AxWorkflowType/Approval/Category AOT elements stay uncovered: d365fo_file has no objectType for them. Golden pending VM capture.',
  },
  {
    id: 'business-events', label: 'Business events & alerts', domain: 'Frameworks', source: 'topic', tier: 'core', weight: 3,
    aotTypes: ['business-event'], knowledgeIds: ['alerts-business-events'], caseIds: ['L2-business-event-basic'],
  },
  {
    id: 'feature-management', label: 'Feature management', domain: 'Frameworks', source: 'topic', tier: 'total', weight: 2,
    aotTypes: ['class'], knowledgeIds: ['feature-management'],
    caseIds: ['L2-feature-management-flight'],
    note: 'Eval case authored (IFeatureMetadata + FeatureStateProvider branch); golden pending VM capture.',
  },
  {
    id: 'configuration-keys', label: 'Configuration keys', domain: 'Frameworks', source: 'aot', tier: 'total', weight: 2,
    aotTypes: ['configuration-key'], knowledgeIds: ['configuration-keys'],
    caseIds: ['L2-config-key-gated-table'],
    note: 'Create path added (d365fo_file objectType "configuration-key"); eval case authored, golden pending VM capture.',
  },
  {
    id: 'multi-company', label: 'Multi-company / changeCompany', domain: 'Frameworks', source: 'topic', tier: 'core', weight: 3,
    aotTypes: ['class'], knowledgeIds: ['multi-company'],
    caseIds: ['L2-multi-company-changecompany'],
    note: 'Case authored (changeCompany block + crosscompany select over a company container); golden pending VM capture.',
  },
  {
    id: 'global-address-book', label: 'Global address book', domain: 'Frameworks', source: 'topic', tier: 'total', weight: 2,
    aotTypes: ['class'], knowledgeIds: ['global-address-book'],
    caseIds: ['L3-gab-party-postaladdress'],
    note: 'Eval case authored (party + primary postal address through the DirParty API); golden pending VM capture.',
  },
  {
    id: 'currency', label: 'Currency & exchange rates', domain: 'Frameworks', source: 'topic', tier: 'total', weight: 2,
    aotTypes: ['class'], knowledgeIds: ['currency-exchange-rates'],
    caseIds: ['L3-currency-exchange-conversion'],
    note: 'Eval case authored (exchange-rate helper conversion + currency rounding); golden pending VM capture.',
  },
  {
    id: 'inventory', label: 'Inventory (InventTrans / InventDim)', domain: 'Frameworks', source: 'topic', tier: 'total', weight: 3,
    aotTypes: ['class'], knowledgeIds: ['inventory-management'],
    caseIds: ['L3-inventory-inventdim-onhand'],
    note: 'Eval case authored (InventDim/InventDimParm on-hand read); golden pending VM capture.',
  },
  {
    id: 'warehouse', label: 'Warehouse management (WHS)', domain: 'Frameworks', source: 'topic', tier: 'total', weight: 1,
    aotTypes: ['class'], knowledgeIds: ['warehouse-management'],
    caseIds: ['L3-warehouse-work-slice'],
    note: 'Eval case authored for the X++ half (work creation through the WHS framework); templates/directives stay configured data. Golden pending VM capture.',
  },
  {
    id: 'trade-agreements', label: 'Trade agreements & pricing', domain: 'Frameworks', source: 'topic', tier: 'total', weight: 1,
    aotTypes: ['class'], knowledgeIds: ['trade-agreements'],
    caseIds: ['L3-trade-agreement-price-lookup'],
    note: 'Eval case authored (PriceDisc price/discount resolution); golden pending VM capture.',
  },

  // ── Integration ─────────────────────────────────────────────────────────
  {
    id: 'data-entity', label: 'Data entity (OData)', domain: 'Integration', source: 'aot', tier: 'core', weight: 5,
    aotTypes: ['data-entity'], knowledgeIds: ['data-entities'],
    caseIds: ['L4-entity-security', 'L4-bridge-drops-data-entity-primarytable-fields-on-create'],
  },
  {
    id: 'data-entity-extension', label: 'Data entity extension', domain: 'Integration', source: 'aot', tier: 'total', weight: 2,
    aotTypes: ['data-entity-extension'], knowledgeIds: ['data-entities'],
    caseIds: ['L3-data-entity-extension-field'],
    note: 'Eval case authored (table extension field surfaced on a standard entity); golden pending VM capture.',
  },
  {
    id: 'custom-service', label: 'Custom services / OData actions', domain: 'Integration', source: 'aot', tier: 'core', weight: 3,
    aotTypes: ['service', 'service-group'], knowledgeIds: ['custom-services'], caseIds: ['L3-custom-service-basic'],
    note: 'Knowledge + eval case authored (L3-custom-service-basic, golden pending); full create/validate tool path for services still pending.',
  },
  {
    id: 'dmf', label: 'Data management framework (DMF/DIXF)', domain: 'Integration', source: 'topic', tier: 'total', weight: 2,
    aotTypes: ['class'], knowledgeIds: ['data-management-framework'],
    caseIds: ['L3-dmf-entity-import-slice'],
    note: 'Eval case authored (import-ready entity + staging hook); golden pending VM capture.',
  },
  {
    id: 'dual-write', label: 'Dual-write (Dataverse)', domain: 'Integration', source: 'topic', tier: 'total', weight: 2,
    aotTypes: ['class'], knowledgeIds: ['dual-write'],
    caseIds: ['L3-dualwrite-entity-mapping'],
    note: 'Eval case authored for the AOT half (business key + change tracking); the dual-write map itself is UI-authored. Golden pending VM capture.',
  },
  {
    id: 'power-platform', label: 'Power Platform / virtual entities', domain: 'Integration', source: 'topic', tier: 'total', weight: 1,
    aotTypes: ['class'], knowledgeIds: ['power-platform-integration'],
    caseIds: ['L2-virtual-entity-power-platform'],
    note: 'Eval case authored (entity marked up for virtual-entity exposure); golden pending VM capture.',
  },
  {
    id: 'file-io', label: 'Reading Excel / CSV files', domain: 'Integration', source: 'topic', tier: 'total', weight: 2,
    aotTypes: ['class'], knowledgeIds: ['file-readers'],
    caseIds: ['L3-file-csv-import'],
    note: 'Eval case authored (CommaStreamIo + OpenXML stream readers); golden pending VM capture.',
  },
  {
    id: 'direct-sql', label: 'Direct SQL execution', domain: 'Integration', source: 'topic', tier: 'total', weight: 1,
    aotTypes: ['class'], knowledgeIds: ['direct-sql'],
    caseIds: ['L2-direct-sql-connection'],
    note: 'Eval case authored — the escape hatch WITH its guard rails (permission assert, no concatenated input). Golden pending VM capture.',
  },
  {
    id: 'aggregate-measurements', label: 'Aggregate measurements / analytics', domain: 'Integration', source: 'aot', tier: 'total', weight: 1,
    aotTypes: ['aggregate-measurement'], knowledgeIds: ['aggregate-measurements'],
    caseIds: ['L3-aggregate-measurement-basic'],
    note: 'Knowledge entry + create path added; eval case authored, golden pending VM capture.',
  },

  // ── Security ────────────────────────────────────────────────────────────
  {
    id: 'security-privilege', label: 'Security privilege', domain: 'Security', source: 'aot', tier: 'core', weight: 5,
    aotTypes: ['security-privilege'], knowledgeIds: ['security', 'security-privileges-duties'],
    caseTags: ['privilege'],
  },
  {
    id: 'security-duty', label: 'Security duty', domain: 'Security', source: 'aot', tier: 'core', weight: 4,
    aotTypes: ['security-duty'], knowledgeIds: ['security-privileges-duties'], caseTags: ['duty'],
  },
  {
    id: 'security-role', label: 'Security role', domain: 'Security', source: 'aot', tier: 'core', weight: 4,
    aotTypes: ['security-role'], knowledgeIds: ['security-privileges-duties'], caseTags: ['role'],
  },
  {
    id: 'entity-security', label: 'Data-entity security', domain: 'Security', source: 'topic', tier: 'core', weight: 3,
    aotTypes: ['data-entity'], knowledgeIds: ['security'], caseIds: ['L4-entity-security'],
  },
  {
    id: 'xds', label: 'Extensible data security (XDS)', domain: 'Security', source: 'aot', tier: 'total', weight: 1,
    aotTypes: ['security-policy'], knowledgeIds: ['security'],
    caseIds: ['L3-xds-policy-constrained-table'],
    note: 'Create path added (d365fo_file objectType "security-policy"); eval case authored (policy + policy query + constrained table), golden pending VM capture.',
  },
  {
    id: 'license-code', label: 'License codes', domain: 'Security', source: 'aot', tier: 'total', weight: 0,
    aotTypes: ['license-code'], knowledgeIds: ['license-codes'], caseIds: ['L2-license-code-configkey'],
    note: 'Exotic (ISV licensing only) but now closable: knowledge + create path added, eval case authored, golden pending VM capture.',
  },

  // ── Quality ─────────────────────────────────────────────────────────────
  {
    id: 'unit-testing', label: 'SysTest unit testing', domain: 'Quality', source: 'topic', tier: 'core', weight: 4,
    aotTypes: ['class'], knowledgeIds: ['unit-testing', 'testing'], caseTags: ['runtime'],
  },
  {
    id: 'labels', label: 'Labels & localisation', domain: 'Quality', source: 'topic', tier: 'core', weight: 5,
    aotTypes: ['class'], knowledgeIds: ['labels'], caseTags: ['deterministic'],
  },
];
