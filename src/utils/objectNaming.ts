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
} from './modelClassifier.js';
import { normalizeModelToken } from './modelToken.js';

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
    if (token && base.toLowerCase().endsWith(token.toLowerCase())) {
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
): string {
  const objectPrefix = resolveObjectPrefix(modelName ?? '');
  const namingStyle = getExtensionNamingStyle();
  let effective = objectName;

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
    namingStyle !== 'model-name' &&
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
    namingStyle !== 'model-name' &&
    effective.endsWith('_Extension') &&
    modelDiffersFromPrefix
  ) {
    const baseName = effective.slice(0, -'_Extension'.length);
    if (baseName.toLowerCase().endsWith(modelToken.toLowerCase())) {
      effective = baseName.slice(0, -modelToken.length) + '_Extension';
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
    effective = `${base}_Extension`;
    onNote?.(hadExtensionWord
      ? `Element-style extension name rewritten to the class form: ${objectName} → ${effective}`
      : `Bare class-extension name auto-converted to _Extension form: ${objectName} → ${effective}`);
  }

  let finalName = applyObjectPrefix(effective, objectPrefix, modelName);

  // EXTENSION_SUFFIX applies to NEW objects only — never to extensions. The
  // model-name style's "Base.ModelName" form has no "Extension" word, so
  // applyObjectSuffix cannot recognise it on its own; the type check can.
  if (!isExtensionObjectType(objectType)) {
    finalName = applyObjectSuffix(finalName, getObjectSuffix());
  }
  return finalName;
}
