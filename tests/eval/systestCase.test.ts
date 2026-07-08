/**
 * Runtime-oracle asset gates (VM-free) for the `systest`-backed cases.
 *
 * Locks in each committed SysTest class and its wiring to the case spec, so a
 * malformed test class or a broken systest path is caught in CI without the
 * D365FO platform. Goldens for all three cases below were captured on the VM
 * — see eval/goldens/<case_id>/. Live SysTest runs are still pending
 * (`systest_pending: true`) for all three: SysTestConsole.exe unconditionally
 * waits on a debugger-attach keypress (Console.ReadKey) even in local-AOS mode,
 * which fails in this non-interactive automation session regardless of the
 * run_systest_class binary/args fix (src/tools/sysTestRunner.ts). This only
 * validates the static contract and that parseSysTestResult scores each class's
 * output; the live run needs an interactive console session.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { parseSysTestResult } from '../../src/eval/oracle/systest';
import { scoreRun } from '../../src/eval/oracle/score';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');

const CASE_ID = 'L2-coc-extension';
const TEST_CLASS = 'EvalL2CocCarFactsTest';

const caseSpec = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, 'eval', 'cases', `${CASE_ID}.json`), 'utf8'),
);
const systestXml = fs.readFileSync(
  path.join(REPO_ROOT, caseSpec.systest),
  'utf8',
);

describe('L2-coc-extension SysTest asset', () => {
  it('the case points at an on-disk systest file', () => {
    expect(caseSpec.systest).toBe('eval/systests/L2-coc-extension.xml');
    expect(fs.existsSync(path.join(REPO_ROOT, caseSpec.systest))).toBe(true);
  });

  it('has a committed golden and a pending live SysTest run, in the holdout split', () => {
    expect(caseSpec.golden_pending).toBeFalsy();
    const goldenDir = path.join(REPO_ROOT, 'eval', 'goldens', CASE_ID);
    expect(fs.existsSync(goldenDir) && fs.readdirSync(goldenDir).some(f => f.endsWith('.metadata.xml'))).toBe(true);
    expect(caseSpec.systest_pending).toBe(true);
    expect(caseSpec.split).toBe('holdout');
  });

  it('is a SysTestCase whose name matches the run_systest_class target', () => {
    expect(systestXml).toMatch(new RegExp(`<Name>${TEST_CLASS}</Name>`));
    expect(systestXml).toMatch(new RegExp(`class\\s+${TEST_CLASS}\\s+extends\\s+SysTestCase`));
  });

  it('exercises the wrapped method transparently and asserts the wrapper transform', () => {
    // Never references the wrapper class (CoC is transparent), but does call the
    // standard method and assert the appended suffix — the behavioural signal.
    expect(systestXml).not.toMatch(/ExtensionOf|_Extension/);
    expect(systestXml).toMatch(/CarFactsSummary\(/);
    expect(systestXml).toMatch(/\[verified\]/);
    expect(systestXml).toMatch(/\[SysTestCheckInTestAttribute\]/);
  });

  it('scores systest=1 when this class passes and systest=0 when it fails', () => {
    const passed = parseSysTestResult(
      `✅ Tests passed\n\nClass: ${TEST_CLASS}\nModel: fm-mcp\n\nSysTestRunner: 2 tests run, 2 passed, 0 failed.`,
    );
    expect(passed).toEqual({ ran: true, passed: true, failures: [] });

    const failed = parseSysTestResult(
      `❌ Tests FAILED\n\nClass: ${TEST_CLASS}\nModel: fm-mcp\n\n` +
        `SysTestRunner: 2 tests run, 1 passed, 1 failed.\n` +
        `${TEST_CLASS}::testCarFactsSummaryAppendsVerifiedSuffix failed: ` +
        `Assert.areEqual expected 'Adventure Works Fuji [verified]' actual 'Adventure Works Fuji'`,
    );
    expect(failed.ran).toBe(true);
    expect(failed.passed).toBe(false);
    expect(failed.failures[0].test).toBe(`${TEST_CLASS}::testCarFactsSummaryAppendsVerifiedSuffix`);

    const build = { succeeded: true, bpWarnings: [] };
    const goldenDiff = { matched: true, missing: [], extra: [], changed: [] };
    expect(scoreRun({ build, goldenDiff, tier: 2, systest: passed }).systest).toBe(1);
    expect(scoreRun({ build, goldenDiff, tier: 2, systest: failed }).systest).toBe(0);
  });
});

describe('L3-batch-basic SysTest asset', () => {
  const CASE_ID = 'L3-batch-basic';
  const TEST_CLASS = 'EvalL3BatchCalcTest';

  const caseSpec3 = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, 'eval', 'cases', `${CASE_ID}.json`), 'utf8'),
  );
  const systestXml3 = fs.readFileSync(path.join(REPO_ROOT, caseSpec3.systest), 'utf8');

  it('the case points at an on-disk systest file', () => {
    expect(caseSpec3.systest).toBe('eval/systests/L3-batch-basic.xml');
    expect(fs.existsSync(path.join(REPO_ROOT, caseSpec3.systest))).toBe(true);
  });

  it('has all 4 committed golden artifacts and a pending live SysTest run, in the holdout split', () => {
    expect(caseSpec3.golden_pending).toBeFalsy();
    const goldenDir = path.join(REPO_ROOT, 'eval', 'goldens', CASE_ID);
    const goldenFiles = fs.existsSync(goldenDir) ? fs.readdirSync(goldenDir).filter(f => f.endsWith('.metadata.xml')) : [];
    expect(goldenFiles.length).toBe(4);
    expect(caseSpec3.systest_pending).toBe(true);
    expect(caseSpec3.split).toBe('holdout');
  });

  it('is a SysTestCase whose name matches the run_systest_class target', () => {
    expect(systestXml3).toMatch(new RegExp(`<Name>${TEST_CLASS}</Name>`));
    expect(systestXml3).toMatch(new RegExp(`class\\s+${TEST_CLASS}\\s+extends\\s+SysTestCase`));
  });

  it('exercises the Contract + Service directly and asserts the pure arithmetic', () => {
    // Unlike CoC (transparent), a batch Service is unit-tested directly —
    // referencing it by name is correct here, not a leak.
    expect(systestXml3).toMatch(/ConDemoBatchContract/);
    expect(systestXml3).toMatch(/ConDemoBatchService/);
    expect(systestXml3).toMatch(/calculateEffectiveBatchSize/);
    expect(systestXml3).toMatch(/\[SysTestCheckInTestAttribute\]/);
  });

  it('scores systest=1 when this class passes and systest=0 when it fails', () => {
    const passed = parseSysTestResult(
      `✅ Tests passed\n\nClass: ${TEST_CLASS}\nModel: fm-mcp\n\nSysTestRunner: 2 tests run, 2 passed, 0 failed.`,
    );
    expect(passed).toEqual({ ran: true, passed: true, failures: [] });

    const failed = parseSysTestResult(
      `❌ Tests FAILED\n\nClass: ${TEST_CLASS}\nModel: fm-mcp\n\n` +
        `SysTestRunner: 2 tests run, 1 passed, 1 failed.\n` +
        `${TEST_CLASS}::testEffectiveBatchSizeMultipliesByPriorityFactor failed: ` +
        `Assert.areEqual expected 30 actual 13`,
    );
    expect(failed.ran).toBe(true);
    expect(failed.passed).toBe(false);
    expect(failed.failures[0].test).toBe(`${TEST_CLASS}::testEffectiveBatchSizeMultipliesByPriorityFactor`);

    const build = { succeeded: true, bpWarnings: [] };
    const goldenDiff = { matched: true, missing: [], extra: [], changed: [] };
    expect(scoreRun({ build, goldenDiff, tier: 3, systest: passed }).systest).toBe(1);
    expect(scoreRun({ build, goldenDiff, tier: 3, systest: failed }).systest).toBe(0);
  });
});

describe('L2-event-handler-basic SysTest asset', () => {
  const CASE_ID = 'L2-event-handler-basic';
  const TEST_CLASS = 'EvalL2EventHandlerDefaultSubjectTest';

  const caseSpec4 = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, 'eval', 'cases', `${CASE_ID}.json`), 'utf8'),
  );
  const systestXml4 = fs.readFileSync(path.join(REPO_ROOT, caseSpec4.systest), 'utf8');

  it('the case points at an on-disk systest file', () => {
    expect(caseSpec4.systest).toBe('eval/systests/L2-event-handler-basic.xml');
    expect(fs.existsSync(path.join(REPO_ROOT, caseSpec4.systest))).toBe(true);
  });

  it('has a committed golden and a pending live SysTest run, in the holdout split', () => {
    expect(caseSpec4.golden_pending).toBeFalsy();
    const goldenDir = path.join(REPO_ROOT, 'eval', 'goldens', CASE_ID);
    expect(fs.existsSync(goldenDir) && fs.readdirSync(goldenDir).some(f => f.endsWith('.metadata.xml'))).toBe(true);
    expect(caseSpec4.systest_pending).toBe(true);
    expect(caseSpec4.split).toBe('holdout');
  });

  it('is a SysTestCase whose name matches the run_systest_class target', () => {
    expect(systestXml4).toMatch(new RegExp(`<Name>${TEST_CLASS}</Name>`));
    expect(systestXml4).toMatch(new RegExp(`class\\s+${TEST_CLASS}\\s+extends\\s+SysTestCase`));
  });

  it('exercises both the defaulted and the explicit-Subject paths', () => {
    expect(systestXml4).toMatch(/ConDemoNoteHeader/);
    expect(systestXml4).toMatch(/\(no subject\)/);
    expect(systestXml4).toMatch(/Explicit subject/);
    expect(systestXml4).toMatch(/\[SysTestCheckInTestAttribute\]/);
  });

  it('scores systest=1 when this class passes and systest=0 when it fails', () => {
    const passed = parseSysTestResult(
      `✅ Tests passed\n\nClass: ${TEST_CLASS}\nModel: fm-mcp\n\nSysTestRunner: 2 tests run, 2 passed, 0 failed.`,
    );
    expect(passed).toEqual({ ran: true, passed: true, failures: [] });

    const failed = parseSysTestResult(
      `❌ Tests FAILED\n\nClass: ${TEST_CLASS}\nModel: fm-mcp\n\n` +
        `SysTestRunner: 2 tests run, 1 passed, 1 failed.\n` +
        `${TEST_CLASS}::testInsertingWithBlankSubjectGetsDefaulted failed: ` +
        `Assert.areEqual expected '(no subject)' actual ''`,
    );
    expect(failed.ran).toBe(true);
    expect(failed.passed).toBe(false);
    expect(failed.failures[0].test).toBe(`${TEST_CLASS}::testInsertingWithBlankSubjectGetsDefaulted`);

    const build = { succeeded: true, bpWarnings: [] };
    const goldenDiff = { matched: true, missing: [], extra: [], changed: [] };
    expect(scoreRun({ build, goldenDiff, tier: 2, systest: passed }).systest).toBe(1);
    expect(scoreRun({ build, goldenDiff, tier: 2, systest: failed }).systest).toBe(0);
  });
});
