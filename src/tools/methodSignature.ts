/**
 * Get Method Signature Tool
 * Extract exact method signature for Chain of Command (CoC) extensions
 * Returns method modifiers, return type, parameters with types
 *
 * PRIMARY: C# bridge (IMetadataProvider) via tryBridgeMethodSignature.
 * SQLite is used only as a gate (verify class/method exists).
 */

import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { XppServerContext } from '../types/context.js';
import { buildObjectTypeMismatchMessage } from '../utils/metadataResolver.js';
import type { BridgeClient } from '../bridge/bridgeClient.js';
import type { XppMetadataParser } from '../metadata/xmlParser.js';
import { canonicalSymbolName } from '../utils/symbolLookup.js';

/** Object types that can own methods. */
const OBJECT_TYPES = ['class', 'table', 'view', 'data-entity'] as const;
const OBJECT_TYPES_SQL = `(${OBJECT_TYPES.map(t => `'${t}'`).join(', ')})`;


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
    const { symbolIndex, parser } = context;
    const { methodName, modelName } = args;
    const rdb = symbolIndex.getReadDb();

    // 1. Find the class/table/view — methods live on all three object types.
    // Resolve the caller's casing to the canonical AOT name first: X++ treats
    // AOT identifiers case-insensitively, but the probes below match by exact
    // name, so a mismatch would report a false "not found" (#686). Canonicalizing
    // once keeps those probes BINARY and on-index — `name = ? COLLATE NOCASE`
    // here would scan every class/table/view row instead (~86k rows, 4–8 s warm).
    const className = canonicalSymbolName(rdb, args.className, OBJECT_TYPES) ?? args.className;

    let classRow: any;
    if (modelName) {
      classRow = rdb.prepare(`
        SELECT file_path, model, name, type
        FROM symbols
        WHERE type IN ${OBJECT_TYPES_SQL} AND name = ? AND model = ?
        ORDER BY CASE type WHEN 'class' THEN 0 WHEN 'table' THEN 1 ELSE 2 END
        LIMIT 1
      `).get(className, modelName);
    } else {
      classRow = rdb.prepare(`
        SELECT file_path, model, name, type
        FROM symbols
        WHERE type IN ${OBJECT_TYPES_SQL} AND name = ?
        ORDER BY CASE type WHEN 'class' THEN 0 WHEN 'table' THEN 1 ELSE 2 END, model
        LIMIT 1
      `).get(className);
    }

    if (!classRow) {
      const typeMismatch = buildObjectTypeMismatchMessage(rdb, className);
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

    // 2. Find the method in database (advisory — delegates and SubscribesTo handlers may be absent)
    // COLLATE NOCASE on the method name is safe here: `parent_name` is canonical
    // and `type`/`parent_name` narrow the range to one object's members before
    // the case-insensitive comparison runs.
    const methodStmt = rdb.prepare(`
      SELECT name, signature, parent_name, file_path
      FROM symbols
      WHERE type = 'method'
        AND parent_name = ?
        AND name = ? COLLATE NOCASE
      LIMIT 1
    `);

    const methodRow = methodStmt.get(className, methodName);

    // 3. C# bridge (IMetadataProvider — live source, always current)
    const includeCoc = args.includeCocTemplate ?? false;
    const bridgeSignature = await tryBridgeMethodSignature(
      context.bridge, className, methodName, classRow.model, includeCoc,
    );
    if (bridgeSignature) return bridgeSignature;

    // Fallback: parse XML file from disk (same pattern as classInfo.ts)
    const xmlSignature = await tryXmlMethodSignature(
      parser, classRow.file_path, className, methodName, classRow.model, includeCoc, classRow.type,
    );
    if (xmlSignature) return xmlSignature;

    // Last resort: use SQLite signature column if available
    if ((methodRow as any)?.signature) {
      const sigText = (methodRow as any).signature as string;
      let output = `# Method: \`${className}.${methodName}\`\n`;
      output += `**Model:** ${classRow.model}\n`;
      output += `_Source: SQLite index (signature only — bridge and XML unavailable)_\n\n`;
      output += `\`\`\`xpp\n${sigText}\n\`\`\`\n`;
      output += `\n> ⚠️ CoC template not available without full method source. Start the C# bridge for full functionality.\n`;
      return { content: [{ type: 'text', text: output }] };
    }

    // classDeclaration is the class header pseudo-member — it has no
    // parenthesised signature and can't be parsed by the signature path.
    if (methodName.toLowerCase() === 'classdeclaration') {
      return {
        content: [{
          type: 'text',
          text: `ℹ️ \`${className}.classDeclaration\` is the class header, not a method — it has no signature.\n\n` +
            `Use \`get_method(className="${className}", methodName="classDeclaration", include="source")\` to read the declaration source, ` +
            `or \`get_object_info(objectType="class", name="${className}")\` for the class overview.`,
        }],
        isError: true,
      };
    }

    // Delegates and SubscribesTo handlers are commonly absent from the index.
    if (!methodRow) {
      return {
        content: [{
          type: 'text',
          text: `❌ Method **${className}.${methodName}** not found.\n\n` +
            `The method is not in the symbol index and could not be retrieved via bridge or XML.\n` +
            `This is common for:\n` +
            `- **Delegate methods** (declared with the \`delegate\` keyword)\n` +
            `- **Event handler subscriptions** (\`[SubscribesTo]\` handlers in extension classes)\n\n` +
            `Use \`get_object_info(objectType="class", name="${className}")\` to see all indexed methods.`,
        }],
        isError: true,
      };
    }

    return {
      content: [{
        type: 'text',
        text: `❌ Method "${methodName}" found in index for ${classRow.type} "${className}" but no source available.\n` +
          `Tried: C# bridge → XML file → SQLite signature. Ensure the C# bridge is running or the XML file is accessible on disk.`,
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
 * Try C# bridge for method signature. Returns null to signal fallback when
 * the bridge is unavailable.
 */
async function tryBridgeMethodSignature(
  bridge: BridgeClient | undefined,
  className: string,
  methodName: string,
  modelName: string,
  includeCoc: boolean,
): Promise<any | null> {
  if (!bridge?.isReady || !bridge.metadataAvailable) return null;
  try {
    const ms = await bridge.getMethodSource(className, methodName);
    if (!ms.found || !ms.source) return null;

    const signature = parseMethodSignature(ms.source, methodName);
    if (!signature) return null;

    const obsoleteWarning = detectObsolete(ms.source);
    const result = formatOutput(className, methodName, signature, modelName, includeCoc, obsoleteWarning);
    return result;
  } catch (e) {
    console.error(`[methodSignature] Bridge getMethodSource(${className}, ${methodName}) failed: ${e}`);
    return null;
  }
}

/**
 * Fallback when C# bridge is unavailable: parse the XML file with a timeout guard.
 * Returns null to signal fallback to SQLite-only.
 */
async function tryXmlMethodSignature(
  parser: XppMetadataParser | undefined,
  filePath: string | undefined,
  className: string,
  methodName: string,
  modelName: string,
  includeCoc: boolean,
  objectType?: string,
): Promise<any | null> {
  if (!parser || !filePath) return null;
  try {
    const parseResult = await Promise.race([
      parseByObjectType(parser, filePath, modelName, objectType),
      new Promise<{ success: false; error: string }>(resolve =>
        setTimeout(() => resolve({ success: false, error: 'timeout' }), 3000)
      ),
    ]);
    if (!parseResult.success || !parseResult.data) return null;

    const method = parseResult.data.methods.find(
      (m: any) => m.name.toLowerCase() === methodName.toLowerCase()
    );
    if (!method?.source) return null;

    const signature = parseMethodSignature(method.source, methodName);
    if (!signature) return null;

    const obsoleteWarning = detectObsolete(method.source);
    const result = formatOutput(className, methodName, signature, modelName, includeCoc, obsoleteWarning);
    return result;
  } catch (e) {
    console.error(`[methodSignature] XML parse for ${className}.${methodName} failed: ${e}`);
    return null;
  }
}

/**
 * Dispatch to the correct parser based on object type.
 * Tables, views, and data-entities have different XML structures than classes.
 */
function parseByObjectType(
  parser: XppMetadataParser,
  filePath: string,
  modelName: string,
  objectType?: string,
): Promise<{ success: boolean; data?: any; error?: string }> {
  switch (objectType) {
    case 'table':       return parser.parseTableFile(filePath, modelName);
    case 'view':
    case 'data-entity': return parser.parseViewFile(filePath, modelName);
    default:            return parser.parseClassFile(filePath, modelName);
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

// Tool registration (name, description, inputSchema) lives inline in
// src/server/mcpServer.ts - the single source of truth for tool instructions.
