/**
 * Probe batch v4f — does the D2 descriptor change actually deliver?
 *
 * The sandbox model now references `TestEssentials`, `AtlFoundation`,
 * `AtlApplicationSuite` and `ATLTestCaseCommon` (owner decision D2, applied
 * 2026-09-02). That is a claim about what will now compile, and the honest way
 * to accept a change someone else made is to measure what it bought rather than
 * to assume it.
 *
 * Two things are settled here:
 *
 *  1. **The filtering attributes.** `[SysTestCategory]` failed before D2 with
 *     `Class 'SysTestCategory' was not found. Are you missing a module
 *     reference?` (v4b). If it compiles now, the reference works and the
 *     scaffold's warning is doing its job for models that lack it. If it does
 *     NOT, the reference name in the descriptor is wrong and everything H2 plans
 *     to build on it would fail later and less clearly.
 *  2. **The ATL entry point.** `AtlDataRootNode::construct()` is the first line
 *     of every integration test the `test-data-atl` topic will teach, so it is
 *     the one call that has to resolve before that topic is worth writing.
 *
 * The negative control is inherited from the harness, and it matters more than
 * usual here: a build that silently did not include these classes would report
 * "compiles" for the same reason it reports it for anything it never read.
 *
 * Run:  npm run oracle:probe -- --file scripts/oracles/probes/coverage-v4f.ts \
 *         --json .oracle-probe-v4f.json
 */
import type { Probe } from '../xppcProbe.js';

const probes: Probe[] = [
  {
    id: 'CategoryAfterD2',
    question: 'v4f — [SysTestCategory] with the TestEssentials reference in place. Failed before D2 with '
      + '"Class \'SysTestCategory\' was not found"',
    declaration: 'public class ConProbeCategoryAfterD2 extends SysTestCase',
    methods: [
      `    [SysTestCategory('Unit')]
    public void testWithCategory()
    {
        this.fail('not implemented');
    }`,
    ],
    expect: 'compiles',
  },
  {
    id: 'OwnerPriorityAfterD2',
    question: 'v4f — the other TestEssentials attributes the unit-testing topic names: [SysTestOwner], '
      + '[SysTestPriority], [SysTestAreaPath]. One bracket, because stacking on a method is ATTR003',
    declaration: 'public class ConProbeOwnerPriorityAfterD2 extends SysTestCase',
    methods: [
      `    [SysTestOwner('team'), SysTestPriority('1'), SysTestAreaPath('Sales')]
    public void testWithFilters()
    {
        this.fail('not implemented');
    }`,
    ],
    expect: 'compiles',
  },
  {
    id: 'AtlRootAfterD2',
    question: 'v4f — AtlDataRootNode::construct(), the first line of every ATL test and the call the '
      + 'test-data-atl topic will open with',
    declaration: 'public class ConProbeAtlRootAfterD2 extends SysTestCase',
    methods: [
      `    [SysTestMethod]
    public void testAtlRootResolves()
    {
        AtlDataRootNode data = AtlDataRootNode::construct();

        this.assertNotNull(data);
    }`,
    ],
    expect: 'compiles',
  },
  {
    id: 'AtlModuleNodeAfterD2',
    question: 'v4f — a module node off the ATL root. If the root resolves but the modules do not, the '
      + 'topic can teach the entry point and nothing past it',
    declaration: 'public class ConProbeAtlModuleNodeAfterD2 extends SysTestCase',
    methods: [
      `    [SysTestMethod]
    public void testAtlModuleNode()
    {
        AtlDataRootNode data = AtlDataRootNode::construct();

        this.assertNotNull(data.invent());
    }`,
    ],
    expect: 'compiles',
  },
  {
    id: 'SuiteIsolationAfterD2',
    question: 'v4f — createSuite() returning a company-isolating suite, which is how a test that writes '
      + 'real data keeps out of the next one\'s way',
    declaration: 'public class ConProbeSuiteIsolationAfterD2 extends SysTestCase',
    methods: [
      `    public SysTestSuite createSuite()
    {
        return new SysTestSuiteCompanyIsolateClass(this);
    }`,
    ],
    expect: 'compiles',
  },
];

export default probes;
