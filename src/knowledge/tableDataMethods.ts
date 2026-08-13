/**
 * The data methods every table inherits from `xRecord` / `Common`.
 *
 * Those are kernel types with no AOT metadata, and the symbol index stores
 * declared members only, so a table's `validateWrite` has no row anywhere.
 * prepare(mode="change") and get_method both reported that as "not found",
 * which reads as "the method does not exist" for the most common CoC target
 * there is and leaves the caller to invent the wrapper unaided.
 *
 * The contract below is the part a green build cannot teach — above all that
 * the pre-image is `this.orig()`, already in memory, so re-reading the row by
 * its own RecId is a database round trip per write AND a different value: the
 * current stored state rather than what this buffer was fetched with.
 *
 * A FALLBACK only: consulted when neither index, bridge nor XML declares the
 * method, so a table that overrides `insert()` still reports its own signature.
 */

export interface TableDataMethod {
  /** Canonical AOT spelling. */
  name: string;
  /** The declaration a CoC wrapper has to match exactly. */
  signature: string;
  /** Kernel type that declares it. */
  declaredOn: 'xRecord' | 'Common';
  /** What wrapping it is for, in one line. */
  purpose: string;
  /** Non-negotiables a green build will not teach. */
  contract: string[];
}

/**
 * The pre-image rule, on every method where a pre-image exists.
 *
 * Stated as a prohibition as well as an instruction: "use orig()" alone does not
 * dislodge a re-select the caller has already reasoned its way into.
 */
const PRE_IMAGE: string[] = [
  '`this.orig()` IS the pre-image — a buffer already in memory, filled when the record was fetched. ' +
  'Read the old value from it: `this.orig().MyField`.',
  'Do NOT re-read the row (`select … where x.RecId == this.RecId`, `MyTable::find(this.RecId)`). It costs a ' +
  'database round trip on every single write of the table, and it returns the CURRENT stored state, which ' +
  'inside a transaction is not the same thing as the values this buffer was fetched with.',
  'On an insert the pre-image is empty, so `this.orig().RecId == 0` is the test for "new record" — the same ' +
  'test the re-select spells as "the select found nothing".',
];

const NEXT_ONCE =
  '`next <method>()` must be reached exactly once and unconditionally — not inside an `if`, not after a ' +
  '`return`. The compiler rejects the alternative with SYS10028 (rule COC004).';

const VALIDATION_RETURN =
  'Report a failure by RETURNING false, not by throwing: `ret = checkFailed("@MyModel:MyLabel");` ' +
  '— checkFailed writes the message to the infolog and returns false, so every failed validation ' +
  'is presented at once. `checkFailed` is a Global function, never `this.checkFailed(…)` (rule COC005).';

/** Keyed by lower-cased method name. */
export const TABLE_DATA_METHODS: Record<string, TableDataMethod> = {
  validatewrite: {
    name: 'validateWrite',
    signature: 'public boolean validateWrite()',
    declaredOn: 'xRecord',
    purpose: 'Gate an insert or an update of the whole record; runs for UI and X++ writes alike.',
    contract: [...PRE_IMAGE, NEXT_ONCE, VALIDATION_RETURN],
  },
  validatefield: {
    name: 'validateField',
    signature: 'public boolean validateField(FieldId _fieldIdToCheck)',
    declaredOn: 'xRecord',
    purpose: 'Gate one field as it is modified, before validateWrite runs.',
    contract: [
      'Test which field you were called for: `if (_fieldIdToCheck == fieldNum(MyTable, MyField))`.',
      ...PRE_IMAGE,
      NEXT_ONCE,
      VALIDATION_RETURN,
    ],
  },
  validatedelete: {
    name: 'validateDelete',
    signature: 'public boolean validateDelete()',
    declaredOn: 'xRecord',
    purpose: 'Gate a delete.',
    contract: [
      'The buffer holds the record being deleted — no lookup is needed to see what is about to go.',
      NEXT_ONCE,
      VALIDATION_RETURN,
    ],
  },
  insert: {
    name: 'insert',
    signature: 'public void insert()',
    declaredOn: 'xRecord',
    purpose: 'Run logic around the physical insert of this buffer.',
    contract: [
      'There is no pre-image: `this.orig()` is an empty buffer and `this.RecId` is still 0 until next insert() returns.',
      'Validation belongs in validateWrite, which the framework calls first — insert() is for side effects.',
      NEXT_ONCE,
    ],
  },
  update: {
    name: 'update',
    signature: 'public void update()',
    declaredOn: 'xRecord',
    purpose: 'Run logic around the physical update of this buffer.',
    contract: [
      ...PRE_IMAGE,
      'Validation belongs in validateWrite, which the framework calls first — update() is for side effects.',
      NEXT_ONCE,
    ],
  },
  delete: {
    name: 'delete',
    signature: 'public void delete()',
    declaredOn: 'xRecord',
    purpose: 'Run logic around the physical delete of this buffer.',
    contract: [
      'The buffer still holds the record while the wrapper runs — read what you need before next delete().',
      NEXT_ONCE,
    ],
  },
  initvalue: {
    name: 'initValue',
    signature: 'public void initValue()',
    declaredOn: 'xRecord',
    purpose: 'Seed defaults on a new, not yet inserted record.',
    contract: [
      'Runs on a record that does not exist yet — there is nothing stored to read, and `this.orig()` is empty.',
      NEXT_ONCE,
    ],
  },
  modifiedfield: {
    name: 'modifiedField',
    signature: 'public void modifiedField(FieldId _fieldId)',
    declaredOn: 'xRecord',
    purpose: 'React to one field changing, typically to derive others.',
    contract: [
      'Test which field you were called for: `if (_fieldId == fieldNum(MyTable, MyField))`.',
      ...PRE_IMAGE,
      NEXT_ONCE,
    ],
  },
};

/** The inherited data method by that name, or undefined. Case-insensitive, as X++ is. */
export function lookupTableDataMethod(methodName: string): TableDataMethod | undefined {
  return TABLE_DATA_METHODS[methodName.trim().toLowerCase()];
}

/**
 * True for the object types this fallback speaks for.
 *
 * Tables only, deliberately. Views, maps and data entities descend from `Common`
 * too, but they do not all wrap through `tableStr` and not every one of these
 * methods fires on them — a fallback that guessed there would be inventing a
 * signature, which is the failure it exists to prevent.
 */
export function hasTableDataMethods(objectType: string | undefined): boolean {
  return objectType?.toLowerCase() === 'table';
}

/** The `### Method signature` body when only this fallback knows the method. */
export function renderTableDataMethodSignature(method: TableDataMethod, objectName: string): string {
  return [
    `Signature : ${method.signature}`,
    `ℹ️  Inherited — \`${objectName}\` does not declare \`${method.name}\`; every table gets it from ` +
    `\`${method.declaredOn}\`, a kernel type with no AOT metadata, which is why the symbol index has no row ` +
    `for it. The signature above is the one a CoC wrapper must match exactly.`,
  ].join('\n');
}

/** The `### CoC eligibility` body, plus the contract that is the reason this exists. */
export function renderTableDataMethodEligibility(method: TableDataMethod, objectName: string): string {
  return [
    `✅ CoC-eligible — \`[ExtensionOf(tableStr(${objectName}))] final class …\` wrapping ` +
    `\`${method.signature}\`.`,
    `_${method.purpose}_`,
    '',
    `**Contract for \`${method.name}\`:**`,
    ...method.contract.map(line => `- ${line}`),
  ].join('\n');
}
