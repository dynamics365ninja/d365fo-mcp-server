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
  /**
   * Can a Chain of Command wrapper actually take effect here?
   *
   * `false` is the dangerous case and the reason this field exists: the four
   * `aosValidate*` methods accept a wrapper, COMPILE, and then never run it —
   * xppc says so in a WARNING ("Chain of command is not supported on method
   * 'aosValidateInsert' because it is internal or marked as InternalUseOnly")
   * and a warning in a build log of thousands of lines is not a message anyone
   * reads. The developer ships a validation that silently does nothing.
   *
   * Defaults to true; only the refusals carry it.
   */
  cocEligible?: boolean;
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

/**
 * The refusal text for a method CoC compiles and then ignores.
 *
 * Verified 2026-09-02 with real wrappers on CustGroup
 * (scripts/oracles/probes/coverage-v4d.ts, family B): all four compile, all four
 * warn, and the warning is the only evidence.
 */
const AOS_VALIDATE_REFUSAL: string[] = [
  '🚨 A CoC wrapper here COMPILES AND NEVER RUNS. xppc answers with a WARNING — "Chain of command is ' +
  'not supported on method \'aosValidateInsert\' because it is internal or marked as InternalUseOnly" — ' +
  'and then builds the model. Nothing fails, and the validation silently does nothing.',
  'These run on the AOS tier as a last line of defence before the physical write, and the platform ' +
  'reserves them. Put the rule in `validateWrite` instead, which is where the framework expects it and ' +
  'where a wrapper is honoured.',
  'If you genuinely need a server-tier check that cannot be bypassed, the supported route is a table ' +
  'method on your OWN table, not a wrapper on someone else\'s.',
];

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
  modifiedfieldvalue: {
    name: 'modifiedFieldValue',
    signature: 'public void modifiedFieldValue(FieldName _fieldName, int _value)',
    declaredOn: 'xRecord',
    purpose: 'React to a field changing, addressed by NAME rather than by id — the form-driven twin of modifiedField.',
    contract: [
      '⚠️ The signature is NOT the one modifiedField uses, and getting it wrong is a compile error that ' +
      'names the fix: parameter 1 is a **FieldName (a str)**, parameter 2 is an **int**. Writing ' +
      '`(FieldId, anytype)` — the obvious guess, by analogy with modifiedField — is refused with ' +
      '"parameter \'1\' must be of type \'str(FieldName)\' instead of \'int(FieldId)\'".',
      'Compare against the name: `if (_fieldName == fieldStr(MyTable, MyField))`, not fieldNum.',
      ...PRE_IMAGE,
      NEXT_ONCE,
    ],
  },
  postload: {
    name: 'postLoad',
    signature: 'public void postLoad()',
    declaredOn: 'xRecord',
    purpose: 'Run after a record has been read from the database — the place to derive unstored state.',
    contract: [
      'Runs on EVERY row fetched, including inside a `while select` over thousands. Anything expensive ' +
      'here is paid per row, and it is the classic way a report goes from seconds to minutes.',
      'The buffer is fully populated when it runs; `this.orig()` is not meaningful, because nothing has ' +
      'been modified yet.',
      NEXT_ONCE,
    ],
  },
  defaultrow: {
    name: 'defaultRow',
    signature: 'public void defaultRow()',
    declaredOn: 'xRecord',
    purpose: 'Seed a new row from the current context — called by the form framework, unlike initValue.',
    contract: [
      'initValue() is the one to wrap for defaults that always apply; defaultRow() is the form-driven ' +
      'companion and does not run for a plain X++ insert.',
      NEXT_ONCE,
    ],
  },
  defaultfield: {
    name: 'defaultField',
    signature: 'public void defaultField(FieldId _fieldId)',
    declaredOn: 'xRecord',
    purpose: 'Seed ONE field from context, per field rather than per row.',
    contract: [
      'Test which field you were called for: `if (_fieldId == fieldNum(MyTable, MyField))`.',
      NEXT_ONCE,
    ],
  },
  tooltipfield: {
    name: 'toolTipField',
    signature: 'public str toolTipField(fieldId _fieldId)',
    declaredOn: 'xRecord',
    purpose: 'The tooltip a form shows for one field of this record.',
    contract: [
      'Returns a STRING that is shown to a user, so it must be a resolved label — `strFmt("@MyModel:MyLabel", …)`, ' +
      'never raw text (BPErrorLabelIsText).',
      'Called on hover, i.e. often. Keep it free of database access.',
      NEXT_ONCE,
    ],
  },
  helpfield: {
    name: 'helpField',
    signature: 'public str helpField(fieldId _fieldId)',
    declaredOn: 'xRecord',
    purpose: 'The status-bar help text for one field of this record.',
    contract: [
      'Same rules as toolTipField: a resolved label, and no database access on a per-hover path.',
      NEXT_ONCE,
    ],
  },
  caption: {
    name: 'caption',
    signature: 'public str caption()',
    declaredOn: 'xRecord',
    purpose: 'The record\'s own caption — what a form title or a lookup shows for this row.',
    contract: [
      'Returns a string shown to a user: label, not raw text.',
      'The default is built from the table\'s TitleField1/TitleField2 properties. Setting those is usually ' +
      'the better answer than wrapping this.',
      NEXT_ONCE,
    ],
  },
  aosvalidateinsert: {
    name: 'aosValidateInsert',
    signature: 'public boolean aosValidateInsert()',
    declaredOn: 'xRecord',
    purpose: 'Server-tier check immediately before a physical insert — reserved by the platform.',
    contract: AOS_VALIDATE_REFUSAL,
    cocEligible: false,
  },
  aosvalidateupdate: {
    name: 'aosValidateUpdate',
    signature: 'public boolean aosValidateUpdate()',
    declaredOn: 'xRecord',
    purpose: 'Server-tier check immediately before a physical update — reserved by the platform.',
    contract: AOS_VALIDATE_REFUSAL,
    cocEligible: false,
  },
  aosvalidatedelete: {
    name: 'aosValidateDelete',
    signature: 'public boolean aosValidateDelete()',
    declaredOn: 'xRecord',
    purpose: 'Server-tier check immediately before a physical delete — reserved by the platform.',
    contract: AOS_VALIDATE_REFUSAL,
    cocEligible: false,
  },
  aosvalidateread: {
    name: 'aosValidateRead',
    signature: 'public boolean aosValidateRead()',
    declaredOn: 'xRecord',
    purpose: 'Server-tier check on a read — reserved by the platform.',
    contract: AOS_VALIDATE_REFUSAL,
    cocEligible: false,
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

/**
 * The `### CoC eligibility` body, plus the contract that is the reason this exists.
 *
 * A ✅ and a 🚫 answer opposite questions and must not share a template. The
 * refusals are the whole point of `cocEligible`: those four methods accept a
 * wrapper and compile, so an eligibility section that said "✅ CoC-eligible"
 * would be literally true of the build and completely wrong about the outcome.
 */
export function renderTableDataMethodEligibility(method: TableDataMethod, objectName: string): string {
  if (method.cocEligible === false) {
    return [
      `🚫 **NOT CoC-eligible** — a wrapper on \`${method.name}\` compiles and then never runs.`,
      `_${method.purpose}_`,
      '',
      `**Why, and what to do instead:**`,
      ...method.contract.map(line => `- ${line}`),
    ].join('\n');
  }
  return [
    `✅ CoC-eligible — \`[ExtensionOf(tableStr(${objectName}))] final class …\` wrapping ` +
    `\`${method.signature}\`.`,
    `_${method.purpose}_`,
    '',
    `**Contract for \`${method.name}\`:**`,
    ...method.contract.map(line => `- ${line}`),
  ].join('\n');
}
