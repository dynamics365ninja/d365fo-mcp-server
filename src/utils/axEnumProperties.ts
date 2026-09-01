/**
 * Closed value sets for the enum-typed metadata properties the XML builders
 * write as raw text.
 *
 * Why this exists: the D365FO deserializer DROPS an element whose value is not a
 * member of the target enum — it does not fail. So `entityCategory:"Masters"`,
 * `cardinality:"OneToMany"` or `contextType:"Role"` were written verbatim, the
 * build stayed green, and the property silently took its default. Nothing
 * anywhere reported it. Validating here turns that into a refusal before a byte
 * is written.
 *
 * Every set below is the metamodel's own, read by reflection over
 * Microsoft.Dynamics.AX.Metadata[.Core].dll in PackagesLocalDirectory\bin — not
 * transcribed from documentation. Two of them contradicted what this repo had
 * been documenting: EntityCategory's member is `Parameters` (not `Parameter`)
 * and it also has `Configuration`.
 */

/** Microsoft.Dynamics.AX.Metadata.Core.MetaModel.EntityCategory */
export const ENTITY_CATEGORIES = [
  'Master', 'Configuration', 'Transaction', 'Reference', 'Document', 'Parameters',
] as const;

/** Microsoft.Dynamics.AX.Metadata.Core.MetaModel.Cardinality (relation, local side) */
export const RELATION_CARDINALITIES = [
  'NotSpecified', 'ZeroOne', 'ExactlyOne', 'ZeroMore', 'OneMore',
] as const;

/** Microsoft.Dynamics.AX.Metadata.Core.MetaModel.RelatedTableCardinality — a
 *  SMALLER set than Cardinality: the related side cannot be ZeroMore/OneMore. */
export const RELATED_TABLE_CARDINALITIES = [
  'NotSpecified', 'ZeroOne', 'ExactlyOne',
] as const;

/** Microsoft.Dynamics.AX.Metadata.Core.MetaModel.RelationshipType */
export const RELATIONSHIP_TYPES = [
  'NotSpecified', 'Association', 'Composition', 'Link', 'Specialization', 'Aggregation',
] as const;

/** Microsoft.Dynamics.AX.Metadata.Core.MetaModel.SecurityPolicyContextType */
export const SECURITY_POLICY_CONTEXT_TYPES = [
  'ContextString', 'RoleName', 'RoleProperty',
] as const;

/** Microsoft.Dynamics.AX.Metadata.Core.MetaModel.EntryPointType — the
 *  <ObjectType> of an AxSecurityEntryPointReference. */
export const SECURITY_ENTRY_POINT_TYPES = [
  'None', 'MenuItemDisplay', 'MenuItemOutput', 'MenuItemAction', 'ServiceOperation',
] as const;

/**
 * Decide `<UseEnumValue>` for an AxEnum. Explicit `<Value>` elements are ALWAYS
 * written for a member whose number is not 0.
 *
 * The rule this replaces suppressed every `<Value>` whenever the resolved mode
 * was UseEnumValue=No, on the premise that "plain 0,1,2 numbering states nothing
 * the order does not". THE PREMISE IS FALSE. An `<AxEnumValue>` with no `<Value>`
 * child is **0** — not "the next ordinal" — so a four-member ladder written that
 * way has every member equal to 0. It compiles with 0 errors, passes xppbp, and
 * looks right in a golden diff, while `enum2int()` returns 0 for every member.
 * Only the runtime oracle caught it (the 2026-08-31 capture run of
 * L3-enum-field-form-downgrade-guard: expected False, actual True, with
 * enum2int(cur) = enum2int(orig()) = 0 on a Gold row).
 *
 * Two oracles, because a claim about the compiler needs the compiler:
 *
 *   • A census of the 3,913 AxEnum files in PackagesLocalDirectory: of the 3,818
 *     with two or more members, exactly SIX omit `<Value>` everywhere, and all
 *     six are extensible. Zero non-extensible multi-member enums ship the
 *     all-zero shape. The shipped convention is the .NET one — omit the 0,
 *     spell out every other number — and 154 files pin numbers that positions
 *     would not give (AtlIntercompanyOrderType: PurchaseOrder=2, SalesOrder=1),
 *     which is only meaningful if `<Value>` is what decides.
 *   • xppc on this VM (fm-mcp, 2026-09-01), two probes in one build:
 *       - IsExtensible=true + UseEnumValue=No + explicit non-positional values
 *         → compiles clean. So `<Value>` is NOT forbidden on an extensible enum,
 *         and it does NOT "force UseEnumValue=Yes at compile time" as the
 *         knowledge entry claimed.
 *       - IsExtensible=true + UseEnumValue=Yes (the negative control)
 *         → "UseEnumValue property must be set to 'No' when the IsExtensible
 *           property is 'True'". The probe discriminates; the rule below is the
 *         half that is real.
 *
 * So there is exactly ONE contradiction left to refuse: isExtensible together
 * with useEnumValue:true, which is the combination xppc names. Explicit values
 * with either setting are written, not dropped and not refused.
 */
export function resolveEnumValueMode(
  enumName: string,
  properties: Record<string, any> | undefined,
  values: Array<{ name?: string; value?: number }>,
): { useEnumValue: 'Yes' | 'No' } {
  const isExtensible = Boolean(properties?.isExtensible);

  if (isExtensible && properties?.useEnumValue === true) {
    throw new Error(
      `Enum '${enumName}': isExtensible=true cannot be combined with useEnumValue=true — nothing was ` +
      `written. xppc refuses it outright: "UseEnumValue property must be set to 'No' when the ` +
      `IsExtensible property is 'True'". Drop useEnumValue — an extensible enum is written with ` +
      `UseEnumValue=No, and its explicit <Value> numbers are kept either way.`,
    );
  }

  if (isExtensible || properties?.useEnumValue === false) return { useEnumValue: 'No' };
  if (properties?.useEnumValue) return { useEnumValue: 'Yes' };

  // A number that DIFFERS from the entry's position is an unambiguous statement
  // that the numbering matters, and UseEnumValue=Yes is how the metadata says so.
  // Numbering an in-order list 0,1,2 states nothing extra, so it does not flip the
  // mode — which keeps the mode of a plain payload where it was. (What changed is
  // that the numbers are now WRITTEN in both modes: the mode chooses how the
  // metadata describes itself, never whether a member keeps its value.)
  const offPositional = values.some((v, i) => typeof v.value === 'number' && v.value !== i);
  return { useEnumValue: offPositional ? 'Yes' : 'No' };
}

/**
 * Canonicalize `value` against `allowed` (case-insensitively, the way
 * Enum.TryParse(…, ignoreCase: true) does on the C# side) and throw naming the
 * whole set when it is not a member. Returns `fallback` for an absent value, so
 * a property that is optional stays optional.
 */
export function assertKnownEnumValue(
  propertyName: string,
  value: unknown,
  allowed: readonly string[],
  fallback: string,
): string {
  if (value === undefined || value === null || value === '') return fallback;
  const raw = String(value).trim();
  if (!raw) return fallback;
  const match = allowed.find(a => a.toLowerCase() === raw.toLowerCase());
  if (match) return match;
  throw new Error(
    `${propertyName}: "${raw}" is not a valid value — nothing was written. ` +
    `Valid values: ${allowed.join(' | ')}. ` +
    `(D365FO drops an unknown value on deserialization, so writing it would build clean ` +
    `with ${propertyName} silently left at its default.)`,
  );
}
