/**
 * Find References Tool
 * Find all usages of a symbol (method, class, field, table)
 * Critical for understanding impact before making changes
 */

import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { XppServerContext } from '../types/context.js';
import { buildObjectTypeMismatchMessage } from '../utils/metadataResolver.js';
import { tryBridgeReferences } from '../bridge/bridgeAdapter.js';

const FindReferencesArgsSchema = z.object({
  targetName: z.string().describe('Name of the target (class name, method name, field name, etc.)'),
  targetType: z.enum(['method', 'class', 'table', 'field', 'enum', 'all']).optional().describe('Type of the target to search for'),
  scope: z.enum(['all', 'workspace', 'standard', 'custom']).optional().default('all').describe('Search scope'),
  limit: z.number().optional().default(50).describe('Maximum results to return'),
  // Default OFF: code-context snippets roughly quadruple the token cost of this tool.
  // Agents typically only need file:line:type — turn context on explicitly when you need snippets.
  includeContext: z.boolean().optional().default(false).describe('Include code context around reference (opt-in to reduce token usage)'),
});

interface Reference {
  file: string;
  model: string;
  line?: number;
  context: string;
  referenceType: 'call' | 'extends' | 'implements' | 'field-access' | 'instantiation' | 'type-reference';
  caller?: string;
}

export async function findReferencesTool(request: CallToolRequest, context: XppServerContext) {
  try {
    const args = FindReferencesArgsSchema.parse(request.params.arguments);
    const { symbolIndex, cache } = context;
    const { targetName, targetType, scope, limit, includeContext } = args;

    // Check cache first (30 min TTL — references can change as code evolves)
    const cacheKey = `xpp:refs:${targetName}:${targetType || 'all'}:${scope}:${limit}`;
    const cachedResult = await cache.get<any>(cacheKey);
    if (cachedResult) {
      return cachedResult;
    }

    // Try C# bridge first (DYNAMICSXREFDB — live cross-references)
    const bridgeResult = await tryBridgeReferences(context.bridge, targetName, limit);
    if (bridgeResult) return bridgeResult;

    // --- Parse dotted notation (e.g. "SalesLineCopy.copy()" or "SalesLineCopy.copy") ---
    // Extract parent object name so we can cross-check its actual type in the DB
    let parentObjectName: string | null = null;
    const cleanTargetName = targetName.replace(/\(.*$/, '').trim(); // strip trailing parens
    if (cleanTargetName.includes('.')) {
      const parts = cleanTargetName.split('.');
      parentObjectName = parts[0].trim() || null;
    } else if (targetType === 'class' || targetType === 'method') {
      // Also check the bare name itself when caller explicitly expects a class
      parentObjectName = cleanTargetName;
    }

    // Build search patterns
    const references: Reference[] = [];
    let totalReferences = 0;

    // 1. Search for method calls
    if (!targetType || targetType === 'method' || targetType === 'all') {
      const methodRefs = findMethodReferences(symbolIndex, targetName, scope, limit);
      references.push(...methodRefs);
    }

    // 2. Search for class references (extends, implements, instantiations)
    if (!targetType || targetType === 'class' || targetType === 'all') {
      const classRefs = findClassReferences(symbolIndex, targetName, scope, limit);
      references.push(...classRefs);
    }

    // 3. Search for table references (select statements, table buffers)
    if (!targetType || targetType === 'table' || targetType === 'all') {
      const tableRefs = findTableReferences(symbolIndex, targetName, scope, limit);
      references.push(...tableRefs);
    }

    // 4. Search for field references
    if (!targetType || targetType === 'field' || targetType === 'all') {
      const fieldRefs = findFieldReferences(symbolIndex, targetName, scope, limit);
      references.push(...fieldRefs);
    }

    // 5. Search for enum references
    if (!targetType || targetType === 'enum' || targetType === 'all') {
      const enumRefs = findEnumReferences(symbolIndex, targetName, scope, limit);
      references.push(...enumRefs);
    }

    // Limit results
    totalReferences = references.length;
    const limitedReferences = references.slice(0, limit);

    // Generate summary
    const summary = generateReferenceSummary(limitedReferences);

    // Format output
    let output = `# References to \`${targetName}\`\n\n`;
    output += `**Total References Found:** ${totalReferences}\n`;
    output += `**Showing:** ${limitedReferences.length} results\n`;
    if (targetType) {
      output += `**Target Type:** ${targetType}\n`;
    }
    output += `**Scope:** ${scope}\n\n`;

    // Cross-type check: detect when the caller used a form/table/view name as if it were a class
    const typeMismatchSection = parentObjectName
      ? buildObjectTypeMismatchMessage(symbolIndex.getReadDb(), parentObjectName)
      : '';

    if (limitedReferences.length === 0) {
      output += `No references found for \`${targetName}\`.\n\n`;
      output += `**Possible reasons:**\n`;
      output += `- Symbol might be unused\n`;
      output += `- Symbol might be defined but not yet indexed\n`;
      output += `- Try search without targetType to broaden results\n`;
      if (typeMismatchSection) {
        output += `\n${typeMismatchSection}`;
      }
    } else {
      // Group by reference type
      const byType = groupByReferenceType(limitedReferences);

      output += `## 📊 Summary by Type\n\n`;
      for (const [type, refs] of Object.entries(byType)) {
        output += `- **${type}**: ${refs.length} reference(s)\n`;
      }
      output += `\n`;

      // Show top callers
      if (summary.topCallers.length > 0) {
        output += `## 🔝 Top Callers\n\n`;
        for (const caller of summary.topCallers.slice(0, 10)) {
          output += `- **${caller.caller}** (${caller.count} call(s))\n`;
        }
        output += `\n`;
      }

      // List all references
      output += `## 📍 All References\n\n`;
      for (const ref of limitedReferences) {
        output += `### ${ref.referenceType} in \`${ref.file}\`\n\n`;
        output += `**Model:** ${ref.model}\n`;
        if (ref.caller) {
          output += `**Caller:** ${ref.caller}\n`;
        }
        if (includeContext && ref.context) {
          output += `\n**Context:**\n\`\`\`xpp\n${ref.context}\n\`\`\`\n`;
        }
        output += `\n`;
      }

      // Show type mismatch hint even when some references were found
      // (they might be false positives from fuzzy matching)
      if (typeMismatchSection) {
        output += `\n---\n\n${typeMismatchSection}`;
      }
    }

    const finalResult = {
      content: [
        {
          type: 'text',
          text: output,
        },
      ],
    };

    // Cache for 30 minutes (references are more volatile than class/table metadata)
    await cache.set(cacheKey, finalResult, 1800);

    return finalResult;
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `Error finding references: ${error instanceof Error ? error.message : 'Unknown error'}`,
        },
      ],
      isError: true,
    };
  }
}

/**
 * Run an FTS5 search on source_snippet (and optionally extra columns) for method symbols.
 * Dramatically faster than `source_snippet LIKE '%term%'` — uses the pre-built FTS index.
 * FTS5 tokenizes on non-word characters (., :, (, ), etc.) so the bare symbol name matches
 * all surrounding call patterns (.name(, ::name(, new name(, etc.).
 * Falls back to an empty array when the FTS query fails (e.g. single-char or reserved word).
 */
function ftsMethodSearch(db: any, term: string, limit: number, extraColumns?: string): any[] {
  // Strip chars that would break FTS5 query syntax
  const safe = term.replace(/["\(\)\\]/g, '').trim();
  if (!safe) return [];
  const cols = extraColumns ? `{source_snippet ${extraColumns}}` : '{source_snippet}';
  const ftsQuery = `${cols} : "${safe}"`;
  try {
    const stmt = db.prepare(`
      SELECT s.name, s.parent_name, s.file_path, s.model, s.source_snippet
      FROM symbols s
      WHERE s.type = 'method'
        AND s.id IN (SELECT rowid FROM symbols_fts WHERE symbols_fts MATCH ?)
      LIMIT ?
    `);
    return stmt.all(ftsQuery, limit) as any[];
  } catch {
    return [];
  }
}

/**
 * Find method call references
 */
function findMethodReferences(symbolIndex: any, methodName: string, _scope: string, limit: number): Reference[] {
  const references: Reference[] = [];
  const rdb = symbolIndex.getReadDb();

  const rows = ftsMethodSearch(rdb, methodName, limit * 3, 'signature');

  for (const row of rows) {
    const context = extractMethodCallContext(row.source_snippet, methodName);
    if (context) {
      references.push({
        file: row.file_path,
        model: row.model,
        context: context,
        referenceType: 'call',
        caller: row.parent_name ? `${row.parent_name}.${row.name}` : row.name,
      });
    }
  }

  return references;
}

/**
 * Find class references (extends, implements, instantiations)
 */
function findClassReferences(symbolIndex: any, className: string, _scope: string, limit: number): Reference[] {
  const references: Reference[] = [];
  const rdb = symbolIndex.getReadDb();

  // 1. Find classes that extend this class
  const extendsStmt = rdb.prepare(`
    SELECT name, file_path, model, extends_class
    FROM symbols
    WHERE type = 'class'
      AND extends_class = ?
    LIMIT ?
  `);

  const extendRows = extendsStmt.all(className, limit);
  for (const row of extendRows) {
    references.push({
      file: row.file_path,
      model: row.model,
      context: `class ${row.name} extends ${className}`,
      referenceType: 'extends',
      caller: row.name,
    });
  }

  // 2. Find classes that implement this interface
  const implementsStmt = rdb.prepare(`
    SELECT name, file_path, model, implements_interfaces
    FROM symbols
    WHERE type = 'class'
      AND implements_interfaces LIKE ?
    LIMIT ?
  `);

  const implRows = implementsStmt.all(`%${className}%`, limit);
  for (const row of implRows) {
    if (row.implements_interfaces && row.implements_interfaces.includes(className)) {
      references.push({
        file: row.file_path,
        model: row.model,
        context: `class ${row.name} implements ${className}`,
        referenceType: 'implements',
        caller: row.name,
      });
    }
  }

  // 3. Find instantiations (new ClassName())
  // FTS5: search for className in source_snippet; extractInstantiationContext filters for 'new ClassName('
  const instRows = ftsMethodSearch(rdb, className, limit);
  for (const row of instRows) {
    const context = extractInstantiationContext(row.source_snippet, className);
    if (context) {
      references.push({
        file: row.file_path,
        model: row.model,
        context: context,
        referenceType: 'instantiation',
        caller: row.parent_name ? `${row.parent_name}.${row.name}` : row.name,
      });
    }
  }

  // 4. Find general type references (classStr(), variable declarations, static calls)
  // FTS5: a single indexed lookup replaces three LIKE full-table scans
  const typeRefRows = ftsMethodSearch(rdb, className, limit);
  const existingCallers = new Set(references.map(r => r.caller));
  for (const row of typeRefRows) {
    const caller = row.parent_name ? `${row.parent_name}.${row.name}` : row.name;
    if (existingCallers.has(caller)) continue; // skip duplicates
    const context = extractTableReferenceContext(row.source_snippet, className);
    if (context) {
      references.push({
        file: row.file_path,
        model: row.model,
        context: context,
        referenceType: 'type-reference',
        caller,
      });
      existingCallers.add(caller);
    }
  }

  return references;
}

/**
 * Find table references (select statements, table buffers)
 */
function findTableReferences(symbolIndex: any, tableName: string, _scope: string, limit: number): Reference[] {
  const references: Reference[] = [];
  const rdb = symbolIndex.getReadDb();

  const rows = ftsMethodSearch(rdb, tableName, limit);

  for (const row of rows) {
    const context = extractTableReferenceContext(row.source_snippet, tableName);
    if (context) {
      references.push({
        file: row.file_path,
        model: row.model,
        context: context,
        referenceType: 'type-reference',
        caller: row.parent_name ? `${row.parent_name}.${row.name}` : row.name,
      });
    }
  }

  return references;
}

/**
 * Find field references
 */
function findFieldReferences(symbolIndex: any, fieldName: string, _scope: string, limit: number): Reference[] {
  const references: Reference[] = [];
  const rdb = symbolIndex.getReadDb();

  const rows = ftsMethodSearch(rdb, fieldName, limit);

  for (const row of rows) {
    const context = extractFieldAccessContext(row.source_snippet, fieldName);
    if (context) {
      references.push({
        file: row.file_path,
        model: row.model,
        context: context,
        referenceType: 'field-access',
        caller: row.parent_name ? `${row.parent_name}.${row.name}` : row.name,
      });
    }
  }

  return references;
}

/**
 * Find enum references
 */
function findEnumReferences(symbolIndex: any, enumName: string, _scope: string, limit: number): Reference[] {
  const references: Reference[] = [];
  const rdb = symbolIndex.getReadDb();

  const rows = ftsMethodSearch(rdb, enumName, limit);

  for (const row of rows) {
    const context = extractEnumReferenceContext(row.source_snippet, enumName);
    if (context) {
      references.push({
        file: row.file_path,
        model: row.model,
        context: context,
        referenceType: 'type-reference',
        caller: row.parent_name ? `${row.parent_name}.${row.name}` : row.name,
      });
    }
  }

  return references;
}

/**
 * Extract context around method call
 */
function extractMethodCallContext(source: string, methodName: string): string | null {
  if (!source) return null;

  const lines = source.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(methodName + '(')) {
      // Return 2 lines before and after
      const start = Math.max(0, i - 2);
      const end = Math.min(lines.length, i + 3);
      return lines.slice(start, end).join('\n').trim();
    }
  }

  return null;
}

/**
 * Extract context around instantiation
 */
function extractInstantiationContext(source: string, className: string): string | null {
  if (!source) return null;

  const pattern = `new ${className}(`;
  const lines = source.split('\n');
  
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(pattern)) {
      const start = Math.max(0, i - 1);
      const end = Math.min(lines.length, i + 2);
      return lines.slice(start, end).join('\n').trim();
    }
  }

  return null;
}

/**
 * Extract context around table reference
 */
function extractTableReferenceContext(source: string, tableName: string): string | null {
  if (!source) return null;

  const lines = source.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(tableName)) {
      const start = Math.max(0, i - 1);
      const end = Math.min(lines.length, i + 2);
      return lines.slice(start, end).join('\n').trim();
    }
  }

  return null;
}

/**
 * Extract context around field access
 */
function extractFieldAccessContext(source: string, fieldName: string): string | null {
  if (!source) return null;

  const lines = source.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes('.' + fieldName)) {
      const start = Math.max(0, i - 1);
      const end = Math.min(lines.length, i + 2);
      return lines.slice(start, end).join('\n').trim();
    }
  }

  return null;
}

/**
 * Extract context around enum reference
 */
function extractEnumReferenceContext(source: string, enumName: string): string | null {
  if (!source) return null;

  const lines = source.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(enumName + '::')) {
      const start = Math.max(0, i - 1);
      const end = Math.min(lines.length, i + 2);
      return lines.slice(start, end).join('\n').trim();
    }
  }

  return null;
}

/**
 * Generate reference summary
 */
function generateReferenceSummary(references: Reference[]): {
  topCallers: Array<{ caller: string; count: number }>;
} {
  const callerCounts = new Map<string, number>();

  for (const ref of references) {
    if (ref.caller) {
      callerCounts.set(ref.caller, (callerCounts.get(ref.caller) || 0) + 1);
    }
  }

  const topCallers = Array.from(callerCounts.entries())
    .map(([caller, count]) => ({ caller, count }))
    .sort((a, b) => b.count - a.count);

  return { topCallers };
}

/**
 * Group references by type
 */
function groupByReferenceType(references: Reference[]): Record<string, Reference[]> {
  const groups: Record<string, Reference[]> = {};

  for (const ref of references) {
    if (!groups[ref.referenceType]) {
      groups[ref.referenceType] = [];
    }
    groups[ref.referenceType].push(ref);
  }

  return groups;
}

export const findReferencesToolDefinition = {
  name: 'find_references',
  description: '🔍 Find all usages of a symbol (method, class, field, table, enum). Shows where the symbol is called, extended, implemented, or referenced. Critical for understanding impact before making changes. Use this instead of code_search which hangs on large workspaces.',
  inputSchema: FindReferencesArgsSchema,
};
