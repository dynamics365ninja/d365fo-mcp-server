/**
 * Reported 2026-08-27: `get_object_info(objectType="edt", name="ItemFreeTxt")` answered
 * StringSize 10. The real size is 1000, inherited from ItemFreeTxtBase.
 *
 * Root cause: IMetadataProvider hands back an EDT exactly as its own XML declares it and does
 * not fill in what it inherits. When a derived string EDT declares no StringSize, the instance
 * reports the AxEdtString constructor default of 10. Verified against 10.0.2645: ItemFreeTxt
 * read back as 10 (really 1000), ItemId and CustAccount as 10 (really 20), and 310 of 564
 * string fields across ten core tables carried the same wrong number.
 *
 * What is NOT true — an earlier revision of this fix claimed it, on the strength of a
 * validation-message identifier alone — is that a child EDT cannot declare StringSize. The
 * message reads in full "StringSize cannot be set on child edt when StringSizeIsExtensible is
 * not set to Yes", i.e. the prohibition is conditional, and 228 derived EDTs in the shipped
 * corpus do declare their own size (InvoiceId declares 50 over Num's 20). A declared value is
 * therefore authoritative and must survive.
 *
 * Nor does a declared size always win. Measured over the 182 derived EDTs that declare a size
 * and have a declaring ancestor:
 *   - StringSizeIsExtensible = Yes -> the declaration wins in either direction (InvoiceId 50
 *     over Num's 20; CustInvoiceId 20 under InvoiceId's 50).
 *   - Otherwise, a declared value SMALLER than the nearest declaring ancestor's loses to it.
 *     Four EDTs corpus-wide: PartyName declares 100 under DirPartyName's 160 and is 160, plus
 *     ITMJourneyId, TAMRebateInvoice, PSNPurchasingCardProviderName.
 *   - Otherwise, a declared value LARGER than the ancestor's: no such EDT ships, so the
 *     behaviour is unverified and nothing here assumes it.
 *
 * And `ResolveVirtualProperties`' isFlightEnabled flag matters. With true, CustInvoiceId reads
 * 50 at EDT level while the field-level resolver says 20 for CustInvoiceJour.InvoiceId, typed
 * with that same EDT. The bridge passes false so the two agree at 20.
 *
 * All of the above comes from the metamodel resolvers, which is the source the compiler uses
 * but not an independent oracle; none of it was cross-checked against live SQL column widths.
 *
 * These tests cover the two Node-side halves: rendering the value with its provenance, and
 * resolving the chain in the SQLite fallback that answers when the bridge is absent.
 */

import { describe, it, expect, vi } from 'vitest';
import Database from '../../src/database/sqlite.js';
import { getEdtInfoTool } from '../../src/tools/readers/edtInfo';

function makeDb(rows: Array<{ name: string; extends?: string; stringSize?: string }>) {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE edt_metadata (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      edt_name TEXT NOT NULL, extends TEXT, enum_type TEXT, reference_table TEXT,
      relation_type TEXT, string_size TEXT, database_string_size TEXT,
      display_length TEXT, label TEXT, model TEXT NOT NULL
    );
    CREATE INDEX idx_edt_metadata_name ON edt_metadata(edt_name);
    CREATE TABLE symbols (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL, type TEXT NOT NULL, parent_name TEXT,
      signature TEXT, file_path TEXT, model TEXT, description TEXT, extends_class TEXT
    );
    CREATE INDEX idx_name_type ON symbols(name, type);
    CREATE VIRTUAL TABLE symbols_fts USING fts5(name, type, parent_name, signature, description, tags);
  `);
  const insEdt = db.prepare(
    `INSERT INTO edt_metadata (edt_name, extends, string_size, model) VALUES (?, ?, ?, 'Foundation')`,
  );
  for (const r of rows) insEdt.run(r.name, r.extends ?? null, r.stringSize ?? null);
  return db;
}

const req = (edtName: string) => ({
  method: 'tools/call' as const,
  params: { name: 'get_edt_info', arguments: { edtName } },
});

/** Context whose bridge answers with the given payload (null = bridge has no data). */
function ctx(db: any, bridgeEdt: any) {
  return {
    symbolIndex: { getReadDb: () => db },
    bridge: { isReady: true, metadataAvailable: true, readEdt: vi.fn(async () => bridgeEdt) },
  } as any;
}

const text = (r: any) => r.content[0].text as string;

describe('EDT StringSize inheritance — bridge path', () => {
  it('reports the inherited size and names the EDT it came from', async () => {
    const result = await getEdtInfoTool(
      req('ItemFreeTxt'),
      ctx(makeDb([]), {
        name: 'ItemFreeTxt',
        baseType: 'String',
        extends: 'ItemFreeTxtBase',
        rootEdt: 'ItemFreeTxtBase',
        stringSize: 1000,
        stringSizeInheritedFrom: 'ItemFreeTxtBase',
        model: 'Foundation',
      }),
    );

    const out = text(result);
    expect(out).toContain('| String Size | 1000 (inherited from ItemFreeTxtBase) |');
    // The old answer must not survive anywhere in the report.
    expect(out).not.toContain('| String Size | 10 |');
  });

  it('names the declaring ancestor, not the immediate parent, on a multi-level chain', async () => {
    // AccountNumber_IN -> CustVendAC -> ExternalAccount(20). Only the last declares a size.
    const result = await getEdtInfoTool(
      req('AccountNumber_IN'),
      ctx(makeDb([]), {
        name: 'AccountNumber_IN',
        baseType: 'String',
        extends: 'CustVendAC',
        rootEdt: 'ExternalAccount',
        stringSize: 20,
        stringSizeInheritedFrom: 'ExternalAccount',
      }),
    );

    const out = text(result);
    expect(out).toContain('| Root EDT | ExternalAccount |');
    expect(out).toContain('| String Size | 20 (inherited from ExternalAccount) |');
  });

  it("claims no inheritance when the derived EDT declares its own size", async () => {
    // InvoiceId declares 50 over Num's 20 — permitted, because Num is extensible. The number
    // is the EDT's own, so it must not be labelled as inherited from anywhere.
    const result = await getEdtInfoTool(
      req('InvoiceId'),
      ctx(makeDb([]), {
        name: 'InvoiceId',
        baseType: 'String',
        extends: 'Num',
        rootEdt: 'Num',
        stringSize: 50,
      }),
    );

    const out = text(result);
    expect(out).toContain('| String Size | 50 |');
    expect(out).not.toContain('inherited from');
  });

  it("labels a value an ancestor overrode", async () => {
    // PartyName declares 100 but is not StringSizeIsExtensible, and its base DirPartyName
    // declares 160, so the base's value is the effective one.
    const result = await getEdtInfoTool(
      req('PartyName'),
      ctx(makeDb([]), {
        name: 'PartyName',
        baseType: 'String',
        extends: 'DirPartyName',
        rootEdt: 'DirPartyName',
        stringSize: 160,
        stringSizeInheritedFrom: 'DirPartyName',
      }),
    );

    expect(text(result)).toContain('| String Size | 160 (inherited from DirPartyName) |');
  });

  it('claims no inheritance for a root EDT, and spells out the memo sentinel', async () => {
    const result = await getEdtInfoTool(
      req('Notes'),
      ctx(makeDb([]), { name: 'Notes', baseType: 'String', stringSize: -1 }),
    );

    const out = text(result);
    expect(out).toContain('| String Size | -1 (memo, unlimited) |');
    expect(out).not.toContain('inherited from');
    expect(out).not.toContain('| Root EDT |');
  });
});

describe('EDT StringSize inheritance — SQLite fallback path', () => {
  it('walks extends to the declaring ancestor instead of omitting String Size', async () => {
    const db = makeDb([
      { name: 'ItemFreeTxt', extends: 'ItemFreeTxtBase' },
      { name: 'ItemFreeTxtBase', stringSize: '1000' },
    ]);

    const out = text(await getEdtInfoTool(req('ItemFreeTxt'), ctx(db, null)));
    expect(out).toContain('| String Size | 1000 (inherited from ItemFreeTxtBase) |');
  });

  it('skips ancestors that declare no size of their own', async () => {
    const db = makeDb([
      { name: 'AccountNumber_IN', extends: 'CustVendAC' },
      { name: 'CustVendAC', extends: 'ExternalAccount' },
      { name: 'ExternalAccount', stringSize: '20' },
    ]);

    const out = text(await getEdtInfoTool(req('AccountNumber_IN'), ctx(db, null)));
    expect(out).toContain('| String Size | 20 (inherited from ExternalAccount) |');
  });

  it('stops at the NEAREST declaring ancestor, not the root', async () => {
    // CorrectedInvoiceId_RU -> InvoiceId(50) -> Num(20). The real size is 50; taking the root
    // would report 20.
    const db = makeDb([
      { name: 'CorrectedInvoiceId_RU', extends: 'InvoiceId' },
      { name: 'InvoiceId', extends: 'Num', stringSize: '50' },
      { name: 'Num', stringSize: '20' },
    ]);

    const out = text(await getEdtInfoTool(req('CorrectedInvoiceId_RU'), ctx(db, null)));
    expect(out).toContain('| String Size | 50 (inherited from InvoiceId) |');
    expect(out).not.toContain('inherited from Num');
  });

  it('keeps a size the derived EDT declares for itself', async () => {
    // 228 shipped derived EDTs declare their own size; InvoiceId declares 50 over Num's 20.
    const db = makeDb([
      { name: 'Num', stringSize: '20' },
      { name: 'InvoiceId', extends: 'Num', stringSize: '50' },
    ]);

    const out = text(await getEdtInfoTool(req('InvoiceId'), ctx(db, null)));
    expect(out).toContain('| String Size | 50 |');
    expect(out).not.toContain('inherited from');
  });

  it('says nothing rather than guessing when the chain dangles', async () => {
    // AmountMST names MoneyMST in its Extends, and no AxEdt file ships for MoneyMST.
    const db = makeDb([{ name: 'AmountMST', extends: 'MoneyMST' }]);

    const out = text(await getEdtInfoTool(req('AmountMST'), ctx(db, null)));
    expect(out).not.toContain('| String Size |');
  });

  it('terminates on a cyclic extends chain', async () => {
    const db = makeDb([
      { name: 'LoopA', extends: 'LoopB' },
      { name: 'LoopB', extends: 'LoopA' },
    ]);

    const out = text(await getEdtInfoTool(req('LoopA'), ctx(db, null)));
    expect(out).not.toContain('| String Size |');
  });
});
