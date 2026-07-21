/**
 * Tool-schema token budget — a regression ratchet on the cost of the ListTools
 * payload, which is sent to the model on (at least) every new session and is
 * the server's largest fixed token cost.
 *
 * Rationale: the 26 tool schemas are verbose on purpose (the descriptions encode
 * hard-won D365FO patterns that prevent failed/retried calls), so the goal is
 * NOT to minimise blindly — it is to make the size *visible and bounded* so it
 * cannot creep upward unnoticed. Lower these ceilings whenever the schema is
 * trimmed; raise them only deliberately (e.g. a new tool), the same way
 * toolInventory.test.ts guards the tool *count*.
 *
 * Measured against the REAL serialized payload (not the source), because that
 * is what the client bills. We pull the registered `tools/list` handler off the
 * constructed server rather than standing up a transport — the handler ignores
 * its request/extra args, so a direct call returns the exact wire payload.
 */

import { describe, it, expect } from 'vitest';
import { createXppMcpServer } from '../../src/server/mcpServer';

// ~4 chars/token is the usual rough conversion for English+JSON; only used for
// the human-readable log line, never for assertions.
const CHARS_PER_TOKEN = 4;

// Ceilings in characters of serialized JSON. Current actuals (2026-07, after
// adding d365fo_file's `service` + `service-group` objectTypes — two genuinely
// new AOT capabilities, so the ceilings were raised deliberately (same as the
// earlier generate_object `additionalDatasets` bump): total ≈ 62,555 ·
// d365fo_file ≈ 9,493 (now the largest, ahead of generate_object ≈ 8,469).
// Headroom is small on purpose so creep is caught early.
const TOTAL_BUDGET = 62_900;
const LARGEST_TOOL_BUDGET = 9_800;

async function getTools(): Promise<Array<{ name: string }>> {
  const ctx: any = { symbolIndex: {}, parser: {} };
  const server: any = createXppMcpServer(ctx);
  const handler = server._requestHandlers?.get('tools/list');
  if (!handler) throw new Error('tools/list handler not registered on the server');
  const res = await handler({ method: 'tools/list' }, {});
  return res.tools;
}

describe('tool schema token budget', () => {
  it('total ListTools payload stays within the token budget', async () => {
    const tools = await getTools();
    const chars = JSON.stringify(tools).length;
    // eslint-disable-next-line no-console
    console.error(
      `[tool-budget] ${tools.length} tools · ${chars} chars ≈ ${Math.round(chars / CHARS_PER_TOKEN)} tokens ` +
      `(budget ${TOTAL_BUDGET} chars)`,
    );
    expect(tools.length).toBe(26);
    expect(chars).toBeLessThan(TOTAL_BUDGET);
  });

  it('no single tool dominates the payload beyond its cap', async () => {
    const tools = await getTools();
    const sizes = tools
      .map(t => ({ name: t.name, chars: JSON.stringify(t).length }))
      .sort((a, b) => b.chars - a.chars);
    // eslint-disable-next-line no-console
    console.error('[tool-budget] top 5: ' + sizes.slice(0, 5).map(s => `${s.name}=${s.chars}`).join(', '));

    const largest = sizes[0];
    expect(
      largest.chars,
      `largest tool schema '${largest.name}' (${largest.chars} chars) exceeds the per-tool cap`,
    ).toBeLessThan(LARGEST_TOOL_BUDGET);
  });
});
