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

// Ceilings in characters of serialized JSON. Current actual ≈ 53,197 · largest
// tool labels ≈ 5,9xx (ahead of d365fo_file ≈ 4,7xx).
//
// Ratcheted down from 63,300 / 9,900 by issue #825: `d365fo_file` (9,888 →
// 4,781) and `generate_object` (8,602 → 3,135) stopped inlining a discriminated
// union of every operation and its parameters. Both now publish the
// DISCRIMINATORS only — action/objectType/operation/mode/pattern as closed
// enums — and the parameter contract behind the one the agent picks is fetched
// once from get_knowledge(kind="op-spec"), backed by d365foFileOpSpecs.ts and
// generateObjectOpSpecs.ts. get_knowledge paid ~490 chars for that lookup.
//
// What is left in those two schemas is close to the floor: the two closed enums
// in d365fo_file alone are ~1,185 chars, and the remaining prose is the
// behavioural warnings (immediate apply, isError=false, never hand-build the
// prefix) that stop failed calls — which cost far more than the bytes do.
// Headroom is small on purpose so creep is caught early.
//
// labels(action="search") maxResults/verbose (#832) added ~230 wire chars: a
// broad phrase query returned 30 four-line blocks (~2,5 kB per call), so the
// schema pays once per session to bound a result paid on every call.
//
// Both ceilings then drop hard (#825): d365fo_file and generate_object now
// publish discriminators plus a loose `params`, with the per-branch contract
// moved to get_knowledge(kind="op-spec"). `labels` is the largest tool now,
// not d365fo_file.
const TOTAL_BUDGET = 53_600;
const LARGEST_TOOL_BUDGET = 6_300;

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

  it('keeps the two discriminated-union tools off the inline-parameter path', async () => {
    // Issue #825: d365fo_file and generate_object were a quarter of the payload
    // because each inlined every operation's parameters. The guard is a size cap
    // per tool PLUS the reason the size holds — both point at the op-spec lookup,
    // so an agent that no longer sees the params still knows where they live.
    const tools = await getTools();
    const byName = new Map(tools.map(t => [t.name, t]));

    for (const [name, cap] of [['d365fo_file', 5_000], ['generate_object', 3_400]] as const) {
      const tool: any = byName.get(name);
      expect(tool, `${name} is not published`).toBeDefined();
      const chars = JSON.stringify(tool).length;
      expect(chars, `${name} (${chars} chars) grew past its post-#825 cap`).toBeLessThan(cap);
      expect(tool.description, `${name} must name the op-spec lookup`).toContain('kind="op-spec"');
      expect(tool.inputSchema.properties.params, `${name} must expose a loose params object`).toMatchObject({
        type: 'object',
        additionalProperties: true,
      });
    }
  });
});
