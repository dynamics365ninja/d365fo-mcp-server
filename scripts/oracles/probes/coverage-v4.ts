/**
 * Probe batch v4/H1 — do the three new SysTest scaffolds actually compile?
 *
 * The shapes were promoted from SysTests that really executed
 * (`eval/systests/L2-coc-extension.xml`, `L2-event-handler-basic.xml`,
 * `L3-batch-basic.xml`, 2026-08-31, 2/2 each), but the SCAFFOLD is not those
 * files: it replaces their assertions with `this.fail(...)` and their arrange
 * blocks with TODO comments. A skeleton is a different program from the finished
 * test, and "it was derived from something that ran" is not evidence that the
 * derivative compiles. The whole red-first loop rests on the first build being
 * GREEN — red means a failing assertion, not a broken file — so a scaffold that
 * does not compile breaks the one property the loop depends on.
 *
 * Second question, and the one with a real chance of failing: the sandbox
 * descriptor does NOT reference TestEssentials (it lists ApplicationFoundation,
 * ApplicationPlatform, ApplicationSuite, Directory, SourceDocumentationTypes,
 * GeneralLedger, PersonnelCore, Dimensions, Currency, ContactPerson, Ledger,
 * FleetManagement, ProcessGuide). The scaffold's own warning says
 * `[SysTestMethod]` and `[SysTestTarget]` come from ApplicationFoundation and
 * compile without it, while `[SysTestCategory]` and friends do not. These probes
 * are the test of that claim: if they compile here, the warning is right and a
 * developer can run the red phase before touching the descriptor.
 *
 * The X++ below is COPIED from what the generator emits. It is pinned on the
 * other side by `tests/tools/systestTargetKinds.test.ts`, so a template change
 * that drifts from these probes fails there first.
 *
 * Run:  npm run oracle:probe -- --file scripts/oracles/probes/coverage-v4.ts \
 *         --json .oracle-probe-v4.json
 */
import type { Probe } from '../xppcProbe.js';

/** A FleetManagement class the sandbox references and that constructs with no arguments. */
const BASE_CLASS = 'FMVehicleDataContract';
/** An ApplicationSuite table, so the event shape has something real to declare. */
const TABLE = 'CustGroup';

const probes: Probe[] = [
  {
    id: 'SysTestCocShape',
    question:
      'H1/G-30 — the "coc" scaffold compiles: [SysTestTarget(classStr(X), UtilElementType::Class)] on a '
      + 'SysTestCase, constructing the BASE class, with this.fail() standing in for the assertion',
    declaration:
      `[SysTestTarget(classStr(${BASE_CLASS}), UtilElementType::Class)]\n`
      + 'public class ConProbeSysTestCocShape extends SysTestCase',
    methods: [
      `    [SysTestMethod]
    public void testCarFactsSummaryIsWrapped()
    {
        ${BASE_CLASS} instance = new ${BASE_CLASS}();

        this.fail('testCarFactsSummaryIsWrapped is not implemented yet.');
    }`,
      `    [SysTestMethod]
    public void testCarFactsSummaryPreservesBaseValueForDifferentInput()
    {
        ${BASE_CLASS} instance = new ${BASE_CLASS}();

        this.fail('testCarFactsSummaryPreservesBaseValueForDifferentInput is not implemented yet.');
    }`,
    ],
    expect: 'compiles',
  },
  {
    id: 'SysTestEventShape',
    question:
      'H1/G-30 — the "event-handler" scaffold compiles: a table buffer declared and inserted inside a '
      + 'SysTestCase targeting the TABLE (UtilElementType::Table)',
    declaration:
      `[SysTestTarget(tableStr(${TABLE}), UtilElementType::Table)]\n`
      + 'public class ConProbeSysTestEventShape extends SysTestCase',
    methods: [
      `    [SysTestMethod]
    public void testInsertingAppliesTheRule()
    {
        ${TABLE} custGroup;

        custGroup.insert();

        this.fail('testInsertingAppliesTheRule is not implemented yet.');
    }`,
    ],
    expect: 'compiles',
  },
  {
    id: 'SysTestServiceShape',
    question:
      'H1/G-30 — the "service" scaffold compiles: two hand-constructed classes (contract + service) in a '
      + 'SysTestCase, with no controller, dialog or batch plumbing',
    declaration:
      `[SysTestTarget(classStr(${BASE_CLASS}), UtilElementType::Class)]\n`
      + 'public class ConProbeSysTestServiceShape extends SysTestCase',
    methods: [
      // Two constructible classes stand in for the contract/service pair: the
      // shape under test is "declare, construct, fail", and the scaffold leaves
      // the call itself as a TODO, so nothing beyond the two constructors has to
      // resolve for this to be the same program.
      `    [SysTestMethod]
    public void testCalculateEffectiveBatchSize()
    {
        ${BASE_CLASS} contract = new ${BASE_CLASS}();

        Query service = new Query();

        this.fail('testCalculateEffectiveBatchSize is not implemented yet.');
    }`,
    ],
    expect: 'compiles',
  },
  {
    id: 'SysTestCategoryWithoutTestEssentials',
    question:
      'H1 — does [SysTestCategory] really fail without a TestEssentials reference? The scaffold warns that '
      + 'it does; if this COMPILES the warning is wrong and should be softened',
    declaration: 'public class ConProbeSysTestCategoryWithoutTestEssentials extends SysTestCase',
    methods: [
      `    [SysTestMethod]
    [SysTestCategory('Unit')]
    public void testWithCategory()
    {
        this.fail('testWithCategory is not implemented yet.');
    }`,
    ],
    expect: 'fails',
  },
];

export default probes;
