/**
 * Coverage taxonomy — the definition of "100%".
 *
 * Three sources:
 *  1. AOT element types the metadata parser knows about — the mechanically
 *     complete list of everything developable (`source: 'aot'`). The
 *     `aotTypes` of these leaves are the internal type names used by the
 *     symbol index and by d365fo_file/generate_object, so the T flag can be
 *     derived rather than asserted.
 *  2. Cross-cutting X++ development topics that are not AOT elements
 *     (transactions, CoC rules, performance, …) — `source: 'topic'`.
 *  3. Real-world frequency `weight` (0–5): how often a leaf shows up in
 *     customization work. Weights order the closure queue; they are not
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
    note: 'Eval case authored (EDT + EDT extension via PropertyModifications); golden captured.',
  },
  {
    // Creating a base enum is half of this leaf; consuming one is the other half,
    // and that half is where the money went — a benchmark run wrote enum2Str with
    // enum2Symbol's two arguments and paid a 76 s failed build for it, because the
    // base documented the conversions nowhere. enum-conversions covers it now.
    //
    // The L3 case builds a four-value ladder enum, types a table field on it and
    // compares it in a validateWrite guard. Note what it does NOT do: it compares
    // through enum2int and messages through a bare label, so it exercises the
    // creation and the ordinal comparison, not the label/symbol split that
    // motivated the knowledge entry. It is the right case for this leaf and it is
    // not proof of that part; a case that renders an enum into a message would be.
    // Its golden was captured on 2026-08-31, so it now flips E for this leaf —
    // read that E as "creation + ordinal comparison proven", not as proof of the
    // label/symbol split.
    id: 'enum', label: 'Base enum', domain: 'Data model', source: 'aot', tier: 'core', weight: 5,
    aotTypes: ['enum'], knowledgeIds: ['xpp-class-rules', 'enum-conversions'],
    caseIds: ['L0-enum-basic', 'L3-enum-field-form-downgrade-guard'],
  },
  {
    id: 'enum-extension', label: 'Enum extension', domain: 'Data model', source: 'aot', tier: 'core', weight: 4,
    aotTypes: ['enum-extension'], knowledgeIds: ['coc', 'extensible-enums'],
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
    id: 'class-inheritance', label: 'Class inheritance (extends chain, virtual dispatch)', domain: 'Code', source: 'topic', tier: 'core', weight: 4,
    aotTypes: ['class', 'class-extension'], knowledgeIds: ['class-inheritance'],
    caseIds: ['L2-coc-inherited-method'],
    note: 'The mirror of table-inheritance for code. Added after the tool path was found to walk ZERO levels of the extends chain: an inherited method was reported as non-existent, so agents concluded a CoC wrap was impossible (PRs #780/#781/#782). Case authored; golden captured.',
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
    note: 'Knowledge entry teaches the legacy status and the modern replacement; eval case authored; golden captured.',
  },
  {
    id: 'transactions', label: 'Transactions (ttsbegin/ttscommit)', domain: 'Code', source: 'topic', tier: 'core', weight: 5,
    aotTypes: ['class'], knowledgeIds: ['transactions'],
    // 'modify' is a WRITE-OP tag: it matched eight metadata-edit cases and none of
    // them opens a transaction. The two cases that do are named instead.
    caseIds: ['L2-exception-tts-retry', 'L2-occ-retry-basic'],
  },
  {
    id: 'select-grammar', label: 'X++ select grammar', domain: 'Code', source: 'topic', tier: 'core', weight: 5,
    aotTypes: ['class'], knowledgeIds: ['select-statement', 'query-patterns'],
    // The two report cases carry one insert_recordset between them. The select
    // surface — joins, find options, date-effective ranges, cross-company — is
    // exercised by these three, so the leaf rests on them too.
    caseIds: ['L4-ssrs-report-basic', 'L4-ssrs-report-advanced', 'L2-sysda-fluent-query',
      'L2-date-effective-table', 'L2-multi-company-changecompany'],
  },
  {
    id: 'set-based', label: 'Set-based operations', domain: 'Code', source: 'topic', tier: 'core', weight: 4,
    aotTypes: ['class'], knowledgeIds: ['set-based'],
    // L2-performance-set-based is the case written FOR this leaf — its instruction
    // fails a while-select that inserts row by row, which is the whole point.
    caseIds: ['L2-performance-set-based', 'L4-ssrs-report-basic'],
  },
  {
    id: 'sysda', label: 'SysDa fluent query API', domain: 'Code', source: 'topic', tier: 'total', weight: 1,
    aotTypes: ['class'], knowledgeIds: ['sysda'],
    caseIds: ['L2-sysda-fluent-query'],
    note: 'Eval case authored (SysDa fluent select); golden captured.',
  },
  {
    id: 'error-handling', label: 'Error handling & infolog', domain: 'Code', source: 'topic', tier: 'core', weight: 5,
    aotTypes: ['class'], knowledgeIds: ['error-handling', 'telemetry'],
    caseIds: ['L2-error-handling-infolog'],
    note: 'Case authored (checkFailed validation + typed catches + exceptionTextFallThrough + infolog capture); golden captured.',
  },
  {
    id: 'sysextension', label: 'SysExtension plug-in pattern', domain: 'Code', source: 'topic', tier: 'total', weight: 2,
    aotTypes: ['class'], knowledgeIds: ['sysextension'],
    caseIds: ['L2-sysextension-plugin'],
    note: 'Eval case authored (attribute-driven SysExtension factory); golden captured.',
  },
  {
    id: 'performance', label: 'Performance patterns', domain: 'Code', source: 'topic', tier: 'core', weight: 4,
    aotTypes: ['class'], knowledgeIds: ['performance', 'set-based'],
    caseIds: ['L2-performance-set-based'],
    note: 'Case authored; it asserts a STRUCTURAL performance property (insert_recordset / RecordInsertList / firstonly / delete_from instead of row-by-row) rather than a wall-clock measurement, which is not reproducible across VM load. Golden captured.',
  },
  {
    id: 'bp-rules', label: 'Best-practice (BP) compliance', domain: 'Code', source: 'topic', tier: 'core', weight: 4,
    aotTypes: ['class'], knowledgeIds: ['bp-rules'],
    // 'deterministic' is an authoring convention (45 cases carry it), not a BP
    // assertion. The case that exercises the BP machinery is named.
    caseIds: ['L2-bp-suppression-lifecycle'], caseTags: ['deterministic'],
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
    note: 'Knowledge entry written (audit hole C6 closed); eval case authored; golden captured.',
  },
  {
    id: 'datetime-timezones', label: 'Date/time & time zones (utcdatetime, DateTimeUtil)', domain: 'Code', source: 'topic', tier: 'total', weight: 3,
    aotTypes: ['class'], knowledgeIds: ['datetime-timezones'], caseIds: ['L2-datetime-timezone-range'],
    note: 'Knowledge entry written (audit hole C7 closed); eval case authored; golden captured.',
  },
  {
    id: 'dotnet-interop', label: '.NET interop (CLRInterop, using alias, CLRError)', domain: 'Code', source: 'topic', tier: 'total', weight: 2,
    aotTypes: ['class'], knowledgeIds: ['dotnet-interop'], caseIds: ['L2-dotnet-interop-clrerror'],
    note: 'Knowledge entry written (audit hole C8 closed); eval case authored; golden captured.',
  },
  {
    id: 'reflection-dict', label: 'Reflection / Dict* metadata API', domain: 'Code', source: 'topic', tier: 'total', weight: 2,
    aotTypes: ['class'], knowledgeIds: ['reflection-dict'], caseIds: ['L2-reflection-dict-fieldwalk'],
    note: 'Knowledge entry written (audit hole C9 closed); eval case authored; golden captured.',
  },
  // Language-core leaves (Phase B/E of the coverage plan): the grammar itself,
  // previously represented only by select-grammar. Leaves without caseIds are
  // knowledge+validator-covered but unproven by an eval case yet — the honest
  // gap the artifact-type taxonomy used to hide.
  {
    id: 'data-types', label: 'Data types, literals & conversions', domain: 'Code', source: 'topic', tier: 'core', weight: 5,
    aotTypes: ['class'], knowledgeIds: ['xpp-data-types', 'enum-conversions'],
    caseIds: ['L2-data-types-conversions'],
    note: 'Taught (xpp-data-types) and partially validator-enforced (FN001 arities, CS001 string type); eval case authored (null-equivalents, date/verbatim literals, silent truncation, conversion functions, anytype locking); golden captured.',
  },
  {
    id: 'declarations-scope', label: 'Declarations & scope (var/const/readonly/using)', domain: 'Code', source: 'topic', tier: 'core', weight: 4,
    aotTypes: ['class'], knowledgeIds: ['xpp-declarations'],
    caseIds: ['L2-declarations-scope'],
    note: 'Taught, and exercised implicitly by every class case; the authored case pins what implicit use never shows — const vs readonly, the shadowing rejection, loop scope, prmIsDefault. Golden captured.',
  },
  {
    id: 'operators', label: 'Operators & precedence (&&/|| trap, like, is/as)', domain: 'Code', source: 'topic', tier: 'core', weight: 4,
    aotTypes: ['class'], knowledgeIds: ['operators-precedence'],
    caseIds: ['L2-operators-precedence'],
    note: 'Taught; CS001 blocks the C#-isms. Eval case authored around the one trap no validator can catch — a mixed &&/|| chain that compiles and means the other thing. Golden captured.',
  },
  {
    id: 'statements-flow', label: 'Statements & flow (switch fallthrough, loops)', domain: 'Code', source: 'topic', tier: 'core', weight: 4,
    aotTypes: ['class'], knowledgeIds: ['switch-loops'],
    caseIds: ['L2-statements-switch-loops'],
    note: 'Taught; BP004 covers removed keywords. Eval case authored (switch fallthrough, comma case lists, and a break that leaves only the switch). Golden captured.',
  },
  {
    id: 'exceptions-tts', label: 'Exceptions inside transactions (catchability, retry)', domain: 'Code', source: 'topic', tier: 'core', weight: 4,
    aotTypes: ['class'], knowledgeIds: ['transactions', 'error-handling'],
    caseIds: ['L2-exception-tts-retry'],
    note: 'TTS002/TTS003 validators + in-tts catchability matrix; eval case authored; golden captured.',
  },
  {
    id: 'attributes', label: 'Attribute authoring & reflection', domain: 'Code', source: 'topic', tier: 'total', weight: 2,
    aotTypes: ['class'], knowledgeIds: ['attributes-authoring', 'reflection-dict'],
    caseIds: ['L2-attribute-authoring-reflection'],
    note: 'Taught with audited examples (the Phase F snapshot re-capture resolved their symbols); eval case authored (SysAttribute subclass, literal-only usage site, SysObsolete, DictClass read-back); golden captured.',
  },
  {
    id: 'intrinsics', label: 'Compile-time (intrinsic) functions', domain: 'Code', source: 'topic', tier: 'core', weight: 4,
    aotTypes: ['class'], knowledgeIds: ['intrinsic-functions'],
    caseIds: ['L2-intrinsic-functions'],
    note: 'Full catalog taught; references mode resolves the common ones. Eval case authored (element/member/num forms, kind-specific menu items, identifierStr banned). Golden captured.',
  },
  {
    id: 'xrecord-buffer-api', label: 'Table buffer API (xRecord/Common members)',
    domain: 'Code', source: 'topic', tier: 'core', weight: 5,
    aotTypes: ['table', 'class'], knowledgeIds: ['xrecord-buffer-api'],
    caseIds: ['L2-table-modify-lifecycle'],
    note: 'Kernel members with no AOT metadata, so the index answers "not found" for every one of them — which is why they get guessed. Signatures compiler-verified 2026-09-02 (probes coverage-v4d/v4e): data() returns a BUFFER not a container, isFieldDataRetrieved takes a field NAME, setData and getSQLStatements do not exist. The E flag rests on a case that exercises the buffer, not on one written for this leaf.',
  },
  {
    id: 'date-effective', label: 'Date-effective tables (validTimeState)', domain: 'Code', source: 'topic', tier: 'total', weight: 3,
    aotTypes: ['table', 'class'], knowledgeIds: ['date-effective', 'select-statement'],
    caseIds: ['L2-date-effective-table'],
    note: 'Eval case authored (table + as-of vs unfiltered select); golden captured.',
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
    knowledgeIds: ['menu-navigation'],
    // The label promises all three kinds; output came from the report cases, so
    // display and action are named from the cases that create them.
    caseIds: ['L2-config-key-gated-table', 'L3-batch-basic'], caseTags: ['menu-item-output'],
  },
  {
    id: 'menu', label: 'Menus & submenu nesting', domain: 'UI', source: 'aot', tier: 'core', weight: 3,
    aotTypes: ['menu', 'menu-extension'], knowledgeIds: ['menu-navigation'], caseTags: ['menu'],
  },
  {
    id: 'tiles-kpis', label: 'Tiles & KPIs', domain: 'UI', source: 'aot', tier: 'total', weight: 1,
    aotTypes: ['tile', 'kpi'], knowledgeIds: ['tiles-kpis'], caseIds: ['L2-tile-cue-over-query'],
    note: 'Knowledge entry written; eval case authored (count tile over an AOT query); golden captured.',
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
    caseIds: ['L3-print-management-report', 'L3-print-mgmt-doctype-extension'],
    note: 'Two cases with captured goldens: using an existing document type, and registering a new one through the PrintMgmtDocType delegates.',
  },
  {
    id: 'report-contracts', label: 'Report contracts (RDP/RDL/print/composite)', domain: 'Reporting', source: 'topic', tier: 'core', weight: 3,
    aotTypes: ['report'], knowledgeIds: ['ssrs-contracts'],
    caseIds: ['L4-ssrs-report-advanced'],
    note: 'Contract taxonomy + controller override points; proven implicitly by the advanced SSRS golden.',
  },
  {
    id: 'rdp-preprocess', label: 'Pre-processed RDP (long-running reports)', domain: 'Reporting', source: 'topic', tier: 'total', weight: 2,
    aotTypes: ['report'], knowledgeIds: ['ssrs-rdp-preprocess'],
    caseIds: ['L4-ssrs-report-preprocess'],
    note: 'Eval case authored — doubles as the Phase F verification of the preProcess scaffold pairing; golden captured.',
  },
  {
    id: 'report-ui-builder', label: 'Report dialog UI builders', domain: 'Reporting', source: 'topic', tier: 'total', weight: 2,
    aotTypes: ['report'], knowledgeIds: ['ssrs-ui-builder'],
    caseIds: ['L4-ssrs-report-uibuilder'],
    note: 'uiBuilder scaffold option landed in Phase D; eval case authored; golden captured.',
  },
  {
    id: 'electronic-reporting', label: 'Electronic Reporting (ER)', domain: 'Reporting', source: 'topic', tier: 'total', weight: 1,
    aotTypes: ['class'], knowledgeIds: ['electronic-reporting'],
    caseIds: ['L3-electronic-reporting-integration'],
    note: 'Eval case authored for the X++ half (ER data provider); the ER model/mapping/format stay UI-configured and out of scope. Golden captured.',
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
    note: 'Eval case authored (BatchHeader runtime tasks); golden captured.',
  },
  {
    id: 'async-retryable-batch', label: 'Async & retryable batch (BatchRetryable/runAsync)', domain: 'Frameworks', source: 'topic', tier: 'total', weight: 2,
    aotTypes: ['class'], knowledgeIds: ['async-retryable-batch'], caseIds: ['L3-batch-retryable-basic'],
    note: 'L3-batch-retryable-basic, golden captured.',
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
    note: 'Eval case authored; it scores the STRUCTURE of the LedgerVoucher call chain, not a posted result (no ledger fixture). Golden captured.',
  },
  {
    id: 'workflow', label: 'Workflow', domain: 'Frameworks', source: 'topic', tier: 'core', weight: 3,
    aotTypes: ['class'], knowledgeIds: ['workflow'],
    caseIds: ['L3-workflow-document-submit'],
    note: 'Case authored for the X++/tool-path-reachable half (WorkflowDocument subclass + query, canSubmitToWorkflow, submit manager, action menu item). The AxWorkflowType/Approval/Category AOT elements stay uncovered: d365fo_file has no objectType for them. Golden captured.',
  },
  {
    id: 'business-events', label: 'Business events & alerts', domain: 'Frameworks', source: 'topic', tier: 'core', weight: 3,
    aotTypes: ['business-event'], knowledgeIds: ['alerts-business-events'], caseIds: ['L2-business-event-basic'],
  },
  {
    id: 'feature-management', label: 'Feature management', domain: 'Frameworks', source: 'topic', tier: 'total', weight: 2,
    aotTypes: ['class'], knowledgeIds: ['feature-management'],
    caseIds: ['L2-feature-management-flight'],
    note: 'Eval case authored (IFeatureMetadata + FeatureStateProvider branch); golden captured.',
  },
  {
    id: 'configuration-keys', label: 'Configuration keys', domain: 'Frameworks', source: 'aot', tier: 'total', weight: 2,
    aotTypes: ['configuration-key'], knowledgeIds: ['configuration-keys'],
    caseIds: ['L2-config-key-gated-table'],
    note: 'Create path added (d365fo_file objectType "configuration-key"); eval case authored; golden captured.',
  },
  {
    id: 'multi-company', label: 'Multi-company / changeCompany', domain: 'Frameworks', source: 'topic', tier: 'core', weight: 3,
    aotTypes: ['class'], knowledgeIds: ['multi-company'],
    caseIds: ['L2-multi-company-changecompany'],
    note: 'Case authored (changeCompany block + crosscompany select over a company container); golden captured.',
  },
  {
    id: 'global-address-book', label: 'Global address book', domain: 'Frameworks', source: 'topic', tier: 'total', weight: 2,
    aotTypes: ['class'], knowledgeIds: ['global-address-book'],
    caseIds: ['L3-gab-party-postaladdress'],
    note: 'Eval case authored (party + primary postal address through the DirParty API); golden captured.',
  },
  {
    id: 'currency', label: 'Currency & exchange rates', domain: 'Frameworks', source: 'topic', tier: 'total', weight: 2,
    aotTypes: ['class'], knowledgeIds: ['currency-exchange-rates'],
    caseIds: ['L3-currency-exchange-conversion'],
    note: 'Eval case authored (exchange-rate helper conversion + currency rounding); golden captured.',
  },
  {
    id: 'inventory', label: 'Inventory (InventTrans / InventDim)', domain: 'Frameworks', source: 'topic', tier: 'total', weight: 3,
    aotTypes: ['class'], knowledgeIds: ['inventory-management'],
    caseIds: ['L3-inventory-inventdim-onhand'],
    note: 'Eval case authored (InventDim/InventDimParm on-hand read); golden captured.',
  },
  {
    id: 'warehouse', label: 'Warehouse management (WHS)', domain: 'Frameworks', source: 'topic', tier: 'total', weight: 1,
    aotTypes: ['class'], knowledgeIds: ['warehouse-management'],
    caseIds: ['L3-warehouse-work-slice'],
    note: 'Eval case authored for the X++ half (work creation through the WHS framework); templates/directives stay configured data. Golden captured.',
  },
  {
    // Split out of `warehouse` deliberately. That leaf is green on wave/work
    // creation, and the scanner half of WHS is a different surface with its own
    // failure modes: a stateless container protocol instead of a form, and a
    // scanned string that is not an item number. Auditing the base for
    // "barcode"/"scanner"/"gs1" returned nothing, one match, and nothing —
    // "scanner" resolved to Electronic Reporting on a substring hit — so it was
    // uncovered while looking covered under `warehouse`.
    id: 'warehouse-mobile-scanning', label: 'Warehouse app / barcode scanning', domain: 'Frameworks', source: 'topic', tier: 'total', weight: 2,
    aotTypes: ['class'], knowledgeIds: ['warehouse-mobile-app', 'barcode-scanning'],
    caseIds: ['L3-warehouse-scan-resolve-slice'],
    note: 'Knowledge authored (scan → action dispatch, one-round-trip transaction, idempotency, GS1 AI parsing, item-barcode resolution); eval case captured on the VM — builds clean, posts through the journal framework with the idempotency guard inside the transaction.',
  },
  {
    // The screens themselves, which is a different job from the flow invariants
    // in `warehouse-mobile-scanning`: the platform builds the same screens with
    // TWO frameworks (ProcessGuide and the legacy WHSWorkExecuteDisplay
    // hierarchy), and picking the wrong one is a rewrite. Both halves need a
    // case, which is why this leaf claims three: create a flow, extend one
    // screen additively, and change a legacy screen without breaking the modes
    // that share its methods.
    id: 'warehouse-app-screens', label: 'Warehouse-app screens (ProcessGuide / legacy)', domain: 'Frameworks', source: 'topic', tier: 'total', weight: 2,
    aotTypes: ['class'], knowledgeIds: ['process-guide-framework'],
    caseIds: ['L3-processguide-flow-slice', 'L2-processguide-page-control', 'L3-legacy-workexecutedisplay-extend'],
    note: 'Knowledge + object_patterns(domain="mobile-app") recipes authored for both frameworks; three eval cases captured on the VM — ProcessGuide flow, a page-control CoC extension, and a legacy WHSWorkExecuteDisplay extension.',
  },
  {
    id: 'trade-agreements', label: 'Trade agreements & pricing', domain: 'Frameworks', source: 'topic', tier: 'total', weight: 1,
    aotTypes: ['class'], knowledgeIds: ['trade-agreements'],
    caseIds: ['L3-trade-agreement-price-lookup'],
    note: 'Eval case authored (PriceDisc price/discount resolution); golden captured.',
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
    note: 'Eval case authored (table extension field surfaced on a standard entity); golden captured.',
  },
  {
    id: 'custom-service', label: 'Custom services / OData actions', domain: 'Integration', source: 'aot', tier: 'core', weight: 3,
    aotTypes: ['service', 'service-group'], knowledgeIds: ['custom-services'], caseIds: ['L3-custom-service-basic'],
    note: 'L3-custom-service-basic, golden captured; the full create/validate tool path for AxService is still XML-template only.',
  },
  {
    id: 'dmf', label: 'Data management framework (DMF/DIXF)', domain: 'Integration', source: 'topic', tier: 'total', weight: 2,
    aotTypes: ['class'], knowledgeIds: ['data-management-framework'],
    caseIds: ['L3-dmf-entity-import-slice'],
    note: 'Eval case authored (import-ready entity + staging hook); golden captured.',
  },
  {
    id: 'dual-write', label: 'Dual-write (Dataverse)', domain: 'Integration', source: 'topic', tier: 'total', weight: 2,
    aotTypes: ['class'], knowledgeIds: ['dual-write'],
    caseIds: ['L3-dualwrite-entity-mapping'],
    note: 'Eval case authored for the AOT half (business key + change tracking); the dual-write map itself is UI-authored. Golden captured.',
  },
  {
    id: 'power-platform', label: 'Power Platform / virtual entities', domain: 'Integration', source: 'topic', tier: 'total', weight: 1,
    aotTypes: ['class'], knowledgeIds: ['power-platform-integration'],
    caseIds: ['L2-virtual-entity-power-platform'],
    note: 'Eval case authored (entity marked up for virtual-entity exposure); golden captured.',
  },
  {
    id: 'file-io', label: 'Reading Excel / CSV files', domain: 'Integration', source: 'topic', tier: 'total', weight: 2,
    aotTypes: ['class'], knowledgeIds: ['file-readers'],
    caseIds: ['L3-file-csv-import'],
    note: 'Eval case authored (CommaStreamIo + OpenXML stream readers); golden captured.',
  },
  {
    id: 'direct-sql', label: 'Direct SQL execution', domain: 'Integration', source: 'topic', tier: 'total', weight: 1,
    aotTypes: ['class'], knowledgeIds: ['direct-sql'],
    caseIds: ['L2-direct-sql-connection'],
    note: 'Eval case authored — the escape hatch WITH its guard rails (permission assert, no concatenated input). Golden captured.',
  },
  {
    id: 'aggregate-measurements', label: 'Aggregate measurements / analytics', domain: 'Integration', source: 'aot', tier: 'total', weight: 1,
    aotTypes: ['aggregate-measurement'], knowledgeIds: ['aggregate-measurements'],
    caseIds: ['L3-aggregate-measurement-basic'],
    note: 'Knowledge entry + create path added; eval case authored; golden captured.',
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
    note: 'Create path added (d365fo_file objectType "security-policy"); eval case authored (policy + policy query + constrained table); golden captured.',
  },
  {
    id: 'license-code', label: 'License codes', domain: 'Security', source: 'aot', tier: 'total', weight: 0,
    aotTypes: ['license-code'], knowledgeIds: ['license-codes'], caseIds: ['L2-license-code-configkey'],
    note: 'Exotic (ISV licensing only) but now closable: knowledge + create path added, eval case authored; golden captured.',
  },

  // ── Quality ─────────────────────────────────────────────────────────────
  {
    id: 'unit-testing', label: 'SysTest unit testing', domain: 'Quality', source: 'topic', tier: 'core', weight: 4,
    aotTypes: ['class'], knowledgeIds: ['unit-testing', 'testing'], caseTags: ['runtime'],
    // This ✅ is now backed by EXECUTION, not only by authoring. The three cases
    // that ship a SysTest class — L2-coc-extension, L2-event-handler-basic and
    // L3-batch-basic — all ran under SysTestConsole.exe on 2026-08-31 and passed
    // 2/2 each ("Rainier Test Suite : 2 Run, 0 Failed"), and no case carries
    // `systest_pending` any more. The earlier claim here — that the oracle had
    // never executed once because SysTestConsole.exe gates on an interactive
    // console — was DISPROVED that day: the blocker was configuration drift (the
    // runner could not reach the AOS database), not an interactive-console gate.
    // The negative control committed alongside the wave proves the oracle
    // discriminates (tests/eval/systestNegativeControl.test.ts), so a green
    // runtime score here means a test really went green.
    // The knowledge behind the leaf is read from the shipped SysTestCase/
    // SysTestAssert rather than from memory (there is no assertExpectedException).
    note: 'Authoring AND execution are both proven: L2-coc-extension, L2-event-handler-basic and L3-batch-basic each ran under SysTestConsole.exe on 2026-08-31 and passed 2/2 (corpus records …__278eee3.json), and L3-enum-field-form-downgrade-guard ran green too. The 2026-08-31 config fix on the VM removed the last blocker; the only runtime-tagged case still scoring null is L2-systest-authoring-basic, whose last run predates the fix.',
  },
  {
    id: 'labels', label: 'Labels & localisation', domain: 'Quality', source: 'topic', tier: 'core', weight: 5,
    aotTypes: ['class'], knowledgeIds: ['labels'], caseTags: ['deterministic'],
  },

  // ── Language surface the artifact-type taxonomy hid ─────────────────────
  //
  // These nine leaves exist because the compiler answered questions this server
  // used to answer from memory — a construct-level map of the language against
  // the live sources, rather than an artifact-indexed one. Each
  // has a knowledge entry written from a probe and an eval case. Those cases were
  // authored but NOT captured when these leaves were written, so `golden_pending`
  // held E false and the published number fell — the intended direction. As of
  // 2026-08-31 the capture wave is complete: 0 of the 120 cases are
  // `golden_pending`, so E here is now decided by the goldens, not by their
  // absence.
  {
    id: 'runtime-functions', label: 'Run-time (predefined) functions', domain: 'Code', source: 'topic', tier: 'core', weight: 4,
    aotTypes: ['class'], knowledgeIds: ['runtime-functions'],
    caseIds: ['L2-runtime-functions-arity'],
    note: 'Arities come from the compiler capture (eval/compiler-facts.snapshot.json); validate_code enforces them as FN001/FN002.',
  },
  {
    id: 'implicit-conversions', label: 'Implicit conversions & explicit converters', domain: 'Code', source: 'topic', tier: 'core', weight: 3,
    aotTypes: ['class'], knowledgeIds: ['xpp-data-types', 'operators-precedence'],
    caseIds: ['L2-implicit-conversions'],
    note: 'real -> int is a compile ERROR, not a silent truncation as the language reference describes.',
  },
  {
    id: 'select-find-options', label: 'select find options, join kinds and clause order', domain: 'Code', source: 'topic', tier: 'core', weight: 4,
    aotTypes: ['class'], knowledgeIds: ['select-statement'],
    caseIds: ['L2-select-find-options-joins'],
    note: 'The select-grammar leaf rests on report cases; this one exercises the find options, the three join kinds and the in operator.',
  },
  {
    id: 'args-navigation', label: 'Args — record, caller and parameters', domain: 'UI', source: 'topic', tier: 'core', weight: 3,
    aotTypes: ['class'], knowledgeIds: ['args-object'],
    caseIds: ['L2-args-record-caller'],
  },
  {
    id: 'display-edit-methods', label: 'display / edit methods', domain: 'UI', source: 'topic', tier: 'core', weight: 3,
    aotTypes: ['table-extension'], knowledgeIds: ['display-edit-methods'],
    caseIds: ['L2-display-edit-methods'],
  },
  {
    id: 'form-event-handlers', label: 'Form event handlers', domain: 'UI', source: 'topic', tier: 'core', weight: 4,
    aotTypes: ['class'], knowledgeIds: ['form-event-handlers'],
    caseIds: ['L3-form-event-handler-class'],
  },
  {
    id: 'sysoperation-ui', label: 'SysOperation dialog from contract attributes', domain: 'Frameworks', source: 'topic', tier: 'total', weight: 3,
    aotTypes: ['class'], knowledgeIds: ['sysoperation-ui-attributes'],
    caseIds: ['L3-sysoperation-dialog-attributes'],
  },
  {
    id: 'report-extension', label: 'Extending a standard report', domain: 'Reporting', source: 'topic', tier: 'core', weight: 4,
    aotTypes: ['class'], knowledgeIds: ['report-extension-patterns'],
    caseIds: ['L3-report-dataset-extension'],
    note: 'Dataset expansion via PostHandlerFor is the case; the custom-design and menu-item routes are knowledge only.',
  },
  {
    id: 'tdd-workflow', label: 'TDD loop (red-first SysTest authoring)', domain: 'Quality', source: 'topic', tier: 'core', weight: 4,
    aotTypes: ['class'], knowledgeIds: ['unit-testing', 'testing'],
    caseIds: ['L2-systest-authoring-basic'],
    note: 'Distinct from the unit-testing leaf: that one proves a SysTest can be authored, this one proves the loop — prepare(test), the failing scaffold, then a run.',
  },

  // ── v3 wave ─────────────────────────────────────────────────────────────
  // Added 2026-08-31 from a construct-level map of the language plus 1,593 real
  // MCP calls. Every one of them was invisible before: the taxonomy is indexed by
  // ARTIFACT, and a lookup, a Global static or an RDL expression is not an
  // artifact — so no percentage could fall for their absence. They arrive
  // uncovered on E, which is the honest state until a golden is captured.
  {
    id: 'lookups', label: 'Lookups (table, reference, multi-select, override)',
    domain: 'UI', source: 'topic', tier: 'core', weight: 4,
    aotTypes: ['class'], knowledgeIds: ['lookups'], caseIds: ['L2-lookup-reference-multiselect'],
    note: 'The lookup class depends on the CONTROL, not the table: a string control takes SysTableLookup, a RecId reference control takes SysReferenceTableLookup, and the compiler enforces it. Proven by L2-lookup-reference-multiselect (captured 2026-08-31).',
  },
  {
    id: 'global-statics', label: 'Global:: statics (query values, access checks)',
    domain: 'Code', source: 'topic', tier: 'core', weight: 4,
    aotTypes: ['class'], knowledgeIds: ['global-class-statics'], caseIds: ['L2-global-statics-access-checks'],
    note: 'The third place the compiler looks for a bare call, after intrinsics and predefined functions; FN001 reports them as "Global.fn". Proven by L2-global-statics-access-checks (captured 2026-08-31).',
  },
  {
    id: 'system-objects', label: 'System objects (infolog, Box, Debug, session)',
    domain: 'Code', source: 'topic', tier: 'core', weight: 4,
    aotTypes: ['class'], knowledgeIds: ['system-objects'], caseIds: ['L2-system-objects-infolog-box'],
    note: 'Half of them are kernel classes with no AOT XML, so the metadata index cannot answer for them — which is exactly why the topic exists. Proven by L2-system-objects-infolog-box (captured 2026-08-31).',
  },
  {
    id: 'query-object-model-advanced', label: 'Query filters, range expressions, custom range functions',
    domain: 'Code', source: 'topic', tier: 'total', weight: 3,
    aotTypes: ['query'], knowledgeIds: ['query-object-model'], caseIds: ['L2-query-range-expression-sysqueryrangeutil'],
    note: 'Range vs filter on an outer join, the range expression language, and [QueryRangeFunction] — verified by probe and proven by L2-query-range-expression-sysqueryrangeutil (captured 2026-08-31).',
  },
  {
    id: 'sysoperation-query-param', label: 'SysOperation query parameter (batch with a filter)',
    domain: 'Frameworks', source: 'topic', tier: 'core', weight: 4,
    aotTypes: ['class'], knowledgeIds: ['sysoperation'], caseIds: ['L3-sysoperation-query-parameter-batch'],
    note: '[AifQueryTypeAttribute] + SysOperationHelper::base64Decode, compile-verified and proven by L3-sysoperation-query-parameter-batch (captured 2026-08-31).',
  },
  {
    id: 'runbase-lifecycle', label: 'RunBase lifecycle & packed state',
    domain: 'Frameworks', source: 'topic', tier: 'total', weight: 3,
    aotTypes: ['class'], knowledgeIds: ['deprecated'], caseIds: ['L3-runbase-coc-pack-unpack'],
    note: 'Legacy, but unavoidable when wrapping shipped classes: the #CurrentVersion bump rule is the one that silently corrupts batch parameters when missed.',
  },
  {
    id: 'rdl-expressions', label: 'Report design & RDL expressions',
    domain: 'Reporting', source: 'topic', tier: 'core', weight: 4,
    aotTypes: ['report'], knowledgeIds: ['rdl-design-expressions', 'axreport-anatomy'],
    caseIds: ['L4-ssrs-report-design-rdl'],
    note: 'Two halves of one document, so one leaf: axreport-anatomy is the metadata (parameters, datasets, the i:type design kind) and rdl-design-expressions is the RDL inside it. Both censused over the full install 2026-09-02 — 1,057 documents, 13,833 parameters: precision 1,163 : auto 123, and UserVisibility has only Hidden (8,972) and Internal (5), which is what RPT103 checks. Proven by L4-ssrs-report-design-rdl (captured 2026-08-31). What the case does NOT prove is the RDL expression grammar itself — the golden asserts the document, not what the renderer does with it.',
  },
  {
    id: 'report-parameters', label: 'Report parameters and dataset upkeep (after the scaffold)',
    domain: 'Reporting', source: 'topic', tier: 'core', weight: 4,
    aotTypes: ['report'], knowledgeIds: ['axreport-anatomy'],
    caseIds: ['L4-ssrs-report-parameters'],
    note: 'The half of a report that is NOT layout: a field arrives on the temp table, or a parameter is needed. Both are now writable through d365fo_file(operation="report-design") — metadata-only and additive-only, because a malformed RDL fails in the SSRS renderer where no build can see it. The case exercises the grounded path end to end and its golden was captured from a clean xppc build. What it does NOT prove is that the design USES either one; placing them is Report Designer work.',
  },
  {
    id: 'anytype-runtime', label: 'anytype at run time',
    domain: 'Language', source: 'topic', tier: 'total', weight: 2,
    aotTypes: ['class'], knowledgeIds: ['xpp-data-types'],
    caseIds: ['L2-anytype-retyping-runtime'],
    note: 'An R-only case: the assertions were written to REPORT what happens, then run, and the result decided the knowledge. It refuted a widely repeated claim — an anytype can be re-typed at run time, as a local AND as a class member, and it keeps its type across a method boundary (4 of 4 under SysTestConsole.exe, 2026-09-03). typeOf() compared through enum2Str is the observation, because a raw Types enum prints as a number in a failure message. What this does NOT settle is anytype in a table field or through a CLR boundary.',
  },
  {
    id: 'email-sending', label: 'Sending e-mail (SysMailerMessageBuilder)',
    domain: 'Integration', source: 'topic', tier: 'total', weight: 2,
    aotTypes: ['class'], knowledgeIds: ['email-sending'],
    caseIds: ['L3-attachment-docuref-pdf'],
    note: 'The fluent builder plus SysMailerFactory::sendNonInteractive, compile-verified on a VM (probe MailerBuilder). The two facts that matter are not API shape: setBody takes an isHtml flag that silently sends markup as visible text when false, and the NON-interactive send is the one that works without a signed-in user, so an interactive send from batch is a no-op. What this does NOT cover is SMTP configuration or delivery.',
  },
  {
    id: 'file-io-write', label: 'Writing files (CSV, XLSX, SendFileToUser)',
    domain: 'Integration', source: 'topic', tier: 'total', weight: 2,
    aotTypes: ['class'], knowledgeIds: ['file-io-write'],
    caseIds: ['L3-file-csv-import'],
    note: 'The write half of file-io, which had only the read side. Build into a MemoryStream — there is no local disk in a hosted environment — then File::SendFileToUser(stream, name). Both compile-verified (probes ClrExcel, FileSendToUser). What it does NOT cover is the position-0 reset failing at runtime: that produces an empty file with the right name and no build catches it.',
  },
  {
    id: 'http-json-xml', label: 'HTTP, JSON and regex from X++',
    domain: 'Integration', source: 'topic', tier: 'total', weight: 2,
    aotTypes: ['class'], knowledgeIds: ['http-json-xml'],
    caseIds: ['L2-entity-query-range-roundtrip'],
    note: 'All four CLR types compile-verified in a sandbox model with no extra references (probes ClrHttp2, ClrNewtonsoft). The blocker is a language fact, not a reference: `client` is a reserved word, so the line everyone writes first does not compile — confirmed against the compiler keyword table (115 words, captured by reflection). What this does NOT cover is authentication or a live endpoint.',
  },
  {
    id: 'test-authoring-rules', label: 'Validator rules for test authoring (TST001-003)',
    domain: 'Testing', source: 'topic', tier: 'core', weight: 3,
    aotTypes: ['class'], knowledgeIds: ['unit-testing', 'systest-attributes'],
    caseIds: ['L2-systest-attributes-isolation'],
    note: 'Three rules, two of them NOT as the plan specified because a census said otherwise. TST002 was to demand `extends SysTestCase`; only 24 of the 56 shipped classes carrying [SysTestMethod] do that literally and 31 reach it through a chain (256 extend AtlWHSTestCase), so the rule checks for NO base at all — clean across the install. TST003 was to trigger on a `test*` name; only 8 of 336 shipped test methods (2.4%) are named that way, so the ATTRIBUTE is the trigger, and any assert*() counts because domain helpers outrank assertEquals in shipped code. Full-install sweep: zero error-severity findings, TST003 warns on 3.0%.',
  },
  {
    id: 'form-runtime-api', label: 'Form runtime API (element, data source, controls)',
    domain: 'Forms', source: 'topic', tier: 'core', weight: 4,
    aotTypes: ['form', 'class'], knowledgeIds: ['form-runtime-api'],
    caseIds: ['L2-form-extension-basic', 'L2-form-control-removal-lifecycle'],
    note: 'Two oracles because the API is split in two: FormRun is an ordinary AOT class (209 methods, member oracle) and xFormRun / FormDataSource / FormDataObject / every Form*Control are KERNEL with no AOT XML, confirmed only by compiling (probe coverage-v4h, 9 of 10 compile, negative control fails). Ranked by a census of all 9,442 shipped forms: of FormRun\'s 209 methods only 49 are ever called through element. and args() is 92% of those calls. The census also REMOVED something — updateDesign ranks first in the raw counts and is not platform at all but the inventory-dimension convention, which the compiler settled (UpdateDesignMode appears in 0 of 76,196 files). What this does NOT cover is form personalization and the view/workspace API.',
  },
  {
    id: 'data-entity-methods', label: 'Data entity lifecycle methods',
    domain: 'Integration', source: 'topic', tier: 'core', weight: 4,
    aotTypes: ['data-entity'], knowledgeIds: ['data-entity-methods'],
    caseIds: ['L3-data-entity-extension-field', 'L2-entity-query-range-roundtrip'],
    note: 'Ranked by a census of all 5,805 shipped data entities and every signature read from shipped source (2026-09-02). Two things the documentation gets wrong: mapEntityToDataSource and mapDataSourceToEntity are not a symmetric pair (1,116 vs 99, an 11-to-1 split toward the write path), and findEntityDataSource (318) and getDefaultingDependencies (233) are common enough to belong in any list that claims to be one. PrimaryCompanyContext is an enum with five shipped values, not a boolean. What this does NOT cover is the OData wire protocol or DMF project sequencing.',
  },
  {
    id: 'systest-attributes', label: 'SysTest attributes: filtering, isolation, dependencies',
    domain: 'Testing', source: 'topic', tier: 'core', weight: 4,
    aotTypes: ['class'], knowledgeIds: ['systest-attributes'],
    caseIds: ['L2-systest-attributes-isolation'],
    note: 'Written from a USE census, not from the class inventory: of the 884 shipped classes whose name carries "test" (2026-09-02), 339 carry a SysTest attribute, ten appear and most of the documented catalogue appears in none — SysTestCategory, SysTestRow, SysTestFixture, SysTestKey, SysTestPriority and SysTestOwner have zero shipped occurrences. Placement is measured too (SysTestGranularity 135/136 on the class, SysTestCheckInTest 1,616/1,622 on the method) and the scaffold applies it. The case is a RUNTIME one and its oracle was proven to discriminate: the same two methods run with TestTransactionMode::None fail on the empty-table assertion, and that document is committed beside the green one. What it does NOT cover is the attributes nobody ships — they compile, they simply have no precedent.',
  },
  {
    id: 'test-data-atl', label: 'Test data through ATL',
    domain: 'Testing', source: 'topic', tier: 'total', weight: 3,
    aotTypes: ['class'], knowledgeIds: ['test-data-atl'],
    caseIds: ['L3-test-data-atl'],
    note: 'The ATL tree is generated from the AOT (scripts/oracles/atlNodes.ts → src/knowledge/atlNodes.generated.ts): 1,105 data classes, 38 root modules across 4 packages, 351 record-producing nodes. Two facts the generator itself had to be corrected on: `default()` usually takes DEFAULTED parameters, so an empty-parens regex silently dropped the biggest nodes; and 107 nodes hand back an AtlEntity WRAPPER whose .record() is the buffer. Proven live 2026-09-02 — a customer and an item both resolved against real data under SysTestConsole.exe. What it does NOT cover is custom tables: ATL knows what Microsoft shipped nodes for, and prepare(test) says which packages are missing rather than guessing.',
  },
  {
    id: 'report-dp-testing', label: 'Testing a report data provider (red-first)',
    domain: 'Reporting', source: 'topic', tier: 'core', weight: 4,
    aotTypes: ['report', 'class'], knowledgeIds: ['unit-testing', 'ssrs-reports'],
    caseIds: ['L4-tdd-report-dp'],
    note: 'The report-dp SysTest shape, proven by a RUNTIME oracle rather than a golden alone: L4-tdd-report-dp ran red (2 of 2 failing on the scaffold this.fail) and then green (2 of 2) under SysTestConsole.exe on 2026-09-02, and eval/systests/L4-tdd-report-dp.xml is the passing document. The red run is the part that matters, because it is what proves the assertions can fail at all. The capture also found a live defect in its own first draft: assertNotNull on a table buffer reports "Expected: not null; Actual: null" for an empty buffer, so it asserts the last select found a row and not that the accessor works. What the case does NOT prove is that the RDL binds the staged rows.',
  },
  {
    id: 'report-destinations', label: 'Report print destinations (file, e-mail, archive, batch)',
    domain: 'Reporting', source: 'topic', tier: 'core', weight: 4,
    aotTypes: ['report'], knowledgeIds: ['report-print-destinations'], caseIds: ['L4-ssrs-report-print-destinations'],
    note: 'Member names read from SrsPrintDestinationSettings and compile-verified; proven by L4-ssrs-report-print-destinations (captured 2026-08-31). The case proves the code compiles and the settings are set, not that a report reached an inbox.',
  },
  {
    id: 'print-mgmt-format', label: 'Publishing a report as a print-management format',
    domain: 'Reporting', source: 'topic', tier: 'core', weight: 4,
    aotTypes: ['report', 'class'], knowledgeIds: ['print-management'],
    caseIds: ['L3-print-mgmt-publish-format'],
    note: 'The supported seam is a delegate, not an overlayer: PrintMgmtDocType declares seven, and getDefaultReportFormatDelegate is the one that answers "which report". Signature and enum values read off the shipped class and enum, and proven by L3-print-mgmt-publish-format, whose golden came from a full xppc build with zero errors and zero warnings (2026-09-02). What the case does NOT prove is that print management PICKS the format at runtime; that needs a posted document.',
  },
  {
    id: 'report-logo-barcode', label: 'Logo and barcode on a report (container + encoded string)',
    domain: 'Reporting', source: 'topic', tier: 'total', weight: 3,
    aotTypes: ['report', 'table'], knowledgeIds: ['ssrs-reports'],
    caseIds: ['L4-ssrs-report-logo-barcode'],
    note: 'Two staging problems a printed document always has. The logo is a container from CompanyImage::findByRecord(CompanyInfo::find()).Image, typed with the Bitmap EDT; the barcode is ENCODED through Barcode::construct/string(true, v)/encode()/barcodeStr(), where the one-argument string() is a getter and does not compile. Both APIs read off the shipped classes and proven by L4-ssrs-report-logo-barcode (2026-09-02, xppc clean). Authoring it corrected two of its own claims by census: 280 of 332 shipped container fields DO carry a container EDT, and typing the field with Bitmap is what silences BPErrorTableFieldNotDefinedUsingType. What the case does NOT prove is that the design renders either one — the barcode column still needs barcode.defaultFont() in Report Designer.',
  },
  {
    id: 'document-attachments', label: 'Attachments (DocuRef / DocumentManagement)',
    domain: 'Integration', source: 'topic', tier: 'total', weight: 3,
    aotTypes: ['class'], knowledgeIds: ['document-attachments'], caseIds: ['L3-attachment-docuref-pdf'],
    note: 'attachFile argument 4 is a DocuTypeId string, not a DocuType record — compile-verified, and the mistake attaches the file to an invisible record.',
  },
];
