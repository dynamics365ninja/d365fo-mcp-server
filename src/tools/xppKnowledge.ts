/**
 * X++ Knowledge Base Tool
 * Queryable knowledge base of D365FO / X++ patterns, best practices,
 * and AX2012 → D365FO migration guidance.
 *
 * Data is embedded — no DB or disk access needed. Available in all server modes.
 */

import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

// ─── Schema ─────────────────────────────────────────────────────────────────

const XppKnowledgeArgsSchema = z.object({
  topic: z.string().describe(
    'Topic to query — e.g. "batch job", "ttsbegin", "RunBase vs SysOperation", ' +
    '"set-based operations", "CoC", "data entities", "number sequences", "security", ' +
    '"temp tables", "today() deprecated", "query patterns", "form patterns"'
  ),
  format: z.enum(['concise', 'detailed']).optional().default('concise').describe(
    'concise = quick reference (default), detailed = full explanation with code examples'
  ),
});

export const xppKnowledgeToolDefinition = {
  name: 'get_xpp_knowledge',
  description:
    'Queryable knowledge base of D365FO X++ patterns, best practices, and AX2012→D365FO migration guidance. ' +
    'Returns distilled, verified patterns with code examples. Use BEFORE generating code to avoid deprecated ' +
    'APIs and AX2012 anti-patterns. Topics: batch jobs, transactions, queries, CoC/extensions, security, ' +
    'data entities, temp tables, number sequences, form patterns, set-based operations, error handling, ' +
    'SysOperation framework, and more.',
  inputSchema: XppKnowledgeArgsSchema,
};

// ─── Knowledge Entry Type ───────────────────────────────────────────────────

interface KnowledgeEntry {
  id: string;
  title: string;
  /** Search keywords (lowercase) for matching */
  keywords: string[];
  /** One-paragraph summary */
  summary: string;
  /** AX2012 anti-pattern → D365FO correct pattern */
  migration?: { ax2012: string; d365fo: string };
  /** Concise bullet-point rules */
  rules: string[];
  /** Code examples (shown in detailed mode) */
  examples?: { label: string; code: string }[];
  /** Related entry IDs */
  related?: string[];
}

// ─── Knowledge Base ─────────────────────────────────────────────────────────

const KNOWLEDGE_BASE: KnowledgeEntry[] = [
  // ── Batch / SysOperation ────────────────────────────────────────────────
  {
    id: 'sysoperation',
    title: 'SysOperation Framework (replaces RunBase)',
    keywords: ['batch', 'sysoperation', 'runbase', 'batch job', 'dialog', 'contract', 'controller', 'service', 'srsreportruncontroller'],
    summary:
      'D365FO uses the SysOperation framework for batch-capable operations. ' +
      'RunBase still works but is legacy — new code should always use SysOperation. ' +
      'The framework separates concerns: DataContract (parameters), Service (logic), Controller (execution).',
    migration: {
      ax2012: 'class MyBatch extends RunBaseBatch { dialog(), run(), pack/unpack }',
      d365fo: 'DataContract + Service class + Controller (or just [SysEntryPointAttribute] service)',
    },
    rules: [
      'New batch jobs: ALWAYS use SysOperation (DataContract + Service + Controller)',
      'RunBase is legacy — only extend existing RunBase classes, never create new ones',
      'DataContract: decorate with [DataContractAttribute], parm methods with [DataMemberAttribute]',
      'Service: business logic class, no UI references',
      'Controller: extends SysOperationServiceController, sets caption, calls service',
      'For simple batch: controller.parmClassName / parmMethodName can point directly to a static method',
      'Menu items: type = Action, point to Controller class',
    ],
    examples: [
      {
        label: 'DataContract',
        code: `[DataContractAttribute]
class MyProcessContract
{
    TransDate   fromDate;
    TransDate   toDate;

    [DataMemberAttribute,
     SysOperationLabelAttribute(literalStr("@MyModel:FromDate")),
     SysOperationDisplayOrderAttribute('1')]
    public TransDate parmFromDate(TransDate _fromDate = fromDate)
    {
        fromDate = _fromDate;
        return fromDate;
    }

    [DataMemberAttribute,
     SysOperationLabelAttribute(literalStr("@MyModel:ToDate")),
     SysOperationDisplayOrderAttribute('2')]
    public TransDate parmToDate(TransDate _toDate = toDate)
    {
        toDate = _toDate;
        return toDate;
    }
}`,
      },
      {
        label: 'Service',
        code: `class MyProcessService
{
    /// <summary>
    /// Processes records within the specified date range.
    /// </summary>
    public void processRecords(MyProcessContract _contract)
    {
        TransDate fromDate = _contract.parmFromDate();
        TransDate toDate   = _contract.parmToDate();

        // Business logic here
    }
}`,
      },
      {
        label: 'Controller',
        code: `class MyProcessController extends SysOperationServiceController
{
    /// <summary>
    /// Constructs the controller for the batch operation.
    /// </summary>
    public static MyProcessController construct()
    {
        MyProcessController controller = new MyProcessController();
        controller.parmClassName(classStr(MyProcessService));
        controller.parmMethodName(methodStr(MyProcessService, processRecords));
        return controller;
    }

    public static void main(Args _args)
    {
        MyProcessController controller = MyProcessController::construct();
        controller.parmDialogCaption("@MyModel:ProcessRecords");
        controller.startOperation();
    }
}`,
      },
    ],
    related: ['transactions', 'error-handling'],
  },

  // ── Transactions ────────────────────────────────────────────────────────
  {
    id: 'transactions',
    title: 'Transaction Handling (ttsbegin / ttscommit)',
    keywords: ['tts', 'ttsbegin', 'ttscommit', 'ttsabort', 'transaction', 'concurrency', 'occ', 'optimistic concurrency', 'update conflict'],
    summary:
      'X++ uses ttsbegin/ttscommit for transaction scoping. Transactions are nestable (reference-counted). ' +
      'OCC (Optimistic Concurrency Control) is the default — always handle UpdateConflict exceptions.',
    rules: [
      'ALWAYS pair ttsbegin with ttscommit — unbalanced calls cause runtime crash',
      'NEVER put try/catch INSIDE ttsbegin..ttscommit — transaction is already rolled back when exception is caught',
      'Put try/catch OUTSIDE the tts block, catch UpdateConflict, then retry',
      'Use forupdate keyword on select when modifying records',
      'Use pessimisticlock for high-concurrency scenarios (e.g. number sequences)',
      'NEVER call ttsabort() as normal flow — it\'s for unrecoverable situations only',
      'Set-based operations (update_recordset, insert_recordset) run inside implicit tts if not explicitly scoped',
      'Maximum retry count for OCC: typically 5 (use a counter variable)',
    ],
    examples: [
      {
        label: 'Correct OCC retry pattern',
        code: `int retryCount = 0;
const int maxRetries = 5;
boolean success = false;

while (!success && retryCount < maxRetries)
{
    try
    {
        ttsbegin;
        CustTable custTable;
        select forupdate custTable
            where custTable.AccountNum == '1001';
        custTable.CreditMax = 10000;
        custTable.update();
        ttscommit;
        success = true;
    }
    catch (Exception::UpdateConflict)
    {
        retryCount++;
        if (retryCount >= maxRetries)
        {
            throw Exception::UpdateConflictNotRecovered;
        }
        // retry — loop continues
    }
}`,
      },
      {
        label: 'WRONG — try/catch inside tts',
        code: `// ❌ NEVER DO THIS — transaction is already rolled back
ttsbegin;
try
{
    custTable.update();
}
catch
{
    // tts is already broken — this does NOT help
}
ttscommit; // ← will crash: tts level mismatch`,
      },
    ],
    related: ['set-based', 'error-handling'],
  },

  // ── Set-Based Operations ────────────────────────────────────────────────
  {
    id: 'set-based',
    title: 'Set-Based Operations (insert_recordset, update_recordset, delete_from)',
    keywords: ['set-based', 'insert_recordset', 'update_recordset', 'delete_from', 'recordinsertlist', 'bulk', 'performance', 'record by record'],
    summary:
      'Set-based operations execute in a single SQL statement instead of row-by-row. ' +
      'They are 10-100x faster for bulk operations. D365FO adds RecordInsertList for batch inserts.',
    migration: {
      ax2012: 'while select + insert/update/delete in a loop (record-by-record)',
      d365fo: 'insert_recordset / update_recordset / delete_from / RecordInsertList',
    },
    rules: [
      'ALWAYS prefer set-based operations over while-select + DML loops',
      'insert_recordset: bulk insert from one table to another with field mapping',
      'update_recordset: bulk update with WHERE clause, no row-by-row fetch needed',
      'delete_from: bulk delete with WHERE clause',
      'RecordInsertList: use when constructing records in code (not from another table)',
      'RecordInsertList.add() → insertDatabase() at the end — single round-trip',
      'Set-based operations skip insert/update/delete overrides — call skipDatabaseLog, skipDataMethods, etc. only when safe',
      'If table has overridden insert()/update()/delete(), set-based falls back to row-by-row unless you call skipDataMethods(true)',
      'BP rule: BPCheckNestedLoopinCode — NEVER nest while-select inside another while-select; use joins instead',
    ],
    examples: [
      {
        label: 'update_recordset',
        code: `update_recordset custTable
    setting CreditMax = 0
    where custTable.Blocked == CustVendorBlocked::All;`,
      },
      {
        label: 'insert_recordset',
        code: `insert_recordset tmpTable (AccountNum, Name)
    select AccountNum, Name
    from custTable
    where custTable.CustGroup == 'DOM';`,
      },
      {
        label: 'RecordInsertList',
        code: `RecordInsertList insertList = new RecordInsertList(tableNum(MyTmpTable));
MyTmpTable tmp;

while select custTable
    where custTable.CustGroup == 'DOM'
{
    tmp.clear();
    tmp.AccountNum = custTable.AccountNum;
    tmp.Name       = custTable.Name;
    insertList.add(tmp);
}

insertList.insertDatabase();`,
      },
    ],
    related: ['transactions', 'query-patterns'],
  },

  // ── Query Patterns ──────────────────────────────────────────────────────
  {
    id: 'query-patterns',
    title: 'Query Patterns & Select Statements',
    keywords: ['query', 'select', 'while select', 'join', 'exists join', 'notexists join', 'outer join', 'firstonly', 'firstfast', 'forceplaceholders', 'forceselectorder', 'index hint', 'crosscompany'],
    summary:
      'X++ select statements support joins, aggregates, and query hints. ' +
      'Use exists join for filtering, outer join for optional data, firstonly for single records.',
    rules: [
      'Use firstonly when you need exactly one record — avoids full table scan',
      'Use exists join (not inner join) when you only need to check existence from the joined table',
      'Use notexists join for "does not exist" conditions',
      'Avoid nested while-select loops — use joins in a single select instead',
      'NEVER call functions directly in WHERE conditions — assign to a variable first (performance + readability)',
      'crosscompany keyword: use for cross-company queries, pass container of companies',
      'forceplaceholders: use in batch operations to get parameterized SQL plans',
      'forceselectorder: use only when you know the optimizer picks a wrong plan',
      'index hint: last resort — prefer letting the optimizer choose',
      'SysQuery class: use for building dynamic query objects (QueryBuildRange, QueryBuildDataSource)',
      'QueryRun: use for executing query objects, supports prompt() for user dialog',
    ],
    examples: [
      {
        label: 'exists join',
        code: `CustTable custTable;
CustTrans custTrans;
// ✅ Assign to variable before WHERE — never call functions directly in WHERE conditions
TransDate cutoffDate = DateTimeUtil::getSystemDate(DateTimeUtil::getUserPreferredTimeZone()) - 30;

while select AccountNum, Name from custTable
    exists join custTrans
        where custTrans.AccountNum == custTable.AccountNum
           && custTrans.TransDate  >= cutoffDate
{
    info(strFmt('%1 - %2', custTable.AccountNum, custTable.Name));
}`,
      },
      {
        label: 'SysQuery dynamic range',
        code: `Query query = new Query(queryStr(CustTableListPage));
QueryBuildDataSource qbds = query.dataSourceTable(tableNum(CustTable));
SysQuery::findOrCreateRange(qbds, fieldNum(CustTable, CustGroup)).value('DOM');
QueryRun qr = new QueryRun(query);

while (qr.next())
{
    CustTable custTable = qr.get(tableNum(CustTable));
    // process record
}`,
      },
    ],
    related: ['set-based', 'performance'],
  },

  // ── Chain of Command ────────────────────────────────────────────────────
  {
    id: 'coc',
    title: 'Chain of Command (CoC) Extensions',
    keywords: ['coc', 'chain of command', 'extension', 'extensionof', 'next', 'wrapping', 'overlay', 'overlayer', 'overlayering'],
    summary:
      'CoC replaces overlayering (which is completely blocked in D365FO). ' +
      'Extension classes wrap methods by calling next to invoke the original + other extensions.',
    migration: {
      ax2012: 'Overlayering: modify the original class/method directly in the same layer',
      d365fo: 'CoC: [ExtensionOf(classStr(Original))] final class Original_Extension { method() { next method(); } }',
    },
    rules: [
      'Extension class MUST be [ExtensionOf(classStr/tableStr/formStr(Target))]',
      'Extension class MUST be final',
      'Method signature MUST match the original exactly (use get_method_signature tool)',
      'ALWAYS call next <methodName>() — skipping it breaks the chain for other extensions',
      'Cannot access private members of the original class',
      'Can wrap: public, protected methods; cannot wrap: private, static',
      'For static methods: use [PostHandlerFor] / [PreHandlerFor] event handlers instead',
      'Naming: <TargetClass>_<YourModel>_Extension (e.g. SalesTable_ContosoExt_Extension)',
      'Form CoC: [ExtensionOf(formStr(CustTable))] — wraps form methods like init(), run()',
      'Form datasource CoC: wrap datasource methods like init(), validateWrite()',
    ],
    examples: [
      {
        label: 'Table method CoC',
        code: `[ExtensionOf(tableStr(CustTable))]
final class CustTable_MyModel_Extension
{
    /// <summary>
    /// Adds custom validation for credit limit.
    /// </summary>
    public boolean validateWrite()
    {
        boolean ret = next validateWrite();

        if (ret && this.CreditMax > 1000000)
        {
            ret = checkFailed("@MyModel:CreditLimitExceeded");
        }

        return ret;
    }
}`,
      },
      {
        label: 'Class method CoC',
        code: `[ExtensionOf(classStr(SalesFormLetter))]
final class SalesFormLetter_MyModel_Extension
{
    /// <summary>
    /// Extends posting logic with custom dimension validation.
    /// </summary>
    protected void postInvoice()
    {
        // Pre-processing
        this.myValidateDimensions();

        next postInvoice();

        // Post-processing
        this.myUpdateCustomStatus();
    }
}`,
      },
    ],
    related: ['event-handlers', 'form-patterns'],
  },

  // ── Event Handlers ──────────────────────────────────────────────────────
  {
    id: 'event-handlers',
    title: 'Event Handlers & Delegates',
    keywords: ['event', 'handler', 'delegate', 'dataeventhandler', 'subscribesto', 'prehandlerfor', 'posthandlerfor', 'on inserting', 'on inserted', 'on validating', 'on validated'],
    summary:
      'Event handlers subscribe to table data events, class delegates, or pre/post method events. ' +
      'Use when CoC is not possible (static methods, or when you need fire-and-forget).',
    rules: [
      'Table data events: use [DataEventHandler(tableStr(X), DataEventType::Inserted)]',
      'Data event types: Inserting, Inserted, Updating, Updated, Deleting, Deleted, ValidatedWrite, ValidatedDelete, ValidatingWrite, ValidatingDelete, etc.',
      'Custom delegates: use [SubscribesTo(classStr(X), delegateStr(X, myDelegate))]',
      'Pre/Post: use [PreHandlerFor(classStr(X), methodStr(X, myMethod))] or PostHandlerFor',
      'Handler methods MUST be static void',
      'DataEventHandler signature: static void handler(Common _sender, DataEventArgs _e)',
      'Validating events: cast _e to ValidateEventArgs, call _e.parmValidateResult(false) to fail',
      'NEVER use SubscribesTo + delegateStr for standard table data events — use DataEventHandler',
    ],
    examples: [
      {
        label: 'Table data event handler',
        code: `class CustTableEventHandler
{
    [DataEventHandler(tableStr(CustTable), DataEventType::Inserting)]
    public static void onInserting(Common _sender, DataEventArgs _e)
    {
        CustTable custTable = _sender as CustTable;
        // Set default values before insert
        if (!custTable.CreditMax)
        {
            custTable.CreditMax = 5000;
        }
    }

    [DataEventHandler(tableStr(CustTable), DataEventType::ValidatingWrite)]
    public static void onValidatingWrite(Common _sender, DataEventArgs _e)
    {
        ValidateEventArgs validateArgs = _e as ValidateEventArgs;
        CustTable custTable = _sender as CustTable;

        if (custTable.CreditMax > 1000000)
        {
            validateArgs.parmValidateResult(
                checkFailed("@MyModel:CreditLimitExceeded"));
        }
    }
}`,
      },
    ],
    related: ['coc'],
  },

  // ── Data Entities ───────────────────────────────────────────────────────
  {
    id: 'data-entities',
    title: 'Data Entities & OData',
    keywords: ['data entity', 'odata', 'integration', 'import', 'export', 'dmf', 'data management', 'aif', 'composite entity', 'staging'],
    summary:
      'Data entities replace AIF document services. They provide a single contract for import/export/OData. ' +
      'Entity = virtual table backed by one or more real tables with field mappings.',
    migration: {
      ax2012: 'AIF Document Services (AxdSalesOrder), custom services',
      d365fo: 'Data entities + OData endpoints + Data Management Framework (DMF)',
    },
    rules: [
      'Data entity = view + insert/update/delete logic mapped to underlying tables',
      'Primary data source: the "root" table (e.g. CustTable for CustCustomerV3Entity)',
      'IsPublic = Yes: exposes as OData endpoint at /data/EntityNamePlural',
      'Staging table: auto-generated for DMF import/export — name is <Entity>Staging',
      'Entity category: Document (header+lines), Master (single table), Reference, Transaction, Parameter',
      'Use AutoIdentification field group for natural key (maps to AlternateKey)',
      'Mapping: entity fields map to data source fields — handle computed/unmapped columns via virtual fields + postLoad/mapEntityToDataSource',
      'Composite entity: wraps multiple entities for header+lines import (e.g. SalesOrderV2 + SalesOrderLine)',
      'NEVER create AIF document services in D365FO — always use data entities',
    ],
    related: ['query-patterns'],
  },

  // ── Temp Tables ─────────────────────────────────────────────────────────
  {
    id: 'temp-tables',
    title: 'Temporary Tables (TempDB vs InMemory)',
    keywords: ['temp', 'temporary', 'tempdb', 'inmemory', 'tmp', 'report', 'ssrs'],
    summary:
      'D365FO has two types of temp tables: TempDB (SQL Server tempdb) and InMemory (ISAM client-side). ' +
      'TempDB is almost always preferred. InMemory is legacy from AX 2009.',
    migration: {
      ax2012: 'Table property Temporary=Yes → InMemory temp table',
      d365fo: 'TableType=TempDB (preferred) or TableType=InMemory (legacy)',
    },
    rules: [
      'TempDB: stored in SQL Server tempdb — supports efficient joins and set-based operations',
      'InMemory: ISAM file on AOS tier — joins and set-based operations are SLOW',
      'SSRS reports: ALWAYS use TempDB for report temp tables (SRSTmpTable pattern)',
      'TempDB tables: scoped to the session/method — automatically dropped when no longer referenced',
      'TempDB supports insert_recordset, update_recordset, delete_from — InMemory does NOT',
      'To pass TempDB data between tiers: use container or RecordSortedList',
      'TableType is NOT the same as TableGroup — TableType=TempDB, TableGroup=Main/Transaction/etc.',
      'Default TableType is RegularTable (permanent) — omit from XML for regular tables',
    ],
    examples: [
      {
        label: 'TempDB table for SSRS report',
        code: `// Table definition: TableType = TempDB, TableGroup = Main
// Fields: ItemId (EDT: ItemId), ItemName (EDT: ItemName), Qty (EDT: Qty)

// In the DP class:
[SRSReportParameterAttribute(classStr(MyReportContract))]
class MyReportDP extends SRSReportDataProviderBase
{
    MyReportTmp tmpTable;

    [SRSReportDataSetAttribute(tableStr(MyReportTmp))]
    public MyReportTmp getMyReportTmp()
    {
        select tmpTable;
        return tmpTable;
    }

    public void processReport()
    {
        MyReportContract contract = this.parmDataContract() as MyReportContract;
        this.populateTmpTable(contract);
    }
}`,
      },
    ],
    related: ['sysoperation', 'set-based'],
  },

  // ── Error Handling ──────────────────────────────────────────────────────
  {
    id: 'error-handling',
    title: 'Error Handling Patterns',
    keywords: ['error', 'exception', 'try', 'catch', 'throw', 'info', 'warning', 'checkfailed', 'infolog', 'global', 'clrcreatedexception'],
    summary:
      'X++ uses a structured exception model with mandatory labels for all user-facing messages.',
    rules: [
      'ALWAYS use label references in info(), warning(), error() — never hardcoded strings (BPErrorLabelIsText)',
      'checkFailed(): posts error to infolog AND returns false — use in validateWrite/validateField',
      'Return pattern: ret = ret && checkFailed("@Label:Message") — accumulates all errors before returning',
      'Exception types: Error, Warning, Info, Deadlock, UpdateConflict, DuplicateKeyConflict, CLRError',
      'Catch specific exceptions — avoid bare catch without type',
      'CLR interop: catch(Exception::CLRError) then use CLRInterop::getLastException() for details',
      'Global::error() = same as error() — both post to infolog',
      'NEVER swallow exceptions silently — at minimum log them',
      'After catching UpdateConflict: retry or throw UpdateConflictNotRecovered',
    ],
    examples: [
      {
        label: 'validateWrite pattern',
        code: `public boolean validateWrite()
{
    boolean ret = super();

    ret = ret && this.AccountNum
        ? true
        : checkFailed("@MyModel:AccountNumRequired");

    ret = ret && this.CreditMax >= 0
        ? true
        : checkFailed("@MyModel:CreditMaxNegative");

    return ret;
}`,
      },
    ],
    related: ['transactions', 'labels'],
  },

  // ── Labels ──────────────────────────────────────────────────────────────
  {
    id: 'labels',
    title: 'Labels & Localization',
    keywords: ['label', 'localization', 'translation', 'literalstr', 'strfmt', 'bperrorlabelistext', 'hardcoded'],
    summary:
      'Every user-visible string MUST be a label. D365FO enforces this via BP rule BPErrorLabelIsText.',
    rules: [
      'ALL user-facing text must use labels: @ModelName:LabelId',
      'BP check BPErrorLabelIsText fires on any hardcoded string in info/warning/error/dialog',
      'Label ID naming: describe the MEANING, no model prefix (e.g. CustomerName, not ContosoExtCustomerName)',
      'Label file: the prefix comes from the file name (e.g. @ContosoExt:CustomerName)',
      'Use strFmt() for parameterized messages: strFmt("@MyModel:ItemNotFound", itemId)',
      'Use literalStr() when BP complains about strFmt argument not being a label — wraps non-label string safely',
      'search_labels() before create_label() — avoid duplicates',
      'Provide translations for all required languages in create_label()',
    ],
    related: ['error-handling'],
  },

  // ── Deprecated APIs ─────────────────────────────────────────────────────
  {
    id: 'deprecated',
    title: 'Deprecated APIs & Replacements',
    keywords: ['deprecated', 'obsolete', 'sysobsolete', 'today', 'curext', 'infolog', 'fieldnum', 'aif'],
    summary:
      'D365FO deprecates many AX2012 APIs. Using deprecated APIs triggers BP warnings/errors.',
    rules: [
      'today() → DateTimeUtil::getSystemDate(DateTimeUtil::getUserPreferredTimeZone()) — BPUpgradeCodeToday; NEVER use today() in new code',
      'NEVER call today() or any function directly in a WHERE condition — assign to a variable first',
      'curext() → use Ledger::primaryForLegalEntity(CompanyInfo::findDataArea(curext()).RecId)',
      'AIF services → Data entities + OData',
      'RunBase → SysOperation framework',
      'display/edit methods on forms → computed columns or data entity virtual fields',
      'infolog.add() → info()/warning()/error() global functions',
      'fieldnum(tableName, fieldName) → still valid but use fieldNum() macro for compile-time safety',
      '[SysObsolete] attribute: ALWAYS read the message — it names the replacement',
      'When get_method_source returns a method with [SysObsolete], do NOT call it — use the stated replacement',
    ],
    related: ['labels', 'data-entities', 'sysoperation'],
  },

  // ── Number Sequences ────────────────────────────────────────────────────
  {
    id: 'number-sequences',
    title: 'Number Sequences',
    keywords: ['number sequence', 'numberseq', 'numseq', 'voucher', 'continuous', 'scope', 'numbersequencereference'],
    summary:
      'Number sequences generate unique, configurable identifiers for master data and transactions. ' +
      'They support scope (shared, company, legal entity) and format segments.',
    rules: [
      'Define in NumberSequenceModuleXxx class (e.g. NumberSequenceModuleCustPaym)',
      'loadModule() method: register each number sequence reference with its EDT, label, and scope',
      'Use NumberSeqFormHandler on forms for auto-number behavior',
      'Continuous sequences: no gaps allowed — performance impact, use only when legally required',
      'Non-continuous (default): allows gaps — faster, use for internal IDs',
      'Call NumberSeq::newGetNum() to fetch next number at runtime',
      'Scope: DataArea (per-company), Global (cross-company), OperatingUnit',
      'Format: {Company}-{NumberSequence:#######} — configurable in Number sequences form',
    ],
    examples: [
      {
        label: 'Fetching next number',
        code: `NumberSequenceReference numSeqRef =
    NumberSeqReference::findReference(
        extendedTypeNum(MyDocumentId));

NumberSeq numSeq = NumberSeq::newGetNum(numSeqRef);
MyDocumentId newId = numSeq.num();

// If insert fails, release the number:
// numSeq.abort();`,
      },
    ],
    related: ['transactions'],
  },

  // ── Form Patterns ───────────────────────────────────────────────────────
  {
    id: 'form-patterns',
    title: 'Form Patterns & Form Extensions',
    keywords: ['form', 'pattern', 'simplelist', 'simplelistdetails', 'detailsmaster', 'detailstransaction', 'listpage', 'dialog', 'lookup', 'formrun', 'formextension'],
    summary:
      'D365FO forms follow standard patterns enforced by the form pattern dialog. ' +
      'Extensions add controls/overrides without modifying the original form.',
    rules: [
      'Standard patterns: SimpleList, SimpleListDetails, DetailsMaster, DetailsTransaction, Dialog, ListPage, TableOfContents, Lookup',
      'ALWAYS use form extensions — never modify standard forms (overlayering is blocked)',
      'Form extension file: AxFormExtension XML — holds new controls, data sources, property overrides',
      'Form extension class: [ExtensionOf(formStr(Target))] — holds CoC logic for form methods',
      'Use get_form_info(formName, searchControl="...") to find exact control names before extending',
      'New controls: add via modify_d365fo_file(operation="add-control", parentControl="TabGeneral")',
      'Data sources: add via modify_d365fo_file(operation="add-data-source")',
      'NEVER use PowerShell or read_file to inspect form XML — use get_form_info',
    ],
    related: ['coc', 'event-handlers'],
  },

  // ── Security ────────────────────────────────────────────────────────────
  {
    id: 'security',
    title: 'Security Model (Roles, Duties, Privileges)',
    keywords: ['security', 'role', 'duty', 'privilege', 'entry point', 'permission', 'policy', 'xds', 'extensible data security'],
    summary:
      'D365FO uses Role → Duty → Privilege → Entry Point security model. ' +
      'Privileges grant access to specific menu items (entry points).',
    rules: [
      'Hierarchy: Role contains Duties, Duty contains Privileges, Privilege contains Entry Points',
      'Entry Point = menu item (Display, Output, Action) at a specific access level (Read, Update, Create, Delete)',
      'Create separate privilege for each access level: MyFormView (Read), MyFormMaintain (Update)',
      'Duty = business function: "Maintain customer records" → groups related privileges',
      'Role = job function: "Accounts receivable clerk" → groups duties',
      'Table permissions: set on the privilege entry point, cascading to related tables',
      'XDS (Extensible Data Security): row-level security policies',
      'Use get_security_coverage_for_object() to check what covers a form/table/menu item',
      'Use get_security_artifact_info() to inspect a role/duty/privilege hierarchy',
    ],
    related: ['form-patterns'],
  },

  // ── Performance ─────────────────────────────────────────────────────────
  {
    id: 'performance',
    title: 'Performance Best Practices',
    keywords: ['performance', 'cache', 'index', 'trace', 'sql trace', 'batch', 'async', 'recordinsertlist'],
    summary:
      'D365FO performance: use set-based operations, proper indexes, caching, and batch processing.',
    rules: [
      'Set-based > row-by-row: ALWAYS use insert_recordset/update_recordset/delete_from when possible',
      'RecordInsertList: for batch insert of constructed records',
      'CacheLookup: Found (most common), FoundAndEmpty, EntireTable (small reference tables only)',
      'Index: every WHERE clause field should be covered by an index; check with SQL trace',
      'firstonly/firstfast: use on single-record lookups — avoid scanning entire table',
      'exists join over inner join: when you don\'t need columns from the joined table',
      'Avoid nested while-select loops — flatten to a single select with joins',
      'Batch parallelism: use SysOperationServiceController.parmExecutionMode(SysOperationExecutionMode::ScheduledBatch)',
      'Use container or SysGlobalObjectCache for cross-call caching',
    ],
    related: ['set-based', 'query-patterns'],
  },

  // ── Testing ─────────────────────────────────────────────────────────────
  {
    id: 'testing',
    title: 'Unit Testing (SysTest Framework)',
    keywords: ['test', 'unit test', 'systest', 'systestcase', 'assert', 'atl', 'acceptance test library', 'mock'],
    summary:
      'D365FO uses SysTestCase for unit tests and ATL (Acceptance Test Library) for integration tests.',
    rules: [
      'Test class: extends SysTestCase — must have methods starting with "test"',
      'SysTestMethodAttribute: [SysTestMethod] on each test method',
      'Assert methods: this.assertEquals(), this.assertTrue(), this.assertFalse(), this.assertNotNull()',
      'setUp() / tearDown(): run before/after each test method',
      'ATL classes: AtlScenario, AtlCommand — for high-level business process tests',
      'Test data: use AtlDataHelper or setUp() to create transient test records',
      'Run with: run_systest_class MCP tool or Visual Studio Test Explorer',
      'Naming: <TestedClass>Test (e.g. CustTableTest)',
    ],
    examples: [
      {
        label: 'Basic unit test',
        code: `[SysTestTarget(classStr(MyHelper), MethodStr(MyHelper, calculateDiscount))]
class MyHelperTest extends SysTestCase
{
    [SysTestMethod]
    public void testCalculateDiscount_ZeroQty()
    {
        MyHelper helper = new MyHelper();
        Amount result = helper.calculateDiscount(0, 100);
        this.assertEquals(0, result, 'Discount should be 0 for zero quantity');
    }

    [SysTestMethod]
    public void testCalculateDiscount_LargeQty()
    {
        MyHelper helper = new MyHelper();
        Amount result = helper.calculateDiscount(100, 50);
        this.assertTrue(result > 0, 'Discount should be positive for large qty');
    }
}`,
      },
    ],
    related: ['sysoperation'],
  },

  // ── Financial Dimensions ────────────────────────────────────────────────
  {
    id: 'financial-dimensions',
    title: 'Financial Dimensions (DimensionAttributeValueSet)',
    keywords: ['dimension', 'financial dimension', 'ledgerdimension', 'dimensionattributevalueset', 'dimensionattribute', 'defaultdimension', 'ledgerdimensionfacade', 'displayvalue', 'dimensiondefaultingcontroller'],
    summary:
      'Financial dimensions in D365FO are multi-part keys stored as RecId references to DimensionAttributeValueSet. ' +
      'Never work with dimension strings directly — always use the LedgerDimensionFacade or DimensionAttributeValueSetStorage APIs.',
    rules: [
      'DefaultDimension field (Int64): RecId pointing to DimensionAttributeValueSet — stores the account structure combination',
      'LedgerDimension field (Int64): RecId pointing to DimensionAttributeValue — full main account + dimensions combined',
      'To read dimension values: use DimensionAttributeValue::find() and DimensionAttributeValueSetStorage',
      'To create/update default dimensions: use DimensionDefaultingService or DimensionAttributeValueSetStorage',
      'To merge two dimension sets: DimensionAttributeValueSetStorage.mergeValues()',
      'To get the display string of a DefaultDimension: use DimensionAttributeValueSetStorage.toString()',
      'To get the display string of a LedgerDimension: use DimensionAttributeValue::find(recId).getValue()',
      'NEVER store dimension strings in custom fields — always use DefaultDimension (Int64 EDT) referencing DimensionAttributeValueSet',
      'DimensionDefaultingController: use on forms to render the Financial Dimensions FastTab automatically',
      'LedgerDimensionFacade: helper class for building/parsing ledger dimension combinations',
      'For CoC on dimension defaulting: override dimensionDefaultingController() or ledgerDimensionDefaultingController()',
      'Dimension attribute names are configurable per company — never hardcode names like "CostCenter", use DimensionAttribute::findByName()',
    ],
    examples: [
      {
        label: 'Read dimension value from DefaultDimension',
        code: `// Get all dimension values from a DefaultDimension RecId
DimensionAttributeValueSetStorage dimStorage =
    DimensionAttributeValueSetStorage::find(myTable.DefaultDimension);

int dimCount = dimStorage.elements();
for (int i = 1; i <= dimCount; i++)
{
    DimensionAttribute    dimAttr  = DimensionAttribute::find(dimStorage.getAttributeRecId(i));
    DimensionAttributeValue dimVal = DimensionAttributeValue::find(dimStorage.getValueRecId(i));

    info(strFmt('%1 = %2', dimAttr.Name, dimVal.getValue()));
}`,
      },
      {
        label: 'Set a DefaultDimension value (merge pattern)',
        code: `// Build a new dimension set with CostCenter = "100"
DimensionAttribute dimAttr = DimensionAttribute::findByName('CostCenter');
if (dimAttr.RecId)
{
    DimensionAttributeValue dimAttrValue =
        DimensionAttributeValue::findByDimensionAttributeAndValue(dimAttr, '100', false, true);

    DimensionAttributeValueSetStorage dimStorage =
        DimensionAttributeValueSetStorage::find(myTable.DefaultDimension);
    dimStorage.addItem(dimAttrValue);

    ttsbegin;
    myTable.DefaultDimension = dimStorage.save();
    myTable.update();
    ttscommit;
}`,
      },
      {
        label: 'DimensionDefaultingController on a form (CoC)',
        code: `[ExtensionOf(formStr(MyForm))]
final class MyForm_MyModel_Extension
{
    DimensionDefaultingController dimensionDefaultingController;

    public void init()
    {
        next init();
        // Initialise the Financial Dimensions FastTab
        dimensionDefaultingController =
            DimensionDefaultingController::constructInTabWithValues(
                true,                         // allow editing
                true,                         // show mandatory asterisk
                true,                         // validate on save
                0,                            // host field group (0 = default)
                this,                         // form run
                MyTable::defaultDimensionField());
    }

    public void close()
    {
        if (dimensionDefaultingController)
        {
            dimensionDefaultingController.pageClose();
        }
        next close();
    }
}`,
      },
    ],
    related: ['coc', 'event-handlers'],
  },

  // ── Posting Engine ──────────────────────────────────────────────────────
  {
    id: 'posting-engine',
    title: 'Posting Engine (LedgerVoucher / SubledgerJournalizer)',
    keywords: ['posting', 'ledger', 'voucher', 'ledgervoucher', 'subledgerjournalizer', 'journalizer', 'accounting', 'ledgerpostingtype', 'axbc', 'subledger'],
    summary:
      'D365FO posting uses SubledgerJournalizer to create subledger entries that are transferred to General Ledger via the Accounting Framework. ' +
      'Never write to LedgerTrans directly — always use the posting framework.',
    rules: [
      'NEVER write to LedgerTrans directly — use SubledgerJournalizer or LedgerVoucher API',
      'SubledgerJournalizer: modern API for creating accounting entries (replaces LedgerVoucher in new modules)',
      'LedgerVoucher: legacy but still valid for most standard modules (SalesOrder, PurchOrder posting)',
      'AccountingEvent: groups voucher lines by posting type for a single business event',
      'AxBC classes (AxSalesLine, AxPurchLine, etc.): business component wrappers for posting — extend via CoC, not direct modification',
      'LedgerPostingType: must be registered in your module\'s LedgerPostingTypeHelper extension',
      'For custom vouchers: extend LedgerVoucher_Extension and override getVoucherType()',
      'Subledger journal: created by SubledgerJournalizerProjectEntry (or similar), transferred async to GL',
      'Always use ledgerDimension (not defaultDimension) for posting — combines main account + dimensions',
      'Posting validation: override validate() in AxBC class via CoC — return error() to stop posting',
    ],
    examples: [
      {
        label: 'Create custom voucher with LedgerVoucher',
        code: `LedgerVoucher ledgerVoucher = LedgerVoucher::newLedgerVoucher(LedgerTransType::None);
LedgerVoucherObject voucherObj = LedgerVoucherObject::newLedgerVoucherObject(
    LedgerTransType::None,
    CompanyInfo::findDataArea(curExt()));

// Debit line
LedgerVoucherTransObject debit = LedgerVoucherTransObject::newTransObject(
    voucherObj,
    LedgerVoucherType::Normal);
debit.parmAccount(myLedgerDimension);
debit.parmAmountCur(amount);
debit.parmTransDate(transDate);
debit.parmTransTxt('My posting');

// Credit line
LedgerVoucherTransObject credit = LedgerVoucherTransObject::newTransObject(
    voucherObj,
    LedgerVoucherType::Normal);
credit.parmAccount(offsetLedgerDimension);
credit.parmAmountCur(-amount);
credit.parmTransDate(transDate);
credit.parmTransTxt('My posting offset');

voucherObj.add(debit);
voucherObj.add(credit);
ledgerVoucher.add(voucherObj);

ttsbegin;
ledgerVoucher.post();
ttscommit;`,
      },
    ],
    related: ['transactions', 'financial-dimensions'],
  },

  // ── Multi-company ───────────────────────────────────────────────────────
  {
    id: 'multi-company',
    title: 'Multi-company Queries & changeCompany()',
    keywords: ['multi-company', 'crosscompany', 'changecompany', 'dataareaid', 'legalentity', 'virtualcompany', 'companyinfo', 'systemsequences'],
    summary:
      'D365FO supports cross-company data access via changeCompany() and crosscompany select. ' +
      'Every table has DataAreaId — always consider company isolation in queries.',
    rules: [
      'Tables with SaveDataPerCompany=Yes: have DataAreaId field, data is company-specific (default)',
      'Tables with SaveDataPerCompany=No: shared across all companies (e.g. DirPartyTable, RefRecId tables)',
      'changeCompany("DAT") { ... }: switch company context for a code block — closes and re-opens connection',
      'crosscompany select: use when querying data across multiple companies in one query',
      'crosscompany containers: pass specific companies, e.g. while select crosscompany [co1, co2] from myTable',
      'NEVER hardcode DataAreaId — always use curExt() or CompanyInfo::current().DataArea',
      'changeCompany is expensive — avoid inside loops; batch operations cross-company instead',
      'For reporting: use crosscompany select with a list of company IDs from a parameter',
      'Inter-company transactions: use InterCompanyTradingRelationship — do not write cross-company manually',
    ],
    examples: [
      {
        label: 'changeCompany block',
        code: `// ✅ Change company for a code block
CustTable custTable;
changeCompany("DAT")
{
    select firstonly custTable
        where custTable.AccountNum == '1001';
}
info(custTable.Name); // data from DAT company`,
      },
      {
        label: 'crosscompany select',
        code: `CustTable custTable;
container companies = ["DAT", "USMF", "DEMF"];

// ✅ Query across multiple companies
while select crosscompany : companies
    AccountNum, Name, DataAreaId from custTable
    where custTable.CustGroup == 'DOM'
{
    info(strFmt('%1 | %2 | %3',
        custTable.DataAreaId,
        custTable.AccountNum,
        custTable.Name));
}`,
      },
    ],
    related: ['query-patterns', 'transactions'],
  },

  // ── Print Management ───────────────────────────────────────────────────
  {
    id: 'print-management',
    title: 'Print Management (SrsPrintMgmtController)',
    keywords: ['print management', 'printmgmt', 'srsprintmgmt', 'srsprintmgmtcontroller', 'printmgmtdoctype', 'printmgmtdocumenttype', 'printmgmtsettings', 'original copy'],
    summary:
      'Print management in D365FO controls report destinations (screen, printer, email, archive) per document type. ' +
      'Use SrsPrintMgmtController for reports that integrate with the Print management setup form.',
    rules: [
      'Extend SrsPrintMgmtController (not SrsReportRunController) when the report supports Print management',
      'Register the document type in PrintMgmtDocType enum extension',
      'Override getDocumentName() and getDocumentTitle() in the controller class',
      'Override getOriginalPrintMgmtPrintSettingDetail() for the default print settings',
      'PrintMgmtDocumentType class: register your document type (link to module, table, report)',
      'To open the Print management setup: go to Accounts receivable → Setup → Print management',
      'For new document types: also add an entry in PrintMgmtReportFormat (links document type to report design)',
      'Reprint: same controller, pass PrintCopyType::Reprint via parmPrintCopyType()',
    ],
    related: ['ssrs-reports'],
  },

  // ── Unit Testing ─────────────────────────────────────────────────────────
  {
    id: 'unit-testing',
    title: 'X++ Unit Testing (SysTestCase / SysTestSuite)',
    keywords: ['unit test', 'systestcase', 'systestsuite', 'test', 'assert', 'testmethod', 'mock', 'stub', 'systestcasestub', 'testautomation'],
    summary:
      'X++ unit tests extend SysTestCase. They run in a fresh database transaction that is always rolled back, ' +
      'ensuring tests are isolated. Run in Visual Studio → Test Explorer or via SysTestSuite.',
    rules: [
      'Test class: extends SysTestCase, must be in the same model as the code under test (or a test model)',
      'Test methods: public void testXxx() — method name MUST start with "test" (case-insensitive)',
      'Setup/teardown: override setUp() and tearDown() — called before/after EACH test method',
      'Assertions: assertEquals, assertNotNull, assertNull, assertTrue, assertFalse, fail()',
      'SysTestSuite: groups multiple SysTestCase classes for batch execution',
      'Transaction rollback: all DML in a test is rolled back after each test — no cleanup needed for DB state',
      'For methods that call ttsbegin internally: wrap test in try/catch and expect a clean state',
      'Mock dependencies: use delegation pattern or extract interfaces — X++ has no built-in mocking framework',
      'Naming convention: <ClassName>_Test (e.g. MyServiceClass_Test)',
      'Attributes: [SysTestMethodAttribute] optional — but helps categorize tests',
      'Run tests: Visual Studio → Test → Run All Tests, or SysTestSuite.run() in a batch job',
    ],
    examples: [
      {
        label: 'Basic SysTestCase',
        code: `/// <summary>
/// Unit tests for MyService.
/// </summary>
class MyService_Test extends SysTestCase
{
    MyService service;

    public void setUp()
    {
        super();
        service = new MyService();
    }

    public void testCalculateDiscount_Zero()
    {
        // Arrange
        AmountMST amount = 1000;

        // Act
        AmountMST discount = service.calculateDiscount(amount, 0);

        // Assert
        this.assertEquals(0, discount,
            'Discount should be 0 when rate is 0');
    }

    public void testCalculateDiscount_TenPercent()
    {
        AmountMST discount = service.calculateDiscount(1000, 10);
        this.assertEquals(100, discount, '10% of 1000 = 100');
    }

    public void testCalculateDiscount_NegativeAmount()
    {
        // Negative amount should throw an exception
        try
        {
            service.calculateDiscount(-100, 10);
            this.fail('Expected an exception for negative amount');
        }
        catch (Exception::Error)
        {
            // Expected — test passes
        }
    }
}`,
      },
    ],
    related: ['transactions', 'error-handling'],
  },

  // ── Telemetry & Logging ─────────────────────────────────────────────────
  {
    id: 'telemetry',
    title: 'Telemetry, Logging & SysInfoLog',
    keywords: ['telemetry', 'logging', 'sysinfolog', 'infolog', 'info', 'warning', 'error', 'checkfailed', 'eventlog', 'application insights', 'syscustomattribute'],
    summary:
      'D365FO uses SysInfoLog for user-visible messages and Application Insights telemetry for monitoring. ' +
      'Structure log output carefully — Copilot and users read infolog messages to diagnose issues.',
    rules: [
      'info("message"): informational message shown to user in infolog',
      'warning("message"): amber warning — operation completed but user should be aware',
      'error("message"): red error — operation failed, return false from validate methods',
      'checkFailed("message"): same as error() but returns false — use in validateWrite()',
      'Global::error/warning/info: same as bare functions (Global:: prefix is valid but redundant)',
      'SysInfoLogScope: use to capture infolog output programmatically (for testing or logging)',
      'NEVER use print statement — it only shows in job output, not infolog',
      'For Azure Application Insights telemetry: use Microsoft.ApplicationInsights NuGet — not available in standard X++ without NuGet reference',
      'Structured telemetry: use SysTelemetry class (available in platform update 20+)',
      'Batch job logging: use this.BatchHeader.addRuntimeTask() for progress feedback',
      'Infolog messages in batch: saved to BatchHistory — accessible via Batch jobs > History',
      'NEVER log sensitive data (passwords, connection strings, PII) — use masked/hashed values',
    ],
    examples: [
      {
        label: 'SysInfoLogScope — capture infolog to string',
        code: `SysInfoLogScope infoLogScope = SysInfoLogScope::startScope();
try
{
    myService.doSomething();
}
finally
{
    SysInfoLogEnumerator enumerator = SysInfoLogEnumerator::newData(infoLogScope.infoLogData());
    while (enumerator.moveNext())
    {
        SysInfologMessageStruct msgStruct =
            SysInfologMessageStruct::construct(enumerator.current());
        str message = msgStruct.message();
        SysInfologLevel level = enumerator.currentException();
        // level: SysInfologLevel::Info, Warning, Error
        info(strFmt('[%1] %2', enum2Str(level), message));
    }
}`,
      },
    ],
    related: ['error-handling', 'sysoperation'],
  },

  // ── Global Address Book (GAB) ───────────────────────────────────────────
  {
    id: 'global-address-book',
    title: 'Global Address Book (GAB) — DirPartyTable, DirPartyPostalAddress',
    keywords: ['gab', 'global address book', 'dirpartytable', 'dirperson', 'dirorganization', 'dirpartypostaladdress', 'logisticspostaladdress', 'dirpartylocation', 'address', 'party', 'contact'],
    summary:
      'D365FO manages all parties (persons, organizations) through DirPartyTable. Every customer, vendor, worker etc. ' +
      'links to a DirPartyTable record via a Party field (RecId). Do NOT store addresses directly on your custom table — ' +
      'always use GAB APIs.',
    rules: [
      'Every entity with a real-world address (customer, vendor, worker) has a DirPartyTable record via a Party field',
      'To read postal address: use LogisticsPostalAddress joined through DirPartyLocation',
      'To read contact info (email, phone): use LogisticsElectronicAddress joined through DirPartyLocation',
      'DirPartyType enum: Person | Organization | Team — use dirPartyType() method to check',
      'To create a Party: use DirPartyTable::createNew(DirPartyType::Organization) or DirPersonName for persons',
      'NEVER insert into DirPartyTable directly — always use the DirPartyTable static helper methods',
      'To link your custom table to GAB: add a Party field (EDT: DirPartyRecId), set RefTableId, RefRecId',
      'DirPartyPostalAddressView is a convenient view for reading the primary address',
      'GlobalAddressBookHelper and DirPartyService provide high-level create/update APIs',
    ],
    examples: [
      {
        label: 'Read primary postal address for a party',
        code: `// Read primary postal address via DirPartyPostalAddressView
DirPartyRecId       partyRecId = custTable.Party;
DirPartyPostalAddressView addrView;

select firstonly addrView
    where addrView.Party    == partyRecId
       && addrView.IsPrimary == NoYes::Yes;

str street  = addrView.Street;
str city    = addrView.City;
str country = addrView.CountryRegionId;`,
      },
      {
        label: 'Read primary email address',
        code: `// Read primary email using LogisticsElectronicAddress
DirPartyRecId               partyRecId = vendTable.Party;
LogisticsElectronicAddress  email;

select firstonly email
    join DirPartyLocation
    where DirPartyLocation.Party       == partyRecId
       && DirPartyLocation.IsPrimary   == NoYes::Yes
    && email.Location == DirPartyLocation.Location
       && email.Type    == LogisticsElectronicAddressMethodType::Email;

str emailAddr = email.Locator;`,
      },
    ],
    related: ['data-entities', 'number-sequences'],
  },

  // ── SysExtension Framework ──────────────────────────────────────────────
  {
    id: 'sysextension',
    title: 'SysExtension Framework — plug-in pattern without if/else chains',
    keywords: ['sysextension', 'sysextensionappsuite', 'exportmetadata', 'iclassextension', 'plugin', 'plug-in', 'factory', 'decorator', 'extensible enum', 'sysplugin'],
    summary:
      'SysExtension allows registering and resolving implementations keyed by an extensible enum without modifying ' +
      'the base code. Replaces if/switch chains. Consists of: interface, enum, concrete classes decorated with ' +
      '[ExportMetadataAttribute], and a factory call via SysExtensionAppSuiteDecoratorForward or SysPluginFactory.',
    rules: [
      'Define an interface (or abstract class) for the strategy: interface IMyStrategy { void execute(); }',
      'Create an extensible enum (IsExtensible=Yes) with one value per strategy',
      'Decorate each concrete class: [ExportMetadataAttribute(enumStr(MyEnum), MyEnum::Value)]',
      'Resolve at runtime: SysExtensionAppSuiteDecoratorForward::construct(classStr(IMyStrategy), myEnumValue)',
      'Alternatively use SysPluginFactory::Instance(enumStr(MyEnum), myEnumValue)',
      'Adding a new strategy = new class + new enum value, ZERO changes to base code',
      'Use classStr() / enumStr() — never string literals — for refactor-safety',
      'Works for both class and table contexts; interface must be implemented on the class',
      'NEVER use this pattern for a single implementation — only when multiple strategies needed',
    ],
    examples: [
      {
        label: 'SysExtension plug-in pattern',
        code: `// 1. Extensible enum (IsExtensible = Yes in XML)
// enum MyProcessorType { Standard, Express, Overnight }

// 2. Interface
interface IMyProcessor
{
    void process(MyTable _record);
}

// 3. Concrete implementation decorated with enum value
[ExportMetadataAttribute(enumStr(MyProcessorType), MyProcessorType::Express)]
public class MyExpressProcessor implements IMyProcessor
{
    public void process(MyTable _record)
    {
        // Express processing logic
    }
}

// 4. Factory resolution — no if/switch needed
public static void runProcessor(MyTable _record, MyProcessorType _type)
{
    IMyProcessor processor = SysExtensionAppSuiteDecoratorForward::construct(
        classStr(IMyProcessor), _type) as IMyProcessor;

    if (processor)
    {
        processor.process(_record);
    }
}`,
      },
    ],
    related: ['coc-extensions', 'batch-jobs'],
  },

  // ── Currency / Exchange Rates ───────────────────────────────────────────
  {
    id: 'currency-exchange-rates',
    title: 'Currency & Exchange Rates — ExchangeRateHelper, CurrencyExchangeHelper',
    keywords: ['currency', 'exchange rate', 'exchangeratehelper', 'currencyexchangehelper', 'amount', 'convert', 'amountcur', 'amountmst', 'ledgercurrency', 'transactioncurrency', 'accountingcurrency'],
    summary:
      'D365FO manages currency conversion through ExchangeRateHelper and CurrencyExchangeHelper. ' +
      'Never calculate exchange rates manually — always use the framework APIs to respect ' +
      'company exchange rate configuration.',
    rules: [
      'Use ExchangeRateHelper::getExchangeRate() to get the rate between two currencies on a date',
      'Use CurrencyExchangeHelper::newExchangeDate() factory for converting amounts',
      'Transaction currency (AmountCur) → Accounting currency (AmountMST): use CurrencyExchangeHelper',
      'Accounting currency is defined per legal entity: CompanyInfo::find().CurrencyCode',
      'Exchange rate types: Default, Budget, Cost accounting — always use the type from Ledger setup',
      'NEVER hard-code exchange rates or calculate manually',
      'For subledger transactions: use LedgerCurrencyConverter, not manual arithmetic',
      'ExchangeRateType table holds the types; ExchangeRate table holds the actual rates',
      'When inserting subledger lines, let SubledgerJournalizer handle the currency conversion',
    ],
    examples: [
      {
        label: 'Convert transaction currency amount to accounting currency',
        code: `// Convert an amount from transaction currency to accounting currency
CurrencyCode        fromCurrency = salesLine.CurrencyCode;
CurrencyCode        toCurrency   = Ledger::accountingCurrency(CompanyInfo::current());
TransDate           rateDate     = systemDateGet();
ExchangeRateValue   rate;

// Get exchange rate
rate = ExchangeRateHelper::getExchangeRate(
    ExchangeRateType::find(Ledger::exchangeRateType(CompanyInfo::current())).RecId,
    fromCurrency,
    toCurrency,
    rateDate);

// Convert amount
AmountMST amountMST = CurrencyExchangeHelper::newExchangeDate(
    fromCurrency,
    rateDate,
    Ledger::current())
    .calculateAmount(salesLine.LineAmount);`,
      },
    ],
    related: ['posting-engine', 'financial-dimensions'],
  },

  // ── Alerts / Business Events ────────────────────────────────────────────
  {
    id: 'alerts-business-events',
    title: 'Alerts & Business Events — BusinessEventsContract, AlertRuleTable',
    keywords: ['alert', 'business event', 'businesseventscontract', 'businesseventscatalog', 'alertrule', 'eventbuscontract', 'notification', 'businessevent', 'businesseventsbase'],
    summary:
      'D365FO supports two notification mechanisms: (1) Classic Alerts (user-defined rules on table changes) ' +
      'and (2) Business Events (developer-defined, publishable to Azure Service Bus / Logic Apps / Power Automate). ' +
      'Use Business Events for integration scenarios, Alerts for user-defined notifications.',
    rules: [
      'Business Events: create a class extending BusinessEventsBase with [BusinessEvents] attribute',
      'BusinessEventsContract: data contract class with [DataContract] + parm methods for payload',
      'Register in BusinessEventsCatalog.addBusinessEventsToCatalog() via CoC extension',
      'Trigger the event: new MyBusinessEvent(contract).send()',
      'Classic Alerts: driven by EventRule and EventJobTable — users configure in UI, no code needed',
      'Business Events are visible in System administration > Business events catalog',
      'Enable/disable per legal entity in the catalog; endpoint configured there (Service Bus, etc.)',
      'For unit testing: use BusinessEventsTestHelper to mock the event bus',
      'NEVER use direct REST calls for integration — always prefer Business Events for D365FO outbound',
    ],
    examples: [
      {
        label: 'Define and send a Business Event',
        code: `// 1. Contract class
[DataContractAttribute]
public final class MyBusinessEventContract extends BusinessEventsContract
{
    private SalesId salesId;
    private AmountMST totalAmount;

    public static MyBusinessEventContract newFromSalesTable(SalesTable _salesTable)
    {
        MyBusinessEventContract contract = new MyBusinessEventContract();
        contract.initialize(_salesTable);
        return contract;
    }

    private void initialize(SalesTable _salesTable)
    {
        salesId     = _salesTable.SalesId;
        totalAmount = _salesTable.SalesBalance;
    }

    [DataMemberAttribute('SalesId')]
    public SalesId parmSalesId(SalesId _salesId = salesId)
    {
        salesId = _salesId;
        return salesId;
    }
}

// 2. Business event class
[BusinessEvents(classStr(MyBusinessEventContract),
    'My Sales Confirmed Event',
    'Raised when a sales order is confirmed',
    ModuleAxapta::SalesOrder)]
public final class MySalesConfirmedBusinessEvent extends BusinessEventsBase
{
    private MyBusinessEventContract contract;

    public static MySalesConfirmedBusinessEvent newFromContract(
        MyBusinessEventContract _contract)
    {
        MySalesConfirmedBusinessEvent event = new MySalesConfirmedBusinessEvent();
        event.contract = _contract;
        return event;
    }

    [Hookable(false)]
    public BusinessEventsContract buildContract()
    {
        return contract;
    }
}

// 3. Send the event (e.g. in postConfirm())
MyBusinessEventContract contract = MyBusinessEventContract::newFromSalesTable(salesTable);
MySalesConfirmedBusinessEvent::newFromContract(contract).send();`,
      },
    ],
    related: ['coc-extensions', 'batch-jobs'],
  },

  // ── Electronic Reporting (ER) ───────────────────────────────────────────
  {
    id: 'electronic-reporting',
    title: 'Electronic Reporting (ER) — ERModelMapping, ERFormatMapping, X++ integration',
    keywords: ['er', 'electronic reporting', 'ermodelmapping', 'erformat', 'erformatmapping', 'erformatmappingrun', 'erconfiguration', 'er format', 'er model', 'data model', 'format mapping'],
    summary:
      'Electronic Reporting (ER) is the D365FO framework for configurable business document generation ' +
      '(invoices, SEPA, VAT files). From X++ you can: (1) run an ER format programmatically, ' +
      '(2) extend an ER model mapping via CoC, (3) pass data from X++ to ER via a custom ER data source.',
    rules: [
      'Run ER format from X++: use ERObjectsFactory to get IERFormatMappingRun, call run()',
      'Pass parameters to ER: use ERModelDefinitionParamsAction to set user-input field values',
      'NEVER modify ER configurations in code — use ER designer in D365FO UI or import from LCS',
      'ER configurations are stored in ERSolutionTable / ERVendorTable — do NOT touch DB directly',
      'To extend ER model mapping: implement IERModelMappingExtension on your class (CoC not possible for ER)',
      'For custom data sources: create a class implementing ERIDataSourceProvider and register it',
      'ER format file path: System administration > Electronic reporting > Reporting configurations',
      'For testing: use ERObjectsFactory::createFormatMappingRunByFormatMappingId()',
      'Country-specific ER formats loaded via localization features — check ERSolutionRepositoryTable',
    ],
    examples: [
      {
        label: 'Run an ER format from X++ code',
        code: `// Run an ER format programmatically and return the output as a file
using Microsoft.Dynamics365.LocalizationFramework;

public static void runErFormat(ERFormatMappingId _formatMappingId, FilePath _outputPath)
{
    IERFormatMappingRun formatRun = ERObjectsFactory::createFormatMappingRunByFormatMappingId(
        _formatMappingId);

    if (formatRun.parmShowPromptDialog(false))
    {
        // Optionally pass parameters
        ERModelDefinitionParamsAction paramsAction = new ERModelDefinitionParamsAction();
        formatRun.withParameter(paramsAction);
    }

    // Run and get output
    formatRun.run();
}`,
      },
    ],
    related: ['ssrs-reports', 'print-management'],
  },

  // ── Security: Privileges / Duties granularity ───────────────────────────
  {
    id: 'security-privileges-duties',
    title: 'Security: Privileges, Duties, Roles — granular security chain',
    keywords: ['security', 'privilege', 'duty', 'role', 'securityprivilege', 'securityduty', 'securityrole', 'entrypoint', 'permission', 'access level', 'securyobject', 'hasappliedmenuitem', 'menuitem'],
    summary:
      'D365FO security follows a 3-tier hierarchy: Role → Duty → Privilege → Entry Point (menu item/service/form). ' +
      'Always create BOTH View (read-only) and Maintain (full-access) privilege variants. ' +
      'Duties group related privileges by business function. Roles group duties by job function.',
    rules: [
      'Hierarchy: Role (job function) → Duty (business function) → Privilege (single operation) → Entry Point',
      'Always create two privilege variants: ViewMyObject (Read) and MaintainMyObject (Update+Create+Delete)',
      'Entry point on privilege = menu item name; access level: Read | Create | Update | Delete | Correct | View | NoAccess',
      'Duty: groups related privileges for a business task (e.g. "Maintain customer invoices")',
      'Role: assigned to user; groups duties for a complete job function (e.g. "Accounts receivable clerk")',
      'Use generate_code(pattern="security-privilege") to generate both View and Maintain XML pairs',
      'Privilege XML: AxSecurityPrivilege folder; Duty XML: AxSecurityDuty; Role XML: AxSecurityRole',
      'NEVER use objectType="security-privilege" for duties — each maps to a different AOT folder',
      'To check user access in code: SecurityRights::hasMenuItemAccess(menuItemStr(X), MenuItemType::Display)',
      'For table-level security: use XDS (Extensible Data Security) policies — AxSecurityPolicy XML',
      'Table permissions on privilege define column-level access; use Field Permissions for column masking',
    ],
    examples: [
      {
        label: 'Check security access in X++',
        code: `// Check if current user has access to a menu item
if (SecurityRights::hasMenuItemAccess(
        menuItemStr(MyCustomForm),
        MenuItemType::Display))
{
    // User has access
    element.design().visible(true);
}
else
{
    element.design().visible(false);
}

// Check table-level access (read permission)
if (SecurityRights::hasTableAccess(tableNum(MyCustomTable), AccessType::Read))
{
    // Has at least read access to MyCustomTable
}`,
      },
      {
        label: 'Privilege XML structure (View variant)',
        code: `<?xml version="1.0" encoding="utf-8"?>
<AxSecurityPrivilege xmlns:i="...">
  <Name>ViewMyCustomTable</Name>
  <Label>@MyModel:ViewMyCustomTable</Label>
  <EntryPoints>
    <AxSecurityEntryPointReference>
      <EntryPointName>MyCustomFormMenuItem</EntryPointName>
      <EntryPointType>MenuItemDisplay</EntryPointType>
      <PermissionGroup>Read</PermissionGroup>
    </AxSecurityEntryPointReference>
  </EntryPoints>
</AxSecurityPrivilege>`,
      },
    ],
    related: ['coc-extensions', 'data-entities'],
  },

  // ── SSRS Reports ────────────────────────────────────────────────────────
  {
    id: 'ssrs-reports',
    title: 'SSRS Reports (DP → TmpTable → RDL)',
    keywords: ['ssrs', 'report', 'rdl', 'dp class', 'data provider', 'srsreportdataproviderbase', 'contract', 'controller', 'design'],
    summary:
      'D365FO SSRS reports use: TmpTable (TempDB) → DataContract → DP class → Controller → AxReport with RDL design.',
    rules: [
      '5 objects: TmpTable (TempDB), Contract (DataContractAttribute), DP (extends SRSReportDataProviderBase), Controller (extends SrsReportRunController), AxReport XML',
      'TmpTable: MUST be TableType=TempDB (NOT InMemory) — required for SSRS data connection',
      'DP class: [SRSReportParameterAttribute(classStr(MyContract))], processReport() fills TmpTable',
      'DP getter: [SRSReportDataSetAttribute(tableStr(MyTmp))] public MyTmp getMyTmp()',
      'Controller: sets report name via ssrsReportStr(), opens dialog, runs report',
      'AxReport XML: DataSet with DataSourceType=ReportDataProvider, Query=SELECT * FROM DPClass.TmpTable',
      'Use generate_smart_report MCP tool to generate all 5 objects at once',
      'For existing reports, use get_report_info() — NEVER read report XML with PowerShell',
    ],
    related: ['temp-tables', 'sysoperation'],
  },
];

// ─── Search Logic ───────────────────────────────────────────────────────────

function scoreEntry(entry: KnowledgeEntry, queryTokens: string[]): number {
  let score = 0;
  const titleLower = entry.title.toLowerCase();
  const summaryLower = entry.summary.toLowerCase();

  for (const token of queryTokens) {
    // Exact keyword match (highest weight)
    if (entry.keywords.some(k => k === token)) score += 10;
    // Partial keyword match
    else if (entry.keywords.some(k => k.includes(token) || token.includes(k))) score += 5;
    // Title match
    if (titleLower.includes(token)) score += 3;
    // Summary match
    if (summaryLower.includes(token)) score += 1;
    // ID match
    if (entry.id === token) score += 15;
  }

  return score;
}

function searchKnowledge(topic: string): KnowledgeEntry[] {
  const tokens = topic
    .toLowerCase()
    .replace(/[^a-z0-9áčďéěíňóřšťúůýž_\-/\s]/g, '')
    .split(/[\s,;/]+/)
    .filter(t => t.length > 1);

  if (tokens.length === 0) {
    // Return all entries sorted alphabetically
    return [...KNOWLEDGE_BASE].sort((a, b) => a.title.localeCompare(b.title));
  }

  const scored = KNOWLEDGE_BASE
    .map(entry => ({ entry, score: scoreEntry(entry, tokens) }))
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score);

  return scored.map(s => s.entry);
}

// ─── Formatters ─────────────────────────────────────────────────────────────

function formatConcise(entries: KnowledgeEntry[]): string {
  if (entries.length === 0) {
    return '❌ No matching knowledge entries found.\n\nAvailable topics:\n' +
      KNOWLEDGE_BASE.map(e => `- \`${e.id}\`: ${e.title}`).join('\n');
  }

  const parts: string[] = [];

  for (const entry of entries.slice(0, 5)) {
    parts.push(`## ${entry.title}\n`);
    parts.push(`${entry.summary}\n`);

    if (entry.migration) {
      parts.push(`**AX2012:** ${entry.migration.ax2012}`);
      parts.push(`**D365FO:** ${entry.migration.d365fo}\n`);
    }

    parts.push('**Rules:**');
    for (const rule of entry.rules) {
      parts.push(`- ${rule}`);
    }

    if (entry.related && entry.related.length > 0) {
      parts.push(`\n_Related: ${entry.related.join(', ')}_`);
    }

    parts.push('');
  }

  if (entries.length > 5) {
    parts.push(`_...and ${entries.length - 5} more entries. Use a more specific query to narrow results._`);
  }

  return parts.join('\n');
}

function formatDetailed(entries: KnowledgeEntry[]): string {
  if (entries.length === 0) {
    return '❌ No matching knowledge entries found.\n\nAvailable topics:\n' +
      KNOWLEDGE_BASE.map(e => `- \`${e.id}\`: ${e.title}`).join('\n');
  }

  const parts: string[] = [];

  for (const entry of entries.slice(0, 3)) {
    parts.push(`# ${entry.title}\n`);
    parts.push(`${entry.summary}\n`);

    if (entry.migration) {
      parts.push('## AX2012 → D365FO Migration\n');
      parts.push(`| AX2012 (legacy) | D365FO (correct) |`);
      parts.push(`|---|---|`);
      parts.push(`| ${entry.migration.ax2012} | ${entry.migration.d365fo} |\n`);
    }

    parts.push('## Rules\n');
    for (const rule of entry.rules) {
      parts.push(`- ${rule}`);
    }
    parts.push('');

    if (entry.examples && entry.examples.length > 0) {
      parts.push('## Code Examples\n');
      for (const ex of entry.examples) {
        parts.push(`### ${ex.label}\n`);
        parts.push('```xpp');
        parts.push(ex.code);
        parts.push('```\n');
      }
    }

    if (entry.related && entry.related.length > 0) {
      const relatedTitles = entry.related
        .map(id => KNOWLEDGE_BASE.find(e => e.id === id))
        .filter(Boolean)
        .map(e => `\`${e!.id}\` (${e!.title})`);
      parts.push(`**Related topics:** ${relatedTitles.join(', ')}\n`);
    }

    parts.push('---\n');
  }

  if (entries.length > 3) {
    parts.push(`_${entries.length - 3} more entries matched. Use a more specific query._`);
  }

  return parts.join('\n');
}

// ─── Tool Handler ───────────────────────────────────────────────────────────

export async function xppKnowledgeTool(request: CallToolRequest) {
  try {
    const args = XppKnowledgeArgsSchema.parse(request.params.arguments);
    const entries = searchKnowledge(args.topic);
    const formatted = args.format === 'detailed'
      ? formatDetailed(entries)
      : formatConcise(entries);

    return {
      content: [{ type: 'text', text: formatted }],
    };
  } catch (error) {
    return {
      content: [{
        type: 'text',
        text: `Error in get_xpp_knowledge: ${error instanceof Error ? error.message : 'Unknown error'}`,
      }],
      isError: true,
    };
  }
}
