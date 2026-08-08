/**
 * Reader payload budget — the metadata readers are the largest single responses
 * this server emits, and each one is re-billed on every later round trip that
 * re-reads the conversation.
 *
 * Three readers had no bound at all: table FIELDS (methods paged, fields did
 * not — a CustTable-class read was 5–8 k tokens), the form CONTROL TREE, and an
 * embedded RDL that reaches 2 MB. Two more defects made the bounded output
 * worse than the unbounded one: the plural get_object_info form dropped every
 * content item after `[0]`, and the truncation footer told the caller to pass
 * `compact=false`, which makes the response BIGGER.
 */

import { describe, it, expect } from 'vitest';
import { tryBridgeTable, tryBridgeForm } from '../../src/bridge/bridgeAdapter';
import { capToolResponse } from '../../src/tools/toolHandler';
import { truncateOnBlockBoundary, TABLE_FIELD_PAGE_SIZE, DEFAULT_MAX_CONTROLS } from '../../src/utils/payloadBudget';

// A bridge that is ready and answers readTable/readForm with the fixture.
const fakeBridge = (answers: Record<string, unknown>): any => ({
  isReady: true,
  metadataAvailable: true,
  readTable: async () => answers.table,
  readForm: async () => answers.form,
});

function bigTable(fieldCount: number) {
  return {
    name: 'CustTable',
    model: 'ApplicationSuite',
    fields: Array.from({ length: fieldCount }, (_, i) => ({
      name: i % 3 === 0 ? `InvoiceField${i}` : `Field${i}`,
      fieldType: 'String',
      mandatory: false,
    })),
    indexes: [],
    relations: [],
    methods: [],
  };
}

/** A control subtree of `count` nodes, nested `width`-wide so the cap has to recurse. */
function controlTree(count: number) {
  const roots: any[] = [];
  let made = 0;
  while (made < count) {
    const children: any[] = [];
    for (let i = 0; i < 9 && made < count - 1; i++) {
      children.push({ name: `Ctrl${made++}`, controlType: 'FormStringControl', children: [] });
    }
    roots.push({ name: `Group${made++}`, controlType: 'FormGroupControl', children });
  }
  return roots;
}

describe('table fields are paged like methods (audit §3.9)', () => {
  it('returns one page of fields, not all 400, and says how to get the next', async () => {
    const res = await tryBridgeTable(fakeBridge({ table: bigTable(400) }), 'CustTable');
    const text = res!.content[0].text;

    expect(text).toContain(`Fields (400 total, showing 1–${TABLE_FIELD_PAGE_SIZE})`);
    expect(text).toContain('**Field1**');
    expect(text).not.toContain(`**Field${TABLE_FIELD_PAGE_SIZE + 1}**`);
    expect(text).toContain(`fieldsOffset: ${TABLE_FIELD_PAGE_SIZE}`);
    expect(text).toContain('350 more fields');
    // The whole point: the response is no longer dominated by the field list.
    expect(text.length).toBeLessThan(6_000);
  });

  it('serves the next page at fieldsOffset, mirroring the methodOffset convention', async () => {
    const res = await tryBridgeTable(fakeBridge({ table: bigTable(400) }), 'CustTable', 0, TABLE_FIELD_PAGE_SIZE);
    const text = res!.content[0].text;

    expect(text).toContain(`showing ${TABLE_FIELD_PAGE_SIZE + 1}–${TABLE_FIELD_PAGE_SIZE * 2}`);
    expect(text).toContain(`**Field${TABLE_FIELD_PAGE_SIZE}**`);
    expect(text).not.toContain('**Field1**:');
  });

  it('fieldFilter narrows instead of paging, and reports an empty match honestly', async () => {
    const hit = await tryBridgeTable(fakeBridge({ table: bigTable(60) }), 'CustTable', 0, 0, 'invoicefield1');
    const hitText = hit!.content[0].text;
    expect(hitText).toContain('matching "invoicefield1"');
    expect(hitText).toContain('**InvoiceField12**');
    expect(hitText).not.toContain('**Field2**:');

    const miss = await tryBridgeTable(fakeBridge({ table: bigTable(60) }), 'CustTable', 0, 0, 'NoSuchThing');
    expect(miss!.content[0].text).toContain('No field name contains "NoSuchThing"');
  });

  it('leaves a small table exactly as it was — no pagination noise', async () => {
    const res = await tryBridgeTable(fakeBridge({ table: bigTable(5) }), 'MyTable');
    const text = res!.content[0].text;
    expect(text).toContain('Fields (5)');
    expect(text).not.toContain('fieldsOffset');
  });
});

describe('form control tree is capped (audit §3.9)', () => {
  const form = (count: number) => ({
    name: 'SalesTable',
    model: 'ApplicationSuite',
    dataSources: [],
    controls: controlTree(count),
    methods: [],
  });

  it('stops at the default cap and quantifies what it hid', async () => {
    const res = await tryBridgeForm(fakeBridge({ form: form(600) }), 'SalesTable');
    const text = res!.content[0].text;

    const rendered = (text.match(/^\s*- \*\*(Ctrl|Group)/gm) ?? []).length;
    expect(rendered).toBe(DEFAULT_MAX_CONTROLS);
    expect(text).toContain(`more controls not shown` );
    expect(text).toContain(`capped at ${DEFAULT_MAX_CONTROLS}`);
    // The remainder must be the true remainder, not "1 more" per skipped parent.
    expect(text).toContain(`${600 - DEFAULT_MAX_CONTROLS} more controls not shown`);
    expect(text).toContain('searchControl');
  });

  it('honours maxControls when the caller really wants the whole tree', async () => {
    const res = await tryBridgeForm(fakeBridge({ form: form(600) }), 'SalesTable', 1000);
    const text = res!.content[0].text;
    expect((text.match(/^\s*- \*\*(Ctrl|Group)/gm) ?? []).length).toBe(600);
    expect(text).not.toContain('more controls not shown');
  });

  it('leaves a small form untouched', async () => {
    const res = await tryBridgeForm(fakeBridge({ form: form(12) }), 'MyForm');
    expect(res!.content[0].text).not.toContain('more controls not shown');
  });
});

describe('the new knobs are reachable from the published surface', () => {
  it('names fieldsOffset, fieldFilter and maxControls in the get_object_info options schema', async () => {
    // A payload cap the model cannot see does not shrink anything — it just makes
    // the reader look like it lost data.
    const { toolSchemas } = await import('../../src/server/toolSchemas/index');
    const schema: any = toolSchemas.find(t => t.name === 'get_object_info');
    const optionsDesc = schema.inputSchema.properties.options.description;

    expect(optionsDesc).toContain('fieldsOffset');
    expect(optionsDesc).toContain('fieldFilter');
    expect(optionsDesc).toContain('maxControls');
  });
});

describe('truncation cuts on a block boundary (audit §4.6)', () => {
  it('never ends inside an XML element', () => {
    const xml = Array.from({ length: 200 }, (_, i) => `  <Textbox Name="Field${i}" Width="2.5in" />`).join('\n');
    for (const cap of [100, 137, 250, 999, 1500]) {
      const cut = truncateOnBlockBoundary(xml, cap);
      expect(cut.length).toBeLessThanOrEqual(cap);
      // A trailing '<' with no matching '>' is exactly the dangling-tag failure.
      expect(cut.lastIndexOf('<')).toBeLessThanOrEqual(cut.lastIndexOf('>'));
    }
  });

  it('prefers a blank-line block boundary and keeps most of the budget', () => {
    const doc = 'A'.repeat(400) + '\n\n' + 'B'.repeat(400) + '\n\n' + 'C'.repeat(400);
    const cut = truncateOnBlockBoundary(doc, 900);
    expect(cut).toBe('A'.repeat(400) + '\n\n' + 'B'.repeat(400));
  });

  it('falls back to the raw cap when no boundary is close enough', () => {
    const oneLine = 'x'.repeat(5000);
    expect(truncateOnBlockBoundary(oneLine, 1000)).toHaveLength(1000);
  });

  it('returns the text untouched when it fits', () => {
    expect(truncateOnBlockBoundary('short', 1000)).toBe('short');
  });
});

describe('response cap footer asks for LESS, not more (audit §4.5)', () => {
  const overCap = (text: string) => capToolResponse('analyze_code', { content: [{ type: 'text', text }] });

  it('no longer tells the caller to pass compact=false, which grows the response', () => {
    const res = overCap('y'.repeat(9000));
    const footer = res.content[0].text;
    expect(footer).not.toContain('compact=false');
    expect(footer).toContain('compact=true');
    expect(footer).toMatch(/fieldsOffset|fieldFilter/);
    expect(footer).toContain('omitted');
  });

  it('cuts the capped body on a boundary too', () => {
    const xml = Array.from({ length: 500 }, (_, i) => `  <Node Name="N${i}" Attr="value" />`).join('\n');
    const body = capToolResponse('analyze_code', { content: [{ type: 'text', text: xml }] }).content[0].text;
    const cutPart = body.split('\n\n> ✂️')[0];
    expect(cutPart.lastIndexOf('<')).toBeLessThanOrEqual(cutPart.lastIndexOf('>'));
  });

  it('leaves an under-cap response and an uncapped tool alone', () => {
    const small = { content: [{ type: 'text', text: 'fine' }] };
    expect(capToolResponse('analyze_code', small)).toStrictEqual(small);
    const big = { content: [{ type: 'text', text: 'z'.repeat(50_000) }] };
    expect(capToolResponse('get_object_info', big)).toBe(big);
  });
});
