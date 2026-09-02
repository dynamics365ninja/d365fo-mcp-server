/**
 * Probe batch v4b — what the first batch's fourth probe did NOT prove.
 *
 * `SysTestCategoryWithoutTestEssentials` failed, as expected — but it failed with
 * `Invalid token '['`, which is a PARSE error, not "unknown attribute". So the
 * probe is consistent with two completely different explanations:
 *
 *   (a) `[SysTestCategory]` is unresolvable without a TestEssentials reference,
 *       which is what the scaffold and the knowledge base both claim; or
 *   (b) two attributes STACKED on one method is not legal in this position at
 *       all, in which case the first explanation is untested and the claim is
 *       still hearsay.
 *
 * "It failed" is as weak a result as "it compiled" when the diagnostic does not
 * name the thing you asked about. These probes separate the two: the same
 * stacking with two attributes that both ship in ApplicationFoundation, and
 * `[SysTestCategory]` alone.
 *
 * Run:  npm run oracle:probe -- --file scripts/oracles/probes/coverage-v4b.ts \
 *         --json .oracle-probe-v4b.json
 */
import type { Probe } from '../xppcProbe.js';

const probes: Probe[] = [
  {
    id: 'StackedAppFoundationAttributes',
    question:
      'v4b/A — are two attributes stacked on one method legal at all? Both of these ship in '
      + 'ApplicationFoundation, which the sandbox references, so a failure here means STACKING is the '
      + 'problem and the TestEssentials claim is untested',
    declaration: 'public class ConProbeStackedAppFoundationAttributes extends SysTestCase',
    methods: [
      `    [SysTestMethod]
    [SysTestCheckInTest]
    public void testStacked()
    {
        this.fail('testStacked is not implemented yet.');
    }`,
    ],
    expect: 'compiles',
  },
  {
    id: 'CategoryAloneNoTestEssentials',
    question:
      'v4b/B — [SysTestCategory] as the ONLY attribute, with no TestEssentials reference. This is the '
      + 'probe that actually decides whether the scaffold\'s warning is true',
    declaration: 'public class ConProbeCategoryAloneNoTestEssentials extends SysTestCase',
    methods: [
      `    [SysTestCategory('Unit')]
    public void testCategoryOnly()
    {
        this.fail('testCategoryOnly is not implemented yet.');
    }`,
    ],
    expect: 'fails',
  },
  {
    id: 'MethodAttributeAloneBaseline',
    question:
      'v4b/C — baseline: [SysTestMethod] alone compiles, so a failure above is about the ATTRIBUTE and '
      + 'not about attributes-on-methods in general',
    declaration: 'public class ConProbeMethodAttributeAloneBaseline extends SysTestCase',
    methods: [
      `    [SysTestMethod]
    public void testPlain()
    {
        this.fail('testPlain is not implemented yet.');
    }`,
    ],
    expect: 'compiles',
  },
];

export default probes;
