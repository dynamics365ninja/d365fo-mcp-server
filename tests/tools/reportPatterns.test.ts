/**
 * object_patterns(domain="report") — dispatcher routing + handler output.
 * The report domain is pure catalog (no index), so a bare context suffices.
 */
import { describe, it, expect } from 'vitest';
import { objectPatternsTool } from '../../src/tools/knowledge/objectPatterns';
import { getReportPatternsTool } from '../../src/tools/knowledge/getReportPatterns';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';

const req = (args: Record<string, unknown> = {}): CallToolRequest => ({
  method: 'tools/call',
  params: { name: 'object_patterns', arguments: args },
});

const getText = (r: any): string => r.content?.[0]?.text ?? '';
const ctx = {} as any;

describe('object_patterns domain="report"', () => {
  it('lists all report patterns without a pattern arg', async () => {
    const r = await objectPatternsTool(req({ domain: 'report' }), ctx);
    const text = getText(r);
    expect(r.isError).toBeFalsy();
    expect(text).toContain('SimpleList');
    expect(text).toContain('PrintMgmtFormLetter');
    expect(text).toContain('generate_object(mode="scaffold"');
  });

  it('returns one spec for pattern=<id> with roster and scaffold', async () => {
    const r = await objectPatternsTool(req({ domain: 'report', pattern: 'HeaderDetail' }), ctx);
    const text = getText(r);
    expect(text).toContain('Header + lines');
    expect(text).toContain('Objects:');
    expect(text).toContain('additionalDatasets');
  });

  it('routes a report-only pattern name without an explicit domain', async () => {
    const r = await objectPatternsTool(req({ pattern: 'PrintMgmtFormLetter' }), ctx);
    expect(getText(r)).toContain('Print-management document');
  });

  it('a report pattern id passed AS the domain routes to its spec', async () => {
    const r = await objectPatternsTool(req({ domain: 'GroupedWithTotals' }), ctx);
    expect(getText(r)).toContain('Grouped list with totals');
  });

  it('unknown pattern lists the available ids', async () => {
    const r = await getReportPatternsTool(req({ pattern: 'nope' }));
    expect(r.isError).toBe(true);
    expect(getText(r)).toContain('SimpleList');
  });

  it('the no-domain error text now offers the report domain', async () => {
    const r = await objectPatternsTool(req({ domain: 'bogus-domain' }), ctx);
    expect(getText(r)).toContain('domain="report"');
  });
});
