/**
 * Get Method Signature Tool
 * Extract exact method signature for Chain of Command (CoC) extensions
 * Returns method modifiers, return type, parameters with types
 */

import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { XppServerContext } from '../types/context.js';
import { promises as fs } from 'fs';
import { parseStringPromise } from 'xml2js';
import { readMethodMetadata, buildObjectTypeMismatchMessage, type ExtractedMethod } from '../utils/metadataResolver.js';


const GetMethodSignatureArgsSchema = z.object({
  className: z.string().describe('Name of the class containing the method'),
  methodName: z.string().describe('Name of the method'),
  modelName: z.string().optional().describe('Model name (auto-detected if not provided)'),
  includeWorkspace: z.boolean().optional().default(false).describe('Include workspace files'),
  workspacePath: z.string().optional().describe('Path to workspace'),
});

interface MethodSignature {
  modifiers: string[];
  returnType: string;
  methodName: string;
  parameters: Array<{
    type: string;
    name: string;
    defaultValue?: string;
  }>;
  signature: string;
  cocTemplate: string;
}

export async function getMethodSignatureTool(request: CallToolRequest, context: XppServerContext) {
  try {
    const args = GetMethodSignatureArgsSchema.parse(request.params.arguments);
    const { symbolIndex } = context;
    const { className, methodName, modelName } = args;

    // 1. Find the class
    let stmt;
    if (modelName) {
      stmt = symbolIndex.db.prepare(`
        SELECT file_path, model, name
        FROM symbols
        WHERE type = 'class' AND name = ? AND model = ?
        LIMIT 1
      `);
      var classRow = stmt.get(className, modelName) as any;
    } else {
      stmt = symbolIndex.db.prepare(`
        SELECT file_path, model, name
        FROM symbols
        WHERE type = 'class' AND name = ?
        ORDER BY model
        LIMIT 1
      `);
      var classRow = stmt.get(className) as any;
    }

    if (!classRow) {
      const typeMismatch = buildObjectTypeMismatchMessage(symbolIndex.db, className);
      return {
        content: [
          {
            type: 'text',
            text: `❌ Class "${className}" not found. Make sure it's indexed.${typeMismatch}`,
          },
        ],
        isError: true,
      };
    }

    // 2. Find the method in database
    const methodStmt = symbolIndex.db.prepare(`
      SELECT name, signature, parent_name, file_path
      FROM symbols
      WHERE type = 'method'
        AND name = ?
        AND parent_name = ?
      LIMIT 1
    `);

    const methodRow = methodStmt.get(methodName, className);

    if (!methodRow) {
      throw new Error(`Method "${methodName}" not found in class "${className}".`);
    }

    // 3a. PRIMARY: extracted-metadata JSON (always available, no file path issues)
    const extractedMethod = await readMethodMetadata(classRow.model, className, methodName);
    if (extractedMethod) {
      const jsonSignature = buildSignatureFromExtractedMethod(extractedMethod);
      return formatOutput(className, methodName, jsonSignature, classRow.model);
    }

    // 3b. SECONDARY: XML file (only works when running on D365FO VM with correct paths)
    let methodSignature: MethodSignature | null = null;
    try {
      const xmlContent = await fs.readFile(classRow.file_path, 'utf-8');
      const xmlObj = await parseStringPromise(xmlContent);
      methodSignature = extractMethodSignature(xmlObj, methodName);
    } catch {
      // File not accessible (build-agent path) — fall through to DB fallback
    }

    if (methodSignature) {
      return formatOutput(className, methodName, methodSignature, classRow.model);
    }

    // 3c. FALLBACK: reconstruct from DB signature column
    const fallbackSignature = buildFallbackSignature(methodRow as any);
    return formatOutput(className, methodName, fallbackSignature, classRow.model);

  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `❌ Error getting method signature: ${error instanceof Error ? error.message : 'Unknown error'}`,
        },
      ],
      isError: true,
    };
  }
}

/**
 * Build a MethodSignature from an ExtractedMethod (JSON metadata).
 * This is the most accurate source — structured data, no regex parsing.
 */
function buildSignatureFromExtractedMethod(method: ExtractedMethod): MethodSignature {
  const modifiers: string[] = [];
  if (method.visibility && method.visibility !== 'public') modifiers.push(method.visibility);
  else if (method.visibility === 'public') modifiers.push('public');
  if (method.isStatic) modifiers.push('static');

  const returnType = method.returnType || 'void';
  const parameters = method.parameters.map(p => ({
    type: p.type,
    name: p.name,
    ...(p.defaultValue ? { defaultValue: p.defaultValue } : {}),
  }));

  const signature = buildSignatureString(modifiers, returnType, method.name, parameters);
  const cocTemplate = buildCoCTemplate(modifiers, returnType, method.name, parameters);

  return { modifiers, returnType, methodName: method.name, parameters, signature, cocTemplate };
}

/**
 * Extract method signature from parsed XML
 */
function extractMethodSignature(xmlObj: any, methodName: string): MethodSignature | null {
  try {
    const axClass = xmlObj.AxClass;
    if (!axClass || !axClass.Methods || !axClass.Methods[0] || !axClass.Methods[0].Method) {
      return null;
    }

    const methods = axClass.Methods[0].Method;
    const method = methods.find((m: any) => m.Name && m.Name[0] === methodName);

    if (!method) {
      return null;
    }

    // Parse method source to extract signature
    const source = method.Source ? method.Source[0] : '';
    const signature = parseMethodSignature(source, methodName);

    return signature;

  } catch (error) {
    return null;
  }
}

/**
 * Parse method signature from source code
 */
function parseMethodSignature(source: string, methodName: string): MethodSignature | null {
  if (!source) return null;

  // Find method declaration line
  const lines = source.split('\n');
  let declarationLine = '';

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.includes(methodName) && trimmed.includes('(')) {
      declarationLine = trimmed;
      break;
    }
  }

  if (!declarationLine) return null;

  // Parse modifiers (public, private, protected, static, final, etc.)
  const modifiers: string[] = [];
  const modifierKeywords = ['public', 'private', 'protected', 'static', 'final', 'abstract', 'display'];
  
  for (const keyword of modifierKeywords) {
    if (declarationLine.toLowerCase().includes(keyword)) {
      modifiers.push(keyword);
    }
  }

  // Parse return type
  let returnType = 'void';
  const returnTypeMatch = declarationLine.match(/(?:public|private|protected|static|final)?\s+(\w+)\s+\w+\s*\(/);
  if (returnTypeMatch) {
    returnType = returnTypeMatch[1];
  }

  // Parse parameters
  const parametersMatch = declarationLine.match(/\((.*?)\)/);
  const parameters: Array<{ type: string; name: string; defaultValue?: string }> = [];

  if (parametersMatch && parametersMatch[1].trim()) {
    const paramString = parametersMatch[1];
    const paramParts = paramString.split(',');

    for (const part of paramParts) {
      const trimmed = part.trim();
      const paramMatch = trimmed.match(/(\w+)\s+(_?\w+)(?:\s*=\s*(.+))?/);
      
      if (paramMatch) {
        const param: any = {
          type: paramMatch[1],
          name: paramMatch[2],
        };
        
        if (paramMatch[3]) {
          param.defaultValue = paramMatch[3].trim();
        }
        
        parameters.push(param);
      }
    }
  }

  // Build full signature
  const signature = buildSignatureString(modifiers, returnType, methodName, parameters);

  // Build CoC template
  const cocTemplate = buildCoCTemplate(modifiers, returnType, methodName, parameters);

  return {
    modifiers,
    returnType,
    methodName,
    parameters,
    signature,
    cocTemplate,
  };
}

/**
 * Build signature string
 */
function buildSignatureString(
  modifiers: string[],
  returnType: string,
  methodName: string,
  parameters: Array<{ type: string; name: string; defaultValue?: string }>
): string {
  let sig = '';

  if (modifiers.length > 0) {
    sig += modifiers.join(' ') + ' ';
  }

  sig += returnType + ' ' + methodName + '(';

  const paramStrings = parameters.map(p => {
    let ps = p.type + ' ' + p.name;
    if (p.defaultValue) {
      ps += ' = ' + p.defaultValue;
    }
    return ps;
  });

  sig += paramStrings.join(', ');
  sig += ')';

  return sig;
}

/**
 * Build Chain of Command template
 */
function buildCoCTemplate(
  modifiers: string[],
  returnType: string,
  methodName: string,
  parameters: Array<{ type: string; name: string; defaultValue?: string }>
): string {
  let template = '';

  // Add modifiers (replace public/private/protected with method attribute)
  const cocModifiers = modifiers.filter(m => !['public', 'private', 'protected'].includes(m));
  
  template += '[ExtensionOf(classStr(OriginalClassName))]\n';
  template += 'final class OriginalClassName_Extension\n';
  template += '{\n';
  template += '\t';

  if (cocModifiers.length > 0) {
    template += cocModifiers.join(' ') + ' ';
  }

  template += returnType + ' ' + methodName + '(';

  const paramStrings = parameters.map(p => p.type + ' ' + p.name);
  template += paramStrings.join(', ');
  template += ')\n';
  template += '\t{\n';
  template += '\t\t// Pre-processing logic\n';
  template += '\t\t\n';

  // Build next() call
  template += '\t\t';
  if (returnType !== 'void') {
    template += returnType + ' ret = ';
  }
  
  template += 'next ' + methodName + '(';
  template += parameters.map(p => p.name).join(', ');
  template += ');\n';

  template += '\t\t\n';
  template += '\t\t// Post-processing logic\n';
  template += '\t\t\n';

  if (returnType !== 'void') {
    template += '\t\treturn ret;\n';
  }

  template += '\t}\n';
  template += '}\n';

  return template;
}

/**
 * Build fallback signature from database row
 */
function buildFallbackSignature(methodRow: any): MethodSignature {
  // Parse modifiers and return type from signature if available
  const signature = methodRow.signature || '';
  
  // Parse modifiers from signature
  const modifiers: string[] = [];
  const keywords = ['public', 'private', 'protected', 'static', 'final', 'display', 'edit', 'client', 'server'];
  for (const keyword of keywords) {
    if (signature.toLowerCase().includes(keyword.toLowerCase())) {
      modifiers.push(keyword);
    }
  }
  
  // Parse return type - find word before method name in signature
  let returnType = 'void';
  const signatureMatch = signature.match(/\b(\w+)\s+\w+\s*\(/);
  if (signatureMatch) {
    returnType = signatureMatch[1];
  }
  
  const methodName = methodRow.name;
  
  // Parse parameters from signature
  const parametersMatch = signature.match(/\((.*?)\)/);
  const parameters: Array<{ type: string; name: string }> = [];

  if (parametersMatch && parametersMatch[1].trim()) {
    const paramString = parametersMatch[1];
    const paramParts = paramString.split(',');

    for (const part of paramParts) {
      const trimmed = part.trim();
      const paramMatch = trimmed.match(/(\w+)\s+(_?\w+)/);
      
      if (paramMatch) {
        parameters.push({
          type: paramMatch[1],
          name: paramMatch[2],
        });
      }
    }
  }

  const fullSignature = buildSignatureString(modifiers, returnType, methodName, parameters);
  const cocTemplate = buildCoCTemplate(modifiers, returnType, methodName, parameters);

  return {
    modifiers,
    returnType,
    methodName,
    parameters,
    signature: fullSignature,
    cocTemplate,
  };
}

/**
 * Format output
 */
function formatOutput(
  className: string,
  methodName: string,
  signature: MethodSignature,
  modelName: string
): any {
  let output = `# Method Signature: \`${className}.${methodName}\`\n\n`;
  output += `**Model:** ${modelName}\n\n`;

  output += `## 📝 Signature\n\n`;
  output += `\`\`\`xpp\n${signature.signature}\n\`\`\`\n\n`;

  output += `## 🔧 Details\n\n`;
  output += `**Modifiers:** ${signature.modifiers.join(', ') || 'none'}\n`;
  output += `**Return Type:** ${signature.returnType}\n`;
  output += `**Parameters:** ${signature.parameters.length}\n\n`;

  if (signature.parameters.length > 0) {
    output += `### Parameters:\n\n`;
    for (const param of signature.parameters) {
      output += `- **${param.name}**: ${param.type}`;
      if (param.defaultValue) {
        output += ` = ${param.defaultValue}`;
      }
      output += '\n';
    }
    output += '\n';
  }

  output += `## 🔗 Chain of Command Template\n\n`;
  output += `Use this template to extend the method:\n\n`;
  output += `\`\`\`xpp\n${signature.cocTemplate}\`\`\`\n\n`;

  output += `**Note:** Replace \`OriginalClassName\` with \`${className}\` in the template.\n`;

  return {
    content: [
      {
        type: 'text',
        text: output,
      },
    ],
  };
}

export const getMethodSignatureToolDefinition = {
  name: 'get_method_signature',
  description: '🔧 Extract exact method signature for Chain of Command (CoC) extensions. Returns method modifiers, return type, parameters with types, and generates ready-to-use CoC template. Essential for creating extensions without signature mismatches.',
  inputSchema: GetMethodSignatureArgsSchema,
};
