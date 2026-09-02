/**
 * Probe batch v4g — can a report data provider be unit-tested at all?
 *
 * G-24 proposes a `report-dp` SysTest shape: construct the DP, hand it a
 * contract, call `processReport()`, then read the staged rows out of the temp
 * table. Every step of that is an assumption until the compiler answers, and two
 * of them are load-bearing:
 *
 *  - `processReport()` is the entry point the FRAMEWORK calls. If it is
 *    protected, a test cannot call it and the whole shape collapses into
 *    "test the helpers instead".
 *  - the dataset getter is written by the DEVELOPER (the base has 11 members and
 *    none of them is a `getTmp*`), so the scaffold must take its name as a
 *    parameter rather than deriving one — the same lesson the
 *    `report-dataset-extension` pattern already learned.
 *
 * `SysDatabaseLogDP` (ApplicationFoundation, referenced by the sandbox) is the
 * stand-in: a real shipped provider with a real `getSysDatabaseLogTmp()` getter,
 * so the probe exercises the shipped shape rather than an invented one.
 *
 * Also settled here: whether `SrsReportRunController::parmPrintDestination`
 * exists. The plan named it with a question mark; the member snapshot says no,
 * and a compile is the second opinion.
 *
 * Run:  npm run oracle:probe -- --file scripts/oracles/probes/coverage-v4g.ts \
 *         --json .oracle-probe-v4g.json
 */
import type { Probe } from '../xppcProbe.js';

const DP = 'SysDatabaseLogDP';

const probes: Probe[] = [
  {
    id: 'DpConstructAndProcess',
    question:
      'v4g/G-24 — the core of the report-dp test shape: construct a DP and call processReport(). If '
      + 'processReport is protected this fails and the shape has to change',
    declaration: 'public class ConProbeDpConstructAndProcess extends SysTestCase',
    methods: [
      `    [SysTestMethod]
    public void testProcessReportIsCallable()
    {
        ${DP} dp = new ${DP}();

        dp.processReport();

        this.fail('not implemented');
    }`,
    ],
    expect: 'compiles',
  },
  {
    id: 'DpDatasetGetter',
    question:
      'v4g/G-24 — reading the staged rows back through the developer-written dataset getter, which is '
      + 'what a DP test asserts on',
    declaration: 'public class ConProbeDpDatasetGetter extends SysTestCase',
    methods: [
      `    [SysTestMethod]
    public void testDatasetGetterReturnsBuffer()
    {
        ${DP} dp = new ${DP}();
        SysDatabaseLogTmp tmp;

        tmp = dp.getSysDatabaseLogTmp();

        this.assertNotNull(tmp);
    }`,
    ],
    expect: 'compiles',
  },
  {
    id: 'DpParmQuery',
    question:
      'v4g/G-24 — parmQuery() on the base, the arrange step for a query-based DP',
    declaration: 'public class ConProbeDpParmQuery extends SysTestCase',
    methods: [
      `    [SysTestMethod]
    public void testParmQuery()
    {
        ${DP} dp = new ${DP}();

        dp.parmQuery(new Query());

        this.fail('not implemented');
    }`,
    ],
    expect: 'compiles',
  },
  {
    id: 'ControllerParmPrintDestination',
    question:
      'v4g/G-19 — does SrsReportRunController::parmPrintDestination exist? The member snapshot says NO '
      + '(the real ones are parmPrintDestinationTokens and setDefaultPrintDestinationSettings); this is '
      + 'the second opinion',
    declaration: 'public class ConProbeControllerParmPrintDestination extends SysTestCase',
    methods: [
      `    [SysTestMethod]
    public void testParmPrintDestination()
    {
        SrsReportRunController controller = new SrsReportRunController();

        controller.parmPrintDestination(SRSPrintMediumType::File);

        this.fail('not implemented');
    }`,
    ],
    expect: 'fails',
  },
  {
    id: 'ControllerRealMembers',
    question:
      'v4g/G-19 — the members that DO exist and that a controller override actually uses',
    declaration: 'public class ConProbeControllerRealMembers extends SysTestCase',
    methods: [
      `    [SysTestMethod]
    public void testRealControllerMembers()
    {
        SrsReportRunController controller = new SrsReportRunController();

        controller.parmReportName('MyReport.Report');
        controller.parmShowDialog(false);
        controller.parmLoadFromSysLastValue(false);

        this.fail('not implemented');
    }`,
    ],
    expect: 'compiles',
  },
];

export default probes;
