/**
 * Kernel enums — enums the X++ runtime defines, with NO AOT metadata element.
 *
 * These are referenced by ordinary metadata (`<EnumType>NoYes</EnumType>` appears
 * 48 times in CustTable.xml alone, and EDT NoYesId reports `Enum Type: NoYes`)
 * but they have no `AxEnum/*.xml` anywhere, so no metadata-backed lookup can
 * ever prove them: not the C# bridge (`IMetadataProvider.Enums` does not carry
 * them), not the SQLite symbol index (it indexes AOT XML), not a disk probe.
 *
 * Treating "absent from the AOT" as "does not exist" produced two failures, both
 * confirmed live on 2026-08-24:
 *
 *   1. `validate_code(mode="references", codeType="xml-table")` reported
 *      `<EnumType>NoYes</EnumType>` as a hard ERROR — "Enum NoYes not found in
 *      the symbol index" — under "Fix errors before writing — these will cause
 *      compiler failures". An agent obeying that edits correct metadata, and
 *      `search` offers it NoYesBlank / DefaultNoYes / NoYesCombo to "correct" to.
 *      Those enums are real, so the result compiles clean and means the wrong
 *      thing.
 *   2. `get_object_info(objectType="enum", name="NoYes")` answered "not found via
 *      bridge, symbol index, or on disk" and advised searching other spellings,
 *      running update_symbol_index on `NoYes.xml`, and checking
 *      D365FO_CUSTOM_PACKAGES_PATH. None of that can ever succeed: there is no
 *      file to index. Meanwhile the EDT reader hands the agent the name `NoYes`
 *      in the first place — a loop with no exit.
 *
 * The X++ reference resolver already knew this (resolveReferences.ts allow-listed
 * 'noyes' and 'exception' for exactly this reason), which is why X++ using
 * `NoYes::Yes` validated cleanly while the XML path hard-errored on the same
 * enum. This module is that knowledge in one place, so the next path to need it
 * does not have to rediscover it.
 *
 * MEMBERSHIP IS EVIDENCE-BASED, not remembered: every name below was checked
 * against the complete set of 8,220 `AxEnum/*.xml` basenames in
 * K:\AosService\PackagesLocalDirectory (metamodel 7.0.7996.33) and is absent
 * from all of them.
 */

/** A kernel enum, and the value names it is used with. */
export interface KernelEnum {
  /** Canonical casing, for rendering. */
  name: string;
  /**
   * Value names as OBSERVED in shipped X++/metadata under
   * PackagesLocalDirectory. Deliberately not claimed to be exhaustive — it is
   * what the product itself uses. Omitted where a scan found no usage, rather
   * than filled in from memory.
   */
  values?: string[];
}

const ENTRIES: KernelEnum[] = [
  // By far the most common: boolean-ish fields reach it through EDT NoYesId.
  { name: 'NoYes', values: ['No', 'Yes'] },
  { name: 'Exception', values: [
    'Break', 'CLRError', 'CodeAccessSecurity', 'DDEerror', 'Deadlock',
    'DuplicateKeyException', 'DuplicateKeyExceptionNotRecovered', 'Error',
    'FunctionArgument', 'Info', 'Internal', 'Sequence', 'Timeout',
    'TransientSqlConnectionError', 'UpdateConflict',
    'UpdateConflictNotRecovered', 'ViewDataSourceValidation', 'Warning',
  ] },
  { name: 'Types', values: [
    'AnyType', 'Blob', 'Class', 'Container', 'Date', 'Enum', 'Guid', 'Int64',
    'Integer', 'List', 'RString', 'Real', 'Record', 'String', 'Time',
    'UserType', 'UtcDateTime', 'VarArg', 'VarString', 'Void',
  ] },
  // What Box::yesNo/confirm/okCancel answer with. Found by the knowledge audit,
  // which reported "DialogButton does not exist in the symbol index" for a topic
  // whose call shape had already compiled in an xppc probe — the same
  // absent-from-the-AOT-is-not-absent trap this module exists for. Values are the
  // ones shipped code actually uses, counted over 30,000 AxClass/AxForm files:
  // Yes 602, No 561, Cancel 154, Ok 129, YesToAll 7, NoToAll 6.
  { name: 'DialogButton', values: ['Cancel', 'No', 'NoToAll', 'Ok', 'Yes', 'YesToAll'] },
  // Added 2026-08-31 after an eval run tripped over AccessType and MenuItemType:
  // validate_code(mode="references") called both hard ERRORS on code that
  // compiles, and with GROUNDING_ENFORCE on it would have REFUSED the write —
  // the exact failure this module was created to prevent. That both were absent
  // was the signal that the list had never been derived from anything, so it is
  // now checked by `npm run oracle:kernel-enums`, which finds every `Name::Value`
  // in shipped X++ with no AOT element behind it. Values below are what the
  // product itself writes, counted by that audit, not recalled.
  { name: 'MenuItemType', values: ['Action', 'Display', 'Output'] },
  { name: 'AccessType', values: ['Add', 'Correction', 'Delete', 'Edit', 'NoAccess', 'View'] },
  { name: 'AccessRight', values: ['Add', 'Correction', 'Delete', 'Edit', 'NoAccess', 'View'] },
  { name: 'SortOrder', values: ['Ascending', 'Descending'] },
  // The argument to an `unchecked(...)` block. Only these two members exist —
  // DBSchemaDrift and Deadlock read plausibly and are not real (xppc-verified).
  { name: 'Uncheck', values: ['TableSecurityPermission', 'XDS'] },
  { name: 'TableScope', values: ['CurrentTableOnly', 'IncludeBaseTables', 'IncludeDerivedTables'] },
  { name: 'ConcurrencyModel', values: ['Auto', 'Optimistic', 'Pessimistic'] },
  { name: 'StatementType', values: ['Delete', 'Insert', 'Select', 'Update'] },
  // Real kernel enums with no usage in the packages scanned — listed without
  // values rather than with guessed ones.
  { name: 'IsolationLevel' },
  { name: 'UtcDateTimeOrder' },
  { name: 'DateOrder' },
  { name: 'DateDay' },
  { name: 'DateMonth' },
  { name: 'DateYear' },
];

const BY_LOWER = new Map<string, KernelEnum>(ENTRIES.map(e => [e.name.toLowerCase(), e]));

/** Lowercase names, for the allow-lists that already work in lowercase. */
export const KERNEL_ENUM_NAMES: ReadonlySet<string> = new Set(BY_LOWER.keys());

/** Is `name` an enum the runtime defines rather than the AOT? Case-insensitive. */
export function isKernelEnum(name: string | null | undefined): boolean {
  return !!name && BY_LOWER.has(name.trim().toLowerCase());
}

/** The entry for `name`, or undefined when it is not a kernel enum. */
export function getKernelEnum(name: string | null | undefined): KernelEnum | undefined {
  return name ? BY_LOWER.get(name.trim().toLowerCase()) : undefined;
}

/**
 * The answer a reader should give instead of "not found".
 *
 * States the one thing the caller has to know — there is nothing to index, and
 * references to it are valid — so the reply cannot be read as "this name is
 * wrong, go find the right one".
 */
export function describeKernelEnum(name: string): string | null {
  const entry = getKernelEnum(name);
  if (!entry) return null;

  const lines = [
    `# Enum: ${entry.name} (kernel enum)`,
    '',
    `\`${entry.name}\` is defined by the X++ runtime, not by an AOT element. There is no ` +
    `\`AxEnum/${entry.name}.xml\` in any package, so the bridge, the symbol index and a disk ` +
    `probe all correctly fail to find one — and there is nothing to index.`,
    '',
    `**It is valid to reference.** \`<EnumType>${entry.name}</EnumType>\` in metadata and ` +
    `\`${entry.name}::Value\` in X++ both compile. Do NOT substitute a similarly named AOT ` +
    `enum (for ${entry.name === 'NoYes' ? '`NoYes`, search offers `NoYesBlank`, `NoYesCombo`, `DefaultNoYes`' : 'example, a prefixed variant'}) — those are different types.`,
  ];

  if (entry.values?.length) {
    lines.push(
      '',
      '## Values',
      '',
      entry.values.map(v => `- \`${entry.name}::${v}\``).join('\n'),
      '',
      '_Value names as used by shipped X++ under PackagesLocalDirectory; the kernel is the ' +
      'authority, so treat the list as observed rather than exhaustive._',
    );
  }

  return lines.join('\n');
}
