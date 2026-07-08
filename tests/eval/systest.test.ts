/**
 * SysTest runtime-oracle parser — turns run_systest_class output into
 * { ran, passed, failures }. Fixtures mirror the real tool's header forms
 * (src/tools/sysTestRunner.ts).
 */

import { describe, it, expect } from 'vitest';
import { parseSysTestResult } from '../../src/eval/oracle/systest';
import { scoreRun } from '../../src/eval/oracle/score';

const PASSED = `✅ Tests passed

Class: ContosoNoteStatusTest
Model: Contoso

SysTestRunner: 3 tests run, 3 passed, 0 failed.`;

const FAILED = `❌ Tests FAILED

Class: ContosoNoteStatusTest
Model: Contoso

SysTestRunner: 3 tests run, 2 passed, 1 failed.
ContosoNoteStatusTest::testArchivedTransition failed: Assert.areEqual expected 'Archived' actual 'Active'`;

const INDETERMINATE = `⚠️ Tests completed (check output)

Class: ContosoThing
Model: Contoso

(no recognizable pass/fail markers)`;

const RUNNER_MISSING = `❌ Neither SysTestConsole.exe nor SysTestRunner.exe found in:
K:\\AOSService\\PackagesLocalDirectory\\Bin`;

const EXEC_ERROR = `❌ Tests failed:

Error: spawn SysTestConsole.exe ENOENT`;

const INTERACTIVE_CONSOLE_REQUIRED = `❌ SysTestConsole.exe requires an interactive console session.

It unconditionally calls a debugger-attach prompt (Console.ReadKey) before running any
test, even in local-AOS mode. This fails when invoked from a non-interactive/automation
session (no real console available).

Unhandled Exception: System.InvalidOperationException: Cannot read keys when either
application does not have a console or when console input has been redirected from a file.
   at System.Console.ReadKey(Boolean intercept)
   at Microsoft.Dynamics.AX.Framework.SysTest.SysTestConsole.WaitForDebugger()`;

describe('parseSysTestResult', () => {
  it('passed run → ran, passed=true, no failures', () => {
    expect(parseSysTestResult(PASSED)).toEqual({ ran: true, passed: true, failures: [] });
  });

  it('failed run → ran, passed=false, extracts the failing test + message', () => {
    const r = parseSysTestResult(FAILED);
    expect(r.ran).toBe(true);
    expect(r.passed).toBe(false);
    expect(r.failures.length).toBeGreaterThanOrEqual(1);
    expect(r.failures.some(f => f.test === 'ContosoNoteStatusTest::testArchivedTransition')).toBe(true);
    expect(r.failures.some(f => /Assert\.areEqual/.test(f.message))).toBe(true);
  });

  it('indeterminate completion → ran, passed=null', () => {
    expect(parseSysTestResult(INDETERMINATE)).toEqual({ ran: true, passed: null, failures: [] });
  });

  it('runner not found → did NOT run (passed=null)', () => {
    expect(parseSysTestResult(RUNNER_MISSING)).toEqual({ ran: false, passed: null, failures: [] });
  });

  it('exec/exception error → did NOT run (not a test failure)', () => {
    expect(parseSysTestResult(EXEC_ERROR)).toEqual({ ran: false, passed: null, failures: [] });
  });

  it('interactive-console-required blocker → did NOT run (not a test failure)', () => {
    expect(parseSysTestResult(INTERACTIVE_CONSOLE_REQUIRED)).toEqual({ ran: false, passed: null, failures: [] });
  });

  it('empty / missing output → did NOT run', () => {
    expect(parseSysTestResult('')).toEqual({ ran: false, passed: null, failures: [] });
    expect(parseSysTestResult(undefined)).toEqual({ ran: false, passed: null, failures: [] });
  });

  it('derives pass/fail from a count summary when the header is absent', () => {
    expect(parseSysTestResult('5 tests run, 5 passed, 0 failed').passed).toBe(true);
    expect(parseSysTestResult('5 tests run, 4 passed, 1 failed').passed).toBe(false);
  });
});

describe('systest feeds the scorecard', () => {
  it('a failed SysTest scores systest=0; a passed one scores 1; not-run stays null', () => {
    const matched = { matched: true, missing: [], extra: [], changed: [] };
    const base = { build: { succeeded: true, bpWarnings: [] }, goldenDiff: matched, tier: 2 };
    expect(scoreRun({ ...base, systest: parseSysTestResult(FAILED) }).systest).toBe(0);
    expect(scoreRun({ ...base, systest: parseSysTestResult(PASSED) }).systest).toBe(1);
    expect(scoreRun({ ...base, systest: parseSysTestResult(RUNNER_MISSING) }).systest).toBeNull();
  });
});
