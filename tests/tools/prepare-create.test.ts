/**
 * prepare_create tool tests — single-round aggregator for new objects.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prepareCreateTool } from '../../src/tools/prepareCreate';
import { getProvenanceBundle } from '../../src/utils/provenanceStore';
import type { XppServerContext } from '../../src/types/context';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';

const req = (args: Record<string, unknown> = {}): CallToolRequest => ({
  method: 'tools/call',
  params: { name: 'prepare_create', arguments: args },
});

const getText = (result: any): string => result.content?.[0]?.text ?? '';

/** In-memory stub over the queries prepare_create issues. */
const buildContext = (opts: {
  existingNames?: Array<{ name: string; type: string; model: string }>;
  edts?: Array<{ name: string; signature: string | null }>;
  labels?: Array<{ labelId: string; labelFileId: string; model: string; text: string }>;
  stats?: boolean;
} = {}): XppServerContext => {
  const db = {
    prepare: vi.fn((sql: string) => ({
      all: vi.fn((..._params: unknown[]) => {
        if (sql.includes("type = 'edt'")) return opts.edts ?? [];
        if (sql.includes('name IN (?, ?)')) return opts.existingNames ?? [];
        return [];
      }),
      get: vi.fn(() => undefined),
      run: vi.fn(),
    })),
  };
  const symbolIndex: any = {
    getReadDb: () => db,
    searchLabels: vi.fn(() => opts.labels ?? []),
  };
  if (opts.stats) {
    symbolIndex.getPropertyPresenceRatio = vi.fn(() => ({ present: 950, total: 1000, ratio: 0.95 }));
    symbolIndex.getPropertyValueDistribution = vi.fn(() => [
      { value: 'Main', count: 600 },
      { value: 'Transaction', count: 400 },
    ]);
  }
  return { symbolIndex } as unknown as XppServerContext;
};

beforeEach(() => {
  delete process.env.EXTENSION_PREFIX;
});

describe('prepare_create input validation', () => {
  it('rejects missing objectType', async () => {
    const result = await prepareCreateTool(
      req({ goal: 'x', objectName: 'ImportParameters' }),
      buildContext(),
    );
    expect(result.isError).toBe(true);
  });
});

describe('prepare_create aggregation', () => {
  it('returns all sections and a valid object-bound grounding token', async () => {
    const result = await prepareCreateTool(
      req({ goal: 'Import parameters table', objectName: 'ImportParameters', objectType: 'table' }),
      buildContext(),
    );
    const text = getText(result);
    expect(result.isError).toBeFalsy();
    expect(text).toContain('Collision check');
    expect(text).toContain('Naming');
    expect(text).toContain('Reusable labels');
    expect(text).toContain('Grounding token');

    const token = /\*\*Grounding token:\*\* `([0-9a-f]{32})`/.exec(text)?.[1];
    expect(token).toBeTruthy();
    const bundle = getProvenanceBundle(token!);
    expect(bundle?.context.objectName).toBe('ImportParameters');
    expect(bundle?.context.objectType).toBe('table');
  });

  it('reports collisions found in the index', async () => {
    const result = await prepareCreateTool(
      req({ goal: 'x', objectName: 'CustTable', objectType: 'table' }),
      buildContext({ existingNames: [{ name: 'CustTable', type: 'table', model: 'ApplicationSuite' }] }),
    );
    expect(getText(result)).toContain('already exists as table');
  });

  it('applies EXTENSION_PREFIX to the final name', async () => {
    process.env.EXTENSION_PREFIX = 'Contoso';
    const result = await prepareCreateTool(
      req({ goal: 'x', objectName: 'ImportParameters', objectType: 'table' }),
      buildContext(),
    );
    expect(getText(result)).toContain('ContosoImportParameters');
  });

  it('suggests EDTs for fieldsHint', async () => {
    const result = await prepareCreateTool(
      req({
        goal: 'x', objectName: 'ImportParameters', objectType: 'table',
        fieldsHint: ['CustAccount'],
      }),
      buildContext({ edts: [{ name: 'CustAccount', signature: 'AccountNum' }] }),
    );
    const text = getText(result);
    expect(text).toContain('EDT suggestions');
    expect(text).toContain('CustAccount → CustAccount (extends AccountNum)');
  });

  it('lists reusable labels from the labels index', async () => {
    const result = await prepareCreateTool(
      req({ goal: 'x', objectName: 'ImportParameters', objectType: 'table' }),
      buildContext({ labels: [{ labelId: 'ImportParams', labelFileId: 'Contoso', model: 'ContosoModel', text: 'Import parameters' }] }),
    );
    expect(getText(result)).toContain('@Contoso:ImportParams');
  });

  it('includes mined property defaults for tables when stats exist', async () => {
    const result = await prepareCreateTool(
      req({ goal: 'x', objectName: 'ImportParameters', objectType: 'table' }),
      buildContext({ stats: true }),
    );
    const text = getText(result);
    expect(text).toContain('Property defaults');
    expect(text).toContain('95% of standard tables');
    expect(text).toContain('Main (60%)');
  });

  it('flags invalid names', async () => {
    const result = await prepareCreateTool(
      req({ goal: 'x', objectName: 'importParameters', objectType: 'class' }),
      buildContext(),
    );
    expect(getText(result)).toContain('must start with an uppercase letter');
  });

  // Regression: objectType enum used to be a much older, narrower list than
  // what d365fo_file(action="create") actually supports — map/business-event/
  // tile/kpi/menu were rejected by prepare(mode="create") even though the
  // create tool itself has always accepted them. Found authoring the
  // L1-map-basic eval case (2026-07-01).
  it.each(['map', 'business-event', 'tile', 'kpi', 'menu'])(
    'accepts objectType=%s (previously rejected — enum drift vs createD365File.ts)',
    async (objectType) => {
      const result = await prepareCreateTool(
        req({ goal: 'x', objectName: 'MyNewObject', objectType }),
        buildContext(),
      );
      expect(result.isError).toBeFalsy();
    },
  );
});
