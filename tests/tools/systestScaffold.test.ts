/**
 * The TDD path: scaffold a failing SysTest, prepare the context for one, and read
 * the runner's per-method result.
 *
 * The generated code is checked against the API the platform actually has — the
 * knowledge base used to promise assertExpectedException and a
 * SysTestCaseAutoRollback attribute, neither of which exists, and a scaffold that
 * emits them produces a class that cannot compile.
 */
import { describe, expect, it } from 'vitest';

import { codeGenTool } from '../../src/tools/smart/codeGen.js';
import { runRules } from '../../src/tools/analysis/validateXpp.js';
import { parseSysTestXml } from '../../src/eval/oracle/systest.js';

async function scaffold(
  name: string,
  testMethods?: string[],
  testTargetType?: 'class' | 'table',
): Promise<string> {
  const res = await codeGenTool(
    { params: { arguments: { pattern: 'systest', name, testMethods, testTargetType } } } as never,
    {} as never,
  ) as { content: Array<{ text: string }>; isError?: boolean };
  expect(res.isError, res.content?.[0]?.text).not.toBe(true);
  return res.content[0].text;
}

/** The X++ inside the fenced block, which is what actually gets written. */
function xppOf(text: string): string {
  return /```xpp([\s\S]*?)```/.exec(text)?.[1] ?? '';
}

describe('generate_object(pattern="systest")', () => {
  it('extends SysTestCase and targets the class under test', async () => {
    const text = await scaffold('ConSalesCalculator', ['calculateDiscount']);
    expect(text).toContain('class ConSalesCalculatorTest extends SysTestCase');
    // SysTestTarget's second argument is a utilElementType, not a method name.
    expect(text).toContain('[SysTestTarget(classStr(ConSalesCalculator), UtilElementType::Class)]');
  });

  it('writes one test per requested method, and each one FAILS', async () => {
    const text = await scaffold('ConSalesCalculator', ['calculateDiscount', 'validate']);
    expect(text).toContain('public void testCalculateDiscount()');
    expect(text).toContain('public void testValidate()');
    // Red first: a scaffolded test that passes proves nothing.
    expect(text).toContain("this.fail('testCalculateDiscount is not implemented yet.')");
    expect(text).toContain("this.fail('testValidate is not implemented yet.')");
  });

  it('declares an expected exception the way the framework supports', async () => {
    const text = await scaffold('ConSalesCalculator');
    expect(text).toContain('this.parmExceptionExpected(true)');
    // The name may appear in the comment that explains why it is not used; what
    // must never appear is a CALL to it.
    expect(text).not.toMatch(/\bassertExpectedException\s*\(/);
    expect(text).not.toContain('SysTestCaseAutoRollback');
  });

  it('still produces a class when no methods are named', async () => {
    const text = await scaffold('ConSalesCalculator');
    expect(text).toContain('public void testBehaviour()');
  });

  it('tells the caller the run order and what red means', async () => {
    const text = await scaffold('ConSalesCalculator', ['calculateDiscount']);
    expect(text).toMatch(/Every test fails as written/i);
    expect(text).toMatch(/run_systest_class\(className="ConSalesCalculatorTest"\)/);
    expect(text).toMatch(/TestEssentials/);
  });

  it('emits X++ the offline validator accepts', async () => {
    const text = await scaffold('ConSalesCalculator', ['calculateDiscount']);
    const code = xppOf(text);
    expect(code.length).toBeGreaterThan(100);
    const errors = runRules(code, 'xpp').filter(v => v.severity === 'error');
    expect(errors.map(e => `${e.rule}: ${e.excerpt}`)).toEqual([]);
  });
});

/**
 * The table shape — the one the daily loop needs and the class template cannot
 * express.
 *
 * Every construct asserted here was compiled against real xppc before it was
 * written (`scripts/oracles/probes/coverage-v3b.ts`, probe `TableMethodTest`):
 * UtilElementType::Table, a buffer with initValue(), and
 * assertExpectedInfoLogMessage after the act.
 */
describe('generate_object(pattern="systest", testTargetType="table")', () => {
  it('targets the TABLE, not a class', async () => {
    const text = await scaffold('CustTable', ['validateWrite'], 'table');
    expect(text).toContain('[SysTestTarget(tableStr(CustTable), UtilElementType::Table)]');
    expect(text).toContain('class CustTableTest extends SysTestCase');
    expect(text).not.toContain('classStr(CustTable)');
  });

  it('arranges a buffer instead of constructing a class', async () => {
    const code = xppOf(await scaffold('CustTable', ['validateWrite'], 'table'));
    expect(code).toContain('CustTable custTable;');
    expect(code).toContain('custTable.initValue();');
    // The class template's shape must NOT leak into a table test.
    expect(code).not.toContain('new CustTable()');
  });

  it('asserts the verdict AND the infolog reason for a validation method', async () => {
    const code = xppOf(await scaffold('CustTable', ['validateWrite'], 'table'));
    expect(code).toContain('this.assertFalse(custTable.validateWrite()');
    expect(code).toContain('this.assertExpectedInfoLogMessage(');
    // parmExceptionExpected is the wrong tool here: table validation does not throw.
    expect(code).not.toContain('this.parmExceptionExpected(true)');
  });

  it('writes the accepting case too, so a rule that refuses everything fails', async () => {
    const code = xppOf(await scaffold('CustTable', ['validateWrite'], 'table'));
    expect(code).toContain('public void testValidateWriteRejects()');
    expect(code).toContain('public void testValidateWriteAccepts()');
    expect(code).toContain('this.assertTrue(custTable.validateWrite()');
  });

  it('passes the field id to validateField, which needs one', async () => {
    const code = xppOf(await scaffold('CustTable', ['validateField'], 'table'));
    expect(code).toContain('custTable.validateField(fieldNum(CustTable, <Field>))');
  });

  it('wraps a write method in a transaction and re-reads from the database', async () => {
    const code = xppOf(await scaffold('CustTable', ['insert'], 'table'));
    expect(code).toContain('ttsbegin;');
    expect(code).toContain('ttscommit;');
    expect(code).toContain('select firstonly reread');
  });

  it('warns that the infolog holds resolved TEXT, not the label id', async () => {
    const text = await scaffold('CustTable', ['validateWrite'], 'table');
    expect(text).toMatch(/resolved label text/i);
    expect(text).toMatch(/@Label:Id/);
  });

  it('defaults to validateWrite when no method is named', async () => {
    const code = xppOf(await scaffold('CustTable', undefined, 'table'));
    expect(code).toContain('validateWrite');
  });

  it('emits X++ the offline validator accepts', async () => {
    for (const method of ['validateWrite', 'validateField', 'insert', 'update', 'modifiedField']) {
      const code = xppOf(await scaffold('CustTable', [method], 'table'));
      const errors = runRules(code, 'xpp').filter(v => v.severity === 'error');
      expect(errors.map(e => `${method} → ${e.rule}: ${e.excerpt}`)).toEqual([]);
    }
  });

  it('leaves the class shape alone when testTargetType is absent', async () => {
    const text = await scaffold('ConSalesCalculator', ['calculateDiscount']);
    expect(text).toContain('UtilElementType::Class');
    expect(text).not.toContain('initValue()');
  });
});

describe('parseSysTestXml — per-method outcomes from the runner document', () => {
  const doc = `<?xml version="1.0"?>
<test-results>
  <results>
    <test-case name="ConSalesCalculatorTest.testCalculateDiscount" success="true" time="0.10" />
    <test-case name="ConSalesCalculatorTest.testValidate" success="false" time="0.20">
      <failure>
        <message>Expected: 10 but was: 0</message>
      </failure>
    </test-case>
  </results>
</test-results>`;

  it('reads the name and outcome of each test case', () => {
    const outcomes = parseSysTestXml(doc);
    expect(outcomes).toHaveLength(2);
    expect(outcomes[0]).toEqual({ name: 'ConSalesCalculatorTest.testCalculateDiscount', passed: true });
    expect(outcomes[1].passed).toBe(false);
    expect(outcomes[1].message).toBe('Expected: 10 but was: 0');
  });

  it('falls back to the failure child when there is no success attribute', () => {
    const outcomes = parseSysTestXml(
      '<test-results><results><test-case name="A"><failure><message>boom</message></failure></test-case>' +
      '<test-case name="B"></test-case></results></test-results>',
    );
    expect(outcomes.map(o => o.passed)).toEqual([false, true]);
  });

  it('returns nothing for text that is not a result document, so callers can fall back', () => {
    expect(parseSysTestXml('SysTestConsole: 3 tests passed')).toEqual([]);
    expect(parseSysTestXml('')).toEqual([]);
    expect(parseSysTestXml(undefined)).toEqual([]);
  });

  it('does not read the word "error" in a test name as a failure', () => {
    // The regex classifier this replaced reported a green run as failed whenever
    // a method was called something like testErrorHandling.
    const outcomes = parseSysTestXml(
      '<test-results><results><test-case name="MyTest.testErrorHandling" success="true"/></results></test-results>',
    );
    expect(outcomes[0].passed).toBe(true);
  });
});
