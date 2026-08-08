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
 * Decide `<UseEnumValue>` and whether explicit `<Value>` elements may be emitted.
 *
 * The rule that used to be here read `properties.useEnumValue` alone, so an
 * enumValues[] carrying explicit `value:` numbers with no `useEnumValue` flag
 * produced UseEnumValue=No and every <Value> suppressed — the numbering the
 * caller asked for was gone, the file built clean, and X++ comparing the enum
 * against a stored int was quietly wrong.
 *
 * An explicit value is now honoured (useEnumValue is auto-set to Yes) rather
 * than dropped: it is an unambiguous statement of intent, and the alternative —
 * refusing — costs a round trip to say something the payload already said.
 *
 * Two cases are genuine contradictions and DO throw, because both readings write
 * something the caller did not ask for:
 *   • isExtensible + explicit values — xppc hard-rejects this
 *     ("UseEnumValue property must be set to 'No' when IsExtensible is True");
 *     an extensible enum is positional by construction.
 *   • useEnumValue:false + explicit values — the caller asked for both halves of
 *     a contradiction in one payload.
 *
 * "Explicit" here means a value that DIFFERS from the position the entry would
 * get anyway. Numbering an in-order list 0,1,2 states nothing the ordering does
 * not already state, so it is not treated as a conflict — otherwise a redundant
 * but harmless payload would start failing, extensible enums included.
 */
export function resolveEnumValueMode(
  enumName: string,
  properties: Record<string, any> | undefined,
  values: Array<{ name?: string; value?: number }>,
): { useEnumValue: 'Yes' | 'No'; suppressExplicitValues: boolean } {
  const isExtensible = Boolean(properties?.isExtensible);
  const offPositional = values
    .map((v, i) => ({ v, i }))
    .filter(({ v, i }) => typeof v.value === 'number' && v.value !== i);

  if (offPositional.length > 0) {
    const shown = offPositional
      .slice(0, 3)
      .map(({ v, i }) => `${v.name ?? `#${i}`}=${v.value}`)
      .join(', ');
    if (isExtensible) {
      throw new Error(
        `Enum '${enumName}': isExtensible=true cannot be combined with explicit enum values (${shown}) — ` +
        `nothing was written. An extensible enum must be UseEnumValue=No with NO <Value> elements ` +
        `(xppc: "UseEnumValue property must be set to 'No' when IsExtensible is True"), so the values ` +
        `would have been silently dropped. Drop the value: numbers and let position decide, or drop ` +
        `isExtensible if the numbering is what matters.`,
      );
    }
    if (properties?.useEnumValue === false) {
      throw new Error(
        `Enum '${enumName}': useEnumValue=false contradicts the explicit enum values (${shown}) — ` +
        `nothing was written. UseEnumValue=No means position decides the number, which would have ` +
        `discarded them. Pass either useEnumValue=true or values without value: numbers.`,
      );
    }
    return { useEnumValue: 'Yes', suppressExplicitValues: false };
  }

  // No caller-chosen numbering to preserve — the original rule stands.
  const useEnumValue: 'Yes' | 'No' = (isExtensible || properties?.useEnumValue === false)
    ? 'No'
    : (properties?.useEnumValue ? 'Yes' : 'No');
  return { useEnumValue, suppressExplicitValues: useEnumValue === 'No' };
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
