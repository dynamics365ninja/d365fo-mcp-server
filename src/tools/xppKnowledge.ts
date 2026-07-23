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
    '"temp tables", "today() deprecated", "query patterns", "form patterns", ' +
    '"inventory", "feature management", "dual-write", "DMF", "warehouse", ' +
    '"trade agreements", "configuration keys", "Power Platform", ' +
    '"read Excel/CSV", "parallel batch", "direct SQL"'
  ),
  format: z.enum(['concise', 'detailed']).optional().default('concise').describe(
    'concise = quick reference (default), detailed = full explanation with code examples'
  ),
});

// Tool registration (name, description, inputSchema) lives inline in
// src/server/mcpServer.ts - the single source of truth for tool instructions.

// ─── Knowledge Entry Type ───────────────────────────────────────────────────

export interface KnowledgeEntry {
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

export const KNOWLEDGE_BASE: KnowledgeEntry[] = [
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
      'Method signature MUST match the original exactly (use get_method(include="signature") tool)',
      'ALWAYS call next <methodName>() — skipping it breaks the chain for other extensions',
      'Cannot access private members of the original class',
      'Can wrap public and protected methods — instance AND static (a static wrapper must repeat the "static" modifier); cannot wrap private methods or constructors. Forms cannot have static-method CoC',
      'For form static methods or fire-and-forget scenarios where CoC is not possible, use [PostHandlerFor] / [PreHandlerFor] event handlers instead',
      'For the strict wrapper non-negotiables (default parameters, next placement, [Wrappable]/[Hookable]) see the coc-authoring topic',
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
    related: ['event-handlers', 'form-patterns', 'coc-authoring'],
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
      'REUSE BEFORE CREATING: call extension_info(mode="events") first — if a handler class for the target already exists in the custom model, add the new handler method there instead of creating a parallel class',
      'Both _EH and _EventHandler handler-class naming styles exist — follow the style already used in the model; never introduce a feature-named handler class (<Form>_<Feature>_EH) unless the user explicitly asks for a separate class',
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
      'Composite entity: wraps multiple entities for header+lines import (e.g. SalesOrderHeaderV2Entity + SalesOrderLineV2Entity)',
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
[SrsReportParameterAttribute(classStr(MyReportContract))]
class MyReportDP extends SrsReportDataProviderBase
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
      'labels(action="search") before labels(action="create") — avoid duplicates',
      'Provide translations for all required languages in labels(action="create")',
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
      'today() → DateTimeUtil::getToday(DateTimeUtil::getUserPreferredTimeZone()) — BPUpgradeCodeToday; NEVER use today() in new code (same replacement the bp-rules topic mandates)',
      'NEVER call today() or any function directly in a WHERE condition — assign to a variable first',
      'curext() → use Ledger::primaryForLegalEntity(CompanyInfo::findDataArea(curext()).RecId)',
      'AIF services → Data entities + OData',
      'RunBase → SysOperation framework',
      'display/edit methods on forms → computed columns or data entity virtual fields',
      'infolog.add() → info()/warning()/error() global functions',
      'fieldnum(tableName, fieldName) → still valid but use fieldNum() macro for compile-time safety',
      '[SysObsolete] attribute: ALWAYS read the message — it names the replacement',
      'When get_method(include="source") returns a method with [SysObsolete], do NOT call it — use the stated replacement',
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
      'Module class EXTENDS NumberSeqApplicationModule — exact name. ❌ NOT "NumberSequenceApplicationModule" (that class does not exist).',
      'It is a subclass (extends), so override loadModule() and call super() at the top. ❌ NOT next() — next() is ONLY for [ExtensionOf] CoC classes, never for an extends subclass.',
      'loadModule() registers each reference with NumberSeqDatatype::construct(), then parmDatatypeId(extendedTypeNum(MyEdt)) + parmWizardIsContinuous/parmWizardIsManual/parmWizardIsChangeDownAllowed/… , then this.create(datatype). ❌ Do NOT assign fields on a NumberSeqReference/NumberSequenceReference buffer (DataTypeId, WizardContinuous, AllowManual… are parm*() methods on NumberSeqDatatype, NOT table fields) and there is NO this.addModuleEntry().',
      'Override numberSeqModule() to return your NumberSeqModule enum value.',
      'A new module class is NOT auto-loaded: extend the NumberSeqModule enum and register the module via an event handler on NumberSeqGlobal (or CoC) so loadModule() runs.',
      'Form auto-numbering: NumberSeqFormHandler::newForm(<ParametersTable>::numRef<Id>().NumberSequenceId, element, <datasource>, fieldNum(<Table>, <Id>)). First arg is a RefRecId via the .NumberSequenceId field. ❌ NOT .NumberSequence and ❌ NOT a string code.',
      'Runtime fetch: NumberSeqReference::findReference(extendedTypeNum(MyId)) → NumberSeq::newGetNum(ref) → .num(); call .abort() to release on rollback.',
      'Continuous (no gaps): perf cost — only when legally required. Non-continuous (default) allows gaps, faster for internal IDs.',
      'Scope: DataArea (per-company), Global (cross-company), OperatingUnit.',
      'Verify exact parm*() names against the SDK with get_object_info(objectType="class", name="NumberSeqDatatype") before relying on them.',
    ],
    examples: [
      {
        label: 'Module class — register the reference in loadModule() (correct API)',
        code: `public class NumberSeqModuleMyRent extends NumberSeqApplicationModule
{
    protected void loadModule()
    {
        NumberSeqDatatype datatype = NumberSeqDatatype::construct();
        datatype.parmDatatypeId(extendedTypeNum(MyRentEquipmentId));
        datatype.parmReferenceHelp(literalStr("Equipment ID"));
        datatype.parmWizardIsContinuous(false);
        datatype.parmWizardIsManual(NoYes::No);
        datatype.parmWizardIsChangeDownAllowed(NoYes::Yes);
        datatype.parmWizardIsChangeUpAllowed(NoYes::Yes);
        datatype.parmWizardHighest(0);
        datatype.parmSortField(1);
        datatype.addParameterType(NumberSeqParameterType::DataArea, true, false);
        this.create(datatype);            // NOT a NumberSeqReference field assignment
    }

    public NumberSeqModule numberSeqModule()
    {
        return NumberSeqModule::MyRent;  // your NumberSeqModule enum value
    }
}`,
      },
      {
        label: 'Form auto-numbering handler',
        code: `NumberSeqFormHandler numberSeqFormHandler;   // form member

public NumberSeqFormHandler numberSeqFormHandler()
{
    if (!numberSeqFormHandler)
    {
        numberSeqFormHandler = NumberSeqFormHandler::newForm(
            MyRentParameters::numRefMyRentEquipmentId().NumberSequenceId, // RefRecId, not a string
            element,
            MyRentEquipmentTable_ds,
            fieldNum(MyRentEquipmentTable, MyRentEquipmentId));
    }
    return numberSeqFormHandler;
}`,
      },
      {
        label: 'Fetching next number at runtime',
        code: `NumberSequenceReference numSeqRef =
    NumberSeqReference::findReference(extendedTypeNum(MyRentEquipmentId));

NumberSeq numSeq = NumberSeq::newGetNum(numSeqRef);
MyRentEquipmentId newId = numSeq.num();

// If the insert is rolled back, release the number:
// numSeq.abort();`,
      },
    ],
    related: ['transactions'],
  },

  // ── Workflow Development ────────────────────────────────────────────────
  {
    id: 'workflow',
    title: 'Workflow Development (WorkflowDocument, WorkflowType)',
    keywords: ['workflow', 'workflowdocument', 'workflowtype', 'approval', 'task', 'submit', 'cansubmittoworkflow'],
    summary:
      'D365FO workflows are built from a Document (condition fields), a Type, Approvals/Tasks, ' +
      'and event handlers. Structure: Document → Type → Approvals/Tasks → EventHandlers.',
    rules: [
      'Key X++ base classes: WorkflowDocument and WorkflowType — Approvals and Tasks are AOT elements (their code lives in generated event handlers), NOT X++ base classes (there is no WorkflowTask class, and WorkflowApproval is only a field)',
      'WorkflowDocument subclass defines which table fields are available as workflow conditions',
      'SubmitToWorkflowMenuItem action menu item provides the submit button on the form',
      'canSubmitToWorkflow() method on the table controls when submit is enabled',
      'Approval/Task event handlers use WorkflowWorkItemActionManager for complete/reject/delegate',
      'Call search("WorkflowDocument", type="class") for real implementations to model after',
    ],
    related: ['event-handlers', 'sysoperation'],
  },

  // ── Best Practice (BP) checker rules ────────────────────────────────────
  {
    id: 'bp-rules',
    title: 'Best Practice (BP) Rules — Generated Code Must Be BP-Clean',
    keywords: ['bp', 'best practice', 'bpupgradecodetoday', 'bperrorlabelistext', 'bperroredtnotmigrated', 'bpcheck', 'xmldoc', 'doc comment', 'alternate key', 'edt extension', 'stringsize', 'hardcoded string'],
    summary:
      'All generated X++ and metadata must pass the D365FO Best Practice checker without warnings. ' +
      'These are the BP rules the offline validator (validate_code(mode="syntax")) and xppbp.exe enforce most often.',
    rules: [
      'BPUpgradeCodeToday: NEVER use today() — use DateTimeUtil::getToday(DateTimeUtil::getUserPreferredTimeZone()); applies to default parameters, comparisons, and queries',
      'NEVER call a function inside a WHERE condition — assign to a local variable first, then use the variable',
      'BPErrorLabelIsText: no literal strings in Info()/warning()/error() or labels — use @ModelName:LabelId; check labels(action="search") first, create with labels(action="create")',
      'BPErrorUnknownLabel: labels(action="create") BEFORE referencing the label in code; labels adds AxLabelFile descriptors to the VS project automatically (addToProject=true)',
      'BPErrorEDTNotMigrated: a field whose EDT carries an implicit relation (ItemId → InventTable) needs an explicit <AxTableRelation>; generate auto-detects these — manual field adds need a matching relation too',
      'BPCheckNestedLoopinCode: never nest while select inside while select — use join, temp table, or Map pre-load; report DP classes use insert_recordset or a single joined query',
      'BPCheckAlternateKeyAbsent: every table needs at least one index with <AlternateKey>Yes</AlternateKey> (generate adds it automatically)',
      'BPXmlDocNoDocumentationComments: every public/protected class and method needs a MEANINGFUL /// <summary> — "MyClass class." or "validateWrite." fail BP review; describe what it does, parameters, and the semantic meaning of the return value',
      'EDT extensions (AxEdtExtension, objectType="edt-extension") can ONLY change Label, HelpText, FormHelp, ConfigurationKey, HelpAlign, Alignment, NoOfDecimals, DecimalSeparator, SignDisplay — and only when the base EDT has IsExtensible=Yes',
      'EDT extensions can NEVER change Extends (re-parenting) or StringSize/DisplayLength on a derived EDT — to widen a string, create a new EDT extending the existing one, or use a table extension modify-field with stringSize (mind databaseStringSize so data is not truncated)',
      'The d365fo_file(action="modify") validator refuses illegal EDT-extension property changes up-front — relay the message verbatim, do not work around it',
    ],
    related: ['labels', 'deprecated', 'set-based'],
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
      'Standard patterns: SimpleList, SimpleListDetails, DetailsMaster, DetailsTransaction, Dialog, DropDialog, ListPage, TableOfContents, Lookup, Workspace — each defines REQUIRED containers in a REQUIRED order',
      'NEW FORM workflow: object_patterns(domain="form", action="analyze", recommend={...}) → object_patterns(domain="form", action="spec", pattern) → generate_object(mode="scaffold", objectType="form", cloneFrom=referenceForm, tableMapping={...}) → object_patterns(domain="form", action="validate") → d365fo_file(action="create")',
      'CLONING an existing reference form (CustGroup for SimpleList, CustTable for DetailsMaster, SalesTable for DetailsTransaction, PaymTerm for SimpleListDetails, CustParameters for TableOfContents) is the PREFERRED strategy — patterns and sub-patterns are preserved',
      'Container sub-patterns (Pattern element on Group/TabPage): FieldsFieldGroups (fields + max 1 level of groups, NO static text/images), CustomAndQuickFilters (QuickFilter required), ToolbarAndList, SidePanel — validate with object_patterns(domain="form", action="validate")',
      'Structural pattern violations BLOCK d365fo_file(action="create") while FORM_PATTERN_ENFORCE=true (default): wrong control order, missing required container, disallowed child type, unknown pattern/version',
      'ALWAYS use form extensions — never modify standard forms (overlayering is blocked)',
      'Form extension file: AxFormExtension XML — holds new controls, data sources, property overrides',
      'Form extension class: [ExtensionOf(formStr(Target))] — holds CoC logic for form methods',
      'Use get_object_info(objectType="form", name=formName, options={searchControl:"..."}) to find exact control names before extending',
      'New controls: add via d365fo_file(action="modify", operation="add-control", parentControl="TabGeneral") — the control type is checked against the parent container\'s sub-pattern',
      'Data sources: add via d365fo_file(action="modify", operation="add-data-source")',
      'NEVER use PowerShell or read_file to inspect form XML — use get_object_info(objectType="form", name=...)',
      'A user-provided example form is a PATTERN CONTRACT: read it with get_object_info(objectType="form", name=...), keep the same pattern family, and verify the generated form keeps the required scaffolding (datasources, design pattern/version, ActionPane/Body/Tab/FastTab/grid/QuickFilter) — missing pattern elements are a failed generation even if the XML is well-formed',
      'Edits must be additive: never drop unrelated <Controls>, <DataSources>, <DataSourceModifications>, methods, or pattern metadata — use targeted d365fo_file(action="modify") operations and verify the diff with review_workspace_changes afterwards',
    ],
    related: ['coc', 'event-handlers', 'formrun-lifecycle'],
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
      'XDS (Extensible Data Security): row-level security policies (AxSecurityPolicy) that filter records via a constrained query + policy context',
      'Use security_info(mode="coverage") to check what covers a form/table/menu item',
      'Use security_info(mode="artifact") to inspect a role/duty/privilege hierarchy',
      'This topic is the conceptual overview — see security-privileges-duties for privilege/duty/role authoring (XML, generate_object, access levels)',
    ],
    related: ['form-patterns', 'security-privileges-duties'],
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
      'ATL (Acceptance Test Library): entry point is AtlDataRootNode::construct(); navigate via data.invent()/data.sales()/… and use the Creators/Commands/Queries/Specifications concepts (AtlCommand* family) — there is NO AtlScenario or AtlDataHelper class',
      'Test data: use the ATL data root (AtlDataRootNode) creators or setUp() to create transient test records',
      'Run with: run_systest_class MCP tool or Visual Studio Test Explorer',
      'Naming: <TestedClass>Test (e.g. CustTableTest) — the repo systests use this suffix; pick ONE convention per model and keep it consistent',
      'See the unit-testing topic for the detailed SysTestCase rules (transaction rollback, SysTestSuite, mocking)',
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
      'To create/update default dimensions: use DimensionAttributeValueSetStorage (find → addItem → save). There is no DimensionDefaultingService class',
      'To merge two dimension sets: DimensionAttributeValueSetStorage.mergeValues()',
      'To get the display string of a DefaultDimension: use DimensionAttributeValueSetStorage.toString()',
      'To get the display string of a LedgerDimension: use DimensionAttributeValue::find(recId).getValue()',
      'NEVER store dimension strings in custom fields — always use DefaultDimension (Int64 EDT) referencing DimensionAttributeValueSet',
      'The Financial dimensions FastTab is a FORM CONTROL (DimensionEntryControl, added in the form design over the DefaultDimension field) — not a controller class you construct in init(). There is no DimensionDefaultingController',
      'DimensionController is the abstract base behind the dimension entry controls (segment validation, account structure) — subclass it only for custom account-type controls',
      'LedgerDimensionFacade: helper class for building/parsing ledger dimension combinations',
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
        label: 'Default a dimension value on write (CoC on the table)',
        code: `// The Financial dimensions FastTab itself is a DimensionEntryControl placed
// in the form design; from X++ you only touch the DefaultDimension value.
[ExtensionOf(tableStr(MyTable))]
final class MyTable_MyModel_Extension
{
    public void insert()
    {
        DimensionAttributeValueSetStorage dimStorage;
        DimensionAttribute                dimAttribute;
        DimensionAttributeValue           dimValue;

        dimStorage   = DimensionAttributeValueSetStorage::find(this.DefaultDimension);

        // Never hardcode the attribute name in a literal used for logic —
        // look it up so a renamed dimension fails loudly.
        dimAttribute = DimensionAttribute::findByName('CostCenter');

        if (dimAttribute.RecId && !dimStorage.containsDimensionAttribute(dimAttribute.RecId))
        {
            dimValue = DimensionAttributeValue::findByDimensionAttributeAndValue(
                dimAttribute,
                this.MyCostCentreCode,
                false,      // _forUpdate
                true);      // _createIfNecessary

            dimStorage.addItem(dimValue);
            this.DefaultDimension = dimStorage.save();
        }

        next insert();
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
      'Never insert into the GL entry tables directly — always go through the posting framework.',
    rules: [
      'NEVER insert into GeneralJournalEntry / GeneralJournalAccountEntry / SubledgerJournalAccountEntry directly — use SubledgerJournalizer or the LedgerVoucher API (the AX2012 LedgerTrans table no longer exists)',
      'SubledgerJournalizer: modern API for creating accounting entries (replaces LedgerVoucher in new modules)',
      'LedgerVoucher: legacy but still valid for most standard modules (SalesOrder, PurchOrder posting)',
      'LedgerVoucher API shape: LedgerVoucher::newLedgerPost() → LedgerVoucherObject::newVoucher() → addVoucher() → LedgerVoucherTransObject::newTransactionAmountDefault() per line → addTrans() → end()',
      'AxBC classes (AxSalesTable, AxSalesLine, etc.): business component wrappers for posting — extend via CoC, not direct modification',
      'LedgerPostingType (base enum) selects which posting profile a voucher line hits — pass it to newTransactionAmountDefault()',
      'Amounts are signed: a debit is a positive Money, the balancing credit the same amount negated. LedgerVoucher.end() fails if the voucher does not balance',
      'Currency conversion goes through CurrencyExchangeHelper::newExchangeDate(Ledger::current(), transDate) — never hand-compute the accounting-currency amount',
      'Always use ledgerDimension (LedgerDimensionAccount, not defaultDimension) for posting — it combines main account + dimensions',
      'Posting validation: override validate() in AxBC class via CoC — return error() to stop posting',
    ],
    examples: [
      {
        label: 'Create custom voucher with LedgerVoucher',
        code: `LedgerVoucher              ledgerVoucher;
LedgerVoucherObject        voucherObj;
LedgerVoucherTransObject   debit, credit;
CurrencyExchangeHelper     exchangeHelper;

ttsbegin;

ledgerVoucher = LedgerVoucher::newLedgerPost(
    DetailSummary::Detail,
    SysModule::Ledger,
    '');                                  // voucher series: '' = module default

voucherObj = LedgerVoucherObject::newVoucher(
    voucher,                              // Voucher number (from the number sequence)
    transDate,
    SysModule::Ledger,
    LedgerTransType::None);
ledgerVoucher.addVoucher(voucherObj);

exchangeHelper = CurrencyExchangeHelper::newExchangeDate(Ledger::current(), transDate);

// Debit line — positive amount
debit = LedgerVoucherTransObject::newTransactionAmountDefault(
    voucherObj,
    LedgerPostingType::LedgerJournal,
    ledgerDimension,
    currencyCode,
    amount,
    exchangeHelper);
ledgerVoucher.addTrans(debit);

// Credit line — same amount, negated, so the voucher balances
credit = LedgerVoucherTransObject::newTransactionAmountDefault(
    voucherObj,
    LedgerPostingType::LedgerJournal,
    offsetLedgerDimension,
    currencyCode,
    -amount,
    exchangeHelper);
ledgerVoucher.addTrans(credit);

ledgerVoucher.end();                      // posts the voucher

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
      'Original vs copy: the base enum is PrintCopyOriginal (Original/Copy), carried on the report contract as parmPrintCopyOriginal() — there is no PrintCopyType enum or parmPrintCopyType()',
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
      'Naming convention: <ClassName>Test (e.g. MyServiceTest) — matches the repo systests and the testing topic; avoid mixing the <ClassName>_Test variant in the same model',
      'Attributes: [SysTestMethodAttribute] optional — but helps categorize tests',
      'Run tests: Visual Studio → Test → Run All Tests, or SysTestSuite.run() in a batch job',
    ],
    examples: [
      {
        label: 'Basic SysTestCase',
        code: `/// <summary>
/// Unit tests for MyService.
/// </summary>
class MyServiceTest extends SysTestCase
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
    related: ['transactions', 'error-handling', 'testing'],
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
      'To capture infolog output programmatically (testing/logging): snapshot infolog.infologData() and walk it with SysInfologEnumerator::newData() — there is no SysInfoLogScope class',
      'NEVER use print statement — it only shows in job output, not infolog',
      'For Azure Application Insights telemetry: use Microsoft.ApplicationInsights NuGet — not available in standard X++ without NuGet reference',
      'Structured telemetry: use SysGlobalTelemetry (logTrace / logEvent / logMetric / logMetricWithCustomProperties) — there is NO SysTelemetry class; for richer App Insights logging use SysApplicationInsightsTelemetryLogger (Monitoring and Telemetry model)',
      'Batch job logging: use this.BatchHeader.addRuntimeTask() for progress feedback',
      'Infolog messages in batch: saved to BatchHistory — accessible via Batch jobs > History',
      'NEVER log sensitive data (passwords, connection strings, PII) — use masked/hashed values',
    ],
    examples: [
      {
        label: 'Capture infolog output programmatically',
        code: `container               beforeData = infolog.infologData();
container               produced;
SysInfologEnumerator    enumerator;
SysInfologMessageStruct msgStruct;

myService.doSomething();

// Everything the service added since the snapshot
produced   = conDel(infolog.infologData(), 1, conLen(beforeData));
enumerator = SysInfologEnumerator::newData(produced);

while (enumerator.moveNext())
{
    msgStruct = SysInfologMessageStruct::construct(enumerator.currentMessage());

    // currentException() returns the severity as an Exception value
    // (Exception::Info / Warning / Error), NOT a SysInfologLevel.
    info(strFmt('[%1] %2', enumerator.currentException(), msgStruct.message()));
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
      'High-level create/update APIs live on the DirParty class (constructFromPartyRecId, constructFromCommon, createOrUpdatePostalAddress, createOrUpdateContactInfo) and DirPartyTable::createNew — there is NO GlobalAddressBookHelper or DirPartyService class',
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
    keywords: ['sysextension', 'sysextensionappclassfactory', 'sysextensioniattribute', 'sysattribute', 'plugin', 'plug-in', 'factory', 'decorator', 'extensible enum', 'sysplugin'],
    summary:
      'SysExtension allows registering and resolving implementations keyed by an extensible enum without modifying ' +
      'the base code. Replaces if/switch chains. Consists of: a base class or interface, an extensible enum, a ' +
      'factory ATTRIBUTE class (extends SysAttribute implements SysExtensionIAttribute) that each concrete class ' +
      'is decorated with, and a lookup via SysExtensionAppClassFactory.',
    rules: [
      'Define an interface (or abstract base class) for the strategy: interface IMyStrategy { void execute(); }',
      'Create an extensible enum (IsExtensible=Yes) with one value per strategy',
      'Write ONE factory attribute per strategy family: `class MyProcessorAttribute extends SysAttribute implements SysExtensionIAttribute`, taking the enum value in new() and returning a unique parmCacheKey()',
      'Decorate each concrete class with that attribute: [MyProcessorAttribute(MyProcessorType::Express)]',
      'Resolve at runtime: SysExtensionAppClassFactory::getClassFromSysAttribute(classStr(MyProcessorBase), new MyProcessorAttribute(_type))',
      'There is no ExportMetadataAttribute and no SysExtensionAppSuiteDecoratorForward class in D365FO — both are AX2012-era/MEF names that do not resolve',
      'SysPluginFactory::Instance(namespace, className, metadataCollection) is the .NET-plugin sibling — different mechanism, do not mix the two',
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

// 2. Abstract base the factory resolves against
public abstract class MyProcessorBase
{
    public abstract void process(MyTable _record);
}

// 3. Factory attribute — the registration mechanism
class MyProcessorAttribute extends SysAttribute implements SysExtensionIAttribute
{
    MyProcessorType processorType;

    public void new(MyProcessorType _processorType)
    {
        super();
        processorType = _processorType;
    }

    public str parmCacheKey()
    {
        return strFmt('%1;%2',
            classStr(MyProcessorAttribute),
            int2str(enum2int(processorType)));
    }

    public boolean useSingleton()
    {
        return false;
    }
}

// 4. Concrete implementation, decorated with the enum value
[MyProcessorAttribute(MyProcessorType::Express)]
public class MyExpressProcessor extends MyProcessorBase
{
    public void process(MyTable _record)
    {
        // Express processing logic
    }
}

// 5. Factory resolution — no if/switch needed
public static void runProcessor(MyTable _record, MyProcessorType _type)
{
    MyProcessorBase processor = SysExtensionAppClassFactory::getClassFromSysAttribute(
        classStr(MyProcessorBase),
        new MyProcessorAttribute(_type)) as MyProcessorBase;

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
      'Use CurrencyExchangeHelper::newExchangeDate(Ledger::current(), rateDate) as the entry point for every conversion — the factory takes a LEDGER RecId + date, not a currency pair',
      'Convert with the calculate* methods on that helper: calculateTransactionToAccounting() (AmountCur → AmountMST), calculateAccountingToTransaction(), calculateTransactionToTransaction()',
      'ExchangeRateHelper is the read-side helper for the rate itself: getExchangeRate1_Static(ledger, currency, date) / getExchangeRate2_Static() — there is no plain getExchangeRate()',
      'Transaction currency (AmountCur) → Accounting currency (AmountMST): use CurrencyExchangeHelper',
      'Accounting currency is defined per legal entity: CompanyInfo::find().CurrencyCode',
      'Exchange rate types: Default, Budget, Cost accounting — always use the type from Ledger setup',
      'NEVER hard-code exchange rates or calculate manually',
      'For subledger transactions: hand the CurrencyExchangeHelper to the posting API (newTransactionAmountDefault), not manual arithmetic',
      'ExchangeRateType table holds the types; ExchangeRate table holds the actual rates',
      'When inserting subledger lines, let SubledgerJournalizer handle the currency conversion',
    ],
    examples: [
      {
        label: 'Convert transaction currency amount to accounting currency',
        code: `// Convert an amount from transaction currency to accounting currency
CurrencyExchangeHelper  exchangeHelper;
CurrencyCode            fromCurrency = salesLine.CurrencyCode;
TransDate               rateDate     = systemDateGet();
ExchRate                rate;
AmountMST               amountMST;

// The helper is bound to a ledger + a rate date, then reused for every amount
exchangeHelper = CurrencyExchangeHelper::newExchangeDate(Ledger::current(), rateDate);

amountMST = exchangeHelper.calculateTransactionToAccounting(
    fromCurrency,
    salesLine.LineAmount,
    true);                  // _roundResult

// Read-side: the rate itself (e.g. to show it on a form)
rate = ExchangeRateHelper::getExchangeRate1_Static(Ledger::current(), fromCurrency, rateDate);`,
      },
    ],
    related: ['posting-engine', 'financial-dimensions'],
  },

  // ── Alerts / Business Events ────────────────────────────────────────────
  {
    id: 'alerts-business-events',
    title: 'Alerts & Business Events — BusinessEventsContract, EventRule',
    keywords: ['alert', 'business event', 'businesseventscontract', 'businesseventscatalog', 'eventrule', 'eventinbox', 'eventjobcud', 'notification', 'businessevent', 'businesseventsbase'],
    summary:
      'D365FO supports two notification mechanisms: (1) Classic Alerts (user-defined rules on table changes) ' +
      'and (2) Business Events (developer-defined, publishable to Azure Service Bus / Logic Apps / Power Automate). ' +
      'Use Business Events for integration scenarios, Alerts for user-defined notifications.',
    rules: [
      'Business Events: create a class extending BusinessEventsBase with the [BusinessEvents(classStr(<Contract>), name, description, ModuleAxapta::…)] attribute — registration in the catalog is automatic from that attribute, do NOT hand-edit BusinessEventsCatalog',
      'BusinessEventsContract: data contract class with [DataContract] + [DataMember(...), BusinessEventsDataMember(...)] parm methods for payload',
      'Constructor is private new(); expose a static newFrom<Buffer>() factory and override [Wrappable(false), Replaceable(false)] buildContract()',
      'Trigger the event: MyBusinessEvent::newFrom<Buffer>(buffer).send() — never call the private new() directly',
      'Gating: BusinessEventsConfigurationReader::isBusinessEventEnabled controls whether an event is active for a legal entity',
      'Classic Alerts: driven by EventRule / EventRuleData / EventInbox tables, processed by the EventJobCUD batch class — users configure rules in UI, no code needed',
      'Business Events are visible in System administration > Business events catalog',
      'Enable/disable per legal entity in the catalog; endpoint configured there (Service Bus, etc.)',
      'For unit testing there is no BusinessEventsTestHelper — model against BusinessEventsTestEndpointContract and the SysTest framework',
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

    [DataMemberAttribute('SalesId'),
     BusinessEventsDataMember('@SYS22843')]
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

    [Wrappable(false), Replaceable(false)]
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
      'Run ER format from X++: use ERObjectsFactory to get an ERIFormatMappingRun (note the ERI… prefix — there is no IERFormatMappingRun), then call run()',
      'Pass parameters to ER: build an ERModelDefinitionInputParametersAction (addParameter/applyTo) and hand it to withParameter()',
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
    ERIFormatMappingRun formatRun = ERObjectsFactory::createFormatMappingRunByFormatMappingId(
        _formatMappingId,
        _outputPath,        // _fileName
        false,              // _showPromptDialog — false = unattended
        false,              // _showInfologMessage
        false);             // _forceRunDraft

    // Optionally push user-input parameter values into the model definition
    ERModelDefinitionInputParametersAction paramsAction = new ERModelDefinitionInputParametersAction();
    formatRun.withParameter(paramsAction);

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
      'Use generate_object(mode="pattern", pattern="security-privilege") to generate both View and Maintain XML pairs',
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
    related: ['coc-extensions', 'data-entities', 'security'],
  },

  // ── SSRS Reports ────────────────────────────────────────────────────────
  {
    id: 'ssrs-reports',
    title: 'SSRS Reports (DP → TmpTable → RDL)',
    keywords: ['ssrs', 'report', 'rdl', 'dp class', 'data provider', 'srsreportdataproviderbase', 'contract', 'controller', 'design'],
    summary:
      'D365FO SSRS reports use: TmpTable (TempDB) → DataContract → DP class → Controller → AxReport with RDL design.',
    rules: [
      '5 objects: TmpTable (TempDB), Contract (DataContractAttribute), DP (extends SrsReportDataProviderBase), Controller (extends SrsReportRunController), AxReport XML',
      'TmpTable: MUST be TableType=TempDB (NOT InMemory) — required for SSRS data connection',
      'DP class: [SrsReportParameterAttribute(classStr(MyContract))], processReport() fills TmpTable',
      'DP getter: [SRSReportDataSetAttribute(tableStr(MyTmp))] public MyTmp getMyTmp()',
      'Controller: sets report name via ssrsReportStr(), opens dialog, runs report',
      'AxReport XML: DataSet with DataSourceType=ReportDataProvider, Query=SELECT * FROM DPClass.TmpTable',
      'Use generate MCP tool to generate all 5 objects at once',
      'For existing reports, use get_object_info(objectType="report", name=...) — NEVER read report XML with PowerShell',
    ],
    related: ['temp-tables', 'sysoperation'],
  },

  // ── Inventory Management ────────────────────────────────────────────────
  {
    id: 'inventory-management',
    title: 'Inventory Management (InventTrans, InventDim, On-hand)',
    keywords: ['inventory', 'inventtrans', 'inventdim', 'inventsum', 'inventonhand', 'reservation',
               'inventtransorigin', 'inventmov', 'inventupdate', 'on-hand', 'stock'],
    summary:
      'D365FO inventory uses InventTrans (transactions), InventDim (dimension combinations), and InventSum ' +
      '(aggregated on-hand). The InventMovement class hierarchy handles business logic for creating/updating ' +
      'inventory transactions. Reservations flow through InventUpd_Reservation.',
    rules: [
      'InventTrans: one record per inventory lot/transaction; linked via InventTransOrigin to source docs',
      'InventDim: stores inventory dimensions (Site, Warehouse, Location, Batch, Serial, etc.) — NEVER create duplicates, use InventDim::findOrCreate()',
      'InventSum: aggregated on-hand per ItemId + InventDimId — do NOT update directly, it is maintained by the system',
      'InventOnHand: use InventOnHand class (not direct InventSum queries) for accurate on-hand calculations',
      'InventMovement: abstract class hierarchy for business rules on inventory transactions — each source doc type has its own subclass',
      'InventUpdate: updates InventTrans status (e.g. InventUpd_Physical for packing slip, InventUpd_Financial for invoice)',
      'Reservation: InventUpd_Reservation handles soft/hard reservation; respects reservation hierarchy (Site > Warehouse > Location > Batch > Serial)',
      'Dimensions: configuration keys control which dimensions are active — check InventDimSetup',
      'Use InventDimCtrl_Frm* classes to control dimension field visibility on forms',
      'For custom inventory dimensions: follow the extension pattern in Microsoft docs — add via model extension, NOT overlayering',
    ],
    examples: [
      {
        label: 'Query on-hand',
        code: `// Query available on-hand for an item
InventDim       inventDim;
InventOnHand    inventOnHand;

inventDim.InventSiteId      = 'Site1';
inventDim.InventLocationId  = 'WH1';
inventDim = InventDim::findOrCreate(inventDim);

// newItemDim takes an ItemId - NOT an InventTable buffer - and an InventDimParm.
// InventDimParm::activeDimFlag() takes an InventDimGroupSetup, so it is the wrong
// call here; initFromInventDim() flags exactly the dimensions you filled in.
InventDimParm inventDimParm;
inventDimParm.initFromInventDim(inventDim);

inventOnHand = InventOnHand::newItemDim('ItemId', inventDim, inventDimParm);

Qty availPhysical = inventOnHand.availPhysical();`,
      },
      {
        label: 'Find or create InventDim',
        code: `// ALWAYS use findOrCreate — never insert raw InventDim records
InventDim dim;
dim.InventSiteId     = 'Site1';
dim.InventLocationId = 'WH-MAIN';
dim = InventDim::findOrCreate(dim);
// dim.inventDimId is now set`,
      },
    ],
    related: ['query-patterns', 'set-based'],
  },

  // ── Feature Management ──────────────────────────────────────────────────
  {
    id: 'feature-management',
    title: 'Feature Management & Feature Flighting',
    keywords: ['feature management', 'feature class', 'feature flighting', 'featurestateprovider',
               'isfeatureenabled', 'feature toggle', 'feature attribute', 'ifeaturemetadata'],
    summary:
      'D365FO Feature Management allows enabling/disabling features at runtime without redeployment. ' +
      'ISV/custom features register by implementing IFeatureMetadata and exporting the class via ' +
      '[ExportAttribute(...)]; they then appear in the Feature Management workspace. ' +
      'Code checks feature state via FeatureStateProvider::isFeatureEnabled(MyFeature::instance()).',
    rules: [
      'Register a custom feature: `[ExportAttribute(identifierStr(Microsoft.Dynamics.ApplicationPlatform.FeatureExposure.IFeatureMetadata))] public final class MyFeature implements IFeatureMetadata` — there is NO FeatureClassAttribute',
      'The feature class is a singleton: private new(), private static void TypeNew() assigning `instance`, and a public static instance() returning it',
      'IFeatureMetadata members are INSTANCE methods, all marked [Hookable(false)]: label(), summary(), module(), isEnabledByDefault(), canDisable(), learnMoreUrl(). The description shown in the workspace is summary() — there is no description()',
      'Check at runtime: FeatureStateProvider::isFeatureEnabled(MyFeature::instance()) — it takes the feature INSTANCE (IFeature), not classStr()',
      'Convention: wrap that call in a static isEnabled() on the feature class so callers never touch FeatureStateProvider directly',
      'NEVER call isFeatureEnabled() inside a tight loop — cache the result in a local variable',
      'Feature states: Enabled, Disabled, EnabledByDefault (user can still disable when canDisable() returns true)',
      'Always provide a meaningful summary() — it shows in the workspace and helps admins decide',
      'Use Feature Management for gradual rollout — don\'t use configuration keys for new features (CK are compile-time)',
    ],
    examples: [
      {
        label: 'Feature class definition',
        code: `using System.ComponentModel.Composition;
using Microsoft.Dynamics.ApplicationPlatform.FeatureExposure;

/// <summary>
/// My custom feature that enables enhanced validation.
/// </summary>
[ExportAttribute(identifierStr(Microsoft.Dynamics.ApplicationPlatform.FeatureExposure.IFeatureMetadata))]
public final class MyEnhancedValidationFeature implements IFeatureMetadata
{
    private static MyEnhancedValidationFeature instance;

    private void new()
    {
    }

    private static void TypeNew()
    {
        instance = new MyEnhancedValidationFeature();
    }

    [Hookable(false)]
    public static MyEnhancedValidationFeature instance()
    {
        return MyEnhancedValidationFeature::instance;
    }

    [Hookable(false)]
    public FeatureLabelId label()
    {
        return literalStr("@MyModel:EnhancedValidationLabel");
    }

    [Hookable(false)]
    public FeatureLabelId summary()
    {
        return literalStr("@MyModel:EnhancedValidationDesc");
    }

    [Hookable(false)]
    public int module()
    {
        return FeatureModuleV0::SystemAdministration;
    }

    [Hookable(false)]
    public boolean isEnabledByDefault()
    {
        return false;
    }

    [Hookable(false)]
    public boolean canDisable()
    {
        return true;
    }

    // Convention: callers use this, never FeatureStateProvider directly.
    internal static boolean isEnabled()
    {
        return FeatureStateProvider::isFeatureEnabled(MyEnhancedValidationFeature::instance());
    }
}`,
      },
      {
        label: 'Runtime feature check',
        code: `// Branch logic based on feature state
if (MyEnhancedValidationFeature::isEnabled())   // wraps FeatureStateProvider::isFeatureEnabled(instance())
{
    // New enhanced validation path
    this.validateEnhanced();
}
else
{
    // Legacy validation path
    this.validateLegacy();
}`,
      },
    ],
    related: ['sysextension', 'testing'],
  },

  // ── Dual-write ──────────────────────────────────────────────────────────
  {
    id: 'dual-write',
    title: 'Dual-write Integration (Dataverse ↔ F&O)',
    keywords: ['dual-write', 'dual write', 'dataverse', 'cds', 'common data service', 'virtual entity',
               'integration', 'synchronization', 'dualwriteentity'],
    summary:
      'Dual-write provides near-real-time bidirectional synchronization between D365FO and Dataverse (Power Platform). ' +
      'It uses table maps (column mappings) and can be extended with custom logic via plug-ins on both sides. ' +
      'Virtual entities expose F&O data in Dataverse without data duplication.',
    rules: [
      'Dual-write operates on data entities — ensure entities are OData-enabled and public',
      'Table maps define column-level mappings between F&O entity fields and Dataverse table columns',
      'Initial sync: always run from the side with the most complete data set',
      'Error handling: dual-write has a retry mechanism — failed records go to an error queue',
      'Live sync: changes in one system propagate to the other in near-real-time (~seconds)',
      'Virtual entities: NO data copy — F&O data accessed via OData at runtime in Dataverse; read-only by default',
      'For custom entities: add DataManagementEnabled=Yes, IsPublic=Yes, PublicEntityName/CollectionName',
      'NEVER put complex business logic in dual-write transform — keep transforms simple (field mapping, default value)',
      'For custom pre/post processing: use business events + Power Automate instead of dual-write plug-ins',
      'Handle company (DataAreaId) filtering carefully — dual-write respects legal entity context',
      'Performance: avoid dual-write on high-volume transaction tables — use async integration (business events + Service Bus) instead',
    ],
    related: ['data-entities', 'alerts-business-events'],
  },

  // ── Data Management Framework ───────────────────────────────────────────
  {
    id: 'data-management-framework',
    title: 'Data Management Framework (DMF / DIXF)',
    keywords: ['dmf', 'dixf', 'data import', 'data export', 'staging', 'data entity', 'data management',
               'composite entity', 'recurring integration', 'data package', 'data project'],
    summary:
      'DMF (Data Import/Export Framework, formerly DIXF) is the standard mechanism for bulk data import/export in D365FO. ' +
      'It uses data entities with optional staging tables for transformation, validation, and error handling. ' +
      'Supports: file-based import, recurring integrations (queue-based), data packages, and composite entities.',
    rules: [
      'Data entities MUST have DataManagementEnabled=Yes to appear in Data Management workspace',
      'Staging table: auto-generated or custom — holds imported records before target table insertion',
      'Entity categories: Parameter, Reference, Master, Document, Transaction — controls import order in data packages',
      'Composite entities: group header + line entities for hierarchical import (e.g. Sales order with lines)',
      'Recurring integrations: REST API endpoint for automated queue-based import/export with external systems',
      'ALWAYS refresh entity list after deploying new/modified entities: Data Management > Framework Parameters > Refresh entity list',
      'Configuration keys: if entity/table/field config key is disabled, those elements are excluded from DMF',
      'validateWrite() and insert/update chain is called per-record during import — keep these performant',
      'For high-volume: use set-based processing via entity.insertEntityDataSource() where possible',
      'Error handling: staging records get DMFTransferStatus (NotStarted, Completed, Error) — use error log for troubleshooting',
      'Data packages: ZIP files containing multiple entity CSVs — used for ALM and environment configuration migration',
    ],
    examples: [
      {
        label: 'Entity with staging table (key XML properties)',
        code: `<!-- AxDataEntityView key properties for DMF -->
<IsPublic>Yes</IsPublic>
<PublicEntityName>MyCustomer</PublicEntityName>
<PublicCollectionName>MyCustomers</PublicCollectionName>
<DataManagementEnabled>Yes</DataManagementEnabled>
<DataManagementStagingTable>MyCustomerStaging</DataManagementStagingTable>
<EntityCategory>Master</EntityCategory>
<PrimaryKey>EntityKey</PrimaryKey>`,
      },
      {
        label: 'Recurring integration API call',
        code: `// External system pushes data via REST API:
// POST https://{env}.operations.dynamics.com/api/connector/enqueue/{DataProject}
// Content-Type: application/json
// Body: { "MessageId": "...", "Company": "USMF" }
// + attach file as multipart form data
//
// External system pulls exported data via:
// GET https://{env}.operations.dynamics.com/api/connector/dequeue/{DataProject}`,
      },
    ],
    related: ['data-entities', 'set-based'],
  },

  // ── Warehouse Management ────────────────────────────────────────────────
  {
    id: 'warehouse-management',
    title: 'Warehouse Management (WHS / WMS)',
    keywords: ['warehouse', 'whs', 'wms', 'wave', 'work', 'location directive', 'whswork',
               'whsworktable', 'whsworkline', 'whswavetemplate', 'pick', 'put', 'replenishment'],
    summary:
      'D365FO Warehouse Management (WHS) manages advanced warehouse operations: wave processing, ' +
      'work creation, pick/put execution, location directives, and mobile device flows. ' +
      'WHSWorkTable/WHSWorkLine are core tables. Extensions use CoC on wave/work processor classes.',
    rules: [
      'WHSWorkTable: header of warehouse work (pick, put, count, replenishment) — one per work order',
      'WHSWorkLine: detail lines (specific pick/put actions with from/to locations)',
      'Wave processing: WHSWaveTemplate defines steps (wave template) — allocate, create work, etc.',
      'Location directives: WHSLocDirTable rules determine where to pick from and put to',
      'Work templates: define the work action sequence (Pick → Put, Count, etc.)',
      'Mobile device: WHSMobileAppFlow — flows are customizable via extensions',
      'For custom wave steps: extend WHSWaveStepBase and register in wave template config',
      'NEVER directly update WHSWorkTable.WorkStatus — use the WHSWorkExecute class hierarchy',
      'Use WHSLocationProfile for zone/location type configuration',
      'Performance: wave processing is batch-capable — always use batch for large volumes',
      'For extensions: use CoC on WHSPostEngine* classes for custom post-processing logic',
    ],
    related: ['inventory-management', 'sysoperation'],
  },

  // ── Trade Agreements ────────────────────────────────────────────────────
  {
    id: 'trade-agreements',
    title: 'Trade Agreements & Pricing (PriceDisc)',
    keywords: ['trade agreement', 'pricing', 'pricedisc', 'price', 'discount', 'sales price',
               'purchase price', 'line discount', 'multiline discount', 'total discount',
               'pricediscadmtrans', 'priceDiscTable'],
    summary:
      'D365FO trade agreements define prices and discounts for sales/purchase. ' +
      'The PriceDisc class evaluates active agreements based on date, quantity, unit, dimensions, and customer/vendor hierarchy. ' +
      'Agreements are stored in PriceDiscAdmTrans (journal lines) and activated via posting to PriceDiscTable.',
    rules: [
      'Trade agreement types: Sales price, Purchase price, Line discount, Multiline discount, Total discount',
      'PriceDisc.findPrice() / findDisc(): core methods for price/discount evaluation — use these, NOT direct table queries',
      'Agreement evaluation order: specific (customer+item) → group (cust group+item) → all (all+item) → all+all',
      'Date effectivity: agreements have FromDate/ToDate — always pass the correct transaction date',
      'Quantity breaks: agreements can be quantity-tiered — PriceDisc considers the line quantity',
      'Dimension matching: agreements can be dimension-specific (color, size, config, style)',
      'Journal posting: PriceDiscAdmTrans → post (validate + transfer) → PriceDiscTable (active agreements)',
      'For custom pricing: extend PriceDisc via CoC on findPriceAgreement() or use pricing events',
      'NEVER hardcode prices in code — always use the trade agreement / pricing framework',
      'Supplementary items: PriceDiscAdmTrans can define supplementary items that auto-add to sales lines',
    ],
    related: ['coc', 'query-patterns'],
  },

  // ── Configuration Keys ──────────────────────────────────────────────────
  {
    id: 'configuration-keys',
    title: 'Configuration Keys (Compile-time Feature Toggle)',
    keywords: ['configuration key', 'config key', 'license code', 'conditional compilation',
               'configurationkeynum', 'isconfiguationkeyenabled', 'sysconfigkey'],
    summary:
      'Configuration keys in D365FO control compile-time visibility of tables, fields, menu items, ' +
      'and security. Unlike Feature Management (runtime), config keys require recompilation when changed. ' +
      'They are typically used for module licensing and major functional areas.',
    rules: [
      'Configuration keys are compile-time — changing them requires deployment/recompilation',
      'For runtime toggles, prefer Feature Management over config keys (no recompilation needed)',
      'Tables/fields with disabled config keys are excluded from the database schema',
      'Data entities respect config keys — disabled fields are excluded from DMF and OData',
      'Use isConfigurationKeyEnabled(configurationKeyNum(MyKey)) for runtime checks',
      'License codes: control which config keys are available — tied to ISV licensing',
      'Custom config keys: create AxConfigurationKey XML and assign to tables/fields/menu items',
      'Parent-child hierarchy: disabling a parent key disables all child keys',
      'ALWAYS test with your config keys disabled — ensure no compile errors in alternate configurations',
      'After config key changes: refresh entity list in Data Management workspace',
    ],
    examples: [
      {
        label: 'Runtime config key check',
        code: `// Check if a configuration key is enabled at runtime
if (isConfigurationKeyEnabled(configurationKeyNum(WHSAdvanced)))
{
    // WHS advanced features are available
    this.processAdvancedWHS();
}
else
{
    // Basic warehouse (WMS) path
    this.processBasicWMS();
}`,
      },
      {
        label: 'AxConfigurationKey XML',
        code: `<?xml version="1.0" encoding="utf-8"?>
<AxConfigurationKey xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
  <Name>MyModuleKey</Name>
  <Label>@MyModel:ModuleLabel</Label>
  <Enabled>Yes</Enabled>
  <LicenseCode>MyModuleLicenseCode</LicenseCode>
</AxConfigurationKey>`,
      },
    ],
    related: ['feature-management', 'security-privileges-duties'],
  },

  // ── Power Platform Integration ──────────────────────────────────────────
  {
    id: 'power-platform-integration',
    title: 'Power Platform Integration (Virtual Entities, Dataverse)',
    keywords: ['power platform', 'power automate', 'power apps', 'virtual entity', 'dataverse',
               'finance operations connector', 'odata', 'business event', 'flow'],
    summary:
      'D365FO integrates with Power Platform via: OData endpoints (data entities), Business Events (triggers for Power Automate), ' +
      'Virtual Entities (Dataverse tables backed by F&O data), and the Finance and Operations connector in Power Automate.',
    rules: [
      'OData endpoint: data entities with IsPublic=Yes are auto-exposed at {env}/data/{CollectionName}',
      'Business events: subscribe via Power Automate trigger "When a Business Event occurs" for real-time notifications',
      'Virtual entities: F&O tables/entities visible in Dataverse WITHOUT data duplication — queries route to F&O at runtime',
      'Virtual entity setup: enable in Dataverse admin, configure in Power Platform integration settings in F&O',
      'Finance and Operations connector: Power Automate actions for CRUD on data entities, running business events, executing batch jobs',
      'For custom triggers: create a custom business event class (extends BusinessEventsBase) → it auto-appears as a Power Automate trigger',
      'Authentication: virtual entities and OData use Azure AD (Entra ID) authentication — configure app registrations properly',
      'NEVER expose sensitive data via OData without proper security — configure security privileges on data entities',
      'Rate limiting: OData has throttling limits — use batch operations ($batch) for bulk CRUD',
      'For Canvas/Model-driven apps: use virtual entities for real-time F&O data, NOT dual-write (which is for bidirectional sync)',
    ],
    related: ['data-entities', 'alerts-business-events', 'dual-write'],
  },

  // ── Select Statement Grammar ────────────────────────────────────────────
  {
    id: 'select-statement',
    title: 'X++ select Statement — Complete Grammar Reference',
    keywords: ['select', 'while select', 'findoption', 'firstonly', 'crosscompany', 'forupdate', 'join', 'outer join', 'exists join', 'notexists join', 'forceliterals', 'forceplaceholders', 'in operator', 'aggregate', 'sum', 'count', 'group by', 'validtimestate', 'index hint', 'grammar'],
    summary:
      'Complete grammar reference for X++ select/while select. Statement order: [FindOptions] [FieldList from] tableBuffer [index] [order by / group by] [where …] [join … [where …]]. ' +
      'FindOptions go BETWEEN "select" and the table buffer. Each joined buffer has its own where clause immediately after it.',
    rules: [
      'FindOptions (crossCompany, firstOnly, forUpdate, forceNestedLoop, forceSelectOrder, forcePlaceholders, pessimisticLock, optimisticLock, repeatableRead, validTimeState, noFetch, reverse, firstFast) go BETWEEN "select" and the table buffer / field list',
      'crossCompany belongs on the OUTER (driving) buffer — never on a joined buffer. Optional container filter: select crossCompany : myContainer table …',
      'Each joined buffer gets its own "where" clause immediately after it; order by / group by appear after the full join chain',
      '"in" operator: "where field in container" — container = X++ container type; works with str/int/int64/real/enum/boolean/date/utcDateTime. NOT a Set, List class, or subquery',
      'forceLiterals is FORBIDDEN — SQL injection risk; use forcePlaceholders (default for non-join selects) or omit',
      'No function calls in WHERE — assign result to a local variable first (performance + BP compliance)',
      'outer join is LEFT OUTER only — no RIGHT outer, no "left" keyword; check joined buffer.RecId == 0 to detect "no match"',
      'Join criteria use "where", not "on" — X++ has no "on" keyword',
      '"index hint" requires buffer.allowIndexHint(true) to be called first; otherwise silently ignored — use only when measured',
      'Aggregates (sum/avg/count/minof/maxof): when sum would be null X++ returns NO row — guard with "if (buffer)" after the select',
      'Non-aggregated fields in select list must appear in "group by" when aggregates are used',
      'validTimeState(dateFrom, dateTo): use for date-effective tables (ValidTimeStateFieldType ≠ None)',
      'doInsert/doUpdate/doDelete bypass overridden methods and event handlers — reserved for data-fix/migration scenarios only',
      'For dynamic queries from user input: use executeQueryWithParameters API — NEVER concatenate into where clause',
    ],
    examples: [
      {
        label: 'crossCompany — correct vs wrong placement',
        code: `// ✅ CORRECT — crossCompany on the driving buffer
select crossCompany custTable
    join custInvoiceJour
    where custInvoiceJour.OrderAccount == custTable.AccountNum;

// ❌ WRONG — crossCompany on joined buffer
select custTable
    join crossCompany custInvoiceJour where …;`,
      },
      {
        label: '"in" operator with container',
        code: `container statusFilter = [CustVendorBlocked::No, CustVendorBlocked::Invoice];
CustTable custTable;
while select AccountNum from custTable
    where custTable.Blocked in statusFilter
{
    info(custTable.AccountNum);
}`,
      },
      {
        label: 'Function in WHERE — wrong vs correct',
        code: `// ❌ WRONG — function call directly in WHERE
select salesTable where salesTable.ShippingDateRequested == DateTimeUtil::getSystemDate(...);

// ✅ CORRECT — assign to variable first
date cutoffDate = DateTimeUtil::getSystemDate(DateTimeUtil::getUserPreferredTimeZone());
select salesTable where salesTable.ShippingDateRequested == cutoffDate;`,
      },
    ],
    related: ['query-patterns', 'set-based', 'query-object-model'],
  },

  // ── CoC Authoring Non-negotiables ───────────────────────────────────────
  {
    id: 'coc-authoring',
    title: 'CoC Authoring Non-negotiables',
    keywords: ['coc', 'chain of command', 'next', 'default parameter', 'wrappable', 'hookable', 'final', 'extensionof', 'wrapper', 'form coc', 'formdatasourcestr', 'static coc', 'replaceable', 'pre', 'post', 'wrap'],
    summary:
      'Strict rules for authoring CoC wrappers. The most common mistake is copying default parameter values. ' +
      'next must always be called at first-level scope. Always use get_method(include="signature") before writing any wrapper.',
    rules: [
      'NEVER copy default parameter values into the wrapper signature — wrapper uses bare parameter types only',
      'next must be at first-level statement scope: NOT inside if/while/for, NOT after return, NOT inside a logical expression. PU21+: permitted inside try/catch/finally',
      'Wrapper must always call next — except on [Replaceable] methods',
      'Signature otherwise matches base exactly: return type, param types and order, static modifier',
      'Static method wrappers must repeat "static". Forms cannot have static-method CoC',
      'Cannot wrap constructors; new parameterless public methods on extension class become the extension\'s own constructor',
      'Extension class shape: [ExtensionOf(<Str>(...))] final class <Target>_Extension — MUST be final',
      '[Hookable(false)] blocks CoC entirely. [Wrappable(false)] blocks wrapping; final methods need [Wrappable(true)] to allow wrapping',
      'Form-nested wrapping uses formdatasourcestr, formdatafieldstr, formControlStr. Cannot ADD new methods via CoC — only wrap existing ones (init, validateWrite, clicked, …)',
      'Wrappers can read/call protected members of the augmented class (PU9+); cannot reach private',
      'Pre-processing: call business logic before next. Post-processing: call next first, then business logic. Wrap: call next inside the logic',
      'Use get_method(include="signature") tool to get exact parameter types before writing the wrapper',
      'REUSE BEFORE CREATING: if a CoC extension class for the target already exists in the custom model (prepare(mode="change") / extension_info(mode="coc") lists them), add the wrapper there — never create a parallel feature-named class (<Target>_<Feature>_Extension) unless the user explicitly requests separation',
      'The class suffix comes from EXTENSION_NAMING_STYLE and existing related artifacts — never from feature names, tickets, or customer names; if it cannot be derived, ask the user',
    ],
    examples: [
      {
        label: 'Default parameter — wrong vs correct',
        code: `// Base method
public void salute(str message = "Hi") { … }

// ✅ CORRECT — no default value in wrapper
public void salute(str message)
{
    next salute(message);
}

// ❌ WRONG — copying the default breaks the CoC contract
public void salute(str message = "Hi")
{
    next salute(message);  // compile error in strict mode
}`,
      },
      {
        label: 'next placement — correct vs wrong scope',
        code: `// ✅ CORRECT — next at first-level scope (post-processing)
public boolean validateWrite()
{
    boolean ret = next validateWrite();  // first-level ✅
    if (this.CreditMax > 1000000)
        ret = checkFailed("@MyModel:CreditLimitExceeded");
    return ret;
}

// ❌ WRONG — next inside an if block
public void post()
{
    if (this.shouldPost())
        next post();  // NOT first-level scope ❌
}`,
      },
    ],
    related: ['coc', 'event-handlers'],
  },

  // ── X++ Class & Method Rules ─────────────────────────────────────────────
  {
    id: 'xpp-class-rules',
    title: 'X++ Class & Method Rules',
    keywords: ['class', 'method', 'access modifier', 'public', 'protected', 'private', 'internal', 'final', 'abstract', 'static', 'constructor', 'new', 'construct', 'parm', 'this', 'extension method', 'override', 'optional parameter', 'pass by value', 'var', 'const', 'macro'],
    summary:
      'X++ class and method rules: access defaults, constructor pattern, modifier order, this usage, extension methods, optional parameters, and pass-by-value semantics.',
    rules: [
      'Class default access = public. Removing "public" does NOT make a class non-public. Use internal, final, abstract deliberately',
      'Instance fields default = protected — NEVER make them public; expose via parmFoo() accessors',
      'Constructor pattern: new() is protected, public static construct() factory; init() for post-construction setup',
      'Method modifier order: [edit|display] [public|protected|private|internal] [static|abstract|final]',
      'Override visibility: must be at least as accessible as the base method. private is not overridable',
      'Optional parameters must come after required ones; all preceding parameters must be supplied. Use prmIsDefault(_x) to detect "was this passed"',
      'All parameters are pass-by-value — mutating a parameter does NOT affect the caller\'s variable',
      '"this" is required for instance method calls; cannot qualify class-declaration member variables (use bare name); cannot be used in static methods; cannot qualify static methods (use ClassName::method())',
      'Extension methods (target Class/Table/View/Map): extension class must be static, name ends _Extension; methods are public static; first param is the target type, supplied by runtime',
      'Constants over macros: public const str FOO = "bar"; at class scope; reference via ClassName::FOO or unqualified inside the class',
      '"var" keyword only when the type is obvious from initialization; skip when ambiguous',
      'Declare variables close to first use, smallest scope; compiler rejects shadowing',
    ],
    related: ['coc-authoring', 'coc'],
  },

  // ── SysDa Framework ─────────────────────────────────────────────────────
  {
    id: 'sysda',
    title: 'SysDa Framework — Fluent Query API',
    keywords: ['sysda', 'sysdaqueryobject', 'sysdafindstatement', 'sysdafindobj', 'sysdaupdatestatement', 'sysdaupdateobject', 'sysdainsertstatement', 'sysdadeletestatement', 'sysdaequalsexpression', 'sysdafieldexpression', 'sysdavalueexpression', 'fluent query', 'dynamic query', 'sysdajoinkind'],
    summary:
      'SysDa is the modern X++ fluent/object-oriented query API. Use for dynamic queries where shape depends on runtime conditions. ' +
      'Use "select/while select" for static, known-at-compile-time queries (cleaner, faster to read, compile-time field validation).',
    rules: [
      'SysDaQueryObject: root query builder — set table buffer via constructor: new SysDaQueryObject(custTable)',
      'SysDaSearchObject / SysDaSearchStatement: execute query and populate buffers in a while loop via nextRecord()',
      'SysDaFindObject / SysDaFindStatement: firstOnly equivalent — returns true/false, populates buffer',
      'SysDaUpdateObject / SysDaUpdateStatement: set-based update without row-by-row fetch',
      'SysDaInsertObject / SysDaInsertStatement: set-based insert from another query result',
      'SysDaDeleteObject / SysDaDeleteStatement: set-based delete',
      'Joins: qe.joinClause(SysDaJoinKind::InnerJoin, joinQe) — supports Inner, Outer, Exists, NotExists',
      'Where clause: qe.whereClause(new SysDaEqualsExpression(new SysDaFieldExpression(...), new SysDaValueExpression(...)))',
      'Use SysDa when: query shape depends on runtime conditions, building framework/reusable logic, dynamic field selection',
      'Use "select/while select" when: static queries, compile-time field validation, clarity is preferred',
    ],
    examples: [
      {
        label: 'Basic SysDa search',
        code: `CustTable custTable;
var qe = new SysDaQueryObject(custTable);
qe.whereClause(new SysDaEqualsExpression(
    new SysDaFieldExpression(custTable, fieldStr(CustTable, AccountNum)),
    new SysDaValueExpression('US-001')
));
var so = new SysDaSearchStatement();
while (so.nextRecord(qe))
{
    info(custTable.AccountNum);
}`,
      },
      {
        label: 'SysDa inner join',
        code: `CustTable custTable;
CustTrans custTrans;
var qMain  = new SysDaQueryObject(custTable);
var qJoin  = new SysDaQueryObject(custTrans);
qJoin.whereClause(new SysDaEqualsExpression(
    new SysDaFieldExpression(custTrans, fieldStr(CustTrans, AccountNum)),
    new SysDaFieldExpression(custTable, fieldStr(CustTable, AccountNum))
));
qMain.joinClause(SysDaJoinKind::InnerJoin, qJoin);

var so = new SysDaSearchStatement();
while (so.nextRecord(qMain))
{
    info(custTable.AccountNum);
}`,
      },
    ],
    related: ['query-patterns', 'query-object-model'],
  },

  // ── AOT Query Object Model ──────────────────────────────────────────────
  {
    id: 'query-object-model',
    title: 'AOT Query Object Model (Query / QueryRun)',
    keywords: ['query', 'queryrun', 'querybuilddsource', 'querybuildatasouce', 'querybuildrange', 'queryvalue', 'sysquery', 'findorcreaterange', 'adddatasource', 'addrange', 'addsortfield', 'joinmode', 'allowcrosscompany', 'addcompanyrange'],
    summary:
      'The Query/QueryRun classes execute AOT-defined or runtime-built queries. Use for form/report data binding, ' +
      'when users dynamically modify filters (SysQueryForm), or when the same query is reused across multiple consumers.',
    rules: [
      'Query: defines structure (data sources, ranges, sorting, joins)',
      'QueryBuildDataSource (QBDS): one table in the query — add via query.addDataSource(tableNum(T))',
      'QueryBuildRange: filter — qbds.addRange(fieldNum(T, Field)).value(queryValue("X"))',
      'QueryRun: executes the query and iterates results via next() and get(tableNum(T))',
      'SysQuery::findOrCreateRange(qbds, fieldNum): idempotent range addition — use instead of addRange to avoid duplicate ranges',
      'QueryBuildDataSource::addDataSource(): nested join (child data source within parent DS)',
      'qbds.joinMode(JoinMode::ExistsJoin): set join type at runtime — ExistsJoin, NotExistsJoin, OuterJoin, InnerJoin',
      'query.allowCrossCompany(true) + query.addCompanyRange("dat"): cross-company at Query level',
      'Use AOT Query objects when: forms/reports bind to them, reusable across multiple consumers',
      'Use runtime Query when: user can dynamically modify filters (SysQueryRun), batch dialog filtering needed',
      'Use "select" for: inline data access where no dynamic filter UI is needed',
    ],
    examples: [
      {
        label: 'Runtime Query with range and sorting',
        code: `Query query = new Query();
QueryBuildDataSource qbds = query.addDataSource(tableNum(CustTable));
qbds.addRange(fieldNum(CustTable, CustGroup)).value(queryValue('10'));
qbds.addSortField(fieldNum(CustTable, AccountNum));
QueryRun qr = new QueryRun(query);
while (qr.next())
{
    CustTable ct = qr.get(tableNum(CustTable));
    info(ct.AccountNum);
}`,
      },
      {
        label: 'SysQuery::findOrCreateRange — idempotent pattern',
        code: `// Use in form init() or executeQuery() CoC — safe to call multiple times
QueryBuildDataSource qbds = this.queryBuildDataSource();
SysQuery::findOrCreateRange(
    qbds,
    fieldNum(CustTable, CustGroup)).value('DOM');`,
      },
    ],
    related: ['query-patterns', 'sysda'],
  },

  // ── FormRun Lifecycle ───────────────────────────────────────────────────
  {
    id: 'formrun-lifecycle',
    title: 'FormRun Lifecycle & Form Extension Points',
    keywords: ['formrun', 'form lifecycle', 'form init', 'form run', 'executequery', 'formdatasource', 'active', 'validatewrite', 'clicked', 'modified', 'form extension', 'research', 'element.args', 'element.design', 'formcontrol', 'formletterservicecontroller'],
    summary:
      'D365FO forms follow a strict initialization sequence. Extensions use CoC on lifecycle methods. ' +
      'Never guess control names — use get_object_info(objectType="form", name=formName, options={searchControl:"..."}) before extending.',
    rules: [
      'Initialization sequence: form.init() → FormDataSource.init() per DS → form.run() → FormDataSource.executeQuery()',
      'form.init(): form structure loaded, data sources NOT yet active — safe for: adding ranges, modifying query before first run',
      'FormDataSource.init(): each data source initializes — add default ranges here, link types resolved',
      'FormDataSource.executeQuery(): fires on each refresh — modify query dynamically here (e.g., based on active record)',
      'FormDataSource.active(): fires when cursor moves to a new record — update dependent data sources or UI state',
      'FormDataSource.validateWrite(): custom validation before save — return false to prevent save',
      'FormDataSource.write(): post-save logic — record is already committed when this fires',
      'FormControl.clicked(): button click handler. FormControl.modified(): field value changed handler',
      'FormDataSource.research(retainPosition: true): refresh grid keeping cursor position (preferred over executeQuery for UI refresh)',
      'element.args(): access caller context (menu item, record, enum parameter passed via Args)',
      'FormDataSource.queryBuildDataSource(): access underlying QueryBuildDataSource for runtime range manipulation',
      'element.design().controlName(formControlStr(MyForm, MyControl)): access control instance by name at runtime',
      'NEVER guess control names — they differ from field names and are often prefixed; use get_object_info(objectType="form", name=formName, options={searchControl:"..."})',
      'Use [ExtensionOf(formStr(...))] for form-level CoC; forms cannot have static-method CoC',
      'Add data sources via d365fo_file(action="modify", operation="add-data-source")',
      'Add controls via d365fo_file(action="modify", operation="add-control", parentControl="TabGeneral")',
      'Typical overrides per pattern — SimpleList/setup: DS initValue + validateWrite; DetailsMaster: form init + DS active/validateWrite; DetailsTransaction: lines DS initValue (defaults from header) + header DS active; Dialog: form init (read element.args()) + closeOk; Lookup: form init + DS executeQuery (caller-context filter)',
      'generate_object(mode="scaffold", objectType="form", includeMethodStubs=true) injects these pattern-appropriate stubs automatically; object_patterns(domain="form", action="spec", pattern) lists them',
    ],
    related: ['coc', 'form-patterns'],
  },

  // ── Reading Excel / CSV files in X++ ──────────────────────────────────────
  {
    id: 'file-readers',
    title: 'Reading Excel (XLSX) & CSV Files in X++',
    keywords: ['excel', 'xlsx', 'csv', 'openxml', 'spreadsheet', 'sysexcel', 'commaio', 'asciiio', 'file upload', 'fileupload', 'import file', 'read file', 'streamreader', 'fileuploadtemporarystoragestrategy', 'office', 'epplus'],
    summary:
      'Reading uploaded Excel/CSV in cloud D365FO must be STREAM-based: the AOS is sandboxed (no Office, no arbitrary file-system access). ' +
      'Use the OpenXML SDK (DocumentFormat.OpenXml) for XLSX and a stream reader for CSV, both fed from a FileUpload stream — never COM Excel or file-path readers.',
    migration: {
      ax2012: 'SysExcelApplication / SysExcelWorksheet (COM), or CommaIo("C:\\\\file.csv") / AsciiIo file-path readers',
      d365fo: 'DocumentFormat.OpenXml.Packaging.SpreadsheetDocument over a System.IO.Stream (XLSX); CommaTextStreamIo / System.IO.StreamReader over a stream (CSV)',
    },
    rules: [
      'XLSX: use the OpenXML SDK — DocumentFormat.OpenXml.Packaging.SpreadsheetDocument::Open(stream, false). It is the only server-side-supported reader.',
      '⛔ NEVER use SysExcelApplication / SysExcelWorksheet / Microsoft.Office.Interop.Excel — COM Office is NOT installed on cloud AOS; it throws at runtime.',
      'CSV: read from a System.IO.Stream via CommaTextStreamIo (X++) or System.IO.StreamReader (.NET). ⛔ NEVER use file-path CommaIo / AsciiIo — the AOS has no access to a client/server file path.',
      'Get the stream from a FileUpload control: FileUploadTemporaryStorageStrategy.uploadResultFileName() → File::UseFileFromURL / openFileUploadDialog returns the stream. In a SysOperation, accept the storage URL as a contract member.',
      'CommaTextStreamIo.parmDelimiter / parmRecordDelimiter to set separators; check inFieldDelimiter for semicolon-separated regional CSVs.',
      'Always wrap .NET interop in try/catch and dispose: use System.IO streams in a try/finally and call package.Dispose()/Close().',
      'Encoding matters for CSV: read with the right System.Text.Encoding (UTF-8 vs ANSI/1252) or accented characters corrupt.',
      'For large imports prefer the Data Management Framework (DMF) with a file entity — hand-rolled readers are for ad-hoc/lightweight cases.',
    ],
    examples: [
      {
        label: 'XLSX — OpenXML SDK over an uploaded stream',
        code: `using DocumentFormat.OpenXml.Packaging;
using DocumentFormat.OpenXml.Spreadsheet;

public void readExcel(System.IO.Stream _stream)
{
    SpreadsheetDocument doc = SpreadsheetDocument::Open(_stream, false);
    try
    {
        WorkbookPart       wbPart = doc.get_WorkbookPart();
        WorksheetPart      wsPart = wbPart.get_WorksheetParts().get_Item(0);
        DocumentFormat.OpenXml.OpenXmlReader reader =
            DocumentFormat.OpenXml.OpenXmlReader::Create(wsPart);

        while (reader.Read())
        {
            if (reader.get_ElementType() == typeof(Row))
            {
                // read cells of the row …
            }
        }
    }
    finally
    {
        doc.Dispose();
    }
}`,
      },
      {
        label: 'CSV — stream-based reader (cloud-safe)',
        code: `public void readCsv(System.IO.Stream _stream)
{
    CommaTextStreamIo io = CommaTextStreamIo::constructForRead(_stream);
    io.inFieldDelimiter(';');          // regional CSV
    container line = io.read();         // header
    while (io.status() == IO_Status::Ok)
    {
        line = io.read();
        if (io.status() != IO_Status::Ok) break;
        str itemId = conPeek(line, 1);
        // …
    }
}`,
      },
    ],
    related: ['data-management-framework', 'error-handling'],
  },

  // ── Parallel / multi-threaded batch ───────────────────────────────────────
  {
    id: 'parallel-batch',
    title: 'Parallel (Multi-threaded) Batch Processing',
    keywords: ['parallel batch', 'multithread', 'multi-threaded', 'batchheader', 'addruntimetask', 'runtime task', 'batch task', 'fan out', 'partition', 'threads', 'batch bundling', 'addtask', 'adddependency', 'concurrent'],
    summary:
      'To process large workloads in parallel, fan the work out into independent batch tasks added to one BatchHeader — the batch engine runs them concurrently across batch threads/AOS instances. ' +
      'A single run() method is single-threaded; ⛔ never use System.Threading inside batch.',
    rules: [
      'Fan-out pattern: in the controller/operation, partition the work (e.g. by a key range) and add one runtime task per partition to a BatchHeader via batchHeader.addRuntimeTask(task, server).',
      'Each task is its own RunBaseBatch (or SysOperation service) that processes ONE partition with its own ttsbegin/ttscommit scope — never one giant transaction across all data.',
      '⛔ NEVER use System.Threading.Thread / Tasks inside batch code — the batch framework owns threading; manual threads are unsupported and unsafe with the session/company context.',
      'Concurrency is controlled by the batch group + the AOS "Maximum batch threads" setting — not by your code. Size partitions so each task is a few minutes of work.',
      'Use BatchHeader::getCurrentBatchHeader() when adding tasks from within an already-running batch (self-spawning); construct a fresh BatchHeader when scheduling from a UI controller.',
      'Only add addDependency() between tasks when ordering is required — independent tasks with no dependencies maximise parallelism.',
      'Make each task idempotent/resumable: a parallel task may be retried after a transient failure, so guard against double-processing (e.g. status flag, RecId watermark).',
      'For data-parallel set work, also consider SysOperation with parmExecutionMode(SysOperationExecutionMode::ScheduledBatch) plus task fan-out — but the BatchHeader.addRuntimeTask split is the canonical approach.',
    ],
    examples: [
      {
        label: 'Fan out independent tasks to one BatchHeader',
        code: `public void scheduleParallel(List _partitions)
{
    BatchHeader batchHeader = BatchHeader::construct();
    ListEnumerator le = _partitions.getEnumerator();

    while (le.moveNext())
    {
        MyPartitionTask task = new MyPartitionTask();   // extends RunBaseBatch
        task.parmPartitionKey(le.current());
        batchHeader.addRuntimeTask(task, this.parmCurrentBatch().RecId);
    }

    batchHeader.parmCaption("@MyModel:ParallelImport");
    batchHeader.save();   // tasks now run concurrently across batch threads
}`,
      },
    ],
    related: ['sysoperation', 'transactions', 'performance'],
  },

  // ── Direct SQL execution ──────────────────────────────────────────────────
  {
    id: 'direct-sql',
    title: 'Direct SQL Execution (Connection / Statement)',
    keywords: ['direct sql', 'connection', 'userconnection', 'statement', 'resultset', 'sqlstatementexecutepermission', 'executequery', 'executeupdate', 'ado', 'raw sql', 'sqlsystem', 'forceliterals sql'],
    summary:
      'Direct SQL (Connection + Statement + ResultSet) bypasses the X++ data layer for performance-critical reads. ' +
      'It REQUIRES an explicit SqlStatementExecutePermission assert, and must use parameters — never string-concatenate user input.',
    rules: [
      'Always assert before executing: new SqlStatementExecutePermission(sql).assert();  run the statement;  CodeAccessPermission::revertAssert();  — without the assert you get a CAS runtime error.',
      '⛔ NEVER concatenate user input into the SQL string — SQL injection. Build parameterised statements; treat any external value as hostile.',
      'Prefer X++ set-based operations (insert_recordset / update_recordset / delete_from) first — direct SQL is a last resort for reads X++ cannot express efficiently.',
      'Use Connection for the current company/partition DB; UserConnection when you need an explicit, separate transaction scope.',
      'Qualify by DataAreaId AND Partition in the WHERE clause — direct SQL does NOT apply the automatic company/partition filter that X++ select does.',
      'Field/table names in raw SQL are the SQL names (e.g. RECID, DATAAREAID) — use fieldId2name/tableId2name or dbg names, not necessarily the AOT label-cased names.',
      'Dispose/close ResultSet and Statement; keep the asserted scope as narrow as possible (assert immediately before execute, revert immediately after).',
      'Direct DDL, cross-database and use of forceLiterals are restricted/forbidden on cloud — keep direct SQL to parameterised SELECTs against the AX database.',
    ],
    examples: [
      {
        label: 'SELECT with the required permission assert',
        code: `Connection  conn = new Connection();
Statement   stmt = conn.createStatement();
// Filter values must be validated/whitelisted, never raw user input.
str         custGroup = this.getValidatedCustGroup();
str         sql  = strFmt(
    "SELECT RECID, ACCOUNTNUM FROM CUSTTABLE "
  + "WHERE DATAAREAID = '%1' AND CUSTGROUP = '%2'",
    curext(), custGroup);

// REQUIRED — assert immediately before execute, revert immediately after
new SqlStatementExecutePermission(sql).assert();
try
{
    ResultSet rs = stmt.executeQuery(sql);
    while (rs.next())
    {
        int64 recId      = rs.getInt64(1);
        str   accountNum = rs.getString(2);
        // …
    }
}
finally
{
    CodeAccessPermission::revertAssert();
}`,
      },
    ],
    related: ['set-based', 'select-statement', 'performance'],
  },

  // ── Menus & submenu nesting ────────────────────────────────────────────────
  {
    id: 'menu-navigation',
    title: 'Menus, Menu Items & Submenu Nesting',
    keywords: ['menu', 'submenu', 'sub-menu', 'navigation', 'axmenu', 'axmenuelement', 'menu item', 'nesting', 'inquiries and reports'],
    summary:
      'An AxMenu is a flat <Elements> collection of AxMenuElement entries. A menu ITEM reference ' +
      '(display/action/output) is an AxMenuElementMenuItem. A NESTED SUBMENU (another AxMenu shown ' +
      'as a folder inside this one, e.g. "Inquiries and reports") is a DIFFERENT element type — ' +
      'AxMenuElementSubMenu — with its own field name, not a menu-item reference.',
    rules: [
      'Menu-item reference: <AxMenuElement i:type="AxMenuElementMenuItem"><Name>X</Name><MenuItemName>X</MenuItemName></AxMenuElement>',
      'Submenu reference (nesting another AxMenu inside this one): <AxMenuElement i:type="AxMenuElementSubMenu"><Name>X</Name><SubMenu>X</SubMenu></AxMenuElement> — ' +
        'the field is <SubMenu>, NOT <MenuName> and NOT <MenuItemName>. Verified against the real ' +
        'Microsoft.Dynamics.AX.Metadata.dll type names: AxMenuElementMenuItem, AxMenuElementSubMenu, ' +
        'AxMenuElementSeparator, AxMenuElementTile, AxMenuElementMenuReference (a different, legacy concept — not the one you want for a plain submenu).',
      '❌ There is no tool operation to add a submenu automatically: add-menu-item-to-menu\'s menuItemToAddType only accepts "display"/"action"/"output" (menu ITEMS). To nest a submenu you must hand-author the <AxMenuElementSubMenu> element into the parent menu\'s XML (d365fo_file create/modify with overwrite) — this is a genuine, current tool gap, not a workaround to avoid.',
      'A submenu is itself just a normal AxMenu object (create it with d365fo_file(action="create", objectType="menu")) — build its own items first, THEN add the AxMenuElementSubMenu reference to it from the parent menu.',
      'This applies both to brand-new standalone menus AND to menu-extensions (AxMenuExtension) nesting into a standard menu (e.g. under "Inquiries and reports") — neither path has a dedicated add-submenu tool operation.',
      'Always verify with build_d365fo_project after hand-authoring: a wrong element type name (e.g. the plausible-looking but nonexistent "AxMenuElementMenu"/"MenuName") is NOT caught by xppc itself — it only surfaces when the separate GenerateMetadata runtime-metadata step tries to deserialize the file ("cannot be deserialized as AxMenu ... no knowledge of any type that maps to this name").',
    ],
    examples: [
      {
        label: 'Parent menu with two items and one nested submenu',
        code: `<AxMenu xmlns:i="http://www.w3.org/2001/XMLSchema-instance" xmlns="Microsoft.Dynamics.AX.Metadata.V1">
  <Name>MyModule</Name>
  <Label>@MyModel:MyModule</Label>
  <Elements>
    <AxMenuElement xmlns="" i:type="AxMenuElementMenuItem">
      <Name>MyEquipment</Name>
      <MenuItemName>MyEquipment</MenuItemName>
    </AxMenuElement>
    <AxMenuElement xmlns="" i:type="AxMenuElementMenuItem">
      <Name>MyAgreement</Name>
      <MenuItemName>MyAgreement</MenuItemName>
    </AxMenuElement>
    <!-- Nested submenu: MySetup is itself a separate AxMenu object -->
    <AxMenuElement xmlns="" i:type="AxMenuElementSubMenu">
      <Name>MySetup</Name>
      <SubMenu>MySetup</SubMenu>
    </AxMenuElement>
  </Elements>
</AxMenu>`,
      },
    ],
    related: ['security', 'form-patterns'],
  },

  // ── Custom Services & OData Actions ─────────────────────────────────────
  {
    id: 'custom-services',
    title: 'Custom Services & OData Actions (Service Classes, Service Groups)',
    keywords: ['custom service', 'service', 'service group', 'odata action', 'sysentrypointattribute', 'sysentrypoint', 'axservice', 'axservicegroup', 'api services', 'service operation', 'json endpoint', 'integration endpoint', 'bound action', 'unbound action'],
    summary:
      'Custom services expose X++ business logic as callable REST/SOAP operations. A service class holds the ' +
      'operation methods, an AxService names them, and an AxServiceGroup publishes them at /api/services. ' +
      'OData actions are the entity-bound alternative for verbs that do not fit CRUD.',
    rules: [
      'Service class: a normal X++ class whose PUBLIC methods become operations; each parameter/return type is a [DataContract] class or a primitive',
      'Authorization: do NOT put [SysEntryPointAttribute] on custom service operations — it is deprecated in AX7/D365FO and xppc emits "\'SysEntryPointAttribute\' is obsolete: This attribute is deprecated in AX7." for it (a BP warning that fails a clean build). Modern JSON/SOAP service endpoints enforce access rights without it, so OMIT it. (It IS still the correct pattern for SysOperation framework entry points — this exception applies only to custom services.)',
      'AxService object: <Name>, <Class> (the service class), <ExternalName>, and <ServiceOperations> holding one <AxServiceOperation> per exposed method — each with <Name> (the external operation name) and <Method> (the X++ method). NOT a flat <Operations> list of names',
      'AxServiceGroup object: groups one or more services via <Services><AxServiceGroupService><Name>+<Service>; its name is the URL segment — endpoint is /api/services/<ServiceGroup>/<Service>/<Operation>. Set <AutoDeploy>Yes</AutoDeploy> to publish it without a manual deployment step',
      'Create both through d365fo_file(action="create", objectType="service" | "service-group") — do not hand-write the XML',
      'Data contract parameters: use [DataContractAttribute] classes with [DataMemberAttribute] parm methods — same contract style as SysOperation',
      'OData actions (entity-bound verbs): add a public static method on the data entity decorated with [SysODataActionAttribute("ActionName", true)]; first parameter type controls bound (entity) vs unbound (collection) — call at /data/Entities/Microsoft.Dynamics.DataEntities.ActionName',
      'Return a strongly-typed contract or a container — never raw text; keep operations idempotent where possible',
      'NEVER put long-running work in a synchronous service operation — schedule a SysOperation batch and return a job reference',
      'Custom services run under the caller\'s security context — enforce access with security privileges/duties granted on the service group, not with hand-rolled checks or the deprecated SysEntryPointAttribute',
    ],
    examples: [
      {
        label: 'Service class + operation (no SysEntryPointAttribute — deprecated for custom services)',
        code: `// 1. Data contract for the request payload
[DataContractAttribute]
class MyPriceRequestContract
{
    ItemId itemId;

    [DataMemberAttribute('ItemId')]
    public ItemId parmItemId(ItemId _itemId = itemId)
    {
        itemId = _itemId;
        return itemId;
    }
}

// 2. Service class — the operation method
class MyPriceService
{
    /// <summary>
    /// Returns the current sales price for an item.
    /// </summary>
    // No [SysEntryPointAttribute] — deprecated in AX7; custom service endpoints
    // enforce access rights without it (adding it only raises a BP warning).
    public MyPriceResponseContract getPrice(MyPriceRequestContract _request)
    {
        MyPriceResponseContract response = new MyPriceResponseContract();
        response.parmPrice(MyPriceProvider::salesPrice(_request.parmItemId()));
        return response;
    }
}

// 3. AxService lists getPrice; AxServiceGroup publishes it at
//    /api/services/<Group>/MyPriceService/getPrice
//    d365fo_file(action="create", objectType="service", objectName="MyPriceService",
//                properties={serviceClass:"MyPriceService", operations:["getPrice"]})
//    d365fo_file(action="create", objectType="service-group", objectName="MyPriceServices",
//                properties={autoDeploy:true, services:["MyPriceService"]})`,
      },
      {
        label: 'OData action bound to a data entity',
        code: `// Public static method on the entity, callable via /data
[SysODataActionAttribute('Recalculate', true)]
public static str recalculate(str _entityKey)
{
    // ... custom verb that does not map to insert/update/delete
    return 'OK';
}`,
      },
    ],
    related: ['data-entities', 'sysoperation', 'security-privileges-duties'],
  },

  // ── Table Inheritance ───────────────────────────────────────────────────
  {
    id: 'table-inheritance',
    title: 'Table Inheritance (SupportInheritance, Extends, InstanceRelationType)',
    keywords: ['table inheritance', 'supportinheritance', 'table extends', 'instancerelationtype', 'derived table', 'base table', 'polymorphic table', 'discriminator', 'relationtype'],
    summary:
      'Table inheritance lets a base table share fields with derived tables while each row has a concrete type ' +
      '(like class inheritance for data). Microsoft uses it for e.g. the business-events endpoint hierarchy. ' +
      'It is a design-time table feature, NOT a runtime cast.',
    rules: [
      'Base table: set SupportInheritance = Yes and choose an InstanceRelationType field (the discriminator that stores which derived table each row belongs to)',
      'Derived table: set Extends = <BaseTable>; it inherits all base fields and adds its own',
      'The InstanceRelationType field on the base holds the tableId of the concrete (leaf) table for each record — the kernel uses it for polymorphic selects',
      'A select on the base table returns rows of ALL derived types; use the .isFormDataSource()/instanceof-style checks or select the specific derived buffer to narrow',
      'Common fields live ONCE on the base — do not duplicate them on derived tables',
      'You cannot change SupportInheritance or Extends on a shipped table via extension — inheritance is fixed at base-table design time',
      'Prefer inheritance only for genuine is-a hierarchies with shared behavior/fields; for optional add-on data a related table + relation is simpler',
      'Abstract base: mark the base table Abstract = Yes when it should never hold rows of its own type',
    ],
    examples: [
      {
        label: 'Base + derived table shape (metadata summary)',
        code: `// Base table MyPartyBase:
//   SupportInheritance = Yes
//   InstanceRelationType = <MyPartyBase discriminator field>
//   Abstract = Yes
//   Fields: PartyId, Name

// Derived table MyPerson:
//   Extends = MyPartyBase
//   Fields: FirstName, LastName   (PartyId/Name inherited)

// Derived table MyOrganization:
//   Extends = MyPartyBase
//   Fields: OrgNumber             (PartyId/Name inherited)

// Polymorphic select — returns Person AND Organization rows:
MyPartyBase party;
while select party
{
    if (party is MyPerson)
    {
        MyPerson person = party;   // narrow to the leaf type
        info(person.FirstName);
    }
}`,
      },
    ],
    related: ['data-entities', 'query-patterns'],
  },

  // ── Async & Retryable Batch ─────────────────────────────────────────────
  {
    id: 'async-retryable-batch',
    title: 'Async & Retryable Batch (BatchRetryable, runAsync, SysOperationSandbox)',
    keywords: ['batchretryable', 'isretryable', 'runasync', 'sysoperationsandbox', 'retryable', 'async batch', 'transient fault', 'batch retry', 'reliable async'],
    summary:
      'Batch tasks can opt into automatic retry on transient faults and run work asynchronously off the caller ' +
      'thread. Retryable tasks must be idempotent because the framework may re-run them.',
    rules: [
      'Retryable task: implement the BatchRetryable interface on your batch/SysOperation service class and return true from isRetryable() so the batch engine retries on transient faults (deadlock, SQL timeout)',
      'RetryCount / retry policy: the batch framework decides how many times to re-run — your isRetryable() only opts in; make the task IDEMPOTENT (safe to run twice)',
      'runAsync: use SysOperationSandbox / the async execution mode to run a unit of work off the current session thread when you must not block the caller (e.g. from a form)',
      'SysOperationSandbox runs a static method reliably in the background and surfaces infolog back to the user session — verify the exact entry-point method with get_object_info before relying on it',
      'Do NOT hold open transactions across an async boundary — start ttsbegin/ttscommit inside the async unit, not around it',
      'A retryable task must not accumulate side effects on partial failure — either make each run fully idempotent or guard with a completed-marker record',
      'For genuine parallelism (partitioning a large workload into independent tasks) combine this with the parallel-batch bundling pattern',
      'Never swallow the transient exception yourself if you opted into retry — let it propagate so the engine can re-run the task',
    ],
    examples: [
      {
        label: 'Retryable SysOperation service',
        code: `class MyReconciliationService extends SysOperationServiceBase implements BatchRetryable
{
    /// <summary>
    /// Opt into automatic retry on transient faults. Must be idempotent.
    /// </summary>
    public boolean isRetryable()
    {
        return true;
    }

    public void run(MyReconciliationContract _contract)
    {
        ttsbegin;
        // idempotent work — safe if the engine re-runs after a transient fault
        this.reconcile(_contract.parmFromDate());
        ttscommit;
    }
}`,
      },
      {
        label: 'Schedule background work off the caller thread',
        code: `// Run a SysOperation service in the background (ScheduledBatch) so the
// caller (e.g. a form button) is not blocked while the work runs.
MyReconciliationController controller = new MyReconciliationController();
controller.parmExecutionMode(SysOperationExecutionMode::ScheduledBatch);
controller.startOperation();`,
      },
    ],
    related: ['sysoperation', 'parallel-batch', 'transactions'],
  },

  // ── Optimistic Concurrency & Unit of Work ───────────────────────────────
  {
    id: 'occ-unitofwork',
    title: 'Optimistic Concurrency & UnitOfWork (OccEnabled, RecVersion, UpdateConflict)',
    keywords: ['occ', 'optimistic concurrency', 'occenabled', 'recversion', 'updateconflict', 'updateconflictnotrecovered', 'unitofwork', 'pessimisticlock', 'optimisticlock', 'selectforupdate', 'concurrency', 'reread'],
    summary:
      'Optimistic Concurrency Control (OCC) lets multiple sessions read the same record without locking and ' +
      'detects conflicts at write time via the RecVersion column. UnitOfWork batches related inserts/updates/' +
      'deletes into one coordinated, referential-integrity-aware commit.',
    rules: [
      'OCC is controlled by the table property OccEnabled (default Yes). With OCC on, a select does NOT hold an update lock; the lock is taken only at update time',
      'RecVersion: a hidden column the kernel bumps on every update; if it changed between your select and update, the kernel throws Exception::UpdateConflict',
      'forupdate + optimisticlock: default modern pattern — select forupdate optimisticlock, then update; re-read (reread()) inside the catch on UpdateConflict',
      'pessimisticlock: takes the lock at select time (blocks other writers) — use only for genuine hotspots where retry churn is worse than blocking',
      'UpdateConflict handling: catch (Exception::UpdateConflict) → reread() the record, re-apply your change, retry; if retries are exhausted the kernel throws UpdateConflictNotRecovered',
      'NEVER disable OccEnabled to \"avoid\" conflicts — it serialises writers and hurts throughput; fix the retry logic instead',
      'UnitOfWork: use new UnitOfWork(); register buffers with insertOnSaveChanges/updateOnSaveChanges/deleteOnSaveChanges, then saveChanges() commits them in dependency order within one transaction',
      'UnitOfWork resolves foreign-key order for you (parent inserted before child) — prefer it over hand-ordered inserts across related tables',
      'Do the whole read-modify-write of an OCC record inside one ttsbegin/ttscommit; keep the transaction short to shrink the conflict window',
    ],
    examples: [
      {
        label: 'OCC update with UpdateConflict retry',
        code: `#OCCRetryCount
CustTable custTable;

try
{
    ttsbegin;
    select forupdate optimisticlock custTable
        where custTable.AccountNum == _accountNum;

    custTable.CreditMax += 1000;
    custTable.update();
    ttscommit;
}
catch (Exception::UpdateConflict)
{
    if (appl.ttsLevel() == 0)
    {
        if (xSession::currentRetryCount() >= #RetryNum)
        {
            throw Exception::UpdateConflictNotRecovered;
        }
        else
        {
            retry;   // kernel re-reads and re-runs the tts block
        }
    }
    else
    {
        throw Exception::UpdateConflict;
    }
}`,
      },
      {
        label: 'UnitOfWork for related inserts',
        code: `UnitOfWork uow = new UnitOfWork();

MyHeader header = new MyHeader();
header.OrderId = 'ORD-001';

MyLine line = new MyLine();
line.ItemId = 'A-001';

// header inserted before line — UnitOfWork orders by relation
uow.insertOnSaveChanges(header);
uow.insertOnSaveChanges(line);
uow.saveChanges();`,
      },
    ],
    related: ['transactions', 'set-based', 'error-handling'],
  },

  // ── Caching (deep) ──────────────────────────────────────────────────────
  {
    id: 'caching',
    title: 'Caching — CacheLookup, SysGlobalObjectCache, RecordViewCache',
    keywords: ['cache', 'cachelookup', 'found', 'foundandempty', 'entiretable', 'notintts', 'sysglobalobjectcache', 'recordviewcache', 'flush', 'record cache', 'global cache', 'display method cache'],
    summary:
      'D365FO has several caching layers. Table record caching (CacheLookup) is automatic and keyed by the ' +
      'primary/unique index; SysGlobalObjectCache is an explicit server-side key/value cache; RecordViewCache ' +
      'pre-loads a record set for repeated in-memory reads.',
    rules: [
      'CacheLookup table property values: None, NotInTTS, Found, FoundAndEmpty, EntireTable',
      'Found: caches records that were found by a unique-index lookup (most common for master/reference tables)',
      'FoundAndEmpty: like Found but ALSO caches \"not found\" results — use when many lookups miss (avoids repeat round-trips), at the cost of remembering absences',
      'EntireTable: loads the whole table into a per-AOS cache — ONLY for small, rarely-changing reference tables; a single insert/update/delete FLUSHES the entire-table cache cluster-wide',
      'NotInTTS: re-reads from DB (not cache) inside a transaction to guarantee a fresh row before update — cache is bypassed within ttsbegin/ttscommit',
      'Record caching only works for selects on the WHOLE primary/unique index (all key fields with ==) — a partial-key or range select bypasses the cache',
      'SysGlobalObjectCache (kernel class): explicit cross-session server cache — set(owner, key, value, scope) / find(owner, key, value, scope); scope controls DataArea vs Global; call clear/remove to invalidate. Use for expensive computed/config values, never for volatile transactional data',
      'RecordViewCache (kernel class): construct with a select-forupdate buffer to pre-load a set of records into memory once, then repeated while-select/find on the same criteria read from memory — ideal for tight loops re-reading the same working set',
      'Display/edit method caching: mark expensive display methods with [SysClientCacheDataMethodAttribute(true)] so the client caches the value instead of round-tripping per repaint',
      'NEVER cache security-sensitive or per-user data in SysGlobalObjectCache with a Global scope — leaks across companies/users',
    ],
    examples: [
      {
        label: 'SysGlobalObjectCache read-through',
        code: `SysGlobalObjectCache goc = classfactory.globalObjectCache();
container   result = goc.find('MyModule', [_configKey]);

if (!result)
{
    // Miss — compute the expensive value once and cache it
    MyValue value = MyExpensiveCalc::run(_configKey);
    result = [value];
    goc.insert('MyModule', [_configKey], result);
}

MyValue cached = conPeek(result, 1);`,
      },
      {
        label: 'RecordViewCache for a repeated working set',
        code: `InventDim inventDim;
inventDim.InventLocationId = _warehouse;

// Pre-load all matching InventDim rows once into memory
RecordViewCache cache = new RecordViewCache(inventDim);

// Subsequent finds on the same criteria read from the cache, not SQL
InventDim lookup;
select firstonly lookup
    where lookup.InventLocationId == _warehouse
       && lookup.InventSiteId     == _site;`,
      },
    ],
    related: ['performance', 'set-based', 'transactions'],
  },

  // ── X++ collections & containers ────────────────────────────────────────
  {
    id: 'xpp-collections',
    title: 'X++ Collections & Containers (List, Map, Set, Struct, container)',
    keywords: ['list', 'map', 'set', 'struct', 'container', 'collection', 'enumerator', 'iterator', 'conpeek', 'conins', 'condel', 'conlen', 'confind', 'array', 'types enum', 'pack', 'unpack'],
    summary:
      'X++ has two families of in-memory collections: the kernel collection classes (List, Map, Set, Struct, Array), ' +
      'which are reference types with enumerators, and the primitive `container`, a value type used for packing, ' +
      'cross-tier marshalling and table fields. Choosing the wrong one is a classic performance bug: containers are ' +
      'copied on every assignment and grow O(n²) when appended in a loop.',
    rules: [
      'Element types are declared at construction with the kernel `Types` enum: new List(Types::String), new Map(Types::Int64, Types::Class), new Set(Types::Integer)',
      'List — ordered, duplicates allowed: addEnd()/addStart(), elements(), getEnumerator(). Iterate with a ListEnumerator: while (enumerator.moveNext()) { … enumerator.current() }',
      'Map — key/value: insert(key, value), exists(key), lookup(key) (THROWS if the key is absent — guard with exists() or use MapEnumerator), remove(key), elements()',
      'Set — unordered unique values: add(), in(), remove(), elements(); use it for de-duplication and membership tests instead of scanning a List',
      'Struct — a named-field record: new Struct(), add(name, value), value(name), exists(name). Prefer a real class or table buffer when the shape is fixed and known at compile time',
      'container — value semantics: assignment COPIES. Building one with `con += [x]` inside a loop reallocates every iteration; accumulate in a List and convert once at the end',
      'container accessors are 1-based intrinsics: conLen(), conPeek(c, i), conIns(), conDel(), conFind(), conNull(). They are not methods and do not mutate — they return a new container',
      'Cross-tier / persistence: only container (and the pack()/unpack() pattern built on it) can cross the client/server boundary or be stored in a table field. List, Map and Set implement pack()/unpack() so they can be marshalled through a container',
      'SysOperation data contracts must expose primitives or a container — never a raw List/Map property; serialize with pack()/unpack() (or List::create(packedContainer)) instead',
      'List::create(container) / Map::create(container) / list.pack() are the supported round-trip helpers; do not hand-roll a conPeek loop over a packed collection',
      'Array (kernel class) is a dynamic 1-based array of one type; the fixed-size X++ array declaration (`int values[10]`) is a different, compile-time construct',
      'An enumerator is invalidated by mutating the collection it iterates — collect the changes and apply them after the loop',
      'None of these collections are thread-safe and none survive a session; they are per-call in-memory structures only',
    ],
    examples: [
      {
        label: 'List + enumerator, and the container anti-pattern',
        code: `// GOOD — accumulate in a List, convert once
List accountNums = new List(Types::String);

CustTable custTable;
while select AccountNum from custTable
{
    accountNums.addEnd(custTable.AccountNum);
}

ListEnumerator enumerator = accountNums.getEnumerator();
while (enumerator.moveNext())
{
    CustAccount accountNum = enumerator.current();
    info(accountNum);
}

// One conversion at the end when a container is genuinely needed
container packed = accountNums.pack();

// BAD — \`result += [value]\` inside a loop copies the whole container
// every iteration (O(n²) allocations on a large result set).`,
      },
      {
        label: 'Map with an exists() guard, and Set for de-duplication',
        code: `Map balanceByAccount = new Map(Types::String, Types::Real);
Set  seenAccounts     = new Set(Types::String);

CustTrans custTrans;
while select AccountNum, AmountCur from custTrans
{
    if (!seenAccounts.in(custTrans.AccountNum))
    {
        seenAccounts.add(custTrans.AccountNum);
    }

    // lookup() throws on a missing key — always guard with exists()
    if (balanceByAccount.exists(custTrans.AccountNum))
    {
        balanceByAccount.insert(
            custTrans.AccountNum,
            balanceByAccount.lookup(custTrans.AccountNum) + custTrans.AmountCur);
    }
    else
    {
        balanceByAccount.insert(custTrans.AccountNum, custTrans.AmountCur);
    }
}

MapEnumerator mapEnumerator = balanceByAccount.getEnumerator();
while (mapEnumerator.moveNext())
{
    info(strFmt('%1: %2', mapEnumerator.currentKey(), mapEnumerator.currentValue()));
}`,
      },
    ],
    related: ['performance', 'sysoperation', 'select-statement'],
  },

  // ── Date/time & time zones ──────────────────────────────────────────────
  {
    id: 'datetime-timezones',
    title: 'Date/Time & Time Zones (utcdatetime, DateTimeUtil, session date)',
    keywords: ['date', 'datetime', 'utcdatetime', 'datetimeutil', 'timezone', 'time zone', 'utcnow', 'today', 'systemdateget', 'timezone conversion', 'validtimestate', 'date effectivity', 'str2date', 'datetime2str'],
    summary:
      'D365FO stores every utcdatetime in UTC and converts to a time zone only for display or user input. ' +
      'The whole surface lives on the kernel class DateTimeUtil — mixing it with the legacy date functions ' +
      '(today(), timeNow()) is the source of most off-by-one-day and off-by-hours bugs.',
    rules: [
      'Table fields of type UtcDateTime always hold UTC. Never store a value you converted to a user/company time zone — convert only at the edge (form display, report, file export)',
      'DateTimeUtil::utcNow() is the current UTC instant — the right default for stamping created/modified data',
      'DateTimeUtil::getSystemDateTime() honours the session date/time override (a user can set a session date); utcNow() does not. Use the session-aware one for BUSINESS decisions, utcNow() for audit stamps',
      'For a business DATE prefer DateTimeUtil::getSystemDate(DateTimeUtil::getUserPreferredTimeZone()) — xppbp raises BPUpgradeCodeSystemDate on the older session-aware systemDateGet(), which still compiles but is deprecated (confirmed by a real BP run in the L2-datetime-timezone-range case)',
      'NEVER use today(): it reads the AOS server clock, ignores both the session date and the user time zone, and is a BP error',
      'Convert for display with DateTimeUtil::applyTimeZoneOffset(utcValue, timeZone) and back with DateTimeUtil::removeTimeZoneOffset(localValue, timeZone) — applyTimeZoneOffset is UTC → local, removeTimeZoneOffset is local → UTC',
      'The time zone comes from DateTimeUtil::getUserPreferredTimeZone() (the Timezone kernel enum), or DateTimeUtil::getCompanyTimeZone() for company-scoped output. Do not hardcode Timezone::GMTCOORDINATEDUNIVERSALTIME',
      'Build a utcdatetime from parts with DateTimeUtil::newDateTime(date, timeOfDay, timeZone); split it with DateTimeUtil::date() and DateTimeUtil::time()',
      'Arithmetic: DateTimeUtil::addDays/addHours/addMinutes/addSeconds and ::addMonths/::addYears — never add raw seconds by casting to int64',
      'Sentinels: DateTimeUtil::minValue() and DateTimeUtil::maxValue() (not 0 / dateNull()). Date-effective (ValidTimeState) tables use maxValue() as "no end date"',
      'Persist / interchange with DateTimeUtil::toStr() (ISO 8601, culture-invariant) and DateTimeUtil::parse(); datetime2Str()/str2Datetime() are LOCALE-dependent and belong to the UI only',
      'Compare utcdatetime values directly (they are all UTC) — converting both sides to local first is redundant and breaks across DST boundaries',
      'When a query range needs a whole local day, convert the local day boundaries to UTC once and range on the UTC values; do not range on a converted column',
    ],
    examples: [
      {
        label: 'UTC storage, local display, and a correct day range',
        code: `Timezone userTimeZone = DateTimeUtil::getUserPreferredTimeZone();

// Stamp in UTC — never a converted value
MyRequestTable request;
request.SubmittedDateTime = DateTimeUtil::utcNow();

// Display: convert at the edge only
utcdatetime displayValue = DateTimeUtil::applyTimeZoneOffset(
    request.SubmittedDateTime, userTimeZone);

// A whole LOCAL day expressed as a UTC range
date       businessDate = DateTimeUtil::getSystemDate(userTimeZone); // systemDateGet() -> BPUpgradeCodeSystemDate
utcdatetime dayStartUtc  = DateTimeUtil::removeTimeZoneOffset(
    DateTimeUtil::newDateTime(businessDate, 0), userTimeZone);
utcdatetime dayEndUtc    = DateTimeUtil::addSeconds(
    DateTimeUtil::removeTimeZoneOffset(
        DateTimeUtil::newDateTime(businessDate + 1, 0), userTimeZone), -1);

MyRequestTable found;
while select found
    where found.SubmittedDateTime >= dayStartUtc
       && found.SubmittedDateTime <= dayEndUtc
{
    info(DateTimeUtil::toStr(found.SubmittedDateTime));
}`,
      },
      {
        label: 'Date-effective sentinel and culture-invariant round-trip',
        code: `// "No end date" on a ValidTimeState table is maxValue(), not an empty value
MyEffectiveTable effective;
effective.ValidFrom = DateTimeUtil::utcNow();
effective.ValidTo   = DateTimeUtil::maxValue();

// Interchange: ISO 8601, culture-invariant both ways
str        serialized   = DateTimeUtil::toStr(effective.ValidFrom);
utcdatetime deserialized = DateTimeUtil::parse(serialized);

if (deserialized == effective.ValidFrom)
{
    info(serialized);
}`,
      },
    ],
    related: ['deprecated', 'bp-rules', 'select-statement'],
  },

  // ── .NET interop ────────────────────────────────────────────────────────
  {
    id: 'dotnet-interop',
    title: '.NET Interop (CLR types, using alias, CLRError, InteropPermission)',
    keywords: ['clr', 'clrinterop', 'net interop', 'dotnet', 'using', 'system.string', 'stringbuilder', 'clrerror', 'getlastexception', 'interoppermission', 'marshalling', 'clr exception', 'assembly reference'],
    summary:
      'X++ can call .NET types directly. The three things that go wrong are: the call runs on the wrong tier, ' +
      'the CLR exception is swallowed because it is caught as a plain error, and the type is written out ' +
      'fully qualified everywhere because no `using` alias was declared.',
    rules: [
      'Declare `using System.Text;` above the class declaration to shorten names; without it every CLR type must be fully qualified (System.Text.StringBuilder)',
      'CLR calls must execute where the assembly is deployed — put them in a `server` static method (or a class with RunOn = Server). A client-tier CLR call against a server-only assembly fails at runtime, not at compile time',
      'Assert interop permission before calling out: new InteropPermission(InteropKind::ClrInterop).assert(); — required for CAS-protected interop, and it documents the boundary',
      'Catch CLR failures with `catch (Exception::CLRError)` and pull the real message from CLRInterop::getLastException() — a bare `catch (Exception::Error)` will NOT catch a CLR exception and the diagnostic is lost',
      'Marshalling: X++ str ↔ System.String and X++ real/int ↔ the matching CLR primitives convert implicitly; anytype needs CLRInterop::getAnyTypeForObject() / CLRInterop::getObjectForAnyType()',
      'CLR enums are reached by value with CLRInterop::parseClrEnum(\'System.StringComparison\', \'OrdinalIgnoreCase\') — an X++ enum literal will not bind to a CLR enum parameter',
      'A CLR array is a System.Array — index it with get_Item()/set_Item(), not with X++ [] syntax; property getters/setters are get_X()/set_X()',
      'null checks use `if (clrObject == null)`; do NOT compare a CLR object with an X++ empty value',
      'Dispose deterministic resources explicitly (streams, readers) in a finally block — X++ has no `using` STATEMENT, only the using DECLARATION for namespaces',
      'Reference the assembly from the model (References node) so the compiler resolves it; a runtime-only GAC assembly compiles but breaks on a clean build machine',
      'Prefer an X++ equivalent when one exists (strFmt, Set/Map, System.IO only when the X++ file APIs cannot do it) — interop costs marshalling and blocks the compiler from checking anything',
    ],
    examples: [
      {
        label: 'Server-tier CLR call with proper CLRError handling',
        code: `using System.Text;

public static server str buildCsvLine(container _values)
{
    str result;

    new InteropPermission(InteropKind::ClrInterop).assert();

    try
    {
        StringBuilder builder = new StringBuilder();
        int           i;

        for (i = 1; i <= conLen(_values); i++)
        {
            if (i > 1)
            {
                builder.Append(',');
            }

            builder.Append(any2Str(conPeek(_values, i)));
        }

        result = builder.ToString();
    }
    catch (Exception::CLRError)
    {
        // Without this branch the real .NET message is lost
        System.Exception clrException = CLRInterop::getLastException();
        error(clrException.get_Message());
    }
    finally
    {
        CodeAccessPermission::revertAssert();
    }

    return result;
}`,
      },
    ],
    related: ['file-readers', 'error-handling', 'bp-rules'],
  },

  // ── Reflection / Dict* metadata API ─────────────────────────────────────
  {
    id: 'reflection-dict',
    title: 'Reflection — Dict* runtime metadata API (DictTable, DictField, DictClass, DictEnum)',
    keywords: ['reflection', 'dicttable', 'dictfield', 'dictclass', 'dictenum', 'dictmethod', 'sysdicttable', 'sysdictclass', 'metadata api', 'tablenum', 'fieldnum', 'classnum', 'dynamic call', 'fieldid2name', 'tableid2name'],
    summary:
      'The Dict* kernel classes expose the AOT at runtime: enumerate a table\'s fields, resolve labels, ' +
      'instantiate a class by id, translate an enum value to its label. Use them for genuinely generic code — ' +
      'never as a substitute for the compile-time intrinsics, which the compiler and the cross-reference can check.',
    rules: [
      'Always seed the Dict* object from an intrinsic, not a string: new DictTable(tableNum(CustTable)), new DictField(tableNum(CustTable), fieldNum(CustTable, AccountNum)), new DictClass(classNum(MyClass)), new DictEnum(enumNum(NoYes))',
      'DictTable: name(), label(), fieldCnt(), fieldCnt2Id(i) → field id, fieldObject(fieldId) → DictField, makeRecord() → an empty buffer of that table',
      'DictField: name(), label(), baseType() (Types enum), enumId(), typeId() — the way to render a generic field/value pair with the right label',
      'DictClass: name(), callObject(methodName, object) / callStatic(methodName, …) for dynamic dispatch, hasStaticMethod(), makeObject()',
      'DictEnum: value2Label(value), value2Symbol(value), symbol2Value(symbol), values() — the correct way to display an enum whose type is only known at runtime',
      'SysDictTable / SysDictField / SysDictClass are the APPLICATION-layer wrappers over the kernel classes; they add security-aware and convenience helpers (SysDictTable::recordCount(), getLabelOrName(), fieldsRecursive()) — reach for them when the kernel class lacks a helper',
      'fieldId2Name()/fieldName2Id()/tableId2Name()/tableName2Id() are the lightweight lookups when only a name↔id translation is needed — no Dict* object required',
      'Reflection defeats the cross-reference: a table or method reached only through a Dict* call is invisible to "find references" and survives a rename as a runtime error. Keep the reflective surface small and covered by tests',
      'Reflective loops over every field are expensive per call — resolve metadata ONCE outside the record loop, never per row',
      'Dict* reads metadata only. It cannot create or modify AOT elements at runtime; design-time metadata authoring is the Microsoft.Dynamics.AX.Metadata API, not X++',
      'A dynamic call whose target does not exist throws at runtime — guard with hasStaticMethod()/hasObjectMethod() before callStatic()/callObject()',
    ],
    examples: [
      {
        label: 'Generic field walk with labels resolved once',
        code: `public static void dumpRecord(Common _record)
{
    DictTable dictTable = new DictTable(_record.TableId);
    int       i;

    for (i = 1; i <= dictTable.fieldCnt(); i++)
    {
        FieldId    fieldId   = dictTable.fieldCnt2Id(i);
        DictField  dictField = dictTable.fieldObject(fieldId);

        if (dictField.isSystem())
        {
            continue;
        }

        info(strFmt('%1: %2', dictField.label(), _record.(fieldId)));
    }
}`,
      },
      {
        label: 'Runtime enum label + guarded dynamic call',
        code: `// Enum whose type is only known at runtime
public static str enumLabel(EnumId _enumId, int _value)
{
    DictEnum dictEnum = new DictEnum(_enumId);

    return dictEnum.value2Label(_value);
}

// Dynamic dispatch — guarded, so a missing method is a handled case
public static void runIfPresent(ClassId _classId, str _methodName)
{
    DictClass dictClass = new DictClass(_classId);

    if (dictClass.hasStaticMethod(_methodName))
    {
        dictClass.callStatic(_methodName);
    }
}`,
      },
    ],
    related: ['xpp-class-rules', 'performance', 'labels'],
  },

  // ── Tiles & KPIs ────────────────────────────────────────────────────────
  {
    id: 'tiles-kpis',
    title: 'Tiles, Cues & KPIs (AxTile, AxKPI, workspace tiles)',
    keywords: ['tile', 'cue', 'kpi', 'workspace tile', 'count tile', 'tile size', 'refreshfrequency', 'scoringpattern', 'aggregate measurement', 'cue group', 'tile button'],
    summary:
      'A Tile is an AOT element that renders a count (or a static link) on a workspace, driven by an AOT query ' +
      'and opening a menu item when clicked. A KPI is the analytical sibling: it scores a measure from an ' +
      'aggregate measurement against a goal. Both are metadata-only elements — no X++ is required.',
    rules: [
      'AxTile properties that matter: Name, Label, Query (the AOT query whose row count is displayed), MenuItemName (what opens on click) and Size (Small / Medium / Wide / Large)',
      'A tile without a Query is a link tile — it just navigates; with a Query it becomes a Cue and shows a live count',
      'The tile\'s query is executed per user per refresh: keep it narrow (indexed ranges, firstonly-friendly) or the workspace becomes the slowest page in the app',
      'Range the query on the CURRENT user/company where that is the intent — a tile query without a user range shows a count nobody can act on',
      'Surface a tile on a workspace form through a tile/cue-group control that references the tile by name; the tile element itself carries no layout',
      'AxKPI properties: Measurement (the aggregate measurement), Value (Measure + MeasureGroup), Goal, ScoringPattern (LessIsBetter / MoreIsBetter / CloserIsBetter), RefreshFrequency and ShowStatus',
      'A KPI therefore REQUIRES an aggregate measurement deployed to the entity store — a KPI over a plain table is not possible',
      'Labels are mandatory on both (they are user-facing surfaces): use a label id, never a hardcoded string',
      'Extension story: tiles and KPIs are added by creating NEW elements plus a form extension that places them — an existing Microsoft tile\'s query cannot be redefined in place',
      'Both are deprioritised in most custom work: a saved view or an embedded Power BI report usually delivers the same insight without the entity-store dependency',
    ],
    examples: [
      {
        label: 'Count tile (Cue) metadata shape',
        code: `<?xml version="1.0" encoding="utf-8"?>
<AxTile xmlns:i="http://www.w3.org/2001/XMLSchema-instance" xmlns="Microsoft.Dynamics.AX.Metadata.V1">
	<Name>MyOpenRequestsTile</Name>
	<Label>@MyModule:OpenRequests</Label>
	<MenuItemName>MyRequestListPage</MenuItemName>
	<Query>MyOpenRequestsQuery</Query>
	<Size>Wide</Size>
</AxTile>`,
      },
      {
        label: 'KPI over an aggregate measurement',
        code: `<?xml version="1.0" encoding="utf-8"?>
<AxKPI xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
	<Name>MyAvgDaysToCloseKpi</Name>
	<Label>@MyModule:AvgDaysToClose</Label>
	<Measurement>MyRequestMeasure</Measurement>
	<RefreshFrequency>AsFastAsPermissible</RefreshFrequency>
	<ScoringPattern>LessIsBetter</ScoringPattern>
	<ShowStatus>No</ShowStatus>
	<Goal>
		<Value>10</Value>
		<Ranges />
	</Goal>
	<Trends />
	<Value>
		<Measure>AvgDaysToClose</Measure>
		<MeasureGroup>MyRequestMeasureGroup</MeasureGroup>
		<Ranges />
	</Value>
</AxKPI>`,
      },
    ],
    related: ['form-patterns', 'aggregate-measurements', 'query-patterns'],
  },

  // ── Macros ──────────────────────────────────────────────────────────────
  {
    id: 'macros',
    title: 'Macros (macro libraries, #define, #localmacro) — legacy, use sparingly',
    keywords: ['macro', 'macros', 'define', 'localmacro', 'globalmacro', 'macro library', 'macrolib', 'axmacrodictionary', 'preprocessor', 'flight', 'flighting'],
    summary:
      'Macros are a text preprocessor inherited from AX. A macro library is an AOT element (AxMacroDictionary) ' +
      'whose Source is a list of #define/#localmacro declarations, included with `#<LibraryName>`. New code should ' +
      'use const, an enum or a class constant instead — the two places macros still legitimately appear are ' +
      'feature flight names and legacy platform includes.',
    rules: [
      'A macro library is an AOT element under AxMacroDictionary; its entire body is the Source property — there is no per-macro sub-element',
      'Declare with #define.NAME(value) for a constant, #localmacro.NAME … #endmacro for a code fragment; use with #NAME',
      'Include a library at the top of the class/table declaration with the include directive `#<LibraryName>` (e.g. #ApplicationFoundationFlights)',
      'Macros are expanded BEFORE compilation: there is no type check, no IntelliSense, no cross-reference and no debugger step — a wrong macro shows up as an error in the expanded line, not the macro',
      'PREFER instead: `const int MyLimit = 100;` for a value, a base enum for a closed value set, a static class method for a code fragment, a label for user-facing text',
      'Do NOT put business logic in a #localmacro — it is uncoverable by unit tests and invisible to a refactor',
      'Macros are NOT extensible: you cannot extend or override a Microsoft macro library, so anything modelled as a macro is a hard fork point',
      'The remaining mainstream use is flight names (#define.MyFeatureFlight(\'MyFeatureFlight\')) — matching the platform\'s own convention in AxMacroDictionary libraries',
      'Conditional compilation (#if.Never / #endif) exists but should never ship — dead code belongs deleted, not preprocessed away',
    ],
    examples: [
      {
        label: 'Macro library metadata shape (AxMacroDictionary)',
        code: `<?xml version="1.0" encoding="utf-8"?>
<AxMacroDictionary xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
	<Name>MyModuleFlights</Name>
	<Source>#define.MyFastPostingFlight('MyFastPostingFlight')
#define.MyBulkImportFlight('MyBulkImportFlight')
</Source>
</AxMacroDictionary>`,
      },
      {
        label: 'Using a macro vs. the modern replacement',
        code: `// Legacy: include the library, then reference the macro
// (declaration area of the class)
// #MyModuleFlights
//
// if (MyFastPostingFlight::instance().isEnabled()) { … }

// Modern replacement for a plain constant — type-checked, refactorable,
// visible to the cross-reference:
public class MyPostingLimits
{
    public const int MaxLinesPerBatch = 500;
}`,
      },
    ],
    related: ['feature-management', 'bp-rules', 'xpp-class-rules'],
  },

  // ── Aggregate measurements ──────────────────────────────────────────────
  {
    id: 'aggregate-measurements',
    title: 'Aggregate Measurements & Analytics (AxAggregateMeasurement, entity store)',
    keywords: ['aggregate measurement', 'measure group', 'dimension attribute', 'entity store', 'axdw', 'analytics', 'power bi', 'kpi', 'aggregate dimension', 'stagedentitystore', 'measure'],
    summary:
      'An aggregate measurement is the star schema D365FO ships to analytics: measure groups (facts, each bound ' +
      'to a table or entity) plus dimension attributes (the keys you slice by). Deployed to the entity store ' +
      '(AxDW), it is what embedded Power BI reports and KPIs read.',
    rules: [
      'AxAggregateMeasurement carries Name, Usage (StagedEntityStore for entity-store deployment) and one or more MeasureGroups',
      'Each AxMeasureGroup binds to exactly one Table (a real table or, more commonly, a denormalised entity) and lists Measures and Attributes (AxDimensionAttribute → KeyFields → DimensionField)',
      'Measures need an aggregation — the element is <DefaultAggregate> (NOT AggregateFunction, which does not exist and is dropped silently, leaving the measure on Sum) and the legal values are Sum, DistinctCount, AverageOfChildren, Max, Min; a field with no aggregation is a dimension attribute, not a measure',
      'Model the fact source as a data entity or a view, not the raw transaction table: the entity store refresh reads it as-is, so joins done at query time cost every refresh',
      'Shared dimensions live in AxAggregateDimension elements and are referenced by attributes so multiple measure groups slice consistently',
      'Deployment is a runtime operation (Data management → Entity store → Refresh), not part of the build; a measurement that compiles can still be undeployed and therefore invisible to Power BI',
      'Refresh is incremental only when the source entity supports change tracking — enable it on the entity or every refresh is a full reload',
      'A KPI element references the measurement plus a Measure/MeasureGroup pair; the measurement must exist and be deployed before the KPI resolves',
      'Do not model an aggregate measurement for operational reporting — for row-level operational output use an SSRS report or a query; measurements are for aggregated analytics',
      'Extension: measure groups can be added to a Microsoft measurement only by creating your own measurement — there is no aggregate-measurement extension element',
    ],
    examples: [
      {
        label: 'Minimal measurement with one measure group',
        code: `<?xml version="1.0" encoding="utf-8"?>
<AxAggregateMeasurement xmlns:i="http://www.w3.org/2001/XMLSchema-instance" xmlns="Microsoft.Dynamics.AX.Metadata.V2">
	<Name>MyRequestMeasure</Name>
	<Usage>StagedEntityStore</Usage>
	<MeasureGroups>
		<AxMeasureGroup xmlns="">
			<Name>MyRequestMeasureGroup</Name>
			<Table>MyRequestSummaryEntity</Table>
			<Attributes>
				<AxDimensionAttribute>
					<Name>RequestType</Name>
					<NameField>RequestType</NameField>
					<KeyFields>
						<AxDimensionFieldReference>
							<DimensionField>RequestType</DimensionField>
						</AxDimensionFieldReference>
					</KeyFields>
				</AxDimensionAttribute>
			</Attributes>
			<Measures>
				<AxMeasure>
					<Name>AvgDaysToClose</Name>
					<DefaultAggregate>AverageOfChildren</DefaultAggregate>
					<Field>DaysToClose</Field>
				</AxMeasure>
			</Measures>
		</AxMeasureGroup>
	</MeasureGroups>
</AxAggregateMeasurement>`,
      },
    ],
    related: ['tiles-kpis', 'data-entities', 'electronic-reporting'],
  },

  // ── License codes ───────────────────────────────────────────────────────
  {
    id: 'license-codes',
    title: 'License Codes (AxLicenseCode) — ISV licensing',
    keywords: ['license code', 'licensecode', 'isv licensing', 'axlicensecode', 'publickey', 'license package', 'configuration key licensing', 'sysbpcheck license'],
    summary:
      'A license code is the ISV licensing anchor: configuration keys point at it, and the code is enabled by a ' +
      'signed license file. In a customer implementation you almost never author one — it exists so an ISV can ' +
      'gate a whole feature area behind a purchased licence.',
    rules: [
      'AxLicenseCode properties: Name, Label, Group (e.g. Module), Package (the licensing package, e.g. BusinessEssential) and PublicKey (the ISV key slot the licence file is signed against)',
      'A license code has NO effect on its own — it gates functionality only through configuration keys whose LicenseCode property points at it',
      'The chain is: license code → configuration key → AOT element (table/field/menu item/…) with that ConfigurationKey. Disabling the licence disables everything down the chain',
      'Disabling a licence/configuration key drops the underlying tables from the synchronised schema — never gate a table that already holds customer data without a migration plan',
      'Customer (non-ISV) models should use configuration keys or feature management, not license codes — licensing is for shipped, sold code',
      'The PublicKey slot ties the code to the ISV\'s signing key; it is issued as part of the ISV registration, not chosen freely',
      'PublicKey is GLOBALLY UNIQUE — xppc fails the build with "Metadata Error: …/PublicKey: Duplicate value \'N\' detected" if any other installed model already owns the slot; check the existing AxLicenseCode elements before picking one (a standard install occupies 1-11, 13, 14, 18, 19, then sparsely up to 234, plus 603-605, 634, 635, 654, 655)',
      'Licence state is evaluated at sync/runtime, not at build time: code behind a disabled licence still compiles',
      'Feature management (a runtime toggle) is the modern way to ship an optional feature; reach for a license code only when the gate must be a commercial one',
    ],
    examples: [
      {
        label: 'License code + the configuration key that consumes it',
        code: `<?xml version="1.0" encoding="utf-8"?>
<AxLicenseCode xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
	<Name>MyIsvSuite</Name>
	<Group>Module</Group>
	<Label>@MyModule:IsvSuiteLicense</Label>
	<Package>BusinessEssential</Package>
	<!-- PublicKey must be a slot no installed model uses yet - 2 is LogisticsBasic -->
	<PublicKey>700</PublicKey>
</AxLicenseCode>

<!-- The configuration key is what actually gates the elements: -->
<!--
<AxConfigurationKey xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
	<Name>MyIsvSuiteKey</Name>
	<Label>@MyModule:IsvSuiteKey</Label>
	<LicenseCode>MyIsvSuite</LicenseCode>
</AxConfigurationKey>
-->`,
      },
    ],
    related: ['configuration-keys', 'feature-management', 'security'],
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

/**
 * Tokenize a topic query. Splits on whitespace/comma/semicolon/slash, then for
 * every token that itself contains a hyphen or underscore ALSO emits the split
 * sub-words. The original (joined) token is kept so entry-ID matches like
 * `set-based` still hit `entry.id === token`, while hyphenated multi-word
 * queries like `number-sequence` also match word-level keywords/titles (which
 * store the words separated by spaces, e.g. keyword "number sequence").
 */
function tokenize(topic: string): string[] {
  const base = topic
    .toLowerCase()
    .replace(/[^a-z0-9áčďéěíňóřšťúůýž_\-/\s]/g, '')
    .split(/[\s,;/]+/)
    .filter(t => t.length > 1);

  const out = new Set<string>();
  for (const tok of base) {
    out.add(tok);
    if (tok.includes('-') || tok.includes('_')) {
      for (const part of tok.split(/[-_]+/).filter(p => p.length > 1)) {
        out.add(part);
      }
    }
  }
  return [...out];
}

/**
 * Minimum top score for a query to count as a confident match. Below this,
 * only incidental summary-substring overlap landed (no title/keyword/ID hit),
 * so results are surfaced as low-confidence suggestions, not authoritative answers.
 */
const CONFIDENT_SCORE = 3;

function searchKnowledge(topic: string): { entries: KnowledgeEntry[]; topScore: number } {
  const tokens = tokenize(topic);

  if (tokens.length === 0) {
    // Return all entries sorted alphabetically
    return {
      entries: [...KNOWLEDGE_BASE].sort((a, b) => a.title.localeCompare(b.title)),
      topScore: 0,
    };
  }

  const scored = KNOWLEDGE_BASE
    .map(entry => ({ entry, score: scoreEntry(entry, tokens) }))
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score);

  return {
    entries: scored.map(s => s.entry),
    topScore: scored.length > 0 ? scored[0].score : 0,
  };
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
    const { entries, topScore } = searchKnowledge(args.topic);

    // Empty topic → compact table of contents listing ALL entries
    const isListAll = args.topic.trim() === '';
    let formatted: string;
    if (isListAll) {
      formatted =
        '# X++ Knowledge Base — All Topics\n\n' +
        entries.map(e => `- \`${e.id}\`: **${e.title}**`).join('\n') +
        '\n\n_Query a specific topic with \`get_knowledge(kind="knowledge")\` for rules and code examples._';
    } else {
      formatted = args.format === 'detailed'
        ? formatDetailed(entries)
        : formatConcise(entries);

      // Low-confidence guard: when something matched but only weakly (incidental
      // substring overlap, no title/keyword/ID hit), warn so the caller doesn't
      // treat unrelated content as authoritative.
      if (entries.length > 0 && topScore < CONFIDENT_SCORE) {
        formatted =
          `⚠️ No strong match for "${args.topic}" — showing the closest entries below, which may be ` +
          `unrelated. Browse the full list with \`get_knowledge(kind="knowledge")\` and an empty topic, ` +
          `or refine your query.\n\n${formatted}`;
      }
    }

    return {
      content: [{ type: 'text', text: formatted }],
    };
  } catch (error) {
    return {
      content: [{
        type: 'text',
        text: `Error in get_knowledge(kind="knowledge"): ${error instanceof Error ? error.message : 'Unknown error'}`,
      }],
      isError: true,
    };
  }
}
