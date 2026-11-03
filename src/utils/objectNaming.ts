/**
 * The on-disk name an object type + caller-supplied name resolves to.
 *
 * This lived inside create_d365fo_file as ninety lines of inline cases, which
 * meant `create` and `modify` disagreed about what an object is called.
 * `create` turns `{objectType: "table-extension", objectName: "PurchTable"}`
 * into `PurchTable.CtsoExtension` and writes that file; `modify` given the same
 * two arguments looked for a file literally named `PurchTable`, missed, and
 * answered "File not found for table-extension" — one call after `create` had
 * printed the path. The caller then had to pass `filePath` by hand, three times
 * in the session that surfaced this.
 *
 * Same inputs, same name, one implementation.
 */

import {
  resolveObjectPrefix,
  applyObjectPrefix,
  applyObjectSuffix,
  deriveExtensionInfix,
  getObjectSuffix,
  getExtensionNamingStyle,
  getExtensionClassNamingStyle,
  endsWithInfix,
  inferBaseBeforeToken,
  isAsGivenNamingMode,
} from './modelClassifier.js';
import { normalizeModelToken } from './modelToken.js';
import {
  classFormatFor,
  classFormatsActive,
  elementFormatActive,
  extensionNameFormatProblems,
  formatClassExtensionName,
  formatElementExtensionName,
  normalizeExtensionBaseType,
  readClassExtensionName,
  ELEMENT_FORMAT_ENV,
  UNDEFINED_FORMAT_ENV,
} from './extensionNameFormat.js';

/**
 * Extension types whose AOT name is `Base.{Token}Extension`. A bare base name
 * for one of these has to grow the dot before prefixing, or applyObjectPrefix
 * reads it as a brand-new object and produces `CtsoPurchTable`.
 */
export const DOT_NOTATION_EXTENSION_TYPES: ReadonlySet<string> = new Set([
  'table-extension', 'form-extension', 'enum-extension', 'edt-extension',
  'data-entity-extension', 'menu-item-display-extension', 'menu-item-action-extension',
  'menu-item-output-extension', 'menu-extension',
  'security-duty-extension', 'security-role-extension',
]);

/**
 * Index types a CoC class can extend. Scopes inferExtendedBase's lookups, so a
 * candidate also spelled by thousands of method/field rows stays a cheap probe.
 */
export const COC_BASE_SYMBOL_TYPES: readonly string[] = ['class', 'table', 'form', 'view', 'query', 'data-entity', 'map'];

/**
 * The base a `{Base}{Token}{Feature}_Extension` class name extends, for a caller
 * with no `[ExtensionOf]` to read it from — prepare and validate_object_naming
 * predict names before any source exists. The writer reads the base from the
 * attribute; these read it from the index, so all three name the same class.
 * Undefined for any other shape, or when no known object precedes the token.
 */
export function inferExtendedBase(
  objectName: string,
  modelName: string | undefined,
  isKnownObject: (name: string) => boolean,
): string | undefined {
  // A dotted name is an element extension (CustTable.MY_Extension), never a class.
  if (!objectName.endsWith('_Extension') || objectName.includes('.')) return undefined;
  // Under class formats the name states its base through the format, and only
  // through it: the index is not asked, so the local companion (empty index) and
  // the shared server (full index) read the same base from the same name.
  if (classFormatsActive()) return readClassExtensionName(objectName)[0]?.base;
  const stem = objectName.slice(0, -'_Extension'.length);
  const prefix = resolveObjectPrefix(modelName ?? '');
  const infix = prefix ? deriveExtensionInfix(prefix, modelName) : '';
  const modelToken = modelName ? normalizeModelToken(modelName) : '';
  return inferBaseBeforeToken(stem, [infix, modelToken, prefix], isKnownObject);
}

export function isExtensionObjectType(objectType: string): boolean {
  return objectType === 'class-extension' || DOT_NOTATION_EXTENSION_TYPES.has(objectType);
}

/**
 * Strip an element-style "Extension" word — and the infix or model token in front
 * of it — off a class-extension name, leaving the base class.
 *
 * `Base.CtsoExtension` is how the dot-notation types spell it, so a caller writes
 * a CoC class the same way: `Base_CtsoExtension`. Only the `_Extension` form was
 * recognised, so that name read as a brand-new base class and grew a SECOND
 * suffix — `Base_CtsoExtensionCtso_Extension`. Returns `name` unchanged when
 * there is no "Extension" word, or when stripping would leave nothing.
 */
function stripElementStyleExtensionWord(name: string, tokens: readonly string[]): string {
  if (!/extension$/i.test(name)) return name;
  let base = name.slice(0, -'Extension'.length);
  // Infix first: the token that would be re-applied is the one to take off, and
  // for most models these are all the same string anyway.
  for (const token of tokens) {
    // As its own word only: "SalesTableExtension" under infix "Le" is the base
    // SalesTable, not SalesTab.
    if (token && endsWithInfix(base, token)) {
      base = base.slice(0, -token.length);
      break;
    }
  }
  base = base.replace(/_+$/, '');
  return base || name;
}

/**
 * Normalise `objectName` for `objectType` under the active naming style.
 *
 * Idempotent: an already-normalised name comes back unchanged, so callers may
 * apply it without checking whether someone else already did.
 *
 * `onNote` receives a line per transformation, for callers that log them.
 */
export function normalizeObjectName(
  objectName: string,
  objectType: string,
  modelName: string | undefined,
  onNote?: (note: string) => void,
  options?: { knownBase?: boolean; extendedBase?: string; baseType?: string },
): string {
  // as-given: the caller's name is final. A name that cannot be valid is refused
  // by the write path (asGivenNameProblem), not repaired here.
  if (isAsGivenNamingMode()) return objectName;
  // A configured format names the extension instead of the styles below. When it
  // cannot (no format for the case, or a format that is wrong) the name is left as
  // given: the write path asks resolveFormattedExtensionName first and refuses.
  const formatted = resolveFormattedExtensionName(objectName, objectType, options);
  if (formatted.kind === 'name') {
    if (formatted.name !== objectName) onNote?.(`Named by ${formatted.setting}: ${objectName} → ${formatted.name}`);
    return formatted.name;
  }
  if (formatted.kind !== 'none') return objectName;
  const objectPrefix = resolveObjectPrefix(modelName ?? '');
  // Elements and classes carry their own style: a convention may spell one with the
  // model name and the other with the prefix. Case A is an element, Case B a class.
  const elementNamingStyle = getExtensionNamingStyle();
  const classNamingStyle = getExtensionClassNamingStyle();
  let effective = objectName;
  // Whether the text before "_Extension" is known to be the base class itself —
  // see ApplyObjectPrefixOptions.knownBase.
  let knownBase = options?.knownBase === true;

  // Cases A and B below strip a model-name token off a name that already carries
  // one, so they have to compare against the spelling a NAME can hold — the token,
  // not the raw model name. They are the same string for any model whose name is
  // already an identifier; for "Contoso Robotics" the raw form matches nothing (#892).
  const modelToken = modelName ? normalizeModelToken(modelName) : '';
  const modelDiffersFromPrefix =
    !!modelToken && objectPrefix.toLowerCase() !== modelToken.toLowerCase();

  // Case A: dot-notation extension carrying the model name as its token —
  // "CustTable.MyModelExtension" → "CustTable.Extension", so applyObjectPrefix
  // can put the right token back.
  if (
    elementNamingStyle !== 'model-name' &&
    effective.includes('.') &&
    effective.toLowerCase().endsWith('extension') &&
    modelDiffersFromPrefix
  ) {
    const dotIdx = effective.lastIndexOf('.');
    const basePart = effective.slice(0, dotIdx);
    const suffixPart = effective.slice(dotIdx + 1);
    if (suffixPart.toLowerCase().startsWith(modelToken.toLowerCase())) {
      effective = `${basePart}.${suffixPart.slice(modelToken.length)}`;
      onNote?.(`Stripped model name from dot-notation extension: ${objectName} → ${effective}`);
    }
  }

  // Case B: the same, for extension classes ending in "_Extension".
  if (
    classNamingStyle !== 'model-name' &&
    effective.endsWith('_Extension') &&
    modelDiffersFromPrefix
  ) {
    const baseName = effective.slice(0, -'_Extension'.length);
    // As its own word only — a base whose last letters spell a short model
    // name (SalesTax under model "Tax") is not carrying the model token.
    if (endsWithInfix(baseName, modelToken)) {
      // Trim the separator the token was sitting behind. Without it the stripped stem
      // keeps the separator and the infix lands one character late:
      // CustTable_ContosoRobotics_Extension → CustTable_ → CustTable_Ctso_Extension,
      // where the shape this converts TO is spelled CustTableCtso_Extension.
      effective = baseName.slice(0, -modelToken.length).replace(/_+$/, '') + '_Extension';
      onNote?.(`Stripped model name infix "${modelToken}" from extension class: ${objectName} → ${effective}`);
    }
  }

  // Case C: a dot-notation extension type given a bare base name.
  if (DOT_NOTATION_EXTENSION_TYPES.has(objectType) && !effective.includes('.')) {
    effective = `${effective}.Extension`;
    onNote?.(`Bare extension name auto-converted to dot-notation: ${objectName} → ${effective}`);
  }

  // Case D: a class extension given a base class name — bare, or already carrying
  // an element-style "Extension" word.
  if (objectType === 'class-extension' && !effective.endsWith('_Extension')) {
    const base = stripElementStyleExtensionWord(
      effective,
      [deriveExtensionInfix(objectPrefix, modelName), objectPrefix, modelToken],
    );
    const hadExtensionWord = base !== effective;
    // A bare base name states the base outright; one that carried an element-style
    // "Extension" word was an extension name, and may already hold the infix.
    if (!hadExtensionWord) knownBase = true;
    effective = `${base}_Extension`;
    onNote?.(hadExtensionWord
      ? `Element-style extension name rewritten to the class form: ${objectName} → ${effective}`
      : `Bare class-extension name auto-converted to _Extension form: ${objectName} → ${effective}`);
  }

  let finalName = applyObjectPrefix(effective, objectPrefix, modelName, { knownBase, extendedBase: options?.extendedBase });

  // EXTENSION_SUFFIX applies to NEW objects only — never to extensions. The
  // model-name style's "Base.ModelName" form has no "Extension" word, so
  // applyObjectSuffix cannot recognise it on its own; the type check can.
  if (!isExtensionObjectType(objectType)) {
    finalName = applyObjectSuffix(finalName, getObjectSuffix());
  }
  return finalName;
}

/** An AOT identifier: a letter or underscore, then letters, digits and underscores. */
const AOT_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** D365FO's hard limit on an AOT element name; past it the build fails. */
const MAX_AOT_NAME_LENGTH = 81;

/**
 * Why `objectName` cannot be written as `objectType` under naming.prefixSource=as-given,
 * or null when it can.
 *
 * Only what makes a name a valid AOT name is checked — the convention itself is
 * the project's, stated in its instruction file. The other modes REPAIR these
 * shapes (a bare `VendTable` given as table-extension becomes `VendTable.<token>`),
 * but repairing means choosing a token, which is exactly what this mode leaves to
 * the caller. So the name is refused with the reason, and nothing is invented.
 */
export function asGivenNameProblem(objectName: string, objectType: string): string | null {
  const name = objectName.trim();
  if (!name) return 'the name is empty.';
  if (name.length > MAX_AOT_NAME_LENGTH) {
    return `"${name}" is ${name.length} characters; AOT names stop at ${MAX_AOT_NAME_LENGTH}.`;
  }
  if (DOT_NOTATION_EXTENSION_TYPES.has(objectType)) {
    const parts = name.split('.');
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      return `a ${objectType} is named \`<Base>.<Token>\` (e.g. \`VendTable.ABC\`); "${name}" is not — ` +
        'name it by your convention, the server does not add the token in naming.prefixSource=as-given.';
    }
    const bad = parts.find(p => !AOT_IDENTIFIER.test(p));
    if (bad) return `"${bad}" in "${name}" is not a valid AOT identifier (letters, digits and _ only).`;
    return null;
  }
  if (!AOT_IDENTIFIER.test(name)) {
    return `"${name}" is not a valid AOT name (a letter or _, then letters, digits and _ only).`;
  }
  if (objectType === 'class-extension' && !name.endsWith('_Extension')) {
    return `a class extension's name must end with \`_Extension\` (e.g. \`VendTableTable_ABC_Extension\`); ` +
      `"${name}" does not — name it by your convention, the server does not derive it in naming.prefixSource=as-given.`;
  }
  return null;
}

/** What a configured format makes of one extension name. */
export type FormattedExtensionName =
  /** No format applies to this type: the naming styles decide, as before. */
  | { kind: 'none' }
  /** The name the format gives — or the caller's explicit one, for a case no format defines. */
  | { kind: 'name'; name: string; setting: string }
  /** No format defines this case and EXTENSION_NAME_FORMAT_UNDEFINED=ask: the user names it. */
  | { kind: 'ask'; message: string }
  /** A format is set but cannot name anything (see extensionNameFormatProblems). */
  | { kind: 'invalid'; message: string };

/**
 * The extension name the configured formats give `objectName` as `objectType`.
 *
 * Element extensions (the dot-notation types) take EXTENSION_ELEMENT_NAME_FORMAT
 * with `{0}` = the part before the dot, or the whole name when there is none.
 *
 * Extension classes take the class format of the extended object's TYPE, which
 * comes from the call — `options.baseType`, read from [ExtensionOf(<kind>Str(…))]
 * or stated — and is never guessed from the base's name. The base is
 * `options.extendedBase`, else what a configured format reads out of the name,
 * else the name itself (`CustTable` or `CustTable_Extension`). A name already
 * shaped by a format is read back by it, so applying this twice changes nothing.
 *
 * For a case no format defines — a base type without one, or no base type — a
 * name ending in `_Extension` that is not just `{Base}_Extension` is the caller's
 * explicit choice and is kept. Anything else is named by the class format under
 * EXTENSION_NAME_FORMAT_UNDEFINED=class-format, and asked for under `ask`.
 */
export function resolveFormattedExtensionName(
  objectName: string,
  objectType: string,
  options?: { extendedBase?: string; baseType?: string },
): FormattedExtensionName {
  const isElement = DOT_NOTATION_EXTENSION_TYPES.has(objectType);
  if (isElement ? !elementFormatActive() : objectType !== 'class-extension' || !classFormatsActive()) {
    return { kind: 'none' };
  }
  const problems = extensionNameFormatProblems().filter(p => !p.startsWith(UNDEFINED_FORMAT_ENV));
  if (problems.length > 0) {
    return { kind: 'invalid', message: `the configured extension name format cannot be used — ${problems.join(' ')}` };
  }
  const name = objectName.trim();

  if (isElement) {
    const base = name.includes('.') ? name.slice(0, name.indexOf('.')) : name;
    return { kind: 'name', name: formatElementExtensionName(base), setting: ELEMENT_FORMAT_ENV };
  }

  const extendedBase = options?.extendedBase?.trim() || undefined;
  const statedType = normalizeExtensionBaseType(options?.baseType);
  const stem = /_Extension$/i.test(name) ? name.slice(0, -'_Extension'.length) : undefined;
  // A reading that contradicts a stated type is no reading: the stated type wins.
  const reading = readClassExtensionName(name, extendedBase)
    .find(r => !statedType || r.type === statedType || r.type === 'class');
  const base = extendedBase ?? reading?.base ?? stem ?? name;
  const baseType = statedType ?? reading?.type;
  const explicit = stem !== undefined && stem.toLowerCase() !== base.toLowerCase();
  const rule = classFormatFor(baseType);

  if (rule.format !== undefined && !(explicit && !isDefinedBaseType(baseType))) {
    return { kind: 'name', name: formatClassExtensionName(rule.format, base), setting: rule.setting };
  }
  if (explicit) {
    // Kept as given — the structure still has to be a valid class name.
    const problem = asGivenNameProblem(name, 'class-extension');
    return problem
      ? { kind: 'invalid', message: problem }
      : { kind: 'name', name, setting: 'the name as given (no format defines this case)' };
  }
  return { kind: 'ask', message: formatAskMessage(rule.format === undefined ? rule.undefinedCase : '', base) };
}

/** A base type a class format is defined for (as opposed to one the fallback covers). */
function isDefinedBaseType(baseType: string | undefined): boolean {
  return baseType === 'class' || baseType === 'table' || baseType === 'form';
}

/**
 * The ask-back. The caller is a model: it should ask its user, not pick a name,
 * and the message says which parameters carry the answer on the next call.
 */
function formatAskMessage(undefinedCase: string, base: string): string {
  return (
    `no naming convention for ${undefinedCase || 'this extension class'} (base "${base}"; ` +
    `${UNDEFINED_FORMAT_ENV}=ask): ask the user for the name and call again with an explicit \`name\` — ` +
    `the full class name ending in _Extension (d365fo_file: objectName, with [ExtensionOf(…)] in sourceCode or ` +
    `properties.baseClass; generate_object: params.className). If the base is a class, table or form, pass its ` +
    `type instead (d365fo_file: properties.baseObjectType, or the [ExtensionOf] in sourceCode) and the configured ` +
    `format names it.`
  );
}

/**
 * Under naming.prefixSource=as-given the server renames nothing, formats
 * included: a name the format would change is refused with the name it expects.
 * Null when the name may be written as given.
 */
export function formatNameProblemAsGiven(
  objectName: string,
  objectType: string,
  options?: { extendedBase?: string; baseType?: string },
): string | null {
  const formatted = resolveFormattedExtensionName(objectName, objectType, options);
  if (formatted.kind === 'none') return null;
  if (formatted.kind !== 'name') return formatted.message;
  if (formatted.name === objectName.trim()) return null;
  return (
    `"${objectName}" does not follow ${formatted.setting}; it expects "${formatted.name}". ` +
    `naming.prefixSource=as-given renames nothing — pass that name.`
  );
}
