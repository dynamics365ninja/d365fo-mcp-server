/**
 * Probe batch 2 — the shapes batch 1 corrected, plus the questions it opened.
 *
 * Batch 1's surprises were mostly MY errors, and each one is a fact worth keeping:
 * `client` is a reserved word so it cannot name a variable; `newParameters` on
 * SysReferenceTableLookup wants a FormReferenceControl; `attachFile` wants a
 * DocuTypeId (a string) not a DocuType record; `newGeneral`'s first argument is a
 * str. This batch re-asks each question in the shape the compiler accepts, so the
 * knowledge entries can be written from a build that passed rather than from one
 * that failed for an unrelated reason.
 *
 * Run:  npm run oracle:probe -- --file scripts/oracles/probes/coverage-v3b.ts --json .oracle-probe-v3b.json
 */
import type { Probe } from '../xppcProbe.js';

/** A query that exists in a package the sandbox model references. */
const REAL_QUERY = 'BatchJobHistoryCleanUp';

const probes: Probe[] = [
  // ── P1 — prmIsDefault, now isolated from its arity twin (batch 1's id prefix
  // collision made this probe report the other one's error).
  {
    id: 'PrmDefaultAlone',
    question: 'P1/H0.2 — prmIsDefault(<default parameter name>) compiles; it is a compiler form, not a function',
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
    id: 'PrmDefaultOnNonDefault',
    question: 'P1 — prmIsDefault on a NON-default parameter: the exact refusal text',
    methods: [
      `    public void withoutDefault(int _a)
    {
        if (prmIsDefault(_a))
        {
            info('default');
        }
    }`,
    ],
    expect: 'fails',
  },

  // ── H3.1 — the TDD target this whole phase turns on: can a SysTest name a TABLE
  // and assert on a table method's infolog message?
  {
    id: 'TableMethodTest',
    question: 'H3.1 — [SysTestTarget(tableStr(X), UtilElementType::Table)] + buffer arrange + assertExpectedInfoLogMessage',
    declaration: `[SysTestTarget(tableStr(CustTable), UtilElementType::Table)]
class ConProbeTableMethodTest extends SysTestCase`,
    methods: [
      `    [SysTestMethod]
    public void testValidateWriteRejectsMissingGroup()
    {
        CustTable custTable;

        custTable.initValue();
        custTable.AccountNum = 'PROBE-1';

        this.assertFalse(custTable.validateWrite(), 'a customer without a group must not validate');
        this.assertExpectedInfoLogMessage('Customer group', 'the rule must say why it refused');
    }`,
    ],
    expect: 'compiles',
  },

  // ── P5/H1.6 — the class name now comes from the declaration, so the artifact
  // name matches and the body is actually compiled.
  {
    id: 'ConProbeRangeFn_Extension',
    question: 'P5/H1.6 — a [QueryRangeFunction] static in an extension of SysQueryRangeUtil compiles',
    declaration: `[ExtensionOf(classStr(SysQueryRangeUtil))]
public static class ConProbeRangeFn_Extension`,
    methods: [
      `    [QueryRangeFunction()]
    public static str probeOpenOnly()
    {
        return SysQuery::value(NoYes::Yes);
    }`,
    ],
    expect: 'compiles',
  },

  // ── P8/H1.10 — the lookup shapes, with the control types the compiler named.
  {
    id: 'LookupRef2',
    question: 'P8/H1.10 — SysReferenceTableLookup::newParameters wants a FormReferenceControl',
    methods: [
      `    public static void probeLookup(FormReferenceControl _control)
    {
        SysReferenceTableLookup lookup = SysReferenceTableLookup::newParameters(tableNum(CustTable), _control);

        lookup.addLookupfield(fieldNum(CustTable, AccountNum));
        lookup.addLookupMethod(tableMethodStr(CustTable, name));
        lookup.performFormLookup();
    }`,
    ],
    expect: 'compiles',
  },
  {
    id: 'LookupTable2',
    question: 'P8/H1.10 — SysTableLookup::newParameters(tableNum, control) + addLookupfield + performFormLookup',
    methods: [
      `    public static void probeTableLookup(FormStringControl _control)
    {
        SysTableLookup lookup = SysTableLookup::newParameters(tableNum(CustTable), _control);
        Query query = new Query();

        query.addDataSource(tableNum(CustTable));
        lookup.addLookupfield(fieldNum(CustTable, AccountNum));
        lookup.parmQuery(query);
        lookup.performFormLookup();
    }`,
    ],
    expect: 'compiles',
  },
  {
    id: 'RegisterOverride2',
    question: 'P8/H1.10 — registerOverrideMethod: the handler named by methodStr must be an INSTANCE method',
    methods: [
      `    public void bind(FormStringControl _control)
    {
        _control.registerOverrideMethod(
            methodStr(FormStringControl, lookup),
            methodStr(ConProbeRegisterOverride2, onLookup),
            this);
    }`,
      `    public void onLookup(FormStringControl _control)
    {
        SysTableLookup lookup = SysTableLookup::newParameters(tableNum(CustTable), _control);

        lookup.addLookupfield(fieldNum(CustTable, AccountNum));
        lookup.performFormLookup();
    }`,
    ],
    expect: 'compiles',
  },

  // ── P15/H1.12 — SysOperation query parameter, with a query that exists here.
  {
    id: 'ConProbeSysOpQuery2',
    question: 'P15/H1.12 — [AifQueryTypeAttribute] on a DataMember + SysOperationHelper::base64Decode',
    declaration: `[DataContractAttribute]
public class ConProbeSysOpQuery2`,
    fields: '    private str packedQuery;',
    methods: [
      `    [DataMemberAttribute('Query'),
     AifQueryTypeAttribute('_packedQuery', queryStr(${REAL_QUERY}))]
    public str parmQuery(str _packedQuery = '')
    {
        if (!prmIsDefault(_packedQuery))
        {
            packedQuery = _packedQuery;
        }

        return packedQuery;
    }`,
      `    public QueryRun buildQueryRun()
    {
        Query query = new Query(SysOperationHelper::base64Decode(this.parmQuery()));

        return new QueryRun(query);
    }`,
    ],
    expect: 'compiles',
  },

  // ── P7/H1.8 — the CLR entry points, with a variable name that is not a keyword.
  {
    id: 'ClrHttp2',
    question: 'P7/H1.8 — HttpClient + Regex + FormJsonSerializer resolve (batch 1 died on the keyword `client`)',
    locals: 'System.Net.Http.HttpClient httpClient; System.Text.RegularExpressions.Regex expression; str json;',
    body: `httpClient = new System.Net.Http.HttpClient();
        expression = new System.Text.RegularExpressions.Regex(@'^[A-Z]{2}[0-9]+$');
        json = FormJsonSerializer::serializeClass(this);`,
    expect: 'compiles',
  },

  // ── H1.15 — attachments: argument 4 is a DocuTypeId, not a DocuType record.
  {
    id: 'AttachDocuRef2',
    question: 'H1.15 — DocumentManagement::attachFile(tableId, recId, dataArea, DocuTypeId, stream, name, mime, note)',
    locals: 'DocuRef docuRef; System.IO.MemoryStream stream = new System.IO.MemoryStream(); CustTable custTable;',
    body: `docuRef = DocumentManagement::attachFile(
            custTable.TableId, custTable.RecId, custTable.DataAreaId,
            'File', stream, 'invoice.pdf', 'application/pdf', 'Invoice');`,
    expect: 'compiles',
  },

  // ── H1.11 — the progress bar: newGeneral's first argument is a str.
  {
    id: 'ProgressBar2',
    question: 'H1.11 — SysOperationProgress::newGeneral(str, caption, total) + base setTotal/incCount/setText',
    locals: 'SysOperationProgress progress;',
    body: `progress = SysOperationProgress::newGeneral('', 'Processing', 100);
        progress.setText('Working');
        progress.setTotal(100);
        progress.incCount(1);`,
    expect: 'compiles',
  },

  // ── H1.1 — the obsolete infolog member and its stated replacement.
  {
    id: 'InfologLine',
    question: 'H1.1 — infologLine() on Global is the replacement the compiler names for infolog.line()',
    locals: 'int lines;',
    body: `lines = infologLine();
        infolog.clear(0);`,
    expect: 'compiles',
  },

  // ── H1.18 — SecurityRights compiled in batch 1 but has no AOT XML. Confirm it
  // is a real kernel class and not the compiler being lenient about statics.
  {
    id: 'SecurityRightsReal',
    question: 'H1.18 — SecurityRights is a real kernel class (a bogus method on it must be refused)',
    body: 'SecurityRights::definitelyNotAMethodOnThisClass();',
    expect: 'fails',
  },

  // ── H4.4 — print destinations from code, the members read off the AOT class.
  {
    id: 'PrintToFile',
    question: 'H4.4 — SrsPrintDestinationSettings: file/PDF, archive and the e-mail contract',
    locals: 'SRSPrintDestinationSettings settings = new SRSPrintDestinationSettings(); SrsReportEMailDataContract mail;',
    body: `settings.printMediumType(SRSPrintMediumType::File);
        settings.fileFormat(SRSReportFileFormat::PDF);
        settings.fileName(@'C:\\Temp\\report.pdf');
        settings.overwriteFile(true);
        settings.parmPrintToArchive(true);
        mail = settings.parmEMailContract();
        mail.parmTo('user@contoso.com');
        mail.parmSubject('Report');`,
    expect: 'compiles',
  },

  // ── H2.7 (RPT003) — the pre-process bases, without batch 1's bogus classStr.
  {
    id: 'PreProcessTempDb',
    question: 'H2.7 — SrsReportDataProviderPreProcessTempDB is a usable DP base class',
    declaration: 'public class ConProbePreProcessTempDb extends SrsReportDataProviderPreProcessTempDB',
    methods: [
      `    public void processReport()
    {
    }`,
    ],
    expect: 'compiles',
  },
  {
    id: 'PreProcessRegular',
    question: 'H2.7 — SrsReportDataProviderPreProcess (regular-table staging) is a usable DP base class',
    declaration: 'public class ConProbePreProcessRegular extends SrsReportDataProviderPreProcess',
    methods: [
      `    public void processReport()
    {
    }`,
    ],
    expect: 'compiles',
  },

  // ── H1.3 — the RunBase members a CoC wrapper on a shipped RunBase must match.
  {
    id: 'RunBaseDialog',
    question: 'H1.3 — RunBaseBatch dialog lifecycle: dialog/getFromDialog/validate/run signatures',
    declaration: 'public class ConProbeRunBaseDialog extends RunBaseBatch',
    fields: `    #define.CurrentVersion(1)
    #localmacro.CurrentList
        accountNum
    #endmacro

    private CustAccount accountNum;
    private DialogField dialogAccountNum;`,
    methods: [
      `    public Object dialog()
    {
        DialogRunbase dialog = super();

        dialogAccountNum = dialog.addFieldValue(extendedTypeStr(CustAccount), accountNum);

        return dialog;
    }`,
      `    public boolean getFromDialog()
    {
        accountNum = dialogAccountNum.value();

        return super();
    }`,
      `    public boolean validate(Object _calledFrom = null)
    {
        if (!accountNum)
        {
            return checkFailed('Account is required');
        }

        return super(_calledFrom);
    }`,
      `    public void run()
    {
        info(accountNum);
    }`,
    ],
    expect: 'compiles',
  },
];

export default probes;
