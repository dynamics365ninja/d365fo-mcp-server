/**
 * New table fields get the EDT or base enum they need, created first.
 *
 * A field with only a primitive type draws BPErrorTableFieldNotDefinedUsingType, and
 * one that names a missing EDT or enum does not build. The writes that add fields
 * (create table, add-field, scaffold table) now create the type through
 * handleCreateD365File and point the field at the name it was written under.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';

const { mockCreate, mockModify, mockSmartTable, known } = vi.hoisted(() => ({
  mockCreate: vi.fn(),
  mockModify: vi.fn(),
  mockSmartTable: vi.fn(),
  /** name → kind and base type of the types the "index" holds. */
  known: new Map<string, { type: 'edt' | 'enum'; base?: string }>(),
}));

vi.mock('../../src/tools/write/createD365File', () => ({ handleCreateD365File: mockCreate }));
vi.mock('../../src/tools/write/modifyD365File', () => ({ modifyD365FileTool: mockModify }));
vi.mock('../../src/tools/write/deleteD365File', () => ({ handleDeleteD365File: vi.fn() }));
vi.mock('../../src/tools/xml/generateD365Xml', () => ({ handleGenerateD365Xml: vi.fn() }));
vi.mock('../../src/tools/smart/generateSmartTable', async orig => ({
  ...(await orig<typeof import('../../src/tools/smart/generateSmartTable')>()),
  handleGenerateSmartTable: mockSmartTable,
}));
vi.mock('../../src/utils/symbolLookup', async orig => ({
  ...(await orig<typeof import('../../src/utils/symbolLookup')>()),
  lookupSymbolsNocase: vi.fn((_db: unknown, name: string, opts: { types?: string[] }) => {
    const k = known.get(name);
    return k && (!opts.types || opts.types.includes(k.type)) ? [{ name, type: k.type }] : [];
  }),
}));
vi.mock('../../src/utils/objectNaming', async orig => ({
  ...(await orig<typeof import('../../src/utils/objectNaming')>()),
  normalizeObjectName: vi.fn((n: string) => (n.startsWith('Contoso') ? n : `Contoso${n}`)),
}));

import { d365foFileTool } from '../../src/tools/d365foFile';
import { generateObjectTool } from '../../src/tools/generateObject';
import { labelTextFor, primitiveOf } from '../../src/tools/write/fieldTypeProvisioning';

/** A db whose edt_metadata knows the base type of the "known" EDTs. */
const db = {
  prepare: () => ({
    get: (name: string) => {
      const k = known.get(name);
      return k?.type === 'edt' ? { extends: k.base ?? null, enum_type: null, string_size: k.base === 'String' ? 20 : null } : undefined;
    },
    all: () => [],
  }),
};
const ctx = { symbolIndex: { getReadDb: () => db } } as any;

const call = (args: Record<string, unknown>): CallToolRequest => ({
  method: 'tools/call', params: { name: 'd365fo_file', arguments: args },
});
const text = (r: any) => (r.content as Array<{ text: string }>).map(c => c.text).join('\n');
const createCalls = () => mockCreate.mock.calls.map(c => (c[0] as CallToolRequest).params.arguments as any);

/** create writes everything under the Contoso prefix; a name in `existing` is already on disk. */
function createsWithPrefix(existing: string[] = []) {
  mockCreate.mockImplementation(async (req: CallToolRequest, _ctx: unknown, outcome: any) => {
    const a = req.params.arguments as any;
    const name = a.objectName.startsWith('Contoso') ? a.objectName : `Contoso${a.objectName}`;
    if (outcome) {
      outcome.finalObjectName = name;
      outcome.filePath = `K:/pkg/${name}.xml`;
      if (existing.includes(name)) outcome.alreadyExisted = true;
    }
    return { content: [{ type: 'text', text: `created ${a.objectType} ${name}` }] };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  known.clear();
  known.set('ItemId', { type: 'edt', base: 'String' });
  known.set('TransDate', { type: 'edt', base: 'Date' });
  known.set('NoYes', { type: 'enum' });
});

describe('helpers', () => {
  it('reads primitive types in any spelling', () => {
    expect(primitiveOf('string')).toBe('String');
    expect(primitiveOf('AxTableFieldInt64')).toBe('Int64');
    expect(primitiveOf('DateTime')).toBe('UtcDateTime');
    expect(primitiveOf('ItemId')).toBeUndefined();
  });

  it('turns a name into label text', () => {
    expect(labelTextFor('ClaimExportDate')).toBe('Claim export date');
    expect(labelTextFor('VATRegNum')).toBe('VAT reg num');
  });
});

describe('d365fo_file create table', () => {
  it('creates the missing types first and points the fields at them', async () => {
    createsWithPrefix();
    const fields = [
      { name: 'ClaimRef', type: 'String', stringSize: 20, label: 'Claim reference' },
      { name: 'Status', enumType: 'ContosoClaimStatus', enumValues: ['Open', { name: 'Closed', label: 'Settled' }] },
      { name: 'ItemId', edt: 'ItemId' },
      { name: 'Amount', edt: 'ContosoClaimAmount' },
      { name: 'TransDate', type: 'Date' },
      { name: 'Approved', enumType: 'NoYes' },
    ];
    const r: any = await d365foFileTool(
      call({ action: 'create', objectType: 'table', objectName: 'ContosoClaim', modelName: 'ContosoExt', properties: { fields } }),
      ctx,
    );

    const calls = createCalls();
    expect(calls.map(c => `${c.objectType}:${c.objectName}`)).toEqual([
      'edt:ClaimRef', 'enum:ContosoClaimStatus', 'edt:ContosoClaimAmount', 'table:ContosoClaim',
    ]);
    expect(calls[0].properties).toEqual({ edtType: 'AxEdtString', label: 'Claim reference', stringSize: 20 });
    expect(calls[0].modelName).toBe('ContosoExt');
    expect(calls[1].properties).toEqual({
      label: 'Status',
      enumValues: [{ name: 'Open', label: 'Open' }, { name: 'Closed', label: 'Settled' }],
    });
    expect(calls[2].properties).toEqual({ edtType: 'AxEdtReal', label: 'Amount' });

    const written = calls[3].properties.fields;
    expect(written[0]).toEqual({ name: 'ClaimRef', type: 'String', stringSize: 20, edt: 'ContosoClaimRef' });
    expect(written[1].enumType).toBe('ContosoClaimStatus');
    expect(written[1]).not.toHaveProperty('label');
    expect(written[2]).toEqual({ name: 'ItemId', edt: 'ItemId' });
    expect(written[3].edt).toBe('ContosoClaimAmount');
    expect(written[4]).toEqual({ name: 'TransDate', type: 'Date', edt: 'TransDate' });
    expect(written[5]).toEqual({ name: 'Approved', enumType: 'NoYes' });

    expect(text(r)).toContain('🧩 Types for the new fields');
    expect(text(r)).toContain('Created EDT ContosoClaimRef (String, size 20, label "Claim reference")');
    expect(text(r)).toContain('BPErrorTableFieldNotDefinedUsingType');
    expect(text(r)).toContain('Field TransDate uses the existing EDT TransDate');
    expect(r.isError).toBeFalsy();
  });

  it('does not write the table when a type could not be created', async () => {
    mockCreate.mockImplementation(async () => ({ content: [{ type: 'text', text: '❌ no model' }], isError: true }));
    const r: any = await d365foFileTool(
      call({ action: 'create', objectType: 'table', objectName: 'ContosoClaim', properties: { fields: [{ name: 'Ref', type: 'String' }] } }),
      ctx,
    );
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/Creating EDT Ref for field Ref failed: ❌ no model/);
    expect(createCalls().map(c => c.objectType)).toEqual(['edt']);
  });

  it('uses a type already on disk that the index does not know yet', async () => {
    createsWithPrefix(['ContosoClaimAmount']);
    const r: any = await d365foFileTool(
      call({ action: 'create', objectType: 'table', objectName: 'ContosoClaim', properties: { fields: [{ name: 'Amount', edt: 'ContosoClaimAmount', label: 'Claim amount' }] } }),
      ctx,
    );
    const table = createCalls()[1];
    expect(table.properties.fields[0]).toEqual({ name: 'Amount', edt: 'ContosoClaimAmount', label: 'Claim amount' });
    expect(text(r)).not.toContain('Created EDT');
  });

  it('refuses a primitive field whose EDT name is taken by another base type', async () => {
    createsWithPrefix();
    known.set('ContosoRef', { type: 'edt', base: 'Int64' });
    const r: any = await d365foFileTool(
      call({ action: 'create', objectType: 'table', objectName: 'ContosoClaim', properties: { fields: [{ name: 'Ref', type: 'String' }] } }),
      ctx,
    );
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('ContosoRef exists with another base type than String');
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('leaves the fields alone with autoCorrect=false, or without an index', async () => {
    createsWithPrefix();
    const fields = [{ name: 'Ref', type: 'String' }];
    await d365foFileTool(call({ action: 'create', objectType: 'table', objectName: 'ContosoClaim', autoCorrect: false, properties: { fields } }), ctx);
    await d365foFileTool(call({ action: 'create', objectType: 'table', objectName: 'ContosoClaim', properties: { fields } }), {} as any);
    expect(createCalls().map(c => c.objectType)).toEqual(['table', 'table']);
  });
});

describe('d365fo_file modify add-field', () => {
  it('creates the EDT for a base-type-only field and sends the field with it', async () => {
    createsWithPrefix();
    mockModify.mockResolvedValue({ content: [{ type: 'text', text: 'field added' }] });
    const r: any = await d365foFileTool(
      call({ action: 'modify', objectType: 'table-extension', objectName: 'CustTable.ContosoExt', operation: 'add-field', fieldName: 'ContosoClaimCount', fieldBaseType: 'Integer', fieldLabel: 'Claim count' }),
      ctx,
    );
    expect(createCalls()[0]).toMatchObject({ objectType: 'edt', objectName: 'ContosoClaimCount', properties: { edtType: 'AxEdtInt', label: 'Claim count' } });
    const sent = (mockModify.mock.calls[0][0] as CallToolRequest).params.arguments as any;
    expect(sent.fieldType).toBe('ContosoClaimCount');
    expect(sent).not.toHaveProperty('fieldBaseType');
    expect(sent).not.toHaveProperty('fieldLabel');
    expect(text(r)).toContain('field added');
    expect(text(r)).toContain('Created EDT ContosoClaimCount (Integer');
  });

  it('creates a missing enum for an add-field in operations[]', async () => {
    createsWithPrefix();
    mockModify.mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });
    await d365foFileTool(
      call({
        action: 'modify', objectType: 'table', objectName: 'ContosoClaim',
        operations: [{ operation: 'add-field', fieldName: 'Channel', fieldEnumType: 'ContosoChannel', fieldEnumValues: ['Retail', 'Online'] }],
      }),
      ctx,
    );
    expect(createCalls()[0]).toMatchObject({
      objectType: 'enum', objectName: 'ContosoChannel',
      properties: { label: 'Channel', enumValues: [{ name: 'Retail', label: 'Retail' }, { name: 'Online', label: 'Online' }] },
    });
  });

  it('makes a RecId reference EDT extend RefRecId', async () => {
    createsWithPrefix();
    mockModify.mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });
    const r: any = await d365foFileTool(
      call({ action: 'modify', objectType: 'table', objectName: 'ContosoClaim', operation: 'add-field', fieldName: 'AgreementRecId', fieldBaseType: 'Int64' }),
      ctx,
    );
    expect(createCalls()[0].properties).toEqual({ edtType: 'AxEdtInt64', label: 'Agreement rec id', extends: 'RefRecId' });
    expect(text(r)).toContain('Created EDT ContosoAgreementRecId (Int64, extends RefRecId');
  });

  it('does nothing for a field whose EDT exists', async () => {
    mockModify.mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });
    await d365foFileTool(call({ action: 'modify', objectType: 'table', objectName: 'ContosoClaim', operation: 'add-field', fieldName: 'ItemId', fieldType: 'ItemId' }), ctx);
    expect(mockCreate).not.toHaveBeenCalled();
  });
});

describe('generate_object scaffold table', () => {
  it('creates the missing types before the table is generated', async () => {
    // (the generator itself may not import the write tools; generate_object does this in front of it)
    createsWithPrefix();
    mockSmartTable.mockResolvedValue({ content: [{ type: 'text', text: 'table generated' }] });
    const r: any = await generateObjectTool(
      { method: 'tools/call', params: { name: 'generate_object', arguments: { mode: 'scaffold', objectType: 'table', name: 'ContosoClaim', fields: [{ name: 'Ref', type: 'String' }] } } },
      ctx,
    );
    expect(createCalls()[0]).toMatchObject({ objectType: 'edt', objectName: 'Ref' });
    expect(mockSmartTable.mock.calls[0][0].fields[0]).toEqual({ name: 'Ref', type: 'String', edt: 'ContosoRef' });
    expect(text(r)).toContain('table generated');
    expect(text(r)).toContain('Created EDT ContosoRef');
  });
});
