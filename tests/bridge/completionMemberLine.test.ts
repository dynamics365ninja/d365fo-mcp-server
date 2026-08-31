/**
 * A member list must be identifiable by NAME.
 *
 * `formatCompletion` printed the signature INSTEAD of the name whenever one
 * existed. The bridge's signature extractor is sometimes wrong — it hands back
 * the line preceding the body when a macro sits between the doc block and the
 * signature — so `SysQuery.range` was rendered as `#ISOCountryRegionCodes`.
 * Filtering runs on the name, so `prefix: "range"` answered "1 member(s)
 * matching range" and then showed something that looks like an unrelated macro.
 *
 * An eval run read that as proof the method does not exist and worked around a
 * public API that was there all along. Reproduced live before this test was
 * written; the extractor itself is a separate C#-side fix.
 */
import { describe, expect, it } from 'vitest';
import { __testing } from '../../src/bridge/bridgeAdapter.js';

const { formatCompletion } = __testing;

const result = (members: Array<{ name: string; kind: string; signature?: string }>) => ({
  symbolName: 'SysQuery',
  symbolType: 'class',
  model: 'ApplicationFoundation',
  members,
}) as never;

describe('formatCompletion — the member name always survives', () => {
  it('names the member even when its signature is junk', () => {
    const out = formatCompletion(
      result([{ name: 'range', kind: 'method', signature: '#ISOCountryRegionCodes' }]),
      'range',
    );
    expect(out).toContain('range');
    expect(out).toMatch(/signature unavailable/i);
  });

  it('shows the signature when it really belongs to that member', () => {
    const out = formatCompletion(
      result([{
        name: 'range',
        kind: 'method',
        signature: 'str range(anytype _from, anytype _to, boolean treatOnlyNullAsUnbound = false)',
      }]),
      'range',
    );
    expect(out).toContain('str range(anytype _from');
    expect(out).not.toMatch(/signature unavailable/i);
  });

  it('falls back to the bare name when there is no signature at all', () => {
    const out = formatCompletion(result([{ name: 'findOrCreateRange', kind: 'method' }]));
    expect(out).toContain('findOrCreateRange');
  });

  it('keeps the inherited-from note beside the name', () => {
    const out = formatCompletion(
      result([{ name: 'addLookupMethod', kind: 'method', signature: '#SomeMacro' }]
        .map(m => ({ ...m, inheritedFrom: 'SysTableLookupBase' })) as never),
    );
    expect(out).toContain('addLookupMethod');
    expect(out).toContain('SysTableLookupBase');
  });
});
