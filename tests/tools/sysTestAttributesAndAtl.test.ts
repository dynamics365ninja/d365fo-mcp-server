/**
 * Regression tests — the two systest scaffold parameters added for H2 (G-26/G-27).
 *
 * Both encode a MEASUREMENT rather than a preference, and that is the point of
 * pinning them. A census of the 488 shipped test classes that mention SysTest
 * (2026-09-02) settled two things a reader would otherwise guess:
 *
 *  - Placement. SysTestGranularity sits on the CLASS (135 of 136),
 *    SysTestCheckInTest on the METHOD (1,616 of 1,621). Putting the second on the
 *    class compiles and quietly changes what it selects.
 *  - The class block is one bracket pair with the attributes stacked inside it,
 *    comma separated. Separate stacked pairs on a member are a compile error
 *    (validator ATTR003), so the generator must never emit them.
 *
 * The ATL half encodes a different measurement: 107 of the ATL nodes hand back an
 * AtlEntity WRAPPER, not a buffer, and `.record()` is what turns it into one.
 */

import { describe, it, expect } from 'vitest';
import { applySysTestAttributes, applyAtlArrange } from '../../src/tools/smart/codeGen';
import {
  atlNodesForTable, atlArrangeLine, ATL_ROOT_MODULES, ATL_PACKAGES, ATL_TABLE_NODES,
} from '../../src/knowledge/atlNodes.generated';

const CLASS_TEMPLATE = `/// <summary>
/// Unit tests.
/// </summary>
[SysTestTarget(classStr(PriceDisc), UtilElementType::Class)]
class PriceDiscTest extends SysTestCase
{
    [SysTestMethod]
    public void testOne()
    {
        // Arrange — an unsaved buffer is enough; validation does not need a row.
        CustTable custTable;
    }
}`;

describe('applySysTestAttributes — placement is measured, not chosen', () => {
  it('is a no-op when nothing was asked for', () => {
    expect(applySysTestAttributes(CLASS_TEMPLATE, [])).toBe(CLASS_TEMPLATE);
  });

  it('stacks class attributes inside the SysTestTarget bracket pair', () => {
    const out = applySysTestAttributes(CLASS_TEMPLATE, ['SysTestGranularity(SysTestGranularity::Unit)']);

    expect(out).toContain([
      '[',
      'SysTestTarget(classStr(PriceDisc), UtilElementType::Class),',
      'SysTestGranularity(SysTestGranularity::Unit)',
      ']',
    ].join('\n'));
    // …and NOT as a second bracket pair, which is the ATTR003 compile error.
    expect(out).not.toContain('][');
    expect(out).not.toMatch(/\]\n\[/);
  });

  it('routes SysTestCheckInTest to the METHOD, where 1,616 of 1,621 shipped uses are', () => {
    const out = applySysTestAttributes(CLASS_TEMPLATE, ['SysTestCheckInTest']);

    expect(out).toContain('[SysTestMethod, SysTestCheckInTest]');
    // The class block is untouched: nothing was asked for there.
    expect(out).toContain('[SysTestTarget(classStr(PriceDisc), UtilElementType::Class)]');
  });

  it('splits a mixed list to both places in one pass', () => {
    const out = applySysTestAttributes(CLASS_TEMPLATE, [
      'SysTestGranularity(SysTestGranularity::Unit)', 'SysTestCheckInTest',
    ]);

    expect(out).toContain('SysTestGranularity(SysTestGranularity::Unit)\n]');
    expect(out).toContain('[SysTestMethod, SysTestCheckInTest]');
  });

  it('accepts the ...Attribute spelling for the routed one too', () => {
    const out = applySysTestAttributes(CLASS_TEMPLATE, ['SysTestCheckInTestAttribute']);
    expect(out).toContain('[SysTestMethod, SysTestCheckInTestAttribute]');
  });

  it('ignores blank entries rather than emitting an empty attribute', () => {
    const out = applySysTestAttributes(CLASS_TEMPLATE, ['   ', 'SysTestCheckInTest']);
    expect(out).not.toContain(', ]');
    expect(out).toContain('[SysTestMethod, SysTestCheckInTest]');
  });
});

describe('applyAtlArrange', () => {
  it('INSERTS after the marker and keeps the reason the marker carries', () => {
    const out = applyAtlArrange(CLASS_TEMPLATE, 'CustTable');

    // The first draft anchored on `// Arrange$` and matched nothing at all,
    // because every template's marker carries trailing text.
    expect(out).toContain('// Arrange — an unsaved buffer is enough; validation does not need a row.');
    expect(out).toContain('AtlDataRootNode data = AtlDataRootNode::construct();');
  });

  it('emits .record() for a node that hands back an AtlEntity wrapper', () => {
    const out = applyAtlArrange(CLASS_TEMPLATE, 'CustTable');
    expect(out).toContain('CustTable atlRecord = data.cust().customers().default().record();');
  });

  it('names the other nodes that produce the same buffer instead of choosing silently', () => {
    const out = applyAtlArrange(CLASS_TEMPLATE, 'CustTable');
    expect(out).toContain('are NOT interchangeable');
  });

  it('says so plainly when ATL ships no node for the table', () => {
    const out = applyAtlArrange(CLASS_TEMPLATE, 'ConDemoNoteHeader');

    expect(out).toContain('ATL ships no node for ConDemoNoteHeader');
    expect(out).not.toContain('atlRecord');
  });

  it('still opens with the root construct when there is no table target at all', () => {
    const out = applyAtlArrange(CLASS_TEMPLATE, undefined);

    expect(out).toContain('AtlDataRootNode::construct();');
    expect(out).not.toContain('ships no node');
  });
});

describe('the generated ATL index', () => {
  it('carries the root modules and the packages that define them', () => {
    expect(ATL_ROOT_MODULES.length).toBeGreaterThan(30);
    expect(ATL_PACKAGES).toContain('AtlFoundation');
    // The module a caller reaches for first, and the package it actually lives in
    // — NOT AtlFoundation, which is the whole reason the failure is confusing.
    const invent = ATL_ROOT_MODULES.find(m => m.accessor === 'invent');
    expect(invent?.package).toBe('ATLApplicationSuite');
  });

  it('keeps default() and createDefault() apart', () => {
    const kinds = new Set(ATL_TABLE_NODES.map(n => n.kind));
    expect([...kinds].sort()).toEqual(['createDefault', 'default']);

    // AtlDataSalesOrders has no default() — asking ATL for an existing sales
    // order is not something it offers, and flattening the two would claim it does.
    const salesOrder = ATL_TABLE_NODES.filter(n => n.path.startsWith('sales().salesOrders()'));
    expect(salesOrder.length).toBeGreaterThan(0);
    expect(salesOrder.every(n => n.kind === 'createDefault')).toBe(true);
  });

  it('returns every candidate for a buffer, likeliest first', () => {
    const nodes = atlNodesForTable('CustTable');

    expect(nodes.length).toBeGreaterThan(1);
    expect(nodes[0].kind).toBe('default');
    expect(atlArrangeLine(nodes[0])).toBe('data.cust().customers().default().record()');
  });

  it('answers with nothing for a table ATL does not cover', () => {
    expect(atlNodesForTable('ConDemoNoteHeader')).toEqual([]);
  });
});
