/**
 * add-relation must carry Cardinality / RelatedTableCardinality / RelationshipType
 * to the bridge, and must not double-write them on disk when it did.
 *
 * Dropping them is what raised BPErrorTableRelationshipPropertiesCompleteness on a
 * relation the tool reported as added, with no repair path — modify-property rejects
 * `Relations/<name>/RelationshipType` (findings #5 / #35).
 *
 * Ground truth for the values: AxTableRelation on platform 7.0.7858.27 exposes
 * Cardinality (NotSpecified|ZeroOne|ExactlyOne|ZeroMore|OneMore),
 * RelatedTableCardinality (NotSpecified|ZeroOne|ExactlyOne) and
 * RelationshipType (NotSpecified|Association|Composition|Link|Specialization|Aggregation).
 * A probe against the live bridge serialised all three in the SDK's own element order
 * (Name → Cardinality → RelatedTable → RelatedTableCardinality → RelationshipType →
 * Constraints) and rejected an invalid value instead of dropping it.
 */

import { describe, it, expect, vi } from 'vitest';
import { bridgeAddRelation } from '../../src/bridge/bridgeAdapter';

const fakeBridge = (response: Record<string, unknown>) => {
  const addRelation = vi.fn(async () => response);
  return { bridge: { isReady: true, metadataAvailable: true, addRelation } as any, addRelation };
};

describe('bridgeAddRelation carries the relation properties', () => {
  it('forwards all three properties to the client', async () => {
    const { bridge, addRelation } = fakeBridge({
      success: true, api: 'IMetaTableProvider.Update',
      cardinality: 'ZeroMore', relatedTableCardinality: 'ExactlyOne', relationshipType: 'Association',
    });
    await bridgeAddRelation(bridge, 'ConTable', 'ConRel', 'CustTable', undefined, {
      relationCardinality: 'ZeroMore',
      relatedTableCardinality: 'ExactlyOne',
      relationshipType: 'Association',
    });
    expect(addRelation).toHaveBeenCalledWith('ConTable', 'ConRel', 'CustTable', undefined, {
      relationCardinality: 'ZeroMore',
      relatedTableCardinality: 'ExactlyOne',
      relationshipType: 'Association',
    });
  });

  it('reports what the bridge actually set, so the caller sees the values', async () => {
    const { bridge } = fakeBridge({
      success: true, api: 'IMetaTableProvider.Update',
      cardinality: 'OneMore', relatedTableCardinality: 'ZeroOne', relationshipType: 'Composition',
    });
    const r = await bridgeAddRelation(bridge, 'ConTable', 'ConRel', 'CustTable');
    expect(r?.propertiesWritten).toBe(true);
    expect(r?.message).toContain('RelationshipType=Composition');
    expect(r?.message).toContain('Cardinality=OneMore');
  });

  it('flags an OLD bridge binary, which echoes no properties back', async () => {
    // The extra params are simply ignored by a stale exe — the on-disk fallback in
    // modifyD365File keys off this flag, so it must not be true by accident.
    const { bridge } = fakeBridge({ success: true, api: 'IMetaTableProvider.Update' });
    const r = await bridgeAddRelation(bridge, 'ConTable', 'ConRel', 'CustTable');
    expect(r?.propertiesWritten).toBe(false);
    expect(r?.message).not.toContain('RelationshipType');
  });

  it('returns null when the bridge is unavailable (unchanged)', async () => {
    expect(await bridgeAddRelation(undefined, 'ConTable', 'ConRel', 'CustTable')).toBeNull();
  });
});
