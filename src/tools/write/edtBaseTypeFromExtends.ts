/**
 * The base type of a new EDT, taken from the EDT it extends.
 *
 * Both writers default an EDT to AxEdtString when no `edtType` is given — the
 * bridge's CreateEdt (`default: AxEdtString`) and generateAxEdtXml. An EDT that
 * extends AmountCur, Percent or TransDate without restating the type was
 * therefore written as a STRING EDT with an <Extends> to a real or date one.
 * Every table field built on it then got the wrong field type, and the only fix
 * was overwriting the EDT and recreating the fields.
 *
 * A child EDT always has its parent's base type, so the parent decides it. Read
 * from the bridge first (it sees the compiled metadata), then the symbol index.
 * Left alone when the parent is a string EDT (the default is already right) or
 * cannot be resolved.
 *
 * An enum parent also decides the enum: every shipped child of an enum EDT is an
 * AxEdtEnum that states its own <EnumType>, equal to the parent's (1,512 of 1,512,
 * e.g. AgreementClassificationImmutable extends NoYesId with EnumType NoYes). So
 * `extends: "NoYesId"` gets edtType Enum AND enumType NoYes, and an explicit
 * edtType Enum without an enumType gets the parent's.
 */

import type { BridgeClient } from '../../bridge/bridgeClient.js';
import { bridgeEdtBaseType, resolveEdtBaseType, resolveEdtEnumType } from '../smart/generateSmartTable.js';

export async function withEdtTypeFromExtends(
  properties: Record<string, unknown> | undefined,
  bridge: BridgeClient | undefined,
  db: unknown,
): Promise<Record<string, unknown> | undefined> {
  const parent = properties?.extends;
  if (typeof parent !== 'string' || !parent.trim()) return properties;
  const name = parent.trim();
  const explicit = properties?.edtType;
  const explicitEnum = typeof explicit === 'string' && /^(axedt)?enum$/i.test(explicit);
  if (explicit && (!explicitEnum || properties?.enumType)) return properties;

  const enumType = await parentEnumType(name, bridge, db);
  if (enumType) return { ...properties, edtType: 'Enum', enumType };
  if (explicit) return properties;

  const baseType = (await bridgeEdtBaseType(bridge, name)) ?? (db ? resolveEdtBaseType(name, db) : undefined);
  if (!baseType || /^(string|enum)$/i.test(baseType)) return properties;

  return { ...properties, edtType: baseType };
}

/** The enum behind an enum EDT (or a chain ending in one), else undefined. */
async function parentEnumType(name: string, bridge: BridgeClient | undefined, db: unknown): Promise<string | undefined> {
  if (bridge?.isReady) {
    try {
      const info = await bridge.readEdt(name);
      if (info?.enumType) return info.enumType;
    } catch {
      // fall through to the index
    }
  }
  return db ? resolveEdtEnumType(name, db) : undefined;
}

/**
 * The bridge's CreateEdt switches on the lower-cased base type name (`real`,
 * `int`, `utcdatetime`, …) and treats anything else as a string. `edtType` may
 * also be given in the AxEdt* form the XML uses — `AxEdtReal` — which then fell
 * through to AxEdtString. Strip that prefix so both spellings reach the switch.
 */
export function bridgeEdtBaseTypeName(edtType: unknown): unknown {
  return typeof edtType === 'string' ? edtType.replace(/^AxEdt/i, '') : edtType;
}
