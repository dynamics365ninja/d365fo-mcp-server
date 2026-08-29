/**
 * object_patterns(domain="report") handler.
 *
 * list (no pattern) → one-line overview of every recipe;
 * pattern=<id|alias> → full spec (roster, scaffold call, method notes, checks).
 * Pure catalog — no index/DB access, mirrors the shape of getFormPatterns.
 */

import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import {
  listReportPatterns,
  renderReportPatternList,
  renderReportPatternSpec,
  resolveReportPattern,
} from '../../knowledge/reportPatterns/index.js';

export async function getReportPatternsTool(request: CallToolRequest) {
  const a = (request.params.arguments ?? {}) as Record<string, any>;
  const requested = a.pattern ?? a.reportPattern;

  if (requested === undefined || requested === null || requested === '') {
    return { content: [{ type: 'text' as const, text: renderReportPatternList() }] };
  }

  const spec = resolveReportPattern(String(requested));
  if (!spec) {
    const ids = listReportPatterns().map(p => p.id).join(', ');
    return {
      content: [{
        type: 'text' as const,
        text:
          `❌ Unknown report pattern "${requested}". Available: ${ids}.\n` +
          `Call object_patterns(domain="report") without a pattern for the overview.`,
      }],
      isError: true,
    };
  }

  return { content: [{ type: 'text' as const, text: renderReportPatternSpec(spec) }] };
}
