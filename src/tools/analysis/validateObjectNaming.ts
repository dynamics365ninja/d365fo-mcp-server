/**
 * validate_object_naming — MCP wrapper.
 *
 * The rules live in utils/objectNamingRules.ts so prepare can run the SAME ones;
 * this file is now argument parsing plus rendering.
 */

import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { XppServerContext } from '../../types/context.js';
import { checkObjectNaming } from '../../utils/objectNamingRules.js';

const ValidateObjectNamingArgsSchema = z.object({
  proposedName: z.string().describe('The proposed object name to validate'),
  objectType: z
    .enum([
      'class',
      'table',
      'form',
      'enum',
      'edt',
      'query',
      'view',
      'table-extension',
      'class-extension',
      'form-extension',
      'enum-extension',
      'edt-extension',
      'menu-item',
      'security-privilege',
      'security-duty',
      'security-role',
      'data-entity',
    ])
    .describe('Type of the D365FO object'),
  baseObjectName: z.string().optional().describe('Required for extension types: name of the object being extended'),
  modelPrefix: z
    .string()
    .optional()
    .describe('Expected ISV/model prefix (2-4 uppercase letters, e.g. "WHS", "CONT"). Auto-detected if omitted.'),
  modelName: z
    .string()
    .optional()
    .describe(
      'Target model name. Only relevant when EXTENSION_NAMING_STYLE=model-name, where the extension token is the model name (e.g. CustTable_ContosoRobotics_Extension). Auto-detected from the active workspace if omitted.',
    ),
});

export async function validateObjectNamingTool(request: CallToolRequest, context: XppServerContext) {
  try {
    const args = ValidateObjectNamingArgsSchema.parse(request.params.arguments);
    const db = context.symbolIndex.getReadDb();
    const check = await checkObjectNaming(db, args);

    const {
      errors, warnings, suggestions, exactConflict, similarSymbols,
      isExtension, prefix, modelName, modelTokenPhrase, extensionInfix,
      useModelName, namingStyle,
    } = check;
    const name = args.proposedName;
    const reinterpreted = check.reinterpretedNote ? { note: check.reinterpretedNote } : undefined;
    const explicitPrefix = args.modelPrefix?.trim() || '';
    const resolution = { source: check.prefixOrigin };
    // Rendering below reads args.objectType/baseObjectName; use what the rules settled on.
    args.objectType = check.objectType as typeof args.objectType;
    args.baseObjectName = check.baseObjectName;

    let output = `Validation: "${name}" as ${args.objectType}\n`;
    if (reinterpreted) output += `ℹ️ ${reinterpreted.note}\n`;
    if (args.baseObjectName) output += `Base Object: ${args.baseObjectName}\n`;
    if (prefix) {
      // The origin comes along, because the same prefix line in get_workspace_info
      // carries it — without it the two read as two independent opinions.
      const origin = explicitPrefix ? 'passed in' : resolution.source;
      // The inferred-prefix origin already names the model; repeating it reads as
      // two different models.
      const modelPart = modelName && !origin.includes(`"${modelName}"`) ? `model ${modelName}, ` : '';
      output += `Model Prefix: ${prefix}${modelName ? ` (${modelPart}${origin})` : ''}\n`;
    }
    if (isExtension) {
      output += useModelName
        ? `Extension Style: model-name (token = ${modelTokenPhrase})\n`
        : `Extension Style: prefix (token = "${extensionInfix}")\n`;
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
