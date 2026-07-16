/**
 * parseMethodSignature tests — the X++ declaration parser behind
 * get_method(include="signature"/"both") and the CoC template.
 *
 * Key regression: X++ declarations routinely wrap the parameter list across
 * several lines (every standard construct/new* pattern with defaulted params
 * does). The old single-line parser silently returned zero parameters for
 * those, producing a wrong signature and a CoC template that cannot compile.
 */

import { describe, it, expect } from 'vitest';
import { parseMethodSignature } from '../../src/tools/methodSignature';

describe('parseMethodSignature', () => {
  it('parses a simple single-line declaration (baseline)', () => {
    const src = 'public void run()\n{\n    info("Hello");\n}';
    const sig = parseMethodSignature(src, 'run');
    expect(sig).not.toBeNull();
    expect(sig!.modifiers).toEqual(['public']);
    expect(sig!.returnType).toBe('void');
    expect(sig!.parameters).toEqual([]);
    expect(sig!.signature).toBe('public void run()');
  });

  it('parses a multi-line declaration with defaulted parameters (PurchFormLetter_Invoice.construct shape)', () => {
    const src = [
      '    public static PurchFormLetter_Invoice construct(',
      '        IdentifierName _className = classStr(FormletterService),',
      '        IdentifierName _methodName = methodStr(FormletterService, postPurchaseOrderInvoice),',
      '        SysOperationExecutionMode _executionMode = SysOperationExecutionMode::Synchronous)',
      '    {',
      '        return new PurchFormLetter_Invoice(_className, _methodName, _executionMode);',
      '    }',
    ].join('\n');
    const sig = parseMethodSignature(src, 'construct');
    expect(sig).not.toBeNull();
    expect(sig!.modifiers).toEqual(['public', 'static']);
    expect(sig!.returnType).toBe('PurchFormLetter_Invoice');
    expect(sig!.parameters).toEqual([
      { type: 'IdentifierName', name: '_className', defaultValue: 'classStr(FormletterService)' },
      { type: 'IdentifierName', name: '_methodName', defaultValue: 'methodStr(FormletterService, postPurchaseOrderInvoice)' },
      { type: 'SysOperationExecutionMode', name: '_executionMode', defaultValue: 'SysOperationExecutionMode::Synchronous' },
    ]);
    // CoC next() call must forward every parameter
    expect(sig!.cocTemplate).toContain('next construct(_className, _methodName, _executionMode);');
  });

  it('does not truncate at a nested closing paren inside a default value', () => {
    const src = 'public static void post(IdentifierName _className = classStr(FormletterService), boolean _late = false)\n{\n}';
    const sig = parseMethodSignature(src, 'post');
    expect(sig).not.toBeNull();
    expect(sig!.parameters).toEqual([
      { type: 'IdentifierName', name: '_className', defaultValue: 'classStr(FormletterService)' },
      { type: 'boolean', name: '_late', defaultValue: 'false' },
    ]);
  });

  it('does not split on commas nested inside defaults (intrinsics, container literals)', () => {
    const src = "void doIt(IdentifierName _m = methodStr(FormletterService, postPurchaseOrderInvoice), container _c = ['a', 'b'])\n{\n}";
    const sig = parseMethodSignature(src, 'doIt');
    expect(sig).not.toBeNull();
    expect(sig!.parameters).toHaveLength(2);
    expect(sig!.parameters[0].defaultValue).toBe('methodStr(FormletterService, postPurchaseOrderInvoice)');
    expect(sig!.parameters[1]).toEqual({ type: 'container', name: '_c', defaultValue: "['a', 'b']" });
  });

  it('matches modifiers as whole words only', () => {
    const sig = parseMethodSignature('public void finalizeOrder()\n{\n}', 'finalizeOrder');
    expect(sig).not.toBeNull();
    expect(sig!.modifiers).toEqual(['public']); // not phantom 'final'

    const sig2 = parseMethodSignature('display Amount amountDisplayed()\n{\n}', 'amountDisplayed');
    expect(sig2).not.toBeNull();
    expect(sig2!.modifiers).toEqual(['display']);
    expect(sig2!.returnType).toBe('Amount');
  });

  it('recognizes internal as an access modifier and keeps it out of the CoC template', () => {
    const sig = parseMethodSignature('internal final void doWork()\n{\n}', 'doWork');
    expect(sig).not.toBeNull();
    expect(sig!.modifiers).toEqual(['internal', 'final']);
    expect(sig!.returnType).toBe('void');
    expect(sig!.cocTemplate).not.toContain('internal');
  });

  it('ignores the method name inside a preceding attribute string or comment', () => {
    const src = [
      "[SysObsolete('use construct() instead of newStandard()')]",
      '// callers should prefer construct() here',
      'public static MyClass construct(MyArgs _args)',
      '{',
      '}',
    ].join('\n');
    const sig = parseMethodSignature(src, 'construct');
    expect(sig).not.toBeNull();
    expect(sig!.returnType).toBe('MyClass');
    expect(sig!.parameters).toEqual([{ type: 'MyArgs', name: '_args' }]);
  });

  it('does not mistake a call for the declaration', () => {
    const src = [
      'public void init(SalesTable _salesTable)',
      '{',
      '    this.update(_salesTable);',
      '}',
    ].join('\n');
    // 'update' only appears as this.update( — a call, not a declaration on this class
    const sig = parseMethodSignature(src, 'update');
    expect(sig).toBeNull();
  });

  it('returns null for source without a matching declaration or with unbalanced parens', () => {
    expect(parseMethodSignature('class Foo\n{\n    int x;\n}', 'classDeclaration')).toBeNull();
    expect(parseMethodSignature('public void broken(int _a', 'broken')).toBeNull();
    expect(parseMethodSignature('', 'anything')).toBeNull();
  });

  it('handles parens and commas inside string default values', () => {
    const src = "void log(str _msg = 'a, b (c)', int _n = 1)\n{\n}";
    const sig = parseMethodSignature(src, 'log');
    expect(sig).not.toBeNull();
    expect(sig!.parameters).toEqual([
      { type: 'str', name: '_msg', defaultValue: "'a, b (c)'" },
      { type: 'int', name: '_n', defaultValue: '1' },
    ]);
  });
});
