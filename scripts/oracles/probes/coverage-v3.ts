/**
 * Probe batch for the v3 coverage work — every claim a knowledge entry or a rule
 * is about to make, put to xppc before it is written.
 *
 * READ THIS BEFORE RE-RUNNING. Its questions are ANSWERED (2026-08-31, xppc
 * 7.0.7996.33) and several were answered by a REFUSAL, because the shape this
 * file asked about was wrong. Those probes keep `expect: 'fails'` and carry the
 * diagnostic they earned, so a re-run reports zero surprises on a healthy
 * platform and a surprise means something really moved. The corrected shapes —
 * the ones a knowledge entry may copy — live in `coverage-v3b.ts`; take examples
 * from there, not from here.
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
    // ANSWERED in v3b (PrmDefaultAlone): it compiles. In THIS batch the result was
    // unreadable — the harness matched diagnostics by name prefix, so this probe
    // collected PrmIsDefaultArity's error. That collision is fixed.
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
    // ANSWERED, by refusal, and the fault was the HARNESS's: the declaration named
    // ConProbeQueryRangeFn_Extension while the artifact was ConProbeQueryRangeFn, and
    // xppc refuses the mismatch. The harness now derives the artifact name from the
    // declaration; v3b re-asks and it compiles.
    expect: 'fails',
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
    // ANSWERED, by refusal: "Type mismatch in 'SysReferenceTableLookup.newParameters'
    // argument 2. The expected type is 'FormReferenceControl'". Corrected in v3b.
    expect: 'fails',
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
    // ANSWERED, by refusal: "The intrinsic argument 'probeRegister' must not specify
    // a static method" — the handler has to be an instance method. Corrected in v3b.
    expect: 'fails',
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
    // ANSWERED, by refusal, for an unrelated reason: "Query 'CustTableListPage' is
    // not found" — that query is not in the sandbox model's reference set. The
    // attribute shape itself was never rejected; v3b re-asks with a query that exists.
    expect: 'fails',
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
    // ANSWERED, by refusal, and the reason is a language fact worth keeping:
    // "'client' is an invalid name for a variable because it is an X++ keyword".
    // The CLR types themselves resolve fine — see ClrHttp2 in v3b.
    expect: 'fails',
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
    // ANSWERED, by refusal: argument 4 is a DocuTypeId (a string), not a DocuType
    // record. Corrected in v3b.
    expect: 'fails',
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
    // ANSWERED, and it INVERTED the assumption: SecurityRights::construct() compiles.
    // The class is real — kernel-implemented, so an AOT read alone reports "not found"
    // and would have shipped a lie. v3b's SecurityRightsReal confirms it by probing a
    // method that does not exist on it.
    expect: 'compiles',
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
    // ANSWERED, by refusal: newGeneral's first argument is a str, not an int, and
    // setTotal/incCount/setText live on SysOperationProgressBase. Corrected in v3b.
    expect: 'fails',
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
    // ANSWERED: it COMPILES, with three warnings — "Type 'SrsProxy' is marked
    // InternalUseOnly and is not accessible from the current module". Compiling is not
    // the same as supported, and that is the answer the knowledge entry needed.
    expect: 'compiles',
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
    // ANSWERED, by refusal, for an unrelated reason: the probe's own placeholder
    // classStr(ConProbeContractNotThere) names no known class. v3b drops the attribute
    // and both pre-process bases compile.
    expect: 'fails',
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
