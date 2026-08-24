/**
 * D365FO object-naming rules, as data.
 *
 * These rules used to live inside the validate_object_naming MCP tool and nowhere
 * else, because the module exported only the tool wrapper. So prepare could not
 * reuse them and grew TWO hand-rolled validators of its own
 * (prepareCreate.validateNaming, and the block in prepareChange), each weaker and
 * neither agreeing with this one. Live, on the same input, prepare(mode="create")
 * answered "Naming looks valid" for a name this checker warns is missing the model
 * prefix, and prepare(mode="change") answered a malformed table-extension name with
 * "Confirm naming follows your convention" — no check at all.
 *
 * Everything below is MOVED, not rewritten: the tool renders this result and its
 * ~35 existing tests are the proof that the rules did not change in the move.
 */

import { getObjectSuffix, getExtensionNamingStyle, deriveExtensionInfix } from './modelClassifier.js';
import {
  matchPrefixCandidate,
  modelWritesLandIn,
  prefixCandidates,
  prefixConflictWarning,
  resolveEffectivePrefix,
  type PrefixCandidate,
} from './effectivePrefix.js';
import { getConfigManager } from './configManager.js';
import { normalizeModelToken } from './modelToken.js';
import { lookupSymbolNocase, lookupSymbolsNocase } from './symbolLookup.js';

// Extension types that require base object name
const EXTENSION_TYPES = new Set([
  'table-extension',
  'class-extension',
  'form-extension',
  'enum-extension',
  'edt-extension',
]);

/** Non-extension type → the extension type that extends it. */
const EXTENSION_COUNTERPART: Record<string, string> = {
  table: 'table-extension',
  class: 'class-extension',
  form: 'form-extension',
  enum: 'enum-extension',
  edt: 'edt-extension',
};

/**
 * A name that can only be an extension: `Base.PrefixExtension` (element extensions) or
 * `BasePrefix_Extension` (class CoC).
 */
const DOTTED_EXTENSION = /^[A-Za-z]\w*\.\w*Extension$/;
const UNDERSCORE_EXTENSION = /^[A-Za-z]\w*_Extension$/;

/**
 * Reinterpret `objectType` when the proposed name is unmistakably an extension.
 *
 * Callers reach for the base type — "is this a valid *form* name?" — while proposing
 * `AslFinCore_TaxTransReportChangeLog.AslFinSKExtension`. Validated as a plain form
 * that trips the "non-extension objects must not contain underscores" rule and comes
 * back as a hard ERROR, which is both wrong and a wasted round trip: run f2e7b71a
 * asked with `form`, was refused, and asked again with `form-extension` (T56 → T59).
 *
 * Only the shapes above qualify, so a genuinely bad non-extension name — the case the
 * underscore rule exists for — still fails.
 */
function reinterpretExtensionType(
  objectType: string,
  proposedName: string,
): { objectType: string; note: string } | undefined {
  const counterpart = EXTENSION_COUNTERPART[objectType];
  if (!counterpart) return undefined;
  const dotted = DOTTED_EXTENSION.test(proposedName);
  const underscored = objectType === 'class' && UNDERSCORE_EXTENSION.test(proposedName);
  if (!dotted && !underscored) return undefined;
  return {
    objectType: counterpart,
    note:
      `Read as **${counterpart}**, not "${objectType}" — "${proposedName}" is an extension name. ` +
      `Pass objectType="${counterpart}" directly next time.`,
  };
}

/** What the caller asks about. Mirrors the tool's arguments. */
export interface ObjectNamingInput {
  proposedName: string;
  objectType: string;
  baseObjectName?: string;
  modelPrefix?: string;
  modelName?: string;
}

/** Every verdict the rules reach, before anything decides how to print it. */
export interface ObjectNamingCheck {
  /** Possibly reinterpreted from the requested type — see reinterpretExtensionType. */
  objectType: string;
  reinterpretedNote?: string;
  baseObjectName?: string;
  isExtension: boolean;
  prefix: string;
  prefixOrigin: string;
  modelName: string;
  modelTokenPhrase: string;
  extensionInfix: string;
  useModelName: boolean;
  namingStyle: string;
  errors: string[];
  warnings: string[];
  suggestions: string[];
  exactConflict: Array<{ name: string; type: string; model: string }>;
  similarSymbols: Array<{ name: string; type: string; model: string }>;
}

/**
 * Run every naming rule against one proposed name.
 *
 * Async because the effective prefix must wait for a model detection still in
 * flight; reading it early resolves from EXTENSION_PREFIX alone and validates
 * against a token the server itself would not apply (#833).
 */
export async function checkObjectNaming(
  db: any,
  input: ObjectNamingInput,
): Promise<ObjectNamingCheck> {
  const args = { ...input };
    const errors: string[] = [];
    const warnings: string[] = [];
    const suggestions: string[] = [];

    const name = args.proposedName;

    // Before any rule runs: an extension name asked about under its base type is a
    // question about the extension. Answer that question instead of refusing.
    const reinterpreted = reinterpretExtensionType(args.objectType, name);
    if (reinterpreted) {
      args.objectType = reinterpreted.objectType as typeof args.objectType;
      // The base is the part before the dot; supplying it here keeps the
      // "baseObjectName is required for extension types" check from firing on a
      // name that spells its base out.
      if (!args.baseObjectName && name.includes('.')) {
        args.baseObjectName = name.slice(0, name.indexOf('.'));
      }
    }

    const isExtension = EXTENSION_TYPES.has(args.objectType);

    // D365FO has a hard 81-character limit on AOT names; exceeding it is a build error.
    const MAX_NAME_LENGTH = 81;
    if (name.length > MAX_NAME_LENGTH) {
      errors.push(
        `Name "${name}" is ${name.length} characters — exceeds the D365FO AOT maximum of ${MAX_NAME_LENGTH} characters. This will cause a build error.`,
      );
      suggestions.push(`Shortened name (${MAX_NAME_LENGTH} chars max): ${name.slice(0, MAX_NAME_LENGTH)}`);
    } else if (name.length > 70) {
      warnings.push(
        `Name is ${name.length} characters — approaching the ${MAX_NAME_LENGTH}-char AOT limit. Consider a shorter name to leave room for extensions.`,
      );
    }

    // The model whose convention is being validated against: explicit arg, else the
    // model WRITES land in — the same model get_workspace_info reports the prefix for
    // (see prefixDiagnostics). Reading the active model here instead made the two
    // tools disagree after a project switch. The await lets a detection still in
    // flight finish: reading null resolves the prefix from EXTENSION_PREFIX alone and
    // validates against a token the server itself would not apply (#833).
    const configManager = getConfigManager();
    await configManager.getAutoDetectedModelName();
    const activeModel = configManager.getModelName();
    const namingStyle = getExtensionNamingStyle();
    const modelName =
      args.modelName?.trim() ||
      modelWritesLandIn(configManager.getWriteAnchorModel() ?? activeModel, activeModel) ||
      '';
    const useModelName = namingStyle === 'model-name' && !!modelName;
    // The spelling of the model name that may appear INSIDE an object name — what the
    // write path embeds (applyObjectPrefix → normalizeModelToken, #892). Comparing the
    // raw name instead flagged the very name d365fo_file(create) writes and recommended
    // one carrying a space, which no build accepts (#901).
    const modelToken = modelName ? normalizeModelToken(modelName) : '';
    // Prose has to carry BOTH halves when the token is not the model name itself,
    // otherwise "should be the model name X" is followed by "Recommended: Y". Collapses
    // to the plain form for every model whose name is already an identifier.
    const modelTokenPhrase =
      modelToken === modelName
        ? `model name "${modelName}"`
        : `model-name token "${modelToken}" (from model "${modelName}")`;

    // Resolve model prefix: explicit arg → the effective prefix for that model
    // (resolveEffectivePrefix: learned from the model's own objects, else
    // EXTENSION_PREFIX, else the model name) → DB auto-detect for an unconfigured
    // workspace.
    // NOT upper-cased: "ContosoFin" is a PascalCase prefix, and "CONTOSOFIN" would make every
    // suggested name and every startsWith() check below wrong.
    const resolution = resolveEffectivePrefix(modelName);
    const explicitPrefix = args.modelPrefix?.trim() || '';
    const prefix = explicitPrefix || resolution.prefix || detectModelPrefix(db, name);

    // An explicitly passed prefix is the caller's decision and the only candidate;
    // otherwise every token that could rightfully prefix a name in this workspace
    // counts, so a disagreement between model and configuration produces a warning
    // naming both rather than an error against whichever one the server picked.
    const resolvedCandidates = prefixCandidates(resolution);
    const candidates: PrefixCandidate[] = explicitPrefix
      ? [{ token: explicitPrefix.replace(/_+$/, ''), label: 'the prefix you passed', effective: true }]
      : resolvedCandidates.length > 0
        ? resolvedCandidates
        : prefix
          ? [{ token: prefix, label: 'the prefix detected from the symbol index', effective: true }]
          : [];
    // Stated once, wherever the name lands: the reader cannot otherwise tell which
    // of the two tokens the validation above used.
    const conflictWarning = explicitPrefix ? null : prefixConflictWarning(resolution);
    // Token embedded in extension element/class names — the model's own infix when its
    // existing extensions state one (ContosoFinanceSK → "ContosoSK"), else derived.
    const extensionInfix = prefix ? deriveExtensionInfix(prefix, modelName) : '';

    // Rule set 1: extension naming rules
    if (isExtension) {
      const baseObjectName = args.baseObjectName;

      if (!baseObjectName) {
        errors.push(`baseObjectName is required for extension types (${args.objectType}).`);
      } else {
        if (args.objectType === 'class-extension') {
          // prefix style → {Base}{Prefix}_Extension; model-name style → {Base}_{ModelToken}_Extension
          const expectedPattern = useModelName
            ? `${baseObjectName}_${modelToken}_Extension`
            : `${baseObjectName}${extensionInfix}_Extension`;
          const expectedToken = useModelName ? modelToken : extensionInfix;

          if (!name.startsWith(baseObjectName)) {
            errors.push(
              `Class extension names must start with the base class name.\n  Expected format: ${expectedPattern}`,
            );
            if (expectedToken) suggestions.push(`Correct name: ${expectedPattern}`);
          } else if (!name.endsWith('_Extension')) {
            errors.push(`Class extension names must end with '_Extension'.\n  Expected format: ${expectedPattern}`);
            if (expectedToken) suggestions.push(`Correct name: ${expectedPattern}`);
          } else {
            // Structure is correct — check the expected token is included. Strip a leading
            // separator so "_ContosoRobotics" compares cleanly to the model token.
            const middle = name.slice(baseObjectName.length, -'_Extension'.length).replace(/^_+/, '');
            if (
              expectedToken &&
              middle.toLowerCase() !== expectedToken.toLowerCase() &&
              !middle.toLowerCase().includes(expectedToken.toLowerCase())
            ) {
              warnings.push(
                useModelName
                  ? `Extension name does not embed the ${modelTokenPhrase} (EXTENSION_NAMING_STYLE=model-name).\n  Current: ${name}\n  Recommended: ${expectedPattern}`
                  : `Extension name does not include model "${modelName || '(unknown)'}"'s extension infix "${extensionInfix}".\n  Current: ${name}\n  Recommended: ${expectedPattern}`,
              );
            }
          }

          suggestions.push(
            useModelName
              ? `AOT name for an element extension instead: ${baseObjectName}.${modelToken}`
              : `AOT label for extension file: ${baseObjectName}.${extensionInfix}Extension (if creating table-extension AOT object instead)`,
          );
        } else if (useModelName) {
          // AOT extensions (table/form/enum/edt), model-name style: {Base}.{ModelToken} — bare
          // model token, no "Extension" word.
          const expectedPattern = `${baseObjectName}.${modelToken}`;

          if (!name.includes('.')) {
            errors.push(
              `${args.objectType} names must use dot notation: {Base}.{ModelName}.\n  Expected: ${expectedPattern}`,
            );
            suggestions.push(`Correct name: ${expectedPattern}`);
          } else {
            const [basePart, extPart] = name.split('.', 2);

            if (basePart !== baseObjectName) {
              errors.push(
                `Extension base (before '.') must exactly match baseObjectName.\n  Expected: ${baseObjectName}.xxx\n  Got: ${basePart}.xxx`,
              );
            }
            if (extPart.toLowerCase() !== modelToken.toLowerCase()) {
              warnings.push(
                `Extension token (after '.') should be the ${modelTokenPhrase} (EXTENSION_NAMING_STYLE=model-name).\n  Current: ${extPart}\n  Recommended: ${modelToken}`,
              );
            }
          }
        } else {
          // AOT extensions (table/form/enum/edt), prefix style: {Base}.{Infix}Extension.
          const expectedPattern = `${baseObjectName}.${extensionInfix}Extension`;

          if (!name.includes('.')) {
            errors.push(
              `${args.objectType} names must use dot notation: {Base}.{Prefix}Extension.\n  Expected: ${expectedPattern}`,
            );
            if (prefix) suggestions.push(`Correct name: ${expectedPattern}`);
          } else {
            const [basePart, extPart] = name.split('.', 2);

            if (basePart !== baseObjectName) {
              errors.push(
                `Extension base (before '.') must exactly match baseObjectName.\n  Expected: ${baseObjectName}.xxx\n  Got: ${basePart}.xxx`,
              );
            }
            if (!extPart.endsWith('Extension')) {
              errors.push(
                `Extension suffix (after '.') must end with 'Extension'.\n  Expected: ${extensionInfix}Extension\n  Got: ${extPart}`,
              );
            } else if (extensionInfix && !extPart.toLowerCase().startsWith(extensionInfix.toLowerCase())) {
              warnings.push(
                `Extension suffix should start with model "${modelName || '(unknown)'}"'s infix "${extensionInfix}".\n  Current: ${extPart}\n  Recommended: ${extensionInfix}Extension`,
              );
            }
          }
        }

        const dbTypes = args.objectType.includes('class')
          ? ['class']
          : args.objectType.includes('table')
            ? ['table']
            : args.objectType.includes('form')
              ? ['form']
              : args.objectType.includes('enum')
                ? ['enum']
                : ['edt'];

        // Case-insensitive: the base object may be spelled with different casing
        // than the canonical AOT name (#686).
        const baseExists = lookupSymbolNocase(db, baseObjectName, dbTypes);

        if (!baseExists) {
          warnings.push(
            `Base object "${baseObjectName}" not found in symbol index for types: ${dbTypes.join(', ')}. Ensure it's indexed.`,
          );
        }
      }
    }

    // Rule set 2: new object naming rules
    if (!isExtension) {
      /** The candidate prefix the name turned out to carry, once one is found. */
      let separator: PrefixCandidate | null = null;

      // Underscores are allowed only as a prefix separator: {Prefix}_{Rest}
      // (e.g. valid "MY_VendPaymTermsMaintain", invalid "MYVendPaymTerms_Helper").
      if (name.includes('_')) {
        const underscoreIdx = name.indexOf('_');
        const beforeUnderscore = name.slice(0, underscoreIdx);
        // Matched against every candidate prefix, not just the winning one: while
        // the model's own naming and EXTENSION_PREFIX disagree, "Other_MyObject"
        // IS prefix-separator form — under the token the server did not pick. The
        // conflict is reported as a warning below; declaring the name invalid
        // contradicts the prefix the server itself reports as effective (#833).
        separator = matchPrefixCandidate(beforeUnderscore, candidates);
        if (!separator) {
          errors.push(
            `Non-extension objects must not contain underscores. ` +
              `The only allowed underscore is as a prefix separator: ` +
              `${prefix ? prefix + '_MyObject' : 'Prefix_MyObject'}. ` +
              `For extension classes use: VendTable${prefix || 'Prefix'}_Extension.`,
          );
        }
      }

      if (prefix) {
        const leading = separator ?? candidates.find(c => name.toLowerCase().startsWith(c.token.toLowerCase()));
        if (!leading) {
          warnings.push(
            `Proposed name does not start with model prefix "${prefix}". All custom objects should be prefixed to avoid conflicts.`,
          );
          suggestions.push(`Prefixed name: ${prefix}${name}`);
        } else if (!leading.effective) {
          warnings.push(
            `"${name}" carries "${leading.token}" (${leading.label}), not the prefix this server ` +
              `applies, "${prefix}" (${resolution.source}).`,
          );
        }
      }

      const configuredSuffix = getObjectSuffix();
      if (configuredSuffix) {
        if (!name.toLowerCase().endsWith(configuredSuffix.toLowerCase())) {
          warnings.push(
            `EXTENSION_SUFFIX="${configuredSuffix}" is configured but the proposed name does not end with it. Expected: ${name}${configuredSuffix}`,
          );
          suggestions.push(`Suffixed name: ${name}${configuredSuffix}`);
        }
      }

      if (args.objectType === 'security-privilege') {
        if (!/(View|Maintain|Delete|Admin|Invoke|Approve|FullControl)$/.test(name)) {
          warnings.push(
            `Security privileges typically end with an action suffix: View, Maintain, Delete, Admin, Invoke, Approve, or FullControl.\n  Examples: ${name}View, ${name}Maintain`,
          );
        }
      }

      if (args.objectType === 'security-duty') {
        if (
          !/(Maintain|View|Inquire|Admin|Approve|Process)$/.test(name) &&
          !(name.toLowerCase().includes('maintain') || name.toLowerCase().includes('view'))
        ) {
          warnings.push(`Security duties typically end with: Maintain, View, Inquire, Admin, Approve, or Process.`);
        }
      }

      if (args.objectType === 'data-entity') {
        if (!name.endsWith('Entity')) {
          warnings.push(`Data entity names typically end with 'Entity'. Recommendation: ${name}Entity`);
          suggestions.push(`Data entity name: ${name}Entity`);
        }
      }
    }

    // The model's own naming and EXTENSION_PREFIX disagree. Reported wherever the
    // name landed, because every rule above ran against ONE of the two tokens and
    // the reader cannot otherwise tell which — the state that produced a false
    // ERROR on a name that was correct under the effective prefix (#833).
    if (conflictWarning) warnings.push(conflictWarning);

    // Rule set 3: conflict detection
    const dbType =
      args.objectType === 'class-extension'
        ? 'class-extension'
        : args.objectType === 'table-extension'
          ? 'table-extension'
          : args.objectType === 'form-extension'
            ? 'form-extension'
            : args.objectType === 'enum-extension'
              ? 'enum-extension'
              : args.objectType === 'edt-extension'
                ? 'edt-extension'
                : args.objectType === 'data-entity'
                  ? 'view'
                  : args.objectType;

    // AOT names are case-insensitive, so an existing object differing only in
    // casing IS a conflict — a case-sensitive probe here reported a false
    // "no existing objects" (#686). Scoped to top-level objects: a method or
    // field sharing the name is not an AOT naming conflict.
    const exactConflict = lookupSymbolsNocase(db, name, { limit: 5 });

    const similarSymbols = db
      .prepare(`SELECT name, type, model FROM symbols WHERE name LIKE ? AND type = ? ORDER BY name LIMIT 5`)
      .all(`${name.slice(0, Math.max(4, name.length - 3))}%`, dbType) as any[];


  return {
    objectType: args.objectType,
    reinterpretedNote: reinterpreted?.note,
    baseObjectName: args.baseObjectName,
    isExtension,
    prefix,
    prefixOrigin: explicitPrefix ? 'passed in' : resolution.source,
    modelName,
    modelTokenPhrase,
    extensionInfix,
    useModelName,
    namingStyle,
    errors,
    warnings,
    suggestions,
    exactConflict: exactConflict as any,
    similarSymbols: similarSymbols as any,
  };
}

/**
 * Detect common model prefix from existing custom symbols.
 * Looks for 2-4 char prefix shared by many objects in the index.
 */
function detectModelPrefix(db: any, proposedName: string): string {
  const stdPrefixes = [
    'Cust',
    'Vend',
    'Sales',
    'Purch',
    'Ledger',
    'Invent',
    'Proj',
    'WHS',
    'Sma',
    'MCR',
    'Retail',
    'Ax',
    'Sys',
    'Global',
    'Common',
    'Tax',
    'Bank',
  ];
  for (const p of stdPrefixes) {
    if (proposedName.startsWith(p)) return '';
  }

  try {
    const prefix3 = proposedName.slice(0, 3).toUpperCase();
    const sample = db
      .prepare(`SELECT name FROM symbols WHERE type = 'class' AND name LIKE ? LIMIT 20`)
      .all(`${prefix3}%`) as any[];

    if (sample.length >= 3) return prefix3;

    const prefix2 = proposedName.slice(0, 2).toUpperCase();
    return prefix2.length >= 2 ? prefix2 : '';
  } catch {
    return '';
  }
}
