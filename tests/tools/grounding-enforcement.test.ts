/**
 * Fail-closed grounding enforcement in write tools.
 *
 * When GROUNDING_ENFORCE=true, extension objectTypes in create_d365fo_file and
 * modify_d365fo_file must reject calls without a valid (object-bound) token
 * BEFORE touching the file system.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { handleCreateD365File } from '../../src/tools/write/createD365File';
import { modifyD365FileTool } from '../../src/tools/write/modifyD365File';
import { createProvenanceToken } from '../../src/utils/provenanceStore';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import type { XppServerContext } from '../../src/types/context';

const ORIGINAL_ENFORCE = process.env.GROUNDING_ENFORCE;

afterEach(() => {
  if (ORIGINAL_ENFORCE === undefined) delete process.env.GROUNDING_ENFORCE;
  else process.env.GROUNDING_ENFORCE = ORIGINAL_ENFORCE;
});

const createReq = (args: Record<string, unknown>): CallToolRequest => ({
  method: 'tools/call',
  params: { name: 'create_d365fo_file', arguments: args },
});

const modifyReq = (args: Record<string, unknown>): CallToolRequest => ({
  method: 'tools/call',
  params: { name: 'modify_d365fo_file', arguments: args },
});

// Enforcement runs before any context access — a stub is sufficient.
const stubContext = {} as XppServerContext;

describe('create_d365fo_file grounding enforcement', () => {
  it('rejects extension objectType without a token when GROUNDING_ENFORCE=true', async () => {
    process.env.GROUNDING_ENFORCE = 'true';
    const result = await handleCreateD365File(createReq({
      objectType: 'class-extension',
      objectName: 'CustTable.ContosoExtension',
    }));
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Grounding required');
    expect(result.content[0].text).toContain('prepare(mode="change"');
  });

  it('rejects a token issued for a different object', async () => {
    process.env.GROUNDING_ENFORCE = 'true';
    const token = createProvenanceToken({ goal: 'test', objectName: 'SalesTable' });
    const result = await handleCreateD365File(createReq({
      objectType: 'table-extension',
      objectName: 'CustTable.ContosoExtension',
      groundingToken: token,
    }));
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('token mismatch');
  });

  it('does not block non-extension objectTypes', async () => {
    process.env.GROUNDING_ENFORCE = 'true';
    const result = await handleCreateD365File(createReq({
      objectType: 'class',
      objectName: 'ContosoHelper',
      packagePath: 'Z:\\nonexistent\\path',
    }));
    // May fail later for other reasons (no model/path), but never for grounding.
    expect(result.content[0].text ?? '').not.toContain('Grounding required');
  });
});

describe('modify_d365fo_file grounding enforcement', () => {
  it('rejects extension objectType without a token when GROUNDING_ENFORCE=true', async () => {
    process.env.GROUNDING_ENFORCE = 'true';
    const result = await modifyD365FileTool(modifyReq({
      objectType: 'form-extension',
      objectName: 'SalesTable.ContosoExtension',
      operation: 'add-control',
      controlName: 'MyControl',
      parentControl: 'TabGeneral',
    }), stubContext);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Grounding required');
  });

  it('accepts a valid object-bound token (passes enforcement gate)', async () => {
    process.env.GROUNDING_ENFORCE = 'true';
    const token = createProvenanceToken({ goal: 'test', objectName: 'SalesTable' });
    const result = await modifyD365FileTool(modifyReq({
      objectType: 'table-extension',
      objectName: 'SalesTable.ContosoExtension',
      operation: 'add-field',
      fieldName: 'ContosoField',
      groundingToken: token,
      filePath: 'Z:\\nonexistent\\SalesTable.ContosoExtension.xml',
    }), stubContext);
    // Fails later (file does not exist), but NOT at the grounding gate.
    expect(result.content[0].text ?? '').not.toContain('Grounding required');
    expect(result.content[0].text ?? '').not.toContain('token mismatch');
  });
});
