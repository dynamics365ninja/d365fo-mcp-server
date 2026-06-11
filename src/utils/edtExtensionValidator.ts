/**
 * EDT Extension Validator
 *
 * Enforces D365FO rules about what can and cannot be changed via an
 * AxEdtExtension. The XPP compiler / runtime silently accepts some edits
 * that the metadata system rejects — so we gate them up-front and explain
 * the proper alternative.
 *
 * Key rules (verified against Microsoft docs and SDK behaviour):
 *
 *   1. **StringSize** can only be modified on a *root* string EDT (one that
 *      does NOT have <Extends>). For derived EDTs, StringSize is inherited
 *      and must be widened by either:
 *        - deriving a new EDT from the inherited one with the larger size, or
 *        - using a table extension to point the field at a wider EDT.
 *
 *   2. **DisplayLength** follows the same inheritance rule as StringSize.
 *
 *   3. **Extends** cannot be changed on an extension — that would mean
 *      re-parenting the base EDT.
 *
 *   4. Most "annotation"-style properties (Label, HelpText, FormHelp,
 *      ConfigurationKey, HelpAlign, Alignment, NoOfDecimals on real,
 *      DecimalSeparator, SignDisplay) are always allowed on extensions
 *      regardless of whether the base EDT carries them itself.
 *
 *   5. The base EDT must be marked IsExtensible = true. Microsoft EDTs
 *      typically are; user-created EDTs default to false. We can only check
 *      this when the bridge is connected.
 */

import type { BridgeClient } from '../bridge/bridgeClient.js';
import type { BridgeEdtInfo } from '../bridge/bridgeTypes.js';

export interface EdtBaseInfo {
  edtName: string;
  /** Parent EDT name (Extends), or null/undefined when this is a root EDT. */
  extends?: string | null;
  /** Current string size (raw string from edt_metadata) — root EDTs only. */
  stringSize?: string | null;
  /**
   * Maximum size of the underlying SQL column (`<DatabaseStringSize>` in XML).
   * `-1` means unlimited (memo). When set and > 0, `StringSize` must not exceed it.
   * Inherited through the Extends chain when not specified locally.
   */
  databaseStringSize?: string | null;
  /** From bridge, when available; null/undefined when SQLite-only lookup. */
  isExtensible?: boolean | null;
}

export interface EdtExtensionValidationResult {
  ok: boolean;
  message?: string;
}

/** Properties that propagate from the root via inheritance and cannot be
 * overridden via an EDT extension at intermediate levels. */
const INHERITED_PROPERTIES = new Set(['stringsize', 'displaylength', 'databasestringsize']);

/** Properties that should never be set via an extension at all. */
const FORBIDDEN_EXT_PROPERTIES = new Set(['extends']);

/**
 * Parse an edt-extension objectName into its base EDT name.
 *
 * Convention: BaseEdtName.MyExtension or BaseEdtName_MyExtension.
 * If no separator is found, the input is returned as-is (assumed already a base name).
 */
export function extractBaseEdtName(extensionObjectName: string): string {
  if (!extensionObjectName) return extensionObjectName;
  const dotIdx = extensionObjectName.indexOf('.');
  if (dotIdx > 0) return extensionObjectName.substring(0, dotIdx);
  // Underscore convention: only treat as separator when right side looks like
  // an Extension token (case-insensitive) so we don't truncate normal EDT names.
  const usMatch = extensionObjectName.match(/^([A-Za-z][A-Za-z0-9]*?)_[A-Za-z0-9]*Extension$/);
  if (usMatch) return usMatch[1];
  return extensionObjectName;
}

/**
 * Look up the base EDT in the SQLite symbol index.
 * Returns null when the EDT is not indexed.
 *
 * When the same edt_name exists in multiple models (e.g. a model layered on
 * top of a Microsoft EDT), prefer the row that carries the most information
 * — specifically a non-null `extends` and a non-null `string_size`.
 * Otherwise we may falsely conclude that an EDT is a *root* (no Extends) and
 * permit a forbidden StringSize change via extension.
 */
export function lookupBaseEdtFromIndex(db: any, baseEdtName: string): EdtBaseInfo | null {
  if (!db || !baseEdtName) return null;
  try {
    const rows = db.prepare(`
      SELECT edt_name, extends, string_size, database_string_size
      FROM edt_metadata
      WHERE edt_name = ?
    `).all(baseEdtName) as Array<{
      edt_name: string; extends: string | null;
      string_size: string | null; database_string_size: string | null;
    }>;

    if (!rows || rows.length === 0) return null;

    // Pick the most informative row: non-null `extends` wins; tiebreak on non-null `string_size`.
    let pick = rows[0];
    for (const r of rows) {
      const pickHasExt = !!(pick.extends && pick.extends.trim().length > 0);
      const rHasExt = !!(r.extends && r.extends.trim().length > 0);
      if (rHasExt && !pickHasExt) { pick = r; continue; }
      if (rHasExt === pickHasExt) {
        const pickHasSize = !!(pick.string_size && pick.string_size.trim().length > 0);
        const rHasSize = !!(r.string_size && r.string_size.trim().length > 0);
        if (rHasSize && !pickHasSize) pick = r;
      }
    }

    return {
      edtName: pick.edt_name,
      extends: pick.extends,
      stringSize: pick.string_size,
      databaseStringSize: pick.database_string_size,
    };
  } catch {
    // Older DB schemas may lack `database_string_size`; fall back to a query without it.
    try {
      const rows = db.prepare(`
        SELECT edt_name, extends, string_size
        FROM edt_metadata
        WHERE edt_name = ?
      `).all(baseEdtName) as Array<{ edt_name: string; extends: string | null; string_size: string | null }>;
      if (!rows || rows.length === 0) return null;
      const pick = rows[0];
      return {
        edtName: pick.edt_name,
        extends: pick.extends,
        stringSize: pick.string_size,
      };
    } catch {
      return null;
    }
  }
}

/**
 * Resolve the *root* EDT in the inheritance chain starting at baseEdtName.
 *
 * Walks Extends pointers until we hit an EDT with no Extends. Returns the
 * full chain so callers can show "MyAccountNum → AccountNum → Num" hints.
 */
export function resolveEdtChain(db: any, baseEdtName: string, maxDepth = 16): EdtBaseInfo[] {
  const chain: EdtBaseInfo[] = [];
  const visited = new Set<string>();
  let current: string | null | undefined = baseEdtName;
  while (current && !visited.has(current.toLowerCase()) && chain.length < maxDepth) {
    visited.add(current.toLowerCase());
    const info = lookupBaseEdtFromIndex(db, current);
    if (!info) break;
    chain.push(info);
    current = info.extends;
  }
  return chain;
}

/**
 * Resolve the effective `DatabaseStringSize` for an EDT.
 *
 * `<DatabaseStringSize>` is inherited through the Extends chain just like
 * `<StringSize>`. We walk up until we find a non-null value; `-1` means the
 * underlying SQL column is unlimited (memo / nvarchar(max)).
 *
 * Returns:
 *   - a positive integer when the chain has an explicit size,
 *   - `-1` when any level in the chain says "unlimited",
 *   - `null` when nothing in the chain specifies it (caller should not block).
 */
export function resolveEffectiveDatabaseStringSize(
  db: any,
  baseEdtName: string,
  maxDepth = 16,
): number | null {
  const chain = db ? resolveEdtChain(db, baseEdtName, maxDepth) : [];
  for (const link of chain) {
    const raw = link.databaseStringSize;
    if (raw == null || String(raw).trim().length === 0) continue;
    const n = parseInt(String(raw), 10);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/**
 * Try to enrich base info with IsExtensible from the live bridge metadata.
 * Returns the same struct when bridge is unavailable or read fails.
 */
export async function enrichWithBridge(
  base: EdtBaseInfo,
  bridge: BridgeClient | undefined,
): Promise<EdtBaseInfo> {
  if (!bridge?.isReady || !bridge.metadataAvailable) return base;
  try {
    const live = (await bridge.readEdt(base.edtName)) as
      (BridgeEdtInfo & { isExtensible?: boolean; databaseStringSize?: number }) | null;
    if (!live) return base;
    return {
      ...base,
      extends: live.extends ?? base.extends,
      stringSize: live.stringSize != null ? String(live.stringSize) : base.stringSize,
      databaseStringSize: typeof live.databaseStringSize === 'number'
        ? String(live.databaseStringSize)
        : base.databaseStringSize,
      isExtensible: typeof live.isExtensible === 'boolean' ? live.isExtensible : base.isExtensible,
    };
  } catch {
    return base;
  }
}

/**
 * Core validation: can `propertyPath` be set to `propertyValue` on an
 * AxEdtExtension whose base EDT is `base`?
 *
 * `db` (optional) lets the validator walk the Extends chain to provide a
 * more informative message ("StringSize is inherited from AccountNum (root)").
 */
export function validateEdtExtensionProperty(
  base: EdtBaseInfo,
  propertyPath: string,
  propertyValue: string,
  db?: any,
): EdtExtensionValidationResult {
  const propLower = (propertyPath || '').trim().toLowerCase();

  // Hard refuse re-parenting via extension
  if (FORBIDDEN_EXT_PROPERTIES.has(propLower)) {
    return {
      ok: false,
      message:
        `⛔ Cannot change property '${propertyPath}' on an EDT extension.\n` +
        `Re-parenting (changing Extends) is not allowed via AxEdtExtension. ` +
        `Create a new EDT with the desired parent instead.`,
    };
  }

  // Inherited size properties: only allowed when base EDT is the root
  if (INHERITED_PROPERTIES.has(propLower)) {
    if (base.extends && base.extends.trim().length > 0) {
      const chain = db ? resolveEdtChain(db, base.edtName) : [base];
      const root = chain[chain.length - 1];
      const chainStr = chain.length > 1
        ? chain.map(c => c.edtName).join(' → ')
        : `${base.edtName} → ${base.extends}`;
      const rootSize = root?.stringSize ? ` (current ${propertyPath}: ${root.stringSize})` : '';
      return {
        ok: false,
        message:
          `⛔ Cannot modify '${propertyPath}' via AxEdtExtension on derived EDT '${base.edtName}'.\n\n` +
          `'${propertyPath}' is **inherited** through the Extends chain:\n` +
          `  ${chainStr}\n\n` +
          `Only the root EDT '${root?.edtName ?? '?'}'${rootSize} controls ${propertyPath}, and you cannot ` +
          `extend Microsoft's root EDTs to widen them. Use one of these approved patterns instead:\n\n` +
          `  • **Create a new EDT** that extends '${base.edtName}' with the desired ${propertyPath}, ` +
          `then point your field at the new EDT (table extension → modify-field → edt=NewEdt).\n` +
          `  • **Use a table extension** on the consuming field to override the size locally ` +
          `(modify-field with stringSize=...) — but watch databaseStringSize on existing data.\n\n` +
          `(For details see the X++ extension framework rules: StringSize/DisplayLength are not ` +
          `extension points on derived EDTs.)`,
      };
    }
    // Root EDT: still must be IsExtensible (when we know)
    if (base.isExtensible === false) {
      return {
        ok: false,
        message:
          `⛔ Cannot modify '${propertyPath}' on EDT '${base.edtName}' — base EDT is **not extensible** ` +
          `(IsExtensible = false). Microsoft has marked this EDT as closed to extension.\n` +
          `Create a new EDT extending '${base.edtName}' with the desired ${propertyPath} instead.`,
      };
    }
    // Cannot verify IsExtensible (no bridge / EDT not in live metadata).
    // Refuse rather than silently allow a change that may be a runtime no-op or
    // get rejected at compile time. The model can still proceed via the safe
    // alternative paths (create derived EDT or table-extension on the field).
    if (base.isExtensible == null) {
      return {
        ok: false,
        message:
          `⛔ Cannot verify whether EDT '${base.edtName}' is marked **IsExtensible = true**.\n` +
          `${propertyPath} can only be changed via AxEdtExtension when the base EDT explicitly opts in.\n\n` +
          `Use one of these safe alternatives instead:\n` +
          `  • **Create a new EDT** that extends '${base.edtName}' with the desired ${propertyPath}, ` +
          `then point your field at the new EDT (table extension → modify-field → edt=NewEdt).\n` +
          `  • **Use a table extension** on the consuming field to widen the size locally ` +
          `(modify-field with stringSize=...) — but watch databaseStringSize on existing data.\n\n` +
          `Re-run with a connected bridge to verify IsExtensible if you believe extension is permitted.`,
      };
    }
    // Defensive: refuse shrinking string size, which would corrupt existing data
    if (propLower === 'stringsize') {
      const newSize = parseInt(String(propertyValue), 10);
      const currentSize = base.stringSize ? parseInt(base.stringSize, 10) : NaN;
      if (Number.isFinite(newSize) && Number.isFinite(currentSize) && newSize < currentSize) {
        return {
          ok: false,
          message:
            `⛔ Refusing to shrink StringSize on '${base.edtName}' from ${currentSize} to ${newSize}. ` +
            `Decreasing StringSize via extension is unsupported and risks truncating existing column data.`,
        };
      }
      // Enforce the metadata invariant `StringSize <= DatabaseStringSize` (when known).
      // -1 means unlimited (memo / nvarchar(max)) and is always permissible.
      const dbSize = resolveEffectiveDatabaseStringSize(db, base.edtName);
      if (Number.isFinite(newSize) && dbSize != null && dbSize > 0 && newSize > dbSize) {
        return {
          ok: false,
          message:
            `⛔ Cannot widen StringSize on '${base.edtName}' to ${newSize}: it exceeds the ` +
            `effective DatabaseStringSize (${dbSize}) inherited from the EDT chain.\n\n` +
            `D365FO requires StringSize ≤ DatabaseStringSize so the SQL column can hold the value. ` +
            `Widening StringSize alone is silently capped at the DB size and risks runtime truncation.\n\n` +
            `Options:\n` +
            `  • First widen DatabaseStringSize on the same root EDT (modify-property propertyPath=DatabaseStringSize) ` +
            `to at least ${newSize} (or -1 for unlimited), then widen StringSize.\n` +
            `  • Or create a derived EDT extending '${base.edtName}' (which is allowed to lower StringSize ` +
            `but cannot exceed the inherited DatabaseStringSize) and base your field on it.`,
        };
      }
    }
    // Same invariant in the other direction: DatabaseStringSize must not be
    // shrunk below the current StringSize, which would orphan existing data.
    if (propLower === 'databasestringsize') {
      const newDb = parseInt(String(propertyValue), 10);
      const currentSize = base.stringSize ? parseInt(base.stringSize, 10) : NaN;
      if (Number.isFinite(newDb) && newDb !== -1 && newDb > 0 &&
          Number.isFinite(currentSize) && newDb < currentSize) {
        return {
          ok: false,
          message:
            `⛔ Cannot shrink DatabaseStringSize on '${base.edtName}' to ${newDb}: ` +
            `it would fall below the current StringSize (${currentSize}). ` +
            `D365FO requires StringSize ≤ DatabaseStringSize. ` +
            `Lower StringSize first, or set DatabaseStringSize to -1 (unlimited).`,
        };
      }
    }
  }

  // All other properties (Label, HelpText, FormHelp, ConfigurationKey, etc.)
  // are allowed regardless of inheritance.
  return { ok: true };
}

/**
 * Convenience wrapper: looks up the base EDT, enriches via bridge when
 * available, and runs validation. Use this from modify_d365fo_file.
 *
 * Returns `{ ok: true }` and lets the caller proceed if everything is fine.
 * Returns `{ ok: false, message }` to be relayed back to the model verbatim.
 */
export async function validateEdtExtensionChange(
  extensionObjectName: string,
  propertyPath: string,
  propertyValue: string,
  db: any,
  bridge: BridgeClient | undefined,
): Promise<EdtExtensionValidationResult> {
  const baseName = extractBaseEdtName(extensionObjectName);
  let base = lookupBaseEdtFromIndex(db, baseName);
  if (!base) {
    // Fall back to bridge-only lookup
    if (bridge?.isReady && bridge.metadataAvailable) {
      try {
        const live = (await bridge.readEdt(baseName)) as
          (BridgeEdtInfo & { isExtensible?: boolean; databaseStringSize?: number }) | null;
        if (live) {
          base = {
            edtName: live.name,
            extends: live.extends ?? null,
            stringSize: live.stringSize != null ? String(live.stringSize) : null,
            databaseStringSize: typeof live.databaseStringSize === 'number'
              ? String(live.databaseStringSize)
              : null,
            isExtensible: typeof live.isExtensible === 'boolean' ? live.isExtensible : null,
          };
        }
      } catch {
        /* ignore — fall through to "ok" so we don't block on a missing index */
      }
    }
  } else {
    base = await enrichWithBridge(base, bridge);
  }

  if (!base) {
    // We genuinely don't know whether this EDT is a root or a derived type.
    // For inherited size properties (StringSize/DisplayLength) and the
    // forbidden Extends property, refuse rather than passing through — the
    // bridge silently accepts illegal extension edits and the change becomes
    // an ineffective metadata modification.
    const propLower = (propertyPath || '').trim().toLowerCase();
    if (INHERITED_PROPERTIES.has(propLower) || FORBIDDEN_EXT_PROPERTIES.has(propLower)) {
      return {
        ok: false,
        message:
          `⛔ Cannot modify '${propertyPath}' on EDT extension '${extensionObjectName}' — ` +
          `base EDT '${baseName}' was not found in the symbol index or live metadata, ` +
          `so the validator cannot confirm whether the change is allowed.\n\n` +
          `${propertyPath} is **inheritance-controlled**: it can only be changed via AxEdtExtension on a ` +
          `*root* EDT marked IsExtensible = true. To stay safe, use one of these patterns instead:\n` +
          `  • **Create a new EDT** extending '${baseName}' with the desired ${propertyPath}, then ` +
          `point your field at it (table extension → modify-field → edt=NewEdt).\n` +
          `  • **Use a table extension** on the consuming field to override the size locally ` +
          `(watch databaseStringSize on existing data).\n\n` +
          `If you genuinely need to extend '${baseName}' directly, run update_symbol_index (and start ` +
          `the C# bridge) so the validator can verify Extends/IsExtensible.`,
      };
    }
    // Other properties (Label, HelpText, ...) are always safe — let through.
    return { ok: true };
  }

  return validateEdtExtensionProperty(base, propertyPath, propertyValue, db);
}
