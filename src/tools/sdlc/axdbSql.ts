import { resolveAxDbConfig } from '../../config/axdbSql.js';
import type { AxDbMethod } from '../../bridge/bridgeTypes.js';
import { SqlInputSchema, sqlContract } from './axdbSql/contract.js';
import { boundedSqlResult } from './axdbSql/output.js';

export interface AxDbContext {
  bridge?: { isReady?: boolean; axdbSqlAvailable?: boolean; callAxDb: (method: AxDbMethod, args: Record<string, unknown>) => Promise<unknown> };
}
const reply = (data: unknown, isError = false) => ({
  ...(isError ? { isError: true } : {}), content: [{ type: 'text' as const, text: JSON.stringify(data) }],
});

export async function axdbSqlTool(args: unknown, context: AxDbContext) {
  try {
    const input = SqlInputSchema.parse(args);
    if (input.action === 'contract') return reply(sqlContract());
    // A setting that does not resolve (a timeout out of range, a connection string where a
    // server name belongs) is named here. The bridge was started without SQL for the same
    // reason, so falling through would only report "bridge unavailable".
    let config: ReturnType<typeof resolveAxDbConfig>;
    try {
      config = resolveAxDbConfig();
    } catch (error) {
      return reply({ code: 'SQL_CONFIG_INVALID', message: `${error instanceof Error ? error.message : String(error)}. Fix it with d365fo-mcp config sql, then restart MCP.` }, true);
    }
    if (!config) return reply({ code: 'SQL_DISABLED', message: 'SQL was not configured or was disabled. Do not use SQL. Run d365fo-mcp config sql to configure it, then restart MCP.' }, true);
    if (!context.bridge?.isReady || !context.bridge.axdbSqlAvailable)
      return reply({ code: 'SQL_BRIDGE_UNAVAILABLE', message: 'An updated Windows bridge with AxDB SQL enabled is required. On the D365FO developer VM run npm run bridge:build to verify, then stop MCP and run dotnet build bridge/D365MetadataBridge -c Release to update the deployed binary. Restart MCP.' }, true);
    const methods = { status: 'axdbStatus', schema: 'axdbSchema', query: 'axdbQuery' } as const;
    const { action, ...parameters } = input;
    const result = await context.bridge.callAxDb(methods[action], parameters);
    if (!result || typeof result !== 'object' || !('success' in result) || typeof result.success !== 'boolean')
      throw new Error('Invalid SQL bridge response; operation outcome cannot be established.');
    return reply(boundedSqlResult(result as Record<string, unknown>), !result.success);
  } catch (error) {
    return reply({ code: 'SQL_ERROR', message: String(error instanceof Error ? error.message : error).slice(0, 1500) }, true);
  }
}
