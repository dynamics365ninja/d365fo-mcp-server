/**
 * CoC extension results — grouped by the element each class actually extends.
 *
 * Background. `findExtensionClasses` used to accept `Kind = 2 OR path LIKE '%_Extension%'`
 * on the belief that xref Kind 2 meant "DerivedFrom". It is the generic type reference, so
 * every class that merely MENTIONED the base was reported as extending it — 259 reported
 * against 9 real for SalesFormLetter, each with fabricated wrapped methods.
 *
 * The replacement reads the extended element out of the [ExtensionOf] declaration. That
 * exposed a second problem this file covers: one NAME can denote several objects, and the
 * results must never be pooled. Measured on a live xref DB, "SalesTable" is:
 *
 *     /Tables/SalesTable                                       14
 *     /Forms/SalesTable                                        17
 *     /Forms/SalesTable/DataSources/SalesLine                   4
 *     /Forms/SalesTable/DataSources/SalesTable                  3
 *     ... 10 more nested elements (controls, data fields)       10
 *                                                          --- 48
 *
 * An agent about to write a table CoC must not be shown the 34 form-side extensions; an
 * agent about to wrap SalesLine.active must be able to see WHICH of the form's nine
 * data sources carrying an `active` method is already wrapped.
 */

import { describe, it, expect, vi } from 'vitest';
import { tryBridgeCocExtensions } from '../../src/bridge/bridgeAdapter';
import type { BridgeClient } from '../../src/bridge/bridgeClient';

/** Shape mirrors real bridge output for baseClassName "SalesTable". */
const SALESTABLE_EXTENSIONS = [
  { className: 'GUPSalesTable_Extension', module: 'GlobalUnifiedPricing', extendedElement: '/Tables/SalesTable', wrappedMethods: ['insert', 'update'] },
  { className: 'RetailSalesTable_Extension', module: 'ApplicationSuite', extendedElement: '/Tables/SalesTable', wrappedMethods: ['update'] },
  { className: 'SalesTableForm_Extension', module: 'ApplicationSuite', extendedElement: '/Forms/SalesTable', wrappedMethods: ['init'] },
  // Four classes on ONE data source, three of which wrap a method called "active" —
  // indistinguishable before the element was carried through.
  { className: 'GUPSalesTableForm_SalesLine_Extension', module: 'GlobalUnifiedPricing', extendedElement: '/Forms/SalesTable/DataSources/SalesLine', wrappedMethods: ['active', 'recalcuateRetailDiscountWhenDelete'] },
  { className: 'SalesTableFormSalesLineDSMPS_Extension', module: 'MPS', extendedElement: '/Forms/SalesTable/DataSources/SalesLine', wrappedMethods: ['active'] },
  // A DIFFERENT data source that also has an "active" method.
  { className: 'GUPSalesTableForm_SalesTable_Extension', module: 'GlobalUnifiedPricing', extendedElement: '/Forms/SalesTable/DataSources/SalesTable', wrappedMethods: ['active', 'write'] },
  { className: 'GUPSalesTableFormRecalculateControl_Extension', module: 'GlobalUnifiedPricing', extendedElement: '/Forms/SalesTable/Controls/ButtonRetailRecalculator', wrappedMethods: ['clicked'] },
  { className: 'SalesTableCustAccountField_Extension', module: 'ApplicationSuite', extendedElement: '/Forms/SalesTable/DataSources/SalesTable/DataFields/CustAccount', wrappedMethods: ['modified'] },
];

function cocBridge(extensions = SALESTABLE_EXTENSIONS, baseClassName = 'SalesTable'): BridgeClient {
  return {
    isReady: true,
    metadataAvailable: true,
    xrefAvailable: true,
    findExtensionClasses: vi.fn(async () => ({
      baseClassName, count: extensions.length, extensions, _source: 'C# bridge (DYNAMICSXREFDB)',
    })),
  } as unknown as BridgeClient;
}

async function render(bridge: BridgeClient, methodName?: string): Promise<string> {
  const result = await tryBridgeCocExtensions(bridge, 'SalesTable', methodName);
  expect(result).not.toBeNull();
  return (result!.content[0] as { text: string }).text;
}

describe('CoC extensions — grouping by extended element', () => {
  it('separates table extensions from form extensions of the same name', async () => {
    const text = await render(cocBridge());

    expect(text).toContain('Table SalesTable — 2');
    expect(text).toContain('Form SalesTable — 1');
    // The two must never be merged into a single undifferentiated list.
    expect(text).not.toMatch(/Found 8 extension class\(es\):\s*\n\s*\n- \*\*/);
  });

  it('labels nested form elements distinctly', async () => {
    const text = await render(cocBridge());

    expect(text).toContain('Form SalesTable › DataSource SalesLine — 2');
    expect(text).toContain('Form SalesTable › DataSource SalesTable — 1');
    expect(text).toContain('Form SalesTable › Control ButtonRetailRecalculator — 1');
    expect(text).toContain('Form SalesTable › DataSource SalesTable › DataField CustAccount — 1');
  });

  it('keeps same-named wrapped methods attributable to their own data source', async () => {
    const text = await render(cocBridge());

    // Three classes wrap a method called "active" on two different data sources. Each must
    // appear under the heading naming ITS data source, not pooled under the form.
    const salesLineSection = text.split('Form SalesTable › DataSource SalesLine')[1].split('###')[0];
    expect(salesLineSection).toContain('GUPSalesTableForm_SalesLine_Extension');
    expect(salesLineSection).toContain('SalesTableFormSalesLineDSMPS_Extension');
    expect(salesLineSection).not.toContain('GUPSalesTableForm_SalesTable_Extension');
  });

  it('still reports every extension exactly once', async () => {
    const text = await render(cocBridge());
    expect(text).toContain('Found 8 extension class(es)');
    for (const ext of SALESTABLE_EXTENSIONS) {
      const occurrences = text.split(`**${ext.className}**`).length - 1;
      expect(occurrences, `${ext.className} should appear once`).toBe(1);
    }
  });

  it('does not assert the `next` keyword on the bridge path', async () => {
    // The index/filesystem path earns that claim (fsExtensionScanner regexes the method
    // body); this one never read any source, so it must not print the tick.
    const text = await render(cocBridge());
    expect(text).toContain('Wraps methods:');
    expect(text).not.toContain("Uses 'next' keyword");
  });

  it('falls back to the raw path for an element shape it does not recognise', async () => {
    // A future [ExtensionOf] intrinsic should degrade to readable, never be mislabelled.
    const text = await render(cocBridge([
      { className: 'Future_Extension', module: 'X', extendedElement: '/SomethingNew/Foo/Parts/Bar', wrappedMethods: ['run'] },
    ] as typeof SALESTABLE_EXTENSIONS));
    expect(text).toContain('SomethingNew Foo › Parts Bar');
  });

  it('renders without headings when the bridge sends no element (older binary)', async () => {
    const text = await render(cocBridge([
      { className: 'Legacy_Extension', module: 'X', wrappedMethods: ['run'] },
    ] as unknown as typeof SALESTABLE_EXTENSIONS));
    expect(text).toContain('Legacy_Extension');
    expect(text).not.toContain('###');
  });
});
