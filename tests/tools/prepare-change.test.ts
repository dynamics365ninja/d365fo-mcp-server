/**
 * prepare_change tool tests — single-round context aggregator
 */

import { describe, it, expect, vi } from 'vitest';
import { prepareChangeTool } from '../../src/tools/prepare/prepareChange';
import type { XppServerContext } from '../../src/types/context';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';

const req = (args: Record<string, unknown> = {}): CallToolRequest => ({
  method: 'tools/call',
  params: { name: 'prepare_change', arguments: args },
});

const buildContext = (overrides: Partial<XppServerContext> = {}): XppServerContext => ({
  symbolIndex: {
    searchSymbols: vi.fn(() => [{ id: 1, name: 'CustTable', type: 'table', filePath: '/Tables/CustTable.xml', model: 'ApplicationSuite' }]),
    getSymbolByName: vi.fn(() => ({ id: 1, name: 'CustTable', type: 'table', filePath: '/Tables/CustTable.xml', model: 'ApplicationSuite' })),
    getClassMethods: vi.fn(() => []),
    getTableFields: vi.fn(() => []),
    searchLabels: vi.fn(() => []),
    getCustomModels: vi.fn(() => []),
    getAllSymbolNames: vi.fn(() => []),
    getCompletions: vi.fn(() => []),
    analyzeCodePatterns: vi.fn(() => ({ scenario: '', totalMatches: 0, patterns: [], exampleClasses: [] })),
    findSimilarMethods: vi.fn(() => []),
    suggestMissingMethods: vi.fn(() => []),
    getApiUsagePatterns: vi.fn(() => []),
    db: { prepare: vi.fn(() => ({ all: vi.fn(() => []), get: vi.fn(() => undefined), run: vi.fn() })) },
    getReadDb: vi.fn(function(this: any) { return this.db; }),
  } as any,
  parser: {
    parseClassFile: vi.fn(async () => ({ success: false })),
    parseTableFile: vi.fn(async () => ({ success: false })),
  } as any,
  cache: {
    get: vi.fn(async () => null),
    set: vi.fn(async () => {}),
    generateSearchKey: vi.fn((q: string) => `k:${q}`),
  } as any,
  workspaceScanner: {} as any,
  hybridSearch: { searchWorkspace: vi.fn(async () => []) } as any,
  bridge: undefined,
  ...overrides,
});

// ─── Input validation ────────────────────────────────────────────────────────

describe('prepare_change input validation', () => {
  it('returns error on missing goal', async () => {
    const result = await prepareChangeTool(
      req({ objectName: 'CustTable' }),
      buildContext(),
    );
    expect(result.isError).toBe(true);
  });

  it('returns error on missing objectName', async () => {
    const result = await prepareChangeTool(
      req({ goal: 'Add validation logic' }),
      buildContext(),
    );
    expect(result.isError).toBe(true);
  });
});

// ─── Successful aggregation ──────────────────────────────────────────────────

describe('prepare_change aggregation', () => {
  it('returns a grounding token in the response', async () => {
    const result = await prepareChangeTool(
      req({ goal: 'Add CoC on validateWrite', objectName: 'CustTable', methodName: 'validateWrite' }),
      buildContext(),
    );
    expect(result.isError).toBeFalsy();
    const text = result.content?.[0]?.text ?? '';
    expect(text).toMatch(/groundingToken|grounding_token/i);
  });

  it('includes objectName in the response', async () => {
    const result = await prepareChangeTool(
      req({ goal: 'Extend CustTable', objectName: 'CustTable' }),
      buildContext(),
    );
    const text = result.content?.[0]?.text ?? '';
    expect(text).toContain('CustTable');
  });

  it('includes naming validation when proposedName is provided', async () => {
    const result = await prepareChangeTool(
      req({
        goal: 'Add CoC on validateWrite',
        objectName: 'CustTable',
        methodName: 'validateWrite',
        proposedName: 'CustTable_MyExt_Extension',
      }),
      buildContext(),
    );
    const text = result.content?.[0]?.text ?? '';
    expect(text).toMatch(/naming|valid|CustTable_MyExt_Extension/i);
  });
});
