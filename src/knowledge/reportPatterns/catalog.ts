/**
 * Report-pattern catalog — 7 implementation recipes for D365FO SSRS reports.
 *
 * Every recipe is grounded in what generate_object(mode="scaffold",
 * objectType="report") actually emits (src/tools/smart/generateSmartReport.ts):
 * a pattern here never describes a shape the scaffold cannot produce, so
 * "scaffold" is always the fastest correct path. Deviations that need hand
 * work (print-management document types, preProcess staging) say so in
 * methodNotes rather than pretending the tool covers them.
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
              baseOrType: 'class extends SrsReportDataProviderPreProcess',
              notes:
                'Scaffolded WITHOUT [SRSReportParameterAttribute] (contract travels via the controller) and WITH a preProcess() stub. ' +
                'VERIFY ON VM: the TempDB-table pairing (SrsReportDataProviderPreProcessTempDB) is not yet compile-proven by this repo — see the coverage plan.',
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
              notes: 'main() sets parmPrintMgmtDocType(PrintMgmtDocumentType::…) — replace the scaffolded placeholder with the real document type.',
            }
          : o,
      ),
    ],
    scaffold:
      'generate_object(mode="scaffold", objectType="report", name="ConsignmentNote", fieldsHint="SalesId, DeliveryAddress", controllerType="printMgmt")',
    methodNotes: [
      'A NEW document type needs hand work the scaffold does not do: extend the PrintMgmtDocumentType base enum, subscribe to the getDefaultReportFormatDelegate to map it to ssrsReportStr({Name}, Report), and add the module\'s PrintMgmtNode handling — see the print-management knowledge topic.',
      'For an EXISTING document type, set parmPrintMgmtDocType to it and Print management setup takes over destinations/copies.',
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
];
