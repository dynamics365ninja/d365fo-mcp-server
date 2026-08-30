/**
 * object_patterns(domain="mobile-app") handler.
 *
 * list (no pattern) → the two-framework decision plus a one-line overview of
 * every recipe; pattern=<id|alias> → the full spec with copy-ready X++.
 * Pure catalog — no index/DB access, mirrors getReportPatterns.
 */

import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import {
  listMobileAppPatterns,
  renderMobileAppPatternList,
  renderMobileAppPatternSpec,
  resolveMobileAppPattern,
} from '../../knowledge/mobileAppPatterns/index.js';

export async function getMobileAppPatternsTool(request: CallToolRequest) {
  const a = (request.params.arguments ?? {}) as Record<string, any>;
  const requested = a.pattern ?? a.mobileAppPattern;

  if (requested === undefined || requested === null || requested === '') {
    return { content: [{ type: 'text' as const, text: renderMobileAppPatternList() }] };
  }

  const spec = resolveMobileAppPattern(String(requested));
  if (!spec) {
    const ids = listMobileAppPatterns().map(p => p.id).join(', ');
    return {
      content: [{
        type: 'text' as const,
        text:
          `❌ Unknown warehouse-app pattern "${requested}". Available: ${ids}.\n` +
          `Call object_patterns(domain="mobile-app") without a pattern for the framework decision and the overview.`,
      }],
      isError: true,
    };
  }

  return { content: [{ type: 'text' as const, text: renderMobileAppPatternSpec(spec) }] };
}
