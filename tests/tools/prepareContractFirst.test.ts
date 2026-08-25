/**
 * prepare — the deliverable survives a cut, and the resolved type is chosen on
 * evidence rather than on symbol-index row order.
 *
 * Both regressions were measured on this VM, not imagined:
 *   • prepare's result size was p50 4,966 / p90 5,011 chars against a 5,000-char
 *     response cap over 1,400 real MCP calls — i.e. essentially every response
 *     was cut, and a cut takes the LAST sections. The write contract and the
 *     grounding token were the last sections, so the two things the call exists
 *     to deliver were exactly the two that went; with the token gone, prepare.ts's
 *     extractToken found nothing and repeat-suppression never armed either.
 *   • prepare(mode="change", objectName="CustTable", methodName="validateWrite")
 *     answered with FORM-extension strategies, because lookupSymbolNocase runs
 *     `WHERE name = ? AND parent_name IS NULL LIMIT 1` with no ORDER BY and
 *     CustTable exists as form, menu-item-display, query and table.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { XppSymbolIndex } from '../../src/metadata/symbolIndex';
import { prepareChangeTool } from '../../src/tools/prepare/prepareChange';
import { capToolResponse } from '../../src/tools/responseCaps';
import type { XppServerContext } from '../../src/types/context';

let index: XppSymbolIndex;
let context: XppServerContext;

const symbol = (over: Record<string, unknown>) => ({
  name: '',
  type: 'class',
  filePath: '/x.xml',
  model: 'ApplicationSuite',
  ...over,
}) as any;

beforeAll(() => {
  index = new XppSymbolIndex(':memory:', ':memory:');

  // Row order deliberately puts the FORM first — that is the order that produced
  // the live defect, and it must no longer decide the answer.
  index.addSymbol(symbol({ name: 'CustTable', type: 'form', filePath: '/Forms/CustTable.xml' }));
  index.addSymbol(symbol({ name: 'CustTable', type: 'menu-item-display', filePath: '/MenuItems/CustTable.xml' }));
  index.addSymbol(symbol({ name: 'CustTable', type: 'query', filePath: '/Queries/CustTable.xml' }));
  index.addSymbol(symbol({ name: 'CustTable', type: 'table', filePath: '/Tables/CustTable.xml' }));

  // validateWrite is declared by the TABLE file; the form file declares a
  // different method, so file_path identifies the owner unambiguously.
  index.addSymbol(symbol({
    name: 'validateWrite', type: 'method', parentName: 'CustTable',
    filePath: '/Tables/CustTable.xml', signature: 'boolean validateWrite()',
  }));
  index.addSymbol(symbol({
    name: 'init', type: 'method', parentName: 'CustTable',
    filePath: '/Forms/CustTable.xml', signature: 'void init()',
  }));

  // A name that only exists as a form — the preference order must not invent a table.
  index.addSymbol(symbol({ name: 'SalesTableListPage', type: 'form', filePath: '/Forms/SalesTableListPage.xml' }));

  context = { symbolIndex: index, bridge: undefined } as unknown as XppServerContext;
});

afterAll(() => {
  index.close();
});

const req = (args: Record<string, unknown>) => ({
  method: 'tools/call' as const,
  params: { name: 'prepare_change', arguments: args },
});

const textOf = (r: any): string => r.content[0].text as string;

describe('prepare(change) resolves the object type on evidence, not row order', () => {
  it('picks the table that declares the method even when the form row comes first', async () => {
    const text = textOf(await prepareChangeTool(
      req({ goal: 'Add CoC on CustTable.validateWrite', objectName: 'CustTable', methodName: 'validateWrite' }),
      context,
    ));
    expect(text).toContain('**Object type (resolved):** table');
    expect(text).not.toContain('**Object type (resolved):** form');
    // Table strategies, not form-extension ones.
    expect(text).toContain('AxTableExtension');
    expect(text).not.toContain('AxFormExtension');
  });

  it('discloses the other types the name resolves to instead of staying silent', async () => {
    const text = textOf(await prepareChangeTool(
      req({ goal: 'Add CoC on CustTable.validateWrite', objectName: 'CustTable', methodName: 'validateWrite' }),
      context,
    ));
    expect(text).toMatch(/also exists as .*form.*— resolved as table/);
    expect(text).toContain('pass `objectType` to override');
  });

  it('falls back to the documented preference order when no method is given', async () => {
    const text = textOf(await prepareChangeTool(
      req({ goal: 'Add a field to CustTable', objectName: 'CustTable' }),
      context,
    ));
    expect(text).toContain('**Object type (resolved):** table');
  });

  it('honours an explicit objectType over both method evidence and preference order', async () => {
    const text = textOf(await prepareChangeTool(
      req({ goal: 'Extend the CustTable form', objectName: 'CustTable', objectType: 'form', methodName: 'validateWrite' }),
      context,
    ));
    expect(text).toContain('**Object type (resolved):** form');
    expect(text).toContain('AxFormExtension');
  });

  it('does not promote a type the name does not have', async () => {
    const text = textOf(await prepareChangeTool(
      req({ goal: 'Extend the list page', objectName: 'SalesTableListPage' }),
      context,
    ));
    expect(text).toContain('**Object type (resolved):** form');
  });
});

describe('prepare(change) leads with the deliverable', () => {
  it('puts the write contract and the token ahead of every discovery section', async () => {
    const text = textOf(await prepareChangeTool(
      req({
        goal: 'Add a field and an index to CustTable',
        objectName: 'CustTable',
        operation: 'add-field,add-index',
      }),
      context,
    ));
    const contract = text.indexOf('### Write contract');
    const token = text.indexOf('**Grounding token:**');
    expect(contract).toBeGreaterThan(-1);
    expect(token).toBeGreaterThan(contract);
    for (const section of [
      '### Existing CoC extensions',
      '### Recommended extension strategies',
      '### Related patterns',
      '### Related context',
    ]) {
      const at = text.indexOf(section);
      if (at === -1) continue;
      expect(at, `${section} must come after the contract and the token`).toBeGreaterThan(token);
    }
  });

  it('renders a contract per operation when several are asked for', async () => {
    const text = textOf(await prepareChangeTool(
      req({
        goal: 'Add a field and an index to CustTable',
        objectName: 'CustTable',
        operation: 'add-field,add-index',
      }),
      context,
    ));
    expect(text).toContain('operation="add-field"');
    expect(text).toContain('operation="add-index"');
    expect(text).toContain('`operations[]`');
  });

  it('keeps the token and the contract when the response is truncated at prepare\'s cap', async () => {
    const result = await prepareChangeTool(
      req({
        goal: 'Add a field and an index to CustTable',
        objectName: 'CustTable',
        operation: 'add-field,add-index',
      }),
      context,
    );
    // Simulate the real production shape: a long discovery tail past the cap.
    // The padding goes at the END, which is where the aggregated sections live.
    const padded = {
      ...result,
      content: [{
        type: 'text',
        text: textOf(result) + '\n' + '  • Filler [class, ApplicationSuite]\n'.repeat(600),
      }],
    };
    expect(padded.content[0].text.length).toBeGreaterThan(12000);

    const capped = capToolResponse('prepare', padded);
    const out = capped.content[0].text as string;
    expect(out).toContain('✂️ Response truncated');
    expect(out).toContain('### Write contract');
    expect(out).toMatch(/\*\*Grounding token:\*\*\s*`[^`]+`/);
    // The footer must not hand the caller reader-tool knobs prepare has never had.
    expect(out).not.toContain('fieldsOffset');
    expect(out).toContain('prepare has no paging parameters');
  });
});
