/**
 * An EDT's base type comes from the EDT it extends.
 *
 * Without `edtType`, both writers wrote AxEdtString — so `extends: "AmountCur"`
 * gave a string EDT extending a real one. These cases pin which parents decide
 * the type and which leave the caller's properties alone. Parent names are
 * unique per case because bridgeEdtBaseType caches by name.
 */
import { describe, expect, it, vi } from 'vitest';
import { withEdtTypeFromExtends, bridgeEdtBaseTypeName } from '../../src/tools/write/edtBaseTypeFromExtends.js';
import { XmlTemplateGenerator } from '../../src/tools/xml/xmlTemplateGenerator.js';

const bridgeWith = (baseType: string | undefined) =>
  ({ isReady: true, readEdt: vi.fn(async () => (baseType ? { baseType } : null)) }) as any;

/** A symbol-index stand-in whose edt_metadata chain ends in a primitive. */
const dbWith = (
  rows: Record<string, { extends: string | null; enum_type?: string | null; string_size?: number | null }>,
) =>
  ({
    prepare: () => ({
      get: (name: string) => (rows[name] ? { enum_type: null, string_size: null, ...rows[name] } : undefined),
    }),
  }) as any;

describe('withEdtTypeFromExtends', () => {
  it('takes Real from a real parent via the bridge', async () => {
    const props = await withEdtTypeFromExtends({ extends: 'ParentReal1' }, bridgeWith('Real'), undefined);
    expect(props?.edtType).toBe('Real');
    expect(props?.extends).toBe('ParentReal1');
  });

  it('falls back to the symbol index when the bridge cannot say', async () => {
    const db = dbWith({ ParentDate1: { extends: 'Date' } });
    const props = await withEdtTypeFromExtends({ extends: 'ParentDate1' }, bridgeWith(undefined), db);
    expect(props?.edtType).toBe('Date');
  });

  it('keeps an explicit edtType', async () => {
    const props = { extends: 'ParentReal2', edtType: 'Int64' };
    await expect(withEdtTypeFromExtends(props, bridgeWith('Real'), undefined)).resolves.toBe(props);
  });

  it('leaves string and enum parents, and unresolved ones, to the writers', async () => {
    for (const [parent, bridge] of [
      ['ParentString1', bridgeWith('String')],
      ['ParentEnum1', bridgeWith('Enum')],
      ['ParentUnknown1', bridgeWith(undefined)],
    ] as const) {
      const props = { extends: parent };
      await expect(withEdtTypeFromExtends(props, bridge, undefined)).resolves.toBe(props);
    }
  });

  it('does nothing without extends', async () => {
    await expect(withEdtTypeFromExtends(undefined, bridgeWith('Real'), undefined)).resolves.toBeUndefined();
    const props = { label: '@X:Y' };
    await expect(withEdtTypeFromExtends(props, bridgeWith('Real'), undefined)).resolves.toBe(props);
  });

  it('gives the XML template a real EDT when there is no bridge', async () => {
    const db = dbWith({ ParentReal3: { extends: 'Real' } });
    const props = await withEdtTypeFromExtends({ extends: 'ParentReal3' }, undefined, db);
    const xml = XmlTemplateGenerator.generateAxEdtXml('MyRebateAmount', props);
    expect(xml).toContain('i:type="AxEdtReal"');
    expect(xml).not.toContain('<StringSize>');
  });
});

describe('bridgeEdtBaseTypeName', () => {
  it('strips the AxEdt prefix the bridge switch does not know', () => {
    expect(bridgeEdtBaseTypeName('AxEdtReal')).toBe('Real');
    expect(bridgeEdtBaseTypeName('AxEdtUtcDateTime')).toBe('UtcDateTime');
    expect(bridgeEdtBaseTypeName('axedtint64')).toBe('int64');
    expect(bridgeEdtBaseTypeName('Date')).toBe('Date');
    expect(bridgeEdtBaseTypeName(undefined)).toBeUndefined();
  });
});
