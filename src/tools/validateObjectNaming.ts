/**
 * Validate Object Naming Tool
 * Validate proposed D365FO object names against naming conventions,
 * detect conflicts against the symbol index, and suggest correct names.
 */

import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { XppServerContext } from '../types/context.js';
import { getObjectSuffix, getExtensionNamingStyle } from '../utils/modelClassifier.js';
import { getConfigManager } from '../utils/configManager.js';
import { lookupSymbolNocase, lookupSymbolsNocase } from '../utils/symbolLookup.js';

const ValidateObjectNamingArgsSchema = z.object({
  proposedName: z.string().describe('The proposed object name to validate'),
  objectType: z.enum([
    'class', 'table', 'form', 'enum', 'edt', 'query', 'view',
    'table-extension', 'class-extension', 'form-extension',
    'enum-extension', 'edt-extension',
    'menu-item', 'security-privilege', 'security-duty', 'security-role',
    'data-entity',
  ]).describe('Type of the D365FO object'),
  baseObjectName: z.string().optional()
    .describe('Required for extension types: name of the object being extended'),
  modelPrefix: z.string().optional()
    .describe('Expected ISV/model prefix (2-4 uppercase letters, e.g. "WHS", "CONT"). Auto-detected if omitted.'),
  modelName: z.string().optional()
    .describe('Target model name. Only relevant when EXTENSION_NAMING_STYLE=model-name, where the extension token is the model name (e.g. CustTable_ContosoRobotics_Extension). Auto-detected from the active workspace if omitted.'),
});

// Extension types that require base object name
const EXTENSION_TYPES = new Set([
  'table-extension', 'class-extension', 'form-extension',
  'enum-extension', 'edt-extension',
]);

export async function validateObjectNamingTool(request: CallToolRequest, context: XppServerContext) {
  try {
    const args = ValidateObjectNamingArgsSchema.parse(request.params.arguments);
    const db = context.symbolIndex.getReadDb();

    const errors: string[] = [];
    const warnings: string[] = [];
    const suggestions: string[] = [];

    const name = args.proposedName;
    const isExtension = EXTENSION_TYPES.has(args.objectType);

    // D365FO has a hard 81-character limit on AOT names; exceeding it is a build error.
    const MAX_NAME_LENGTH = 81;
    if (name.length > MAX_NAME_LENGTH) {
      errors.push(`Name "${name}" is ${name.length} characters — exceeds the D365FO AOT maximum of ${MAX_NAME_LENGTH} characters. This will cause a build error.`);
      suggestions.push(`Shortened name (${MAX_NAME_LENGTH} chars max): ${name.slice(0, MAX_NAME_LENGTH)}`);
    } else if (name.length > 70) {
      warnings.push(`Name is ${name.length} characters — approaching the ${MAX_NAME_LENGTH}-char AOT limit. Consider a shorter name to leave room for extensions.`);
    }

    // Resolve model prefix: explicit arg → EXTENSION_PREFIX env → DB auto-detect (mirrors resolveObjectPrefix()).
    let prefix = args.modelPrefix?.toUpperCase() || '';
    if (!prefix) {
      const envPrefix = process.env.EXTENSION_PREFIX?.trim().replace(/_+$/, '');
      if (envPrefix) {
        prefix = envPrefix.toUpperCase();
      } else {
        prefix = detectModelPrefix(db, name);
      }
    }

    // Under EXTENSION_NAMING_STYLE=model-name the extension token is the model name (Visual Studio
    // default) rather than the prefix infix: class extension → {Base}_{ModelName}_Extension,
    // element extension → {Base}.{ModelName}. Explicit modelName arg wins over workspace config.
    const namingStyle = getExtensionNamingStyle();
    let modelName = args.modelName?.trim() || '';
    if (!modelName && namingStyle === 'model-name') {
      modelName = getConfigManager().getModelName() ?? '';
    }
    const useModelName = namingStyle === 'model-name' && !!modelName;

    // Rule set 1: extension naming rules
    if (isExtension) {
      const baseObjectName = args.baseObjectName;

      if (!baseObjectName) {
        errors.push(`baseObjectName is required for extension types (${args.objectType}).`);
      } else {
        if (args.objectType === 'class-extension') {
          // prefix style → {Base}{Prefix}_Extension; model-name style → {Base}_{ModelName}_Extension
          const expectedPattern = useModelName
            ? `${baseObjectName}_${modelName}_Extension`
            : `${baseObjectName}${prefix}_Extension`;
          const expectedToken = useModelName ? modelName : prefix;

          if (!name.startsWith(baseObjectName)) {
            errors.push(`Class extension names must start with the base class name.\n  Expected format: ${expectedPattern}`);
            if (expectedToken) suggestions.push(`Correct name: ${expectedPattern}`);
          } else if (!name.endsWith('_Extension')) {
            errors.push(`Class extension names must end with '_Extension'.\n  Expected format: ${expectedPattern}`);
            if (expectedToken) suggestions.push(`Correct name: ${expectedPattern}`);
          } else {
            // Structure is correct — check the expected token is included. Strip a leading
            // separator so "_ContosoRobotics" compares cleanly to the model name.
            const middle = name.slice(baseObjectName.length, -'_Extension'.length).replace(/^_+/, '');
            if (expectedToken &&
                middle.toLowerCase() !== expectedToken.toLowerCase() &&
                !middle.toLowerCase().includes(expectedToken.toLowerCase())) {
              warnings.push(
                useModelName
                  ? `Extension name does not embed the model name "${modelName}" (EXTENSION_NAMING_STYLE=model-name).\n  Current: ${name}\n  Recommended: ${expectedPattern}`
                  : `Extension name does not include model prefix "${prefix}".\n  Current: ${name}\n  Recommended: ${expectedPattern}`
              );
            }
          }

          suggestions.push(
            useModelName
              ? `AOT name for an element extension instead: ${baseObjectName}.${modelName}`
              : `AOT label for extension file: ${baseObjectName}.${prefix}Extension (if creating table-extension AOT object instead)`
          );

        } else if (useModelName) {
          // AOT extensions (table/form/enum/edt), model-name style: {Base}.{ModelName} — bare model
          // name, no "Extension" word.
          const expectedPattern = `${baseObjectName}.${modelName}`;

          if (!name.includes('.')) {
            errors.push(`${args.objectType} names must use dot notation: {Base}.{ModelName}.\n  Expected: ${expectedPattern}`);
            suggestions.push(`Correct name: ${expectedPattern}`);
          } else {
            const [basePart, extPart] = name.split('.', 2);

            if (basePart !== baseObjectName) {
              errors.push(`Extension base (before '.') must exactly match baseObjectName.\n  Expected: ${baseObjectName}.xxx\n  Got: ${basePart}.xxx`);
            }
            if (extPart.toLowerCase() !== modelName.toLowerCase()) {
              warnings.push(`Extension token (after '.') should be the model name "${modelName}" (EXTENSION_NAMING_STYLE=model-name).\n  Current: ${extPart}\n  Recommended: ${modelName}`);
            }
          }

        } else {
          // AOT extensions (table/form/enum/edt), prefix style: {Base}.{Prefix}Extension.
          const expectedPattern = `${baseObjectName}.${prefix}Extension`;

          if (!name.includes('.')) {
            errors.push(`${args.objectType} names must use dot notation: {Base}.{Prefix}Extension.\n  Expected: ${expectedPattern}`);
            if (prefix) suggestions.push(`Correct name: ${expectedPattern}`);
          } else {
            const [basePart, extPart] = name.split('.', 2);

            if (basePart !== baseObjectName) {
              errors.push(`Extension base (before '.') must exactly match baseObjectName.\n  Expected: ${baseObjectName}.xxx\n  Got: ${basePart}.xxx`);
            }
            if (!extPart.endsWith('Extension')) {
              errors.push(`Extension suffix (after '.') must end with 'Extension'.\n  Expected: ${prefix}Extension\n  Got: ${extPart}`);
            } else if (prefix && !extPart.startsWith(prefix)) {
              warnings.push(`Extension suffix should start with model prefix "${prefix}".\n  Current: ${extPart}\n  Recommended: ${prefix}Extension`);
            }
          }
        }

        const dbTypes = args.objectType.includes('class') ? ['class'] :
          args.objectType.includes('table') ? ['table'] :
          args.objectType.includes('form') ? ['form'] :
          args.objectType.includes('enum') ? ['enum'] : ['edt'];

        // Case-insensitive: the base object may be spelled with different casing
        // than the canonical AOT name (#686).
        const baseExists = lookupSymbolNocase(db, baseObjectName, dbTypes);

        if (!baseExists) {
          warnings.push(`Base object "${baseObjectName}" not found in symbol index for types: ${dbTypes.join(', ')}. Ensure it's indexed.`);
        }
      }
    }

    // Rule set 2: new object naming rules
    if (!isExtension) {
      // Underscores are allowed only as a prefix separator: {Prefix}_{Rest}
      // (e.g. valid "MY_VendPaymTermsMaintain", invalid "MYVendPaymTerms_Helper").
      if (name.includes('_')) {
        const underscoreIdx = name.indexOf('_');
        const beforeUnderscore = name.slice(0, underscoreIdx);
        const hasPrefixSeparator = !!prefix &&
          beforeUnderscore.toLowerCase() === prefix.toLowerCase();
        if (!hasPrefixSeparator) {
          errors.push(
            `Non-extension objects must not contain underscores. ` +
            `The only allowed underscore is as a prefix separator: ` +
            `${prefix ? prefix + '_MyObject' : 'Prefix_MyObject'}. ` +
            `For extension classes use: VendTable${prefix || 'Prefix'}_Extension.`
          );
        }
      }

      if (prefix) {
        if (!name.startsWith(prefix) && !name.toUpperCase().startsWith(prefix)) {
          warnings.push(`Proposed name does not start with model prefix "${prefix}". All custom objects should be prefixed to avoid conflicts.`);
          suggestions.push(`Prefixed name: ${prefix}${name}`);
        }
      }

      const configuredSuffix = getObjectSuffix();
      if (configuredSuffix) {
        if (!name.toLowerCase().endsWith(configuredSuffix.toLowerCase())) {
          warnings.push(`EXTENSION_SUFFIX="${configuredSuffix}" is configured but the proposed name does not end with it. Expected: ${name}${configuredSuffix}`);
          suggestions.push(`Suffixed name: ${name}${configuredSuffix}`);
        }
      }

      if (args.objectType === 'security-privilege') {
        if (!/(View|Maintain|Delete|Admin|Invoke|Approve|FullControl)$/.test(name)) {
          warnings.push(`Security privileges typically end with an action suffix: View, Maintain, Delete, Admin, Invoke, Approve, or FullControl.\n  Examples: ${name}View, ${name}Maintain`);
        }
      }

      if (args.objectType === 'security-duty') {
        if (!/(Maintain|View|Inquire|Admin|Approve|Process)$/.test(name) &&
            !(name.toLowerCase().includes('maintain') || name.toLowerCase().includes('view'))) {
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

    // Rule set 3: conflict detection
    const dbType = args.objectType === 'class-extension' ? 'class-extension' :
      args.objectType === 'table-extension' ? 'table-extension' :
      args.objectType === 'form-extension' ? 'form-extension' :
      args.objectType === 'enum-extension' ? 'enum-extension' :
      args.objectType === 'edt-extension' ? 'edt-extension' :
      args.objectType === 'data-entity' ? 'view' :
      args.objectType;

    // AOT names are case-insensitive, so an existing object differing only in
    // casing IS a conflict — a case-sensitive probe here reported a false
    // "no existing objects" (#686). Scoped to top-level objects: a method or
    // field sharing the name is not an AOT naming conflict.
    const exactConflict = lookupSymbolsNocase(db, name, { limit: 5 });

    const similarSymbols = db.prepare(
      `SELECT name, type, model FROM symbols WHERE name LIKE ? AND type = ? ORDER BY name LIMIT 5`
    ).all(`${name.slice(0, Math.max(4, name.length - 3))}%`, dbType) as any[];

    let output = `Validation: "${name}" as ${args.objectType}\n`;
    if (args.baseObjectName) output += `Base Object: ${args.baseObjectName}\n`;
    if (prefix) output += `Model Prefix: ${prefix}\n`;
    if (isExtension) {
      output += useModelName
        ? `Extension Style: model-name (token = model name "${modelName}")\n`
        : `Extension Style: prefix (token = model prefix infix)\n`;
      if (namingStyle === 'model-name' && !modelName) {
        output += `  ⚠ EXTENSION_NAMING_STYLE=model-name but no model name could be resolved — validated structure only. Pass modelName to validate the extension token.\n`;
      }
    }
    output += '\n';

    if (errors.length > 0) {
      output += `ERRORS (${errors.length}):\n`;
      for (const e of errors) {
        output += `  ✗ ${e}\n`;
      }
      output += '\n';
    }

    if (warnings.length > 0) {
      output += `WARNINGS (${warnings.length}):\n`;
      for (const w of warnings) {
        output += `  ⚠ ${w}\n`;
      }
      output += '\n';
    }

    if (errors.length === 0 && warnings.length === 0) {
      output += `✓ Name passes all validation rules\n\n`;
    }

    if (suggestions.length > 0) {
      output += `SUGGESTIONS:\n`;
      for (const s of suggestions) {
        output += `  → ${s}\n`;
      }
      output += '\n';
    }

    output += `CONFLICT CHECK:\n`;
    if (exactConflict.length > 0) {
      output += `  ✗ Name "${name}" already exists:\n`;
      for (const c of exactConflict) {
        output += `    ${c.name} [${c.type}] in ${c.model}\n`;
      }
    } else {
      output += `  ✓ No existing objects named "${name}" found\n`;
    }

    if (similarSymbols.length > 0 && !exactConflict.some(c => c.name.toLowerCase() === name.toLowerCase())) {
      output += `  Similar ${args.objectType} names:\n`;
      for (const s of similarSymbols) {
        output += `    ${s.name} [${s.model}]\n`;
      }
    }

    output += '\n';

    const rules = isExtension
      ? ['Extension suffix pattern', 'Model prefix included', 'Base object exists in index']
      : ['No underscore in non-extension names', 'Model prefix', 'Type-specific conventions'];
    output += `Naming Rules Applied:\n`;
    for (const r of rules) {
      output += `  [${errors.length === 0 ? 'x' : ' '}] ${r}\n`;
    }

    return { content: [{ type: 'text', text: output }] };
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `Error validating object name: ${error instanceof Error ? error.message : 'Unknown error'}`,
        },
      ],
      isError: true,
    };
  }
}

/**
 * Detect common model prefix from existing custom symbols.
 * Looks for 2-4 char prefix shared by many objects in the index.
 */
function detectModelPrefix(db: any, proposedName: string): string {
  const stdPrefixes = ['Cust', 'Vend', 'Sales', 'Purch', 'Ledger', 'Invent', 'Proj', 'WHS',
    'Sma', 'MCR', 'Retail', 'Ax', 'Sys', 'Global', 'Common', 'Tax', 'Bank'];
  for (const p of stdPrefixes) {
    if (proposedName.startsWith(p)) return '';
  }

  try {
    const prefix3 = proposedName.slice(0, 3).toUpperCase();
    const sample = db.prepare(
      `SELECT name FROM symbols WHERE type = 'class' AND name LIKE ? LIMIT 20`
    ).all(`${prefix3}%`) as any[];

    if (sample.length >= 3) return prefix3;

    const prefix2 = proposedName.slice(0, 2).toUpperCase();
    return prefix2.length >= 2 ? prefix2 : '';
  } catch {
    return '';
  }
}
