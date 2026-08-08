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
import { parseXppDeclaration } from '../metadata/xppDeclaration.js';
import { canonicalSymbolName } from '../utils/symbolLookup.js';
import { inheritedOwnerCandidates } from '../utils/inheritanceChain.js';

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

    const classRow: any = loadOwnerRow(rdb, className, modelName);

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

    // 4. Inherited methods. Every reader above sees declared members only, so a
    // class that inherits the method rather than declaring it reports a false
    // "not found" — and for CoC that is the common case, because the class
    // worth wrapping is usually a leaf. Retry the same readers against the
    // declaring ancestor. Only when the class itself has no method row: if it
    // does declare the method, its own (index-only) signature below is the
    // right answer, not a base class's.
    if (!methodRow) {
      const bridgeUsable = Boolean(context.bridge?.isReady && context.bridge?.metadataAvailable);
      for (const ancestor of inheritedOwnerCandidates(rdb, className, methodName, bridgeUsable)) {
        const row: any = loadOwnerRow(rdb, ancestor);
        const model = row?.model ?? classRow.model;

        const inheritedBridge = await tryBridgeMethodSignature(
          context.bridge, ancestor, methodName, model, includeCoc, className,
        );
        if (inheritedBridge) return inheritedBridge;

        const inheritedXml = await tryXmlMethodSignature(
          parser, row?.file_path, ancestor, methodName, model, includeCoc, row?.type, className,
        );
        if (inheritedXml) return inheritedXml;
      }
    }

    // Last resort: use SQLite signature column if available. No declaration is
    // parsed on this path, so the index's own `name` is the canonical spelling
    // to render rather than the caller's argument (#691).
    if ((methodRow as any)?.signature) {
      const sigText = (methodRow as any).signature as string;
      let output = `# Method: \`${className}.${(methodRow as any).name ?? methodName}\`\n`;
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
            `Neither ${className} nor any class it extends declares it, and it could not be ` +
            `retrieved via bridge or XML.\n` +
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
 * Locate a method owner (class/table/view/data-entity) in the index. `name` is
 * expected to be canonical, so this stays a BINARY probe on idx_name_type.
 */
function loadOwnerRow(rdb: any, name: string, modelName?: string): any {
  try {
    if (modelName) {
      return rdb.prepare(`
        SELECT file_path, model, name, type
        FROM symbols
        WHERE type IN ${OBJECT_TYPES_SQL} AND name = ? AND model = ?
        ORDER BY CASE type WHEN 'class' THEN 0 WHEN 'table' THEN 1 ELSE 2 END
        LIMIT 1
      `).get(name, modelName);
    }
    return rdb.prepare(`
      SELECT file_path, model, name, type
      FROM symbols
      WHERE type IN ${OBJECT_TYPES_SQL} AND name = ?
      ORDER BY CASE type WHEN 'class' THEN 0 WHEN 'table' THEN 1 ELSE 2 END, model
      LIMIT 1
    `).get(name);
  } catch {
    return undefined;
  }
}

/**
 * Try C# bridge for method signature. Returns null to signal fallback when
 * the bridge is unavailable.
 *
 * `inheritedBy` is the class the caller asked about when it differs from
 * `className` (the declaring class this call is reading).
 */
async function tryBridgeMethodSignature(
  bridge: BridgeClient | undefined,
  className: string,
  methodName: string,
  modelName: string,
  includeCoc: boolean,
  inheritedBy?: string,
): Promise<any | null> {
  if (!bridge?.isReady || !bridge.metadataAvailable) return null;
  try {
    const ms = await bridge.getMethodSource(className, methodName);
    if (!ms.found || !ms.source) return null;

    const signature = parseMethodSignature(ms.source, methodName);
    if (!signature) return null;

    const obsoleteWarning = detectObsolete(ms.source);
    const result = formatOutput(className, signature, modelName, includeCoc, obsoleteWarning, inheritedBy);
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
  inheritedBy?: string,
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
    const result = formatOutput(className, signature, modelName, includeCoc, obsoleteWarning, inheritedBy);
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
 * Parse method signature from source code.
 *
 * The declaration parsing itself lives in ../metadata/xppDeclaration.js and is
 * shared with the XML metadata parser; this only turns a parsed declaration
 * into the rendered signature and CoC template. Exported for unit tests.
 */
export function parseMethodSignature(source: string, methodName: string): MethodSignature | null {
  const decl = parseXppDeclaration(source, methodName);
  if (!decl) return null;

  // Render the declaration's own spelling, never the caller's argument: the
  // lookup path is case-insensitive end to end, so `methodName` may be
  // mis-cased. Echoing it would emit a `next CONSTRUCT(...)` CoC template and a
  // header naming a member that doesn't exist in the AOT with that spelling (#691).
  const { name, modifiers, returnType, parameters } = decl;

  return {
    modifiers,
    returnType,
    methodName: name,
    parameters,
    signature: buildSignatureString(modifiers, returnType, name, parameters),
    cocTemplate: buildCoCTemplate(modifiers, returnType, name, parameters),
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

  // Add modifiers (replace access modifiers with method attribute)
  const cocModifiers = modifiers.filter(m => !['public', 'private', 'protected', 'internal'].includes(m));
  
  template += '[ExtensionOf(classStr(OriginalClassName))]\n';
  template += 'final class OriginalClassName_Extension\n';
  template += '{\n';
  template += '\t';

  if (cocModifiers.length > 0) {
    template += cocModifiers.join(' ') + ' ';
  }

  template += returnType + ' ' + methodName + '(';

  // Bare parameter types only — NEVER echo the base method's defaults here.
  // A CoC wrapper that repeats `str _message = "Hi"` is exactly what validate_code
  // reports as COC001 (error) and what the coc-authoring knowledge topic forbids:
  // the base method's defaults are already in effect by the time `next` runs, and
  // re-declaring them shadows the base value on every call. This builder was
  // copy-pasted from buildSignatureString (where defaults ARE correct), so the
  // default-value branch has to be dropped deliberately — and it cannot be caught
  // downstream, because the template strips access modifiers and COC001's regex
  // only fires on lines that carry one.
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

/**
 * `signature.methodName` is the declaration's own spelling (#691) — there is
 * deliberately no separate name parameter, so the caller's possibly mis-cased
 * argument cannot reach the output.
 */
function formatOutput(
  className: string,
  signature: MethodSignature,
  modelName: string,
  includeCocTemplate: boolean = false,
  obsoleteWarning: string = '',
  inheritedBy?: string
): any {
  let output = `# Method: \`${className}.${signature.methodName}\`\n`;
  output += `**Model:** ${modelName}  **Returns:** ${signature.returnType}  **Modifiers:** ${signature.modifiers.join(', ') || 'none'}\n`;
  if (inheritedBy) {
    output += `\n> ℹ️ **Inherited method.** \`${inheritedBy}\` does not declare \`${signature.methodName}\` — ` +
      `it inherits it from \`${className}\`, which is where the signature below comes from.\n`;
  }
  if (obsoleteWarning) output += obsoleteWarning + '\n';
  output += `\n\`\`\`xpp\n${signature.signature}\n\`\`\`\n`;

  if (signature.parameters.length > 0) {
    output += `\n**Parameters:** ${signature.parameters.map(p => `${p.type} ${p.name}${p.defaultValue ? ` = ${p.defaultValue}` : ''}`).join(', ')}\n`;
  }

  if (includeCocTemplate) {
    output += `\n## Chain of Command Template\n\`\`\`xpp\n${signature.cocTemplate}\`\`\`\n`;
    output += `Replace \`OriginalClassName\` with \`${className}\`.\n`;
    if (inheritedBy) {
      output += `\n**Pick the target deliberately — both compile:**\n` +
        `- \`[ExtensionOf(classStr(${inheritedBy}))]\` — wraps the inherited method for \`${inheritedBy}\` only. ` +
        `The signature must still match \`${className}\`'s declaration exactly; the compiler validates against it ` +
        `and names \`${className}\` in any mismatch error.\n` +
        `- \`[ExtensionOf(classStr(${className}))]\` — wraps it at the declaration, so it runs for **every** ` +
        `subclass of \`${className}\`.\n`;
    }
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

// This handler has no schema of its own — it is reached through a unified
// tool. Tool registration (name, description, inputSchema) lives in
// src/server/toolSchemas/, one file per published tool, aggregated by
// toolSchemas/index.ts. It is NOT in mcpServer.ts; that file only spreads
// the aggregated array into the ListTools response.
