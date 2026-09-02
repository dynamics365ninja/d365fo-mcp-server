/**
 * The red-phase commentary on a SysTest run.
 *
 * "2/2 passed" means two different things and the result line cannot tell them
 * apart: ordinary news for a test that has existed for weeks, a red flag for one
 * written minutes ago. A test that passes the first time it runs has proven
 * nothing about the assertion inside it — which is why the scaffold emits
 * `this.fail('… is not implemented yet.')` in every method, and why a developer
 * who deletes those while writing the behaviour never sees a red phase at all.
 *
 * Both signals are DERIVED — the session ledger, and the scaffold's own failure
 * text — rather than asked for. An earlier draft published an `expectRed`
 * parameter; it could not ship, because a strict MCP client drops undeclared
 * top-level keys and the tool's schema had 49 chars of headroom. A parameter the
 * caller cannot send is the recurring defect shape this repo has paid for twice.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { _clearRedPhaseMemory, renderRedPhaseNote } from '../../src/tools/sdlc/sysTestRunner';
import {
  _clearCreatedArtifactLedger,
  recordCreatedArtifact,
} from '../../src/workspace/createdArtifactLedger';

const outcome = (name: string, passed: boolean, message?: string) => ({ name, passed, message });

afterEach(() => {
  _clearCreatedArtifactLedger();
  _clearRedPhaseMemory();
});

describe('renderRedPhaseNote — the red phase', () => {
  it('confirms the red phase from the scaffold\'s own failure text', () => {
    const note = renderRedPhaseNote('ConThingTest', [
      outcome('testA', false, 'testA is not implemented yet.'),
      outcome('testB', false, 'testB is not implemented yet.'),
    ]);
    expect(note).toContain('Red phase confirmed');
    expect(note).toContain('2 of 2');
  });

  it('counts only the unwritten ones when a real assertion has landed', () => {
    const note = renderRedPhaseNote('ConThingTest', [
      outcome('testA', false, 'Expected: 30; Actual: 2'),
      outcome('testB', false, 'testB is not implemented yet.'),
    ]);
    expect(note).toContain('1 of 2');
  });
});

describe('renderRedPhaseNote — all green', () => {
  const created = () => recordCreatedArtifact({
    filePath: 'K:/AosService/PackagesLocalDirectory/fm-mcp/fm-mcp/AxClass/ConThingTest.xml',
    objectName: 'ConThingTest',
    objectType: 'class',
  });

  it('warns when everything passes on a class that has never failed here', () => {
    created();
    const note = renderRedPhaseNote('ConThingTest', [outcome('testA', true), outcome('testB', true)]);
    expect(note).toContain('never failed in this session');
    expect(note).toContain('proven nothing');
  });

  /**
   * The defect a live run found, and the reason this file exists in the shape it
   * does. The first version warned on any all-green run of a session-created
   * class — which is EXACTLY what the green half of red-green looks like. It
   * fired on the developer who had just done the right thing.
   *
   * Verified against the real loop on the VM: scaffold (red) -> assertion, wrong
   * behaviour (red) -> implemented (green). Only the last run must be quiet.
   */
  it('is silent on the green that follows a red — that is the loop working', () => {
    created();
    renderRedPhaseNote('ConThingTest', [outcome('testA', false, 'testA is not implemented yet.')]);
    expect(renderRedPhaseNote('ConThingTest', [outcome('testA', true)])).toBe('');
  });

  it('remembers a red run under any casing of the class name', () => {
    created();
    renderRedPhaseNote('conthingtest', [outcome('testA', false, 'Expected: 30; Actual: 2')]);
    expect(renderRedPhaseNote('ConThingTest', [outcome('testA', true)])).toBe('');
  });

  it('does not let one class\'s red run silence another class', () => {
    created();
    renderRedPhaseNote('ConOtherTest', [outcome('testA', false, 'boom')]);
    expect(renderRedPhaseNote('ConThingTest', [outcome('testA', true)])).toContain('never failed');
  });

  it('is silent for a class this session did not create', () => {
    // The whole point of the ledger check: a long-standing suite going green is
    // the normal, desirable outcome and must not be nagged about.
    expect(renderRedPhaseNote('CustTableTest', [outcome('testA', true)])).toBe('');
  });

  it('is case-insensitive about the class name, like the AOT', () => {
    recordCreatedArtifact({
      filePath: 'K:/x/AxClass/ConThingTest.xml', objectName: 'ConThingTest', objectType: 'class',
    });
    expect(renderRedPhaseNote('conthingtest', [outcome('testA', true)])).toContain('never failed');
  });
});

describe('renderRedPhaseNote — silence', () => {
  it('says nothing when the runner produced no per-method outcomes', () => {
    // Without the XML document there is nothing to reason about, and the stdout
    // fallback is explicitly untrustworthy (a test named testErrorHandling reads
    // as a failure).
    expect(renderRedPhaseNote('ConThingTest', [])).toBe('');
  });

  it('says nothing for a failing run whose message is a real assertion', () => {
    // "Expected: 30; Actual: 2" speaks for itself; commentary on it is noise.
    expect(renderRedPhaseNote('ConThingTest', [
      outcome('testA', true),
      outcome('testB', false, 'Expected: 30; Actual: 2'),
    ])).toBe('');
  });
});
