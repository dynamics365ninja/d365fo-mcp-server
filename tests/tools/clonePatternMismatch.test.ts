import { describe, it, expect } from 'vitest';
import { cloneFromPatternMismatchWarning } from '../../src/tools/generateSmartForm';

/** Minimal AxForm shell carrying a Design-level <Pattern>. */
function formXmlWithPattern(pattern: string): string {
  return `<?xml version="1.0"?><AxForm><Design><Pattern xmlns="">${pattern}</Pattern></Design></AxForm>`;
}

describe('cloneFromPatternMismatchWarning', () => {
  it('warns when the cloned reference declares a different pattern than requested', () => {
    const warn = cloneFromPatternMismatchWarning(
      'SimpleListDetails',
      formXmlWithPattern('SimpleList'),
      'CustGroup',
    );
    expect(warn).not.toBeNull();
    expect(warn).toContain('PATTERN MISMATCH');
    expect(warn).toContain('SimpleListDetails');
    expect(warn).toContain('SimpleList');
    expect(warn).toContain('CustGroup');
    // Points the caller at a same-pattern reference form to clone instead.
    expect(warn).toMatch(/cloneFrom="\w+"/);
  });

  it('returns null when the cloned pattern matches the requested one', () => {
    expect(
      cloneFromPatternMismatchWarning(
        'SimpleListDetails',
        formXmlWithPattern('SimpleListDetails'),
        'ProjCategory',
      ),
    ).toBeNull();
  });

  it('is case-insensitive on the pattern name', () => {
    expect(
      cloneFromPatternMismatchWarning('simplelist', formXmlWithPattern('SimpleList'), 'CustGroup'),
    ).toBeNull();
  });

  it('returns null when no pattern was requested', () => {
    expect(
      cloneFromPatternMismatchWarning(undefined, formXmlWithPattern('SimpleList'), 'CustGroup'),
    ).toBeNull();
  });

  it('returns null when the cloned XML carries no Design pattern', () => {
    expect(
      cloneFromPatternMismatchWarning('SimpleListDetails', '<AxForm><Design/></AxForm>', 'X'),
    ).toBeNull();
  });
});
