/**
 * Grounding dry-run for the warehouse-app cases (VM-free).
 *
 * A case instruction opens with "ground it first with <tool call>". Nothing
 * checked that those calls actually answer — a case whose grounding step is
 * broken still looks fine in the catalog and only fails on the VM, after the
 * implementer has already paid for a run.
 *
 * This executes the grounding path of each warehouse-app case here, in process,
 * and asserts the answer carries the names the case then asks the implementer to
 * write. It is the strongest run these cases can get without a D365FO VM: it
 * proves the ground truth is reachable, not that the artifact builds.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { xppKnowledgeTool } from '../../src/tools/knowledge/xppKnowledge';
import { objectPatternsTool } from '../../src/tools/knowledge/objectPatterns';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';

const CASES_DIR = path.resolve(__dirname, '..', '..', 'eval', 'cases');
const ctx: any = { symbolIndex: {}, parser: {} };
const text = (r: any): string => r.content?.[0]?.text ?? '';

const knowledge = (topic: string): CallToolRequest => ({
  method: 'tools/call',
  params: { name: 'get_knowledge', arguments: { topic } },
});
const patterns = (args: Record<string, unknown>): CallToolRequest => ({
  method: 'tools/call',
  params: { name: 'object_patterns', arguments: args },
});

function caseSpec(id: string): { instruction: string; tags: string[] } {
  return JSON.parse(fs.readFileSync(path.join(CASES_DIR, `${id}.json`), 'utf8'));
}

/** Case id → the identifiers its grounding must actually hand the implementer. */
const GROUNDED: Array<{
  id: string;
  topics: string[];
  pattern?: string;
  mustName: string[];
}> = [
  {
    id: 'L3-processguide-flow-slice',
    topics: ['process-guide-framework'],
    pattern: 'processguide-flow',
    mustName: [
      'ProcessGuideController',
      'ProcessGuideStep',
      'ProcessGuidePageBuilder',
      'ProcessGuideStepWithoutPrompt',
      'initializeNavigationRoute',
      'addProcessCompletionMessage',
      '#ProcessGuideActionNames',
    ],
  },
  {
    id: 'L2-processguide-page-control',
    topics: ['coc-authoring'],
    pattern: 'processguide-page-control',
    mustName: ['addDataControls', 'ExtensionOf', 'ProcessGuidePage'],
  },
  {
    id: 'L3-legacy-workexecutedisplay-extend',
    topics: ['warehouse-mobile-app'],
    pattern: 'legacy-workexecutedisplay',
    mustName: ['WHSWorkExecuteDisplay', 'processWorkLine', 'find_references'],
  },
  {
    id: 'L3-warehouse-scan-resolve-slice',
    topics: ['barcode-scanning', 'warehouse-mobile-app'],
    pattern: 'gs1-scan-input',
    mustName: ['application identifier', 'group separator'],
  },
];

describe('warehouse-app eval cases — grounding dry-run', () => {
  for (const g of GROUNDED) {
    it(`${g.id}: every tool its instruction names answers`, async () => {
      const spec = caseSpec(g.id);
      const answers: string[] = [];

      for (const topic of g.topics) {
        const out = text(await xppKnowledgeTool(knowledge(topic)));
        expect(out, `${g.id} → get_knowledge(topic="${topic}")`).not.toContain('❌ No matching');
        // The case names the topic verbatim, so it must also BE a real topic id.
        expect(spec.instruction, `${g.id} instruction must name topic ${topic}`).toContain(topic);
        answers.push(out);
      }

      if (g.pattern) {
        const r: any = await objectPatternsTool(patterns({ domain: 'mobile-app', pattern: g.pattern }), ctx);
        expect(r.isError, `${g.id} → object_patterns(pattern="${g.pattern}")`).toBeFalsy();
        answers.push(text(r));
      }

      const combined = answers.join('\n');
      const missing = g.mustName.filter(n => !combined.includes(n));
      expect(
        missing,
        `\n${g.id}: the grounding answer never names ${missing.join(', ')} — the case asks the ` +
          `implementer to write something the ground truth does not mention.`,
      ).toEqual([]);
    });
  }

  it('both frameworks have a case, so neither can silently rot', () => {
    const tagsOf = (id: string) => caseSpec(id).tags;
    expect(tagsOf('L3-processguide-flow-slice')).toContain('processguide');
    expect(tagsOf('L3-legacy-workexecutedisplay-extend')).toContain('legacy');
  });
});
