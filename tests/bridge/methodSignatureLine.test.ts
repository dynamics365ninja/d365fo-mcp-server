/**
 * The compact class view took `source.split('\n')[0]` as the method signature,
 * so every method whose body opens with an XML doc comment rendered as
 * `/// <summary>`. Measured on Foundation's CustVendVoucher during the
 * L2-datetime-timezone-range run: 14 of the first 15 methods were unreadable,
 * while options={members:"names"} answered correctly for the same class.
 */

import { describe, it, expect } from 'vitest';
import { methodSignatureLine } from '../../src/bridge/bridgeAdapter';

const DOCUMENTED = `/// <summary>
/// Posts the voucher.
/// </summary>
/// <param name = "_voucher">The voucher to post.</param>
public static void postVoucher(LedgerVoucher _voucher)
{
    // ...
}`;

describe('methodSignatureLine', () => {
  it('shows the declaration, not the doc comment, for a documented method', () => {
    const sig = methodSignatureLine('postVoucher', DOCUMENTED);
    expect(sig).not.toContain('<summary>');
    expect(sig).toContain('postVoucher');
    expect(sig).toContain('LedgerVoucher _voucher');
  });

  it('handles an undocumented method unchanged', () => {
    const sig = methodSignatureLine('construct', 'public static CustTable construct()\n{\n}');
    expect(sig).toContain('construct(');
  });

  it('handles a parameter list wrapped across lines', () => {
    const src = `/// <summary>x</summary>
protected void init(
    CustTable _custTable,
    boolean _refresh = false)
{
}`;
    const sig = methodSignatureLine('init', src);
    expect(sig).not.toContain('///');
    expect(sig).toContain('_custTable');
    expect(sig).toContain('_refresh');
  });

  it('skips an attribute line when falling back', () => {
    // Name deliberately not present as a declaration, so the parser returns null
    // and the fallback scan runs.
    const src = `[SysObsolete("gone")]\n// legacy\nsomething else entirely`;
    expect(methodSignatureLine('missingName', src)).toBe('something else entirely');
  });

  it('falls back to the metadata name when there is no source at all', () => {
    expect(methodSignatureLine('parmValue')).toBe('parmValue');
    expect(methodSignatureLine('parmValue', '')).toBe('parmValue');
  });
});
