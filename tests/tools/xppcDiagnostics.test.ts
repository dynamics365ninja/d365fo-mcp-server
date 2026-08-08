/**
 * Structured xppc diagnostics tests — parser + formatter.
 * Line format grounded in the observed xppc -log output:
 *   Compile Error: Class Method dynamics://MyModel/MyClass/myMethod: [(28,27),(28,28)]: ';' expected.
 */

import { describe, it, expect } from 'vitest';
import { parseXppcDiagnostics, formatStructuredDiagnostics } from '../../src/tools/sdlc/buildProject';

describe('parseXppcDiagnostics', () => {
  it('parses the canonical class-method error line', () => {
    const diags = parseXppcDiagnostics(
      "Compile Error: Class Method dynamics://MyModel/MyClass/myMethod: [(28,27),(28,28)]: ';' expected.",
    );
    expect(diags).toHaveLength(1);
    expect(diags[0]).toMatchObject({
      severity: 'error',
      kind: 'Class Method',
      model: 'MyModel',
      object: 'MyClass',
      member: 'myMethod',
      line: 28,
      column: 27,
      message: "';' expected.",
    });
  });

  it('parses object-level diagnostics without a member', () => {
    const diags = parseXppcDiagnostics(
      'Compile Error: Table dynamics://MyModel/MyTable: [(1,1),(1,2)]: Unknown field reference.',
    );
    expect(diags[0]).toMatchObject({
      object: 'MyTable',
      member: undefined,
      line: 1,
      message: 'Unknown field reference.',
    });
  });

  it('classifies warnings', () => {
    const diags = parseXppcDiagnostics(
      'Compile Warning: Class Method dynamics://MyModel/MyClass/run: [(5,1),(5,2)]: Unused variable x.',
    );
    expect(diags[0].severity).toBe('warning');
  });

  it('falls back to message-only diagnostics for unstructured error lines', () => {
    const diags = parseXppcDiagnostics(
      'Compile Fatal Error: The metadata path could not be resolved.',
    );
    expect(diags).toHaveLength(1);
    expect(diags[0].severity).toBe('error');
    expect(diags[0].object).toBeUndefined();
    expect(diags[0].message).toBe('The metadata path could not be resolved.');
  });

  it('ignores non-diagnostic log noise', () => {
    const diags = parseXppcDiagnostics(
      'Loading metadata...\nCompiling module MyModel\nDone in 42s\n',
    );
    expect(diags).toEqual([]);
  });

  it('parses a multi-line log with mixed severities', () => {
    const log = [
      'Loading metadata...',
      "Compile Error: Class Method dynamics://M/ClassA/m1: [(10,5),(10,6)]: ';' expected.",
      'Compile Warning: Class Method dynamics://M/ClassA/m2: [(20,1),(20,2)]: Unused variable.',
      "Compile Error: Class Method dynamics://M/ClassB/m3: [(30,2),(30,3)]: Unbalanced TTS level.",
    ].join('\n');
    const diags = parseXppcDiagnostics(log);
    expect(diags).toHaveLength(3);
    expect(diags.filter(d => d.severity === 'error')).toHaveLength(2);
  });
});

describe('formatStructuredDiagnostics', () => {
  it('returns empty string for no diagnostics', () => {
    expect(formatStructuredDiagnostics([])).toBe('');
  });

  it('orders errors before warnings and includes locations', () => {
    const text = formatStructuredDiagnostics(parseXppcDiagnostics([
      'Compile Warning: Class Method dynamics://M/ClassA/m2: [(20,1),(20,2)]: Unused variable.',
      "Compile Error: Class Method dynamics://M/ClassA/m1: [(10,5),(10,6)]: ';' expected.",
    ].join('\n')));
    expect(text).toContain('1 error(s), 1 warning(s)');
    const errIdx = text.indexOf('ClassA.m1');
    const warnIdx = text.indexOf('ClassA.m2');
    expect(errIdx).toBeGreaterThan(-1);
    expect(warnIdx).toBeGreaterThan(errIdx);
    expect(text).toContain('(line 10, col 5)');
    expect(text).toContain('d365fo_file(action="modify")');
  });

  it('enriches known errors with a fix hint from the error knowledge base', () => {
    const text = formatStructuredDiagnostics(parseXppcDiagnostics(
      'Compile Error: Class Method dynamics://M/ClassB/m3: [(30,2),(30,3)]: Unbalanced TTS level on exit.',
    ));
    expect(text).toContain('💡');
    expect(text).toMatch(/TTS/i);
  });

  it('collapses duplicate diagnostics', () => {
    const line = "Compile Error: Class Method dynamics://M/ClassA/m1: [(10,5),(10,6)]: ';' expected.";
    const text = formatStructuredDiagnostics(parseXppcDiagnostics(`${line}\n${line}\n${line}`));
    expect(text.match(/ClassA\.m1/g)).toHaveLength(1);
  });
});
