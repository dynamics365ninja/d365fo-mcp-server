/**
 * Phase 1.1 — several modify operations in ONE tool call.
 *
 * The audit's largest round-trip finding: a table change is never one
 * operation. "add three fields" was 3 calls, each add-field response then told
 * the agent to make a field-group call (in as many words), and an index or
 * relation added more — 8 to 14 round trips for one ordinary task, every one of
 * them re-billing the whole cached context.
 *
 * Each entry goes through the ORDINARY single-op path, so the guards
 * (containment, backups, prefixing, .rnrproj registration, direct-XML
 * fallbacks) all still run. These tests pin the batch semantics: order,
 * stop-at-first-failure, shared-vs-entry key precedence, and that the failure
 * report says what was and was not applied.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';

const { mockModify } = vi.hoisted(() => ({ mockModify: vi.fn() }));

vi.mock('../../src/tools/write/modifyD365File', () => ({
  modifyD365FileTool: mockModify,
}));
vi.mock('../../src/tools/write/createD365File', () => ({ handleCreateD365File: vi.fn() }));
vi.mock('../../src/tools/xml/generateD365Xml', () => ({ handleGenerateD365Xml: vi.fn() }));

import { d365foFileTool } from '../../src/tools/d365foFile';

const ctx = {} as any;
const ok = (text: string) => ({ content: [{ type: 'text', text }] });
const fail = (text: string) => ({ content: [{ type: 'text', text }], isError: true });

const call = (args: Record<string, unknown>): CallToolRequest => ({
  method: 'tools/call',
  params: { name: 'd365fo_file', arguments: { action: 'modify', ...args } },
});

/** The arguments each forwarded single-op call actually received. */
const forwarded = () => mockModify.mock.calls.map(c => (c[0] as CallToolRequest).params.arguments as any);

const text = (r: any) => r.content[0].text as string;

describe('d365fo_file(action="modify") with operations[]', () => {
  beforeEach(() => {
    mockModify.mockReset();
    mockModify.mockImplementation(async () => ok('applied'));
  });

  it('runs every operation in one call, in order', async () => {
    const result = await d365foFileTool(call({
      objectType: 'table',
      objectName: 'ContosoXyzTable',
      operations: [
        { operation: 'add-field', fieldName: 'AccountNum' },
        { operation: 'add-field', fieldName: 'Amount' },
        { operation: 'add-field-to-field-group', fieldName: 'AccountNum', fieldGroupName: 'AutoReport' },
      ],
    }), ctx);

    expect(mockModify).toHaveBeenCalledTimes(3);
    expect(forwarded().map(a => a.operation)).toEqual(['add-field', 'add-field', 'add-field-to-field-group']);
    expect(result.isError).toBeFalsy();
    expect(text(result)).toContain('3/3 operation(s) applied');
  });

  it('carries shared keys into every entry, and lets an entry override them', async () => {
    await d365foFileTool(call({
      objectType: 'table',
      objectName: 'ContosoXyzTable',
      modelName: 'ContosoExt',
      operations: [
        { operation: 'add-field', fieldName: 'A' },
        { operation: 'add-field', fieldName: 'B', objectName: 'ContosoOtherTable' },
      ],
    }), ctx);

    const [first, second] = forwarded();
    expect(first).toMatchObject({ objectType: 'table', objectName: 'ContosoXyzTable', modelName: 'ContosoExt', fieldName: 'A' });
    expect(second).toMatchObject({ objectName: 'ContosoOtherTable', modelName: 'ContosoExt', fieldName: 'B' });
  });

  it('stops at the first failure instead of cascading into it', async () => {
    mockModify
      .mockImplementationOnce(async () => ok('field added'))
      .mockImplementationOnce(async () => fail('❌ EDT "Iteger" does not exist'))
      .mockImplementationOnce(async () => ok('should never run'));

    const result = await d365foFileTool(call({
      objectType: 'table',
      objectName: 'ContosoXyzTable',
      operations: [
        { operation: 'add-field', fieldName: 'A' },
        { operation: 'add-field', fieldName: 'B' },
        { operation: 'add-index', indexName: 'Idx' },
      ],
    }), ctx);

    expect(mockModify).toHaveBeenCalledTimes(2);
    expect(result.isError).toBe(true);
    const t = text(result);
    expect(t).toContain('1/3 operation(s) applied');
    expect(t).toContain('failed at #2');
    expect(t).toContain('1 not attempted');
    // The partial state has to be stated — the first field IS on disk.
    expect(t).toMatch(/ARE applied/);
    expect(t).toContain('Iteger');
  });

  it('rejects an empty operations[]', async () => {
    const result = await d365foFileTool(call({ objectType: 'table', objectName: 'T', operations: [] }), ctx);
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('operations[] is empty');
    expect(mockModify).not.toHaveBeenCalled();
  });

  it('caps the batch size rather than accepting an unbounded list', async () => {
    const operations = Array.from({ length: 21 }, (_, i) => ({ operation: 'add-field', fieldName: `F${i}` }));
    const result = await d365foFileTool(call({ objectType: 'table', objectName: 'T', operations }), ctx);
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('max 20');
    expect(mockModify).not.toHaveBeenCalled();
  });

  it('rejects an entry with no operation key before writing anything', async () => {
    const result = await d365foFileTool(call({
      objectType: 'table', objectName: 'T',
      operations: [{ fieldName: 'A' }],
    }), ctx);
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('no `operation` key');
    expect(mockModify).not.toHaveBeenCalled();
  });

  it('leaves the single-operation form untouched', async () => {
    await d365foFileTool(call({
      objectType: 'table', objectName: 'T', operation: 'add-field', fieldName: 'A',
    }), ctx);

    expect(mockModify).toHaveBeenCalledTimes(1);
    expect(forwarded()[0]).toMatchObject({ operation: 'add-field', fieldName: 'A' });
    // No batch wrapper around a single op.
    expect(forwarded()[0].operations).toBeUndefined();
  });

  it('accepts operations[] nested in params, like every other modify parameter', async () => {
    await d365foFileTool(call({
      objectType: 'table', objectName: 'T',
      params: { operations: [{ operation: 'add-field', fieldName: 'A' }] },
    }), ctx);

    expect(mockModify).toHaveBeenCalledTimes(1);
    expect(forwarded()[0]).toMatchObject({ operation: 'add-field', fieldName: 'A' });
  });
});
