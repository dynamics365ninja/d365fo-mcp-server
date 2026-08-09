/**
 * Rich Context Utilities
 * Enhance tool responses with related suggestions, patterns, and tips
 */

import type { XppSymbol } from '../metadata/types.js';
import { STALE_ROW_MARKER } from './indexedXmlLookup.js';

export interface RichContextOptions {
  includeRelated?: boolean;
  includePatterns?: boolean;
  includeTips?: boolean;
  maxSuggestions?: number;
}

export interface RelatedSearch {
  query: string;
  reason: string;
}

export interface CommonPattern {
  pattern: string;
  frequency?: number;
}

export interface ContextualTip {
  tip: string;
  tool?: string;
}

export interface RichContext {
  relatedSearches?: RelatedSearch[];
  commonPatterns?: CommonPattern[];
  tips?: ContextualTip[];
}

/**
 * Generate related search suggestions based on query and results
 */
export function generateRelatedSearches(
  query: string,
  results: XppSymbol[],
  maxSuggestions: number = 5
): RelatedSearch[] {
  const suggestions: RelatedSearch[] = [];
  const queryLower = query.toLowerCase();

  const classResults = results.filter(r => r.type === 'class');
  const tableResults = results.filter(r => r.type === 'table');

  if (classResults.length > 0) {
    const firstClass = classResults[0];

    if (firstClass.extendsClass && firstClass.extendsClass !== 'Object') {
      suggestions.push({
        query: firstClass.extendsClass,
        reason: `Base class of ${firstClass.name}`
      });
    }

    if (!queryLower.includes('helper') && firstClass.name.includes('Table')) {
      const helperQuery = firstClass.name.replace('Table', 'Helper');
      suggestions.push({
        query: helperQuery,
        reason: 'Helper class for common operations'
      });
    }

    if (!queryLower.includes('service')) {
      suggestions.push({
        query: `${query} service`,
        reason: 'Service classes for business logic'
      });
    }
  }

  if (tableResults.length > 0 && !queryLower.includes('line')) {
    suggestions.push({
      query: `${query}Line`,
      reason: 'Related line table'
    });
  }

  if (queryLower.includes('dimension')) {
    if (!queryLower.includes('helper')) {
      suggestions.push({
        query: 'dimension helper',
        reason: 'Helper classes for dimension operations'
      });
    }
    if (!queryLower.includes('validation')) {
      suggestions.push({
        query: 'dimension validation',
        reason: 'Validation patterns for dimensions'
      });
    }
    if (!queryLower.includes('ledger') && !queryLower.includes('financial')) {
      suggestions.push({
        query: 'ledger dimension',
        reason: 'Ledger-specific dimension classes'
      });
    }
  }

  if (queryLower.includes('cust') && !queryLower.includes('vend')) {
    suggestions.push({
      query: query.replace(/cust/gi, 'Vend'),
      reason: 'Vendor equivalent'
    });
  }

  if (queryLower.includes('sales') && !queryLower.includes('purch')) {
    suggestions.push({
      query: query.replace(/sales/gi, 'Purch'),
      reason: 'Purchase equivalent'
    });
  }

  if (results.length > 15) {
    suggestions.push({
      query: `${query} helper`,
      reason: 'Narrow down to helper classes'
    });
  }

  if (results.length === 0 || results.length < 3) {
    const broaderQuery = queryLower.split(/\s+/)[0]; // first word only
    if (broaderQuery !== queryLower) {
      suggestions.push({
        query: broaderQuery,
        reason: 'Broader search term'
      });
    }
  }

  if (results.length > 0 && !queryLower.includes('custom')) {
    suggestions.push({
      query: `search(scope="extensions") for "${query}"`,
      reason: 'Find custom/ISV extensions'
    });
  }

  return suggestions.slice(0, maxSuggestions);
}

/**
 * Detect common patterns in search results
 */
export function detectCommonPatterns(results: XppSymbol[]): CommonPattern[] {
  const patterns: CommonPattern[] = [];

  if (results.length === 0) return patterns;

  const baseClasses = new Map<string, number>();
  results.forEach(r => {
    if (r.extendsClass && r.extendsClass !== 'Object') {
      baseClasses.set(r.extendsClass, (baseClasses.get(r.extendsClass) || 0) + 1);
    }
  });

  const mostCommonBase = Array.from(baseClasses.entries())
    .sort((a, b) => b[1] - a[1])[0];

  if (mostCommonBase && mostCommonBase[1] > 1) {
    patterns.push({
      pattern: `${mostCommonBase[1]} classes extend ${mostCommonBase[0]}`,
      frequency: mostCommonBase[1]
    });
  }

  const hasHelperClasses = results.some(r => r.name.includes('Helper'));
  const hasServiceClasses = results.some(r => r.name.includes('Service'));
  const hasControllerClasses = results.some(r => r.name.includes('Controller'));

  if (hasHelperClasses) {
    patterns.push({
      pattern: 'Helper classes found - typically contain reusable utility methods'
    });
  }

  if (hasServiceClasses) {
    patterns.push({
      pattern: 'Service classes found - typically contain business logic'
    });
  }

  if (hasControllerClasses) {
    patterns.push({
      pattern: 'Controller classes found - typically handle UI/form logic'
    });
  }

  const apiPatterns = results
    .filter(r => r.apiPatterns)
    .map(r => r.apiPatterns)
    .filter(Boolean);

  if (apiPatterns.length > 0) {
    const initPatterns = apiPatterns
      .flatMap(p => {
        try {
          const parsed = JSON.parse(p!);
          return parsed.initialization || [];
        } catch {
          return [];
        }
      })
      .filter(Boolean);

    if (initPatterns.length > 0) {
      const mostCommon = initPatterns[0];
      patterns.push({
        pattern: `Common initialization: ${mostCommon}`
      });
    }
  }

  const typicalUsages = results
    .filter(r => r.typicalUsages)
    .map(r => r.typicalUsages)
    .filter(Boolean);

  if (typicalUsages.length > 0) {
    try {
      const usages = JSON.parse(typicalUsages[0]!);
      if (Array.isArray(usages) && usages.length > 0) {
        patterns.push({
          pattern: `Typical usage: ${usages[0]}`
        });
      }
    } catch {
      // Ignore parse errors
    }
  }

  return patterns;
}

/**
 * Generate contextual tips based on query and results
 */
export function generateContextualTips(
  query: string,
  results: XppSymbol[],
  searchType?: string
): ContextualTip[] {
  const tips: ContextualTip[] = [];
  const queryLower = query.toLowerCase();

  if (results.length === 0) {
    tips.push({
      tip: 'Try a broader search term or use wildcard patterns (e.g., "Dim*" for all classes starting with Dim)'
    });
    tips.push({
      tip: 'Use search(scope="extensions") to search only in custom/ISV code',
      tool: 'search'
    });

    if (queryLower.length < 3) {
      tips.push({
        tip: 'Search terms shorter than 3 characters may not yield results. Try a longer term.'
      });
    }

    return tips;
  }

  const classResults = results.filter(r => r.type === 'class');
  const methodResults = results.filter(r => r.type === 'method');

  if (classResults.length > 0) {
    const firstClass = classResults[0];

    tips.push({
      tip: `Use get_object_info(objectType="class", name="${firstClass.name}") for full method signatures and inheritance chain`,
      tool: 'get_object_info'
    });

    tips.push({
      tip: `Use get_object_info(objectType="class", name="${firstClass.name}", options={members:"names"}) for an IntelliSense-style method/field list`,
      tool: 'get_object_info'
    });

    if (firstClass.usageFrequency && firstClass.usageFrequency > 10) {
      tips.push({
        tip: `Use analyze_code(mode="api-usage", apiName="${firstClass.name}") to see how this frequently-used class is initialized and used`,
        tool: 'analyze_code'
      });
    }
  }

  if (methodResults.length > 0) {
    tips.push({
      tip: 'Use get_object_info(objectType="class", name=...) to see full method implementation and parameters'
    });
  }

  if (searchType === 'all' && results.length > 15) {
    tips.push({
      tip: 'Too many results? Use type parameter to filter: type="class", type="table", type="method"'
    });
  }

  const hasHelpers = results.some(r => r.name.includes('Helper'));
  if (hasHelpers) {
    tips.push({
      tip: 'Helper classes often have validate(), find(), and create() methods. Use analyze_code(mode="completeness", className=...) to check for missing patterns',
      tool: 'analyze_code'
    });
  }

  return tips;
}

/**
 * Format rich context as markdown text
 */
export function formatRichContext(
  _query: string,
  results: XppSymbol[],
  richContext: RichContext,
  options: RichContextOptions = {}
): string {
  let output = '';

  const resultGroups = groupResultsByType(results);

  for (const [type, items] of Object.entries(resultGroups)) {
    if (items.length === 0) continue;

    output += `\n## ${type.toUpperCase()} (${items.length})\n\n`;

    items.slice(0, 10).forEach(item => {
      output += formatSymbolWithMetadata(item);
    });

    if (items.length > 10) {
      output += `\n... and ${items.length - 10} more. Use larger limit to see all.\n`;
    }
  }

  if (options.includeRelated !== false && richContext.relatedSearches && richContext.relatedSearches.length > 0) {
    output += '\n\n## 🔍 Related Searches\n';
    richContext.relatedSearches.forEach(rel => {
      output += `\n• **"${rel.query}"** - ${rel.reason}`;
    });
  }

  if (options.includePatterns !== false && richContext.commonPatterns && richContext.commonPatterns.length > 0) {
    output += '\n\n## 💡 Common Patterns\n';
    richContext.commonPatterns.forEach(pattern => {
      const freq = pattern.frequency ? ` (found ${pattern.frequency}×)` : '';
      output += `\n• ${pattern.pattern}${freq}`;
    });
  }

  if (options.includeTips !== false && richContext.tips && richContext.tips.length > 0) {
    output += '\n\n## 📌 Tips\n';
    richContext.tips.forEach(tip => {
      const toolHint = tip.tool ? ` → Use \`${tip.tool}()\`` : '';
      output += `\n• ${tip.tip}${toolHint}`;
    });
  }

  return output;
}

/**
 * Group results by type.
 *
 * Groups are built dynamically from the types actually present — a hardcoded
 * group list silently dropped every other type (form, query, view, report,
 * security-*, menu-item-*, *-extension) from the rendered output while the
 * header still claimed the full match count.
 */
const TYPE_DISPLAY_ORDER = ['class', 'table', 'method', 'field', 'enum', 'edt'];

function groupResultsByType(results: XppSymbol[]): Record<string, XppSymbol[]> {
  const groups: Record<string, XppSymbol[]> = {};
  for (const type of TYPE_DISPLAY_ORDER) groups[type] = [];

  results.forEach(r => {
    (groups[r.type] ??= []).push(r);
  });

  return groups;
}

/**
 * Format a single symbol with rich metadata
 */
function formatSymbolWithMetadata(symbol: XppSymbol): string {
  let output = `📦 **${symbol.name}**\n`;

  // Marked, never hidden: the row is a real index hit whose file is not on this
  // machine, and the caller needs both halves of that. See renderStaleSearchRowsNote.
  if (symbol.staleIndexRow) {
    output += `   └─ ${STALE_ROW_MARKER}\n`;
  }

  if (symbol.parentName) {
    output += `   └─ Parent: ${symbol.parentName}\n`;
  }

  if (symbol.extendsClass && symbol.extendsClass !== 'Object') {
    output += `   └─ Extends: ${symbol.extendsClass}\n`;
  }

  if (symbol.signature) {
    output += `   └─ Signature: ${symbol.signature}\n`;
  }

  if (symbol.description) {
    output += `   └─ ${symbol.description}\n`;
  }

  if (symbol.usageFrequency && symbol.usageFrequency > 5) {
    output += `   └─ ⭐ Frequently used (${symbol.usageFrequency} references)\n`;
  }

  output += '\n';
  return output;
}
