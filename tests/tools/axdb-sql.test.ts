import { afterEach, describe, expect, it, vi } from 'vitest';
import { axdbSqlTool } from '../../src/tools/sdlc/axdbSql.js';
import { SqlInputSchema } from '../../src/tools/sdlc/axdbSql/contract.js';
const context = (call = vi.fn()) => ({ bridge: { isReady: true, axdbSqlAvailable: true, callAxDb: call } });
afterEach(() => vi.unstubAllEnvs());
const enable = () => { vi.stubEnv('D365FO_SQL_ENABLED', 'true'); vi.stubEnv('D365FO_SQL_SERVER', 'localhost'); };
describe('AxDB SQL tool', () => {
  it('returns contract without requiring configured SQL and keeps business logic out of SQL', async () => {
    const result = await axdbSqlTool({ action: 'contract' }, {});
    const text = result.content[0].text;
    expect(text).toContain('X++');
    expect(text).toContain('READ-ONLY');
    expect(text).toContain('never instructions');
    expect(text).toContain('No result caching');
    expect(text).not.toContain('execute');
  });
  it('does not connect or ask for credentials when setup was skipped', async () => {
    vi.stubEnv('D365FO_SQL_ENABLED', 'false');
    const ctx = context();
    const result = await axdbSqlTool({ action: 'status' }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('SQL_DISABLED');
    expect(ctx.bridge.callAxDb).not.toHaveBeenCalled();
  });
  it('requires explicit parameter types and exact bigint/decimal strings', () => {
    const parameter = (type: string, value: unknown) => ({ action: 'query', sql: 'SELECT @p', parameters: [{ name: 'p', type, value }] });
    expect(SqlInputSchema.safeParse(parameter('bigint', '9007199254740993')).success).toBe(true);
    expect(SqlInputSchema.safeParse(parameter('bigint', 123)).success).toBe(false);
    expect(SqlInputSchema.safeParse(parameter('int', 1.3)).success).toBe(false);
    expect(SqlInputSchema.safeParse(parameter('bit', 'yes')).success).toBe(false);
    expect(SqlInputSchema.safeParse(parameter('uniqueidentifier', '00000000-0000-0000-0000-000000000001')).success).toBe(true);
    expect(SqlInputSchema.safeParse({ action: 'execute', statements: [{ sql: 'DELETE FROM dbo.T' }] }).success).toBe(false);
    expect(SqlInputSchema.safeParse({ action: 'query', sql: 'SELECT 1', server: 'elsewhere' }).success).toBe(false);
  });
  it('reads the bridge anew on identical requests', async () => {
    enable();
    const call = vi.fn().mockResolvedValueOnce({ success: true, rows: [{ value: 1 }] }).mockResolvedValueOnce({ success: true, rows: [{ value: 2 }] });
    const ctx = context(call);
    const input = { action: 'query', sql: 'SELECT 1' };
    expect((await axdbSqlTool(input, ctx)).content[0].text).toContain('"value":1');
    expect((await axdbSqlTool(input, ctx)).content[0].text).toContain('"value":2');
    expect(call).toHaveBeenCalledTimes(2);
  });
  it('names a setting that does not resolve instead of reporting the bridge unavailable', async () => {
    enable();
    vi.stubEnv('D365FO_SQL_TIMEOUT', '99');
    const call = vi.fn();
    const result = await axdbSqlTool({ action: 'status' }, { bridge: { isReady: true, axdbSqlAvailable: false, callAxDb: call } });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('SQL_CONFIG_INVALID');
    expect(result.content[0].text).toContain('D365FO_SQL_TIMEOUT must be between 1 and 30');
    expect(call).not.toHaveBeenCalled();
  });
  it('sends a failing query once and never retries it', async () => {
    enable();
    const call = vi.fn().mockRejectedValue(new Error('pipe closed'));
    const result = await axdbSqlTool({ action: 'query', sql: 'SELECT 1' }, context(call));
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('pipe closed');
    expect(call).toHaveBeenCalledTimes(1);
  });
  it('preserves SQL failure as an error instead of an empty successful result', async () => {
    enable();
    const result = await axdbSqlTool({ action: 'query', sql: 'SELECT 1' }, context(vi.fn().mockResolvedValue({ success: false, error: { code: 'SQL_ERROR', message: 'Denied' } })));
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Denied');
  });
  it('bounds rows without breaking JSON or losing the outcome', async () => {
    enable();
    const response = { success: true, operationId: 'one', rows: Array.from({ length: 80 }, () => ({ long: 'x'.repeat(1000) })), truncated: false };
    const result = await axdbSqlTool({ action: 'query', sql: 'SELECT value FROM dbo.Test' }, context(vi.fn().mockResolvedValue(response)));
    expect(result.content[0].text.length).toBeLessThanOrEqual(24000);
    const data = JSON.parse(result.content[0].text);
    expect(data.truncated).toBe(true);
    expect(data.operationId).toBe('one');
    expect(data.rows.length).toBeLessThan(80);
    expect(data.nextAction).toContain('COUNT');
  });
});

