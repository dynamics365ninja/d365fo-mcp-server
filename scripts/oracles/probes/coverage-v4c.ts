/**
 * Probe batch v4c — the matrix that separates three explanations at once.
 *
 * v4b reported "two stacked attributes on a method is a parse error". A census
 * then found 2,163 shipped AxClass files that stack attributes, so that reading
 * cannot be right and the probe was measuring something else. Three candidates
 * remain, and one probe each settles them:
 *
 *   A. the SUFFIX — every shipped use is `[SysTestCheckInTestAttribute]`; the
 *      short form `[SysTestCheckInTest]` appears exactly 4 times in the whole
 *      install, and all four are `attributestr(...)` arguments or the class
 *      declaration itself. So the short form may simply not resolve.
 *   B. STACKING on a METHOD specifically — the census examples were all
 *      class-level declarations, which is a different position in the grammar.
 *   C. something about the probe harness's own file layout.
 *
 * The point of running all three: a single failing probe tells you a program did
 * not compile, never why. Only a matrix where the SAME shape varies in one place
 * turns a failure into a fact.
 *
 * Run:  npm run oracle:probe -- --file scripts/oracles/probes/coverage-v4c.ts \
 *         --json .oracle-probe-v4c.json
 */
import type { Probe } from '../xppcProbe.js';

const probes: Probe[] = [
  {
    id: 'CheckInShortFormAlone',
    question: 'v4c/A — [SysTestCheckInTest], the SHORT form, as the only attribute',
    declaration: 'public class ConProbeCheckInShortFormAlone extends SysTestCase',
    methods: [
      `    [SysTestCheckInTest]
    public void testShortForm()
    {
        this.fail('not implemented');
    }`,
    ],
    expect: 'compiles',
  },
  {
    id: 'CheckInFullFormAlone',
    question: 'v4c/A2 — [SysTestCheckInTestAttribute], the form every shipped file uses',
    declaration: 'public class ConProbeCheckInFullFormAlone extends SysTestCase',
    methods: [
      `    [SysTestCheckInTestAttribute]
    public void testFullForm()
    {
        this.fail('not implemented');
    }`,
    ],
    expect: 'compiles',
  },
  {
    id: 'StackedFullFormsOnMethod',
    question:
      'v4c/B — two attributes stacked on a METHOD, both in their full form. If this compiles, stacking is '
      + 'fine and v4b failed on the short name',
    declaration: 'public class ConProbeStackedFullFormsOnMethod extends SysTestCase',
    methods: [
      `    [SysTestMethodAttribute]
    [SysTestCheckInTestAttribute]
    public void testStackedFull()
    {
        this.fail('not implemented');
    }`,
    ],
    expect: 'compiles',
  },
  {
    id: 'StackedShortFormsOnMethod',
    question: 'v4c/B2 — the same stack in short form, i.e. exactly what v4b ran',
    declaration: 'public class ConProbeStackedShortFormsOnMethod extends SysTestCase',
    methods: [
      `    [SysTestMethod]
    [SysTestCheckInTest]
    public void testStackedShort()
    {
        this.fail('not implemented');
    }`,
    ],
    expect: 'fails',
  },
];

export default probes;
