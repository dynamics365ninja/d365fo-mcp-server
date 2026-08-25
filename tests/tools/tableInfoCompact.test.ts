/**
 * The table reader's default is the CHEAP answer (audit 2026-08-25).
 *
 * VERIFIED LIVE: `get_object_info(objectType="table", name="CustTable")` returned
 * 20,199 chars — 50 fields, 20 indexes, all 75 relations in full and 25 methods
 * WITH their bodies — and `options:{compact:true}` returned a byte-identical
 * 20,199, because nothing on the table path ever read the flag. The class reader
 * answers the same question in 1,241 chars by being signature-only by default;
 * that is the shape copied here. get_object_info is the most-called tool in the
 * corpus (286 of 1,400 calls) and its result is re-read by every later request in
 * the session, so those bytes are paid many times over.
 *
 * The rule the tests pin: nothing is dropped silently. Whatever the default stops
 * printing, the response says exists and names the option that returns it.
 */

import { describe, it, expect } from 'vitest';
import { tryBridgeTable } from '../../src/bridge/bridgeAdapter';

const table = {
  name: 'CustTable',
  model: 'Foundation',
  fields: Array.from({ length: 8 }, (_, i) => ({ name: `Field${i}`, fieldType: 'String', mandatory: false })),
  indexes: [{ name: 'AccountIdx', allowDuplicates: false, fields: ['AccountNum'] }],
  relations: Array.from({ length: 75 }, (_, i) => ({
    name: `Rel${i}`,
    relatedTable: `Related${i}`,
    constraints: [{ field: `Field${i}`, relatedField: 'AccountNum' }],
  })),
  methods: [
    { name: 'validateWrite', source: 'public boolean validateWrite()\n{\n    boolean ret = super();\n    return ret;\n}' },
    { name: 'insert', source: '/// <summary>doc</summary>\npublic void insert()\n{\n    super();\n}' },
  ],
};

const fakeBridge = (t: unknown): any => ({ isReady: true, metadataAvailable: true, readTable: async () => t });

async function read(render?: Record<string, unknown>): Promise<string> {
  const res = await tryBridgeTable(fakeBridge(table), 'CustTable', 0, 0, undefined, render as any);
  return res!.content[0].text;
}

describe('table reader default', () => {
  it('prints method signatures, not bodies', async () => {
    const text = await read();
    expect(text).toContain('- `public boolean validateWrite()`');
    expect(text).not.toContain('```xpp');
    // …and the signature comes from the declaration, not the doc comment above it.
    expect(text).toContain('public void insert()');
    expect(text).not.toContain('/// <summary>');
  });

  it('withholds the relation list but says it exists and how to get it', async () => {
    const text = await read();
    expect(text).toContain('## Relations (75) — not listed');
    expect(text).toContain('"relations":true');
    expect(text).not.toContain('**Rel0**');
  });

  it('keeps fields and indexes, which are why a table is usually read', async () => {
    const text = await read();
    expect(text).toContain('**Field0**');
    expect(text).toContain('**AccountIdx**');
  });

  it('names the escape hatch for the withheld bodies', async () => {
    expect(await read()).toContain('"compact":false');
  });

  it('is dramatically smaller than the full form', async () => {
    const compact = await read();
    const full = await read({ compact: false });
    expect(compact.length).toBeLessThan(full.length / 2);
  });
});

describe('table reader options', () => {
  it('relations:true lists them with their constraints', async () => {
    const text = await read({ relations: true });
    expect(text).toContain('## Relations (75)');
    expect(text).toContain('**Rel0** → Related0');
    expect(text).toContain('Field0 = AccountNum');
    // …and still no bodies: relations and bodies are separate asks.
    expect(text).not.toContain('```xpp');
  });

  it('compact:false restores the old full output — bodies AND relations', async () => {
    const text = await read({ compact: false });
    expect(text).toContain('```xpp');
    expect(text).toContain('**Rel0** → Related0');
  });
});
