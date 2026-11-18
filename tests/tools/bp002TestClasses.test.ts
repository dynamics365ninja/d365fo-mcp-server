/**
 * BP002 (doInsert/doUpdate/doDelete) stays quiet in SysTest test classes, where do*
 * is how a fixture is set up, and keeps firing in production code.
 *
 * Shipped baseline (platform 10.0.2790): 82 of the 359 classes deriving from
 * SysTestCase use do*. Only 3 extend SysTestCase directly and 10 carry
 * [SysTestMethod], so most of them are recognised only through the index.
 */

import { describe, it, expect } from 'vitest';
import { runRules, validateXppTool } from '../../src/tools/analysis/validateXpp';
import { isTestClassInIndex, isTestClassSource } from '../../src/tools/analysis/testClassContext';
import { maskStringsAndComments } from '../../src/tools/analysis/validateXpp';
import type { DbLike } from '../../src/utils/symbolLookup';

const text = (r: any): string => r.content?.[0]?.text ?? '';
const bp002 = (code: string) => runRules(code, 'xpp').filter(v => v.rule === 'BP002');

/** A symbol index holding just a class hierarchy (name → base). */
function fakeIndex(hierarchy: Record<string, string | null>): DbLike {
  const row = (name: string) => {
    const key = Object.keys(hierarchy).find(k => k.toLowerCase() === name.toLowerCase());
    return key === undefined
      ? []
      : [{ name: key, type: 'class', model: 'ContosoCore', extends_class: hierarchy[key], file_path: null }];
  };
  return {
    prepare: (sql: string) => ({
      all: (...p: unknown[]) => (/s\.name = \?/.test(sql) ? row(String(p[0])) : []),
      get: () => undefined,
    }),
  };
}

const HIERARCHY = {
  SysTestCase: null,
  ContosoWhsTestCase: 'SysTestCase',
  ContosoRentPostingTest: 'ContosoWhsTestCase',
  ContosoRentPostingService: 'RunBaseBatch',
  RunBaseBatch: 'RunBase',
  RunBase: null,
};
const ctx = (h = HIERARCHY) => ({ symbolIndex: { getReadDb: () => fakeIndex(h) } }) as any;
const req = (args: Record<string, unknown>) => ({ params: { name: 'validate_code', arguments: args } });

const FIXTURE_METHOD = `
    public void setUp()
    {
        ContosoRentTable rent;
        rent.RentId = 'R1';
        rent.doInsert();
    }`;

describe('BP002 is not raised in test classes', () => {
  it('a class that extends SysTestCase directly', () => {
    const code = `class ContosoRentTest extends SysTestCase\n{\n${FIXTURE_METHOD}\n}`;
    expect(bp002(code)).toHaveLength(0);
  });

  it('a class with [SysTestMethod] whose base is another test case', () => {
    const code = `class ContosoRentTest extends ContosoWhsTestCase\n{\n${FIXTURE_METHOD}\n
    [SysTestMethod]
    public void postsRent()
    {
        ContosoRentTable rent;
        rent.doUpdate();
        this.assertEquals(1, 1);
    }\n}`;
    expect(bp002(code)).toHaveLength(0);
  });

  it('a declaration whose base reaches SysTestCase in the index', async () => {
    const code = `class ContosoRentPostingTest extends ContosoWhsTestCase\n{\n${FIXTURE_METHOD}\n}`;
    expect(bp002(code)).toHaveLength(1); // source alone cannot tell
    expect(text(await validateXppTool(req({ code }), ctx()))).not.toContain('BP002');
  });

  it('a bare method whose context names an indexed test class', async () => {
    const r = await validateXppTool(req({ code: FIXTURE_METHOD, context: 'ContosoRentPostingTest.setUp' }), ctx());
    expect(text(r)).not.toContain('BP002');
  });
});

describe('BP002 is still raised in production code', () => {
  it('a bare call with no class context', () => {
    expect(bp002('custTable.doInsert();')).toHaveLength(1);
  });

  it('a production class, even with "Test" in its name', async () => {
    const code = `class ContosoTestDataImport extends RunBaseBatch\n{\n${FIXTURE_METHOD}\n}`;
    expect(bp002(code)).toHaveLength(1);
    expect(text(await validateXppTool(req({ code }), ctx()))).toContain('BP002');
  });

  it('a bare method whose context is a production class in the index', async () => {
    const r = await validateXppTool(req({ code: FIXTURE_METHOD, context: 'ContosoRentPostingService' }), ctx());
    expect(text(r)).toContain('BP002');
  });

  it('a context the index does not know, or no index at all', async () => {
    expect(text(await validateXppTool(req({ code: FIXTURE_METHOD, context: 'ContosoUnknown' }), ctx()))).toContain('BP002');
    expect(text(await validateXppTool(req({ code: FIXTURE_METHOD, context: 'ContosoRentPostingTest' })))).toContain('BP002');
  });

  it('SysTestCase or [SysTestMethod] inside a string or comment does not count', () => {
    const code = `class ContosoRentJob extends RunBase\n{\n    // extends SysTestCase [SysTestMethod]\n    str s = '[SysTestMethod]';\n${FIXTURE_METHOD}\n}`;
    expect(bp002(code)).toHaveLength(1);
  });
});

describe('testClassContext helpers', () => {
  it('isTestClassSource reads masked source', () => {
    expect(isTestClassSource(maskStringsAndComments('class A extends SysTestCase {}'))).toBe(true);
    expect(isTestClassSource(maskStringsAndComments('class A extends SysTestCaseHelper {}'))).toBe(false);
  });

  it('isTestClassInIndex walks the chain and stops at unknown names', () => {
    const db = fakeIndex(HIERARCHY);
    expect(isTestClassInIndex(db, 'class ContosoRentPostingTest {}')).toBe(true);
    expect(isTestClassInIndex(db, '', 'ContosoRentPostingTest::setUp')).toBe(true);
    expect(isTestClassInIndex(db, 'class ContosoRentPostingService {}')).toBe(false);
    expect(isTestClassInIndex(db, '', 'not a name')).toBe(false);
  });
});
