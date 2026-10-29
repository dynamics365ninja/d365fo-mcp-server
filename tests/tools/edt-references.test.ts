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

/** Bridge that is running, but without a cross-reference database (none configured, or unreachable). */
function bridgeWithoutXref(): BridgeClient {
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
      const text = await runTool({ targetName: 'EcoResDescription', targetType }, bridgeWithoutXref());

      expect(text).not.toContain('Total References Found:** 0');
      expect(text).not.toContain('Symbol might be unused');
      expect(text).toContain('inconclusive');
      expect(text).toContain('NOT a count of zero');
      expect(text).toContain(`**Target Type:** ${targetType}`);
    });
  }

  it('points an EDT lookup at the "/Edts/" AOT path that does work', async () => {
    const text = await runTool({ targetName: 'EcoResDescription', targetType: 'edt' }, bridgeWithoutXref());
    // "/Edts/…" (plural, leading slash) is the verified TARGET convention.
    expect(text).toContain('/Edts/EcoResDescription');
    // The concrete-subtype form is a SOURCE-path convention and matches nothing.
    expect(text).not.toContain('/EdtString/');
  });

  it('offers no AOT-path suggestion when the caller already passed one', async () => {
    const text = await runTool({ targetName: '/Edts/EcoResDescription', targetType: 'edt' }, bridgeWithoutXref());
    expect(text).not.toContain('Or pass the explicit AOT path');
  });

  it('still searches the types the fallback does implement', async () => {
    for (const targetType of ['method', 'class', 'table', 'field', 'enum', 'all']) {
      const text = await runTool({ targetName: 'SomeName', targetType }, bridgeWithoutXref());
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
    expect(text).not.toContain('not connected');
    expect(text).not.toContain('runs without a cross-reference database');
  });

  it('says the cross-reference database is missing when the bridge runs without one', async () => {
    const text = await runTool({ targetName: 'SomeName', targetType: 'class' }, bridgeWithoutXref());
    expect(text).toContain('runs without a cross-reference database');
    // The bridge is up, so this must not read as an outage.
    expect(text).not.toContain('not connected');
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
      // Advice to fix the bridge, which made the old text actively wrong in this exact case.
      expect(text).not.toContain('then re-run');
      expect(text).not.toContain('D365FO_XREF_DB_NAME');
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
    // Each cause is told its own fix, and only that one.
    const advice: Array<[BridgeClient, string]> = [
      [bridgeWithoutXref(), 'set `D365FO_XREF_DB_NAME`'],
      [bridgeThatThrows(), 'Check the bridge log'],
      [undefined as unknown as BridgeClient, 'Ensure the C# bridge exe is built'],
    ];
    for (const [bridge, whatToDo] of advice) {
      const text = await runTool({ targetName: 'EcoResDescription', targetType: 'edt' }, bridge);
      expect(text).toContain('inconclusive');
      expect(text).not.toContain('**Total References Found:** 0');
      expect(text).toContain(whatToDo);
      for (const [, other] of advice) {
        if (other !== whatToDo) expect(text).not.toContain(other);
      }
    }
  });
});

// ─── declarative metadata references ───────────────────────────────────────────
// Metadata references are stored with a singular, slash-free source path that
// carries the referencing property. The C# bridge now queries their targets too
// (Table/X, EdtString/X, …); what it hands back must read as "who uses it", not
// as a raw path, and the summary must say how much came from metadata.

describe('find_references — metadata references from the bridge', () => {
  function bridgeWithMetadataRows(): BridgeClient {
    return {
      isReady: true,
      metadataAvailable: true,
      xrefAvailable: true,
      findReferences: vi.fn(async () => ({
        count: 3,
        references: [
          { sourcePath: '/Tables/MyFormatTable/Methods/exist', sourceModule: 'MyModel', line: 11, column: 5, referenceType: 'type-reference', callerClass: 'MyFormatTable', callerMethod: 'exist' },
          { sourcePath: 'Table/MyOutboundStaging/TableFieldString/Format1?ExtendedDataType', sourceModule: 'MyModel', line: 0, column: 0, referenceType: 'type-reference', callerClass: 'MyOutboundStaging' },
          { sourcePath: 'Form/MyJournalForm/FormDataSourceRoot/MyCountingTrans?Table', sourceModule: 'MyModel', line: 0, column: 0, referenceType: 'type-reference', callerClass: 'MyJournalForm' },
        ],
      })),
    } as unknown as BridgeClient;
  }

  it('names the referencing object, member and property of a metadata reference', async () => {
    const text = await runTool({ targetName: 'MyFormatCode', targetType: 'edt' }, bridgeWithMetadataRows());
    expect(text).toContain('Table MyOutboundStaging › Format1 › ExtendedDataType');
    expect(text).toContain('Form MyJournalForm › MyCountingTrans › Table');
    // Code references keep their Class.method reading.
    expect(text).toContain('MyFormatTable.exist');
    expect(text).not.toContain('**Table/MyOutboundStaging/TableFieldString');
  });

  it('splits the summary into X++ code and declarative metadata', async () => {
    const text = await runTool({ targetName: 'MyFormatCode', targetType: 'edt' }, bridgeWithMetadataRows());
    expect(text).toContain('From X++ code: 1 · from declarative metadata: 2');
    expect(text).toContain('X++ code and declarative metadata references');
  });

  it('scopes a bare name to the type targetType names, not every same-named object', async () => {
    // Bare, "CustTable" also matched the form, menu item and query named CustTable.
    for (const [targetType, path] of [['table', '/Tables/CustTable'], ['edt', '/Edts/CustTable'], ['form', '/Forms/CustTable']]) {
      const bridge = bridgeWithMetadataRows();
      await runTool({ targetName: 'CustTable', targetType }, bridge);
      expect(bridge.findReferences as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(path);
      expect(bridge.findReferences as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1);
    }
    // Without a type there is nothing to scope to: the bridge expands the bare name.
    const bridge = bridgeWithMetadataRows();
    await runTool({ targetName: 'CustTable' }, bridge);
    expect(bridge.findReferences as ReturnType<typeof vi.fn>).toHaveBeenCalledWith('CustTable');
  });

  it('scopes to entities, maps and menu items, which have no container of their own in "view"', async () => {
    // "/Views/<entity>" matches nothing: an entity is stored under DataEntityViews.
    for (const [targetType, paths] of [
      ['data-entity', ['/DataEntityViews/CustCustomerV3Entity']],
      ['map', ['/Maps/CustCustomerV3Entity']],
      // A menu item often shares its name with the class or report it runs.
      ['menu-item', ['/MenuItemDisplays/CustCustomerV3Entity', '/MenuItemActions/CustCustomerV3Entity', '/MenuItemOutputs/CustCustomerV3Entity']],
    ] as const) {
      const bridge = bridgeWithMetadataRows();
      await runTool({ targetName: 'CustCustomerV3Entity', targetType }, bridge);
      const fn = bridge.findReferences as ReturnType<typeof vi.fn>;
      expect(fn.mock.calls.map(c => c[0])).toEqual(paths);
    }
  });

  it('looks an enum value up as a member of its enum, written "Enum::Value" or "Enum.Value"', async () => {
    for (const targetName of ['SalesStatus::Invoiced', 'SalesStatus.Invoiced']) {
      const bridge = bridgeWithMetadataRows();
      await runTool({ targetName, targetType: 'enum' }, bridge);
      expect(bridge.findReferences as ReturnType<typeof vi.fn>).toHaveBeenCalledWith('/Enums/SalesStatus/EnumValues/Invoiced');
      expect(bridge.findReferences as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1);
    }
    // Untyped, an owner the index knows as an enum is queried for the value too.
    const enumIndex = {
      getReadDb: () => ({
        prepare: (sql: string) => ({
          all: (name: string) => (/FROM symbols/.test(sql) && /NOT IN/.test(sql) && name === 'SalesStatus'
            ? [{ type: 'enum', model: 'ApplicationSuite' }] : []),
        }),
      }),
    };
    const bridge = bridgeWithMetadataRows();
    await findReferencesTool(req({ targetName: 'SalesStatus::Invoiced' }), { symbolIndex: enumIndex, bridge } as any);
    expect(bridge.findReferences as ReturnType<typeof vi.fn>).toHaveBeenCalledWith('/Enums/SalesStatus/EnumValues/Invoiced');
  });

  it('queries an entity member under DataEntityViews, although the index calls the entity a view', async () => {
    const viewIndex = {
      getReadDb: () => ({
        prepare: (sql: string) => ({
          all: (name: string) => (/FROM symbols/.test(sql) && /NOT IN/.test(sql) && name === 'LogisticsPostalAddressBaseEntity'
            ? [{ type: 'view', model: 'ApplicationSuite' }] : []),
        }),
      }),
    };
    const bridge = bridgeWithMetadataRows();
    await findReferencesTool(req({ targetName: 'LogisticsPostalAddressBaseEntity.CountryRegionId', targetType: 'field' }), { symbolIndex: viewIndex, bridge } as any);
    const fn = bridge.findReferences as ReturnType<typeof vi.fn>;
    expect(fn.mock.calls.map(c => c[0])).toEqual([
      '/Views/LogisticsPostalAddressBaseEntity/Fields/CountryRegionId',
      '/DataEntityViews/LogisticsPostalAddressBaseEntity/Fields/CountryRegionId',
    ]);
  });

  it('looks up a table index or field group only when targetType asks for it', async () => {
    for (const [targetType, path] of [
      ['index', '/Tables/CustTable/TableIndexs/AccountIdx'],
      ['field-group', '/Tables/CustTable/TableFieldGroups/AccountIdx'],
    ] as const) {
      const bridge = bridgeWithMetadataRows();
      await runTool({ targetName: 'CustTable.AccountIdx', targetType }, bridge);
      expect((bridge.findReferences as ReturnType<typeof vi.fn>).mock.calls.map(c => c[0])).toEqual([path]);
    }
    // Untyped, a same-named field must not pick up the index or the field group.
    const bridge = bridgeWithMetadataRows();
    await runTool({ targetName: 'CustTable.AccountIdx' }, bridge);
    const sent = (bridge.findReferences as ReturnType<typeof vi.fn>).mock.calls.map(c => c[0]).join(' ');
    expect(sent).not.toMatch(/TableIndexs|TableFieldGroups/);
  });

  it('asks for the table instead of reporting zero for an owner-less index or field group', async () => {
    for (const targetType of ['index', 'field-group'] as const) {
      const bridge = bridgeWithMetadataRows();
      const text = await runTool({ targetName: 'AccountIdx', targetType }, bridge);
      expect(bridge.findReferences).not.toHaveBeenCalled();
      expect(text).toContain('NOT a count of zero');
      expect(text).toContain('Table.AccountIdx');
      expect(text).not.toMatch(/Total References Found/);
    }
  });

  it('looks up a form data source method as Form.DataSource.method', async () => {
    const bridge = bridgeWithMetadataRows();
    await runTool({ targetName: 'VendOpenTrans.VendTransOpen.editMarkTrans', targetType: 'method' }, bridge);
    expect((bridge.findReferences as ReturnType<typeof vi.fn>).mock.calls.map(c => c[0]))
      .toEqual(['/Forms/VendOpenTrans/DataSources/VendTransOpen/Methods/editMarkTrans']);
  });

  it('reports the exact totals and shows both code and metadata rows when the bridge sampled', async () => {
    // The live case: 785 references to a table, 451 of them metadata; the bridge
    // returns up to 500 rows per shape with the true totals alongside.
    const code = Array.from({ length: 334 }, (_, i) => ({
      sourcePath: `/Classes/C${i}/Methods/m`, sourceModule: 'M', line: 1, column: 1, referenceType: 'field-access', callerClass: `C${i}`, callerMethod: 'm',
    }));
    const metadata = Array.from({ length: 166 }, (_, i) => ({
      sourcePath: `Form/F${i}/FormDataSourceRoot/MyCountingTrans?Table`, sourceModule: 'M', line: 0, column: 0, referenceType: 'type-reference', callerClass: `F${i}`,
    }));
    const bridge = {
      isReady: true, metadataAvailable: true, xrefAvailable: true,
      findReferences: vi.fn(async () => ({ count: 500, total: 785, metadataTotal: 451, references: [...code, ...metadata] })),
    } as unknown as BridgeClient;
    const text = await runTool({ targetName: 'MyCountingTrans', targetType: 'table', limit: 20 }, bridge);
    expect(text).toContain('**Total:** 785 reference(s) found (showing 500)');
    expect(text).toContain('From X++ code: 334 · from declarative metadata: 451');
    expect(text).toContain('the totals are exact');
    // Neither shape crowds the other out of the list.
    expect(text).toContain('### From declarative metadata (10 of 451)');
    expect(text).toContain('### From X++ code (10 of 334)');
    expect(text).toContain('Form F0 › MyCountingTrans › Table');
  });

  it('says when a lookup hit the bridge row limit, so the total is a floor', async () => {
    const rows = Array.from({ length: 500 }, (_, i) => ({
      sourcePath: `/Classes/C${i}/Methods/m`, sourceModule: 'M', line: 1, column: 1, referenceType: 'call', callerClass: `C${i}`, callerMethod: 'm',
    }));
    const bridge = {
      isReady: true, metadataAvailable: true, xrefAvailable: true,
      findReferences: vi.fn(async () => ({ count: 500, references: rows })),
    } as unknown as BridgeClient;
    const text = await runTool({ targetName: '/Tables/Busy' }, bridge);
    expect(text).toContain('500+ reference(s)');
    expect(text).toContain('limit of 500 rows');
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
