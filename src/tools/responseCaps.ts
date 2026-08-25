/**
 * Per-tool response caps and the advice printed after a cut.
 *
 * Lives beside the dispatcher rather than inside it: `tests/utils/layering.test.ts`
 * pins `toolHandler.ts` under 500 lines on the rule that the dispatcher ROUTES
 * rather than implements, and deciding how much of a response survives — and
 * what to tell the caller about it — is a policy of its own, with its own
 * measurements to record.
 */

import { truncateOnBlockBoundary } from '../utils/payloadBudget.js';

/**
 * Per-tool response cap sizes. 'uncapped' = no truncation.
 *
 * The caps are a context-budget guard, not a quality target: a response cut
 * short of the thing the call existed to deliver costs an extra round trip,
 * and a round trip re-bills the whole cached context (~1.5 AIU floor here).
 * Cutting is therefore only cheaper than not cutting when what is lost is
 * genuinely optional.
 *
 * Measured over 1,400 real MCP calls from Copilot sessions on this VM:
 *   • prepare      — result size p50 4,966 / p90 5,011 chars against the 5,000
 *     default, i.e. essentially EVERY prepare was being cut, always in its last
 *     sections. Raised to 12,000; prepareChange/prepareCreate also moved the
 *     write contract and the grounding token ahead of the discovery sections so
 *     a cut can only ever cost discovery, never the deliverable.
 *   • get_knowledge — called 186 times against only 81 prepares, and its batch
 *     form (topics[]) 0 times, because a knowledge topic measures 8–12 KB and
 *     was halved by the same 5,000 default. Bounded at 16,000 (a number, not
 *     'uncapped', so a runaway topics[] batch cannot flood the context); the
 *     renderer in tools/knowledge/getKnowledge.ts spends its own smaller budget
 *     in whole topics first, so this cap is a backstop rather than the cutter.
 */
const TOOL_CAP_SIZES: Record<string, number | 'uncapped'> = {
  // Uncapped — XML generation, file writes, or long structured output
  generate_object:                  'uncapped',
  d365fo_file:                      'uncapped',
  get_object_info:                  'uncapped', // can return reports (RDL) and full class bodies
  get_method:                       'uncapped', // partial method source is useless
  build_d365fo_project:             'uncapped', // compiler errors can appear late in long logs
  security_info:                    8000,
  extension_info:                   6000,
  prepare:                          12000,
  get_knowledge:                    16000,
  // Default output is ~1 KB. The higher cap exists for diagnostics=true, whose
  // whole point is the full dump — truncating that at 5000 hid the stdio
  // handshake section behind the project table.
  get_workspace_info:               20000,
  default:                          5000,
};

function getCapForTool(toolName: string): number | 'uncapped' {
  return TOOL_CAP_SIZES[toolName] ?? TOOL_CAP_SIZES['default'];
}

/**
 * What to say after a cut, per tool.
 *
 * The reader advice below used to be printed for EVERY tool. Verified live: a
 * truncated `prepare` told the agent to page with `fieldsOffset` — a parameter
 * prepare does not have — so the agent's next move was a call that could not
 * help it. Advice naming knobs the tool does not accept is worse than no
 * advice, because it is followed.
 */
const TRUNCATION_ADVICE: Record<string, string> = {
  default:
    'Ask for LESS, not more: page with methodOffset/fieldsOffset, narrow with fieldFilter/searchControl/prefix, ' +
    'keep compact=true, and read one object per call instead of objects[].',
  // prepare has no paging knobs at all — it is narrowed by being more specific.
  prepare:
    'prepare has no paging parameters. Narrow it instead: pass `operation` (comma-separated for several) ' +
    'to get only the write contracts you need, and `objectType`/`methodName` so the discovery sections stay small. ' +
    'The write contract and the grounding token are at the TOP of this response — they were not cut.',
  get_knowledge:
    'Ask for fewer topics per call (`topics[]`, max 10) or one `topic` at a time, and keep format="concise" (the default).',
  security_info:
    'Narrow it: one artifact per call (mode="artifact", name, artifactType), ' +
    'includeChain=false to skip the hierarchy walk, or mode="coverage" with a single objectName.',
  extension_info:
    'Narrow it: pass `method` to filter to one method/event, `objectType` to skip auto-detection, ' +
    'and one `target` per call.',
};

export function capToolResponse(toolName: string, result: any): any {
  const cap = getCapForTool(toolName);
  if (cap === 'uncapped' || !result?.content) return result;
  const advice = TRUNCATION_ADVICE[toolName] ?? TRUNCATION_ADVICE['default'];
  const content = result.content.map((item: any) => {
    if (item.type !== 'text' || typeof item.text !== 'string') return item;
    if (item.text.length <= (cap as number)) return item;
    // Cut on a block boundary: a raw slice ended responses mid-XML-element
    // (`<AxTableField Nam`), which reads as corrupt metadata, not truncated.
    const kept = truncateOnBlockBoundary(item.text, cap as number);
    return {
      ...item,
      // The advice used to say `compact=false`, which makes the response BIGGER
      // — the caller followed it and hit the cap again with more content cut.
      text: kept +
        `\n\n> ✂️ Response truncated at ${cap} chars (${item.text.length - kept.length} omitted). ` +
        advice,
    };
  });
  return { ...result, content };
}

