/**
 * BP Moniker Tool — validate, search, and generate suppressions for
 * Best-Practice-check diagnostic monikers.
 *
 * Backed by the extracted catalog (src/knowledge/bpMonikers/), not memory —
 * see that module's docblock for why. Three actions:
 *   • validate → is this exact moniker real? (case-insensitive exact match)
 *   • search   → free-text query against real rule message/description text,
 *                for when you have a scenario but no moniker yet ("pull one
 *                out of a hat" case — e.g. mid-development, before a BP check
 *                has actually been run)
 *   • suppress → render one <Diagnostic> block for {Model}_BPSuppressions.xml
 *
 * This handler has no schema of its own — it is reached through the unified
 * get_knowledge tool. Tool registration (name/description/inputSchema) lives
 * in src/server/toolSchemas/getKnowledge.ts.
 */

import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import {
  validateMoniker,
  searchMonikers,
  buildSuppressionXml,
  BP_MONIKER_CATALOG,
  type SuppressionElementType,
} from '../../knowledge/bpMonikers/index.js';

const ELEMENT_TYPES = [
  'AxClass', 'AxTable', 'AxForm', 'AxEnum', 'AxEdt', 'AxQuery', 'AxView',
  'AxSecurityPrivilege', 'AxSecurityDuty', 'AxSecurityRole',
  'AxTableExtension', 'AxFormExtension', 'AxEnumExtension', 'AxEdtExtension',
  'AxDataEntityView', 'AxReport', 'AxMenuItemDisplay', 'AxMenuItemAction', 'AxMenuItemOutput',
] as const satisfies readonly SuppressionElementType[];

const BpMonikerArgsSchema = z.object({
  action: z.enum(['validate', 'search', 'suppress']).describe(
    'validate = confirm an exact moniker is real; search = free-text query for a scenario with no moniker yet; ' +
    'suppress = render a <Diagnostic> block for {Model}_BPSuppressions.xml.',
  ),
  moniker: z.string().optional().describe('[validate, suppress] The exact moniker, e.g. "BPErrorPrivilegeNotCoveredByDuty".'),
  query: z.string().optional().describe('[search] Free-text description of the scenario, e.g. "privilege not linked to any duty".'),
  limit: z.number().int().positive().max(50).optional().default(10).describe('[search] Max results (default 10).'),
  elementType: z.enum(ELEMENT_TYPES).optional().describe('[suppress] AOT element type the warning was raised against.'),
  elementName: z.string().optional().describe('[suppress] Name of the object the warning was raised against, e.g. the privilege or table name.'),
  message: z.string().optional().describe('[suppress] The real message text from a run_bp_check finding, if you have it — preferred over the catalog template.'),
  severity: z.enum(['Error', 'Warning']).optional().describe('[suppress] Defaults to "Warning".'),
});

export async function bpMonikerHelpTool(request: CallToolRequest) {
  const parsed = BpMonikerArgsSchema.safeParse(request.params.arguments ?? {});
  if (!parsed.success) {
    return {
      content: [{ type: 'text', text: `❌ bp-moniker: invalid arguments — ${parsed.error.message}` }],
      isError: true,
    };
  }
  const args = parsed.data;

  if (args.action === 'validate') {
    if (!args.moniker) {
      return { content: [{ type: 'text', text: '❌ validate requires `moniker`.' }], isError: true };
    }
    const result = validateMoniker(args.moniker);
    if (!result.found) {
      const nearMissText = result.nearMisses.length
        ? `\n\nFound with different casing only: ${result.nearMisses.join(', ')}`
        : '';
      return {
        content: [{
          type: 'text',
          text: `❌ '${args.moniker}' is not in the extracted catalog (${BP_MONIKER_CATALOG.length} known monikers).${nearMissText}\n\n` +
            `This does not prove it is fake — the extraction is not exhaustive — but it is not confirmed. ` +
            `If you have a real run_bp_check finding using it, that is stronger evidence than this lookup.`,
        }],
      };
    }
    const e = result.entry!;
    const lines = [
      `✅ '${e.moniker}' is a real BP moniker.`,
      `Canonical (found in a model's AxRuleSet/BPRules.xml): ${e.canonical ? 'yes' : 'no — found only in rule-DLL resource text'}`,
      e.message ? `Message template: ${e.message}` : 'Message template: (not found in a resource class)',
      e.description ? `Description: ${e.description}` : 'Description: (not found in a resource class)',
    ];
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  }

  if (args.action === 'search') {
    if (!args.query) {
      return { content: [{ type: 'text', text: '❌ search requires `query`.' }], isError: true };
    }
    const results = searchMonikers(args.query, args.limit);
    if (results.length === 0) {
      return {
        content: [{
          type: 'text',
          text: `No catalog matches for "${args.query}". Coverage is uneven — most X++-authored rules have no ` +
            `message/description text in the catalog, only a name — so a miss here does not mean no rule fits.`,
        }],
      };
    }
    const lines = [`Candidates for "${args.query}" — verify against a real finding before suppressing:`, ''];
    for (const r of results) {
      lines.push(
        `• ${r.entry.moniker}${r.entry.canonical ? '' : ' (not in any AxRuleSet — less certain)'}  [matched: ${r.matchedIn.join(', ')}]`,
      );
      if (r.entry.description) lines.push(`    ${r.entry.description}`);
      else if (r.entry.message) lines.push(`    ${r.entry.message}`);
    }
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  }

  // suppress
  if (!args.moniker || !args.elementType || !args.elementName) {
    return {
      content: [{ type: 'text', text: '❌ suppress requires `moniker`, `elementType`, and `elementName`.' }],
      isError: true,
    };
  }
  const built = buildSuppressionXml({
    moniker: args.moniker,
    elementType: args.elementType,
    elementName: args.elementName,
    message: args.message,
    severity: args.severity,
  });
  const warningText = built.warning ? `⚠️ ${built.warning}\n\n` : '';
  return {
    content: [{
      type: 'text',
      text: `${warningText}Add this to src/Metadata/{Model}/{Model}/AxIgnoreDiagnosticList/{Model}_BPSuppressions.xml:\n\n${built.xml}`,
    }],
  };
}
