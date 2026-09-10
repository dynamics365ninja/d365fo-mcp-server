/**
 * find_references — EDT (and other metadata-type) where-used.
 *
 * Regression cover for three defects found together on a live UDE instance while
 * chasing "the MCP returns no xref for EDTs", tested with EcoResDescription:
 *
 *   1. The name-based fallback had branches for method/class/table/field/enum
 *      only. `targetType: 'edt'` (and form/query/view/report) matched none, so NO
 *      query ran and the tool reported "Total References Found: 0" — a confident
 *      zero that actually meant "never searched". `targetType: 'all'` hit every
 *      branch and returned 60, which is what made the zero look like a real
 *      per-type answer rather than a dead code path.
 *
 *   2. Every fallback was labelled "(xref bridge unavailable)" regardless of why
 *      the bridge did not answer. On the instance under test the bridge was up
 *      and healthy — it served 161 label references in the same session — and had
 *      simply returned no rows, because of defect 3. The label sent two separate
 *      investigations hunting a bridge outage that was not happening.
 *
 *   3. (C# side, CrossReferenceService.FindReferences) the bare-name path
 *      expansion covered Tables/Classes/Enums/Views/DataEntityViews/Queries/Forms
 *      and nothing else, so an EDT target matched no path at all. Verified live:
 *      "/Edts/EcoResDescription" returns 261 references; "/EdtString/…" — the
 *      SOURCE-path convention — returns none. That container list is C#, so it is
 *      not unit-testable from here; what IS tested below is that the TS layer
 *      hands an explicit "/Edts/…" path through to the bridge untouched.
 */

import { describe, it, expect, vi } from 'vitest';
import { findReferencesTool } from '../../src/tools/analysis/findReferences';
import type { BridgeClient } from '../../src/bridge/bridgeClient';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';

/** symbolIndex stub whose every query comes back empty — enough for the fallback. */
const emptyIndex = {
  getReadDb: () => ({ prepare: () => ({ all: () => [] }) }),
};

/** Bridge that is up and answering, but has no rows for the target. */
function bridgeWithNoRows(): BridgeClient {
  return {
    isReady: true,
    metadataAvailable: true,
    xrefAvailable: true,
    findReferences: vi.fn(async () => ({ count: 0, references: [] })),
  } as unknown as BridgeClient;
}

/** Bridge that is up but whose query fails — an outcome of 'error', never 'empty'. */
function bridgeThatThrows(): BridgeClient {
  return {
    isReady: true,
    metadataAvailable: true,
    xrefAvailable: true,
    findReferences: vi.fn(async () => { throw new Error('SQL timeout'); }),
  } as unknown as BridgeClient;
}

/** Bridge that is not in play at all (serverless mode / no xref DB configured). */
function bridgeUnavailable(): BridgeClient {
  return { isReady: true, metadataAvailable: true, xrefAvailable: false } as unknown as BridgeClient;
}

/** Bridge that returns real rows for any target. */
function bridgeWithRows(): BridgeClient {
  return {
    isReady: true,
    metadataAvailable: true,
    xrefAvailable: true,
    findReferences: vi.fn(async () => ({
      count: 2,
      // callerClass/callerMethod are parsed from the source path by the C# side
      // (ReferenceInfoModel), so a faithful fixture carries them too.
      references: [
        { sourcePath: '/Tables/InventTable/Methods/itemDescriptionOrName', sourceModule: 'ApplicationSuite', line: 812, column: 20, referenceType: 'type-reference', callerClass: 'InventTable', callerMethod: 'itemDescriptionOrName' },
        { sourcePath: '/Classes/BOMCalcTrans/Methods/getDisplayDescription', sourceModule: 'ApplicationSuite', line: 44, column: 9, referenceType: 'type-reference', callerClass: 'BOMCalcTrans', callerMethod: 'getDisplayDescription' },
      ],
    })),
  } as unknown as BridgeClient;
}

function req(args: Record<string, unknown>): CallToolRequest {
  return { method: 'tools/call', params: { name: 'find_references', arguments: args } } as CallToolRequest;
}

async function runTool(args: Record<string, unknown>, bridge: BridgeClient): Promise<string> {
  const result = await findReferencesTool(req(args), { symbolIndex: emptyIndex, bridge } as any);
  return (result.content[0] as { text: string }).text;
}

// ─── defect 1: types the fallback cannot search ────────────────────────────────

describe('find_references — targetTypes the name-based fallback cannot serve', () => {
  // These five are in the tool schema's targetType enum but have no branch in the
  // fallback scan. Before the fix each returned "Total References Found: 0".
  for (const targetType of ['edt', 'form', 'query', 'view', 'report']) {
    it(`does not report a bare "0" for targetType="${targetType}"`, async () => {
      const text = await runTool({ targetName: 'EcoResDescription', targetType }, bridgeUnavailable());

      expect(text).not.toContain('Total References Found:** 0');
      expect(text).not.toContain('Symbol might be unused');
      expect(text).toContain('inconclusive');
      expect(text).toContain('NOT a count of zero');
      expect(text).toContain(`**Target Type:** ${targetType}`);
    });
  }

  it('points an EDT lookup at the "/Edts/" AOT path that does work', async () => {
    const text = await runTool({ targetName: 'EcoResDescription', targetType: 'edt' }, bridgeUnavailable());
    // "/Edts/…" (plural, leading slash) is the verified TARGET convention.
    expect(text).toContain('/Edts/EcoResDescription');
    // The concrete-subtype form is a SOURCE-path convention and matches nothing.
    expect(text).not.toContain('/EdtString/');
  });

  it('offers no AOT-path suggestion when the caller already passed one', async () => {
    const text = await runTool({ targetName: '/Edts/EcoResDescription', targetType: 'edt' }, bridgeUnavailable());
    expect(text).not.toContain('Or pass the explicit AOT path');
  });

  it('still searches the types the fallback does implement', async () => {
    for (const targetType of ['method', 'class', 'table', 'field', 'enum', 'all']) {
      const text = await runTool({ targetName: 'SomeName', targetType }, bridgeUnavailable());
      expect(text).toContain('Total References Found:');
      expect(text).not.toContain('inconclusive');
    }
  });
});

// ─── defect 2: honest reason for falling back ──────────────────────────────────

describe('find_references — why the fallback was used', () => {
  it('does not claim an outage when the bridge answered with no rows', async () => {
    const text = await runTool({ targetName: 'SomeName', targetType: 'class' }, bridgeWithNoRows());

    expect(text).toContain('returned no rows for this target');
    expect(text).not.toContain('bridge unavailable');
    expect(text).not.toContain('xref bridge down');
  });

  it('says the bridge is unavailable only when it actually is', async () => {
    const text = await runTool({ targetName: 'SomeName', targetType: 'class' }, bridgeUnavailable());
    expect(text).toContain('unavailable in this server mode');
  });

  it('carries the same reason into the zero-result caveat', async () => {
    const text = await runTool({ targetName: 'SomeName', targetType: 'class' }, bridgeWithNoRows());
    // The caveat block only prints when the scan found nothing, which is the
    // case here — and it used to open with "With the xref bridge down,".
    expect(text).toContain('not evidence that it is unused');
    expect(text).toContain('returned no rows for this target');
    expect(text).not.toContain('With the xref bridge down');
  });

  it('reports a failed query as a failure, not as absence', async () => {
    const bridge = {
      isReady: true, metadataAvailable: true, xrefAvailable: true,
      findReferences: vi.fn(async () => { throw new Error('SQL timeout'); }),
    } as unknown as BridgeClient;

    const text = await runTool({ targetName: 'SomeName', targetType: 'class' }, bridge);
    expect(text).toContain('cross-reference query failed');
  });
});

// ─── an unsearchable type when the bridge DID answer ──────────────────────────

describe('find_references — unsearchable targetType, bridge answered with no rows', () => {
  // The two halves of this fix met here and disagreed. Adding /Edts/ (etc.) to the
  // C# container list is what makes a bare EDT name reach the rows that exist —
  // so once it does, a bridge 'empty' for these types is a real zero, and
  // tryBridgeReferences only ever returns 'empty' when every query ran cleanly.
  // The unsearchable-type message called it "inconclusive" anyway, and told the
  // reader to "re-run once the xref bridge is available" while the bridge was the
  // thing that had just answered them.
  for (const targetType of ['edt', 'form', 'query', 'view', 'report']) {
    it(`reports an authoritative zero for targetType="${targetType}"`, async () => {
      const text = await runTool({ targetName: 'EcoResDescription', targetType }, bridgeWithNoRows());

      expect(text).toContain('**Total References Found:** 0');
      expect(text).toContain('C# bridge (DYNAMICSXREFDB)');
      expect(text).not.toContain('inconclusive');
      expect(text).not.toContain('NOT a count of zero');
      // The advice that made the old text actively wrong in this exact case.
      expect(text).not.toContain('Re-run once the xref bridge is available');
      // Re-running the bare name as an explicit path queries a strict subset of
      // what just ran, so offering it here would be noise.
      expect(text).not.toContain('Or pass the explicit AOT path');
    });
  }

  it('still keeps the "not necessarily unused" caveat on the zero', async () => {
    const text = await runTool({ targetName: 'EcoResDescription', targetType: 'edt' }, bridgeWithNoRows());
    expect(text).toContain('Before concluding it is unused');
    expect(text).toContain('misspelling is indistinguishable');
  });

  it('still refuses to give a number when the bridge could not answer', async () => {
    // The distinction the whole branch rests on: 'unavailable'/'error' keep the
    // inconclusive wording, so this must not have become a blanket zero.
    for (const bridge of [bridgeUnavailable(), bridgeThatThrows()]) {
      const text = await runTool({ targetName: 'EcoResDescription', targetType: 'edt' }, bridge);
      expect(text).toContain('inconclusive');
      expect(text).not.toContain('**Total References Found:** 0');
      expect(text).toContain('Re-run once the xref bridge is available');
    }
  });
});

// ─── defect 3 (TS half): explicit AOT paths reach the bridge untouched ─────────

describe('find_references — explicit "/Edts/" path routing', () => {
  it('passes an "/Edts/…" target to the bridge verbatim and formats its rows', async () => {
    const bridge = bridgeWithRows();
    const text = await runTool({ targetName: '/Edts/EcoResDescription' }, bridge);

    expect(bridge.findReferences as ReturnType<typeof vi.fn>).toHaveBeenCalledWith('/Edts/EcoResDescription');
    expect(text).toContain('C# bridge (DYNAMICSXREFDB)');
    expect(text).toContain('InventTable.itemDescriptionOrName');
    // A bridge answer must never be relabelled as the heuristic scan.
    expect(text).not.toContain('name-based index scan');
  });

  it('prefers the bridge answer over the fallback for targetType="edt"', async () => {
    // Once the C# container list includes /Edts/, a bare EDT name resolves on the
    // bridge and the unsearchable-type message must NOT pre-empt it.
    const bridge = bridgeWithRows();
    const text = await runTool({ targetName: 'EcoResDescription', targetType: 'edt' }, bridge);

    expect(text).toContain('C# bridge (DYNAMICSXREFDB)');
    expect(text).not.toContain('inconclusive');
  });
});
