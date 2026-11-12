/**
 * The name a new object is created under, from the arguments of the call.
 *
 * d365fo_file(action="create") writes under it and action="generate" previews
 * it. Generate used to take objectName as passed, so under a configured prefix
 * the preview said `<Name>Foo</Name>` (and renamed the caller's `class ContosoFoo`
 * back to `Foo`) for an object that create would write as ContosoFoo, into a
 * file of that name. Both now ask this module.
 */

import { isAsGivenNamingMode } from '../../utils/modelClassifier.js';
import {
  COC_BASE_SYMBOL_TYPES, asGivenNameProblem, formatNameProblemAsGiven, inferExtendedBase, normalizeObjectName,
  resolveFormattedExtensionName,
} from '../../utils/objectNaming.js';
import { lookupSymbolsNocase } from '../../utils/symbolLookup.js';
import { parseExtensionOfAttribute } from '../../metadata/xppDeclaration.js';
import { rewriteRootObjectName } from './objectIdentityGate.js';

export interface CreateNameInput {
  objectName: string;
  objectType: string;
  sourceCode?: string;
  xmlContent?: string;
  properties?: unknown;
}

export type CreateNameResolution =
  | { kind: 'name'; finalObjectName: string }
  /** The name cannot be used; `message` says why. Nothing may be written. */
  | { kind: 'refused'; message: string };

/**
 * Resolve the final object name, or the reason there is none.
 *
 * `symbolIndex` stands in for the extended base when neither the source nor
 * the properties name it (see inferExtendedBase). `onNote` gets a line per
 * transformation.
 */
export function resolveCreateObjectName(
  args: CreateNameInput,
  actualModelName: string,
  symbolIndex: { getReadDb?: () => unknown } | undefined,
  onNote?: (note: string) => void,
): CreateNameResolution {
  // Name normalisation lives in utils/objectNaming so that modify resolves the
  // very same name from the very same arguments — the ninety lines that used to
  // sit here inline were the reason it did not. See normalizeObjectName.
  // The base an extension class names in [ExtensionOf] (or properties.baseClass)
  // tells "SalesTable + Mcp + CreditHold" — a name that already carries the token —
  // apart from a base that merely contains it. See ApplyObjectPrefixOptions.extendedBase.
  const statedBaseClass = (args.properties as Record<string, unknown> | undefined)?.baseClass;
  const extensionOf = parseExtensionOfAttribute(args.sourceCode ?? args.xmlContent ?? '');
  // The extended object's TYPE selects the class name format (EXTENSION_CLASS_NAME_FORMAT_*):
  // from the [ExtensionOf(<kind>Str(…))] the caller wrote, else as stated. Never from the name.
  const statedBaseType = (args.properties as Record<string, unknown> | undefined)?.baseObjectType;
  const extendedBaseType =
    extensionOf?.baseKind ?? (typeof statedBaseType === 'string' && statedBaseType ? statedBaseType : undefined);
  // With neither, the index stands in — the same inference prepare and
  // validate_object_naming use, so the name they predict is the name written.
  const extendedBase =
    extensionOf?.baseObjectName ??
    (typeof statedBaseClass === 'string' && statedBaseClass ? statedBaseClass : undefined) ??
    inferExtendedBase(args.objectName, actualModelName, n => {
      try {
        const db = symbolIndex?.getReadDb?.() as Parameters<typeof lookupSymbolsNocase>[0] | undefined;
        return !!db && lookupSymbolsNocase(db, n, { types: COC_BASE_SYMBOL_TYPES, limit: 1 }).length > 0;
      } catch {
        return false;
      }
    });
  // naming.prefixSource=as-given: the name is final, so one that cannot be a
  // valid AOT name is refused with the reason instead of repaired (issue 1134).
  const formatOptions = { extendedBase, baseType: extendedBaseType };
  const asGivenProblem = isAsGivenNamingMode()
    ? asGivenNameProblem(args.objectName, args.objectType) ??
      formatNameProblemAsGiven(args.objectName, args.objectType, formatOptions)
    : null;
  if (asGivenProblem) return { kind: 'refused', message: asGivenProblem };
  // A configured name format that cannot name this extension stops the write:
  // no format for the case (the user is asked), or a format that is wrong.
  const formatted = resolveFormattedExtensionName(args.objectName, args.objectType, formatOptions);
  if (formatted.kind === 'ask' || formatted.kind === 'invalid') {
    return { kind: 'refused', message: formatted.message };
  }
  const finalObjectName = normalizeObjectName(
    args.objectName,
    args.objectType,
    actualModelName,
    onNote,
    formatOptions,
  );
  return { kind: 'name', finalObjectName };
}

/**
 * The line a reply carries when the object got a name other than the one passed.
 *
 * In the RESPONSE, not only on stderr: a caller that is not told reads the
 * other name as a failed create and creates the object a second time.
 */
export function renameDisclosure(finalObjectName: string, objectName: string): string {
  return finalObjectName !== objectName
    ? `\n🔖 Named \`${finalObjectName}\`, not \`${objectName}\` as passed — the model's naming ` +
      `style decides this. The declaration inside the file matches; use this name in later calls.`
    : '';
}

/**
 * Carry a rename into XML built from the caller's own source or XML.
 *
 * When xmlContent or sourceCode contains `class MyClass` but the final name is
 * `MyPrefixMyClass`, the file would be named MyPrefixMyClass.xml but contain
 * `class MyClass`. Rewrites the declaration, classnum(…), classStr(…) and the
 * root <Name>. Returns `xmlContent` unchanged when nothing matched.
 */
export function applyRenameToContent(
  xmlContent: string,
  orig: string,
  final: string,
  logTag = 'create_d365fo_file',
): string {
  // Escape for use in RegExp (handles dots in extension names like "Foo.Extension")
  const escapedOrig = orig.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // 1. `class OriginalName` / `public class OriginalName` etc.
  const classPattern = new RegExp(
    `\\b(public\\s+|private\\s+|protected\\s+|internal\\s+|final\\s+)?class\\s+${escapedOrig}\\b`,
    'g',
  );
  let replaced = xmlContent.replace(classPattern, (match) => match.replace(orig, final));

  // 2. classnum(OriginalName) — X++ intrinsic that refers to the class by name.
  //    Callers often write classnum(OriginalName) in the source code before prefixing.
  const classnumPattern = new RegExp(`\\bclassnum\\(\\s*${escapedOrig}\\s*\\)`, 'gi');
  replaced = replaced.replace(classnumPattern, (m) => m.replace(new RegExp(escapedOrig, 'i'), final));

  // 3. classStr(OriginalName) — used in [ExtensionOf(classStr(...))] and SysOperation attributes.
  const classStrPattern = new RegExp(`\\bclassStr\\(\\s*${escapedOrig}\\s*\\)`, 'gi');
  replaced = replaced.replace(classStrPattern, (m) => m.replace(new RegExp(escapedOrig, 'i'), final));

  // 4. the metadata <Name> — the identity this block used to leave behind.
  //    Rewriting the declaration alone produced a file whose name, whose X++
  //    and whose <Name> disagreed, reported ✅, and killed the next build
  //    ("must be named X instead of Y to be consistent with its file name").
  replaced = rewriteRootObjectName(replaced, orig, final);

  if (replaced !== xmlContent) {
    console.error(
      `[${logTag}] ✅ Fixed name inconsistency: ` +
      `replaced \`${orig}\` with \`${final}\` in XML content (<Name>, class decl, classnum, classStr)`,
    );
  }
  return replaced;
}
