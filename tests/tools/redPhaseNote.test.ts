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
import { renderRedPhaseNote } from '../../src/tools/sdlc/sysTestRunner';
import {
  _clearCreatedArtifactLedger,
  recordCreatedArtifact,
} from '../../src/workspace/createdArtifactLedger';

const outcome = (name: string, passed: boolean, message?: string) => ({ name, passed, message });

afterEach(() => _clearCreatedArtifactLedger());

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
  it('warns when everything passes on a class created in this session', () => {
    recordCreatedArtifact({
      filePath: 'K:/AosService/PackagesLocalDirectory/fm-mcp/fm-mcp/AxClass/ConThingTest.xml',
      objectName: 'ConThingTest',
      objectType: 'class',
    });
    const note = renderRedPhaseNote('ConThingTest', [outcome('testA', true), outcome('testB', true)]);
    expect(note).toContain('created in this session');
    expect(note).toContain('proven nothing');
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
    expect(renderRedPhaseNote('conthingtest', [outcome('testA', true)])).toContain('created in this session');
  });
});

describe('renderRedPhaseNote — silence', () => {
  it('says nothing when the runner produced no per-method outcomes', () => {
    // Without the XML document there is nothing to reason about, and the stdout
    // fallback is explicitly untrustworthy (a test named testErrorHandling reads
    // as a failure).
    expect(renderRedPhaseNote('ConThingTest', [])).toBe('');
  });

  it('says nothing for a mixed run with no scaffold markers', () => {
    expect(renderRedPhaseNote('ConThingTest', [
      outcome('testA', true),
      outcome('testB', false, 'Expected: 30; Actual: 2'),
    ])).toBe('');
  });
});
