/**
 * X++ Knowledge Base Tool Tests
 */

import { describe, it, expect } from 'vitest';
import { xppKnowledgeTool, KNOWLEDGE_BASE } from '../../src/tools/knowledge/xppKnowledge';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';

const req = (args: Record<string, unknown> = {}): CallToolRequest => ({
  method: 'tools/call',
  params: { name: 'get_xpp_knowledge', arguments: args },
});

const getText = (result: any): string =>
  result.content?.[0]?.text ?? '';

describe('get_xpp_knowledge', () => {
  it('returns results for "batch job" topic', async () => {
    const result = await xppKnowledgeTool(req({ topic: 'batch job' }));
    const text = getText(result);
    expect(text).toContain('SysOperation');
    expect(text).not.toContain('❌ No matching');
  });

  it('returns results for "ttsbegin" topic', async () => {
    const result = await xppKnowledgeTool(req({ topic: 'ttsbegin' }));
    const text = getText(result);
    expect(text).toContain('ttsbegin');
    expect(text).toContain('ttscommit');
  });

  it('returns results for "CoC" topic', async () => {
    const result = await xppKnowledgeTool(req({ topic: 'CoC' }));
    const text = getText(result);
    expect(text).toContain('Chain of Command');
    expect(text).toContain('ExtensionOf');
  });

  it('returns results by entry ID', async () => {
    const result = await xppKnowledgeTool(req({ topic: 'set-based' }));
    const text = getText(result);
    expect(text).toContain('Set-Based Operations');
  });

  it('warns against COM Excel for "read excel" topic (file-readers)', async () => {
    const result = await xppKnowledgeTool(req({ topic: 'read excel csv' }));
    const text = getText(result);
    expect(text).toContain('OpenXML');
    expect(text).toContain('SysExcelApplication'); // documents the anti-pattern
    expect(text).not.toContain('❌ No matching');
  });

  it('returns the BatchHeader fan-out for "parallel batch" topic', async () => {
    const result = await xppKnowledgeTool(req({ topic: 'parallel batch' }));
    const text = getText(result);
    expect(text).toContain('addRuntimeTask');
    expect(text).not.toContain('❌ No matching');
  });

  it('requires a permission assert for "direct sql" topic', async () => {
    const result = await xppKnowledgeTool(req({ topic: 'direct sql' }));
    const text = getText(result);
    expect(text).toContain('SqlStatementExecutePermission');
    expect(text).not.toContain('❌ No matching');
  });

  it('documents AxMenuElementSubMenu (not AxMenuElementMenu) for "submenu" topic', async () => {
    // Regression (eval scenario 1 — Equipment Rental): hand-authoring a nested submenu into a
    // brand-new AxMenu (no tool operation exists for this — add-menu-item-to-menu only accepts
    // display/action/output) is easy to get wrong. A plausible-looking
    // <AxMenuElementMenu>/<MenuName> guess is NOT a real type — xppc itself doesn't catch it, only
    // the separate GenerateMetadata step fails to deserialize it. Verified live against
    // Microsoft.Dynamics.AX.Metadata.dll: the real type is AxMenuElementSubMenu with a <SubMenu>
    // field. This was previously undocumented anywhere in the knowledge base.
    const result = await xppKnowledgeTool(req({ topic: 'submenu' }));
    const text = getText(result);
    expect(text).toContain('AxMenuElementSubMenu');
    expect(text).toContain('SubMenu');
    expect(text).not.toContain('❌ No matching');
  });

  it('no longer mandates the deprecated SysEntryPointAttribute for custom services', async () => {
    // Finding B (KNOWLEDGE_GAP): the custom-services entry used to state every
    // operation MUST carry [SysEntryPointAttribute(true)], but xppc flags that
    // attribute as "obsolete: deprecated in AX7" — anyone following the KB got a
    // BP warning (bp_clean:0). Custom services must OMIT it; SysOperation entry
    // points still use it.
    // Corpus: eval/corpus/runs/2026-07-21T__L3-custom-service-basic__a2a4131.json
    const result = await xppKnowledgeTool(req({ topic: 'custom service', format: 'detailed' }));
    const text = getText(result);
    expect(text).not.toContain('❌ No matching');
    // Must not mandate the attribute any more.
    expect(text).not.toMatch(/MUST carry \[SysEntryPointAttribute/i);
    // Must flag it as deprecated for custom services.
    expect(text).toMatch(/deprecated/i);
    expect(text).toContain('SysEntryPointAttribute');
    // The example operation must no longer be decorated with the attribute.
    expect(text).not.toContain('[SysEntryPointAttribute(true)]');
  });

  it('returns detailed format with code examples', async () => {
    const result = await xppKnowledgeTool(req({ topic: 'transactions', format: 'detailed' }));
    const text = getText(result);
    expect(text).toContain('```xpp');
    expect(text).toContain('Code Examples');
  });

  it('returns concise format by default', async () => {
    const result = await xppKnowledgeTool(req({ topic: 'transactions' }));
    const text = getText(result);
    expect(text).toContain('Rules:');
    // Concise does not include code blocks
    expect(text).not.toContain('```xpp');
  });

  it('returns migration info for AX2012 topics', async () => {
    const result = await xppKnowledgeTool(req({ topic: 'RunBase', format: 'detailed' }));
    const text = getText(result);
    expect(text).toContain('AX2012');
    expect(text).toContain('D365FO');
  });

  it('returns deprecated API info', async () => {
    const result = await xppKnowledgeTool(req({ topic: 'today() deprecated' }));
    const text = getText(result);
    expect(text).toContain('DateTimeUtil');
  });

  it('returns all topics for empty-like query', async () => {
    const result = await xppKnowledgeTool(req({ topic: '' }));
    const text = getText(result);
    // Should list all entries alphabetically
    expect(text).toContain('Chain of Command');
    expect(text).toContain('Transaction');
  });

  it('returns no-match message for unknown topic', async () => {
    const result = await xppKnowledgeTool(req({ topic: 'zzzyyyxxx_nonexistent' }));
    const text = getText(result);
    expect(text).toContain('❌ No matching');
    expect(text).toContain('Available topics');
  });

  it('handles temp tables query', async () => {
    const result = await xppKnowledgeTool(req({ topic: 'temp tables TempDB' }));
    const text = getText(result);
    expect(text).toContain('TempDB');
    expect(text).toContain('InMemory');
  });

  it('handles SSRS report query', async () => {
    const result = await xppKnowledgeTool(req({ topic: 'ssrs report' }));
    const text = getText(result);
    expect(text).toContain('SSRS');
    // AOT casing, as the knowledge audit pins it (Srs…, not SRS…).
    expect(text).toContain('SrsReportDataProviderBase');
  });

  it('handles security query', async () => {
    const result = await xppKnowledgeTool(req({ topic: 'security roles duties' }));
    const text = getText(result);
    expect(text).toContain('Role');
    expect(text).toContain('Duty');
    expect(text).toContain('Privilege');
  });

  it('handles number sequence query', async () => {
    const result = await xppKnowledgeTool(req({ topic: 'number sequence' }));
    const text = getText(result);
    expect(text).toContain('NumberSeq');
  });

  it('resolves a hyphenated multi-word topic to the right entry', async () => {
    // Regression: "number-sequence" used to score 0 on the number-sequences
    // entry (keyword/title store the words space-separated) and silently
    // returned Electronic Reporting docs as the nearest substring hit.
    const result = await xppKnowledgeTool(req({ topic: 'number-sequence' }));
    const text = getText(result);
    expect(text).toContain('Number Sequences');
    expect(text).toContain('NumberSeq');
    expect(text).not.toContain('⚠️ No strong match');
  });

  it('returns error for missing topic parameter', async () => {
    const result = await xppKnowledgeTool(req({}));
    expect(result.isError).toBe(true);
  });

  it('handles data entity / OData query', async () => {
    const result = await xppKnowledgeTool(req({ topic: 'data entity odata integration' }));
    const text = getText(result);
    expect(text).toContain('Data Entit');
    expect(text).toContain('OData');
  });

  it('handles overlayering migration query', async () => {
    const result = await xppKnowledgeTool(req({ topic: 'overlayering overlay' }));
    const text = getText(result);
    expect(text).toContain('CoC');
  });

  it('surfaces related topics', async () => {
    const result = await xppKnowledgeTool(req({ topic: 'transactions', format: 'detailed' }));
    const text = getText(result);
    expect(text).toContain('Related topics');
  });

  // ── New knowledge topics (P1) ──────────────────────────────────────────

  it('handles inventory management query', async () => {
    const result = await xppKnowledgeTool(req({ topic: 'inventory InventTrans' }));
    const text = getText(result);
    expect(text).toContain('InventTrans');
    expect(text).toContain('InventDim');
  });

  it('handles feature management query', async () => {
    const result = await xppKnowledgeTool(req({ topic: 'feature management toggle' }));
    const text = getText(result);
    expect(text).toContain('FeatureClassAttribute');
    expect(text).toContain('isFeatureEnabled');
  });

  it('handles dual-write query', async () => {
    const result = await xppKnowledgeTool(req({ topic: 'dual-write Dataverse' }));
    const text = getText(result);
    expect(text).toContain('Dataverse');
    expect(text).toContain('dual-write');
  });

  it('handles DMF/DIXF query', async () => {
    const result = await xppKnowledgeTool(req({ topic: 'DMF data import staging' }));
    const text = getText(result);
    expect(text).toContain('Data Management');
    expect(text).toContain('staging');
  });

  it('handles warehouse management query', async () => {
    const result = await xppKnowledgeTool(req({ topic: 'warehouse WHS wave' }));
    const text = getText(result);
    expect(text).toContain('Warehouse');
    expect(text).toContain('WHSWork');
  });

  it('handles trade agreements query', async () => {
    const result = await xppKnowledgeTool(req({ topic: 'trade agreement pricing' }));
    const text = getText(result);
    expect(text).toContain('PriceDisc');
    expect(text).toContain('Trade');
  });

  it('handles configuration keys query', async () => {
    const result = await xppKnowledgeTool(req({ topic: 'configuration key license' }));
    const text = getText(result);
    expect(text).toContain('Configuration');
    expect(text).toContain('config key');
  });

  it('handles Power Platform integration query', async () => {
    const result = await xppKnowledgeTool(req({ topic: 'Power Platform virtual entity' }));
    const text = getText(result);
    expect(text).toContain('Power Platform');
    expect(text).toContain('virtual entit');
  });

  it('returns select-statement entry by ID', async () => {
    const result = await xppKnowledgeTool(req({ topic: 'select-statement' }));
    const text = getText(result);
    expect(text).toContain('select');
    expect(text).toContain('crossCompany');
  });

  it('returns coc-authoring entry by ID', async () => {
    const result = await xppKnowledgeTool(req({ topic: 'coc-authoring' }));
    const text = getText(result);
    expect(text).toContain('next');
    expect(text).toContain('ExtensionOf');
  });

  it('returns xpp-class-rules entry by ID', async () => {
    const result = await xppKnowledgeTool(req({ topic: 'xpp-class-rules' }));
    const text = getText(result);
    expect(text).toContain('class');
    expect(text).toContain('public');
  });

  it('returns sysda entry by ID', async () => {
    const result = await xppKnowledgeTool(req({ topic: 'sysda' }));
    const text = getText(result);
    expect(text).toContain('SysDa');
  });

  it('returns query-object-model entry by ID', async () => {
    const result = await xppKnowledgeTool(req({ topic: 'query-object-model' }));
    const text = getText(result);
    expect(text).toContain('Query');
    expect(text).toContain('QueryRun');
  });

  it('returns formrun-lifecycle entry by ID', async () => {
    const result = await xppKnowledgeTool(req({ topic: 'formrun-lifecycle' }));
    const text = getText(result);
    expect(text).toContain('FormRun');
    expect(text).toContain('init');
  });
});

/**
 * Run 7b8de4ba asked for "enum2str global function convert enum value to label
 * text" and was answered — without a caveat — by the extensible-enum topic,
 * because the token `enum2str` CONTAINS the keyword `enum` and scoreEntry credits
 * that direction. The only conversion example in the answer takes two arguments,
 * so the caller wrote enum2Str with two, and paid a 76 s failed build.
 *
 * The base now documents enum2Str, so that exact query is answered properly. What
 * is pinned here is the general guard: a name the base does not carry must come
 * back saying so, instead of quietly serving its nearest neighbour.
 */
describe('unknown distinctive tokens', () => {
  it('says so when an identifier-shaped word is not documented by name', async () => {
    const text = getText(await xppKnowledgeTool(req({ topic: 'SysFooBar2Baz conversion helper' })));
    expect(text).toContain('`SysFooBar2Baz` is not documented by name');
    // The results still come — this annotates them, it does not withhold them.
    expect(text).toContain('##');
    // The lesson from the run that motivated it.
    expect(text).toContain('do NOT infer a signature, an argument count');
  });

  it('names several unknowns and counts the rest', async () => {
    const text = getText(await xppKnowledgeTool(
      req({ topic: 'aslFooOne aslFooTwo aslFooThree aslFooFour enum' }),
    ));
    expect(text).toContain('are not documented by name');
    expect(text).toContain('(and 1 more)');
  });

  it('stays quiet for a name the base does document', async () => {
    // enum2Str earns its silence the only way that counts: it is in the base.
    const text = getText(await xppKnowledgeTool(
      req({ topic: 'enum2str global function convert enum value to label text' }),
    ));
    expect(text).not.toContain('is not documented by name');
    expect(text).toContain('ONE argument');
  });

  it('stays quiet for ordinary prose, however unmatched', async () => {
    // Only identifier-shaped words qualify: a digit against letters, internal
    // camelCase or an underscore. Plain words are the score guard's business.
    const text = getText(await xppKnowledgeTool(req({ topic: 'batch job' })));
    expect(text).not.toContain('not documented by name');
  });

  it('leaves every shipped entry id unflagged', async () => {
    // An id that tripped its own guard would be a scoring bug, not a warning.
    for (const topic of ['set-based', 'coc-authoring', 'enum-conversions', 'formrun-lifecycle']) {
      const text = getText(await xppKnowledgeTool(req({ topic })));
      expect(text, topic).not.toContain('not documented by name');
    }
  });
});

/**
 * Scanner/barcode routing (SCM audit, 2026-08-30).
 *
 * Before the `warehouse-mobile-app` / `barcode-scanning` topics existed, the base
 * answered the scanner half of WHS like this: `barcode`, `gs1` and `scanning`
 * returned "❌ No matching knowledge entries found", `item barcode` returned the
 * *menu* topic (the token `item` hits the keyword `menu item`), `license plate`
 * returned ISV *license codes*, and `scanner` returned **Electronic Reporting** —
 * scoreEntry credits `token.includes(keyword)`, and "scanner" contains "er".
 *
 * A wrong topic is worse than no topic: it reads as authoritative. These pin the
 * routing, not the prose — the failure they guard against is a future keyword
 * edit silently handing scanner questions back to an unrelated framework.
 */
describe('warehouse scanner / barcode routing', () => {
  const routes: Array<[string, string]> = [
    ['barcode', 'barcode-scanning'],
    ['gs1', 'barcode-scanning'],
    ['gtin', 'barcode-scanning'],
    ['item barcode', 'barcode-scanning'],
    ['application identifier', 'barcode-scanning'],
    ['scanner', 'warehouse-mobile-app'],
    ['scanning', 'warehouse-mobile-app'],
    ['warehouse mobile app', 'warehouse-mobile-app'],
    ['mobile device menu item', 'warehouse-mobile-app'],
    ['license plate', 'warehouse-mobile-app'],
    ['handheld', 'warehouse-mobile-app'],
  ];

  const titleOf = (id: string) => KNOWLEDGE_BASE.find(e => e.id === id)!.title;

  for (const [topic, expectedId] of routes) {
    it(`"${topic}" is answered by ${expectedId}`, async () => {
      const text = getText(await xppKnowledgeTool(req({ topic })));
      expect(text, topic).not.toContain('❌ No matching');
      // The top result is the first "## <title>" heading in the rendered answer.
      expect(text.split('\n').find(l => l.startsWith('## ')), topic)
        .toBe(`## ${titleOf(expectedId)}`);
    });
  }

  it('keeps the topics the scanner keywords used to be stolen from', async () => {
    // The other half of the same defect: widening keywords must not push a
    // neighbouring topic off its own query.
    const unchanged: Array<[string, string]> = [
      ['electronic reporting', 'electronic-reporting'],
      ['license code', 'license-codes'],
      ['menu item', 'menu-navigation'],
      ['wave template', 'warehouse-management'],
      ['inventory on-hand', 'inventory-management'],
    ];
    for (const [topic, id] of unchanged) {
      const text = getText(await xppKnowledgeTool(req({ topic })));
      expect(text.split('\n').find(l => l.startsWith('## ')), topic)
        .toBe(`## ${titleOf(id)}`);
    }
  });

  it('teaches the two invariants a scanner customization gets wrong', async () => {
    const step = getText(await xppKnowledgeTool(req({ topic: 'warehouse-mobile-app', format: 'detailed' })));
    // Stateless round trips — state in the container, not in member variables.
    expect(step).toMatch(/stateless/i);
    expect(step).toContain('NEVER in class member variables');

    const scan = getText(await xppKnowledgeTool(req({ topic: 'barcode-scanning', format: 'detailed' })));
    // A scan is not an item number; AIs are parsed, not sliced at offsets.
    expect(scan).toContain('GTIN is not an item number');
    expect(scan).toContain('FNC1');
  });
});
