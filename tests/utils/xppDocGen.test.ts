/**
 * Tests for the X++ XML doc-comment generator.
 *
 * Covers both generation of brand-new doc blocks and completion of existing
 * (AI-authored) blocks that are missing <param> / <returns> elements.
 */

import { describe, it, expect } from 'vitest';
import { ensureXppDocComment, ensureBlankLineBeforeClosingBrace } from '../../src/utils/xppDocGen.js';

describe('ensureXppDocComment — fresh generation (no existing doc block)', () => {
  it('generates summary, params and returns for a public method', () => {
    const src = [
      '    public boolean validateItem(ItemId _itemId, InventDimId _dimId)',
      '    {',
      '        return true;',
      '    }',
    ].join('\n');

    const out = ensureXppDocComment(src);

    expect(out).toContain('/// <summary>');
    expect(out).toContain('/// <param name="_itemId">');
    expect(out).toContain('/// <param name="_dimId">');
    expect(out).toContain('/// <returns>');
    // Doc block must be indented like the signature
    expect(out.startsWith('    /// <summary>')).toBe(true);
  });

  it('omits <returns> for void methods', () => {
    const src = [
      'public void run()',
      '{',
      '}',
    ].join('\n');

    const out = ensureXppDocComment(src);
    expect(out).toContain('<summary>');
    expect(out).not.toContain('<returns>');
  });

  it('documents parameters of a signature spanning multiple lines', () => {
    const src = [
      '    public static TransDate calcDeliveryDate(',
      '        SalesId      _salesId,',
      '        TransDate    _requestedDate = dateNull())',
      '    {',
      '        return _requestedDate;',
      '    }',
    ].join('\n');

    const out = ensureXppDocComment(src);

    expect(out).toContain('<param name="_salesId">');
    expect(out).toContain('<param name="_requestedDate">');
    expect(out).toContain('<returns>');
  });

  it('handles default values containing commas inside function calls', () => {
    const src = [
      'public int pickBigger(int _a, int _b = max(1, 2))',
      '{',
      '    return _b;',
      '}',
    ].join('\n');

    const out = ensureXppDocComment(src);

    expect(out).toContain('<param name="_a">');
    expect(out).toContain('<param name="_b">');
    expect(out).not.toContain('<param name="2)">');
  });

  it('leaves private methods untouched', () => {
    const src = [
      'private int helper()',
      '{',
      '    return 1;',
      '}',
    ].join('\n');

    expect(ensureXppDocComment(src)).toBe(src);
  });

  it('generates a class summary without params/returns', () => {
    const src = [
      'public class ContosoBudgetHelper',
      '{',
      '}',
    ].join('\n');

    const out = ensureXppDocComment(src);
    expect(out).toContain('<summary>');
    expect(out).not.toContain('<param');
    expect(out).not.toContain('<returns>');
  });
});

describe('ensureXppDocComment — completing an existing doc block', () => {
  it('adds <returns> to a documented static int method (reported bug)', () => {
    const src = [
      '/// <summary>',
      '/// Returns the configured number of look-ahead months.',
      '/// </summary>',
      'public static int lookAheadMonths()',
      '{',
      '    ContosoBudgetLookAheadParameters params = ContosoBudgetLookAheadParameters::find();',
      '    return params.LookAheadMonths > 0 ? params.LookAheadMonths : 2;',
      '}',
    ].join('\n');

    const out = ensureXppDocComment(src);
    const lines = out.split('\n');

    // Original summary text kept verbatim
    expect(out).toContain('/// Returns the configured number of look-ahead months.');
    // <returns> added right after </summary>, before the signature
    expect(lines[3]).toContain('/// <returns>');
    expect(lines[4]).toContain('public static int lookAheadMonths()');
  });

  it('adds missing <param> elements and <returns> after an existing summary', () => {
    const src = [
      '    /// <summary>',
      '    /// Validates the budget for the purchase line.',
      '    /// </summary>',
      '    public boolean validateBudget(PurchLine _purchLine, boolean _showErrors)',
      '    {',
      '        return true;',
      '    }',
    ].join('\n');

    const out = ensureXppDocComment(src);
    const lines = out.split('\n');

    expect(lines[3]).toContain('<param name="_purchLine">');
    expect(lines[4]).toContain('<param name="_showErrors">');
    expect(lines[5]).toContain('<returns>');
    // Inserted lines keep the signature indentation
    expect(lines[3].startsWith('    ///')).toBe(true);
  });

  it('adds only the params that are not documented yet', () => {
    const src = [
      '/// <summary>',
      '/// Processes the journal.',
      '/// </summary>',
      '/// <param name="_journalId">The journal to process.</param>',
      'public void process(JournalId _journalId, boolean _validateOnly)',
      '{',
      '}',
    ].join('\n');

    const out = ensureXppDocComment(src);
    const lines = out.split('\n');

    // Existing param doc kept, missing one appended after it
    expect(lines[3]).toContain('<param name="_journalId">The journal to process.</param>');
    expect(lines[4]).toContain('<param name="_validateOnly">');
    expect(out.match(/<param name="_journalId"/g)).toHaveLength(1);
    expect(out).not.toContain('<returns>'); // void
  });

  it('is idempotent for an already complete block', () => {
    const src = [
      '/// <summary>',
      '/// Finds the parameters record.',
      '/// </summary>',
      '/// <param name="_forUpdate">A value indicating whether to select for update.</param>',
      '/// <returns>The parameters record.</returns>',
      'public static ContosoParameters find(boolean _forUpdate = false)',
      '{',
      '    ContosoParameters parameters;',
      '    return parameters;',
      '}',
    ].join('\n');

    const once = ensureXppDocComment(src);
    expect(once).toBe(src);
    expect(ensureXppDocComment(once)).toBe(once);
  });

  it('inserts <returns> before an existing <remarks> block', () => {
    const src = [
      '/// <summary>',
      '/// Gets the look-ahead horizon.',
      '/// </summary>',
      '/// <remarks>',
      '/// Defaults to two months when not configured.',
      '/// </remarks>',
      'public static int lookAheadMonths()',
      '{',
      '    return 2;',
      '}',
    ].join('\n');

    const out = ensureXppDocComment(src);
    const lines = out.split('\n');

    expect(lines[3]).toContain('<returns>');
    expect(lines[4]).toContain('<remarks>');
  });

  it('completes a documented method whose signature spans multiple lines', () => {
    const src = [
      '/// <summary>',
      '/// Calculates the delivery date.',
      '/// </summary>',
      'public static TransDate calcDeliveryDate(',
      '    SalesId   _salesId,',
      '    TransDate _requestedDate)',
      '{',
      '    return _requestedDate;',
      '}',
    ].join('\n');

    const out = ensureXppDocComment(src);

    expect(out).toContain('<param name="_salesId">');
    expect(out).toContain('<param name="_requestedDate">');
    expect(out).toContain('<returns>');
  });

  it('leaves documented class declarations unchanged', () => {
    const src = [
      '/// <summary>',
      '/// Helper class.',
      '/// </summary>',
      'public class ContosoHelper',
      '{',
      '}',
    ].join('\n');

    expect(ensureXppDocComment(src)).toBe(src);
  });

  it('leaves documented private methods unchanged', () => {
    const src = [
      '/// <summary>',
      '/// Internal helper.',
      '/// </summary>',
      'private int helper(int _x)',
      '{',
      '    return _x;',
      '}',
    ].join('\n');

    expect(ensureXppDocComment(src)).toBe(src);
  });
});

describe('ensureBlankLineBeforeClosingBrace', () => {
  it('inserts a blank line between last member and closing brace', () => {
    const decl = [
      'public class MyClass',
      '{',
      '    TransDate fromDate;',
      '}',
    ].join('\n');

    const out = ensureBlankLineBeforeClosingBrace(decl);
    expect(out).toContain(';\n\n}');
  });

  it('is idempotent', () => {
    const decl = [
      'public class MyClass',
      '{',
      '    TransDate fromDate;',
      '',
      '}',
    ].join('\n');

    expect(ensureBlankLineBeforeClosingBrace(decl)).toBe(decl);
  });
});
