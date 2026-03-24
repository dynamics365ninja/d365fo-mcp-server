/**
 * Get Method Signature Tool
 * Extract exact method signature for Chain of Command (CoC) extensions
 * Returns method modifiers, return type, parameters with types
 *
 * PRIMARY: C# bridge (IMetadataProvider) via tryBridgeMethodSignature.
 * SQLite is used only as a gate (verify class/method exists) and for cache.
 */

import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { XppServerContext } from '../types/context.js';
import { buildObjectTypeMismatchMessage } from '../utils/metadataResolver.js';
import type { BridgeClient } from '../bridge/bridgeClient.js';


const GetMethodSignatureArgsSchema = z.object({
  className: z.string().describe('Name of the class containing the method'),
  methodName: z.string().describe('Name of the method'),
  modelName: z.string().optional().describe('Model name (auto-detected if not provided)'),
  includeWorkspace: z.boolean().optional().default(false).describe('Include workspace files'),
  workspacePath: z.string().optional().describe('Path to workspace'),
  includeCocTemplate: z.boolean().optional().default(false).describe('Include CoC extension template (default false to save tokens — set true only when about to write a CoC extension)'),
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
    const { symbolIndex, cache } = context;
    const { className, methodName, modelName } = args;

    // Check cache first (method signatures are static — 24h TTL via setClassInfo)
    const cacheKey = `xpp:method-sig:${className}:${methodName}`;
    const cachedResult = await cache.get<any>(cacheKey);
    if (cachedResult) {
      return cachedResult;
    }

    // 1. Find the class/table/view — methods live on all three object types
    const OBJECT_TYPES = `('class', 'table', 'view', 'data-entity')`;
    let classRow: any;
    if (modelName) {
      classRow = symbolIndex.db.prepare(`
        SELECT file_path, model, name, type
        FROM symbols
        WHERE type IN ${OBJECT_TYPES} AND name = ? AND model = ?
        ORDER BY CASE type WHEN 'class' THEN 0 WHEN 'table' THEN 1 ELSE 2 END
        LIMIT 1
      `).get(className, modelName);
    } else {
      classRow = symbolIndex.db.prepare(`
        SELECT file_path, model, name, type
        FROM symbols
        WHERE type IN ${OBJECT_TYPES} AND name = ?
        ORDER BY CASE type WHEN 'class' THEN 0 WHEN 'table' THEN 1 ELSE 2 END, model
        LIMIT 1
      `).get(className);
    }

    if (!classRow) {
      const typeMismatch = buildObjectTypeMismatchMessage(symbolIndex.db, className);
      return {
        content: [
          {
            type: 'text',
            text: `❌ Object "${className}" not found. Make sure it's indexed.${typeMismatch}`,
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
      throw new Error(`Method "${methodName}" not found in ${classRow.type} "${className}".`);
    }

    // 3. C# bridge (IMetadataProvider — live source, always current)
    // Bridge returns full source → parse signature locally + detect obsolete.
    // This is the sole data path — eliminates JSON file I/O and XML parsing.
    const includeCoc = args.includeCocTemplate ?? false;
    const bridgeSignature = await tryBridgeMethodSignature(
      context.bridge, className, methodName, classRow.model, includeCoc, cache, cacheKey,
    );
    if (bridgeSignature) return bridgeSignature;

    return {
      content: [{
        type: 'text',
        text: `❌ Method "${methodName}" found in index for ${classRow.type} "${className}" but bridge returned no source.\n` +
          `Ensure the C# bridge is running and has access to D365FO metadata.`,
      }],
      isError: true,
    };

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
 * Try C# bridge for method signature.
 * Bridge returns full source → parse signature locally + detect obsolete.
 * This is the fastest path on Windows VMs (one IPC call, no JSON/XML file I/O).
 * Returns null to signal fallback when bridge is unavailable.
 */
async function tryBridgeMethodSignature(
  bridge: BridgeClient | undefined,
  className: string,
  methodName: string,
  modelName: string,
  includeCoc: boolean,
  cache: any,
  cacheKey: string,
): Promise<any | null> {
  if (!bridge?.isReady || !bridge.metadataAvailable) return null;
  try {
    const ms = await bridge.getMethodSource(className, methodName);
    if (!ms.found || !ms.source) return null;

    // Parse signature from full source — same function used by the XML path
    const signature = parseMethodSignature(ms.source, methodName);
    if (!signature) return null;

    const obsoleteWarning = detectObsolete(ms.source);
    const result = formatOutput(className, methodName, signature, modelName, includeCoc, obsoleteWarning);
    await cache.setClassInfo(cacheKey, result);
    return result;
  } catch (e) {
    console.error(`[methodSignature] Bridge getMethodSource(${className}, ${methodName}) failed: ${e}`);
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

  const paramStrings = parameters.map(p => {
    let ps = p.type + ' ' + p.name;
    if (p.defaultValue) {
      ps += ' = ' + p.defaultValue;
    }
    return ps;
  });
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
 * Detect [SysObsolete] or [Obsolete] attribute in X++ source and return a warning string.
 * Returns an empty string when no obsolete marker is found.
 */
function detectObsolete(source: string): string {
  const m = source.match(/\[\s*SysObsolete\s*\(\s*['"]([^'"]*)['"]|\[\s*Obsolete\s*\(\s*['"]([^'"]*)['"]/i);
  if (!m) return '';
  const msg = m[1] ?? m[2] ?? '';
  return `\n> ⚠️ **This method is marked obsolete. Do NOT generate calls to it.**${
    msg ? `\n> Replacement hint: _"${msg}"_` : ''
  }\n> Use the stated replacement instead.`;
}

function formatOutput(
  className: string,
  methodName: string,
  signature: MethodSignature,
  modelName: string,
  includeCocTemplate: boolean = false,
  obsoleteWarning: string = ''
): any {
  let output = `# Method: \`${className}.${methodName}\`\n`;
  output += `**Model:** ${modelName}  **Returns:** ${signature.returnType}  **Modifiers:** ${signature.modifiers.join(', ') || 'none'}\n`;
  if (obsoleteWarning) output += obsoleteWarning + '\n';
  output += `\n\`\`\`xpp\n${signature.signature}\n\`\`\`\n`;

  if (signature.parameters.length > 0) {
    output += `\n**Parameters:** ${signature.parameters.map(p => `${p.type} ${p.name}${p.defaultValue ? ` = ${p.defaultValue}` : ''}`).join(', ')}\n`;
  }

  if (includeCocTemplate) {
    output += `\n## Chain of Command Template\n\`\`\`xpp\n${signature.cocTemplate}\`\`\`\n`;
    output += `Replace \`OriginalClassName\` with \`${className}\`.\n`;
  } else {
    output += `\n> 💡 Pass \`includeCocTemplate: true\` to get the CoC extension template.\n`;
  }

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
