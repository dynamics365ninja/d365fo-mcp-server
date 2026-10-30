/**
 * The bridge SKIP contract — an operation that wrote nothing must never be
 * reported as one that did.
 *
 * The bridge answers a declined write with `{ success: true, skipped: true, reason }`:
 * nothing failed, and nothing changed. Every wrapper read only `success`, so all four
 * skippable operations rendered their success branch — "✅ … added" — over a file the
 * provider never opened, and dropped the bridge's own reason on the way past.
 *
 * What that cost: `add-data-source` on a form-extension was handed three data sources,
 * skipped all three on an over-broad table-match guard (removed in the same change as
 * this test), and replied "3/3 operation(s) applied / ✅ Verified: on disk" over a
 * byte-identical file whose mtime had not moved.
 *
 * Asserted here:
 *  1. skippedMessage() fires on `skipped`, and only on `skipped`;
 *  2. all four skippable wrappers report the skip instead of claiming a write;
 *  3. the word "added" never appears in a skip message — that single word was the lie;
 *  4. the bridge's `reason` survives to the caller;
 *  5. an ordinary write is untouched by any of it.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  skippedMessage,
  bridgeAddField,
  bridgeAddFieldToFieldGroup,
  bridgeAddDataSource,
  bridgeAddMenuItemToMenu,
  bridgeAddIndex,
  bridgeAddFieldGroup,
  bridgeAddRelation,
} from '../../src/bridge/bridgeAdapter';

/** A healthy bridge whose every write returns the given payload. */
function bridgeReturning(payload: Record<string, unknown>): any {
  const answer = async () => payload;
  return {
    isReady: true,
    metadataAvailable: true,
    addField: answer,
    addFieldToFieldGroup: answer,
    addDataSource: answer,
    addMenuItemToMenu: answer,
    addIndex: answer,
    addFieldGroup: answer,
    addRelation: answer,
  };
}

const SKIP = {
  success: true,
  skipped: true,
  reason: "data source 'KSPurchTable' already binds table 'PurchTable'",
  api: 'IMetaFormExtensionProvider.Update',
};

const WROTE = { success: true, api: 'IMetaFormExtensionProvider.Update' };

/** The four wrappers whose bridge operation can return `skipped`. */
const SKIPPABLE: Array<{
  name: string;
  call: (b: any) => Promise<{ success: boolean; message: string; skipped?: boolean } | null>;
}> = [
  {
    name: 'bridgeAddField',
    call: b => bridgeAddField(b, 'PurchTable.Ext', 'KSFlag', 'String'),
  },
  {
    name: 'bridgeAddFieldToFieldGroup',
    call: b => bridgeAddFieldToFieldGroup(b, 'PurchTable', 'Overview', 'KSFlag'),
  },
  {
    name: 'bridgeAddDataSource',
    call: b => bridgeAddDataSource(b, 'form-extension', 'PurchLineBackOrder.Ext', 'KSPurchTableTrans', 'PurchTable'),
  },
  {
    name: 'bridgeAddMenuItemToMenu',
    call: b => bridgeAddMenuItemToMenu(b, 'PurchOrder', 'KSBackOrderMenuItem'),
  },
  // The table adds below skip an element that already exists (AddIndex, AddFieldGroup,
  // AddRelation). AutoReport is the common case: table create writes it, and a
  // follow-up add-field-group AutoReport used to fail with "already exists among elements".
  {
    name: 'bridgeAddIndex',
    call: b => bridgeAddIndex(b, 'PurchTable', 'KSIdx', ['PurchId']),
  },
  {
    name: 'bridgeAddFieldGroup',
    call: b => bridgeAddFieldGroup(b, 'PurchTable', 'AutoReport', undefined, ['PurchId']),
  },
  {
    name: 'bridgeAddRelation',
    call: b => bridgeAddRelation(b, 'PurchTable', 'KSRel', 'VendTable', [{ field: 'OrderAccount', relatedField: 'AccountNum' }]),
  },
];

describe('skippedMessage', () => {
  it('stays silent unless the bridge actually skipped', () => {
    expect(skippedMessage({}, 'thing')).toBeNull();
    expect(skippedMessage({ skipped: false }, 'thing')).toBeNull();
    // `success: true` alone is not a skip — that conflation is the whole bug.
    expect(skippedMessage({ reason: 'some note' }, 'thing')).toBeNull();
  });

  it('names the subject and carries the reason through verbatim', () => {
    const msg = skippedMessage({ skipped: true, reason: 'already exists' }, "DataSource 'KSFoo'");
    expect(msg).toContain("DataSource 'KSFoo'");
    expect(msg).toContain('already exists');
    expect(msg).toContain('Nothing changed on disk');
  });

  it('still reports the skip when the bridge gives no reason', () => {
    const msg = skippedMessage({ skipped: true }, 'thing');
    expect(msg).toContain('NOT written');
    expect(msg).toContain('no reason given');
  });
});

describe('bridge wrappers: a skip is never rendered as a write', () => {
  for (const { name, call } of SKIPPABLE) {
    it(`${name} reports skipped:true and does not say "added"`, async () => {
      const result = await call(bridgeReturning(SKIP));

      expect(result).not.toBeNull();
      // The call did not FAIL — nothing threw, nothing was rejected.
      expect(result!.success).toBe(true);
      // …but it did not write either, and the caller can now tell the difference.
      expect(result!.skipped).toBe(true);
      // The one word that made a no-op indistinguishable from a write.
      expect(result!.message).not.toContain('added');
      expect(result!.message).toContain('NOT written');
      // The bridge explained itself; that explanation must reach the caller.
      expect(result!.message).toContain("already binds table 'PurchTable'");
    });

    it(`${name} is unchanged on an ordinary write`, async () => {
      const result = await call(bridgeReturning(WROTE));

      expect(result!.success).toBe(true);
      expect(result!.skipped).toBe(false);
      expect(result!.message).toContain('✅');
      expect(result!.message).toContain('added');
      expect(result!.message).not.toContain('NOT written');
    });
  }
});

describe('add-field-group on a group that already exists', () => {
  // Table create writes AutoReport, AutoLookup, … so a follow-up add-field-group
  // AutoReport with fields finds the group there. A plain skip dropped the fields
  // the caller asked for; the missing ones now go into the existing group.
  const existingGroup = (alreadyIn: string[]) => {
    const addFieldToFieldGroup = vi.fn(async (_t: string, _g: string, field: string) =>
      alreadyIn.includes(field) ? { success: true, skipped: true, reason: 'already in group' } : { success: true });
    return {
      isReady: true,
      metadataAvailable: true,
      addFieldGroup: async () => ({ success: true, skipped: true, reason: "field group 'AutoReport' already exists" }),
      addFieldToFieldGroup,
    };
  };

  it('adds the requested fields that are not in it yet, and says which', async () => {
    const bridge = existingGroup(['Name']);
    const result = await bridgeAddFieldGroup(bridge as any, 'ConTable', 'AutoReport', undefined, ['Name', 'Amount']);

    expect(bridge.addFieldToFieldGroup).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ success: true });
    expect(result!.skipped).toBeFalsy();
    expect(result!.message).toContain('already existed — added Amount');
    expect(result!.message).toContain('Name already in it');
  });

  it('is a skip when every requested field is already in it', async () => {
    const result = await bridgeAddFieldGroup(existingGroup(['Name']) as any, 'ConTable', 'AutoReport', undefined, ['Name']);
    expect(result).toMatchObject({ success: true, skipped: true });
    expect(result!.message).toContain('NOT written');
  });
});
