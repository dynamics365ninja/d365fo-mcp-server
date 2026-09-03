/**
 * The red-green cycle, pinned from BOTH runs (`L2-tdd-red-green-cycle`).
 *
 * Every other case in this catalog commits the green document, and a green
 * document alone cannot tell a working test from an empty one — this repo has
 * paid for that reading more than once. So this case ran the cycle on the VM and
 * kept both: the same test class against a deliberately unfinished
 * implementation, then against a fixed one, with nothing about the test changed
 * between the two.
 *
 * What the pair proves that neither half can prove alone: the assertion is
 * capable of failing, it failed for the stated reason, and the ONLY thing that
 * made it pass was the implementation.
 */

import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { parseSysTestXml } from '../../src/eval/oracle/systest.js';

const read = (file: string) =>
  fs.readFileSync(path.join(process.cwd(), 'eval', 'systests', file), 'utf8');

const RED = 'L2-tdd-red-green-cycle.red.xml';
const GREEN = 'L2-tdd-red-green-cycle.xml';

describe('red-green cycle — the red half', () => {
  it('recorded a run in which the test FAILED', () => {
    const outcomes = parseSysTestXml(read(RED));

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].passed).toBe(false);
  });

  it('failed on the assertion, naming expected and actual — not on a broken build', () => {
    const failed = parseSysTestXml(read(RED))[0];

    // Red means a failing assertion. A compile error would have produced no
    // document at all, and an exception would carry a different message.
    expect(failed.message).toContain('tier 2 must be 10 percent');
    expect(failed.message).toContain('Expected: 10');
    expect(failed.message).toContain('Actual: 0');
  });
});

describe('red-green cycle — the green half', () => {
  it('recorded the same single test, passing', () => {
    const outcomes = parseSysTestXml(read(GREEN));

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].passed).toBe(true);
  });

  it('is the SAME test method as the red run, so only the implementation changed', () => {
    const red = parseSysTestXml(read(RED))[0];
    const green = parseSysTestXml(read(GREEN))[0];

    expect(green.name).toBe(red.name);
  });
});
