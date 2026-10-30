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
 * Left alone when the parent is a string EDT (the default is already right), an
 * enum EDT (that needs its EnumType too, which neither resolver returns), or
 * cannot be resolved.
 */

import type { BridgeClient } from '../../bridge/bridgeClient.js';
import { bridgeEdtBaseType, resolveEdtBaseType } from '../smart/generateSmartTable.js';

export async function withEdtTypeFromExtends(
  properties: Record<string, unknown> | undefined,
  bridge: BridgeClient | undefined,
  db: unknown,
): Promise<Record<string, unknown> | undefined> {
  const parent = properties?.extends;
  if (typeof parent !== 'string' || !parent.trim() || properties?.edtType) return properties;

  const baseType =
    (await bridgeEdtBaseType(bridge, parent.trim())) ?? (db ? resolveEdtBaseType(parent.trim(), db) : undefined);
  if (!baseType || /^(string|enum)$/i.test(baseType)) return properties;

  return { ...properties, edtType: baseType };
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
