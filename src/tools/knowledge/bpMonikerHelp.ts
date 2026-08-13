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
  'AxClass', 'AxTable', 'AxForm', 'AxView', 'AxMap', 'AxEnum', 'AxQuerySimple',
  'AxDataEntityView', 'AxAggregateMeasurement', 'AxAggregateDimension',
  'AxSecurityPrivilege', 'AxSecurityDuty', 'AxSecurityRole',
  'AxTableExtension', 'AxFormExtension', 'AxMenuExtension',
  'AxMenu', 'AxMenuItemDisplay', 'AxMenuItemAction', 'AxMenuItemOutput',
  'AxEdtString', 'AxEdtInt', 'AxEdtInt64', 'AxEdtEnum', 'AxEdtReal', 'AxEdtDate', 'AxEdtGuid',
  'AxConfigurationKey', 'AxLicenseCode',
] as const satisfies readonly SuppressionElementType[];

const BpMonikerArgsSchema = z.object({
  action: z.enum(['validate', 'search', 'suppress']).describe(
    'validate = confirm an exact moniker is real; search = free-text query for a scenario with no moniker yet; ' +
    'suppress = render a <Diagnostic> block for {Model}_BPSuppressions.xml.',
  ),
  moniker: z.string().optional().describe('[validate, suppress] The exact moniker, e.g. "BPErrorPrivilegeNotCoveredByDuty".'),
  query: z.string().optional().describe('[search] Free-text description of the scenario, e.g. "privilege not linked to any duty".'),
  limit: z.number().int().positive().max(50).optional().default(10).describe('[search] Max results (default 10).'),
  path: z.string().optional().describe('[suppress] The dynamics:// path copied verbatim from the finding — preferred, and the only way to target a control/field/method/enum value.'),
  elementType: z.enum(ELEMENT_TYPES).optional().describe('[suppress] Top-level AOT element type; used with elementName to derive the path when `path` is not given.'),
  elementName: z.string().optional().describe('[suppress] Name of the object the warning was raised against, e.g. the privilege or table name.'),
  justification: z.string().optional().describe('[suppress] Why the warning is being ignored. 95% of real entries carry one — omitting it emits a TODO and a warning.'),
  message: z.string().optional().describe('[suppress] The real message text from a run_bp_check finding, if you have it.'),
  severity: z.enum(['Error', 'Warning']).optional().describe('[suppress] Defaults to "Warning".'),
  itemSpecific: z.boolean().optional().describe('[suppress] Add the <ItemSpecific> block (only 9% of real entries carry it). Requires elementName.'),
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
      const suggestionText = result.suggestions.length
        ? `\n\nCatalog names sharing words with it — candidates to check, not corrections: ${result.suggestions.join(', ')}`
        : '';
      return {
        content: [{
          type: 'text',
          text: `❌ '${args.moniker}' is not in the extracted catalog (${BP_MONIKER_CATALOG.length} known monikers).${suggestionText}\n\n` +
            `This does not prove it is fake — the extraction is not exhaustive — but it is not confirmed. ` +
            `If you have a real run_bp_check finding using it, that is stronger evidence than this lookup.`,
        }],
      };
    }
    const e = result.entry!;
    // Only the AxRuleSet union proves "this is a BP rule". The rule-DLL
    // resource text also contains strings that are not BP rules at all
    // (upgrade-tool and form-conversion messages), so a resource-only hit gets
    // a qualified answer, not a ✅.
    const lines = e.canonical
      ? [`✅ '${e.moniker}' is a real BP moniker — it appears in a model's AxRuleSet/BPRules.xml.`]
      : [
          `⚠️ '${e.moniker}' is a known string from the rule DLLs, but it is NOT in any model's AxRuleSet/BPRules.xml.`,
          `That source also carries non-BP messages (upgrade and form-conversion tooling), so this is not confirmed as a BP rule.`,
          `Treat it as unverified unless a real BP finding uses it.`,
        ];
    lines.push(
      e.message ? `Message template: ${e.message}` : 'Message template: (not found in a resource class)',
      e.description ? `Description: ${e.description}` : 'Description: (not found in a resource class)',
    );
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
          text: `No catalog matches for "${args.query}". 545 of the ${BP_MONIKER_CATALOG.length} entries carry real rule text, ` +
            `so a miss is meaningful: most likely no BP rule covers this, or the wording shares no words with the rule's own. ` +
            `Try the rule's vocabulary (e.g. "duty", "privilege", "label", "extensible") before concluding there is none.`,
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
  if (!args.moniker) {
    return { content: [{ type: 'text', text: '❌ suppress requires `moniker`.' }], isError: true };
  }
  if (!args.path && !(args.elementType && args.elementName)) {
    return {
      content: [{
        type: 'text',
        text: '❌ suppress requires either `path` (copied verbatim from the finding — preferred) ' +
          'or both `elementType` and `elementName`.',
      }],
      isError: true,
    };
  }
  const built = buildSuppressionXml({
    moniker: args.moniker,
    path: args.path,
    elementType: args.elementType,
    elementName: args.elementName,
    justification: args.justification,
    message: args.message,
    severity: args.severity,
    itemSpecific: args.itemSpecific,
  });
  if (built.errors.length) {
    return {
      content: [{ type: 'text', text: `❌ ${built.errors.join('\n❌ ')}` }],
      isError: true,
    };
  }
  const warningText = built.warnings.length ? `${built.warnings.map(w => `⚠️ ${w}`).join('\n\n')}\n\n` : '';
  return {
    content: [{
      type: 'text',
      text: `${warningText}Add this inside <Items> of ` +
        `{Model}/{Model}/AxIgnoreDiagnosticList/{Model}_BPSuppressions.xml:\n\n${built.xml}`,
    }],
  };
}
