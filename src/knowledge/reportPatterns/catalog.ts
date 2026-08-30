/**
 * Report-pattern catalog — 10 implementation recipes for D365FO SSRS reports:
 * seven that CREATE a report and three that EXTEND one that already ships.
 *
 * Every recipe is grounded in what generate_object actually emits — the create
 * seven in generateSmartReport.ts (mode="scaffold"), the extension three in
 * codeGen.ts (mode="pattern") — so a pattern here never describes a shape the
 * tool cannot produce, and "scaffold" is always the fastest correct path.
 * tests/knowledge/reportPatternCatalog.test.ts enforces that by checking every
 * pattern name in this file against CODE_GEN_PATTERNS. Deviations that need
 * hand work (print-management document types, preProcess staging, duplicating
 * a report design) say so in methodNotes rather than pretending otherwise.
 */

import type { ReportObjectSpec, ReportPatternSpec } from './types.js';

/** The roster every RDP-based report shares; patterns extend or replace rows. */
function baseRoster(): ReportObjectSpec[] {
  return [
    {
      role: 'TmpTable',
      naming: '{Name}Tmp',
      baseOrType: 'AxTable, TableType=TempDB',
      notes: 'MUST be TempDB (not InMemory) — required for the SSRS data connection.',
    },
    {
      role: 'Data contract',
      naming: '{Name}Contract',
      baseOrType: 'class, [DataContractAttribute]',
      notes: 'Dialog parameters as [DataMemberAttribute] parm methods; mandatory checks live in validate(), not attributes.',
    },
    {
      role: 'Data provider',
      naming: '{Name}DP',
      baseOrType: 'class extends SrsReportDataProviderBase',
      notes: '[SRSReportParameterAttribute(classStr({Name}Contract))]; processReport() fills the TmpTable; one [SRSReportDataSetAttribute] getter per dataset.',
    },
    {
      role: 'Controller',
      naming: '{Name}Controller',
      baseOrType: 'class extends SrsReportRunController',
      notes: 'main() sets parmReportName(ssrsReportStr({Name}, Report)) — the scaffolded design is named "Report".',
    },
    {
      role: 'Menu item',
      naming: '{Name}',
      baseOrType: 'AxMenuItemOutput',
      notes: 'Object=Controller class, ObjectType=Class.',
    },
    {
      role: 'Report',
      naming: '{Name}',
      baseOrType: 'AxReport with embedded RDL precision design named "Report"',
    },
  ];
}

const SHARED_CROSS_CHECKS = [
  'validate_code(mode="both") on the DP and Controller — RPT001/RPT002 catch a missing parameter attribute or dataset getter, FN001 catches a one-argument ssrsReportStr.',
  'validate_object_naming(objectType="report") — checks the name and lists the companion-object roster.',
  'The controller design name must match the AxReport design ("Report" for scaffolded reports) — ssrsReportStr is compile-time checked.',
  'Build the project (build_d365fo_project) — reports only fail some errors (wrong design name, bad dataset query) at build/deploy.',
];

export const REPORT_PATTERN_CATALOG: ReportPatternSpec[] = [
  {
    id: 'SimpleList',
    displayName: 'Simple List report',
    aliases: ['list', 'basic'],
    purpose: 'A flat tabular report: one TmpTable dataset rendered as a single tablix with a page header.',
    whenToUse: [
      'Row-per-record listing with a handful of filter parameters',
      'The default choice — start here unless another pattern clearly applies',
    ],
    whenNotToUse: [
      'Subtotals/grouping needed → GroupedWithTotals',
      'Header + lines document → HeaderDetail',
      'Posted-document output (invoice, confirmation) → PrintMgmtFormLetter',
    ],
    objects: baseRoster(),
    scaffold:
      'generate_object(mode="scaffold", objectType="report", name="InventByZones", fieldsHint="ItemId, ItemName, Qty, Zone", caption="Inventory by zones", contractParams=[{name:"FromDate", type:"TransDate"}])',
    methodNotes: [
      'processReport(): read contract parms into locals, delete_from tmpTable, then insert_recordset (set-based) or while select + insert.',
      'Keep the dataset getter exactly as scaffolded: [SRSReportDataSetAttribute(tableStr({Name}Tmp))] select * from the buffer.',
    ],
    crossChecks: SHARED_CROSS_CHECKS,
    referenceReports: ['CustTransList'],
    relatedTopics: ['ssrs-reports', 'temp-tables'],
  },
  {
    id: 'GroupedWithTotals',
    displayName: 'Grouped list with totals',
    aliases: ['grouped', 'totals', 'subtotals'],
    purpose: 'Tablix with a row group and SUM aggregates on the numeric columns — subtotal per group, grand total at the end.',
    whenToUse: [
      'Same flat data as SimpleList but users need per-group subtotals (per customer, per warehouse, …)',
    ],
    whenNotToUse: [
      'No aggregation needed → SimpleList (simpler RDL)',
    ],
    objects: baseRoster(),
    scaffold:
      'generate_object(mode="scaffold", objectType="report", name="SalesByCust", fieldsHint="CustAccount, Name, Amount", designStyle="GroupedWithTotals")',
    methodNotes: [
      'The FIRST field in fieldsHint becomes the group key in the generated tablix — order the hint accordingly.',
      'Aggregation happens in RDL (SUM), not in X++ — processReport() still writes detail rows.',
    ],
    crossChecks: SHARED_CROSS_CHECKS,
    relatedTopics: ['ssrs-reports'],
  },
  {
    id: 'HeaderDetail',
    displayName: 'Header + lines (multi-dataset)',
    aliases: ['multidataset', 'headerlines', 'master-detail'],
    purpose: 'Two or more datasets from one DP — a header TmpTable and a lines TmpTable, each exposed by its own getter.',
    whenToUse: [
      'Document-style output: order header with its lines, journal with entries',
      'Any report needing more than one dataset (summary + detail)',
    ],
    whenNotToUse: [
      'Posted documents managed by Print management → PrintMgmtFormLetter',
    ],
    objects: [
      ...baseRoster(),
      {
        role: 'Extra TmpTable(s)',
        naming: '{Name}{Dataset}Tmp',
        baseOrType: 'AxTable, TableType=TempDB',
        notes: 'One per additionalDatasets entry; the DP gains a member + [SRSReportDataSetAttribute] getter for each.',
      },
    ],
    scaffold:
      'generate_object(mode="scaffold", objectType="report", name="SalesOrderDoc", fieldsHint="SalesId, CustAccount, OrderDate", additionalDatasets=[{name:"Lines", fieldsHint:"ItemId, Qty, LineAmount"}])',
    methodNotes: [
      'processReport() fills ALL tmp tables in one pass — link lines to their header by the header key field.',
      'Each dataset getter returns its own buffer; SSRS joins them by dataset name in the RDL, not by table relation.',
    ],
    crossChecks: SHARED_CROSS_CHECKS,
    relatedTopics: ['ssrs-reports', 'temp-tables'],
  },
  {
    id: 'PreProcess',
    displayName: 'Pre-processed data provider (long-running)',
    aliases: ['long-running', 'staged'],
    purpose: 'Stages data BEFORE the SSRS render request so heavy queries do not hit the ~10-minute interactive rendering timeout.',
    whenToUse: [
      'processReport() takes minutes on production volumes',
      'The report times out interactively but the same query succeeds in batch',
    ],
    whenNotToUse: [
      'Normal volumes — the extra staging machinery costs complexity for nothing',
    ],
    objects: [
      ...baseRoster().map(o =>
        o.role === 'Data provider'
          ? {
              ...o,
              baseOrType: 'class extends SrsReportDataProviderPreProcessTempDB',
              notes:
                'Scaffolded WITH [SRSReportParameterAttribute] (every shipped pre-processed DP carries it) and NO extra hook method — ' +
                'processReport() IS the pre-processing step, run on the AOS before the render request. ' +
                'VM-verified 2026-08-30 (L4-ssrs-report-preprocess): xppc accepts either pre-process base with a TempDB table, but 332 of the 370 ' +
                'shipped pre-processed DPs pair TempDB staging tables with SrsReportDataProviderPreProcessTempDB; SrsReportDataProviderPreProcess is ' +
                'the REGULAR-table variant (rows keyed by createdTransactionId).',
            }
          : o,
      ),
    ],
    scaffold:
      'generate_object(mode="scaffold", objectType="report", name="HeavyLedgerRecap", fieldsHint="AccountNum, Amount", preProcess=true)',
    methodNotes: [
      'preProcess() runs before the dialog/render — do the heavy population there.',
      'Regular-table staging variants key rows by createdTransactionId so concurrent runs do not read each other\'s rows.',
    ],
    crossChecks: [
      ...SHARED_CROSS_CHECKS,
      'This is the one pattern the repo has not compile-proven on the VM — build and run it there before trusting the scaffolded shape.',
    ],
    relatedTopics: ['ssrs-reports', 'temp-tables'],
  },
  {
    id: 'PrintMgmtFormLetter',
    displayName: 'Print-management document',
    aliases: ['printmgmt', 'print-management', 'formletter', 'document'],
    purpose: 'A posted-document report (invoice, confirmation, packing slip) whose destination/copies are governed by Print management setup.',
    whenToUse: [
      'Output for a posted business document that users configure per customer/vendor in Print management',
    ],
    whenNotToUse: [
      'Ad-hoc inquiry listing → SimpleList; the Print management machinery is for documents',
    ],
    objects: [
      ...baseRoster().map(o =>
        o.role === 'Controller'
          ? {
              ...o,
              baseOrType: 'class extends SrsPrintMgmtController',
              notes: 'initPrintMgmtReportRun() constructs PrintMgmtReportRun::construct(PrintMgmtHierarchyType::…, PrintMgmtNodeType::…, PrintMgmtDocumentType::…) and hands it the controller; runPrintMgmt() (abstract on the base — mandatory) loads the settings for the record and calls outputReports(). Replace the three scaffolded placeholders with the real hierarchy/node/document type. SrsPrintMgmtController has NO parmPrintMgmtDocType (VM-verified 2026-08-30).',
            }
          : o,
      ),
    ],
    scaffold:
      'generate_object(mode="scaffold", objectType="report", name="ConsignmentNote", fieldsHint="SalesId, DeliveryAddress", controllerType="printMgmt")',
    methodNotes: [
      'A NEW document type needs hand work the scaffold does not do: extend the PrintMgmtDocumentType base enum, subscribe to the getDefaultReportFormatDelegate to map it to ssrsReportStr({Name}, Report), and add the module\'s PrintMgmtNode handling — see the print-management knowledge topic.',
      'For an EXISTING document type, name it in PrintMgmtReportRun::construct(...) inside initPrintMgmtReportRun() and Print management setup takes over destinations/copies.',
    ],
    crossChecks: SHARED_CROSS_CHECKS,
    referenceReports: ['SalesInvoice', 'PurchPurchaseOrder'],
    relatedTopics: ['print-management', 'ssrs-reports'],
  },
  {
    id: 'QueryBased',
    displayName: 'AOT-query data provider',
    aliases: ['query', 'aotquery'],
    purpose: 'The DP consumes a modeled AOT query (user gets the standard query filter dialog) instead of hand-written selects.',
    whenToUse: [
      'Users should filter with the full query dialog (ranges on any field, joins already modeled)',
      'An AOT query for the data shape already exists',
    ],
    whenNotToUse: [
      'The data needs computation/aggregation the query cannot express → SimpleList with hand-written processReport()',
    ],
    objects: [
      ...baseRoster().map(o =>
        o.role === 'Data provider'
          ? {
              ...o,
              notes:
                'Adds [SRSReportQueryAttribute(queryStr(MyQuery))]; processReport() runs this.parmQuery() through a QueryRun and copies rows into the TmpTable.',
            }
          : o,
      ),
    ],
    scaffold:
      'generate_object(mode="scaffold", objectType="report", name="CustOpenItems", fieldsHint="CustAccount, Amount, DueDate", aotQuery="CustOpenTrans")',
    methodNotes: [
      'Keep contract parameters for values the query ranges cannot express (a threshold, a mode toggle) — both can coexist.',
    ],
    crossChecks: SHARED_CROSS_CHECKS,
    relatedTopics: ['ssrs-reports', 'query-object-model'],
  },
  {
    id: 'UIBuilderDialog',
    displayName: 'Custom dialog (UI builder)',
    aliases: ['uibuilder', 'dialog'],
    purpose: 'Adds a UI-builder class so the parameter dialog gets custom lookups, dependent fields, or field events.',
    whenToUse: [
      'A parameter needs a filtered lookup, cascading enable/disable, or a modified() reaction',
    ],
    whenNotToUse: [
      'Plain parameters render fine automatically — no builder class needed',
    ],
    objects: [
      ...baseRoster().map(o =>
        o.role === 'Data contract'
          ? {
              ...o,
              notes: 'Additionally carries [SysOperationContractProcessing(classStr({Name}UIBuilder))] binding the builder to the dialog.',
            }
          : o,
      ),
      {
        role: 'UI builder',
        naming: '{Name}UIBuilder',
        baseOrType: 'class extends SrsReportDataContractUIBuilder',
        notes: 'Override build(); fetch fields via this.bindInfo().getDialogField(contract, methodStr(...)) and attach lookups/events.',
      },
    ],
    scaffold:
      'generate_object(mode="scaffold", objectType="report", name="CustAging", fieldsHint="CustAccount, Balance", contractParams=[{name:"CustGroup", type:"CustGroupId"}], uiBuilder=true)',
    methodNotes: [
      'build(): call super() first, then customize the dialog fields.',
      'Register overrides (lookup/modified) on the dialog field, not on the form control directly.',
    ],
    crossChecks: SHARED_CROSS_CHECKS,
    relatedTopics: ['ssrs-reports', 'sysoperation'],
  },

  // ── Extending a report that already exists ──────────────────────────────
  //
  // The seven recipes above CREATE a report. The three below change one that
  // already ships, and none of them touches a standard object: no overlayering,
  // no edit to the RDP class, the temp table or the report. Every X++ shape
  // named here was compiled on the VM (xppc 7.0.7996.33) before it was written
  // down — including a negative control, because a probe that reports nothing
  // is not a probe that passed.
  {
    id: 'DatasetExtension',
    displayName: 'Add a column to a standard report',
    aliases: ['report-dataset-extension', 'add-column', 'extend-dataset'],
    purpose: 'Adds field(s) to a standard report\'s dataset by extending its temp table and filling them from a handler.',
    whenToUse: [
      'Users need one more column on a report the platform already ships',
      'The data is reachable from what the standard provider already selected',
    ],
    whenNotToUse: [
      'The layout has to change as well → CustomDesign (a new column still needs placing in the RDL)',
      'You are building the report yourself → SimpleList and friends',
    ],
    objects: [
      {
        role: 'Temp table extension',
        naming: '{TmpTable}.{Prefix}Extension',
        baseOrType: 'AxTableExtension on the report\'s dataset table',
        notes: 'The standard temp table stays untouched; your field(s) live in the extension. Find the table on the DP method carrying [SRSReportDataSetAttribute(tableStr(…))].',
      },
      {
        role: 'Handler',
        naming: '{DP}{Prefix}_EventHandler',
        baseOrType: 'class (no base) with one handler method',
        notes: 'Bulk: [PostHandlerFor(classStr({DP}), methodStr({DP}, processReport))] with (XppPrePostArgs _args). Per row: [DataEventHandler(tableStr({TmpTable}), DataEventType::Inserting)] with (Common _sender, DataEventArgs _e).',
      },
      {
        role: 'Report / DP / controller',
        naming: '—',
        baseOrType: 'standard, UNCHANGED',
        notes: 'Nothing is duplicated: a platform change to the provider still reaches your column.',
      },
    ],
    scaffold:
      'generate_object(mode="pattern", pattern="report-dataset-extension", name="AssetBarCodeDP", baseName="AssetBarCodeTmp", params:{datasetAccessor:"geAssetBarCodeTmp"})',
    methodNotes: [
      'Bulk vs per row is the one real choice: one pass over the finished temp table for a lookup that serves the whole set, a row handler for a calculation. The row handler needs no accessor, which is why it is what the scaffold emits when datasetAccessor is omitted.',
      'The bulk handler MUST share the provider\'s temp table instance: tmpUpdate.linkPhysicalTableInstance(dataProvider.<accessor>()). A buffer merely declared in the handler is a DIFFERENT, empty table, and the handler then appears to work while updating nothing.',
      'The dataset accessor cannot be derived from the table name — read it off the DP. The platform\'s own AssetBarCodeDP spells its getter "geAssetBarCodeTmp", a shipped typo.',
      '_args.getThis() is typed Object: downcast with `as` and test the result before use.',
      'A handler whose parameter profile does not match is a COMPILE error, not a runtime surprise.',
    ],
    crossChecks: [
      'The added field must exist before the handler compiles — write the table extension first.',
      'validate_code(mode="both") on the handler — FN001/FN002 catch a wrong argument count or an AX 2012 function name.',
      'Build the model: the intrinsics (classStr/methodStr/tableStr) are all compile-time checked, so a wrong DP or table name fails here rather than at run time.',
      'A new column still has to be placed in the RDL design and the report re-deployed; the X++ alone changes nothing visible.',
    ],
    referenceReports: ['AssetBarCode'],
    relatedTopics: ['report-extension-patterns', 'ssrs-reports', 'event-handlers'],
  },
  {
    id: 'CustomDesign',
    displayName: 'Custom design for a standard document',
    aliases: ['report-custom-design', 'replace-design', 'custom-layout'],
    purpose: 'Replaces the LAYOUT of a standard business document with your own, keeping its data contract and provider.',
    whenToUse: [
      'A posted document (invoice, confirmation, packing slip) has to look different',
      'The data is right and only the presentation is wrong',
    ],
    whenNotToUse: [
      'Only a column is missing → DatasetExtension (much less to own)',
      'The document type does not exist yet → PrintMgmtFormLetter (a new document, not an override)',
    ],
    objects: [
      {
        role: 'Report copy',
        naming: '{Prefix}{Report}',
        baseOrType: 'AxReport duplicated into your model and renamed',
        notes: 'Duplicate the DESIGN, not the solution: the copy keeps consuming the standard contract and DP, so platform changes to those still reach it.',
      },
      {
        role: 'Controller',
        naming: '{Prefix}{Report}Controller',
        baseOrType: 'class extends the STANDARD report\'s controller',
        notes: 'main(): parmArgs(_args), parmReportName(ssrsReportStr({Prefix}{Report}, <DesignName>)), startOperation(). There is no initArgs anywhere in the SrsReportRunController hierarchy.',
      },
      {
        role: 'Print-management handler',
        naming: '{Prefix}{Report}PrintMgmtHandler',
        baseOrType: 'class with a [SubscribesTo] delegate handler',
        notes: 'getDefaultReportFormatDelegate(PrintMgmtDocumentType, EventHandlerResult) — answer only the document types you replace. PrintMgmtDocType exposes seven delegates, all with this same shape.',
      },
      {
        role: 'Menu item extension',
        naming: '{StandardMenuItem}.{Prefix}Extension',
        baseOrType: 'AxMenuItemOutputExtension',
        notes: 'Point its Object at your controller. Without it the menu item still starts the standard one and neither class above runs.',
      },
    ],
    scaffold:
      'generate_object(mode="pattern", pattern="report-custom-design", name="SalesInvoice", baseName="SalesInvoiceController", params:{documentType:"SalesOrderInvoice", designName:"Report"})',
    methodNotes: [
      'Duplicate and rename the report FIRST — neither generated class compiles until the copy exists.',
      'The second argument of ssrsReportStr is the DESIGN inside the report, not the report name repeated. It is compile-time checked; read it off the AxReport rather than assuming "Report".',
      'Answer only the document types you are replacing in the switch, and let the platform resolve the rest.',
    ],
    crossChecks: [
      ...SHARED_CROSS_CHECKS.slice(0, 1),
      'The base controller and the design name are both compile-time checked — a wrong one fails the build, which is the cheap way to find out.',
      'Deploy the report after building; a design change that is not deployed shows the OLD layout with no error at all.',
    ],
    referenceReports: ['SalesInvoice', 'SalesConfirm'],
    relatedTopics: ['report-extension-patterns', 'print-management', 'ssrs-reports'],
  },
  {
    id: 'MenuRedirect',
    displayName: 'Point an existing report run at your design',
    aliases: ['report-menu-redirect', 'redirect-report'],
    purpose: 'Sends an existing report run to your own design without editing the standard report or chasing its callers.',
    whenToUse: [
      'The design is already duplicated and only the routing is left',
      'The report is reached from several places and you do not want to find them all',
    ],
    whenNotToUse: [
      'You also need print-management to resolve the document type → CustomDesign covers both',
    ],
    objects: [
      {
        role: 'Menu item extension',
        naming: '{StandardMenuItem}.{Prefix}Extension',
        baseOrType: 'AxMenuItemOutputExtension',
        notes: 'The route that works for EVERY report: change the Object (or the report/design) on an extension of the existing output menu item.',
      },
      {
        role: 'Controller handler (alternative)',
        naming: '{Controller}{Prefix}_EventHandler',
        baseOrType: 'class with [PostHandlerFor(…, staticMethodStr({Controller}, construct))]',
        notes: 'Catches every route into the report at once, because they all go through construct(). Requires a STATIC construct() on the controller — SalesInvoiceController has one, AssetBarCodeController does not.',
      },
    ],
    scaffold:
      'generate_object(mode="pattern", pattern="report-menu-redirect", name="SalesInvoiceController", baseName="MyInvoiceReport", params:{designName:"Report"})',
    methodNotes: [
      'Confirm the controller HAS a static construct() with get_object_info before generating — staticMethodStr fails the build otherwise, and roughly half of the shipped report controllers expose only main().',
      'In the handler: _args.getReturnValue() as SrsReportRunController, test for null, then parmReportName(ssrsReportStr(<YourReport>, <DesignName>)).',
      'When there is no construct(), the menu item extension is not a fallback but the better answer — it is metadata, so nothing has to compile.',
    ],
    crossChecks: [
      'get_object_info on the controller — does construct() exist, and is it static?',
      'validate_code(mode="both") on the handler.',
      'Build: classStr/staticMethodStr/ssrsReportStr are all compile-time checked.',
    ],
    referenceReports: ['SalesInvoice'],
    relatedTopics: ['report-extension-patterns', 'ssrs-reports'],
  },
];
