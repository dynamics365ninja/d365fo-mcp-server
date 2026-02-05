/**
 * Enhanced X++ Metadata Parser
 * Extension of xmlParser.ts with richer metadata extraction for better Copilot integration
 */

import type {
  XppClassInfo,
  XppMethodInfo,
} from './types.js';

/**
 * Enhanced method information with additional context
 */
export interface EnhancedMethodInfo extends XppMethodInfo {
  sourceSnippet?: string;       // First 10 lines for preview
  complexity?: number;          // Complexity score
  usedTypes?: string[];         // Classes/tables used in method
  methodCalls?: string[];       // Methods called within this method
  tags?: string[];              // Semantic tags (validation, query, etc.)
  inlineComments?: string;      // Extracted inline comments
}

/**
 * Enhanced class information
 */
export interface EnhancedClassInfo extends XppClassInfo {
  tags?: string[];
  relationships?: {
    extends?: string;
    implements?: string[];
    uses?: string[];            // Other classes used
  };
}

export class EnhancedXppParser {
  constructor() {
    // Enhanced parser works with already parsed XML data
  }

  /**
   * Extract semantic tags from method name and source code
   */
  extractSemanticTags(source: string, className: string, methodName: string): string[] {
    const tags = new Set<string>();
    
    // Tags based on method name patterns
    const namePatterns: Record<string, RegExp> = {
      'validation': /validate|check|verify|isValid|canSubmit/i,
      'initialization': /init|create|new|construct|setup|build/i,
      'data-modification': /update|modify|change|set|edit|save|write/i,
      'query': /find|select|query|search|get|fetch|load|read/i,
      'deletion': /delete|remove|clear|purge|drop/i,
      'calculation': /calculate|compute|sum|total|aggregate/i,
      'conversion': /convert|transform|parse|format|serialize/i,
      'event-handler': /on[A-Z]|handle|process[A-Z]/i,
    };
    
    for (const [tag, pattern] of Object.entries(namePatterns)) {
      if (pattern.test(methodName)) {
        tags.add(tag);
      }
    }
    
    // Tags based on code content
    const contentPatterns: Record<string, RegExp> = {
      'transaction': /\b(ttsbegin|ttscommit|ttsabort)\b/i,
      'error-handling': /\b(throw|error\(|warning\(|try|catch)\b/i,
      'database-query': /\bselect\b.*\bwhere\b/is,
      'set-based': /\b(insert_recordset|update_recordset|delete_from)\b/i,
      'loop': /\b(while|for|do)\s*\(/i,
      'conditional': /\bif\s*\(/i,
      'async': /\basync\b/i,
      'static-method': /\bstatic\b/i,
    };
    
    for (const [tag, pattern] of Object.entries(contentPatterns)) {
      if (pattern.test(source)) {
        tags.add(tag);
      }
    }
    
    // Tags based on class name (domain context)
    const classPatterns: Record<string, RegExp> = {
      'customer': /^Cust/,
      'vendor': /^Vend/,
      'inventory': /^Invent/,
      'sales': /^Sales/,
      'purchasing': /^Purch/,
      'ledger': /^Ledger/,
      'tax': /^Tax/,
      'project': /^Proj/,
      'warehouse': /^(WMS|WHs)/,
      'production': /^Prod/,
    };
    
    for (const [tag, pattern] of Object.entries(classPatterns)) {
      if (pattern.test(className)) {
        tags.add(tag);
      }
    }
    
    return Array.from(tags);
  }

  /**
   * Calculate complexity score for a method
   */
  calculateComplexity(source: string): number {
    const lines = source.split('\n').filter(line => line.trim().length > 0).length;
    
    // Count control structures
    const ifCount = (source.match(/\bif\s*\(/gi) || []).length;
    const loopCount = (source.match(/\b(for|while|do)\s*\(/gi) || []).length;
    const switchCount = (source.match(/\bswitch\s*\(/gi) || []).length;
    const caseCount = (source.match(/\bcase\b/gi) || []).length;
    const catchCount = (source.match(/\bcatch\b/gi) || []).length;
    
    // Complexity formula: lines + weighted control structures
    return lines + (ifCount * 2) + (loopCount * 3) + (switchCount * 2) + caseCount + (catchCount * 2);
  }

  /**
   * Extract types (classes/tables) used in the source code
   */
  extractUsedTypes(source: string): string[] {
    const types = new Set<string>();
    
    // Pattern: TypeName variableName or TypeName::staticMethod
    const patterns = [
      /\b([A-Z][a-zA-Z0-9_]*)\s+[a-z]/g,           // TypeName varName
      /\b([A-Z][a-zA-Z0-9_]*)::/g,                  // TypeName::
      /new\s+([A-Z][a-zA-Z0-9_]*)\s*\(/g,          // new TypeName(
    ];
    
    for (const pattern of patterns) {
      let match;
      while ((match = pattern.exec(source)) !== null) {
        const typeName = match[1];
        // Filter out common keywords
        if (!['Int', 'String', 'Real', 'Boolean', 'Date', 'DateTime', 'Guid', 'Int64'].includes(typeName)) {
          types.add(typeName);
        }
      }
    }
    
    return Array.from(types);
  }

  /**
   * Extract method calls from source code
   */
  extractMethodCalls(source: string): string[] {
    const methods = new Set<string>();
    
    // Pattern: .methodName( or ::methodName(
    const patterns = [
      /\.([a-z][a-zA-Z0-9_]*)\s*\(/g,              // .methodName(
      /::([a-z][a-zA-Z0-9_]*)\s*\(/g,              // ::methodName(
    ];
    
    for (const pattern of patterns) {
      let match;
      while ((match = pattern.exec(source)) !== null) {
        methods.add(match[1]);
      }
    }
    
    return Array.from(methods);
  }

  /**
   * Extract inline comments from source code
   */
  extractInlineComments(source: string): string {
    const commentLines: string[] = [];
    const lines = source.split('\n');
    
    for (const line of lines) {
      // Single-line comments
      const commentMatch = line.match(/\/\/\s*(.+)/);
      if (commentMatch) {
        commentLines.push(commentMatch[1].trim());
      }
      
      // Multi-line comment blocks
      const blockMatch = line.match(/\/\*\s*(.+?)\s*\*\//);
      if (blockMatch) {
        commentLines.push(blockMatch[1].trim());
      }
    }
    
    return commentLines.join(' ');
  }

  /**
   * Get first N lines of code
   */
  getFirstLines(source: string, lineCount: number = 10): string {
    const lines = source.split('\n').slice(0, lineCount);
    let result = lines.join('\n');
    
    if (source.split('\n').length > lineCount) {
      result += '\n// ...';
    }
    
    return result;
  }

  /**
   * Parse method with enhanced metadata
   */
  parseMethodEnhanced(method: XppMethodInfo, parentClass: string): EnhancedMethodInfo {
    // method parameter is already a parsed XppMethodInfo object with lowercase properties
    const source = method.source || '';
    const methodName = method.name || 'unknown';
    
    // Enhanced metadata
    const enhanced: EnhancedMethodInfo = {
      ...method,
      sourceSnippet: this.getFirstLines(source, 10),
      complexity: this.calculateComplexity(source),
      usedTypes: this.extractUsedTypes(source),
      methodCalls: this.extractMethodCalls(source),
      tags: this.extractSemanticTags(source, parentClass, methodName),
      inlineComments: this.extractInlineComments(source),
    };
    
    return enhanced;
  }

  /**
   * Create usage pattern examples from method source
   */
  generateUsageExample(className: string, method: EnhancedMethodInfo): string | undefined {
    const isStatic = method.isStatic;
    const params = method.parameters.map(p => {
      // Generate example values based on type
      if (p.type.toLowerCase().includes('int')) return '0';
      if (p.type.toLowerCase().includes('str')) return '""';
      if (p.type.toLowerCase().includes('bool')) return 'false';
      if (p.type.toLowerCase().includes('date')) return 'today()';
      return `${p.name}Value`;
    }).join(', ');
    
    if (isStatic) {
      return `${className}::${method.name}(${params});`;
    } else {
      return `${className} obj = new ${className}();\nobj.${method.name}(${params});`;
    }
  }

  /**
   * Extract all classes/tables used by a class
   */
  extractClassDependencies(classInfo: XppClassInfo): string[] {
    const dependencies = new Set<string>();
    
    // Add inherited class
    if (classInfo.extends) {
      dependencies.add(classInfo.extends);
    }
    
    // Add implemented interfaces
    classInfo.implements?.forEach(i => dependencies.add(i));
    
    // Extract from all methods
    for (const method of classInfo.methods) {
      const types = this.extractUsedTypes(method.source);
      types.forEach(t => dependencies.add(t));
    }
    
    return Array.from(dependencies);
  }

  /**
   * Generate comprehensive tags for a class
   */
  generateClassTags(classInfo: XppClassInfo): string[] {
    const tags = new Set<string>();
    
    // Based on class name
    if (/Controller|Engine|Service|Manager/i.test(classInfo.name)) {
      tags.add('business-logic');
    }
    if (/Helper|Util|Tool/i.test(classInfo.name)) {
      tags.add('utility');
    }
    if (/Builder/i.test(classInfo.name)) {
      tags.add('builder-pattern');
    }
    if (/Factory/i.test(classInfo.name)) {
      tags.add('factory-pattern');
    }
    if (/Handler/i.test(classInfo.name)) {
      tags.add('event-handler');
    }
    
    // Based on class attributes
    if (classInfo.isAbstract) {
      tags.add('abstract');
    }
    if (classInfo.isFinal) {
      tags.add('final');
    }
    
    // Based on methods
    const hasMainMethod = classInfo.methods.some(m => m.name === 'main' && m.isStatic);
    if (hasMainMethod) {
      tags.add('runnable');
    }
    
    return Array.from(tags);
  }
}
