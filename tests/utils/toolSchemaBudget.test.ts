/**
 * Tool-schema token budget — a regression ratchet on the cost of the ListTools
 * payload, which is sent to the model on (at least) every new session and is
 * the server's largest fixed token cost.
 *
 * Rationale: the 25 tool schemas are verbose on purpose (the descriptions encode
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

// Ceilings in characters of serialized JSON. Current actual = 63,255 · largest
// tool d365fo_file = 9,888 (ahead of generate_object = 8,602). Raised
// deliberately whenever a genuinely new AOT capability lands — `service` +
// `service-group` objectTypes, then d365fo_file's add-/remove-delete-action
// (findings #36), generate_object scaffold `fields[]`/`preview` (#21), and the
// five coverage-closure objectTypes (macro, configuration-key, security-policy,
// aggregate-measurement, license-code) that took the T flag green on the last
// create-path holes in the taxonomy, then the data-entity writer properties
// (primaryKey, isPublic, entityCategory, dynamicFields,
// allowRowVersionChangeTracking) that were implemented but unadvertised — paid
// for in part by dropping the member-variable rule from `sourceCode`, where it
// was the third statement of the same thing.
//
// data-entity-extension add-field deliberately does NOT raise these. `params` is
// additionalProperties:true, so dataField/dataSource/fieldGroupName cost nothing
// on the wire — only the prose naming them does, and that was paid for by
// tightening the `params` description rather than by moving the ceiling.
//
// Raised for labels(action="search") maxResults/verbose (#832): a broad phrase
// query returned 30 four-line blocks (~2,5 kB per call), so ~230 wire chars buy
// a bounded, one-line-per-label default — the schema pays once per session, the
// result paid on every call and on every later re-read.
//
// get_object_info absorbing batch_get_info as `objects[]` (#831) lowers it: the
// plural form cost 1,002 chars but the retired tool gave back 1,047, and naming
// the entry `objectName` (the key verify_d365fo_project and run_bp_check already
// use) added 42 more.
//
// Headroom is small on purpose so creep is caught early: both ceilings are the
// next round hundred above the measured payload.
const TOTAL_BUDGET = 63_200;
const LARGEST_TOOL_BUDGET = 9_900;

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
    expect(tools.length).toBe(25);
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
