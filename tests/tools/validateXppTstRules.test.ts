/**
 * TST001–TST003 — the three test-authoring rules (G-31).
 *
 * All three shipped only after being measured against the install, and two of
 * them are NOT what the coverage plan specified, because the measurement said
 * otherwise:
 *
 *  - TST002 was specified as "[SysTestMethod] in a class that does not
 *    `extends SysTestCase`". Of the 56 shipped classes carrying the attribute,
 *    only 24 extend it directly and 31 reach it through a chain — 256 shipped
 *    test classes extend `AtlWHSTestCase`. The literal rule would have fired on
 *    more shipped classes than it caught, and a source-text validator cannot
 *    follow the chain. It checks for NO base at all instead, which is clean
 *    across the whole install.
 *  - TST003 was specified to trigger on a `test*` method name. Only 8 of the 336
 *    shipped [SysTestMethod] methods — 2.4% — are named that way, so the rule
 *    would have missed 98% of real tests. The attribute is the trigger.
 *
 * TST001 needed no correction: `assertExpectedException` appears in 0 of 66,754
 * shipped AxClass files and is absent from SysTestAssert's 14 asserts.
 */

import { describe, expect, it } from 'vitest';
import { runRules } from '../../src/tools/analysis/validateXpp';

const only = (code: string, rule: string) => runRules(code, 'xpp').filter(v => v.rule === rule);

describe('TST001 — assertExpectedException does not exist', () => {
  it('fires and names the shape that replaces it', () => {
    const found = only(`
class ConFooTest extends SysTestCase
{
    [SysTestMethod]
    public void testRejects()
    {
        this.assertExpectedException(Exception::Error);
    }
}`, 'TST001');

    expect(found).toHaveLength(1);
    expect(found[0].severity).toBe('error');
    expect(found[0].fix).toContain('parmExceptionExpected');
  });

  it('leaves the correct shape alone', () => {
    expect(only(`
class ConFooTest extends SysTestCase
{
    [SysTestMethod]
    public void testRejects()
    {
        this.parmExceptionExpected(true);
        ConFoo::mustThrow();
    }
}`, 'TST001')).toEqual([]);
  });

  it('does not fire on the name inside a string or a comment', () => {
    expect(only(`
class ConFooTest extends SysTestCase
{
    // there is no assertExpectedException(…) in X++
    [SysTestMethod]
    public void testRejects()
    {
        str hint = 'assertExpectedException(';
        this.assertTrue(true, hint);
    }
}`, 'TST001')).toEqual([]);
  });
});

describe('TST002 — a test class with no base at all', () => {
  it('fires when the class extends nothing', () => {
    const found = only(`
class ConFooTest
{
    [SysTestMethod]
    public void testSomething()
    {
        this.assertTrue(true);
    }
}`, 'TST002');

    expect(found).toHaveLength(1);
    expect(found[0].severity).toBe('error');
    expect(found[0].fix).toContain('reports no tests');
  });

  it('accepts SysTestCase', () => {
    expect(only(`
class ConFooTest extends SysTestCase
{
    [SysTestMethod]
    public void testSomething()
    {
        this.assertTrue(true);
    }
}`, 'TST002')).toEqual([]);
  });

  it('accepts an intermediate base, because 31 of 56 shipped classes use one', () => {
    expect(only(`
class ConWarehouseFooTest extends AtlWHSTestCase
{
    [SysTestMethod]
    public void testSomething()
    {
        this.assertTrue(true);
    }
}`, 'TST002')).toEqual([]);
  });

  it('ignores a class that only MENTIONS the attribute in a string', () => {
    // This is the single candidate the whole-install sweep produced: SysTest
    // itself, passing 'SysTestMethod' to an event-tracing call.
    expect(only(`
class SysTest
{
    public void run()
    {
        EventProvider::write('SysTestMethod', activityId);
    }
}`, 'TST002')).toEqual([]);
  });

  it('is silent on a class with no test methods', () => {
    expect(only(`
class ConPlainHelper
{
    public void doThing()
    {
    }
}`, 'TST002')).toEqual([]);
  });
});

describe('TST003 — a test method that asserts nothing', () => {
  it('warns, and does not error', () => {
    const found = only(`
class ConFooTest extends SysTestCase
{
    [SysTestMethod]
    public void aScenarioThatChecksNothing()
    {
        ConFoo::doWork();
    }
}`, 'TST003');

    expect(found).toHaveLength(1);
    expect(found[0].severity).toBe('warning');
    expect(found[0].fix).toContain('asserts nothing');
  });

  it('triggers on the ATTRIBUTE, not the name — 97.6% of shipped tests are not named test*', () => {
    const found = only(`
class ConFooTest extends SysTestCase
{
    [SysTestMethod]
    public void enterLPOnWorkComplete_NoErrorShown()
    {
        ConFoo::doWork();
    }
}`, 'TST003');

    expect(found).toHaveLength(1);
  });

  it('accepts a DOMAIN assert helper, not just SysTestAssert methods', () => {
    // assertExpectedLines (229 uses) outranks assertEquals (223) in shipped code.
    expect(only(`
class ConFooTest extends SysTestCase
{
    [SysTestMethod]
    public void checksLines()
    {
        this.assertExpectedLines(expected, actual);
    }
}`, 'TST003')).toEqual([]);
  });

  it('accepts parmExceptionExpected as the assertion', () => {
    expect(only(`
class ConFooTest extends SysTestCase
{
    [SysTestMethod]
    public void mustThrow()
    {
        this.parmExceptionExpected(true);
        ConFoo::boom();
    }
}`, 'TST003')).toEqual([]);
  });

  it('accepts this.fail(...), which is what the red scaffold emits', () => {
    expect(only(`
class ConFooTest extends SysTestCase
{
    [SysTestMethod]
    public void notImplementedYet()
    {
        this.fail('notImplementedYet is not implemented yet.');
    }
}`, 'TST003')).toEqual([]);
  });

  it('reports each empty test once, not once per line', () => {
    const found = only(`
class ConFooTest extends SysTestCase
{
    [SysTestMethod]
    public void first()
    {
        ConFoo::a();
        ConFoo::b();
    }

    [SysTestMethod]
    public void second()
    {
        this.assertTrue(true);
    }

    [SysTestMethod]
    public void third()
    {
        ConFoo::c();
    }
}`, 'TST003');

    expect(found.map(v => v.excerpt)).toEqual([
      'public void first()',
      'public void third()',
    ]);
  });

  it('is silent on a class with no test attribute at all', () => {
    expect(only(`
class ConPlainHelper
{
    public void doThing()
    {
    }
}`, 'TST003')).toEqual([]);
  });
});

/**
 * Two false positives a release audit found the day after the rules shipped.
 * Neither was in the full-install sweep's population: shipped code keeps the
 * whole class header on one line and puts its doc comment above the attributes.
 */
describe('TST002 reads a class header that wraps', () => {
  it('finds extends on the continuation line', () => {
    expect(only(`
class ConVeryLongWarehouseScenarioTest
    extends AtlWHSTestCase
{
    [SysTestMethod]
    public void testSomething()
    {
        this.assertTrue(true);
    }
}`, 'TST002')).toEqual([]);
  });

  it('still fires when the wrapped header extends nothing', () => {
    expect(only(`
class ConFooTest
    implements SysTestSetup
{
    [SysTestMethod]
    public void testSomething()
    {
        this.assertTrue(true);
    }
}`, 'TST002')).toHaveLength(1);
  });
});

describe('TST003 walks past every comment spelling between the attribute and the signature', () => {
  it('a line comment, a doc comment and a block comment', () => {
    // maskStringsAndComments turns `///` into `//` + spaces, so a skip that
    // tested for `///` never matched; `//` and `/* */` were not skipped at all.
    // The comment line was then taken as the signature, had no `(`, and the
    // method was silently NOT checked — a false negative here, and the
    // mirror-image false positive in ATTR003.
    const found = only(`
class ConFooTest extends SysTestCase
{
    [SysTestMethod]
    // arranges nothing, asserts nothing
    /// <summary>Doc.</summary>
    /* block */
    public void checksNothing()
    {
        ConFoo::doWork();
    }
}`, 'TST003');
    expect(found).toHaveLength(1);
    expect(found[0].excerpt).toBe('public void checksNothing()');
  });
});
