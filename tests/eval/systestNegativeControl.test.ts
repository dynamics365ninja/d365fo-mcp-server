/**
 * The runtime oracle must DISCRIMINATE, not merely run.
 *
 * `SysTestConsole` was blocked for weeks, and when it finally executed it
 * reported success — which tells you the instrument is on and nothing else. This
 * repo has twice paid for reading an all-green instrument as a working one: a
 * probe that reported nothing was taken for a probe that passed, and a golden
 * that had silently lost its attributes was committed as proof.
 *
 * So a control class was built and run on the VM with three methods — one that
 * must pass, one that fails an assertion, one that fails by throwing — and the
 * document it produced is the fixture here. It is a REAL SysTestListenerXML
 * output (2026-08-31 16:33), trimmed only of its multi-KB .NET call stacks,
 * because a synthetic document proves the parser handles what its author already
 * imagined.
 *
 * What this pins: the parser distinguishes both failure modes from the pass, in
 * one run, and carries each failure's message.
 */
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { parseSysTestXml } from '../../src/eval/oracle/systest.js';

const FIXTURE = path.join(process.cwd(), 'tests', 'fixtures', 'systest', 'negative-control.xml');
const outcomes = () => parseSysTestXml(fs.readFileSync(FIXTURE, 'utf8'));

describe('runtime oracle — the negative control document', () => {
  it('reads every method the run produced', () => {
    expect(outcomes()).toHaveLength(3);
  });

  it('reports the passing method as passed', () => {
    const pass = outcomes().find(o => o.name.endsWith('testControlPasses'));
    expect(pass?.passed).toBe(true);
  });

  it('reports a failed ASSERTION as failed, with its message', () => {
    const failed = outcomes().find(o => o.name.endsWith('testControlFailsByAssertion'));
    expect(failed?.passed).toBe(false);
    expect(failed?.message).toMatch(/Expected: 99; Actual: 2/);
  });

  it('reports a THROWN error as failed too — a different failure mode', () => {
    const thrown = outcomes().find(o => o.name.endsWith('testControlFailsByThrow'));
    expect(thrown?.passed).toBe(false);
    expect(thrown?.message).toMatch(/DELIBERATE/);
  });

  it('does not report the whole run as passing because one method did', () => {
    // The property that makes the oracle usable: a single failure is visible
    // even beside a success in the same suite.
    expect(outcomes().some(o => !o.passed)).toBe(true);
  });
});
