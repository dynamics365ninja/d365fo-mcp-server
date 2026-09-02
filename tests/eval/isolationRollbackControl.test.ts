/**
 * The isolation case's oracle must DISCRIMINATE, not merely pass.
 *
 * `L2-systest-attributes-isolation` proves that SysTest rolls each test back, and
 * it does so with two methods that each assert an EMPTY table and then write to
 * it. Two such methods can only both pass if the framework undid the other one.
 *
 * That argument is only worth anything if the same two methods FAIL when rollback
 * is off — otherwise they might be passing for some reason nobody thought of, and
 * a green case would prove nothing. So the pair was run twice on the VM
 * (2026-09-02): once as the case, once with `[SysTestTransaction(TestTransactionMode::None)]`
 * and nothing else changed. Both documents are committed and both are read here.
 *
 * The negative run also left a row behind in the sandbox, which is the clearest
 * possible statement of what TestTransactionMode::None means.
 */
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { parseSysTestXml } from '../../src/eval/oracle/systest.js';

const read = (file: string) =>
  parseSysTestXml(fs.readFileSync(path.join(process.cwd(), 'eval', 'systests', file), 'utf8'));

const CASE = 'L2-systest-attributes-isolation.xml';
const CONTROL = 'L2-systest-attributes-isolation.negative-control.xml';

describe('isolation case — the rollback oracle', () => {
  it('the case itself is green on both methods', () => {
    const outcomes = read(CASE);

    expect(outcomes).toHaveLength(2);
    expect(outcomes.every(o => o.passed)).toBe(true);
  });

  it('the same methods FAIL with rollback off — so the green run means something', () => {
    const outcomes = read(CONTROL);

    expect(outcomes).toHaveLength(2);
    const failed = outcomes.filter(o => !o.passed);
    // Exactly one: whichever ran second saw the first one's row. Which of the two
    // that is depends on execution order, and the case is deliberately written so
    // that the order does not matter.
    expect(failed).toHaveLength(1);
  });

  it('fails for the RIGHT reason — the table was not empty', () => {
    const failed = read(CONTROL).find(o => !o.passed);

    expect(failed?.message).toContain('the table must be empty at the start of every test');
    expect(failed?.message).toContain('Expected: 0');
    expect(failed?.message).toContain('Actual: 1');
  });
});

describe('ATL case — the runtime half', () => {
  it('both ATL fixtures resolved against real data', () => {
    const outcomes = read('L3-test-data-atl.xml');

    expect(outcomes).toHaveLength(2);
    expect(outcomes.every(o => o.passed)).toBe(true);
  });
});
