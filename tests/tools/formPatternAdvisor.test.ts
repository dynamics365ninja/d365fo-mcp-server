/**
 * Form Pattern Advisor tests — the Microsoft decision tree implemented by
 * recommendPattern(), plus the recommend-mode rendering with and without
 * mined pattern data.
 */

import { describe, it, expect, vi } from 'vitest';
import { recommendPattern, getFormPatternsTool, type RecommendInput } from '../../src/tools/getFormPatterns';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';

describe('recommendPattern decision tree', () => {
  const cases: Array<[RecommendInput, string]> = [
    [{ usageIntent: 'pickValue' }, 'Lookup'],
    [{ entityKind: 'lookup' }, 'Lookup'],
    [{ usageIntent: 'quickCreate', fieldCount: 3 }, 'DropDialog'],
    [{ usageIntent: 'quickCreate', fieldCount: 8 }, 'Dialog'],
    [{ entityKind: 'dialogTask' }, 'Dialog'],
    [{ usageIntent: 'dashboard' }, 'WorkspaceOperational'],
    [{ entityKind: 'workspace' }, 'WorkspaceOperational'],
    [{ entityKind: 'parameters' }, 'TableOfContents'],
    [{ entityKind: 'transaction' }, 'DetailsTransaction'],
    [{ hasHeaderLines: true }, 'DetailsTransaction'],
    [{ entityKind: 'inquiry' }, 'ListPage'],
    [{ entityKind: 'master', usageIntent: 'viewOnly' }, 'ListPage'],
    [{ entityKind: 'master' }, 'DetailsMaster'],
    [{ entityKind: 'setup', fieldCount: 5 }, 'SimpleList'],
    [{ entityKind: 'setup', fieldCount: 18 }, 'SimpleListDetails'],
    [{}, 'SimpleList'], // default
  ];

  for (const [input, expected] of cases) {
    it(`${JSON.stringify(input)} → ${expected}`, () => {
      const rec = recommendPattern(input);
      expect(rec.spec.id).toBe(expected);
      expect(rec.reasons.length).toBeGreaterThan(0);
      expect(rec.spec.referenceForms.length).toBeGreaterThan(0);
    });
  }

  it('offers alternatives where the choice is close', () => {
    const rec = recommendPattern({ entityKind: 'setup', fieldCount: 5 });
    expect(rec.alternatives.map((a) => a.spec.id)).toContain('SimpleListDetails');
  });
});

describe('get_form_patterns recommend mode', () => {
  const makeContext = (opts: { minedRows?: any[]; fieldCount?: number; throwOnFormPatterns?: boolean }) => {
    const db = {
      prepare: vi.fn((sql: string) => ({
        get: vi.fn(() => {
          if (sql.includes("type = 'field'")) return { c: opts.fieldCount ?? 0 };
          if (sql.includes('COUNT(*) AS c FROM form_patterns')) {
            if (opts.throwOnFormPatterns) throw new Error('no such table: form_patterns');
            return { c: (opts.minedRows?.length ?? 0) > 0 ? 1 : 0 };
          }
          return undefined;
        }),
        all: vi.fn(() => {
          if (sql.includes('FROM form_patterns')) {
            if (opts.throwOnFormPatterns) throw new Error('no such table: form_patterns');
            return opts.minedRows ?? [];
          }
          return [];
        }),
      })),
    };
    return { symbolIndex: { getReadDb: () => db } } as any;
  };

  const req = (recommend: RecommendInput): CallToolRequest => ({
    method: 'tools/call',
    params: { name: 'get_form_patterns', arguments: { recommend } },
  });

  it('renders a recommendation with mined evidence', async () => {
    const ctx = makeContext({
      minedRows: [{ form_name: 'CustGroup', pattern_version: '1.1' }],
    });
    const result = await getFormPatternsTool(req({ entityKind: 'setup', fieldCount: 4 }), ctx);
    const text = result.content[0].text as string;
    expect(text).toContain('SimpleList');
    expect(text).toContain('Real forms using SimpleList');
    expect(text).toContain('cloneFrom=');
    expect(text).toContain('object_patterns(domain="form", action="spec"');
  });

  it('degrades gracefully without mined pattern data (older index)', async () => {
    const ctx = makeContext({ throwOnFormPatterns: true });
    const result = await getFormPatternsTool(req({ entityKind: 'master' }), ctx);
    const text = result.content[0].text as string;
    expect(result.isError).not.toBe(true);
    expect(text).toContain('DetailsMaster');
    expect(text).toContain('cloneFrom=');
  });

  it('pulls field count from the index when only tableName is given', async () => {
    const ctx = makeContext({ fieldCount: 23, minedRows: [] });
    const result = await getFormPatternsTool(
      req({ entityKind: 'setup', tableName: 'MyBigSetupTable' }),
      ctx,
    );
    const text = result.content[0].text as string;
    expect(text).toContain('SimpleListDetails'); // 23 fields ≥ 10
  });
});
