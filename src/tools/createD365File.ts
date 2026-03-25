/**
 * D365FO File Creator Tool
 * Creates physical XML files in the AOT package structure
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { Parser, Builder } from 'xml2js';
import { getConfigManager, fallbackPackagePath } from '../utils/configManager.js';
import { registerCustomModel, resolveObjectPrefix, applyObjectPrefix } from '../utils/modelClassifier.js';
import { PackageResolver } from '../utils/packageResolver.js';
import { ensureXppDocComment, ensureBlankLineBeforeClosingBrace } from '../utils/xppDocGen.js';
import { decodeXmlEntitiesFromXppSource } from './modifyD365File.js';
import { bridgeValidateAfterWrite, canBridgeCreate, bridgeCreateObject } from '../bridge/index.js';
import { invalidateCache } from './updateSymbolIndex.js';

/**
 * Per-project-file mutex to serialise concurrent addToProject calls.
 * Key = normalised absolute project path, Value = tail of the promise chain.
 * Prevents race conditions when the AI calls create_d365fo_file in parallel
 * for multiple objects that share the same .rnrproj file.
 */
const projectFileLocks = new Map<string, Promise<unknown>>();

async function withProjectFileLock<T>(projectPath: string, fn: () => Promise<T>): Promise<T> {
  const key = path.resolve(projectPath).toLowerCase();
  const prev = projectFileLocks.get(key) ?? Promise.resolve();
  let resolve!: () => void;
  const next = new Promise<void>(r => { resolve = r; });
  projectFileLocks.set(key, next);
  try {
    await prev;
    return await fn();
  } finally {
    resolve();
    // Clean up the map entry only if it still points to this chain slot
    if (projectFileLocks.get(key) === next) {
      projectFileLocks.delete(key);
    }
  }
}

const CreateD365FileArgsSchema = z.object({
  objectType: z
    .enum([
      'class', 'class-extension', 'table', 'enum', 'form', 'query', 'view', 'data-entity', 'report',
      'edt', 'edt-extension',
      'table-extension', 'form-extension', 'data-entity-extension', 'enum-extension',
      'menu-item-display', 'menu-item-action', 'menu-item-output',
      'menu-item-display-extension', 'menu-item-action-extension', 'menu-item-output-extension',
      'menu', 'menu-extension',
      'security-privilege', 'security-duty', 'security-role',
      'business-event', 'tile', 'kpi',
    ])
    .describe('Type of D365FO object to create'),
  objectName: z
    .string()
    .describe('Name of the object (e.g., MyHelperClass, MyCustomTable)'),
  modelName: z
    .string()
    .optional()
    .describe('Model name (e.g., ContosoExtensions). Auto-detected from mcp.json if omitted.'),
  packageName: z
    .string()
    .optional()
    .describe('Package name (e.g., CustomExtensions, ApplicationSuite). Auto-resolved from model name if omitted.'),
  packagePath: z
    .string()
    .optional()
    .describe('Base package path (default: auto-detected from .mcp.json or well-known locations: C:\\, J:\\, K:\\AosService\\PackagesLocalDirectory)'),
  sourceCode: z
    .string()
    .optional()
    .describe('X++ source code for the object (class declaration, methods, etc.)'),
  properties: z
    .record(z.string(), z.any())
    .optional()
    .describe('Additional properties for the object (extends, implements, etc.)'),
  addToProject: z
    .boolean()
    .optional()
    .default(true)
    .describe('Whether to automatically add file to Visual Studio project (default: true — always pass true unless explicitly told not to)'),
  projectPath: z
    .string()
    .optional()
    .describe('Path to .rnrproj file. Required for addToProject to work. If not specified, auto-detected from .mcp.json or workspace context.'),
  solutionPath: z
    .string()
    .optional()
    .describe('Path to active VS solution directory. Used to find .rnrproj when projectPath is not given.'),
  xmlContent: z
    .string()
    .optional()
    .describe(
      'Custom XML content to write verbatim instead of generating a template. ' +
      'Use this in hybrid setups: call generate_smart_table / generate_smart_form on Azure ' +
      'to get AI-driven XML, then pass that XML here on the local Windows VM to write the file ' +
      'and add it to the VS2022 project.'
    ),
  overwrite: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      'Allow overwriting an existing file. Use together with xmlContent when you need to completely ' +
      'rewrite an object (e.g. table with corrupted field names). Default: false (returns error if file already exists).'
    ),
});

/**
 * Project File Finder
 * Finds .rnrproj files in solution directory or specific paths
 */
export class ProjectFileFinder {
  /**
   * Find .rnrproj file in solution directory
   * Recursively searches for .rnrproj files matching the model name (up to 3 levels deep)
   */
  static async findProjectInSolution(
    solutionPath: string,
    modelName: string
  ): Promise<string | null> {
    return ProjectFileFinder.findRecursive(solutionPath, modelName, 0, 3);
  }

  private static async findRecursive(
    dir: string,
    modelName: string,
    currentDepth: number,
    maxDepth: number
  ): Promise<string | null> {
    if (currentDepth > maxDepth) return null;

    try {
      await fs.access(dir);
    } catch {
      return null;
    }

    let files: string[];
    try {
      files = await fs.readdir(dir);
    } catch {
      return null;
    }

    // Check .rnrproj files at this level first
    const projectFiles = files.filter(file =>
      file.endsWith('.rnrproj') &&
      (file.includes(modelName) || file === `${modelName}.rnrproj`)
    );

    if (projectFiles.length > 0) {
      return path.join(dir, projectFiles[0]);
    }

    // Recurse into subdirectories
    for (const file of files) {
      const fullPath = path.join(dir, file);
      try {
        const stat = await fs.stat(fullPath);
        if (stat.isDirectory()) {
          const found = await ProjectFileFinder.findRecursive(fullPath, modelName, currentDepth + 1, maxDepth);
          if (found) return found;
        }
      } catch {
        continue;
      }
    }

    return null;
  }
}

/**
 * Map a D365FO base type name to the XML i:type attribute used in <AxTableField>.
 * If the explicit fieldType is not a known primitive, fall back to name-based heuristics
 * using edtName (same heuristics as SmartXmlBuilder.getAxTableFieldType).
 */
function fieldTypeToAxType(fieldType: string, edtName?: string): string {
  const typeMap: Record<string, string> = {
    String:      'AxTableFieldString',
    Integer:     'AxTableFieldInt',
    Int64:       'AxTableFieldInt64',
    Real:        'AxTableFieldReal',
    Date:        'AxTableFieldDate',
    DateTime:    'AxTableFieldUtcDateTime',
    UtcDateTime: 'AxTableFieldUtcDateTime',
    Enum:        'AxTableFieldEnum',
    GUID:        'AxTableFieldGuid',
    Guid:        'AxTableFieldGuid',
    Container:   'AxTableFieldContainer',
  };

  const explicit = typeMap[fieldType];
  if (explicit) return explicit;

  // Fall back to EDT name heuristics (mirrors SmartXmlBuilder.getAxTableFieldType)
  const hint = edtName || fieldType;
  if (hint) {
    const e = hint.toLowerCase();
    if (e === 'recid' || e.endsWith('recid') || e.includes('refrecid')) return 'AxTableFieldInt64';
    if (e.includes('utcdatetime') || (e.includes('datetime') && !e.includes('transdate'))) return 'AxTableFieldUtcDateTime';
    if (e.includes('date') && !e.includes('time') && !e.includes('update')) return 'AxTableFieldDate';
    if (e.includes('amount') || e.includes('mst') || e.includes('price') || e.includes('qty')
        || e.includes('percent') || e === 'real') return 'AxTableFieldReal';
    if (e === 'noyesid' || e.endsWith('noyesid') || e === 'noyes') return 'AxTableFieldEnum';
    if ((e.endsWith('int') || e.includes('count') || e.includes('level'))
        && !e.includes('account') && !e.includes('name')) return 'AxTableFieldInt';
  }

  return 'AxTableFieldString';
}

/**
 * XML Templates for different D365FO object types
 */
export class XmlTemplateGenerator {

  /**
   * Split X++ class source into the Declaration block (class header + field
   * declarations) and individual method bodies, as required by D365FO XML.
   *
   * D365FO XML structure:
   *   <Declaration> = class keyword + field declarations (the outer {} block)
   *   <Methods>     = one <Method><Name/><Source/></Method> per method body
   *
   * AI generators often emit the entire source (header + methods) as a single
   * string.  This helper separates them so the generated XML is correct.
   */
  static splitXppClassSource(fullSource: string): {
    declaration: string;
    methods: Array<{ name: string; source: string }>;
  } {
    // Find the '{' that opens the class body
    const firstBrace = fullSource.indexOf('{');
    if (firstBrace === -1) return { declaration: fullSource, methods: [] };

    // Walk to the matching '}' that closes the class header block
    let depth = 0;
    let classEndIdx = -1;
    for (let i = firstBrace; i < fullSource.length; i++) {
      if (fullSource[i] === '{') depth++;
      else if (fullSource[i] === '}') {
        depth--;
        if (depth === 0) { classEndIdx = i; break; }
      }
    }
    if (classEndIdx === -1) return { declaration: fullSource, methods: [] };

    let declaration = fullSource.substring(0, classEndIdx + 1);
    const rest = fullSource.substring(classEndIdx + 1);
    if (!rest.trim()) {
      // Nothing after the class closing brace.
      // Check whether the class body itself contains method definitions
      // (AI-style: methods INSIDE the class braces).
      const innerResult = XmlTemplateGenerator.extractInnerClassMethods(declaration);
      if (innerResult) {
        console.error(
          '[splitXppClassSource] Inner-class methods detected — extracting into ' +
          'separate <Method> elements (D365FO format).'
        );
        return innerResult;
      }
      // Normalise: ensure exactly one blank line before the closing '}'
      // when the class body has content (e.g. member variable declarations).
      // Fixes: "    VendGroupId vendGroupId;\n}" → "    VendGroupId vendGroupId;\n\n}"
      const bodyStart = declaration.indexOf('{');
      const bodyContent = declaration.substring(bodyStart + 1, declaration.lastIndexOf('}'));
      if (bodyContent.trim().length > 0) {
        declaration = declaration.replace(/\n+(\s*)}(\s*)$/, '\n\n}');
      }
      return { declaration, methods: [] };
    }

    // ── FIX: Rescue member-variable declarations that appear OUTSIDE the class {}
    // Some AI generators emit variable declarations after the class closing brace but
    // before the first method (e.g. "}\nint myVar;\npublic void foo() { }").
    // D365FO requires them inside the <Declaration> CDATA block. Detect and inject them now.
    const nextBraceInRest = rest.indexOf('{');
    if (nextBraceInRest !== -1) {
      const preMethodText = rest.substring(0, nextBraceInRest);
      const varLines = preMethodText
        .split('\n')
        .filter(l => {
          const t = l.trim();
          // A variable declaration ends with ';' and does NOT contain '(' (not a method call/signature)
          return t.endsWith(';') && !t.includes('(');
        });
      if (varLines.length > 0) {
        // Inject the rescued declarations into the class body, just before the closing '}'
        const injected = varLines.map(l => '    ' + l.trim()).join('\n');
        declaration = declaration.replace(/}(\s*)$/, `\n${injected}\n\n}`);
        console.error(
          `[splitXppClassSource] Rescued ${varLines.length} member variable declaration(s) ` +
          'found outside the class {} block — injected into <Declaration>.'
        );
      }
    }

    // Parse each method block from the remaining source
    const methods: Array<{ name: string; source: string }> = [];
    let pos = 0;
    while (pos < rest.length) {
      const nextBrace = rest.indexOf('{', pos);
      if (nextBrace === -1) break;

      const sigText = rest.substring(pos, nextBrace);

      // Find the matching '}' for this method body (depth-counting)
      let d = 0;
      let bodyEnd = -1;
      for (let i = nextBrace; i < rest.length; i++) {
        if (rest[i] === '{') d++;
        else if (rest[i] === '}') {
          d--;
          if (d === 0) { bodyEnd = i; break; }
        }
      }
      if (bodyEnd === -1) break;

      const methodSource = rest.substring(pos, bodyEnd + 1).trim();

      // Extract method name: last identifier before '(' in the signature
      const parenIdx = sigText.lastIndexOf('(');
      const nameMatch =
        parenIdx !== -1 ? sigText.substring(0, parenIdx).match(/(\w+)\s*$/) : null;
      const methodName = nameMatch ? nameMatch[1] : `method${methods.length + 1}`;

      methods.push({ name: methodName, source: methodSource });
      pos = bodyEnd + 1;
    }

    // ── Fallback: methods inside class {} ─────────────────────────────────────
    // AI generators often write methods INSIDE the class body (not D365FO style).
    // When that happens, `rest` is empty and `methods` is empty — the entire class
    // (including method bodies) ends up in `<Declaration>`, which means D365FO sees
    // no separate <Method> elements and the methods have no blank-line separation.
    //
    // Fix: detect methods nested at depth-1 inside the class body and extract them
    // so they become proper <Method> elements separated by blank lines via .join('\n\n').
    if (methods.length === 0) {
      const innerResult = XmlTemplateGenerator.extractInnerClassMethods(declaration);
      if (innerResult) {
        console.error(
          '[splitXppClassSource] Extracted inner class methods — moving them from ' +
          '<Declaration> into separate <Method> elements (D365FO format).'
        );
        return innerResult;
      }
    }

    return { declaration, methods };
  }

  /**
   * Extract methods that are defined INSIDE the class body (depth-1 inside {}).
   *
   * D365FO XML requires each method as a separate <Method><Source/></Method> element.
   * When AI generates a class with methods inside the class braces, all code ends up
   * in <Declaration> with no blank-line separation between methods.
   *
   * This helper detects that pattern and returns the correct split:
   *   declaration = class header + member variable declarations only
   *   methods     = each method body as a separate entry
   *
   * Returns null when no inner methods are found (i.e. the class body is just fields).
   */
  static extractInnerClassMethods(classDeclaration: string): {
    declaration: string;
    methods: Array<{ name: string; source: string }>;
  } | null {
    const classOpenIdx = classDeclaration.indexOf('{');
    const classCloseIdx = classDeclaration.lastIndexOf('}');
    if (classOpenIdx === -1 || classCloseIdx <= classOpenIdx) return null;

    const classBody = classDeclaration.substring(classOpenIdx + 1, classCloseIdx);

    const methods: Array<{ name: string; source: string }> = [];
    const memberVarLines: string[] = [];

    let pos = 0;
    while (pos < classBody.length) {
      const nextBrace = classBody.indexOf('{', pos);
      if (nextBrace === -1) {
        // No more braces — collect any trailing member-variable declarations
        for (const line of classBody.substring(pos).split('\n')) {
          const t = line.trim();
          if (t.length > 0 && t.endsWith(';') && !t.includes('(') &&
              !t.startsWith('//') && !t.startsWith('*')) {
            memberVarLines.push(t);
          }
        }
        break;
      }

      const sigText = classBody.substring(pos, nextBrace);

      // Find the matching '}' for this block
      let depth = 0;
      let bodyEnd = -1;
      for (let i = nextBrace; i < classBody.length; i++) {
        if (classBody[i] === '{') depth++;
        else if (classBody[i] === '}') {
          depth--;
          if (depth === 0) { bodyEnd = i; break; }
        }
      }
      if (bodyEnd === -1) break;

      const parenIdx = sigText.lastIndexOf('(');
      if (parenIdx !== -1) {
        // The block is a method (sigText contains a '(' — it's a parameter list).
        // Collect member-variable lines that appeared before the method signature.
        for (const line of sigText.split('\n')) {
          const t = line.trim();
          if (t.length > 0 && t.endsWith(';') && !t.includes('(') &&
              !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('[')) {
            memberVarLines.push(t);
          }
        }

        // Find where the actual method signature starts within sigText:
        // walk backward from the last '(' to include attribute annotations ('[…]').
        const beforeLastParen = sigText.substring(0, parenIdx);
        const lastNewlineBeforeLastParen = beforeLastParen.lastIndexOf('\n');
        let methodStartInSig = lastNewlineBeforeLastParen !== -1
          ? lastNewlineBeforeLastParen + 1
          : 0;

        // Include any leading [Attribute] and doc-comment (///) lines that belong to this method.
        // Walking BACKWARDS through the lines that appear above the method signature:
        // we stop as soon as we hit a line that is neither empty, nor an attribute, nor a comment.
        const sigBeforeMethod = sigText.substring(0, methodStartInSig);
        const sigBeforeLines = sigBeforeMethod.split('\n').reverse();
        let droppedChars = 0;
        for (const line of sigBeforeLines) {
          const t = line.trim();
          if (t.length === 0 || t.startsWith('[') || t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) {
            droppedChars += line.length + 1; // +1 for '\n'
          } else {
            break;
          }
        }
        methodStartInSig = Math.max(0, methodStartInSig - droppedChars);

        const methodSource = classBody
          .substring(pos + methodStartInSig, bodyEnd + 1)
          .trim();

        const nameMatch = sigText.substring(0, parenIdx).match(/(\w+)\s*$/);
        const methodName = nameMatch ? nameMatch[1] : `method${methods.length + 1}`;

        methods.push({ name: methodName, source: methodSource });
      } else {
        // Not a method (no '(' in sigText) — collect member-variable declarations
        for (const line of sigText.split('\n')) {
          const t = line.trim();
          if (t.length > 0 && t.endsWith(';') && !t.includes('(') &&
              !t.startsWith('//') && !t.startsWith('*')) {
            memberVarLines.push(t);
          }
        }
        // Skip the block (e.g. object initialiser)
      }

      pos = bodyEnd + 1;
    }

    if (methods.length === 0) return null;

    // Rebuild the declaration as: class header + member variable declarations only
    const classHeader = classDeclaration.substring(0, classOpenIdx + 1);
    const memberVarsXpp = memberVarLines.length > 0
      ? '\n' + memberVarLines.map(v => '    ' + v).join('\n') + '\n\n'
      : '\n';

    return {
      declaration: classHeader + memberVarsXpp + '}',
      methods,
    };
  }

  /**
   * Parse X++ sourceCode into declaration + methods for the C# bridge.
   *
   * Used by the bridge-first creation path in create_d365fo_file — the C# side
   * expects declaration (class header + member vars) and an array of method
   * objects {name, source} which it sets on the AxClass via IMetadataProvider.
   *
   * Delegates to splitXppClassSource after decoding any XML entities.
   */
  static parseSourceForBridge(sourceCode: string): {
    declaration: string;
    methods: { name: string; source?: string }[];
  } {
    // Same entity-decoding as generateAxClassXml to handle AI-generated &lt; etc.
    const cleaned = decodeXmlEntitiesFromXppSource(sourceCode);
    const result = XmlTemplateGenerator.splitXppClassSource(cleaned);
    return {
      declaration: result.declaration,
      methods: result.methods,
    };
  }

  /**
   * Generate AxClass XML structure
   */
  static generateAxClassXml(
    className: string,
    sourceCode?: string,
    properties?: Record<string, any>
  ): string {
    // Decode XML entities that AI models may introduce when copying from SSRS report
    // entity-encoded <Text> blocks (e.g. &lt;summary&gt; → <summary>).
    const rawSource = decodeXmlEntitiesFromXppSource(sourceCode || `public class ${className}\n{\n}`);

    // Split full X++ source into Declaration (class header + fields) and Methods.
    // D365FO XML requires member variable declarations in <Declaration> and
    // each method body as a separate <Method> element under <Methods>.
    const { declaration, methods } = XmlTemplateGenerator.splitXppClassSource(rawSource);

    const extendsAttr = properties?.extends
      ? `\t<Extends>${properties.extends}</Extends>\n`
      : '';
    const implementsAttr = properties?.implements
      ? `\t<Implements>${properties.implements}</Implements>\n`
      : '';
    const isFinalAttr = properties?.isFinal ? `\t<IsFinal>Yes</IsFinal>\n` : '';
    const isAbstractAttr = properties?.isAbstract
      ? `\t<IsAbstract>Yes</IsAbstract>\n`
      : '';

    // D365FO convention: method source is always indented by 4 spaces inside <Source>.
    // This matches what VS writes and what the compiler/Designer expect to see.
    const indentMethodSource = (src: string): string =>
      src.split('\n').map(line => '    ' + line).join('\n');

    const methodsXml =
      methods.length === 0
        ? '\t\t<Methods />\n'
        : `\t\t<Methods>\n${methods
            .map(
              m =>
                `\t\t\t<Method>\n\t\t\t\t<Name>${m.name}</Name>\n\t\t\t\t<Source><![CDATA[\n${indentMethodSource(ensureXppDocComment(m.source))}\n\n]]></Source>\n\t\t\t</Method>`
            )
            .join('\n\n')}\n\t\t</Methods>\n`;

    return `<?xml version="1.0" encoding="utf-8"?>
<AxClass xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
\t<Name>${className}</Name>
${extendsAttr}${implementsAttr}${isFinalAttr}${isAbstractAttr}\t<SourceCode>
\t\t<Declaration><![CDATA[
${ensureBlankLineBeforeClosingBrace(ensureXppDocComment(declaration))}
]]></Declaration>
${methodsXml}\t</SourceCode>
</AxClass>
`;
  }

  /**
   * Generate AxClass XML structure for a Chain of Command (class-extension).
   * The XML format is identical to a regular AxClass — the distinction is purely
   * in the X++ source code ([ExtensionOf(classStr(...))] + final modifier).
   *
   * properties.baseClass   — name of the class being extended (required)
   * properties.modelInfix  — naming infix, e.g. "ContosoExt" → BaseClass_ContosoExt_Extension
   */
  static generateAxClassExtensionXml(
    extensionName: string,
    sourceCode?: string,
    properties?: Record<string, any>
  ): string {
    const baseClass = properties?.baseClass || extensionName.replace(/_[^_]+_Extension$/, '');

    const defaultSource = sourceCode ||
      `[ExtensionOf(classStr(${baseClass}))]\nfinal class ${extensionName}\n{\n    // ⚠️  ALWAYS call next <methodName>() — verify exact signature with:\n    //     get_method_signature("${baseClass}", "methodName")\n    //\n    // Template for wrapping a method:\n    //   public ReturnType methodName(ParamType _param)\n    //   {\n    //       ReturnType result = next methodName(_param);\n    //       return result;\n    //   }\n}`;

    return XmlTemplateGenerator.generateAxClassXml(extensionName, defaultSource, { isFinal: true, ...properties });
  }

  /**
   * Generate AxTable XML structure (based on real D365FO table structure)
   */
  static generateAxTableXml(
    tableName: string,
    properties?: Record<string, any>
  ): string {
    const label = properties?.label || tableName;
    const tableGroup = properties?.tableGroup || 'Main';
    const tableType = properties?.tableType || '';
    const titleField1 = properties?.titleField1 || '';
    const titleField2 = properties?.titleField2 || '';
    const configKey = properties?.configurationKey || '';
    const primaryIndex = properties?.primaryIndex || '';
    const cacheLookup = properties?.cacheLookup || '';

    // Build optional configuration key
    const configKeyXml = configKey
      ? `\t<ConfigurationKey>${configKey}</ConfigurationKey>\n`
      : '';

    // Build optional cache lookup (only if explicitly set)
    const cacheLookupXml = cacheLookup
      ? `\t<CacheLookup>${cacheLookup}</CacheLookup>\n`
      : '';

    // Build optional primary index (NOTE: ClusteredIndex is NOT in real D365FO files)
    const primaryIndexXml = primaryIndex
      ? `\t<PrimaryIndex>${primaryIndex}</PrimaryIndex>\n\t<ReplacementKey>${primaryIndex}</ReplacementKey>\n`
      : '';

    // Build optional TableType (TempDB, InMemory; omit for Regular — it's the default)
    const tableTypeXml = tableType
      ? `\t<TableType>${tableType}</TableType>\n`
      : '';

    // Build <Fields> block from properties.fields array (TableFieldSpec[]).
    // Copilot may pass field definitions via properties.fields or via sourceCode JSON —
    // both paths merge into properties before calling here (see generate()).
    const fieldSpecs: Array<{ name: string; edt?: string; type?: string; mandatory?: boolean; label?: string }> =
      Array.isArray(properties?.fields) ? properties.fields : [];

    let fieldsXml: string;
    if (fieldSpecs.length === 0) {
      fieldsXml = '\t<Fields />\n';
    } else {
      fieldsXml = '\t<Fields>\n';
      for (const f of fieldSpecs) {
        // Determine i:type: use explicit type if provided, otherwise derive from EDT name heuristics.
        // NEVER default to AxTableFieldString blindly when an EDT is present — EDT base type matters!
        const iType = fieldTypeToAxType(f.type || 'String', f.edt);
        fieldsXml += `\t\t<AxTableField xmlns=""\n\t\t\ti:type="${iType}">\n`;
        fieldsXml += `\t\t\t<Name>${f.name}</Name>\n`;
        if (f.edt)       fieldsXml += `\t\t\t<ExtendedDataType>${f.edt}</ExtendedDataType>\n`;
        if (f.mandatory) fieldsXml += `\t\t\t<Mandatory>Yes</Mandatory>\n`;
        if (f.label)     fieldsXml += `\t\t\t<Label>${f.label}</Label>\n`;
        fieldsXml += `\t\t</AxTableField>\n`;
      }
      fieldsXml += '\t</Fields>\n';
    }

    return `<?xml version="1.0" encoding="utf-8"?>
<AxTable xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
\t<Name>${tableName}</Name>
\t<SourceCode>
\t\t<Declaration><![CDATA[
public class ${tableName} extends common
{
}
]]></Declaration>
\t\t<Methods />
\t</SourceCode>
${configKeyXml}\t<Label>${label}</Label>
\t<TableGroup>${tableGroup}</TableGroup>
${tableTypeXml}\t<TitleField1>${titleField1}</TitleField1>
\t<TitleField2>${titleField2}</TitleField2>
${cacheLookupXml}${primaryIndexXml}\t<DeleteActions />
\t<FieldGroups>
\t\t<AxTableFieldGroup>
\t\t\t<Name>AutoReport</Name>
\t\t\t<Fields />
\t\t</AxTableFieldGroup>
\t\t<AxTableFieldGroup>
\t\t\t<Name>AutoLookup</Name>
\t\t\t<Fields />
\t\t</AxTableFieldGroup>
\t\t<AxTableFieldGroup>
\t\t\t<Name>AutoIdentification</Name>
\t\t\t<AutoPopulate>Yes</AutoPopulate>
\t\t\t<Fields />
\t\t</AxTableFieldGroup>
\t\t<AxTableFieldGroup>
\t\t\t<Name>AutoSummary</Name>
\t\t\t<Fields />
\t\t</AxTableFieldGroup>
\t\t<AxTableFieldGroup>
\t\t\t<Name>AutoBrowse</Name>
\t\t\t<Fields />
\t\t</AxTableFieldGroup>
\t</FieldGroups>
${fieldsXml}\t<FullTextIndexes />
\t<Indexes />
\t<Mappings />
\t<Relations />
\t<StateMachines />
</AxTable>
`;
  }

  /**
   * Generate AxEnum XML structure
   */
  static generateAxEnumXml(
    enumName: string,
    properties?: Record<string, any>
  ): string {
    const label = properties?.label || enumName;
    const useEnumValue = properties?.useEnumValue ? 'Yes' : 'No';


    // Build <EnumValues> block from properties.enumValues array
    // Each entry: { name: string; value?: number; label?: string; helpText?: string }
    const enumValueSpecs: Array<{ name: string; value?: number; label?: string; helpText?: string }> =
      Array.isArray(properties?.enumValues) ? properties.enumValues : [];

    let enumValuesXml: string;
    if (enumValueSpecs.length === 0) {
      enumValuesXml = '\t<EnumValues />\n';
    } else {
      enumValuesXml = '\t<EnumValues>\n';
      let autoValue = 0;
      for (const v of enumValueSpecs) {
        const intValue = v.value ?? autoValue;
        autoValue = intValue + 1;
        enumValuesXml += `\t\t<AxEnumValue>\n`;
        enumValuesXml += `\t\t\t<Name>${v.name}</Name>\n`;
        if (v.label) enumValuesXml += `\t\t\t<Label>${v.label}</Label>\n`;
        if (v.helpText) enumValuesXml += `\t\t\t<HelpText>${v.helpText}</HelpText>\n`;
        // D365FO convention: omit <Value> for 0 (implicit default)
        if (intValue !== 0) enumValuesXml += `\t\t\t<Value>${intValue}</Value>\n`;
        enumValuesXml += `\t\t</AxEnumValue>\n`;
      }
      enumValuesXml += '\t</EnumValues>\n';
    }

    // IsExtensible goes after EnumValues; value is lowercase true/false
    const isExtensibleXml = properties?.isExtensible ? '\t<IsExtensible>true</IsExtensible>\n' : '';

    return `<?xml version="1.0" encoding="utf-8"?>
<AxEnum xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
\t<Name>${enumName}</Name>
\t<Label>${label}</Label>
\t<UseEnumValue>${useEnumValue}</UseEnumValue>
${enumValuesXml}${isExtensibleXml}</AxEnum>
`;
  }

  /**
   * Generate AxForm XML structure (based on real D365FO form structure)
   */
  static generateAxFormXml(
    formName: string,
    properties?: Record<string, any>
  ): string {
    const caption = properties?.caption || `@${formName}`;
    const formTemplate = properties?.formTemplate || 'DetailsPage';
    const pattern = properties?.pattern || 'DetailsTransaction';
    const dataSource = properties?.dataSource || '';
    const interactionClass = properties?.interactionClass || '';
    const style = properties?.style || 'DetailsFormTransaction';

    // Build class declaration for SourceCode
    const extendsFrom = properties?.extends || 'FormRun';
    const classDeclaration = properties?.classDeclaration || 
      `[Form]\npublic class ${formName} extends ${extendsFrom}\n{\n}`;

    // Build optional InteractionClass
    const interactionClassXml = interactionClass
      ? `\t<InteractionClass>${interactionClass}</InteractionClass>\n`
      : '';

    // Build DataSource reference for Design
    const dataSourceXml = dataSource
      ? `\t\t<DataSource xmlns="">${dataSource}</DataSource>\n`
      : '';

    return `<?xml version="1.0" encoding="utf-8"?>
<AxForm xmlns:i="http://www.w3.org/2001/XMLSchema-instance" xmlns="Microsoft.Dynamics.AX.Metadata.V6">
\t<Name>${formName}</Name>
\t<SourceCode>
\t\t<Methods xmlns="">
\t\t\t<Method>
\t\t\t\t<Name>classDeclaration</Name>
\t\t\t\t<Source><![CDATA[
${classDeclaration}

]]></Source>
\t\t\t</Method>
\t\t</Methods>
\t</SourceCode>
\t<FormTemplate>${formTemplate}</FormTemplate>
${interactionClassXml}\t<DataSources />
\t<Design>
\t\t<Caption xmlns="">${caption}</Caption>
${dataSourceXml}\t\t<Pattern xmlns="">${pattern}</Pattern>
\t\t<Style xmlns="">${style}</Style>
\t\t<Controls xmlns="" />
\t</Design>
\t<Parts />
</AxForm>
`;
  }

  /**
   * Generate AxQuery XML structure
   */
  static generateAxQueryXml(
    queryName: string,
    properties?: Record<string, any>
  ): string {
    const title = properties?.title || queryName;

    return `<?xml version="1.0" encoding="utf-8"?>
<AxQuery xmlns:i="http://www.w3.org/2001/XMLSchema-instance" xmlns=""
\ti:type="AxQuerySimple">
\t<Name>${queryName}</Name>
\t<SourceCode>
\t\t<Methods>
\t\t\t<Method>
\t\t\t\t<Name>classDeclaration</Name>
\t\t\t\t<Source><![CDATA[
[Query]
public class ${queryName} extends QueryRun
{
}

]]></Source>
\t\t\t</Method>
\t\t</Methods>
\t</SourceCode>
\t<Title>${title}</Title>
\t<DataSources />
</AxQuery>
`;
  }

  /**
   * Generate AxView XML structure
   */
  static generateAxViewXml(
    viewName: string,
    properties?: Record<string, any>
  ): string {
    const label = properties?.label || viewName;

    return `<?xml version="1.0" encoding="utf-8"?>
<AxView xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
\t<Name>${viewName}</Name>
\t<Label>${label}</Label>
\t<Fields />
\t<Mappings />
\t<Metadata />
\t<ViewMetadata />
</AxView>
`;
  }

  /**
   * Generate AxDataEntityView XML structure
   */
  static generateAxDataEntityXml(
    entityName: string,
    properties?: Record<string, any>
  ): string {
    const label = properties?.label || entityName;
    const publicEntityName = properties?.publicEntityName || entityName;
    const publicCollectionName =
      properties?.publicCollectionName || `${entityName}Collection`;

    return `<?xml version="1.0" encoding="utf-8"?>
<AxDataEntityView xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
\t<Name>${entityName}</Name>
\t<Label>${label}</Label>
\t<DataManagementEnabled>Yes</DataManagementEnabled>
\t<DataManagementStagingTable>${entityName}Staging</DataManagementStagingTable>
\t<EntityCategory>Transaction</EntityCategory>
\t<IsPublic>Yes</IsPublic>
\t<PublicCollectionName>${publicCollectionName}</PublicCollectionName>
\t<PublicEntityName>${publicEntityName}</PublicEntityName>
\t<Fields />
\t<Keys />
\t<Mappings />
\t<Ranges />
\t<Relations />
\t<ViewMetadata />
</AxDataEntityView>
`;
  }

  /**
   * Generate AxReport XML skeleton.
   *
   * properties:
   *   dpClassName   - Data Provider class name          (default: <ReportName>DP)
   *   tmpTableName  - TempDB table name                 (default: <ReportName>Tmp)
   *   datasetName   - AxReportDataSet name              (default: tmpTableName)
   *   designName    - AxReportDesign name               (default: 'Report')
   *   caption       - Design caption label ref           (e.g. '@MyModel:MyLabel')
   *   style         - Design style template             (e.g. 'TableStyleTemplate')
   *   aotQuery      - AOT query name for DynamicParameter (e.g. 'SalesTable')
   *   fields        - Array of { name, alias?, dataType?, caption?, disableAutoCreate? } → AxReportDataSetField
   *   datasets      - Array of { name, dpClassName, tmpTableName, fields?, aotQuery?, contractParams? } for multi-dataset reports
   *   contractParams - Array of { name, dataType?, label?, defaultValue? } → contract class parameters (DataMember)
   *   rdlContent    - Full RDL XML string to embed (auto-generated from fields when omitted)
   *
   * AOT structure generated (mirrors real D365FO reports like ContosoReports_CashOrder_CZ):
   *   <AxReport xmlns="Microsoft.Dynamics.AX.Metadata.V2">
   *     <DataMethods />
   *     <DataSets>
   *       <AxReportDataSet xmlns="">           ← one per dataset
   *         <Fields>…</Fields>
   *         <Parameters>   ← 6 AX system params + {DPCLASS}_DynamicParameter
   *       </AxReportDataSet>
   *     </DataSets>
   *     <DefaultParameterGroup>               ← 6 AX params + DynamicParameter (with AOTQuery+DataType)
   *     <Designs>
   *       <AxReportDesign xmlns="" i:type="AxReportPrecisionDesign">
   *         <Text><![CDATA[…RDL…]]></Text>   ← 2016 schema with DataSources/DataSets/ReportParameters
   *         <DisableIndividualTransformation><Name>…</Name></DisableIndividualTransformation>
   *     </Designs>
   *   </AxReport>
   */
  static generateAxReportXml(
    reportName: string,
    properties?: Record<string, any>
  ): string {
    // ── Type helpers ─────────────────────────────────────────────────────────
    type FieldDef = {
      name: string; alias?: string; dataType?: string;
      caption?: string; disableAutoCreate?: boolean;
    };
    type DatasetDef = {
      name: string; dpClassName: string; tmpTableName: string;
      fields?: FieldDef[]; aotQuery?: string;
      contractParams?: Array<{ name: string; dataType?: string; label?: string; defaultValue?: string }>;
    };

    // ── Resolve datasets (multi-dataset array OR single-dataset shorthand) ──
    let datasets: DatasetDef[];
    if (properties?.datasets && Array.isArray(properties.datasets)) {
      datasets = properties.datasets as DatasetDef[];
    } else {
      const tmpTableName = properties?.tmpTableName || `${reportName}Tmp`;
      const dpClassName  = properties?.dpClassName  || `${reportName}DP`;
      const datasetName  = properties?.datasetName  || tmpTableName;
      datasets = [{
        name:         datasetName,
        dpClassName,
        tmpTableName,
        fields:       properties?.fields    as FieldDef[] | undefined,
        aotQuery:     properties?.aotQuery  as string     | undefined,
        contractParams: properties?.contractParams as Array<{ name: string; dataType?: string; label?: string; defaultValue?: string }> | undefined,
      }];
    }
    const designName = properties?.designName || 'Report';

    // ── RDL .NET type mapping ──
    const rdlType = (dt?: string): string => {
      switch (dt) {
        case 'System.Double':   return 'System.Double';
        case 'System.Int32':    return 'System.Int32';
        case 'System.Int64':    return 'System.Int64';
        case 'System.DateTime': return 'System.DateTime';
        case 'System.Byte[]':   return 'System.Byte[]';
        default:                return 'System.String';
      }
    };

    // ── UUID helper — use Node.js crypto for guaranteed RFC-4122 v4 format ──
    const uuid = (): string => crypto.randomUUID();

    // ── Build one AxReportDataSet XML entry ──
    const buildDatasetXml = (ds: DatasetDef): string => {
      const dpParamName = `${ds.dpClassName.toUpperCase()}_DynamicParameter`;
      const contractDatasetParamsXml = (ds.contractParams || []).map(cp => {
        const pn = `${ds.name}_ds_${cp.name}`;
        const dt = cp.dataType || 'System.String';
        return `\t\t\t\t<AxReportDataSetParameter>\n\t\t\t\t\t<Name>${pn}</Name>\n\t\t\t\t\t<Alias>${pn}</Alias>\n\t\t\t\t\t<DataType>${dt}</DataType>\n\t\t\t\t\t<Parameter>${pn}</Parameter>\n\t\t\t\t</AxReportDataSetParameter>`;
      }).join('\n');
      let fieldsXml: string;
      if (ds.fields && ds.fields.length > 0) {
        const entries = ds.fields.map(f => {
          const alias      = f.alias    || `${ds.tmpTableName}.1.${f.name}`;
          const capLine    = f.caption          ? `\n\t\t\t\t<Caption>${f.caption}</Caption>`                                 : '';
          const dtLine     = f.dataType         ? `\n\t\t\t\t<DataType>${f.dataType}</DataType>`                              : '';
          const disableLine = f.disableAutoCreate ? `\n\t\t\t\t<DisableAutoCreateInDataRegion>true</DisableAutoCreateInDataRegion>` : '';
          return [
            `\t\t\t<AxReportDataSetField>`,
            `\t\t\t\t<Name>${f.name}</Name>`,
            `\t\t\t\t<Alias>${alias}</Alias>${capLine}${dtLine}${disableLine}`,
            `\t\t\t\t<DisplayWidth>Auto</DisplayWidth>`,
            `\t\t\t\t<UserDefined>false</UserDefined>`,
            `\t\t\t</AxReportDataSetField>`,
          ].join('\n');
        });
        fieldsXml = `\t\t\t<Fields>\n${entries.join('\n')}\n\t\t\t</Fields>`;
      } else {
        // ⚠ No field definitions provided — dataset will have no columns visible in the
        // D365FO Report Designer.  Caller MUST pass a `fields` array listing all TmpTable
        // columns that the report should expose (name, alias, dataType).  Without this the
        // designer shows an empty dataset and the RDL tablix has no fields to bind to.
        fieldsXml = `\t\t\t<Fields />`;
      }
      return `\t\t<AxReportDataSet xmlns="">
\t\t\t<Name>${ds.name}</Name>
\t\t\t<DataSourceType>ReportDataProvider</DataSourceType>
\t\t\t<Query>SELECT * FROM ${ds.dpClassName}.${ds.tmpTableName}</Query>
\t\t\t<FieldGroups />
${fieldsXml}
\t\t\t<Parameters>
\t\t\t\t<AxReportDataSetParameter>
\t\t\t\t\t<Name>AX_PartitionKey</Name>
\t\t\t\t\t<Alias>AX_PartitionKey</Alias>
\t\t\t\t\t<DataType>System.String</DataType>
\t\t\t\t\t<Parameter>AX_PartitionKey</Parameter>
\t\t\t\t</AxReportDataSetParameter>
\t\t\t\t<AxReportDataSetParameter>
\t\t\t\t\t<Name>AX_CompanyName</Name>
\t\t\t\t\t<Alias>AX_CompanyName</Alias>
\t\t\t\t\t<DataType>System.String</DataType>
\t\t\t\t\t<Parameter>AX_CompanyName</Parameter>
\t\t\t\t</AxReportDataSetParameter>
\t\t\t\t<AxReportDataSetParameter>
\t\t\t\t\t<Name>AX_UserContext</Name>
\t\t\t\t\t<Alias>AX_UserContext</Alias>
\t\t\t\t\t<DataType>System.String</DataType>
\t\t\t\t\t<Parameter>AX_UserContext</Parameter>
\t\t\t\t</AxReportDataSetParameter>
\t\t\t\t<AxReportDataSetParameter>
\t\t\t\t\t<Name>AX_RenderingCulture</Name>
\t\t\t\t\t<Alias>AX_RenderingCulture</Alias>
\t\t\t\t\t<DataType>System.String</DataType>
\t\t\t\t\t<Parameter>AX_RenderingCulture</Parameter>
\t\t\t\t</AxReportDataSetParameter>
\t\t\t\t<AxReportDataSetParameter>
\t\t\t\t\t<Name>AX_ReportContext</Name>
\t\t\t\t\t<Alias>AX_ReportContext</Alias>
\t\t\t\t\t<DataType>System.String</DataType>
\t\t\t\t\t<Parameter>AX_ReportContext</Parameter>
\t\t\t\t</AxReportDataSetParameter>
\t\t\t\t<AxReportDataSetParameter>
\t\t\t\t\t<Name>AX_RdpPreProcessedId</Name>
\t\t\t\t\t<Alias>AX_RdpPreProcessedId</Alias>
\t\t\t\t\t<DataType>System.String</DataType>
\t\t\t\t\t<Parameter>AX_RdpPreProcessedId</Parameter>
\t\t\t\t</AxReportDataSetParameter>
${contractDatasetParamsXml ? contractDatasetParamsXml + '\n' : ''}\t\t\t\t<AxReportDataSetParameter>
\t\t\t\t\t<Name>${dpParamName}</Name>
\t\t\t\t\t<Alias>${dpParamName}</Alias>
\t\t\t\t\t<DataType>Microsoft.Dynamics.AX.Framework.Services.Client.QueryMetadata</DataType>
\t\t\t\t\t<Parameter>${dpParamName}</Parameter>
\t\t\t\t</AxReportDataSetParameter>
\t\t\t</Parameters>
\t\t</AxReportDataSet>`;
    };

    const datasetsXml = datasets.map(buildDatasetXml).join('\n');

    // ── DefaultParameterGroup (uses first dataset's DP for DynamicParameter) ──
    const firstDs      = datasets[0];
    const dpParamName  = `${firstDs.dpClassName.toUpperCase()}_DynamicParameter`;
    const aotQueryLine = firstDs.aotQuery ? `\n\t\t\t\t<AOTQuery>${firstDs.aotQuery}</AOTQuery>` : '';

    // Contract parameters (from DataContract class with [DataMember] attributes)
    const contractParamsXml = (firstDs.contractParams || []).map(cp => {
      const dataTypeLine = cp.dataType ? `\n\t\t\t\t<DataType>${cp.dataType}</DataType>` : '';
      const promptLine = cp.label ? `\n\t\t\t\t<PromptString>${cp.label}</PromptString>` : '';
      return `\t\t\t<AxReportParameterBase xmlns=""
\t\t\t\t\ti:type="AxReportParameter">
\t\t\t\t<Name>${firstDs.name}_ds_${cp.name}</Name>${dataTypeLine}${promptLine}
\t\t\t\t<DefaultValue />
\t\t\t\t<Values />
\t\t\t</AxReportParameterBase>`;
    }).join('\n');

    const defaultParamGroupXml = `\t<DefaultParameterGroup>
\t\t<Name xmlns="">Parameters</Name>
\t\t<ReportParameterBases xmlns="">
\t\t\t<AxReportParameterBase xmlns=""
\t\t\t\t\ti:type="AxReportParameter">
\t\t\t\t<Name>AX_PartitionKey</Name>
\t\t\t\t<AllowBlank>true</AllowBlank>
\t\t\t\t<Nullable>true</Nullable>
\t\t\t\t<UserVisibility>Hidden</UserVisibility>
\t\t\t\t<DefaultValue />
\t\t\t\t<Values />
\t\t\t</AxReportParameterBase>
\t\t\t<AxReportParameterBase xmlns=""
\t\t\t\t\ti:type="AxReportParameter">
\t\t\t\t<Name>AX_CompanyName</Name>
\t\t\t\t<UserVisibility>Hidden</UserVisibility>
\t\t\t\t<DefaultValue />
\t\t\t\t<Values />
\t\t\t</AxReportParameterBase>
\t\t\t<AxReportParameterBase xmlns=""
\t\t\t\t\ti:type="AxReportParameter">
\t\t\t\t<Name>AX_UserContext</Name>
\t\t\t\t<AllowBlank>true</AllowBlank>
\t\t\t\t<Nullable>true</Nullable>
\t\t\t\t<UserVisibility>Hidden</UserVisibility>
\t\t\t\t<DefaultValue />
\t\t\t\t<Values />
\t\t\t</AxReportParameterBase>
\t\t\t<AxReportParameterBase xmlns=""
\t\t\t\t\ti:type="AxReportParameter">
\t\t\t\t<Name>AX_RenderingCulture</Name>
\t\t\t\t<AllowBlank>true</AllowBlank>
\t\t\t\t<Nullable>true</Nullable>
\t\t\t\t<UserVisibility>Hidden</UserVisibility>
\t\t\t\t<DefaultValue />
\t\t\t\t<Values />
\t\t\t</AxReportParameterBase>
\t\t\t<AxReportParameterBase xmlns=""
\t\t\t\t\ti:type="AxReportParameter">
\t\t\t\t<Name>AX_ReportContext</Name>
\t\t\t\t<AllowBlank>true</AllowBlank>
\t\t\t\t<Nullable>true</Nullable>
\t\t\t\t<UserVisibility>Hidden</UserVisibility>
\t\t\t\t<DefaultValue />
\t\t\t\t<Values />
\t\t\t</AxReportParameterBase>
\t\t\t<AxReportParameterBase xmlns=""
\t\t\t\t\ti:type="AxReportParameter">
\t\t\t\t<Name>AX_RdpPreProcessedId</Name>
\t\t\t\t<AllowBlank>true</AllowBlank>
\t\t\t\t<Nullable>true</Nullable>
\t\t\t\t<UserVisibility>Hidden</UserVisibility>
\t\t\t\t<DefaultValue />
\t\t\t\t<Values />
\t\t\t</AxReportParameterBase>
${contractParamsXml}${contractParamsXml ? '\n' : ''}\t\t\t<AxReportParameterBase xmlns=""
\t\t\t\t\ti:type="AxReportParameter">
\t\t\t\t<Name>${dpParamName}</Name>${aotQueryLine}
\t\t\t\t<AllowBlank>true</AllowBlank>
\t\t\t\t<DataType>Microsoft.Dynamics.AX.Framework.Services.Client.QueryMetadata</DataType>
\t\t\t\t<Nullable>true</Nullable>
\t\t\t\t<UserVisibility>Hidden</UserVisibility>
\t\t\t\t<DefaultValue />
\t\t\t\t<Values />
\t\t\t</AxReportParameterBase>
\t\t</ReportParameterBases>
\t</DefaultParameterGroup>`;

    // ── Auto-generate RDL skeleton (2016 namespace, mirrors real D365FO reports) ──
    const buildRdlSkeleton = (): string => {
      const ns2016 = 'http://schemas.microsoft.com/sqlserver/reporting/2016/01/reportdefinition';
      const nsRd   = 'http://schemas.microsoft.com/SQLServer/reporting/reportdesigner';

      // DataSources block — single shared AX data source
      const rdlDataSourcesXml =
`  <DataSources>
    <DataSource Name="AutoGen__ReportDataProvider">
      <Transaction>true</Transaction>
      <ConnectionProperties>
        <DataProvider>AXREPORTDATAPROVIDER</DataProvider>
        <ConnectString />
        <IntegratedSecurity>true</IntegratedSecurity>
      </ConnectionProperties>
      <rd:DataSourceID>${uuid()}</rd:DataSourceID>
    </DataSource>
  </DataSources>`;

      // Build one RDL DataSet per AxReportDataSet
      const buildRdlDataset = (ds: DatasetDef): string => {
        const dsDpParam   = `${ds.dpClassName.toUpperCase()}_DynamicParameter`;
        const contractParamNamesRdl = (ds.contractParams || []).map(cp => `${ds.name}_ds_${cp.name}`);
        const paramNames  = [
          'AX_PartitionKey', 'AX_CompanyName', 'AX_UserContext',
          'AX_RenderingCulture', 'AX_ReportContext', 'AX_RdpPreProcessedId',
          ...contractParamNamesRdl,
          dsDpParam,
        ];
        const queryParams = paramNames
          .map(p =>
            `          <QueryParameter Name="${p}">\n            <Value>=Parameters!${p}.Value</Value>\n          </QueryParameter>`)
          .join('\n');

        let rdlFields = '';
        if (ds.fields && ds.fields.length > 0) {
          const flines = ds.fields.map(f => {
            const alias = f.alias || `${ds.tmpTableName}.1.${f.name}`;
            return `        <Field Name="${f.name}">\n          <DataField>${alias}</DataField>\n          <rd:TypeName>${rdlType(f.dataType)}</rd:TypeName>\n        </Field>`;
          });
          rdlFields = `      <Fields>\n${flines.join('\n')}\n      </Fields>\n`;
        }
        return `    <DataSet Name="${ds.name}">
      <rd:DataSetID>${uuid()}</rd:DataSetID>
      <Query>
        <DataSourceName>AutoGen__ReportDataProvider</DataSourceName>
        <QueryParameters>
${queryParams}
        </QueryParameters>
        <CommandText>SELECT * FROM ${ds.dpClassName}.${ds.tmpTableName}</CommandText>
        <rd:UseGenericDesigner>true</rd:UseGenericDesigner>
      </Query>
${rdlFields}      <rd:DataSetInfo>
        <rd:DataSetName>${ds.name}</rd:DataSetName>
        <rd:TableName>Fields</rd:TableName>
        <rd:TableAdapterFillMethod>Fill</rd:TableAdapterFillMethod>
        <rd:TableAdapterGetDataMethod>GetData</rd:TableAdapterGetDataMethod>
        <rd:TableAdapterName>FieldsTableAdapter</rd:TableAdapterName>
      </rd:DataSetInfo>
    </DataSet>`;
      };

      const rdlDatasetsXml = `  <DataSets>\n${datasets.map(buildRdlDataset).join('\n')}\n  </DataSets>`;

      // ── Build a simple detail tablix for each dataset so the design is not empty ──
      const buildRdlTablix = (ds: DatasetDef): string => {
        if (!ds.fields || ds.fields.length === 0) return '';
        const n      = ds.fields.length;
        const colW   = +Math.min(1.5, 7 / n).toFixed(2);
        const totalW = +(colW * n).toFixed(2);
        const grp    = `Details_${ds.name}`;
        const cols   = ds.fields.map(() =>
          `            <TablixColumn><Width>${colW}in</Width></TablixColumn>`).join('\n');
        const hCells = ds.fields.map(f => [
          `            <TablixCell><CellContents>`,
          `              <Textbox Name="Textbox_${f.name}_H">`,
          `                <CanGrow>true</CanGrow><Value>${f.name}</Value>`,
          `                <Style><FontWeight>Bold</FontWeight>`,
          `                  <BackgroundColor>LightGrey</BackgroundColor>`,
          `                  <Border><Style>Solid</Style></Border>`,
          `                  <PaddingLeft>2pt</PaddingLeft><PaddingRight>2pt</PaddingRight>`,
          `                  <PaddingTop>2pt</PaddingTop><PaddingBottom>2pt</PaddingBottom>`,
          `                </Style></Textbox>`,
          `            </CellContents></TablixCell>`,
        ].join('\n')).join('\n');
        const dCells = ds.fields.map(f => [
          `            <TablixCell><CellContents>`,
          `              <Textbox Name="Textbox_${f.name}">`,
          `                <CanGrow>true</CanGrow><Value>=Fields!${f.name}.Value</Value>`,
          `                <Style><Border><Style>Solid</Style></Border>`,
          `                  <PaddingLeft>2pt</PaddingLeft><PaddingRight>2pt</PaddingRight>`,
          `                  <PaddingTop>2pt</PaddingTop><PaddingBottom>2pt</PaddingBottom>`,
          `                </Style></Textbox>`,
          `            </CellContents></TablixCell>`,
        ].join('\n')).join('\n');
        const cMembers = ds.fields.map(() => `          <TablixMember />`).join('\n');
        return [
          `        <Tablix Name="Tablix_${ds.name}">`,
          `          <TablixBody>`,
          `            <TablixColumns>`,
          cols,
          `            </TablixColumns>`,
          `            <TablixRows>`,
          `              <TablixRow><Height>0.25in</Height><TablixCells>`,
          hCells,
          `              </TablixCells></TablixRow>`,
          `              <TablixRow><Height>0.25in</Height><TablixCells>`,
          dCells,
          `              </TablixCells></TablixRow>`,
          `            </TablixRows>`,
          `          </TablixBody>`,
          `          <TablixColumnHierarchy><TablixMembers>`,
          cMembers,
          `          </TablixMembers></TablixColumnHierarchy>`,
          `          <TablixRowHierarchy><TablixMembers>`,
          `            <TablixMember>`,
          `              <KeepWithGroup>After</KeepWithGroup>`,
          `              <RepeatOnNewPage>true</RepeatOnNewPage>`,
          `            </TablixMember>`,
          `            <TablixMember><Group Name="${grp}"><DataGroupName>${grp}</DataGroupName></Group></TablixMember>`,
          `          </TablixMembers></TablixRowHierarchy>`,
          `          <DataSetName>${ds.name}</DataSetName>`,
          `          <Top>0.5in</Top><Left>0.5in</Left>`,
          `          <Height>0.5in</Height><Width>${totalW}in</Width>`,
          `          <Style><Border><Style>Solid</Style></Border></Style>`,
          `        </Tablix>`,
        ].join('\n');
      };
      const rdlBodyItemsXml = datasets.map(buildRdlTablix).filter(Boolean).join('\n');
      const rdlBodyTag = rdlBodyItemsXml
        ? `        <ReportItems>\n${rdlBodyItemsXml}\n        </ReportItems>`
        : `        <ReportItems />`;

      // ReportParameters — 6 AX system params + DynamicParameter + contract params (all hidden)
      const contractRdlParams = (firstDs.contractParams || []).map(cp => ({
        name: `${firstDs.name}_ds_${cp.name}`,
        nullable: true, blank: true, usedInQuery: true,
      }));
      const rdlParamDefs = [
        { name: 'AX_PartitionKey',      nullable: true,  blank: true,  usedInQuery: false },
        { name: 'AX_CompanyName',        nullable: false, blank: false, usedInQuery: false },
        { name: 'AX_UserContext',        nullable: true,  blank: true,  usedInQuery: false },
        { name: 'AX_RenderingCulture',   nullable: true,  blank: true,  usedInQuery: false },
        { name: 'AX_ReportContext',       nullable: true,  blank: true,  usedInQuery: true  },
        { name: 'AX_RdpPreProcessedId',  nullable: true,  blank: true,  usedInQuery: false },
        { name: dpParamName,             nullable: true,  blank: true,  usedInQuery: false },
        ...contractRdlParams,
      ];
      const rdlParamsXml = `  <ReportParameters>\n` +
        rdlParamDefs.map(p => {
          const nullLine  = p.nullable     ? `\n      <Nullable>true</Nullable>`        : '';
          const blankLine = p.blank        ? `\n      <AllowBlank>true</AllowBlank>`    : '';
          const usedLine  = p.usedInQuery  ? `\n      <UsedInQuery>true</UsedInQuery>` : '';
          return `    <ReportParameter Name="${p.name}">\n      <DataType>String</DataType>${nullLine}${blankLine}\n      <Prompt>${p.name}</Prompt>\n      <Hidden>true</Hidden>${usedLine}\n    </ReportParameter>`;
        }).join('\n') + `\n  </ReportParameters>`;

      // ReportParametersLayout
      const cellDefs = rdlParamDefs
        .map((p, i) =>
          `        <CellDefinition>\n          <ColumnIndex>${i}</ColumnIndex>\n          <RowIndex>0</RowIndex>\n          <ParameterName>${p.name}</ParameterName>\n        </CellDefinition>`)
        .join('\n');
      const rdlParamLayoutXml =
`  <ReportParametersLayout>
    <GridLayoutDefinition>
      <NumberOfColumns>${rdlParamDefs.length}</NumberOfColumns>
      <NumberOfRows>1</NumberOfRows>
      <CellDefinitions>
${cellDefs}
      </CellDefinitions>
    </GridLayoutDefinition>
  </ReportParametersLayout>`;

      return `<?xml version="1.0" encoding="utf-8"?>
<Report xmlns="${ns2016}" xmlns:rd="${nsRd}">
  <AutoRefresh>0</AutoRefresh>
${rdlDataSourcesXml}
${rdlDatasetsXml}
  <ReportSections>
    <ReportSection>
      <Body>
${rdlBodyTag}
        <Height>1in</Height>
        <Style>
          <Border>
            <Style>None</Style>
          </Border>
        </Style>
      </Body>
      <Width>7.5in</Width>
      <Page>
        <PageHeight>11.69in</PageHeight>
        <PageWidth>8.27in</PageWidth>
        <InteractiveHeight>11in</InteractiveHeight>
        <InteractiveWidth>8.5in</InteractiveWidth>
        <LeftMargin>0.2in</LeftMargin>
        <TopMargin>0.2in</TopMargin>
        <Style />
      </Page>
    </ReportSection>
  </ReportSections>
${rdlParamsXml}
${rdlParamLayoutXml}
  <Language>en-US</Language>
  <rd:ReportUnitType>Inch</rd:ReportUnitType>
  <rd:ReportID>${uuid()}</rd:ReportID>
</Report>`;
    };

    // ── Design block ──
    const captionLine = properties?.caption ? `\n\t\t\t<Caption>${properties.caption}</Caption>` : '';
    const styleLine   = properties?.style   ? `\n\t\t\t<Style>${properties.style}</Style>`       : '';
    const rdlContent  = properties?.rdlContent as string | undefined;
    // Sanitize: fix old-schema <Header> inside <TablixMember> — renamed to <TablixHeader> in 2016 RDL.
    // This handles AI-generated or older-tool-generated RDL that still uses the pre-2016 element name.
    const rdl = (rdlContent || buildRdlSkeleton())
      .replace(/<Header>/g, '<TablixHeader>')
      .replace(/<\/Header>/g, '</TablixHeader>');
    const textElement = `\n\t\t\t<Text><![CDATA[${rdl}]]></Text>`;

    return `<?xml version="1.0" encoding="utf-8"?>
<AxReport xmlns:i="http://www.w3.org/2001/XMLSchema-instance" xmlns="Microsoft.Dynamics.AX.Metadata.V2">
\t<Name>${reportName}</Name>
\t<DataMethods />
\t<DataSets>
${datasetsXml}
\t</DataSets>
${defaultParamGroupXml}
\t<Designs>
\t\t<AxReportDesign xmlns=""
\t\t\t\ti:type="AxReportPrecisionDesign">
\t\t\t<Name>${designName}</Name>${captionLine}${styleLine}${textElement}
\t\t\t<DisableIndividualTransformation>
\t\t\t\t<Name>DisableIndividualTransformation</Name>
\t\t\t</DisableIndividualTransformation>
\t\t</AxReportDesign>
\t</Designs>
\t<EmbeddedImages />
</AxReport>`;
  }

  /**
   * Generate XML based on object type
   */
  static generate(
    objectType: string,
    objectName: string,
    sourceCode?: string,
    properties?: Record<string, any>
  ): string {
    switch (objectType) {
      case 'class':
        return this.generateAxClassXml(objectName, sourceCode, properties);
      case 'class-extension':
        return this.generateAxClassExtensionXml(objectName, sourceCode, properties);
      case 'table': {
        // sourceCode is not used for tables directly, but Copilot may pass field
        // definitions as a JSON string in sourceCode. Try to parse and merge into properties.
        let mergedProperties = properties;
        if (sourceCode && sourceCode.trim().startsWith('{')) {
          try {
            const parsed = JSON.parse(sourceCode);
            if (parsed && (Array.isArray(parsed.fields) || parsed.label || parsed.tableGroup)) {
              mergedProperties = { ...parsed, ...properties }; // explicit properties win
              console.error('[create_d365fo_file] Parsed table field definitions from sourceCode JSON');
            }
          } catch {
            // Not valid JSON — ignore
          }
        }
        return this.generateAxTableXml(objectName, mergedProperties);
      }
      case 'enum':
        return this.generateAxEnumXml(objectName, properties);
      case 'form':
        return this.generateAxFormXml(objectName, properties);
      case 'query':
        return this.generateAxQueryXml(objectName, properties);
      case 'view':
        return this.generateAxViewXml(objectName, properties);
      case 'data-entity':
        return this.generateAxDataEntityXml(objectName, properties);
      case 'report':
        return this.generateAxReportXml(objectName, properties);
      case 'edt':
        return this.generateAxEdtXml(objectName, properties);
      case 'table-extension':
        return this.generateAxTableExtensionXml(objectName, properties);
      case 'form-extension':
        return this.generateAxFormExtensionXml(objectName);
      case 'edt-extension':
        return this.generateAxSimpleExtensionXml('AxEdtExtension', objectName);
      case 'enum-extension':
        return this.generateAxSimpleExtensionXml('AxEnumExtension', objectName);
      case 'data-entity-extension':
        return this.generateAxSimpleExtensionXml('AxDataEntityViewExtension', objectName);
      case 'menu-item-display':
      case 'menu-item-action':
      case 'menu-item-output':
        return this.generateAxMenuItemXml(objectType, objectName, properties);
      case 'menu-item-display-extension':
        return this.generateAxSimpleExtensionXml('AxMenuItemDisplayExtension', objectName);
      case 'menu-item-action-extension':
        return this.generateAxSimpleExtensionXml('AxMenuItemActionExtension', objectName);
      case 'menu-item-output-extension':
        return this.generateAxSimpleExtensionXml('AxMenuItemOutputExtension', objectName);
      case 'menu':
        return this.generateAxMenuXml(objectName, properties);
      case 'menu-extension':
        return this.generateAxMenuExtensionXml(objectName);
      case 'security-privilege':
        return this.generateAxSecurityPrivilegeXml(objectName, properties);
      case 'security-duty':
        return this.generateAxSecurityDutyXml(objectName, properties);
      case 'security-role':
        return this.generateAxSecurityRoleXml(objectName, properties);
      case 'business-event':
        return XmlTemplateGenerator.generateBusinessEventXml(objectName, properties);
      case 'tile':
        return XmlTemplateGenerator.generateAxTileXml(objectName, properties);
      case 'kpi':
        return XmlTemplateGenerator.generateAxKpiXml(objectName, properties);
      default:
        throw new Error(`Unsupported object type: ${objectType}`);
    }
  }

  /**
   * Sanitize AxQuery XML — ensures xmlns="" and i:type="AxQuerySimple" are present
   * on the root <AxQuery> element. D365FO deserializer requires both attributes.
   */
  static sanitizeQueryXml(xml: string): string {
    return xml.replace(
      /<AxQuery(\s[^>]*)?>/,
      (_match, attrs: string | undefined) => {
        let a = attrs || '';
        if (!a.includes('xmlns=""')) {
          a += ' xmlns=""';
        }
        if (!a.includes('i:type="AxQuerySimple"')) {
          a += '\n\ti:type="AxQuerySimple"';
        }
        return `<AxQuery${a}>`;
      }
    );
  }

  /**
   * Sanitize AxReport XML to guarantee the structural elements required by the D365FO
   * Visual Studio Designer metadata loader, regardless of whether the XML was generated
   * by the template or supplied verbatim by a caller via the xmlContent parameter.
   *
   * Required invariants:
   *  1. xmlns="Microsoft.Dynamics.AX.Metadata.V2" on <AxReport> root
   *  2. <DataMethods /> directly after <Name>…</Name>
   *  3. xmlns="" on every <AxReportDataSet> child element (namespace reset)
   *  4. </AxReport> closing tag present (guard against truncated XML)
   *  5. <AxReportDesign> has xmlns="" and i:type="AxReportPrecisionDesign" attributes
   *     (VS Designer won't show Designs sub-nodes without these)
   */

  /**
   * Sanitize AxTable XML to ensure correct D365FO field element format.
   *
   * D365FO requires fields as:
   *   <AxTableField xmlns=""
   *     i:type="AxTableFieldString"> ... </AxTableField>
   *
   * AI generators often emit the shorter form:
   *   <AxTableFieldString> ... </AxTableFieldString>
   *
   * This method also ensures <FullTextIndexes /> is present between </Fields> and <Indexes>.
   */
  static sanitizeTableXml(xml: string): string {
    const fieldTypes = [
      'AxTableFieldString', 'AxTableFieldInt', 'AxTableFieldInt64',
      'AxTableFieldReal', 'AxTableFieldDate', 'AxTableFieldUtcDateTime',
      'AxTableFieldEnum', 'AxTableFieldGuid', 'AxTableFieldContainer',
    ];

    for (const ft of fieldTypes) {
      // Opening tag: <AxTableFieldString ...> → <AxTableField xmlns="" i:type="AxTableFieldString" ...>
      // Only replace if NOT already inside a correct <AxTableField xmlns="" i:type="..."> wrapper
      const openRe = new RegExp(`<${ft}(\\s[^>]*)?>`, 'g');
      xml = xml.replace(openRe, (_match, attrs: string | undefined) => {
        const extra = attrs ? attrs : '';
        return `<AxTableField xmlns=""\n\t\t\ti:type="${ft}"${extra}>`;
      });
      // Closing tag
      xml = xml.replace(new RegExp(`<\\/${ft}>`, 'g'), '</AxTableField>');
    }

    // Ensure <FullTextIndexes /> is present between </Fields> and <Indexes>
    if (!xml.includes('<FullTextIndexes')) {
      xml = xml.replace('</Fields>\n\t<Indexes', '</Fields>\n\t<FullTextIndexes />\n\t<Indexes');
      xml = xml.replace('</Fields>\n<Indexes', '</Fields>\n<FullTextIndexes />\n<Indexes');
    }

    return xml;
  }

  static sanitizeReportXml(xml: string): string {
    // 1. Ensure xmlns="Microsoft.Dynamics.AX.Metadata.V2" on <AxReport> opening tag
    if (!xml.includes('xmlns="Microsoft.Dynamics.AX.Metadata.V2"')) {
      xml = xml.replace(/<AxReport(\s[^>]*)?>/, (match) => {
        // Insert the namespace attribute before the closing > of the tag
        return match.slice(0, -1) + ' xmlns="Microsoft.Dynamics.AX.Metadata.V2">';
      });
      console.error('[sanitizeReportXml] Added xmlns="Microsoft.Dynamics.AX.Metadata.V2" to <AxReport>');
    }

    // 2. Ensure <DataMethods /> exists directly after the top-level <Name>
    if (!xml.includes('<DataMethods')) {
      // Match only the first <Name>…</Name> (the report's own name, not nested ones)
      xml = xml.replace(/(<Name>[^<]*<\/Name>)/, '$1\n\t<DataMethods />');
      console.error('[sanitizeReportXml] Inserted missing <DataMethods />');
    }

    // 3. Ensure xmlns="" on each <AxReportDataSet> (bare tag without the attribute)
    if (xml.includes('<AxReportDataSet>')) {
      xml = xml.replace(/<AxReportDataSet>/g, '<AxReportDataSet xmlns="">');
      console.error('[sanitizeReportXml] Added xmlns="" to <AxReportDataSet> elements');
    }

    // 4. Ensure </AxReport> closing tag is present (guard against truncated XML)
    const trimmed = xml.trimEnd();
    if (!trimmed.endsWith('</AxReport>')) {
      xml = trimmed + '\n</AxReport>';
      console.error('[sanitizeReportXml] Appended missing </AxReport> closing tag');
    }

    // 5. Ensure <AxReportDesign> has xmlns="" and i:type="AxReportPrecisionDesign"
    //    VS Designer requires both attributes to render the Designs sub-tree correctly.
    //    Match bare <AxReportDesign> or one that is already partially attributed.
    xml = xml.replace(/<AxReportDesign(\s[^>]*)?>/, (match, attrs: string | undefined) => {
      const current = attrs || '';
      let updated = current;
      if (!updated.includes('xmlns=""')) {
        updated = ` xmlns=""${updated}`;
      }
      if (!updated.includes('i:type=')) {
        updated += `\n\t\t\t\ti:type="AxReportPrecisionDesign"`;
      }
      if (updated === current) return match; // nothing changed — idempotent
      console.error('[sanitizeReportXml] Fixed <AxReportDesign> attributes (xmlns="" + i:type)');
      return `<AxReportDesign${updated}>`;
    });


    // 6. Ensure <Parameters> block inside <AxReportDataSet> for real RDP datasets.
    //    Skipped for stub/minimal datasets that have no <DataSourceType>.
    if (xml.includes('<DataSourceType>') && !xml.includes('<Parameters>')) {
      const axDatasetParams =
        '\t\t\t<Parameters>\n' +
        '\t\t\t\t<AxReportDataSetParameter>\n' +
        '\t\t\t\t\t<Name>AX_PartitionKey</Name>\n' +
        '\t\t\t\t\t<Alias>AX_PartitionKey</Alias>\n' +
        '\t\t\t\t\t<DataType>System.String</DataType>\n' +
        '\t\t\t\t\t<Parameter>AX_PartitionKey</Parameter>\n' +
        '\t\t\t\t</AxReportDataSetParameter>\n' +
        '\t\t\t\t<AxReportDataSetParameter>\n' +
        '\t\t\t\t\t<Name>AX_CompanyName</Name>\n' +
        '\t\t\t\t\t<Alias>AX_CompanyName</Alias>\n' +
        '\t\t\t\t\t<DataType>System.String</DataType>\n' +
        '\t\t\t\t\t<Parameter>AX_CompanyName</Parameter>\n' +
        '\t\t\t\t</AxReportDataSetParameter>\n' +
        '\t\t\t\t<AxReportDataSetParameter>\n' +
        '\t\t\t\t\t<Name>AX_UserContext</Name>\n' +
        '\t\t\t\t\t<Alias>AX_UserContext</Alias>\n' +
        '\t\t\t\t\t<DataType>System.String</DataType>\n' +
        '\t\t\t\t\t<Parameter>AX_UserContext</Parameter>\n' +
        '\t\t\t\t</AxReportDataSetParameter>\n' +
        '\t\t\t\t<AxReportDataSetParameter>\n' +
        '\t\t\t\t\t<Name>AX_RenderingCulture</Name>\n' +
        '\t\t\t\t\t<Alias>AX_RenderingCulture</Alias>\n' +
        '\t\t\t\t\t<DataType>System.String</DataType>\n' +
        '\t\t\t\t\t<Parameter>AX_RenderingCulture</Parameter>\n' +
        '\t\t\t\t</AxReportDataSetParameter>\n' +
        '\t\t\t\t<AxReportDataSetParameter>\n' +
        '\t\t\t\t\t<Name>AX_ReportContext</Name>\n' +
        '\t\t\t\t\t<Alias>AX_ReportContext</Alias>\n' +
        '\t\t\t\t\t<DataType>System.String</DataType>\n' +
        '\t\t\t\t\t<Parameter>AX_ReportContext</Parameter>\n' +
        '\t\t\t\t</AxReportDataSetParameter>\n' +
        '\t\t\t\t<AxReportDataSetParameter>\n' +
        '\t\t\t\t\t<Name>AX_RdpPreProcessedId</Name>\n' +
        '\t\t\t\t\t<Alias>AX_RdpPreProcessedId</Alias>\n' +
        '\t\t\t\t\t<DataType>System.String</DataType>\n' +
        '\t\t\t\t\t<Parameter>AX_RdpPreProcessedId</Parameter>\n' +
        '\t\t\t\t</AxReportDataSetParameter>\n' +
        '\t\t\t</Parameters>';
      if (xml.includes('</Fields>')) {
        xml = xml.replace('</Fields>', `</Fields>\n${axDatasetParams}`);
      } else if (xml.includes('<Fields />')) {
        xml = xml.replace('<Fields />', `<Fields />\n${axDatasetParams}`);
      } else {
        xml = xml.replace('</AxReportDataSet>', `${axDatasetParams}\n\t\t</AxReportDataSet>`);
      }
      console.error('[sanitizeReportXml] Added missing <Parameters> to <AxReportDataSet>');
    }

    // 7. Ensure <DefaultParameterGroup> before <Designs> for real RDP datasets.
    if (xml.includes('<DataSourceType>') && !xml.includes('<DefaultParameterGroup>') && xml.includes('<Designs>')) {
      const defaultParamGroup =
        '\t<DefaultParameterGroup>\n' +
        '\t\t<Name xmlns="">Parameters</Name>\n' +
        '\t\t<ReportParameterBases xmlns="">\n' +
        '\t\t\t<AxReportParameterBase xmlns=""\n' +
        '\t\t\t\t\ti:type="AxReportParameter">\n' +
        '\t\t\t\t<Name>AX_PartitionKey</Name>\n' +
        '\t\t\t\t<AllowBlank>true</AllowBlank>\n' +
        '\t\t\t\t<Nullable>true</Nullable>\n' +
        '\t\t\t\t<UserVisibility>Hidden</UserVisibility>\n' +
        '\t\t\t\t<DefaultValue />\n' +
        '\t\t\t\t<Values />\n' +
        '\t\t\t</AxReportParameterBase>\n' +
        '\t\t\t<AxReportParameterBase xmlns=""\n' +
        '\t\t\t\t\ti:type="AxReportParameter">\n' +
        '\t\t\t\t<Name>AX_CompanyName</Name>\n' +
        '\t\t\t\t<UserVisibility>Hidden</UserVisibility>\n' +
        '\t\t\t\t<DefaultValue />\n' +
        '\t\t\t\t<Values />\n' +
        '\t\t\t</AxReportParameterBase>\n' +
        '\t\t\t<AxReportParameterBase xmlns=""\n' +
        '\t\t\t\t\ti:type="AxReportParameter">\n' +
        '\t\t\t\t<Name>AX_UserContext</Name>\n' +
        '\t\t\t\t<AllowBlank>true</AllowBlank>\n' +
        '\t\t\t\t<Nullable>true</Nullable>\n' +
        '\t\t\t\t<UserVisibility>Hidden</UserVisibility>\n' +
        '\t\t\t\t<DefaultValue />\n' +
        '\t\t\t\t<Values />\n' +
        '\t\t\t</AxReportParameterBase>\n' +
        '\t\t\t<AxReportParameterBase xmlns=""\n' +
        '\t\t\t\t\ti:type="AxReportParameter">\n' +
        '\t\t\t\t<Name>AX_RenderingCulture</Name>\n' +
        '\t\t\t\t<AllowBlank>true</AllowBlank>\n' +
        '\t\t\t\t<Nullable>true</Nullable>\n' +
        '\t\t\t\t<UserVisibility>Hidden</UserVisibility>\n' +
        '\t\t\t\t<DefaultValue />\n' +
        '\t\t\t\t<Values />\n' +
        '\t\t\t</AxReportParameterBase>\n' +
        '\t\t\t<AxReportParameterBase xmlns=""\n' +
        '\t\t\t\t\ti:type="AxReportParameter">\n' +
        '\t\t\t\t<Name>AX_ReportContext</Name>\n' +
        '\t\t\t\t<AllowBlank>true</AllowBlank>\n' +
        '\t\t\t\t<Nullable>true</Nullable>\n' +
        '\t\t\t\t<UserVisibility>Hidden</UserVisibility>\n' +
        '\t\t\t\t<DefaultValue />\n' +
        '\t\t\t\t<Values />\n' +
        '\t\t\t</AxReportParameterBase>\n' +
        '\t\t\t<AxReportParameterBase xmlns=""\n' +
        '\t\t\t\t\ti:type="AxReportParameter">\n' +
        '\t\t\t\t<Name>AX_RdpPreProcessedId</Name>\n' +
        '\t\t\t\t<AllowBlank>true</AllowBlank>\n' +
        '\t\t\t\t<Nullable>true</Nullable>\n' +
        '\t\t\t\t<UserVisibility>Hidden</UserVisibility>\n' +
        '\t\t\t\t<DefaultValue />\n' +
        '\t\t\t\t<Values />\n' +
        '\t\t\t</AxReportParameterBase>\n' +
        '\t\t</ReportParameterBases>\n' +
        '\t</DefaultParameterGroup>';
      xml = xml.replace('<Designs>', `${defaultParamGroup}\n\t<Designs>`);
      console.error('[sanitizeReportXml] Added missing <DefaultParameterGroup>');
    }

    // 8. Fix embedded RDL structural issues based on the SSRS namespace version:
    //    2008/01 — <PageHeader>/<PageFooter> must be inside <Page> (direct child of <Report>).
    //    2010/01+ (2010, 2016, future) — <Body> and <Page> must NOT be direct children of
    //              <Report>; they must be wrapped in:
    //              <ReportSections><ReportSection>...</ReportSection></ReportSections>
    //              Placing <Page> directly under <Report> causes:
    //              "Deserialization failed: invalid child element 'Page'" in VS Designer.
    xml = xml.replace(/(<Text><!\[CDATA\[)([\s\S]*?)(\]\]><\/Text>)/, (_whole, open, rdl, close) => {
      const is2008 = rdl.includes('reporting/2008/01/reportdefinition');
      // Any SSRS namespace newer than 2008 requires ReportSections wrapping
      const isModernRdl = !is2008 && /reporting\/20\d\d\/\d\d\/reportdefinition/.test(rdl);
      const is2010 = isModernRdl; // kept for branch clarity below
      let fixedRdl = rdl;
      let changed = false;

      if (is2010 && !rdl.includes('<ReportSections>')) {
        // 2010 schema: collect any stray Body/Page/PageHeader/PageFooter that are direct
        // children of <Report>, then wrap them in ReportSections/ReportSection.
        let pageEl = '';
        const existingPageMatch = fixedRdl.match(/<Page(?:\s[^>]*)?>([\s\S]*?)<\/Page>/);
        if (existingPageMatch) {
          pageEl = existingPageMatch[0];
          fixedRdl = fixedRdl.replace(existingPageMatch[0], '');
          // PageHeader/PageFooter may still be direct children of <Report> (outside the <Page>
          // element we just extracted). Inject them into pageEl before </Page>.
          let extraPageContent = '';
          const phMatch = fixedRdl.match(/<PageHeader[\s\S]*?<\/PageHeader>/);
          if (phMatch && !pageEl.includes('<PageHeader')) {
            extraPageContent += phMatch[0];
            fixedRdl = fixedRdl.replace(phMatch[0], '');
          }
          const pfMatch = fixedRdl.match(/<PageFooter[\s\S]*?<\/PageFooter>/);
          if (pfMatch && !pageEl.includes('<PageFooter')) {
            extraPageContent += (extraPageContent ? '\n' : '') + pfMatch[0];
            fixedRdl = fixedRdl.replace(pfMatch[0], '');
          }
          if (extraPageContent) {
            pageEl = pageEl.replace('</Page>', extraPageContent.trim() + '\n</Page>');
            console.error('[sanitizeReportXml] Moved stray <PageHeader>/<PageFooter> into existing <Page> (2010 RDL)');
          }
        } else {
          let pageInner = '';
          const phMatch = fixedRdl.match(/<PageHeader[\s\S]*?<\/PageHeader>/);
          if (phMatch) { pageInner += phMatch[0]; fixedRdl = fixedRdl.replace(phMatch[0], ''); }
          const pfMatch = fixedRdl.match(/<PageFooter[\s\S]*?<\/PageFooter>/);
          if (pfMatch) { pageInner += (pageInner ? '\n' : '') + pfMatch[0]; fixedRdl = fixedRdl.replace(pfMatch[0], ''); }
          if (pageInner) pageEl = '<Page>\n' + pageInner.trim() + '\n</Page>';
        }
        const bodyMatch = fixedRdl.match(/<Body[\s\S]*?<\/Body>/);
        let sectionContent = '';
        if (bodyMatch) { sectionContent += bodyMatch[0]; fixedRdl = fixedRdl.replace(bodyMatch[0], ''); }
        if (pageEl) sectionContent += (sectionContent ? '\n' : '') + pageEl;
        if (sectionContent) {
          const reportSections =
            '<ReportSections>\n<ReportSection>\n' + sectionContent.trim() + '\n</ReportSection>\n</ReportSections>';
          fixedRdl = fixedRdl.includes('</Report>')
            ? fixedRdl.replace('</Report>', reportSections + '\n</Report>')
            : fixedRdl + '\n' + reportSections;
          changed = true;
          const rdlVersion = rdl.match(/reporting\/(20\d\d\/\d\d)\/reportdefinition/)?.[1] ?? 'modern';
          console.error(`[sanitizeReportXml] Wrapped Body+Page in <ReportSections>/<ReportSection> for ${rdlVersion} RDL`);
        }

      } else if (is2008 && (rdl.includes('<PageHeader') || rdl.includes('<PageFooter'))) {
        // 2008 schema: <PageHeader>/<PageFooter> must be inside <Page>, not direct children of <Report>.
        // A real D365FO RDL always has a <Page> element (PageWidth/Height/Margins) but PageHeader is
        // still a sibling — the old guard `!rdl.match(/<Page...>/)` incorrectly skipped this case.
        // Strategy:
        //   a) If <Page> already exists — inject PageHeader/PageFooter before </Page>.
        //   b) If <Page> doesn't exist — create one after </Body>.
        const pageMatch = fixedRdl.match(/<Page(?:\s[^>]*)?>[\s\S]*?<\/Page>/);
        const alreadyInPage = !!pageMatch &&
          (pageMatch[0].includes('<PageHeader') || pageMatch[0].includes('<PageFooter'));
        if (!alreadyInPage) {
          let pageInner = '';
          const phMatch = fixedRdl.match(/<PageHeader[\s\S]*?<\/PageHeader>/);
          if (phMatch) { pageInner += phMatch[0]; fixedRdl = fixedRdl.replace(phMatch[0], ''); }
          const pfMatch = fixedRdl.match(/<PageFooter[\s\S]*?<\/PageFooter>/);
          if (pfMatch) { pageInner += (pageInner ? '\n' : '') + pfMatch[0]; fixedRdl = fixedRdl.replace(pfMatch[0], ''); }
          if (pageInner) {
            if (pageMatch) {
              // Inject into the existing <Page> before </Page>
              const updatedPage = pageMatch[0].replace('</Page>', pageInner.trim() + '\n</Page>');
              fixedRdl = fixedRdl.replace(pageMatch[0], updatedPage);
            } else {
              // No existing <Page> — create one after </Body>
              const pageEl = '<Page>\n' + pageInner.trim() + '\n</Page>';
              fixedRdl = fixedRdl.includes('</Body>')
                ? fixedRdl.replace('</Body>', '</Body>\n' + pageEl)
                : fixedRdl.replace('</Report>', pageEl + '\n</Report>');
            }
            changed = true;
            console.error('[sanitizeReportXml] Moved <PageHeader>/<PageFooter> inside <Page> in 2008 RDL');
          }
        }
      }

      if (!changed) return _whole;
      return open + fixedRdl + close;
    });

    // 9. Fix wrong margin element names inside embedded RDL.
    //    Some AI-generated RDLs use CSS-style names (MarginTop, MarginLeft, …) instead of
    //    the correct SSRS RDL names (TopMargin, LeftMargin, …).  All SSRS namespace versions
    //    require the XMargin form — MarginX causes "invalid child element 'MarginTop'" in
    //    VS Designer even though the value and namespace are otherwise correct.
    if (xml.includes('<MarginTop>') || xml.includes('<MarginBottom>') ||
        xml.includes('<MarginLeft>') || xml.includes('<MarginRight>')) {
      xml = xml
        .replace(/<MarginTop>/g,    '<TopMargin>')   .replace(/<\/MarginTop>/g,    '</TopMargin>')
        .replace(/<MarginBottom>/g, '<BottomMargin>').replace(/<\/MarginBottom>/g, '</BottomMargin>')
        .replace(/<MarginLeft>/g,   '<LeftMargin>')  .replace(/<\/MarginLeft>/g,   '</LeftMargin>')
        .replace(/<MarginRight>/g,  '<RightMargin>') .replace(/<\/MarginRight>/g,  '</RightMargin>');
      console.error('[sanitizeReportXml] Fixed wrong margin element names (MarginX → XMargin) in embedded RDL');
    }

    // 10. Ensure <Body> inside embedded RDL <ReportSection> has <ReportItems /> as its first
    //     child element.  SSRS schema requires the order: ReportItems → Height → Style.
    //     Without <ReportItems>, VS Designer can't surface the DataSet in the Report Data panel
    //     (it appears as if the dataset "disappeared") and may refuse to open the report.
    xml = xml.replace(/(<Text><!\[CDATA\[)([\s\S]*?)(\]\]><\/Text>)/, (_whole, open, rdl, close) => {
      // Match a <Body> that contains <Height> or <Style> but lacks <ReportItems>
      // (i.e., an empty skeleton body without any report items)
      const fixedRdl = rdl.replace(
        /<Body>\s*\n(\s*)((?!<ReportItems)[\s\S]*?)<\/Body>/,
        (_bodyMatch: string, indent: string, bodyContent: string) => {
          // Only add <ReportItems /> when the body has no report items at all
          if (bodyContent.includes('<ReportItems')) return _bodyMatch;
          console.error('[sanitizeReportXml] Added missing <ReportItems /> as first child of <Body> in embedded RDL');
          return `<Body>\n${indent}<ReportItems />\n${indent}${bodyContent.trimStart()}</Body>`;
        }
      );
      if (fixedRdl === rdl) return _whole;
      return open + fixedRdl + close;
    });

    // 11. Fix doubled closing tags inside embedded RDL CDATA.
    //     AI generators sometimes emit </Foo></Foo> (the closing tag twice).
    //     These are invalid XML and cause "Deserialization failed" in VS Designer.
    //     Pattern: </TagName></TagName>  →  </TagName>
    xml = xml.replace(/(<Text><!\[CDATA\[)([\s\S]*?)(\]\]><\/Text>)/, (_whole, open, rdl, close) => {
      const fixedRdl = rdl.replace(/<\/(\w+)><\/\1>/g, (_m: string, tag: string) => {
        console.error(`[sanitizeReportXml] Removed doubled closing tag </${tag}></${tag}> in embedded RDL`);
        return `</${tag}>`;
      });
      if (fixedRdl === rdl) return _whole;
      return open + fixedRdl + close;
    });

    // 12. Fix <Value> as direct child of <Textbox> in embedded RDL.
    //     SSRS 2008+ schema requires: <Textbox> → <Paragraphs><Paragraph><TextRuns><TextRun><Value>
    //     AI generators sometimes emit <Value> directly inside <Textbox>, which causes:
    //     "invalid child element 'Value'" error in VS Designer.
    //     This fix wraps any bare <Value>…</Value> found as a direct child of <Textbox>
    //     into the correct paragraph/textrun structure.
    xml = xml.replace(/(<Text><!\[CDATA\[)([\s\S]*?)(\]\]><\/Text>)/, (_whole, open, rdl, close) => {
      // Look for <Textbox ...> that contains a direct <Value> child (not inside <TextRun>)
      const fixedRdl = rdl.replace(
        /(<Textbox\b[^>]*>)([\s\S]*?)(<\/Textbox>)/g,
        (tbMatch: string, tbOpen: string, tbContent: string, tbClose: string) => {
          // Only act if there is a <Value> but no <Paragraphs> wrapping yet
          if (!tbContent.includes('<Value>') && !tbContent.includes('<Value =')) return tbMatch;
          if (tbContent.includes('<Paragraphs>')) return tbMatch;
          const fixedContent = tbContent.replace(
            /<Value>([\s\S]*?)<\/Value>/,
            (_vMatch: string, val: string) => {
              console.error('[sanitizeReportXml] Wrapped bare <Value> in <Textbox> into <Paragraphs> structure');
              return `<Paragraphs>\n            <Paragraph>\n              <TextRuns>\n                <TextRun>\n                  <Value>${val}</Value>\n                  <Style />\n                </TextRun>\n              </TextRuns>\n              <Style />\n            </Paragraph>\n          </Paragraphs>`;
            }
          );
          if (fixedContent === tbContent) return tbMatch;
          return tbOpen + fixedContent + tbClose;
        }
      );
      if (fixedRdl === rdl) return _whole;
      return open + fixedRdl + close;
    });

    // 13. Fix <ColSpan>/<RowSpan> as direct children of <TablixCell>.
    //     SSRS schema only allows CellContents, DataElementName, DataElementOutput
    //     as direct children of <TablixCell>. ColSpan/RowSpan must be INSIDE
    //     <CellContents> (after the report item, before </CellContents>).
    //     AI generators emit them BEFORE or AFTER the <CellContents> block:
    //       <TablixCell><ColSpan>2</ColSpan><CellContents>...</CellContents></TablixCell>
    //       <TablixCell><CellContents>...</CellContents><ColSpan>2</ColSpan></TablixCell>
    //     Both cause "invalid child element 'ColSpan'" deserialization error.
    xml = xml.replace(/(<Text><!\[CDATA\[)([\s\S]*?)(\]\]><\/Text>)/, (_whole, open, rdl, close) => {
      const fixedRdl = rdl.replace(
        /(<TablixCell>)([\s\S]*?)(<\/TablixCell>)/g,
        (tcMatch: string, tcOpen: string, tcContent: string, tcClose: string) => {
          // Use indexOf to split tcContent into: beforeCC / ccBlock / afterCC.
          // This reliably handles spans placed either before OR after CellContents.
          const ccStart = tcContent.indexOf('<CellContents');
          const ccEnd   = tcContent.indexOf('</CellContents>');
          if (ccStart === -1 || ccEnd === -1) return tcMatch;

          const beforeCC = tcContent.substring(0, ccStart);
          const ccBlock  = tcContent.substring(ccStart, ccEnd + '</CellContents>'.length);
          const afterCC  = tcContent.substring(ccEnd + '</CellContents>'.length);

          // Collect ColSpan/RowSpan from anywhere outside CellContents
          const spanTagRe = () => /[ \t\r\n]*<(ColSpan|RowSpan)>[^<]*<\/\1>/g;
          let spans = '';
          const cleanBefore = beforeCC.replace(spanTagRe(), (m) => { spans += '\n' + m.trim(); return ''; });
          const cleanAfter  = afterCC.replace( spanTagRe(), (m) => { spans += '\n' + m.trim(); return ''; });

          if (!spans) return tcMatch;

          // Move collected spans inside CellContents, just before </CellContents>
          const fixedCC = ccBlock.replace('</CellContents>', `${spans}\n</CellContents>`);
          console.error('[sanitizeReportXml] Moved <ColSpan>/<RowSpan> from <TablixCell> into <CellContents> in embedded RDL');
          return tcOpen + cleanBefore + fixedCC + cleanAfter + tcClose;
        }
      );
      if (fixedRdl === rdl) return _whole;
      return open + fixedRdl + close;
    });

    // 14. Fix flat border properties as direct children of <Style>.
    //     SSRS <Style> only accepts <Border>, <TopBorder>, <BottomBorder>,
    //     <LeftBorder>, <RightBorder> as border wrappers — not flat attributes
    //     like <BorderStyle>, <BorderColor>, <BorderWidth>.
    //     AI generators often emit:
    //       <Style><BorderStyle>Solid</BorderStyle><BorderColor>#000</BorderColor></Style>
    //     but the correct form is:
    //       <Style><Border><Style>Solid</Style><Color>#000</Color></Border></Style>
    //     Same pattern applies to TopBorderStyle/TopBorderColor/TopBorderWidth etc.
    //
    //     Previous approach (matching <Style>…</Style> blocks non-greedily) had a
    //     nesting failure: if an outer <Style> contained a nested <Style> element
    //     (e.g. <Border><Style>Solid</Style>…</Border>) BEFORE a flat <BorderStyle>,
    //     the non-greedy regex would bind the outer opening <Style> to the inner
    //     closing </Style>, leaving the flat tag unprocessed.
    //
    //     New approach: scan the CDATA directly for flat border-property clusters
    //     and replace them with the correct wrapper, independent of the containing
    //     <Style> block.  Adjacent flat tags (same group, separated only by
    //     whitespace) are collapsed into a single wrapper element.
    xml = xml.replace(/(<Text><!\[CDATA\[)([\s\S]*?)(\]\]><\/Text>)/g, (_whole, open, rdl, close) => {
      let fixedRdl = rdl;
      let changed = false;

      const groups: Array<[string, string]> = [
        ['Border',       'Border'],
        ['TopBorder',    'TopBorder'],
        ['BottomBorder', 'BottomBorder'],
        ['LeftBorder',   'LeftBorder'],
        ['RightBorder',  'RightBorder'],
      ];

      for (const [prefix, wrapper] of groups) {
        const st = `${prefix}Style`;
        const ct = `${prefix}Color`;
        const wt = `${prefix}Width`;

        if (!new RegExp(`<(?:${st}|${ct}|${wt})>`).test(fixedRdl)) continue;

        // Build a regex that matches a cluster of 1–3 adjacent flat border tags
        // for this group (in any order, with optional whitespace between them).
        const singleTag =
          `(?:<${st}>([^<]*)<\\/${st}>|<${ct}>([^<]*)<\\/${ct}>|<${wt}>([^<]*)<\\/${wt}>)`;
        const clusterRe = new RegExp(
          `${singleTag}(?:\\s*${singleTag})?(?:\\s*${singleTag})?`,
          'g'
        );

        fixedRdl = fixedRdl.replace(clusterRe, (match: string) => {
          // Extract each flat-tag value from the matched cluster via side-effect callbacks.
          let bStyle = '', bColor = '', bWidth = '';
          match.replace(new RegExp(`<${st}>([^<]*)<\\/${st}>`), (_: string, v: string) => { bStyle = v; return ''; });
          match.replace(new RegExp(`<${ct}>([^<]*)<\\/${ct}>`), (_: string, v: string) => { bColor = v; return ''; });
          match.replace(new RegExp(`<${wt}>([^<]*)<\\/${wt}>`), (_: string, v: string) => { bWidth = v; return ''; });

          let inner = '';
          if (bStyle) inner += `<Style>${bStyle}</Style>`;
          if (bColor) inner += `<Color>${bColor}</Color>`;
          if (bWidth) inner += `<Width>${bWidth}</Width>`;

          changed = true;
          return `<${wrapper}>${inner}</${wrapper}>`;
        });
      }

      if (!changed) return _whole;
      console.error('[sanitizeReportXml] Wrapped flat border properties into <Border> inside <Style> in embedded RDL');
      return open + fixedRdl + close;
    });

    // 15. Fix absorbed TablixCells following a ColSpan > 1.
    //     Confirmed by real D365FO reports: when <CellContents> has <ColSpan>N</ColSpan>,
    //     the next N-1 sibling TablixCells in the same <TablixCells> block must be empty
    //     (<TablixCell />). AI generators give those absorbed cells full CellContents,
    //     causing VS Report Designer to render an empty/broken design surface.
    //     Approach: for each <ColSpan>N</ColSpan>, trace past its containing
    //     </CellContents></TablixCell> then depth-count-walk the next N-1 TablixCells
    //     and replace any non-empty ones with <TablixCell />.
    xml = xml.replace(/(<Text><!\[CDATA\[)([\s\S]*?)(\]\]><\/Text>)/, (_whole, open, rdl, close) => {
      let fixedRdl = rdl;
      const patches: { start: number; end: number }[] = [];

      const csRe = /<ColSpan>(\d+)<\/ColSpan>/g;
      let csMatch: RegExpExecArray | null;
      while ((csMatch = csRe.exec(fixedRdl)) !== null) {
        const span = parseInt(csMatch[1], 10);
        if (span <= 1) continue;

        // Find </CellContents> that closes the CellContents containing this ColSpan
        const ccCloseIdx = fixedRdl.indexOf('</CellContents>', csMatch.index + csMatch[0].length);
        if (ccCloseIdx === -1) continue;
        // Find </TablixCell> that closes the TablixCell containing this CellContents
        const tcCloseIdx = fixedRdl.indexOf('</TablixCell>', ccCloseIdx + '</CellContents>'.length);
        if (tcCloseIdx === -1) continue;

        let pos = tcCloseIdx + '</TablixCell>'.length;

        for (let i = 0; i < span - 1; i++) {
          // Skip whitespace
          while (pos < fixedRdl.length && /\s/.test(fixedRdl[pos])) pos++;

          if (fixedRdl.startsWith('<TablixCell />', pos) || fixedRdl.startsWith('<TablixCell/>', pos)) {
            // Already empty — advance
            pos += fixedRdl.startsWith('<TablixCell />', pos) ? '<TablixCell />'.length : '<TablixCell/>'.length;
            continue;
          }
          if (!fixedRdl.startsWith('<TablixCell>', pos)) break; // Not a TablixCell

          // Walk to balanced </TablixCell>, counting nested TablixCell depth
          let depth = 1;
          let search = pos + '<TablixCell>'.length;
          while (depth > 0 && search < fixedRdl.length) {
            const nextOpen  = fixedRdl.indexOf('<TablixCell>',  search);
            const nextClose = fixedRdl.indexOf('</TablixCell>', search);
            if (nextClose === -1) { depth = 0; break; }
            if (nextOpen !== -1 && nextOpen < nextClose) {
              depth++;
              search = nextOpen + '<TablixCell>'.length;
            } else {
              depth--;
              search = nextClose + '</TablixCell>'.length;
            }
          }
          const cellEnd = search;
          patches.push({ start: pos, end: cellEnd });
          pos = cellEnd;
        }
      }

      if (patches.length === 0) return _whole;
      // Apply patches in reverse order to preserve string positions
      patches.sort((a, b) => b.start - a.start);
      let result = fixedRdl;
      for (const p of patches) {
        result = result.substring(0, p.start) + '<TablixCell />' + result.substring(p.end);
      }
      console.error(`[sanitizeReportXml] Emptied ${patches.length} absorbed TablixCell(s) following ColSpan in embedded RDL`);
      return open + result + close;
    });

    // 16. Rename reversed border side wrapper element names.
    //     SSRS schema expects <TopBorder>, <BottomBorder>, <LeftBorder>, <RightBorder>.
    //     AI generators often emit them reversed: <BorderTop>, <BorderBottom>, etc.
    //     The inner content (<Style>, <Color>, <Width>) is already correct — only
    //     the wrapper element name needs to change.
    if (xml.includes('<BorderTop>') || xml.includes('<BorderBottom>') ||
        xml.includes('<BorderLeft>') || xml.includes('<BorderRight>')) {
      xml = xml
        .replace(/<BorderTop>/g,     '<TopBorder>')    .replace(/<\/BorderTop>/g,     '</TopBorder>')
        .replace(/<BorderBottom>/g,  '<BottomBorder>') .replace(/<\/BorderBottom>/g,  '</BottomBorder>')
        .replace(/<BorderLeft>/g,    '<LeftBorder>')   .replace(/<\/BorderLeft>/g,    '</LeftBorder>')
        .replace(/<BorderRight>/g,   '<RightBorder>')  .replace(/<\/BorderRight>/g,   '</RightBorder>');
      console.error('[sanitizeReportXml] Fixed reversed border side wrapper names (BorderXxx → XxxBorder) in RDL');
    }

    // 17. Add missing </Style> before </Paragraph> when Paragraph-level Style is
    //     left unclosed. AI generators sometimes emit:
    //       <Paragraph><TextRuns>...</TextRuns><Style><TextAlign>Right</TextAlign></Paragraph>
    //     The </Style> before </Paragraph> is missing, which makes the XML
    //     malformed (</Paragraph> appears to close inside <Style>) and causes
    //     SSRS deserialization to fail entirely.
    xml = xml.replace(/(<Text><!\[CDATA\[)([\s\S]*?)(\]\]><\/Text>)/, (_whole, open, rdl, close) => {
      const fixedRdl = rdl.replace(
        /<Paragraph>([\s\S]*?)<\/Paragraph>/g,
        (match: string, inner: string) => {
          const opens  = (inner.match(/<Style>/g)  || []).length;
          const closes = (inner.match(/<\/Style>/g) || []).length;
          if (opens === closes) return match;
          const missing = opens - closes;
          console.error('[sanitizeReportXml] Added missing </Style> tag(s) inside <Paragraph> in embedded RDL');
          return `<Paragraph>${inner}${'</Style>'.repeat(missing)}</Paragraph>`;
        }
      );
      if (fixedRdl === rdl) return _whole;
      return open + fixedRdl + close;
    });

    // 18. Reconcile TablixCells count with TablixColumns count.
    //     Each TablixRow must have exactly as many TablixCell elements as there
    //     are TablixColumn entries in the enclosing Tablix's TablixColumns block.
    //     When the counts are mismatched VS Report Designer throws:
    //       "Index was out of range. Must be non-negative and less than the size
    //        of the collection. Parameter name: index"
    //
    //     Two cases are handled:
    //       A) A TablixRow has FEWER cells than TablixColumns → pad with <TablixCell />
    //       B) TablixColumns has FEWER entries than max cells per row → pad columns
    //
    //     The fix finds each top-level <Tablix>…</Tablix> block using depth
    //     tracking (to handle multiple/nested Tablix controls correctly) and
    //     reconciles column vs cell counts within each one independently.
    xml = xml.replace(/(<Text><!\[CDATA\[)([\s\S]*?)(\]\]><\/Text>)/g, (_whole, open, rdl, close) => {
      let fixedRdl = rdl;
      let changed = false;

      const processTablix = (block: string): string => {
        // Count declared TablixColumn entries (exclude TablixColumns container)
        const colsMatch = block.match(/<TablixColumns>([\s\S]*?)<\/TablixColumns>/);
        if (!colsMatch) return block;
        const colCount = (colsMatch[1].match(/<TablixColumn[\s>\/]/g) || []).length;
        if (colCount === 0) return block;

        // Sub-case A: pad each TablixCells block that has too few cells
        let result = block.replace(
          /(<TablixCells>)([\s\S]*?)(<\/TablixCells>)/g,
          (m: string, o: string, inner: string, c: string) => {
            const n = (inner.match(/<TablixCell[\s>\/]/g) || []).length;
            if (n >= colCount) return m;
            changed = true;
            const padding = Array(colCount - n).fill('\t\t\t\t<TablixCell />').join('\n');
            return `${o}${inner}\n${padding}\n\t\t\t${c}`;
          }
        );

        // Sub-case B: ensure TablixColumns has enough entries
        const cellsBlocks = result.match(/<TablixCells>([\s\S]*?)<\/TablixCells>/g) || [];
        const maxCells = cellsBlocks.reduce((mx, b) => {
          const n = (b.match(/<TablixCell[\s>\/]/g) || []).length;
          return n > mx ? n : mx;
        }, 0);
        if (maxCells > colCount) {
          const extra = Array(maxCells - colCount)
            .fill('\t\t<TablixColumn><Width>1in</Width></TablixColumn>')
            .join('\n');
          result = result.replace('</TablixColumns>', `\n${extra}\n\t\t</TablixColumns>`);
          changed = true;
        }

        return result;
      };

      // Depth-tracking scan for each top-level <Tablix>…</Tablix> block.
      // Child elements (<TablixBody>, <TablixColumns>, <TablixCell>, …) all have
      // letters immediately after '<Tablix', so the main element is identified by
      // '<Tablix' followed by '>', ' ', tab, or newline.
      let pos = 0;
      while (pos < fixedRdl.length) {
        const tagStart = fixedRdl.indexOf('<Tablix', pos);
        if (tagStart < 0) break;

        const ch = fixedRdl[tagStart + 7];
        if (ch !== '>' && ch !== ' ' && ch !== '\t' && ch !== '\n' && ch !== '\r') {
          pos = tagStart + 8;
          continue;
        }

        // Self-closing <Tablix /> — skip
        const tagEndIdx = fixedRdl.indexOf('>', tagStart);
        if (tagEndIdx < 0) break;
        if (fixedRdl[tagEndIdx - 1] === '/') { pos = tagEndIdx + 1; continue; }

        // Depth-scan for matching </Tablix>
        let depth = 1;
        let scan = tagEndIdx + 1;
        let closeTagPos = -1;
        while (depth > 0 && scan < fixedRdl.length) {
          const nxtOpen  = fixedRdl.indexOf('<Tablix', scan);
          const nxtClose = fixedRdl.indexOf('</Tablix>', scan);
          if (nxtClose < 0) break;

          if (nxtOpen >= 0 && nxtOpen < nxtClose) {
            const nc = fixedRdl[nxtOpen + 7];
            if (nc === '>' || nc === ' ' || nc === '\t' || nc === '\n' || nc === '\r') {
              depth++;
              const innerTagEnd = fixedRdl.indexOf('>', nxtOpen);
              scan = innerTagEnd >= 0 ? innerTagEnd + 1 : nxtOpen + 8;
            } else {
              scan = nxtOpen + 8;
            }
          } else {
            depth--;
            if (depth === 0) closeTagPos = nxtClose;
            scan = nxtClose + 9; // '</Tablix>'.length === 9
          }
        }

        if (closeTagPos < 0) break;
        const blockEnd = closeTagPos + 9;
        const block = fixedRdl.substring(tagStart, blockEnd);
        const fixed  = processTablix(block);
        if (fixed !== block) {
          fixedRdl = fixedRdl.substring(0, tagStart) + fixed + fixedRdl.substring(blockEnd);
          pos = tagStart + fixed.length;
        } else {
          pos = blockEnd;
        }
      }

      if (!changed) return _whole;
      console.error('[sanitizeReportXml] Reconciled TablixCell count with TablixColumn count in embedded RDL');
      return open + fixedRdl + close;
    });

    return xml;
  }

  /**
   * Convert <Text><![CDATA[…RDL…]]></Text> to XML entity-encoded form.
   *
   * D365FO stores and expects the embedded RDL as entity-encoded text, not CDATA:
   *   <Text>&lt;?xml version="1.0"?&gt;&lt;Report ...&gt;...&lt;/Report&gt;</Text>
   *
   * CDATA is valid XML and semantically equivalent, but the VS Designer metadata loader
   * does not render <Designs> correctly when the <Text> value uses CDATA — the design
   * appears empty even though no parse error is raised. Using entity encoding matches
   * what VS writes natively and fixes the empty-design issue.
   *
   * This is a SEPARATE method from sanitizeReportXml intentionally:
   *   - sanitizeReportXml operates on CDATA form (efficient regex over raw XML text)
   *   - encodeReportTextElement runs AFTER sanitize, just before writing to disk
   */
  static encodeReportTextElement(xml: string): string {
    return xml.replace(/<Text><!\[CDATA\[([\s\S]*?)\]\]><\/Text>/g, (_match, rdlInner: string) => {
      const encoded = rdlInner
        .replace(/&/g, '&amp;')   // must be first to avoid double-encoding
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
      return `<Text>${encoded}</Text>`;
    });
  }

  /**
   * Generate AxEdt XML (Extended Data Type).
   * Default i:type is AxEdtString; override via properties.edtType.
   * Accepts either the full AxEdt* form or a plain base-type name
   * (string → AxEdtString, integer/int → AxEdtInt, int64 → AxEdtInt64,
   *  real → AxEdtReal, date → AxEdtDate, datetime/utcdatetime → AxEdtUtcDateTime,
   *  enum → AxEdtEnum, guid → AxEdtGuid, container → AxEdtContainer).
   */
  static generateAxEdtXml(name: string, properties?: Record<string, any>): string {
    const edtTypeRaw = properties?.edtType || 'AxEdtString';
    const edtTypeNormMap: Record<string, string> = {
      string:      'AxEdtString',
      integer:     'AxEdtInt',
      int:         'AxEdtInt',
      int64:       'AxEdtInt64',
      real:        'AxEdtReal',
      date:        'AxEdtDate',
      datetime:    'AxEdtUtcDateTime',
      utcdatetime: 'AxEdtUtcDateTime',
      enum:        'AxEdtEnum',
      guid:        'AxEdtGuid',
      container:   'AxEdtContainer',
    };
    const edtType = edtTypeNormMap[edtTypeRaw.toLowerCase()] ?? edtTypeRaw;
    const label = properties?.label || '@TODO:LabelId';
    const extends_ = properties?.extends ? `\n\t<Extends>${properties.extends}</Extends>` : '';
    const stringSize = edtType === 'AxEdtString'
      ? `\n\t<StringSize>${properties?.stringSize ?? 30}</StringSize>` : '';
    return `<?xml version="1.0" encoding="utf-8"?>
<AxEdt xmlns:i="http://www.w3.org/2001/XMLSchema-instance" xmlns=""
\ti:type="${edtType}">
\t<Name>${name}</Name>
\t<Label>${label}</Label>${extends_}
\t<ArrayElements />
\t<Relations />
\t<TableReferences />${stringSize}
</AxEdt>`;
  }

  /**
   * Generate a minimal extension XML for AxEdtExtension, AxEnumExtension,
   * AxDataEntityViewExtension, AxMenuItemDisplayExtension, AxMenuItemActionExtension,
   * AxMenuItemOutputExtension.
   * Name convention: BaseObjectName.ExtensionName  (e.g. CustTable.MyExtension)
   */
  static generateAxSimpleExtensionXml(rootElement: string, name: string): string {
    return `<?xml version="1.0" encoding="utf-8"?>
<${rootElement} xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
\t<Name>${name}</Name>
\t<PropertyModifications />
</${rootElement}>`;
  }

  /**
   * Generate AxTableExtension XML.
   * Name convention: TableName.PrefixExtension
   *
   * Supported properties:
   *   fields:       Array<{ name, edt?, enumType?, label?, mandatory?, fieldType? }>
   *   fieldGroups:  Array<{ name, label?, fields?: string[] }>
   *   fieldGroupExtensions: Array<{ name, fields: string[] }>  — extend base-table field groups
   *   indexes:      Array<{ name, fields: Array<{fieldName, direction?}>, allowDuplicates?, alternateKey? }>
   *   relations:    Array<{ name, relatedTable, constraints: Array<{fieldName, relatedFieldName}>,
   *                         cardinality?, relatedTableCardinality?, relationshipType? }>
   */
  static generateAxTableExtensionXml(name: string, properties?: Record<string, any>): string {
    // ── Fields ───────────────────────────────────────────────────────────────
    const fieldSpecs: Array<{
      name: string;
      edt?: string;
      enumType?: string;
      label?: string;
      mandatory?: boolean;
      fieldType?: string;
    }> = Array.isArray(properties?.fields) ? properties.fields : [];

    let fieldsXml: string;
    if (fieldSpecs.length === 0) {
      fieldsXml = '\t<Fields />';
    } else {
      fieldsXml = '\t<Fields>\n';
      for (const f of fieldSpecs) {
        const iType = f.fieldType ?? (f.enumType ? 'AxTableFieldEnum' : 'AxTableFieldString');
        fieldsXml += `\t\t<AxTableField xmlns=""\n\t\t\ti:type="${iType}">\n`;
        fieldsXml += `\t\t\t<Name>${f.name}</Name>\n`;
        if (f.edt)       fieldsXml += `\t\t\t<ExtendedDataType>${f.edt}</ExtendedDataType>\n`;
        if (f.label)     fieldsXml += `\t\t\t<Label>${f.label}</Label>\n`;
        if (f.mandatory) fieldsXml += `\t\t\t<Mandatory>Yes</Mandatory>\n`;
        if (f.enumType)  fieldsXml += `\t\t\t<EnumType>${f.enumType}</EnumType>\n`;
        fieldsXml += `\t\t</AxTableField>\n`;
      }
      fieldsXml += '\t</Fields>';
    }

    // ── FieldGroups (new groups defined in this extension) ───────────────────
    const fgSpecs: Array<{ name: string; label?: string; fields?: string[] }> =
      Array.isArray(properties?.fieldGroups) ? properties.fieldGroups : [];
    let fieldGroupsXml: string;
    if (fgSpecs.length === 0) {
      fieldGroupsXml = '\t<FieldGroups />';
    } else {
      fieldGroupsXml = '\t<FieldGroups>\n';
      for (const fg of fgSpecs) {
        fieldGroupsXml += `\t\t<AxTableFieldGroup>\n\t\t\t<Name>${fg.name}</Name>\n`;
        if (fg.label) fieldGroupsXml += `\t\t\t<Label>${fg.label}</Label>\n`;
        const fgFields = Array.isArray(fg.fields) ? fg.fields : [];
        if (fgFields.length === 0) {
          fieldGroupsXml += `\t\t\t<Fields />\n`;
        } else {
          fieldGroupsXml += `\t\t\t<Fields>\n`;
          for (const df of fgFields) {
            fieldGroupsXml += `\t\t\t\t<AxTableFieldGroupField>\n\t\t\t\t\t<DataField>${df}</DataField>\n\t\t\t\t</AxTableFieldGroupField>\n`;
          }
          fieldGroupsXml += `\t\t\t</Fields>\n`;
        }
        fieldGroupsXml += `\t\t</AxTableFieldGroup>\n`;
      }
      fieldGroupsXml += '\t</FieldGroups>';
    }

    // ── FieldGroupExtensions (extend base-table field groups) ────────────────
    const fgeSpecs: Array<{ name: string; fields: string[] }> =
      Array.isArray(properties?.fieldGroupExtensions) ? properties.fieldGroupExtensions : [];
    let fieldGroupExtensionsXml: string;
    if (fgeSpecs.length === 0) {
      fieldGroupExtensionsXml = '\t<FieldGroupExtensions />';
    } else {
      fieldGroupExtensionsXml = '\t<FieldGroupExtensions>\n';
      for (const fge of fgeSpecs) {
        fieldGroupExtensionsXml += `\t\t<AxTableFieldGroupExtension>\n\t\t\t<Name>${fge.name}</Name>\n`;
        const fgeFields = Array.isArray(fge.fields) ? fge.fields : [];
        if (fgeFields.length === 0) {
          fieldGroupExtensionsXml += `\t\t\t<Fields />\n`;
        } else {
          fieldGroupExtensionsXml += `\t\t\t<Fields>\n`;
          for (const df of fgeFields) {
            fieldGroupExtensionsXml += `\t\t\t\t<AxTableFieldGroupField>\n\t\t\t\t\t<DataField>${df}</DataField>\n\t\t\t\t</AxTableFieldGroupField>\n`;
          }
          fieldGroupExtensionsXml += `\t\t\t</Fields>\n`;
        }
        fieldGroupExtensionsXml += `\t\t</AxTableFieldGroupExtension>\n`;
      }
      fieldGroupExtensionsXml += '\t</FieldGroupExtensions>';
    }

    // ── Indexes ──────────────────────────────────────────────────────────────
    const idxSpecs: Array<{
      name: string;
      fields: Array<{ fieldName: string; direction?: string }>;
      allowDuplicates?: boolean;
      alternateKey?: boolean;
    }> = Array.isArray(properties?.indexes) ? properties.indexes : [];
    let indexesXml: string;
    if (idxSpecs.length === 0) {
      indexesXml = '\t<Indexes />';
    } else {
      indexesXml = '\t<Indexes>\n';
      for (const idx of idxSpecs) {
        indexesXml += `\t\t<AxTableIndex>\n\t\t\t<Name>${idx.name}</Name>\n`;
        if (idx.allowDuplicates !== undefined) indexesXml += `\t\t\t<AllowDuplicates>${idx.allowDuplicates ? 'Yes' : 'No'}</AllowDuplicates>\n`;
        if (idx.alternateKey)                 indexesXml += `\t\t\t<AlternateKey>Yes</AlternateKey>\n`;
        const idxFields = Array.isArray(idx.fields) ? idx.fields : [];
        if (idxFields.length === 0) {
          indexesXml += `\t\t\t<Fields />\n`;
        } else {
          indexesXml += `\t\t\t<Fields>\n`;
          for (const f of idxFields) {
            indexesXml += `\t\t\t\t<AxTableIndexField>\n\t\t\t\t\t<DataField>${f.fieldName}</DataField>\n`;
            if (f.direction) indexesXml += `\t\t\t\t\t<Direction>${f.direction}</Direction>\n`;
            indexesXml += `\t\t\t\t</AxTableIndexField>\n`;
          }
          indexesXml += `\t\t\t</Fields>\n`;
        }
        indexesXml += `\t\t</AxTableIndex>\n`;
      }
      indexesXml += '\t</Indexes>';
    }

    // ── Relations ────────────────────────────────────────────────────────────
    const relSpecs: Array<{
      name: string;
      relatedTable: string;
      constraints: Array<{ fieldName: string; relatedFieldName: string }>;
      cardinality?: string;
      relatedTableCardinality?: string;
      relationshipType?: string;
    }> = Array.isArray(properties?.relations) ? properties.relations : [];
    let relationsXml: string;
    if (relSpecs.length === 0) {
      relationsXml = '\t<Relations />';
    } else {
      relationsXml = '\t<Relations>\n';
      for (const rel of relSpecs) {
        relationsXml += `\t\t<AxTableRelation>\n`;
        relationsXml += `\t\t\t<Name>${rel.name}</Name>\n`;
        relationsXml += `\t\t\t<Cardinality>${rel.cardinality || 'ZeroMore'}</Cardinality>\n`;
        relationsXml += `\t\t\t<RelatedTable>${rel.relatedTable}</RelatedTable>\n`;
        relationsXml += `\t\t\t<RelatedTableCardinality>${rel.relatedTableCardinality || 'ExactlyOne'}</RelatedTableCardinality>\n`;
        relationsXml += `\t\t\t<RelationshipType>${rel.relationshipType || 'Association'}</RelationshipType>\n`;
        const constraints = Array.isArray(rel.constraints) ? rel.constraints : [];
        if (constraints.length === 0) {
          relationsXml += `\t\t\t<Constraints />\n`;
        } else {
          relationsXml += `\t\t\t<Constraints>\n`;
          for (const c of constraints) {
            relationsXml += `\t\t\t\t<AxTableRelationConstraint xmlns="" i:type="AxTableRelationConstraintField">\n`;
            relationsXml += `\t\t\t\t\t<Name>${c.fieldName}</Name>\n`;
            relationsXml += `\t\t\t\t\t<Field>${c.fieldName}</Field>\n`;
            relationsXml += `\t\t\t\t\t<RelatedField>${c.relatedFieldName}</RelatedField>\n`;
            relationsXml += `\t\t\t\t</AxTableRelationConstraint>\n`;
          }
          relationsXml += `\t\t\t</Constraints>\n`;
        }
        relationsXml += `\t\t</AxTableRelation>\n`;
      }
      relationsXml += '\t</Relations>';
    }

    return `<?xml version="1.0" encoding="utf-8"?>
<AxTableExtension xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
\t<Name>${name}</Name>
${fieldGroupExtensionsXml}
${fieldGroupsXml}
\t<FieldModifications />
${fieldsXml}
\t<FullTextIndexes />
${indexesXml}
\t<Mappings />
\t<PropertyModifications />
\t<RelationExtensions />
\t<RelationModifications />
${relationsXml}
</AxTableExtension>`;
  }

  /**
   * Generate AxFormExtension XML.
   * Name convention: FormName.ExtensionName
   */
  static generateAxFormExtensionXml(name: string): string {
    return `<?xml version="1.0" encoding="utf-8"?>
<AxFormExtension xmlns:i="http://www.w3.org/2001/XMLSchema-instance" xmlns="Microsoft.Dynamics.AX.Metadata.V6">
\t<Name>${name}</Name>
\t<ControlModifications />
\t<Controls />
\t<DataSourceModifications />
\t<DataSourceReferences />
\t<DataSources />
\t<Parts />
\t<PropertyModifications />
</AxFormExtension>`;
  }

  /**
   * Generate AxSecurityPrivilege XML.
   * properties.targetObject  – ObjectName of the target menu item (optional)
   * properties.objectType    – MenuItemDisplay | MenuItemAction | MenuItemOutput (default: MenuItemDisplay)
   * properties.accessLevel   – 'view' | 'maintain' | 'read' (default: 'view' = Read only)
   */
  static generateAxSecurityPrivilegeXml(name: string, properties?: Record<string, any>): string {
    const label = properties?.label || '@TODO:LabelId';
    const targetObject: string | undefined = properties?.targetObject;
    const objType: string = properties?.objectType || 'MenuItemDisplay';

    let entryPointsXml: string;
    if (targetObject) {
      const al = (properties?.accessLevel || 'view').toLowerCase();
      const grantXml = al === 'maintain'
        ? '\t\t\t\t<Read>Allow</Read>\n\t\t\t\t<Update>Allow</Update>\n\t\t\t\t<Create>Allow</Create>\n\t\t\t\t<Delete>Allow</Delete>'
        : '\t\t\t\t<Read>Allow</Read>';
      entryPointsXml = `\n\t\t<AxSecurityEntryPointReference>\n\t\t\t<Name>${targetObject}</Name>\n\t\t\t<Grant>\n${grantXml}\n\t\t\t</Grant>\n\t\t\t<ObjectName>${targetObject}</ObjectName>\n\t\t\t<ObjectType>${objType}</ObjectType>\n\t\t\t<Forms />\n\t\t</AxSecurityEntryPointReference>\n\t`;
    } else {
      entryPointsXml = '';
    }

    return `<?xml version="1.0" encoding="utf-8"?>
<AxSecurityPrivilege xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
\t<Name>${name}</Name>
\t<Label>${label}</Label>
\t<DataEntityPermissions />
\t<DirectAccessPermissions />
\t<EntryPoints>${entryPointsXml}</EntryPoints>
\t<FormControlOverrides />
</AxSecurityPrivilege>`;
  }

  /**
   * Generate AxSecurityDuty XML.
   */
  static generateAxSecurityDutyXml(name: string, properties?: Record<string, any>): string {
    const label = properties?.label || '@TODO:LabelId';
    return `<?xml version="1.0" encoding="utf-8"?>
<AxSecurityDuty xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
\t<Name>${name}</Name>
\t<Label>${label}</Label>
\t<Privileges />
</AxSecurityDuty>`;
  }

  /**
   * Generate AxSecurityRole XML.
   */
  static generateAxSecurityRoleXml(name: string, properties?: Record<string, any>): string {
    const label = properties?.label || '@TODO:LabelId';
    return `<?xml version="1.0" encoding="utf-8"?>
<AxSecurityRole xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
\t<Name>${name}</Name>
\t<Label>${label}</Label>
\t<DirectAccessPermissions />
\t<Duties />
\t<Privileges />
\t<SubRoles />
</AxSecurityRole>`;
  }

  /**
   * Generate BusinessEventsContract class XML (AxClass) for a Business Event.
   * The class extends BusinessEventsBase and includes a companion contract class.
   */
  static generateBusinessEventXml(name: string, properties?: Record<string, any>): string {
    const label      = properties?.label     || `@TODO:${name}Label`;
    const helpText   = properties?.helpText  || `@TODO:${name}HelpText`;
    const module     = properties?.module    || 'ModuleAxapta::Other';
    const contractName = `${name}Contract`;

    const source =
`[BusinessEvents(classStr(${contractName}),
    '${name}',
    '${name}',
    ${module})]
public final class ${name} extends BusinessEventsBase
{
    private ${contractName} contract;

    public static ${name} newFromContract(${contractName} _contract)
    {
        ${name} event = new ${name}();
        event.contract = _contract;
        return event;
    }

    [Hookable(false)]
    public BusinessEventsContract buildContract()
    {
        return contract;
    }
}

// ── Contract class ──────────────────────────────────────────────────────────
[DataContractAttribute]
public final class ${contractName} extends BusinessEventsContract
{
    // TODO: add private fields and parmXxx() methods for the event payload

    public static ${contractName} newDefault()
    {
        ${contractName} c = new ${contractName}();
        return c;
    }
}`;

    return XmlTemplateGenerator.generateAxClassXml(name, source, { label, helpText, isFinal: true });
  }

  /**
   * Generate Workspace Tile XML (AxTile).
   * Tiles appear in workspace panorama sections as KPI / navigation tiles.
   */
  static generateAxTileXml(name: string, properties?: Record<string, any>): string {
    const label      = properties?.label     || `@TODO:${name}Label`;
    const helpText   = properties?.helpText  || `@TODO:${name}HelpText`;
    const tileType   = properties?.tileType  || 'Count';       // Count | Link | Summary
    const menuItem   = properties?.menuItem  || '';
    const query      = properties?.query     || '';

    return `<?xml version="1.0" encoding="utf-8"?>
<AxTile xmlns:i="http://www.w3.org/2001/XMLSchema-instance" xmlns="Microsoft.Dynamics.AX.Metadata.V6">
\t<Name>${name}</Name>
\t<Label>${label}</Label>
\t<HelpText>${helpText}</HelpText>
\t<TileType>${tileType}</TileType>${menuItem ? `\n\t<MenuItemName>${menuItem}</MenuItemName>\n\t<MenuItemType>Display</MenuItemType>` : ''}${query ? `\n\t<Query>${query}</Query>` : ''}
\t<Size>Wide</Size>
\t<RefreshFrequency>600</RefreshFrequency>
</AxTile>`;
  }

  /**
   * Generate KPI XML (AxKPI).
   * KPIs appear in workspace summary sections.
   */
  static generateAxKpiXml(name: string, properties?: Record<string, any>): string {
    const label      = properties?.label     || `@TODO:${name}Label`;
    const helpText   = properties?.helpText  || `@TODO:${name}HelpText`;
    const measure    = properties?.measure   || '';
    const dimension  = properties?.dimension || '';

    return `<?xml version="1.0" encoding="utf-8"?>
<AxKPI xmlns:i="http://www.w3.org/2001/XMLSchema-instance" xmlns="Microsoft.Dynamics.AX.Metadata.V6">
\t<Name>${name}</Name>
\t<Label>${label}</Label>
\t<HelpText>${helpText}</HelpText>${measure ? `\n\t<Measure>${measure}</Measure>` : ''}${dimension ? `\n\t<MeasureDimension>${dimension}</MeasureDimension>` : ''}
\t<Goal>0</Goal>
\t<GoalType>None</GoalType>
\t<Trend>None</Trend>
</AxKPI>`;
  }

  /**
   * Generate AxMenu XML.
   */
  static generateAxMenuXml(name: string, properties?: Record<string, any>): string {
    const label = properties?.label || '@TODO:LabelId';
    return `<?xml version="1.0" encoding="utf-8"?>
<AxMenu xmlns:i="http://www.w3.org/2001/XMLSchema-instance" xmlns="Microsoft.Dynamics.AX.Metadata.V1">
\t<Name>${name}</Name>
\t<Label>${label}</Label>
\t<Elements />
</AxMenu>`;
  }

  /**
   * Generate AxMenuExtension XML.
   * Name convention: MenuName.ExtensionName
   */
  static generateAxMenuExtensionXml(name: string): string {
    return `<?xml version="1.0" encoding="utf-8"?>
<AxMenuExtension xmlns:i="http://www.w3.org/2001/XMLSchema-instance" xmlns="Microsoft.Dynamics.AX.Metadata.V1">
\t<Name>${name}</Name>
\t<Customizations />
\t<Elements />
\t<MenuElementModifications />
\t<PropertyModifications />
</AxMenuExtension>`;
  }

  /**
   * Generate AxMenuItemDisplay / AxMenuItemAction / AxMenuItemOutput XML.
   *
   * AOT folder mapping:
   *   menu-item-display → AxMenuItemDisplay  (ObjectType: Form)
   *   menu-item-action  → AxMenuItemAction   (ObjectType: Class)
   *   menu-item-output  → AxMenuItemOutput   (ObjectType: Report)
   */
  static generateAxMenuItemXml(
    itemType: 'menu-item-display' | 'menu-item-action' | 'menu-item-output',
    name: string,
    properties?: Record<string, any>
  ): string {
    const elemName = itemType === 'menu-item-action' ? 'AxMenuItemAction'
      : itemType === 'menu-item-output' ? 'AxMenuItemOutput'
      : 'AxMenuItemDisplay';
    const targetObject = properties?.targetObject || properties?.object || name;
    const label = properties?.label || '@TODO:LabelId';

    // Determine ObjectType based on item type and explicit properties.
    // D365FO serializer rules (confirmed from real XML files):
    //   - AxMenuItemAction:  ObjectType is always "Class"; must be present.
    //   - AxMenuItemDisplay: ObjectType is OMITTED when targeting a Form (default);
    //                        use "Class" only when explicitly set.
    //   - AxMenuItemOutput:  ObjectType is "Class" (controller) or "SSRSReport";
    //                        "Report" is NOT a valid value — real files use "SSRSReport".
    const explicitObjType: string | undefined = properties?.objectType || properties?.targetType;
    let objType: string | undefined;
    if (itemType === 'menu-item-action') {
      // Action always needs ObjectType; default to Class
      objType = explicitObjType || 'Class';
    } else if (itemType === 'menu-item-output') {
      // Output: Class (controller pattern) or SSRSReport; "Report" is invalid
      if (explicitObjType === 'Report') {
        objType = 'SSRSReport';
      } else {
        objType = explicitObjType || 'Class';
      }
    } else {
      // Display: omit ObjectType entirely when targeting a Form (the implicit default).
      // Include it only when caller explicitly requests "Class".
      if (explicitObjType && explicitObjType !== 'Form') {
        objType = explicitObjType;
      }
      // else leave objType undefined → element omitted
    }

    const objectTypeXml = objType ? `\n\t<ObjectType>${objType}</ObjectType>` : '';
    return `<?xml version="1.0" encoding="utf-8"?>
<${elemName} xmlns:i="http://www.w3.org/2001/XMLSchema-instance" xmlns="Microsoft.Dynamics.AX.Metadata.V1">
\t<Name>${name}</Name>
\t<Label>${label}</Label>
\t<Object>${targetObject}</Object>${objectTypeXml}
</${elemName}>`;
  }

  /**
   * Ensure AxMenuItemAction/Display/Output XML always has the required namespace
   * attributes on the root element.  D365FO metadata deserializer rejects the file
   * without both:
   *   xmlns="Microsoft.Dynamics.AX.Metadata.V1"
   *   xmlns:i="http://www.w3.org/2001/XMLSchema-instance"
   *
   * Also fix invalid ObjectType values:
   *   "Form"   → remove element entirely (display items targeting a form should
   *              omit ObjectType; D365FO has no ObjectType enum value "Form")
   *   "Report" → "SSRSReport" (only valid values are Class / SSRSReport)
   */
  static sanitizeMenuItemXml(xml: string): string {
    // 1. Ensure xmlns namespace attributes on root element
    xml = xml.replace(
      /<(AxMenuItem(?:Action|Display|Output))(\s[^>]*)?>/,
      (_match, tag: string, attrs: string | undefined) => {
        let a = attrs || '';
        if (!a.includes('xmlns="Microsoft.Dynamics.AX.Metadata.V1"')) {
          a += ' xmlns="Microsoft.Dynamics.AX.Metadata.V1"';
        }
        if (!a.includes('xmlns:i="')) {
          a = ` xmlns:i="http://www.w3.org/2001/XMLSchema-instance"` + a;
        }
        return `<${tag}${a}>`;
      }
    );
    // 2. Fix invalid ObjectType value "Form" → remove element
    //    Real AxMenuItemDisplay files targeting forms simply omit ObjectType.
    xml = xml.replace(/\s*<ObjectType>Form<\/ObjectType>/g, '');
    // 3. Fix invalid ObjectType value "Report" → "SSRSReport"
    xml = xml.replace(/<ObjectType>Report<\/ObjectType>/g, '<ObjectType>SSRSReport</ObjectType>');
    return xml;
  }
}

/**
 * Visual Studio Project (.rnrproj) Manipulator
 */
export class ProjectFileManager {
  private parser: Parser;
  private builder: Builder;

  constructor() {
    this.parser = new Parser({
      explicitArray: false,
      mergeAttrs: false,
      trim: true,
    });
    this.builder = new Builder({
      xmldec: { version: '1.0', encoding: 'utf-8' },
      renderOpts: { pretty: true, indent: '  ' },
    });
  }

  /**
   * Get friendly display folder name for project (used in Folder Include and Link)
   * e.g. class → Classes, enum → Base Enums
   */
  private getFolderName(objectType: string): string {
    const folderMap: Record<string, string> = {
      class: 'Classes',
      'class-extension': 'Classes',
      table: 'Tables',
      enum: 'Base Enums',
      form: 'Forms',
      query: 'Queries',
      view: 'Views',
      'data-entity': 'Data Entities',
      'table-extension': 'Table Extensions',
      'form-extension': 'Form Extensions',
      'data-entity-extension': 'Data Entity Extensions',
      report: 'Reports',
      'menu-item-display': 'Menu Items Display',
      'menu-item-action': 'Menu Items Action',
      'menu-item-output': 'Menu Items Output',
      'menu-item-display-extension': 'Menu Item Display Extensions',
      'menu-item-action-extension': 'Menu Item Action Extensions',
      'menu-item-output-extension': 'Menu Item Output Extensions',
      edt: 'Extended Data Types',
      'edt-extension': 'EDT Extensions',
      'enum-extension': 'Enum Extensions',
      menu: 'Menus',
      'menu-extension': 'Menu Extensions',
      'security-privilege': 'Security Privileges',
      'security-duty': 'Security Duties',
      'security-role': 'Security Roles',
      'business-event': 'Classes',
      tile: 'Tiles',
      kpi: 'KPIs',
    };
    return folderMap[objectType] || 'Classes';
  }

  /**
   * Get AOT folder prefix for Content Include path (no .xml extension)
   * e.g. class → AxClass, enum → AxEnum, data-entity → AxDataEntityView
   */
  private getAxFolderPrefix(objectType: string): string {
    const prefixMap: Record<string, string> = {
      class: 'AxClass',
      'class-extension': 'AxClass',
      table: 'AxTable',
      enum: 'AxEnum',
      form: 'AxForm',
      query: 'AxQuery',
      view: 'AxView',
      'data-entity': 'AxDataEntityView',
      'table-extension': 'AxTableExtension',
      'form-extension': 'AxFormExtension',
      'data-entity-extension': 'AxDataEntityViewExtension',
      report: 'AxReport',
      'menu-item-display': 'AxMenuItemDisplay',
      'menu-item-action': 'AxMenuItemAction',
      'menu-item-output': 'AxMenuItemOutput',
      'menu-item-display-extension': 'AxMenuItemDisplayExtension',
      'menu-item-action-extension': 'AxMenuItemActionExtension',
      'menu-item-output-extension': 'AxMenuItemOutputExtension',
      edt: 'AxEdt',
      'edt-extension': 'AxEdtExtension',
      'enum-extension': 'AxEnumExtension',
      menu: 'AxMenu',
      'menu-extension': 'AxMenuExtension',
      'security-privilege': 'AxSecurityPrivilege',
      'security-duty': 'AxSecurityDuty',
      'security-role': 'AxSecurityRole',
      'business-event': 'AxClass',
      tile: 'AxTile',
      kpi: 'AxKPI',
    };
    return prefixMap[objectType] || 'AxClass';
  }

  /**
   * Add file reference to Visual Studio project
   * D365FO projects use ABSOLUTE paths to XML files in PackagesLocalDirectory
   * Returns true if file was added, false if file already exists in project
   */
  async addToProject(
    projectPath: string,
    objectType: string,
    objectName: string,
    _absoluteXmlPath: string  // kept for API compatibility
  ): Promise<boolean> {
    return withProjectFileLock(projectPath, () => this._addToProjectLocked(projectPath, objectType, objectName));
  }

  private async _addToProjectLocked(
    projectPath: string,
    objectType: string,
    objectName: string
  ): Promise<boolean> {
    // Read project file (with retry for transient VS file locks)
    let projectXml = '';
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        projectXml = await fs.readFile(projectPath, 'utf-8');
        break;
      } catch (err: any) {
        if ((err.code === 'EBUSY' || err.code === 'EPERM' || err.code === 'EACCES') && attempt < 4) {
          await new Promise(r => setTimeout(r, 300 * (attempt + 1)));
          continue;
        }
        throw err;
      }
    }
    // Strip UTF-8 BOM if present (VS writes BOM; Node fs.readFile keeps it)
    let hadBom = false;
    if (projectXml.charCodeAt(0) === 0xFEFF) {
      projectXml = projectXml.slice(1);
      hadBom = true;
    }
    const project = await this.parser.parseStringPromise(projectXml);

    // Ensure project structure exists
    if (!project.Project) {
      throw new Error('Invalid .rnrproj file structure');
    }

    // Initialize ItemGroup if not exists — insert BEFORE Import elements
    // so MSBuild/VS sees items before targets (xml2js preserves JS key order)
    if (!project.Project.ItemGroup) {
      const { Import, ...rest } = project.Project;
      project.Project = { ...rest, ItemGroup: [{ Folder: [] }, { Content: [] }] };
      if (Import) {
        project.Project.Import = Import;
      }
    }

    // Convert to array if single ItemGroup
    if (!Array.isArray(project.Project.ItemGroup)) {
      project.Project.ItemGroup = [project.Project.ItemGroup];
    }

    // Find or create Folder ItemGroup
    let folderGroup = project.Project.ItemGroup.find(
      (group: any) => group.Folder !== undefined
    );
    if (!folderGroup) {
      folderGroup = { Folder: [] };
      project.Project.ItemGroup.push(folderGroup);
    }

    // Find or create Content ItemGroup
    let contentGroup = project.Project.ItemGroup.find(
      (group: any) => group.Content !== undefined
    );
    if (!contentGroup) {
      contentGroup = { Content: [] };
      project.Project.ItemGroup.push(contentGroup);
    }

    // Ensure arrays
    if (!Array.isArray(folderGroup.Folder)) {
      folderGroup.Folder = folderGroup.Folder ? [folderGroup.Folder] : [];
    }
    if (!Array.isArray(contentGroup.Content)) {
      contentGroup.Content = contentGroup.Content ? [contentGroup.Content] : [];
    }

    // Get folder names for project organization
    const displayFolderName = this.getFolderName(objectType);
    const axFolderPrefix = this.getAxFolderPrefix(objectType);

    // Add folder if not exists (uses friendly display name, e.g. "Classes\")
    const folderExists = folderGroup.Folder.some(
      (folder: any) =>
        folder.$ && folder.$.Include === `${displayFolderName}\\`
    );
    if (!folderExists) {
      folderGroup.Folder.push({
        $: { Include: `${displayFolderName}\\` },
      });
    }

    // D365FO .rnrproj standard:
    //   Content Include = AxClass\ObjectName  (Ax prefix, NO .xml extension)
    //   Link            = Classes\ObjectName  (display name, NO .xml extension)
    const contentInclude = `${axFolderPrefix}\\${objectName}`;
    const linkPath = `${displayFolderName}\\${objectName}`;

    // Check if file already in project
    const fileExists = contentGroup.Content.some(
      (content: any) =>
        content.$ && content.$.Include === contentInclude
    );

    if (fileExists) {
      console.error(
        `[ProjectFileManager] File ${objectName} is already in the project - skipping`
      );
      return false; // File already exists in project
    }

    // Add file reference
    contentGroup.Content.push({
      $: { Include: contentInclude },
      SubType: 'Content',
      Name: objectName,
      Link: linkPath,
    });

    console.error(
      `[ProjectFileManager] Added file reference to project, Content items: ${contentGroup.Content.length}`
    );

    // Write back to project file (with retry for transient VS file locks)
    const updatedXml = this.builder.buildObject(project);
    // Restore UTF-8 BOM if the original file had one (VS 2022 writes .rnrproj with BOM)
    const output = hadBom ? '\uFEFF' + updatedXml : updatedXml;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await fs.writeFile(projectPath, output, 'utf-8');
        break;
      } catch (err: any) {
        if ((err.code === 'EBUSY' || err.code === 'EPERM' || err.code === 'EACCES') && attempt < 4) {
          await new Promise(r => setTimeout(r, 300 * (attempt + 1)));
          continue;
        }
        throw err;
      }
    }

    console.error(`[ProjectFileManager] Project file saved successfully`);
    return true; // File successfully added
  }

  /**
   * Extract ModelName from Visual Studio project file
   * Returns the actual model name from PropertyGroup/Model or PropertyGroup/ModelName
   */
  async extractModelName(projectPath: string): Promise<string | null> {
    try {
      console.error(
        `[ProjectFileManager] Extracting model name from: ${projectPath}`
      );

      // Read project file
      let projectXml = await fs.readFile(projectPath, 'utf-8');
      // Strip UTF-8 BOM if present
      if (projectXml.charCodeAt(0) === 0xFEFF) {
        projectXml = projectXml.slice(1);
      }
      const project = await this.parser.parseStringPromise(projectXml);

      // Look for PropertyGroup with Model or ModelName
      if (project.Project && project.Project.PropertyGroup) {
        const propertyGroups = Array.isArray(project.Project.PropertyGroup)
          ? project.Project.PropertyGroup
          : [project.Project.PropertyGroup];

        for (const group of propertyGroups) {
          // Try <Model> tag first (standard D365FO format)
          if (group.Model) {
            const modelName = group.Model;
            console.error(
              `[ProjectFileManager] Found Model in project: ${modelName}`
            );
            return modelName;
          }
          
          // Fallback to <ModelName> tag (alternative format)
          if (group.ModelName) {
            const modelName = group.ModelName;
            console.error(
              `[ProjectFileManager] Found ModelName in project: ${modelName}`
            );
            return modelName;
          }
        }
      }

      console.error(
        `[ProjectFileManager] No Model or ModelName found in project file`
      );
      return null;
    } catch (error) {
      console.error(
        `[ProjectFileManager] Error extracting model name:`,
        error
      );
      return null;
    }
  }
}

/**
 * Create D365FO file handler function
 */
export async function handleCreateD365File(
  request: CallToolRequest,
  context?: {
    bridge?: import('../bridge/bridgeClient.js').BridgeClient;
    cache?: import('../cache/redisCache.js').RedisCacheService;
  },
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  const args = CreateD365FileArgsSchema.parse(request.params.arguments);

  try {
    // Step 1: Try to find and parse .rnrproj to get actual ModelName
    let actualModelName = args.modelName;
    let wasAutoExtracted = false;
    let projectPathToUse = args.projectPath;
    let solutionPathToUse = args.solutionPath;
    
    console.error(
      `[create_d365fo_file] Initial modelName: ${actualModelName}`
    );

    // If neither projectPath nor solutionPath provided, try to get from config or auto-detect
    if (!projectPathToUse && !solutionPathToUse) {
      const configManager = getConfigManager();

      // Try to auto-detect from workspace (async)
      projectPathToUse = await configManager.getProjectPath() || undefined;
      solutionPathToUse = await configManager.getSolutionPath() || undefined;

      // If model name was not passed as argument, try to resolve from mcp.json config
      if (!actualModelName) {
        actualModelName = configManager.getModelName() ?? undefined;
        if (actualModelName) {
          const ctx = configManager.getContext();
          const source = ctx?.modelName ? 'modelName (mcp.json)' : 'workspacePath (mcp.json)';
          console.error(`[create_d365fo_file] Using modelName from ${source}: ${actualModelName}`);
        }
      }

      if (projectPathToUse) {
        console.error(
          `[create_d365fo_file] Using projectPath (auto-detected or from .mcp.json): ${projectPathToUse}`
        );
      } else if (solutionPathToUse) {
        console.error(
          `[create_d365fo_file] Using solutionPath (auto-detected or from .mcp.json): ${solutionPathToUse}`
        );
      }
    }

    // If projectPath is available, extract model name from it
    if (projectPathToUse) {
      const projectManager = new ProjectFileManager();
      const extractedModelName = await projectManager.extractModelName(
        projectPathToUse
      );
      if (extractedModelName) {
        actualModelName = extractedModelName;
        wasAutoExtracted = true;
        console.error(
          `[create_d365fo_file] Extracted ModelName from projectPath: ${actualModelName}`
        );
        
        // ✨ Register extracted model as custom (since it came from user's project)
        registerCustomModel(actualModelName);
      }
    }
    // If solutionPath is available, try to find .rnrproj and extract model name
    else if (solutionPathToUse) {
      const foundProjectPath = await ProjectFileFinder.findProjectInSolution(
        solutionPathToUse,
        actualModelName ?? ''
      );
      
      if (foundProjectPath) {
        const projectManager = new ProjectFileManager();
        const extractedModelName = await projectManager.extractModelName(
          foundProjectPath
        );
        if (extractedModelName) {
          actualModelName = extractedModelName;
          wasAutoExtracted = true;
          console.error(
            `[create_d365fo_file] Extracted ModelName from solutionPath .rnrproj: ${actualModelName}`
          );
          
          // ✨ Register extracted model as custom (since it came from user's project)
          registerCustomModel(actualModelName);
        }
      }
    }

    // ⚠️ CRITICAL: modelName is required — must come from args, mcp.json, or .rnrproj extraction
    if (!actualModelName) {
      const errorMsg =
        '❌ ERROR: modelName could not be resolved.\n\n' +
        'Provide it in one of these ways:\n' +
        '  1. Pass modelName explicitly in the tool call arguments\n' +
        '  2. Add modelName to .mcp.json context: { "context": { "modelName": "YourModel" } }\n' +
        '  3. Add workspacePath ending with the package/model name: { "context": { "workspacePath": "C:\\\\AosService\\\\PackagesLocalDirectory\\\\YourModel" } }\n' +
        '  4. Add projectPath or solutionPath to .mcp.json so the model is auto-extracted from .rnrproj';
      console.error(`[create_d365fo_file] ${errorMsg}`);
      return { content: [{ type: 'text', text: errorMsg }] };
    }

    // ⚠️ CRITICAL WARNING: If no project/solution path available anywhere
    if (!projectPathToUse && !solutionPathToUse) {
      console.error(
        `[create_d365fo_file] ⚠️ WARNING: No projectPath or solutionPath available (not in args, not in .mcp.json)!`
      );
      console.error(
        `[create_d365fo_file] ⚠️ Using modelName AS-IS: "${actualModelName}"`
      );
      console.error(
        `[create_d365fo_file] ⚠️ If "${actualModelName}" is a Microsoft model (e.g., ApplicationSuite), this will create the file in the WRONG location!`
      );
      console.error(
        `[create_d365fo_file] ⚠️ Add projectPath or solutionPath to .mcp.json config to auto-extract correct ModelName from .rnrproj!`
      );
      
      // Extra validation: Check for suspicious/placeholder model names
      const suspiciousNames = ['auto', 'test', 'example', 'temp', 'undefined', 'null'];
      // Known Microsoft standard D365FO models — NEVER use for custom code
      const knownMicrosoftModels = [
        'applicationsuite', 'applicationcommon', 'applicationfoundation', 'applicationplatform',
        'applicationwebcomponents', 'applicationworkspaces', 'foundation',
        'directory', 'dimensions', 'currency', 'calendar', 'casemanagement',
        'contactperson', 'datasharing', 'dataupgrade', 'datamaintenance',
        'electronicreporting', 'electronicreportingcore',
        'banktype', 'banktypes', 'benefitsmanagement', 'creditmanagement',
      ];
      const modelLower = actualModelName.toLowerCase();
      const isPlaceholder = suspiciousNames.includes(modelLower);
      const isMicrosoftModel = knownMicrosoftModels.includes(modelLower);

      if (isPlaceholder || isMicrosoftModel) {
        const reason = isPlaceholder
          ? `"${actualModelName}" is a placeholder value, not a real D365FO model`
          : `"${actualModelName}" is a Microsoft standard model — custom code must NEVER be created there`;
        const errorMsg =
          `❌ ERROR: ${reason}\n\n` +
          `Root cause: No projectPath or solutionPath was found (not in tool args, not in .mcp.json config).\n` +
          `Without projectPath, the tool uses the modelName parameter AS-IS, which is wrong.\n\n` +
          `To fix — add projectPath to .mcp.json (in the MCP server directory)::\n` +
          `  {\n` +
          `    "servers": {\n` +
          `      "context": {\n` +
          `        "projectPath": "C:\\\\VSProjects\\\\YourSolution\\\\YourProject\\\\YourProject.rnrproj",\n` +
          `        "solutionPath": "C:\\\\VSProjects\\\\YourSolution",\n` +
          `        "packagePath": "C:\\\\AosService\\\\PackagesLocalDirectory"\n` +
          `      }\n` +
          `    }\n` +
          `  }\n\n` +
          `Or pass projectPath explicitly in the tool call arguments.`;

        console.error(`[create_d365fo_file] ${errorMsg}`);

        return {
          content: [
            {
              type: 'text',
              text: errorMsg
            }
          ]
        };
      }
    }

    console.error(
      `[create_d365fo_file] Final ModelName to use: ${actualModelName}${wasAutoExtracted ? ' (auto-extracted ✓)' : ' (as-is, NOT auto-extracted ⚠️)'}`
    );

    // Guard: refuse to create objects in generic placeholder model names.
    // These are never real D365FO models — if the AI reaches this point with a placeholder,
    // the workspace was not detected correctly and the file would land in the wrong location.
    const PLACEHOLDER_MODELS = new Set([
      'mymodel', 'mypackage', 'model', 'package', 'modelname', 'packagename',
      'yourmodel', 'yourpackage', 'custommodel', 'custompackage',
      'testmodel', 'testpackage', 'samplemodel', 'samplepackage',
    ]);
    if (actualModelName && PLACEHOLDER_MODELS.has(actualModelName.toLowerCase())) {
      return {
        content: [
          {
            type: 'text',
            text:
              `❌ Model name "${actualModelName}" looks like a placeholder — file creation aborted.\n\n` +
              `The workspace / project path was not detected correctly, so the model name\n` +
              `could not be resolved from the .rnrproj file.\n\n` +
              `To fix this, provide one of:\n` +
              `  • projectPath — full path to the .rnrproj file (e.g. K:\\...\\MyProject.rnrproj)\n` +
              `  • solutionPath — directory containing the .rnrproj\n` +
              `  • A correct modelName that matches an actual D365FO model on disk\n\n` +
              `Never use "MyModel", "MyPackage" or similar placeholders as modelName.`,
          },
        ],
        isError: true,
      };
    }

    // Apply extension prefix to object name
    const objectPrefix = resolveObjectPrefix(actualModelName);

    // If EXTENSION_PREFIX differs from modelName, the AI may have embedded the modelName
    // in the extension name. Strip it so applyObjectPrefix injects the correct prefix only.
    let effectiveObjectName = args.objectName;

    // Case A: dot-notation extension elements (table/form/EDT/enum extensions)
    // e.g. "CustTable.MyModelExtension" with modelName="MyModel" → "CustTable.Extension"
    // applyObjectPrefix then produces "CustTable.MyExtension"
    if (
      args.objectName.includes('.') &&
      args.objectName.toLowerCase().endsWith('extension') &&
      actualModelName &&
      objectPrefix.toLowerCase() !== actualModelName.toLowerCase()
    ) {
      const dotIdx = args.objectName.lastIndexOf('.');
      const basePart = args.objectName.slice(0, dotIdx);
      const suffixPart = args.objectName.slice(dotIdx + 1);
      if (suffixPart.toLowerCase().startsWith(actualModelName.toLowerCase())) {
        effectiveObjectName = `${basePart}.${suffixPart.slice(actualModelName.length)}`;
        console.error(
          `[create_d365fo_file] Stripped model name from dot-notation extension: ` +
          `${args.objectName} → ${effectiveObjectName}`
        );
      }
    }

    // Case B: extension classes (objectName ends with "_Extension")
    // e.g. "SalesFormLetterContoso_Extension" with modelName="ContosoExt" → "SalesFormLetter_Extension"
    // applyObjectPrefix then produces "SalesFormLetterContoso_Extension"
    if (
      args.objectName.endsWith('_Extension') &&
      actualModelName &&
      objectPrefix.toLowerCase() !== actualModelName.toLowerCase()
    ) {
      const baseName = args.objectName.slice(0, -'_Extension'.length);
      if (baseName.toLowerCase().endsWith(actualModelName.toLowerCase())) {
        effectiveObjectName = baseName.slice(0, -actualModelName.length) + '_Extension';
        console.error(
          `[create_d365fo_file] Stripped model name infix "${actualModelName}" from extension class: ` +
          `${args.objectName} → ${effectiveObjectName}`
        );
      }
    }

    const finalObjectName = applyObjectPrefix(effectiveObjectName, objectPrefix);
    if (finalObjectName !== args.objectName) {
      console.error(`[create_d365fo_file] Applied prefix "${objectPrefix}": ${args.objectName} → ${finalObjectName}`);
    }

    // Determine object folder based on type
    const objectFolderMap: Record<string, string> = {
      class: 'AxClass',
      'class-extension': 'AxClass',
      table: 'AxTable',
      enum: 'AxEnum',
      form: 'AxForm',
      query: 'AxQuery',
      view: 'AxView',
      'data-entity': 'AxDataEntityView',
      report: 'AxReport',
      edt: 'AxEdt',
      'edt-extension': 'AxEdtExtension',
      'table-extension': 'AxTableExtension',
      'form-extension': 'AxFormExtension',
      'data-entity-extension': 'AxDataEntityViewExtension',
      'enum-extension': 'AxEnumExtension',
      'menu-item-display': 'AxMenuItemDisplay',
      'menu-item-action': 'AxMenuItemAction',
      'menu-item-output': 'AxMenuItemOutput',
      'menu-item-display-extension': 'AxMenuItemDisplayExtension',
      'menu-item-action-extension': 'AxMenuItemActionExtension',
      'menu-item-output-extension': 'AxMenuItemOutputExtension',
      menu: 'AxMenu',
      'menu-extension': 'AxMenuExtension',
      'security-privilege': 'AxSecurityPrivilege',
      'security-duty': 'AxSecurityDuty',
      'security-role': 'AxSecurityRole',
      'business-event': 'AxClass',
      tile: 'AxTile',
      kpi: 'AxKPI',
    };

    const objectFolder = objectFolderMap[args.objectType];
    if (!objectFolder) {
      throw new Error(`Unsupported object type: ${args.objectType}`);
    }

    // Construct full path - resolve package name
    // Package name can differ from model name in any environment (not just UDE).
    const configManager = getConfigManager();
    const configPackagePath = configManager.getPackagePath();
    const envType = await configManager.getDevEnvironmentType();

    let basePath: string;
    let resolvedPackageName: string;

    if (args.packageName) {
      // Explicit packageName always wins, regardless of environment type
      resolvedPackageName = args.packageName;
      if (envType === 'ude') {
        const customPath = await configManager.getCustomPackagesPath();
        basePath = customPath || args.packagePath || configPackagePath || fallbackPackagePath();
      } else {
        basePath = args.packagePath || configPackagePath || fallbackPackagePath();
      }
    } else if (envType === 'ude') {
      // UDE mode: auto-resolve package name via descriptor scan
      const customPath = await configManager.getCustomPackagesPath();
      const msPath = await configManager.getMicrosoftPackagesPath();
      const roots = [customPath, msPath].filter(Boolean) as string[];

      const resolver = new PackageResolver(roots);
      const resolved = await resolver.resolve(actualModelName);

      if (resolved) {
        resolvedPackageName = resolved.packageName;
        basePath = resolved.rootPath;
      } else {
        // Fallback: assume package == model (common case)
        resolvedPackageName = actualModelName;
        basePath = customPath || args.packagePath || configPackagePath || fallbackPackagePath();
      }
    } else {
      // Traditional mode without explicit packageName: assume package == model
      resolvedPackageName = actualModelName;
      basePath =
        args.packagePath ||
        configPackagePath ||
        fallbackPackagePath();
    }

    console.error(
      `[create_d365fo_file] Environment: ${envType}, Package: ${resolvedPackageName}, Model: ${actualModelName}`,
    );

    const modelPath = path.join(
      basePath,
      resolvedPackageName,
      actualModelName,
      objectFolder,
    );
    const fileName = `${finalObjectName}.xml`;
    const fullPath = path.join(modelPath, fileName);

    // Security: prevent path traversal. path.join() resolves ".." segments,
    // so a crafted modelName/objectName could escape basePath entirely.
    // Resolve both paths and assert the target stays within basePath.
    const resolvedBase = path.resolve(basePath);
    const resolvedTarget = path.resolve(fullPath);
    if (!resolvedTarget.startsWith(resolvedBase + path.sep) && resolvedTarget !== resolvedBase) {
      throw new Error(
        `❌ Security error: resolved path "${resolvedTarget}" is outside base directory "${resolvedBase}".\n` +
        `Check modelName, packageName, objectName, and packagePath for path traversal sequences.`
      );
    }

    // Normalize path to Windows format (backslashes) for consistency
    const normalizedFullPath = fullPath.replace(/\//g, '\\');

    // Ensure directory exists (create if needed)
    const directory = path.dirname(normalizedFullPath);

    // Check if this looks like a Windows path on non-Windows system
    if (process.platform !== 'win32' && /^[A-Z]:\\/.test(normalizedFullPath)) {
      throw new Error(
        `❌ Cannot create D365FO file on non-Windows system!\n\n` +
        `Attempting to create: ${normalizedFullPath}\n` +
        `Running on: ${process.platform}\n\n` +
        `The create_d365fo_file tool requires:\n` +
        `1. Running on Windows (local D365FO VM)\n` +
        `2. Direct access to PackagesLocalDirectory (e.g. C:\\AosService\\PackagesLocalDirectory)\n\n` +
        `This tool CANNOT work through Azure MCP proxy (runs on Linux).\n\n` +
        `Solutions:\n` +
        `- Run MCP server locally on D365FO Windows VM\n` +
        `- Use VS 2022 with local MCP stdio transport\n` +
        `- DO NOT use Azure HTTP proxy for file creation\n`
      );
    }
    
    // Verify drive/root exists before attempting recursive mkdir
    // (Node.js gives a cryptic '\\?' error when the drive letter doesn't exist)
    const driveOrRoot = path.parse(directory).root; // e.g. "K:\" or "C:\"
    if (driveOrRoot) {
      try {
        await fs.access(driveOrRoot);
      } catch {
        throw new Error(
          `❌ Drive or root path does not exist: ${driveOrRoot}\n\n` +
          `Attempting to create: ${directory}\n\n` +
          `The packagePath in your .mcp.json points to a drive that is not accessible.\n` +
          `Update "packagePath" in .mcp.json to match your actual D365FO installation:\n\n` +
          `Common paths:\n` +
          `  C:\\AosService\\PackagesLocalDirectory\n` +
          `  K:\\AosService\\PackagesLocalDirectory\n` +
          `  J:\\AosService\\PackagesLocalDirectory\n\n` +
          `Current packagePath: ${basePath}\n` +
          `Current drive checked: ${driveOrRoot}`
        );
      }
    }

    try {
      await fs.mkdir(directory, { recursive: true });
    } catch (mkdirError) {
      console.error(
        `[create_d365fo_file] Failed to create directory:`,
        mkdirError
      );
      const hint =
        (mkdirError instanceof Error && mkdirError.message.includes('\\?'))
          ? `\n\nHint: The path "${directory}" could not be created. ` +
            `Verify the drive letter exists and the path is correct. ` +
            `Update "packagePath" in .mcp.json to fix this.`
          : '';
      throw new Error(
        `Failed to create directory ${directory}: ${mkdirError instanceof Error ? mkdirError.message : 'Unknown error'}${hint}`
      );
    }

    // Check if file already exists
    let fileExisted = false;
    try {
      await fs.access(normalizedFullPath);
      fileExisted = true;
    } catch {
      // File does not exist — normal creation path
    }

    if (fileExisted) {
      if (!args.overwrite) {
        return {
          content: [
            {
              type: 'text',
              text: `⚠️ File already exists: ${normalizedFullPath}\n\nOptions:\n` +
                `  1. Pass overwrite=true together with xmlContent to replace the file.\n` +
                `  2. Use modify_d365fo_file to make targeted changes (rename-field, replace-all-fields, modify-property, …).\n` +
                `  3. Choose a different objectName.`,
            },
          ],
        };
      }
    }

    // ── Phase 4: Bridge-first creation via IMetadataProvider.Create() ──
    // For 18 supported types (class, class-extension, table, enum, edt, query, view, form,
    // menu, 3 menu-items, 3 security, table/form/enum-extension): try C# bridge first.
    // Falls back to TypeScript XML generation if bridge unavailable or unsupported type
    // (report, data-entity, tile, kpi, business-event, etc.).
    if (!args.xmlContent && context?.bridge && actualModelName && canBridgeCreate(args.objectType)) {
      try {
        // Prepare parameters for the bridge
        const bridgeParams: Parameters<typeof bridgeCreateObject>[1] = {
          objectType: args.objectType,
          objectName: finalObjectName,
          modelName: actualModelName,
          properties: (args.properties as Record<string, string>) ?? undefined,
        };

        // For classes: parse sourceCode into declaration + methods
        if ((args.objectType === 'class' || args.objectType === 'class-extension') && args.sourceCode) {
          const parsed = XmlTemplateGenerator.parseSourceForBridge(args.sourceCode);
          bridgeParams.declaration = parsed.declaration;
          bridgeParams.methods = parsed.methods;
        }

        // For tables: pass fields, fieldGroups, indexes, relations from properties
        if (args.objectType === 'table' && args.properties) {
          const props = args.properties as Record<string, unknown>;
          if (props.fields) bridgeParams.fields = props.fields as Record<string, unknown>[];
          if (props.fieldGroups) bridgeParams.fieldGroups = props.fieldGroups as Record<string, unknown>[];
          if (props.indexes) bridgeParams.indexes = props.indexes as Record<string, unknown>[];
          if (props.relations) bridgeParams.relations = props.relations as Record<string, unknown>[];
          if (props.methods) bridgeParams.methods = props.methods as { name: string; source?: string }[];
        }

        // For enums: pass values from properties
        if (args.objectType === 'enum' && args.properties) {
          const props = args.properties as Record<string, unknown>;
          if (props.values) bridgeParams.values = props.values as Record<string, unknown>[];
        }

        // For views: pass fields from properties
        if (args.objectType === 'view' && args.properties) {
          const props = args.properties as Record<string, unknown>;
          if (props.fields) bridgeParams.fields = props.fields as Record<string, unknown>[];
        }

        const bridgeResult = await bridgeCreateObject(context.bridge, bridgeParams);
        if (bridgeResult?.success && bridgeResult.filePath) {
          console.error(`[create_d365fo_file] ✅ Created via C# bridge: ${bridgeResult.filePath}`);

          // Add to .rnrproj if requested
          let projectMsg = '';
          if (args.addToProject !== false && projectPathToUse) {
            try {
              const projectManager = new ProjectFileManager();
              await projectManager.addToProject(
                projectPathToUse,
                args.objectType,
                finalObjectName,
                bridgeResult.filePath,
              );
              projectMsg = `\n✅ Added to project: ${path.basename(projectPathToUse)}`;
            } catch (projErr) {
              projectMsg = `\n⚠️ Could not add to project: ${projErr}`;
            }
          }

          // Auto-invalidate Redis cache so subsequent reads see fresh data
          // (bridge was already refreshed internally by bridgeCreateObject)
          if (context?.cache) {
            try {
              await invalidateCache(context.cache, finalObjectName, args.objectType, [finalObjectName]);
            } catch { /* Redis not available — non-fatal */ }
          }

          return {
            content: [
              {
                type: 'text',
                text: `✅ Created ${args.objectType} '${finalObjectName}' via IMetadataProvider.Create()\n` +
                  `📁 ${bridgeResult.filePath}${projectMsg}\n` +
                  `🔧 API: ${bridgeResult.message}`,
              },
            ],
          };
        }
        // If bridge returned null or success=false, fall through to XML generation
        console.error(`[create_d365fo_file] Bridge returned ${JSON.stringify(bridgeResult)} — falling back to XML generation`);
      } catch (bridgeErr) {
        console.error(`[create_d365fo_file] Bridge create failed, falling back to XML: ${bridgeErr}`);
      }
    }

    // Generate (or use provided) XML content
    let xmlContent = args.xmlContent
      ? args.xmlContent
      : XmlTemplateGenerator.generate(
          args.objectType,
          finalObjectName,
          args.sourceCode,
          args.properties
        );

    // CRITICAL FIX: Replace unprefixed class/table names with prefixed finalObjectName
    // When xmlContent or sourceCode contains `class MyClass` but finalObjectName is `MyPrefixMyClass`,
    // the file would be named MyPrefixMyClass.xml but contain `class MyClass` — inconsistency!
    if (finalObjectName !== args.objectName && (args.xmlContent || args.sourceCode)) {
      // Pattern to match: `class OriginalName` or `public class OriginalName`
      const classPattern = new RegExp(
        `\\b(public\\s+|private\\s+|protected\\s+|internal\\s+|final\\s+)?class\\s+${args.objectName}\\b`,
        'g'
      );
      const replacedContent = xmlContent.replace(classPattern, (match) => {
        return match.replace(args.objectName, finalObjectName);
      });
      
      if (replacedContent !== xmlContent) {
        console.error(
          `[create_d365fo_file] ✅ Fixed class name inconsistency: ` +
          `replaced \`class ${args.objectName}\` with \`class ${finalObjectName}\` in XML content`
        );
        xmlContent = replacedContent;
      }
    }

    // Sanitize AxReport XML structure — ensures required D365FO VS Designer elements
    // are always present, regardless of whether xmlContent came from the template or a caller.
    if (args.objectType === 'report') {
      xmlContent = XmlTemplateGenerator.sanitizeReportXml(xmlContent);
      // Convert remaining <Text><![CDATA[…]]></Text> to entity-encoded form.
      // sanitizeReportXml operates on CDATA internally; this final step converts
      // the output so that D365FO VS Designer renders the design correctly.
      xmlContent = XmlTemplateGenerator.encodeReportTextElement(xmlContent);
    }

    // Sanitize menu item XML — D365FO metadata deserializer requires
    // xmlns="Microsoft.Dynamics.AX.Metadata.V1" on the root element.
    if (args.objectType === 'menu-item-display' ||
        args.objectType === 'menu-item-action' ||
        args.objectType === 'menu-item-output') {
      xmlContent = XmlTemplateGenerator.sanitizeMenuItemXml(xmlContent);
    }

    // Sanitize table XML — ensures correct field element format required by D365FO deserializer.
    if (args.objectType === 'table') {
      xmlContent = XmlTemplateGenerator.sanitizeTableXml(xmlContent);
    }

    // Sanitize query XML — ensures xmlns="" and i:type="AxQuerySimple" on root element.
    if (args.objectType === 'query') {
      xmlContent = XmlTemplateGenerator.sanitizeQueryXml(xmlContent);
    }

    // Safety net: ensure every pair of adjacent </Method>…<Method> is separated by
    // exactly one blank line. This guards against xmlContent supplied by callers
    // (e.g. from generate_smart_table or generate_d365fo_xml) that might already be
    // correct, or against edge-cases in the generator that produces no blank line.
    // The replacement is idempotent: \n\n\n → \n\n (no double-blank lines created).
    xmlContent = xmlContent.replace(
      /<\/Method>\n(\t*)<Method>/g,
      '</Method>\n\n$1<Method>'
    );

    // Debug: Log XML content length
    const xmlSource = args.xmlContent ? 'provided by caller' : 'generated from template';
    console.error(
      `[create_d365fo_file] XML content (${xmlSource}): ${xmlContent.length} bytes`
    );
    console.error(
      `[create_d365fo_file] XML preview: ${xmlContent.substring(0, 200)}...`
    );

    // Write file with UTF-8 BOM (required for D365FO XML files)
    try {
      const utf8BOM = Buffer.from([0xEF, 0xBB, 0xBF]);
      const xmlBuffer = Buffer.concat([utf8BOM, Buffer.from(xmlContent, 'utf-8')]);
      await fs.writeFile(normalizedFullPath, xmlBuffer);
    } catch (writeError) {
      console.error(`[create_d365fo_file] Failed to write file:`, writeError);
      
      // Check if it's a disk/path issue
      const errorMessage = writeError instanceof Error ? writeError.message : String(writeError);
      if (errorMessage.includes('EINVAL') || errorMessage.includes('ENOENT')) {
        throw new Error(
          `Failed to write file to ${normalizedFullPath}.\n\n` +
          `Possible causes:\n` +
          `1. Drive K:\\ does not exist (running on Linux/Mac? Use packagePath parameter to override)\n` +
          `2. Directory ${path.dirname(normalizedFullPath)} is not accessible\n` +
          `3. Insufficient permissions\n\n` +
          `Original error: ${errorMessage}`
        );
      }
      throw writeError;
    }

    // Verify file was written
    const stats = await fs.stat(normalizedFullPath);
    const fileSizeKb = (stats.size / 1024).toFixed(1);
    console.error(
      `[create_d365fo_file] ✅ Written: ${normalizedFullPath}  (${fileSizeKb} KB)`
    );

    // Post-write validation via C# bridge (best-effort — non-fatal if bridge unavailable)
    let bridgeValidation = '';
    try {
      const validationMsg = await bridgeValidateAfterWrite(
        context?.bridge,
        args.objectType,
        finalObjectName,
      );
      if (validationMsg) {
        bridgeValidation = `\n${validationMsg}\n`;
        console.error(`[create_d365fo_file] Bridge validation: ${validationMsg}`);
      }
    } catch (e) {
      console.error(`[create_d365fo_file] Bridge validation skipped: ${e}`);
    }

    // Auto-invalidate Redis cache so subsequent reads return fresh data
    // (bridgeValidateAfterWrite already refreshed the C# bridge DiskProvider)
    if (context?.cache) {
      try {
        await invalidateCache(context.cache, finalObjectName, args.objectType, [finalObjectName]);
      } catch { /* Redis not available — non-fatal */ }
    }

    // Add to Visual Studio project if requested
    let projectMessage = '';
    if (args.addToProject) {
      // Try to find project file if not explicitly specified
      // Use projectPathToUse which includes values from .mcp.json config
      let projectPath = projectPathToUse;
      
      if (!projectPath && solutionPathToUse) {
        // Try to find project in solution directory
        // Use solutionPathToUse which includes values from .mcp.json config
        console.error(
          `[create_d365fo_file] Searching for .rnrproj in solution: ${solutionPathToUse}, model: ${actualModelName}`
        );
        const detectedPath = await ProjectFileFinder.findProjectInSolution(
          solutionPathToUse,
          actualModelName
        );

        if (!detectedPath) {
          console.error(
            `[create_d365fo_file] No .rnrproj found in solution directory`
          );
          projectMessage = `\n⚠️ Could not find .rnrproj file for model '${actualModelName}' in solution directory.\n` +
            `Searched in: ${solutionPathToUse}\n` +
            `Please specify projectPath parameter explicitly or add it to .mcp.json.\n`;
        } else {
          console.error(
            `[create_d365fo_file] Found project file: ${detectedPath}`
          );
          projectPath = detectedPath;
        }
      } else if (!projectPath) {
        projectMessage = `\n⚠️ Cannot add to project: projectPath could not be resolved.\n` +
          `Add projectPath to .mcp.json config, or pass it as a tool argument.\n` +
          `Example .mcp.json: { "servers": { "context": { "projectPath": "K:\\\\VSProjects\\\\MySolution\\\\MyModel\\\\MyModel.rnrproj" } } }\n`;
      }

      if (projectPath) {
        try {
          // Validate project file exists
          await fs.access(projectPath);

          // D365FO projects expect ABSOLUTE paths to XML files, not relative
          // The full path must point to the exact XML location in PackagesLocalDirectory
          // Ensure Windows path format with backslashes
          const absoluteXmlPath = normalizedFullPath;

          // Add to project
          const projectManager = new ProjectFileManager();
          const wasAdded = await projectManager.addToProject(
            projectPath,
            args.objectType,
            finalObjectName,
            absoluteXmlPath
          );

          if (wasAdded) {
            console.error(`[create_d365fo_file] Successfully added to project`);
            projectMessage = `\n✅ Successfully added to Visual Studio project:\n📋 Project: ${projectPath}\n` +
              `ℹ️  If the file does not appear in VS Solution Explorer, right-click the project → Reload Project.`;
          } else {
            console.error(`[create_d365fo_file] File already exists in project`);
            projectMessage = `\n✅ File already exists in Visual Studio project:\n📋 Project: ${projectPath}\n`;
          }
        } catch (projectError) {
          const errMsg = projectError instanceof Error ? projectError.message : 'Unknown error';
          const isLocked = errMsg.includes('EBUSY') || errMsg.includes('EPERM') || errMsg.includes('EACCES');
          console.error(
            `[create_d365fo_file] Failed to add to project:`,
            projectError
          );
          projectMessage = `\n⚠️ File created but failed to add to project:\n${errMsg}\n` +
            (isLocked
              ? `This usually means Visual Studio has the .rnrproj file locked.\n` +
                `Close Visual Studio (or unload the project), re-run the tool, then reopen.\n`
              : '');
        }
      } else if (!projectMessage) {
        // No projectPath found from any source — surface this in the response so AI and user see it
        projectMessage = `\n⚠️ addToProject=true but no projectPath could be resolved.\n` +
          `The file was created on disk but was NOT added to the Visual Studio project.\n\n` +
          `To fix this, add projectPath to your .mcp.json:\n` +
          `  {\n` +
          `    "servers": { "context": {\n` +
          `      "projectPath": "K:\\\\VSProjects\\\\YourSolution\\\\YourModel\\\\YourModel.rnrproj"\n` +
          `    } }\n` +
          `  }\n` +
          `Until then, add the file manually in Visual Studio: right-click project → Add Existing Item → ${normalizedFullPath}\n`;
      }
    }

    // Build success message
    const nextSteps = args.addToProject
      ? `Next steps:\n` +
        `1. Reload project in Visual Studio (or close/reopen solution)\n` +
        `2. Build the project to synchronize the object\n` +
        `3. Refresh AOT in Visual Studio to see the new object\n`
      : `Next steps:\n` +
        `1. Add the file to your Visual Studio project (.rnrproj)\n` +
        `2. Build the project to synchronize the object\n` +
        `3. Refresh AOT in Visual Studio to see the new object\n`;

    // Return success message with file path
    return {
      content: [
        {
          type: 'text',
          text: `✅ Successfully created D365FO ${args.objectType} file:\n\n` +
            `📁 Path: ${normalizedFullPath}\n` +
            `📄 Object: ${finalObjectName}${finalObjectName !== args.objectName ? ` (prefixed from "${args.objectName}")` : ''}\n` +
            `📦 Model: ${actualModelName}\n` +
            `🔧 Type: ${objectFolder}\n` +
            bridgeValidation +
            projectMessage +
            `\n${nextSteps}\n` +
            `⛔ TASK COMPLETE — do NOT call \`generate_smart_table\`, \`generate_smart_form\`, or \`create_d365fo_file\` again for this object.`,
        },
      ],
    };
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `❌ Error creating D365FO file:\n\n${error instanceof Error ? error.message : 'Unknown error'}`,
        },
      ],
    };
  }
}

export const createD365FileToolDefinition = {
  name: 'create_d365fo_file',
  description:
    'Creates a physical D365FO XML file in the correct AOT package structure. ' +
    'This tool generates the complete XML metadata file for classes, tables, enums, forms, etc. ' +
    'and saves it to the proper location in PackagesLocalDirectory. ' +
    'Use this instead of creating files in the project folder directly.',
  inputSchema: CreateD365FileArgsSchema,
};