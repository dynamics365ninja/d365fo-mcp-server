/**
 * The golden-capture gates.
 *
 * `scripts/capture-golden.ts` exists because this step had no script and every
 * implementer re-derived it from memory. That is only an improvement if the gates
 * are right, and two of them fail in opposite directions:
 *
 *  - The build-log check must be NARROW. A loose /error/i matches an object named
 *    `ErrorHandler`, a BP finding that contains the word, or a test called
 *    `testErrorHandling` — refusing a clean build teaches the operator to reach
 *    for `--build-ok`, and then the gate is gone. The same mistake is documented
 *    in `src/cli/session/copilotChatLog.ts`, where a loose regex turned a
 *    2-failure session into a 22-failure one.
 *  - It must still catch the shapes the build tool and xppc really emit, because
 *    a golden captured from a model that never compiled asserts code the compiler
 *    rejects — and nothing downstream can tell.
 *
 * The root-element reader is here for a defect this repo has already shipped
 * once: a root element read out of an XML comment (CodeQL, CHANGELOG 1.16.0).
 */

import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { buildLogFailure, rootElementOf } from '../../scripts/capture-golden';

describe('buildLogFailure — refuses a broken build', () => {
  it('catches the tool\'s own failure marker', () => {
    expect(buildLogFailure('❌ Build failed with 3 error(s)')).toBeDefined();
  });

  it('catches an xppc fatal', () => {
    expect(buildLogFailure('Compile Fatal Error: must be named \'ConDemoX\' instead of \'X\'')).toBeDefined();
  });

  it('catches a coded compiler diagnostic', () => {
    expect(buildLogFailure('ConDemoRule.xpp(12): error CS0103: name not found')).toBeDefined();
  });

  it('catches a structured false verdict', () => {
    expect(buildLogFailure('{ "succeeded": false, "errors": [] }')).toBeDefined();
  });
});

describe('buildLogFailure — does not refuse a clean build', () => {
  it('passes a plain success line', () => {
    expect(buildLogFailure('✅ Build succeeded: 0 errors, 0 warnings')).toBeUndefined();
  });

  it('passes an object whose NAME contains "error"', () => {
    expect(
      buildLogFailure('✅ Build succeeded\nCompiled: ConDemoErrorHandler, ConDemoErrorLogTable'),
    ).toBeUndefined();
  });

  it('passes a BP warning that merely says the word', () => {
    expect(
      buildLogFailure('Build succeeded.\nBP warning: BPErrorLabelIsText on ConDemoNote.Subject'),
    ).toBeUndefined();
  });

  it('passes a test method named after error handling', () => {
    expect(buildLogFailure('Rainier Test Suite : 2 Run, 0 Failed\n  testErrorHandling passed')).toBeUndefined();
  });

  it('passes a structured true verdict', () => {
    expect(buildLogFailure('{ "succeeded": true, "errors": [], "bpWarnings": [] }')).toBeUndefined();
  });
});

describe('rootElementOf', () => {
  it('reads the AOT root of a normal document', () => {
    expect(rootElementOf('<?xml version="1.0" encoding="utf-8"?>\n<AxTable xmlns:i="…">\n  <Name>X</Name>'))
      .toBe('AxTable');
  });

  it('survives a BOM', () => {
    expect(rootElementOf('﻿<?xml version="1.0"?><AxClass><Name>X</Name>')).toBe('AxClass');
  });

  it('does not read the root out of a comment', () => {
    expect(rootElementOf('<?xml version="1.0"?>\n<!-- <AxForm> was here -->\n<AxTable><Name>X</Name>'))
      .toBe('AxTable');
  });

  it('answers undefined for text that is not metadata', () => {
    expect(rootElementOf('class ConDemoThing { }')).toBeUndefined();
  });

  /**
   * The shape CodeQL flagged as js/incomplete-multi-character-sanitization.
   *
   * The first version of this reader stripped comments with one `replace()` pass
   * and then matched the first element. On nested or unterminated input a single
   * pass leaves a comment opener behind, so the very next match reads the root
   * OUT OF A COMMENT — the exact defect this repo already shipped and fixed once
   * (CHANGELOG 1.16.0). The fix was not a better regex; it was to stop having a
   * second reader and delegate to `aotRootElement`, which consumes prologue
   * tokens in order.
   */
  it('does not read a root out of a NESTED comment', () => {
    const xml = [
      '<?xml version="1.0"?>',
      '<!-- <!-- <AxForm> --> -->',
      '<AxTable><Name>X</Name>',
    ].join('\n');
    expect(rootElementOf(xml)).not.toBe('AxForm');
  });

  it('does not invent a root from an UNTERMINATED comment', () => {
    // Nothing after the opener is a real element, so the honest answer is none.
    const xml = ['<?xml version="1.0"?>', '<!-- <AxForm> and then the file ends'].join('\n');
    expect(rootElementOf(xml)).toBeUndefined();
  });
});

/**
 * The CLI half. Spawning is the only way to observe a refusal, since each one
 * exits non-zero — and exiting non-zero IS the contract: a half-captured golden
 * fails later, in CI, on a machine that cannot re-capture.
 */
describe('capture-golden CLI refusals', () => {
  // node + the tsx loader rather than `npx tsx`: `npx` needs a shell on Windows,
  // and passing args through a shell is both a deprecation warning and a quoting
  // hazard for the very argument shapes this CLI parses.
  const run = (args: string[]): { status: number; output: string } => {
    try {
      const out = execFileSync(
        process.execPath,
        ['--import', 'tsx', 'scripts/capture-golden.ts', ...args],
        { cwd: process.cwd(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      );
      return { status: 0, output: out };
    } catch (err) {
      const e = err as { status?: number; stdout?: string; stderr?: string };
      return { status: e.status ?? 1, output: `${e.stdout ?? ''}${e.stderr ?? ''}` };
    }
  };

  it('refuses without build evidence', () => {
    const r = run(['L1-table-basic', '--from', '.', '--objects', 'Whatever']);
    expect(r.status).not.toBe(0);
    expect(r.output).toContain('No build evidence');
  });

  it('refuses an unknown case id, and suggests near names', () => {
    const r = run(['L1-table-bogus', '--from', '.', '--objects', 'X', '--build-ok', 'test']);
    expect(r.status).not.toBe(0);
    expect(r.output).toContain('No case spec');
    expect(r.output).toContain('L1-table-basic');
  });

  it('refuses without --objects rather than sweeping the sandbox', () => {
    const r = run(['L1-table-basic', '--from', '.', '--build-ok', 'test']);
    expect(r.status).not.toBe(0);
    expect(r.output).toContain('--objects');
  });
}, 120_000);
