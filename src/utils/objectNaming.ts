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
  getObjectSuffix,
  getExtensionNamingStyle,
} from './modelClassifier.js';

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

  const modelDiffersFromPrefix =
    !!modelName && objectPrefix.toLowerCase() !== modelName.toLowerCase();

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
    if (suffixPart.toLowerCase().startsWith(modelName!.toLowerCase())) {
      effective = `${basePart}.${suffixPart.slice(modelName!.length)}`;
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
    if (baseName.toLowerCase().endsWith(modelName!.toLowerCase())) {
      effective = baseName.slice(0, -modelName!.length) + '_Extension';
      onNote?.(`Stripped model name infix "${modelName}" from extension class: ${objectName} → ${effective}`);
    }
  }

  // Case C: a dot-notation extension type given a bare base name.
  if (DOT_NOTATION_EXTENSION_TYPES.has(objectType) && !effective.includes('.')) {
    effective = `${effective}.Extension`;
    onNote?.(`Bare extension name auto-converted to dot-notation: ${objectName} → ${effective}`);
  }

  // Case D: a class extension given a bare base class name.
  if (objectType === 'class-extension' && !effective.endsWith('_Extension')) {
    effective = `${effective}_Extension`;
    onNote?.(`Bare class-extension name auto-converted to _Extension form: ${objectName} → ${effective}`);
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
