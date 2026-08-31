/**
 * Probe batch for the v3 coverage work — every claim a knowledge entry or a rule
 * is about to make, put to xppc before it is written.
 *
 * One build answers all of them (a build costs 90-170 s whatever it contains, so
 * batching is free), and the harness adds a negative control that MUST fail: a
 * silent log is a broken run, not a pass.
 *
 * Run:  npm run oracle:probe -- --file scripts/oracles/probes/coverage-v3.ts --json .oracle-probe-v3.json
 *
 * Every probe names the plan item it decides, so a result can be traced to the
 * entry it licensed — and so a probe nobody needs any more can be deleted.
 */
import type { Probe } from '../xppcProbe.js';

const probes: Probe[] = [
  // ── P1 — prmIsDefault: taught in four knowledge rules, present in NEITHER
  // compiler table (80 intrinsics, 170 predefined) nor the Global class.
  {
    id: 'PrmIsDefault',
    question: 'P1/H0.2 — is prmIsDefault callable, and on what? (absent from every captured table)',
    methods: [
      `    public void withDefault(int _a = 5)
    {
        if (prmIsDefault(_a))
        {
            info('default');
        }
    }`,
    ],
    expect: 'compiles',
  },
  {
    id: 'PrmIsDefaultArity',
    question: 'P1 — prmIsDefault arity message shape (drives FN001 if it is a predefined function)',
    body: 'prmIsDefault(1, 1, 1, 1, 1, 1, 1, 1, 1);',
    expect: 'fails',
  },

  // ── P5 — custom query range functions (H1.6).
  {
    id: 'QueryRangeFn',
    question: 'P5/H1.6 — a [QueryRangeFunction] static in an extension of SysQueryRangeUtil compiles',
    declaration: `[ExtensionOf(classStr(SysQueryRangeUtil))]
public static class ConProbeQueryRangeFn_Extension`,
    methods: [
      `    [QueryRangeFunction()]
    public static str probeOpenOnly()
    {
        return SysQuery::value(NoYes::Yes);
    }`,
    ],
    expect: 'compiles',
  },
  {
    id: 'QueryFilterKernel',
    question: 'P5/H1.6 — QueryFilter (no AOT XML) is usable from X++, i.e. it is a kernel class',
    locals: 'Query q = new Query(); QueryBuildDataSource qbds; QueryFilter filter;',
    body: `qbds = q.addDataSource(tableNum(CustTable));
        filter = q.addQueryFilter(qbds, fieldStr(CustTable, CustGroup));
        filter.value(SysQuery::value('10'));`,
    expect: 'compiles',
  },

  // ── P8 — lookups (H1.10). Member names come from the AOT read; what is being
  // asked here is whether the CALL SHAPES compile.
  {
    id: 'LookupReference',
    question: 'P8/H1.10 — SysReferenceTableLookup::newParameters(...).performFormLookup() shape',
    methods: [
      `    public static void probeLookup(FormStringControl _control)
    {
        SysReferenceTableLookup lookup = SysReferenceTableLookup::newParameters(tableNum(CustTable), _control);
        Query query = new Query();

        query.addDataSource(tableNum(CustTable));
        lookup.addLookupfield(fieldNum(CustTable, AccountNum));
        lookup.addLookupMethod(tableMethodStr(CustTable, name));
        lookup.parmQuery(query);
        lookup.performFormLookup();
    }`,
    ],
    expect: 'compiles',
  },
  {
    id: 'LookupMultiSelect',
    question: 'P8/H1.10 — SysLookupMultiSelectCtrl::construct(formRun, control, query) shape',
    methods: [
      `    public static void probeMultiSelect(FormRun _formRun, FormStringControl _control)
    {
        Query query = new Query();
        SysLookupMultiSelectCtrl ctrl;

        query.addDataSource(tableNum(CustTable));
        ctrl = SysLookupMultiSelectCtrl::constructWithQuery(_formRun, _control, query);
    }`,
    ],
    expect: 'compiles',
  },
  {
    id: 'RegisterOverride',
    question: 'P8/H1.10 — registerOverrideMethod binding a control lookup from an extension class',
    methods: [
      `    public static void probeRegister(FormStringControl _control, Object _handler)
    {
        _control.registerOverrideMethod(
            methodStr(FormStringControl, lookup),
            methodStr(ConProbeRegisterOverride, probeRegister),
            _handler);
    }`,
    ],
    expect: 'compiles',
  },

  // ── P15 — SysOperation query parameter (H1.12), the batch-with-a-filter shape.
  {
    id: 'SysOpQueryParam',
    question: 'P15/H1.12 — [AifQueryTypeAttribute] on a DataMember + SysOperationHelper::base64Decode',
    declaration: `[DataContractAttribute]
public class ConProbeSysOpQueryParam`,
    fields: '    private str packedQuery;',
    methods: [
      `    [DataMemberAttribute('Query'),
     AifQueryTypeAttribute('_packedQuery', queryStr(CustTableListPage))]
    public str parmQuery(str _packedQuery = '')
    {
        return _packedQuery;
    }`,
      `    public QueryRun buildQueryRun()
    {
        Query query = new Query(SysOperationHelper::base64Decode(this.parmQuery()));

        return new QueryRun(query);
    }`,
    ],
    expect: 'compiles',
  },

  // ── P7 — do the CLR entry points resolve in the sandbox model's reference set?
  // A missing reference reads as "does not denote a class", not as a syntax error,
  // so this probe decides whether H1.8 can be taught with examples that build.
  {
    id: 'ClrHttpJson',
    question: 'P7/H1.8 — HttpClient, FormJsonSerializer, Newtonsoft JObject and Regex resolve here',
    locals: 'System.Net.Http.HttpClient client; System.Text.RegularExpressions.Regex re; str json;',
    body: `client = new System.Net.Http.HttpClient();
        re = new System.Text.RegularExpressions.Regex(@'^[A-Z]{2}\\d+$');
        json = FormJsonSerializer::serializeClass(this);`,
    expect: 'compiles',
  },
  {
    id: 'ClrNewtonsoft',
    question: 'P7/H1.8 — Newtonsoft.Json.Linq is reachable from a sandbox model',
    locals: 'Newtonsoft.Json.Linq.JObject o;',
    body: `o = Newtonsoft.Json.Linq.JObject::Parse('{"a":1}');`,
    expect: 'compiles',
  },
  {
    id: 'ClrExcel',
    question: 'P7/H1.17 — OfficeOpenXml (EPPlus) is reachable, i.e. an XLSX example can be taught',
    locals: 'OfficeOpenXml.ExcelPackage package; System.IO.MemoryStream stream;',
    body: `stream = new System.IO.MemoryStream();
        package = new OfficeOpenXml.ExcelPackage(stream);`,
    expect: 'compiles',
  },

  // ── H1.17 — the supported file-download path.
  {
    id: 'FileSendToUser',
    question: 'H1.17 — File::SendFileToUser(stream, name) is the supported download call',
    locals: 'System.IO.MemoryStream stream = new System.IO.MemoryStream();',
    body: `File::SendFileToUser(stream, 'export.csv');`,
    expect: 'compiles',
  },

  // ── H1.15 / H1.16 — attachments and mail, shapes for the entries.
  {
    id: 'AttachDocuRef',
    question: 'H1.15 — DocumentManagement::attachFile(...) shape with a stream',
    locals: 'DocuRef docuRef; System.IO.MemoryStream stream = new System.IO.MemoryStream(); CustTable custTable;',
    body: `docuRef = DocumentManagement::attachFile(
            custTable.TableId, custTable.RecId, custTable.DataAreaId,
            DocuType::find('File'), stream, 'invoice.pdf', 'application/pdf', 'Invoice');`,
    expect: 'compiles',
  },
  {
    id: 'MailerBuilder',
    question: 'H1.16 — SysMailerMessageBuilder + SysMailerFactory::sendNonInteractive shape',
    locals: 'SysMailerMessageBuilder builder = new SysMailerMessageBuilder();',
    body: `builder.setFrom('noreply@contoso.com')
            .addTo('user@contoso.com')
            .setSubject('Subject')
            .setBody('<p>Body</p>', true);
        SysMailerFactory::sendNonInteractive(builder.getMessage());`,
    expect: 'compiles',
  },

  // ── H1.18 — the security checks. SecurityRights does NOT exist in D365FO (the
  // AOT read found only EeSecurityRights* controllers), so the probe asks about
  // the Global statics that replaced it.
  {
    id: 'SecurityChecks',
    question: 'H1.18 — hasTableAccess/hasMenuItemAccess/isSystemAdministrator are Global statics',
    locals: 'boolean ok;',
    body: `ok = hasTableAccess(tableNum(CustTable), AccessType::View)
            && hasMenuItemAccess(menuItemDisplayStr(CustTable), MenuItemType::Display)
            && isSystemAdministrator();`,
    expect: 'compiles',
  },
  {
    id: 'SecurityRightsGone',
    question: 'H1.18 — SecurityRights (AX2012) really is absent, so no entry may name it',
    body: `SecurityRights::construct();`,
    expect: 'fails',
  },

  // ── H1.1 — system objects and dialogs.
  {
    id: 'SystemObjects',
    question: 'H1.1 — Box/Debug/infolog/appl/classFactory call shapes',
    locals: 'DialogButton answer; int lines;',
    body: `answer = Box::yesNo('Continue?', DialogButton::No);
        Debug::assert(answer == DialogButton::Yes);
        lines = infolog.line();
        infolog.clear(0);
        setPrefix('Probe');`,
    expect: 'compiles',
  },
  {
    id: 'ProgressBar',
    question: 'H1.11 — SysOperationProgress::newGeneral + the base-class members (setTotal/incCount are on the BASE)',
    locals: 'SysOperationProgress progress;',
    body: `progress = SysOperationProgress::newGeneral(0, 'Processing', 100);
        progress.setText('Working');
        progress.incCount(1);
        progress.setTotal(100);`,
    expect: 'compiles',
  },

  // ── H1.3 — RunBase lifecycle, needed to CoC shipped RunBase classes.
  {
    id: 'RunBaseLifecycle',
    question: 'H1.3 — a RunBaseBatch subclass with pack/unpack and #CurrentVersion compiles',
    declaration: `public class ConProbeRunBaseLifecycle extends RunBaseBatch`,
    fields: `    #define.CurrentVersion(1)
    #localmacro.CurrentList
        accountNum
    #endmacro

    private CustAccount accountNum;`,
    methods: [
      `    public container pack()
    {
        return [#CurrentVersion, #CurrentList];
    }`,
      `    public boolean unpack(container _packedClass)
    {
        int version = conPeek(_packedClass, 1);

        switch (version)
        {
            case #CurrentVersion:
                [version, #CurrentList] = _packedClass;
                return true;

            default:
                return false;
        }
    }`,
    ],
    expect: 'compiles',
  },

  // ── H4.5 — is there a supportable render-to-bytes path? The AOT read found
  // SrsProxy.renderReportToByteArray behind an InternalUseOnly attribute; this
  // asks what the compiler does about that.
  {
    id: 'RenderToBytes',
    question: 'H4.5/P13 — calling SrsProxy::renderReportToByteArray: error, warning, or silent?',
    locals: 'SrsProxy proxy; System.Byte[] bytes;',
    body: `proxy = SrsProxy::construct();`,
  },

  // ── H2.7 (RPT003) — the pre-process base classes, to key the rule on real names.
  {
    id: 'PreProcessBase',
    question: 'H2.7 — SrsReportDataProviderPreProcessTempDB is a real base class for a DP',
    declaration: `[SRSReportParameterAttribute(classStr(ConProbeContractNotThere))]
public class ConProbePreProcessBase extends SrsReportDataProviderPreProcessTempDB`,
    methods: [
      `    public void processReport()
    {
    }`,
    ],
  },

  // ── H1.5 — view computed columns: the static method shape a view calls.
  {
    id: 'ComputedColumn',
    question: 'H1.5 — SysComputedColumn::returnField/comparisonField compile as a view method body',
    methods: [
      `    public static str probeComputedColumn()
    {
        return SysComputedColumn::if(
            SysComputedColumn::comparisonField(
                identifierStr(ConProbeComputedColumn), 'CustTable', fieldStr(CustTable, Blocked)),
            SysComputedColumn::returnLiteral(1),
            SysComputedColumn::returnLiteral(0));
    }`,
    ],
  },
];

export default probes;
