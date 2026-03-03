/**
 * Validate Object Naming Tool
 * Validate proposed D365FO object names against naming conventions,
 * detect conflicts against the symbol index, and suggest correct names.
 */

import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { XppServerContext } from '../types/context.js';

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
});

// Extension types that require base object name
const EXTENSION_TYPES = new Set([
  'table-extension', 'class-extension', 'form-extension',
  'enum-extension', 'edt-extension',
]);

export async function validateObjectNamingTool(request: CallToolRequest, context: XppServerContext) {
  try {
    const args = ValidateObjectNamingArgsSchema.parse(request.params.arguments);
    const db = context.symbolIndex.db;

    const errors: string[] = [];
    const warnings: string[] = [];
    const suggestions: string[] = [];

    const name = args.proposedName;
    const isExtension = EXTENSION_TYPES.has(args.objectType);

    // ── Auto-detect model prefix from existing symbols if not provided ─────
    let prefix = args.modelPrefix?.toUpperCase() || '';
    if (!prefix) {
      prefix = detectModelPrefix(db, name);
    }

    // ══════════════════════════════════════════════════════════════════
    // RULE SET 1: Extension naming rules
    // ══════════════════════════════════════════════════════════════════
    if (isExtension) {
      const baseObjectName = args.baseObjectName;

      if (!baseObjectName) {
        errors.push(`baseObjectName is required for extension types (${args.objectType}).`);
      } else {
        if (args.objectType === 'class-extension') {
          // Class extensions: {Base}{Prefix}_Extension
          const expectedPattern = `${baseObjectName}${prefix}_Extension`;

          if (!name.startsWith(baseObjectName)) {
            errors.push(`Class extension names must start with the base class name.\n  Expected format: ${expectedPattern}`);
            if (prefix) suggestions.push(`Correct name: ${expectedPattern}`);
          } else if (!name.endsWith('_Extension')) {
            errors.push(`Class extension names must end with '_Extension'.\n  Expected format: ${expectedPattern}`);
            if (prefix) suggestions.push(`Correct name: ${expectedPattern}`);
          } else {
            // Has correct structure — check prefix is included
            const middle = name.slice(baseObjectName.length, -'_Extension'.length);
            if (prefix && middle !== prefix && !middle.includes(prefix)) {
              warnings.push(`Extension name does not include model prefix "${prefix}".\n  Current: ${name}\n  Recommended: ${expectedPattern}`);
            }
          }

          // AOT extension name suggestion
          if (args.objectType === 'class-extension') {
            suggestions.push(`AOT label for extension file: ${baseObjectName}.${prefix}Extension (if creating table-extension AOT object instead)`);
          }

        } else {
          // AOT extensions (table/form/enum/edt): {Base}.{Prefix}Extension
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

        // Verify base object exists in index
        const dbTypes = args.objectType.includes('class') ? ['class'] :
          args.objectType.includes('table') ? ['table'] :
          args.objectType.includes('form') ? ['form'] :
          args.objectType.includes('enum') ? ['enum'] : ['edt'];

        const baseExists = db.prepare(
          `SELECT name FROM symbols WHERE name = ? AND type IN (${dbTypes.map(() => '?').join(',')}) LIMIT 1`
        ).get(baseObjectName, ...dbTypes) as any;

        if (!baseExists) {
          warnings.push(`Base object "${baseObjectName}" not found in symbol index for types: ${dbTypes.join(', ')}. Ensure it's indexed.`);
        }
      }
    }

    // ══════════════════════════════════════════════════════════════════
    // RULE SET 2: New object naming rules
    // ══════════════════════════════════════════════════════════════════
    if (!isExtension) {
      // No underscores in base names (underscores reserved for extension pattern)
      if (name.includes('_')) {
        errors.push(`Non-extension objects must not contain underscores. Underscores are reserved for extension naming (e.g. MyClass_Extension).`);
      }

      // Must start with a prefix (letter, avoid starting with Microsoft-reserved ones)
      if (prefix) {
        if (!name.startsWith(prefix) && !name.toUpperCase().startsWith(prefix)) {
          warnings.push(`Proposed name does not start with model prefix "${prefix}". All custom objects should be prefixed to avoid conflicts.`);
          suggestions.push(`Prefixed name: ${prefix}${name}`);
        }
      }

      // Security object naming conventions
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

    // ══════════════════════════════════════════════════════════════════
    // RULE SET 3: Conflict detection
    // ══════════════════════════════════════════════════════════════════
    // Exact name collision
    const dbType = args.objectType === 'class-extension' ? 'class-extension' :
      args.objectType === 'table-extension' ? 'table-extension' :
      args.objectType === 'form-extension' ? 'form-extension' :
      args.objectType === 'enum-extension' ? 'enum-extension' :
      args.objectType === 'edt-extension' ? 'edt-extension' :
      args.objectType === 'data-entity' ? 'view' :
      args.objectType;

    const exactConflict = db.prepare(
      `SELECT name, type, model FROM symbols WHERE name = ? ORDER BY model LIMIT 5`
    ).all(name) as any[];

    // Near-match search (same prefix, similar name)
    const similarSymbols = db.prepare(
      `SELECT name, type, model FROM symbols WHERE name LIKE ? AND type = ? ORDER BY name LIMIT 5`
    ).all(`${name.slice(0, Math.max(4, name.length - 3))}%`, dbType) as any[];

    // ══════════════════════════════════════════════════════════════════
    // FORMAT OUTPUT
    // ══════════════════════════════════════════════════════════════════
    let output = `Validation: "${name}" as ${args.objectType}\n`;
    if (args.baseObjectName) output += `Base Object: ${args.baseObjectName}\n`;
    if (prefix) output += `Model Prefix: ${prefix}\n`;
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

    // Conflicts
    output += `CONFLICT CHECK:\n`;
    if (exactConflict.length > 0) {
      output += `  ✗ Name "${name}" already exists:\n`;
      for (const c of exactConflict) {
        output += `    ${c.name} [${c.type}] in ${c.model}\n`;
      }
    } else {
      output += `  ✓ No existing objects named "${name}" found\n`;
    }

    if (similarSymbols.length > 0 && !exactConflict.some(c => c.name === name)) {
      output += `  Similar ${args.objectType} names:\n`;
      for (const s of similarSymbols) {
        output += `    ${s.name} [${s.model}]\n`;
      }
    }

    output += '\n';

    // Naming rules applied
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
  // If proposed name starts with common D365 standard prefixes, return empty
  const stdPrefixes = ['Cust', 'Vend', 'Sales', 'Purch', 'Ledger', 'Invent', 'Proj', 'WHS',
    'Sma', 'MCR', 'Retail', 'Ax', 'Sys', 'Global', 'Common', 'Tax', 'Bank'];
  for (const p of stdPrefixes) {
    if (proposedName.startsWith(p)) return '';
  }

  try {
    // Sample a few symbols starting with the first 3 chars of the proposed name
    const prefix3 = proposedName.slice(0, 3).toUpperCase();
    const sample = db.prepare(
      `SELECT name FROM symbols WHERE type = 'class' AND name LIKE ? LIMIT 20`
    ).all(`${prefix3}%`) as any[];

    if (sample.length >= 3) return prefix3;

    // Try 2 chars
    const prefix2 = proposedName.slice(0, 2).toUpperCase();
    return prefix2.length >= 2 ? prefix2 : '';
  } catch {
    return '';
  }
}
