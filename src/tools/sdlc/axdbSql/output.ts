/** Preserve valid JSON and error evidence while bounding model-facing SQL data. */
export function boundedSqlResult(result: Record<string, unknown>): Record<string, unknown> {
  const cap = 24000;
  if (JSON.stringify(result).length <= cap) return result;
  const copy: Record<string, unknown> = { ...result, truncated: true, nextAction: 'Result is incomplete. Select fewer columns/rows or use COUNT/EXISTS; do not treat this as complete test evidence.' };
  if (Array.isArray(copy.rows)) {
    const rows = [...copy.rows];
    copy.rows = rows;
    while (rows.length && JSON.stringify(copy).length > cap) rows.pop();
  }
  if (JSON.stringify(copy).length <= cap) return copy;
  // Extremely wide schema/column metadata: retain outcome, never a sliced JSON document.
  return {
    success: result.success, operationId: result.operationId, server: result.server, database: result.database,
    durationMs: result.durationMs, error: result.error,
    truncated: true, dataOmitted: true, nextAction: copy.nextAction,
  };
}
