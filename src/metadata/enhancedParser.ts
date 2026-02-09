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

  /**
   * Detect pattern type for a class
   */
  detectClassPatternType(className: string, methods: XppMethodInfo[]): string {
    // Pattern detection based on class name suffix
    if (className.endsWith('Helper')) return 'Helper';
    if (className.endsWith('Service')) return 'Service';
    if (className.endsWith('Controller')) return 'Controller';
    if (className.endsWith('Handler')) return 'Handler';
    if (className.endsWith('Repository') || className.endsWith('Repo')) return 'Repository';
    if (className.endsWith('Manager')) return 'Manager';
    if (className.endsWith('Factory')) return 'Factory';
    if (className.endsWith('Builder')) return 'Builder';
    if (className.endsWith('Processor')) return 'Processor';
    if (className.endsWith('Validator')) return 'Validator';
    if (className.endsWith('Provider')) return 'Provider';
    if (className.endsWith('Adapter')) return 'Adapter';
    
    // Pattern detection based on method patterns
    const methodNames = methods.map(m => m.name.toLowerCase());
    
    // Repository pattern: find, get, save, update, delete
    const repoMethods = ['find', 'get', 'save', 'update', 'delete', 'insert'];
    if (methodNames.filter(n => repoMethods.some(rm => n.includes(rm))).length >= 3) {
      return 'Repository';
    }
    
    // Service pattern: process, execute, handle, run
    const serviceMethods = ['process', 'execute', 'handle', 'run', 'perform'];
    if (methodNames.filter(n => serviceMethods.some(sm => n.includes(sm))).length >= 2) {
      return 'Service';
    }
    
    // Validator pattern: validate, check, verify, isValid
    const validatorMethods = ['validate', 'check', 'verify', 'isvalid'];
    if (methodNames.filter(n => validatorMethods.some(vm => n.includes(vm))).length >= 2) {
      return 'Validator';
    }
    
    return 'Unknown';
  }

  /**
   * Generate typical usage patterns from method source
   */
  generateTypicalUsages(className: string, methods: XppMethodInfo[]): string[] {
    const usages: string[] = [];
    
    // Look for static methods - these are common entry points
    const staticMethods = methods.filter(m => m.isStatic);
    for (const method of staticMethods.slice(0, 3)) {
      const params = method.parameters.map(p => this.generateExampleValue(p.type)).join(', ');
      usages.push(`${className}::${method.name}(${params});`);
    }
    
    // Look for main/run methods
    const mainMethod = methods.find(m => m.name === 'main' && m.isStatic);
    if (mainMethod) {
      usages.push(`${className}::main(args);`);
    }
    
    // Instance usage pattern
    const publicMethods = methods.filter(m => !m.isStatic && m.visibility === 'public');
    if (publicMethods.length > 0) {
      const method = publicMethods[0];
      const params = method.parameters.map(p => this.generateExampleValue(p.type)).join(', ');
      usages.push(`${className} instance = new ${className}();\ninstance.${method.name}(${params});`);
    }
    
    return usages;
  }

  /**
   * Generate example value based on type
   */
  private generateExampleValue(typeName: string): string {
    const lower = typeName.toLowerCase();
    
    if (lower.includes('int') || lower.includes('recid')) return '0';
    if (lower.includes('str') || lower.includes('string')) return '""';
    if (lower.includes('bool')) return 'false';
    if (lower.includes('date')) return 'today()';
    if (lower.includes('datetime')) return 'DateTimeUtil::utcNow()';
    if (lower.includes('real')) return '0.0';
    if (lower.includes('guid')) return 'newGuid()';
    
    return `${typeName.toLowerCase()}Value`;
  }

  /**
   * Analyze method relationships and generate related methods list
   */
  generateRelatedMethods(method: XppMethodInfo, allMethods: XppMethodInfo[]): string[] {
    const related = new Set<string>();
    
    // Methods that share similar names (prefix/suffix)
    const baseMethodName = method.name.replace(/(get|set|is|has|can|validate|check)/, '');
    for (const other of allMethods) {
      if (other.name !== method.name && other.name.includes(baseMethodName)) {
        related.add(other.name);
      }
    }
    
    // Methods called by this method
    if (method.methodCalls) {
      for (const call of method.methodCalls) {
        const found = allMethods.find(m => m.name === call);
        if (found) {
          related.add(call);
        }
      }
    }
    
    // Methods with similar tags
    if (method.tags) {
      for (const other of allMethods) {
        if (other.name !== method.name && other.tags) {
          const commonTags = method.tags.filter(t => other.tags?.includes(t));
          if (commonTags.length >= 2) {
            related.add(other.name);
          }
        }
      }
    }
    
    return Array.from(related).slice(0, 10);
  }

  /**
   * Build API patterns from method source code
   */
  buildApiPatterns(_className: string, method: XppMethodInfo): any {
    const patterns: any = {
      initialization: [],
      commonSequences: [],
      errorHandling: []
    };
    
    const source = method.source;
    
    // Detect initialization patterns
    if (source.includes('new ')) {
      const initMatch = source.match(/new\s+\w+\s*\([^)]*\)/g);
      if (initMatch) {
        patterns.initialization = initMatch.slice(0, 3);
      }
    }
    
    // Detect method call sequences
    const lines = source.split('\n');
    const sequences: string[] = [];
    for (let i = 0; i < lines.length - 1; i++) {
      const line1 = lines[i].trim();
      const line2 = lines[i + 1].trim();
      if (line1.includes('.') && line2.includes('.')) {
        sequences.push(`${line1}\n${line2}`);
      }
    }
    patterns.commonSequences = sequences.slice(0, 3);
    
    // Detect error handling patterns
    if (source.includes('try') || source.includes('catch')) {
      const tryMatch = source.match(/try\s*{[^}]+}\s*catch[^{]*{[^}]+}/s);
      if (tryMatch) {
        patterns.errorHandling.push(tryMatch[0].slice(0, 200));
      }
    }
    
    return patterns;
  }
}