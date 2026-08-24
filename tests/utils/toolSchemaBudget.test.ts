/**
 * Tool-schema token budget — a regression ratchet on the cost of the ListTools
 * payload, which is sent to the model on (at least) every new session and is
 * the server's largest fixed token cost.
 *
 * Rationale: the 23 tool schemas are verbose on purpose (the descriptions encode
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

// Ceilings in characters of serialized JSON.
//
// Ratcheted down hard by issue #825: `d365fo_file` (9,888 -> 4,781) and
// `generate_object` (8,602 -> 3,135) stopped inlining a discriminated union of
// every operation and its parameters. Both now publish the DISCRIMINATORS only
// — action/objectType/operation/mode/pattern as closed enums — and the
// parameter contract behind the one the agent picks is fetched once from
// get_knowledge(kind="op-spec"), backed by d365foFileOpSpecs.ts and
// generateObjectOpSpecs.ts. get_knowledge paid ~490 chars for that lookup.
//
// What is left in those two schemas is close to the floor: the two closed enums
// in d365fo_file alone are ~1,185 chars, and the remaining prose is the
// behavioural warnings (immediate apply, isError=false, never hand-build the
// prefix) that stop failed calls — which cost far more than the bytes do.
//
// Ratcheted again by the round-trip work, which needed headroom it did not have:
// 53,450 of 53,500 chars were used, and `labels` sat 3 chars under its per-tool
// cap, so no change could be paid for. Three trims, ~3,850 chars:
//   • get_method and suggest_edt unpublished. Both were folded into a tool that
//     already had the object in hand — get_object_info(options.method) and
//     prepare(fieldsHint) — and get_method's mandated chain (search →
//     get_object_info → get_method) spent a round trip to read one signature.
//     Their handlers stay routable, so an agent holding the old name still gets
//     an answer instead of an unrecoverable "unknown tool".
//   • `labels` write plumbing — 13 knobs (packagePath, languages, sortLabels, …)
//     that are auto-resolved on the normal path — moved behind
//     get_knowledge(kind="op-spec", topic="labels"), the same trade #825 made
//     for d365fo_file. labels: 6,197 -> 4,465.
//   Net after re-spending some of it on the folded get_method contract: 53,450 -> 49,776.
//   • the 23-value object-type enum was inlined THREE times in `search`; the two
//     nested copies now point at the top-level one.
//
// Raised DELIBERATELY, by 451 chars, to spend part of that headroom on
// d365fo_file's operations[] (4,781 -> 5,232): several edits to one object in a
// single call. This is the trade the trim was for — the description costs ~450
// chars once per session, and it removes six or more round trips from every
// ordinary table change, each of which re-bills the entire cached context.
//
// Raised again by ~200 chars for prepare's `operation`, which makes prepare
// return the write contract itself. Deferring those contracts out of the schema
// (#825) had traded bytes for a discovery hop — get_knowledge(kind="op-spec")
// on nearly every write flow — and this buys the hop back for a fraction of
// what inlining them cost.
//
// Headroom is small on purpose so creep is caught early: both ceilings are the
// next round hundred above the measured payload.
//
// Phase 1.7 (reader payloads) added ~50 chars to get_object_info's `options`
// description to name the new pagination knobs — table fieldsOffset/fieldFilter
// and form maxControls. That is not optional text: a knob the model cannot see
// does not shrink anything, so those chars buy back thousands per call. Against
// main alone it needed the ceiling at 53_700; combined with the Phase 1.5 trim
// it fits far below, so the ceiling is set from the real measured payload.
//
// Raised by ~1,000 chars for get_knowledge's new kind="bp-moniker": validate an
// exact BP-check moniker, search by scenario when there is no moniker yet, or
// render a _BPSuppressions.xml <Diagnostic> block — all backed by names/text
// extracted from a real D365FO install (src/knowledge/bpMonikers/), not typed
// from memory. A moniker guessed wrong and only caught by reading the xppc log
// by hand is the failure this buys back. Only the four fields a caller cannot
// work without are published (action, moniker, path, justification); the rest —
// limit, message, severity, itemSpecific, and the elementType/elementName
// fallback for deriving a path — stay in the zod handler schema, the same trade
// already made for `labels`.
//
// Raised DELIBERATELY by ~350 chars for the three removal capabilities d365fo_file
// was missing: the `delete` action (an object's XML plus its .rnrproj entry) and
// the remove-control / remove-entry-point operations. All three are enum values
// plus one line of prose for the action — the parameters stay behind
// get_knowledge(kind="op-spec"), as #825 requires. An operation the model cannot
// see is an operation it works around by rewriting the whole object with
// action="create", overwrite=true, which costs orders of magnitude more than the
// enum value does and loses metadata as well.
//
// Raised by ~50 chars for add-query-range / remove-query-range — two XML-only
// operations for inserting/removing ViewMetadata filter ranges on data entities.
// Lowered to bank the removal of build_d365fo_project.buildReferencedModels, a
// parameter whose handler hard-codes `false` and ignores it (buildProject.ts).
// The ratchet only works in this direction: fit the change to the budget, never
// the budget to the change.
const TOTAL_BUDGET = 52_000;
const LARGEST_TOOL_BUDGET = 5_700;

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
    expect(tools.length).toBe(23);
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

    for (const [name, cap] of [['d365fo_file', 5_700], ['generate_object', 3_400]] as const) {
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
