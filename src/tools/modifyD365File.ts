/**
 * Modify D365FO File Tool
 * Edit existing D365FO XML files (AxClass, AxTable, AxForm, etc.)
 * Supports atomic operations: add method, add field, modify property
 */

import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { XppServerContext } from '../types/context.js';
import { promises as fs } from 'fs';
import { ensureXppDocComment } from '../utils/xppDocGen.js';
import path from 'path';
import { parseStringPromise, Builder } from 'xml2js';
import { getConfigManager } from '../utils/configManager.js';
import { PackageResolver } from '../utils/packageResolver.js';

/**
 * Re-wrap a specific XML element's text content in <![CDATA[...]]>.
 *
 * xml2js strips CDATA wrappers when parsing and entity-encodes < > & when
 * rebuilding. D365FO requires CDATA for <Declaration> and <Source> blocks, and
 * X++ code may contain characters that must not be entity-encoded (e.g.
 * `/// <summary>` doc comments, generic type parameters like `List<str>`).
 *
 * This function decodes entity-encoded characters and re-wraps the content in
 * a CDATA section so the output file matches the D365FO XML convention.
 */
export function rewrapXmlTagAsCdata(tag: string, xml: string): string {
  return xml.replace(
    new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'g'),
    (_match, innerRaw: string) => {
      // Already CDATA-wrapped — leave as-is (idempotency)
      if (innerRaw.trimStart().startsWith('<![CDATA[')) {
        return _match;
      }
      // Decode XML entities introduced by the xml2js Builder
      const decoded = innerRaw
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&')
        .replace(/&apos;/g, "'")
        .replace(/&quot;/g, '"')
        // xml2js Builder escapes \r as &#xD; — strip it to normalise to LF-only line endings
        .replace(/&#xD;/g, '');
      // Normalise: strip leading/trailing newlines
      const content = decoded.replace(/^\n+/, '').replace(/\n+$/, '');
      // D365FO convention: <![CDATA[\n...content...\n\n]]>
      // - One newline after opening <![CDATA[
      // - TWO newlines before closing ]]> (creates blank line before ]]>)
      return `<${tag}><![CDATA[\n${content}\n\n]]></${tag}>`;
    }
  );
}

const ModifyD365FileArgsSchema = z.object({
  objectType: z.enum([
    'class', 'table', 'form', 'enum', 'query', 'view', 'edt', 'data-entity', 'report',
    'table-extension', 'class-extension', 'form-extension', 'enum-extension', 'edt-extension',
    'data-entity-extension',
    'menu-item-display', 'menu-item-action', 'menu-item-output',
    'menu-item-display-extension', 'menu-item-action-extension', 'menu-item-output-extension',
    'menu', 'menu-extension',
    'security-privilege', 'security-duty', 'security-role',
  ]).describe('Type of D365FO object'),
  objectName: z.string().describe('Name of the object to modify'),
  operation: z.enum(['add-method', 'add-field', 'modify-field', 'rename-field', 'replace-all-fields', 'modify-property', 'remove-method', 'remove-field']).describe('Operation to perform'),
  
  // For add-method
  methodName: z.string().optional().describe('Name of method to add/remove'),
  methodCode: z.string().optional().describe('X++ code for the method body'),
  methodModifiers: z.string().optional().describe('Method modifiers (e.g., "public static")'),
  methodReturnType: z.string().optional().describe('Return type of method'),
  methodParameters: z.string().optional().describe('Method parameters (e.g., "str _param1, int _param2")'),
  
  // For add-field / modify-field (tables)
  fieldName: z.string().optional().describe('Name of field to add/remove/modify/rename'),
  fieldNewName: z.string().optional().describe('New name for the field (required for rename-field operation)'),
  fieldType: z.string().optional().describe('EDT name for the field (for add-field: required — pass the EDT name, e.g. "InventQty", "WHSZoneId"). For modify-field: new EDT to set.'),
  fieldBaseType: z.string().optional().describe(
    'Base type that determines the XML element for add-field: String | Integer | Real | Date | DateTime | Int64 | GUID | Enum. ' +
    'REQUIRED when fieldType is an EDT — pass the EDT base type so the correct AxTableFieldReal/AxTableFieldDate/… is used. ' +
    'Examples: fieldType="InventQty" fieldBaseType="Real"; fieldType="TransDate" fieldBaseType="Date"; fieldType="ItemId" fieldBaseType="String". ' +
    'Without this, all EDT fields default to AxTableFieldString which is WRONG for numeric/date types.'
  ),
  fieldMandatory: z.boolean().optional().describe('Is field mandatory'),
  fieldLabel: z.string().optional().describe('Field label'),
  fields: z.array(z.object({
    name: z.string(),
    edt: z.string().optional(),
    type: z.string().optional().describe('Base type for the XML element: String|Real|Integer|Date|DateTime|Int64|GUID|Enum. REQUIRED when edt is an EDT name — without it defaults to AxTableFieldString!'),
    mandatory: z.boolean().optional(),
    label: z.string().optional(),
  })).optional().describe(
    'Full list of fields for replace-all-fields operation. Each item: { name, edt?, type?, mandatory?, label? }. ' +
    'IMPORTANT: always pass type= the base type (String/Real/Integer/Date/DateTime/Int64/GUID) alongside edt= so the correct XML element is used. ' +
    'Example: { name: "TransQty", edt: "InventQty", type: "Real" }. ' +
    'All existing fields are replaced atomically.'
  ),
  
  // For modify-property
  propertyPath: z.string().optional().describe(
    'Top-level property name to set. For tables: TableGroup, TitleField1, TitleField2, TableType (TempDB/RegularTable/InMemory), ' +
    'CacheLookup, ClusteredIndex, PrimaryIndex, SaveDataPerCompany, Label, HelpText, Extends. ' +
    'For EDTs: Extends, StringSize, Label, HelpText, ReferenceTable, ReferenceField. ' +
    'For classes: Extends, Abstract, Final, Label. ' +
    'For nested properties use dot notation, e.g. "Fields.AxTableField.Name" (rare). ' +
    'Examples: propertyPath="TableGroup" propertyValue="Group"; propertyPath="TitleField1" propertyValue="ItemId"; ' +
    'propertyPath="TableType" propertyValue="TempDB"; propertyPath="Extends" propertyValue="WHSZoneId"'
  ),
  propertyValue: z.string().optional().describe('New property value'),
  
  // Options
  createBackup: z.boolean().optional().default(false).describe('Create backup before modification (default: false)'),
  modelName: z.string().optional().describe('Model name (auto-detected if not provided). Pass this if the file was just created and is not yet indexed.'),
  packageName: z.string().optional().describe('Package name. Auto-resolved if omitted.'),
  workspacePath: z.string().optional().describe('Path to workspace for finding file'),
  filePath: z.string().optional().describe(
    'Absolute path to the XML file. Use this when the object was just created and the path is already known ' +
    '(e.g. from create_d365fo_file output). Bypasses symbol DB lookup entirely.'
  ),
});

export async function modifyD365FileTool(request: CallToolRequest, context: XppServerContext) {
  try {
    const args = ModifyD365FileArgsSchema.parse(request.params.arguments);
    const { symbolIndex } = context;
    const {
      objectType,
      objectName,
      operation,
      createBackup,
      modelName,
      workspacePath,
      filePath: explicitFilePath,
    } = args;

    // 1. Find the file
    const filePath = await findD365File(symbolIndex, objectType, objectName, modelName, workspacePath, explicitFilePath);

    if (!filePath) {
      throw new Error(
        `File not found for ${objectType} "${objectName}".\n\n` +
        `Retry options (do NOT use PowerShell — this tool can handle it):\n` +
        `  1. Pass modelName="<YourModel>" — triggers filesystem lookup by path.\n` +
        `  2. Pass filePath="K:\\\\AosService\\\\PackagesLocalDirectory\\\\<pkg>\\\\<model>\\\\${objectName}.xml" — bypasses all lookup.\n` +
        `  3. If the object was just created, re-run create_d365fo_file first and use the returned path as filePath.`
      );
    }

    // 2. Resolve actual XML file path (DB may store JSON metadata with sourcePath)
    let xmlContent: string;
    let actualFilePath = filePath;
    try {
      const fileContent = await fs.readFile(filePath, 'utf-8');
      const trimmed = fileContent.trimStart();
      if (trimmed.startsWith('{')) {
        const data = JSON.parse(fileContent);
        if (data.sourcePath) {
          actualFilePath = data.sourcePath;
          xmlContent = await fs.readFile(data.sourcePath, 'utf-8');
        } else {
          throw new Error(`Metadata file has no sourcePath: ${filePath}`);
        }
      } else {
        xmlContent = fileContent;
      }
    } catch (readError) {
      if (readError instanceof SyntaxError || (readError instanceof Error && readError.message.includes('sourcePath'))) {
        throw readError;
      }
      const isRelative = !path.isAbsolute(filePath);
      const hint = isRelative
        ? ' The path is relative — the symbol DB returned a build-agent path. ' +
          'Pass filePath="<absolute path>" or modelName="<YourModel>" so the tool can locate the file on disk.'
        : '';
      throw new Error(`Cannot read file: ${filePath}${hint}`);
    }

    // 3. Create backup of the actual XML file
    if (createBackup) {
      await createFileBackup(actualFilePath);
    }
    const xmlObj = await parseStringPromise(xmlContent);

    // 4. Perform operation
    let modified = false;
    let message = '';

    switch (operation) {
      case 'add-method':
        modified = await addMethod(xmlObj, objectType, args);
        message = `Added method "${args.methodName}" to ${objectType} "${objectName}"`;
        break;
      
      case 'remove-method':
        modified = await removeMethod(xmlObj, objectType, args);
        message = `Removed method "${args.methodName}" from ${objectType} "${objectName}"`;
        break;
      
      case 'add-field':
        modified = await addField(xmlObj, objectType, args);
        message = `Added field "${args.fieldName}" to ${objectType} "${objectName}"`;
        break;
      
      case 'modify-field':
        modified = await modifyField(xmlObj, objectType, args);
        message = `Modified field "${args.fieldName}" in ${objectType} "${objectName}"`;
        break;
      
      case 'rename-field':
        modified = await renameField(xmlObj, objectType, args);
        message = `Renamed field "${args.fieldName}" → "${args.fieldNewName}" in ${objectType} "${objectName}"`;
        break;

      case 'replace-all-fields':
        modified = await replaceAllFields(xmlObj, objectType, args);
        message = `Replaced all fields in ${objectType} "${objectName}" (${(args as any).fields?.length ?? 0} fields written)`;
        break;
      
      case 'remove-field':
        modified = await removeField(xmlObj, objectType, args);
        message = `Removed field "${args.fieldName}" from ${objectType} "${objectName}"`;
        break;
      
      case 'modify-property':
        modified = await modifyProperty(xmlObj, objectType, args);
        message = `Modified property "${args.propertyPath}" in ${objectType} "${objectName}"`;
        break;
      
      default:
        throw new Error(`Unsupported operation: ${operation}`);
    }

    if (!modified) {
      throw new Error(`Failed to perform operation "${operation}". The object structure might be unexpected.`);
    }

    // 5. Write XML back
    const builder = new Builder({
      xmldec: { version: '1.0', encoding: 'utf-8' },
      renderOpts: { pretty: true, indent: '\t', newline: '\n' },
      headless: false,
    });

    let newXml = builder.buildObject(xmlObj);

    // ── Re-wrap <Declaration> and <Source> content in CDATA ─────────────────
    // xml2js strips the <![CDATA[...]]> wrappers during parsing. When the Builder
    // re-serialises the XML it:
    //   1. Loses the CDATA wrapper (D365FO requires it for Source/Declaration blocks)
    //   2. Entity-encodes < > & inside method/class source → breaks /// <summary> doc
    //      comments (they become /// &lt;summary&gt;) and any generic types (List<str>)
    //
    // Fix: replace  <Tag>...content...</Tag>  with  <Tag><![CDATA[\n...decoded...\n]]></Tag>
    // for all <Declaration> and <Source> elements. See rewrapXmlTagAsCdata() above.
    newXml = rewrapXmlTagAsCdata('Declaration', newXml);
    newXml = rewrapXmlTagAsCdata('Source', newXml);

    await fs.writeFile(actualFilePath, newXml, 'utf-8');

    // 6. Return success
    return {
      content: [
        {
          type: 'text',
          text: `✅ ${message}\n\n**File:** ${actualFilePath}\n\n**Next steps:**\n- Review changes in Visual Studio\n- Build the model to validate\n- Commit changes to source control`,
        },
      ],
    };

  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `❌ Error modifying D365FO file: ${error instanceof Error ? error.message : 'Unknown error'}`,
        },
      ],
      isError: true,
    };
  }
}

/**
 * Find D365FO file path
 */
async function findD365File(
  symbolIndex: any,
  objectType: string,
  objectName: string,
  modelName?: string,
  _workspacePath?: string,
  explicitFilePath?: string
): Promise<string | null> {
  // Explicit path bypasses all lookup — use when caller knows the exact location
  // (e.g. the path was returned by create_d365fo_file).
  if (explicitFilePath) {
    return explicitFilePath;
  }

  // Symbol DB only indexes a subset of types — for the rest go straight to filesystem.
  const dbTypeMap: Record<string, string> = {
    class: 'class',
    table: 'table',
    form: 'form',
    enum: 'enum',
    query: 'query',
    view: 'view',
  };

  const symbolType = dbTypeMap[objectType];

  // Query database when a symbol type mapping exists
  if (symbolType) {
    let dbResult: string | null = null;
    if (modelName) {
      const stmt = symbolIndex.db.prepare(`
        SELECT file_path
        FROM symbols
        WHERE type = ? AND name = ? AND model = ?
        LIMIT 1
      `);
      const row = stmt.get(symbolType, objectName, modelName);
      dbResult = row ? row.file_path : null;
    } else {
      const stmt = symbolIndex.db.prepare(`
        SELECT file_path
        FROM symbols
        WHERE type = ? AND name = ?
        ORDER BY model
        LIMIT 1
      `);
      const row = stmt.get(symbolType, objectName);
      dbResult = row ? row.file_path : null;
    }

    // Only trust the DB path when it is an absolute path that actually exists on disk.
    // The DB file_path column stores paths from the CI build agent (e.g. C:\home\vsts\work\...)
    // which are never accessible at runtime.  Relative paths (e.g. "fm-mcp/fm-mcp/AxClass/Foo.xml")
    // also come from this source and cannot be used directly.
    // Fall through to findD365FileOnDisk which builds the correct absolute path from config.
    if (dbResult && path.isAbsolute(dbResult)) {
      try {
        await import('fs').then(m => m.promises.access(dbResult!));
        return dbResult;
      } catch {
        // Absolute path from DB but not accessible — fall through to filesystem lookup
        console.error(`[modifyD365File] DB path not accessible: ${dbResult} — falling back to filesystem lookup`);
      }
    } else if (dbResult) {
      console.error(`[modifyD365File] DB returned relative path: ${dbResult} — falling back to filesystem lookup`);
    }
  }

  // Filesystem fallback: handles newly created files not yet in the symbol index,
  // and all types not covered by the symbol DB (edt, report, extensions, security, menu …).
  return findD365FileOnDisk(objectType, objectName, modelName);
}

/**
 * Filesystem fallback for findD365File.
 * Constructs the expected AOT file path from config/env and checks if it exists on disk.
 * This handles objects that were just created and are not yet indexed in the symbol database.
 */
export async function findD365FileOnDisk(
  objectType: string,
  objectName: string,
  modelName?: string
): Promise<string | null> {
  const folderMap: Record<string, string> = {
    class: 'AxClass',
    table: 'AxTable',
    form: 'AxForm',
    enum: 'AxEnum',
    query: 'AxQuery',
    view: 'AxView',
    edt: 'AxEdt',
    'data-entity': 'AxDataEntityView',
    report: 'AxReport',
    'table-extension': 'AxTableExtension',
    'class-extension': 'AxClass',
    'form-extension': 'AxFormExtension',
    'enum-extension': 'AxEnumExtension',
    'edt-extension': 'AxEdtExtension',
    'data-entity-extension': 'AxDataEntityViewExtension',
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
  };

  const objectFolder = folderMap[objectType];
  if (!objectFolder) return null;

  const configManager = getConfigManager();

  // Ensure .mcp.json is loaded — lazy init so this works even when
  // server startup did not call initializeConfig() before this tool ran.
  await configManager.ensureLoaded();

  // Resolve model name (same priority order as generateSmartTable):
  //   1. Explicit arg (skip placeholders like "any")
  //   2. .mcp.json context (modelName field or last segment of workspacePath)
  //   3. Auto-detected model name (async, from .rnrproj scan)
  //   4. D365FO_MODEL_NAME env var
  const resolvedModel =
    (modelName && modelName !== 'any' ? modelName : null) ||
    configManager.getModelName() ||
    (await configManager.getAutoDetectedModelName()) ||
    process.env.D365FO_MODEL_NAME ||
    null;

  if (!resolvedModel) {
    console.error('[modifyD365File] Filesystem fallback: could not resolve model name. ' +
      'Provide modelName parameter, configure .mcp.json with modelName/projectPath, or set D365FO_MODEL_NAME env var.');
    return null;
  }

  const configPackagePath =
    configManager.getPackagePath() || 'K:\\AosService\\PackagesLocalDirectory';

  // Traditional mode: package name == model name (most common case)
  const candidatePath = path.join(
    configPackagePath,
    resolvedModel,
    resolvedModel,
    objectFolder,
    `${objectName}.xml`
  );

  try {
    await fs.access(candidatePath);
    console.error(`[modifyD365File] Found via filesystem fallback: ${candidatePath}`);
    return candidatePath;
  } catch {
    // Not at the default package==model path; try UDE layout
  }

  // UDE mode: package name may differ from model name — use PackageResolver
  try {
    const envType = await configManager.getDevEnvironmentType();
    if (envType === 'ude') {
      const customPath = await configManager.getCustomPackagesPath();
      const msPath = await configManager.getMicrosoftPackagesPath();
      const roots = [customPath, msPath].filter(Boolean) as string[];
      const resolver = new PackageResolver(roots);
      const resolved = await resolver.resolve(resolvedModel);
      if (resolved) {
        const udePath = path.join(
          resolved.rootPath,
          resolved.packageName,
          resolvedModel,
          objectFolder,
          `${objectName}.xml`
        );
        try {
          await fs.access(udePath);
          console.error(`[modifyD365File] Found via UDE filesystem fallback: ${udePath}`);
          return udePath;
        } catch {
          // Not found at UDE path either
        }
      }
    }
  } catch {
    // UDE resolution failed — skip silently
  }

  return null;
}

/**
 * Create file backup and verify it was written successfully.
 * Throws if the source file is missing or the copy fails, so callers
 * always know whether a valid backup exists before overwriting.
 */
async function createFileBackup(filePath: string): Promise<void> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
  const backupPath = `${filePath}.backup-${timestamp}`;
  try {
    await fs.copyFile(filePath, backupPath);
    // Confirm the backup has non-zero size before proceeding
    const stat = await fs.stat(backupPath);
    if (stat.size === 0) {
      throw new Error('Backup file was created but is empty');
    }
  } catch (error) {
    throw new Error(
      `Failed to create backup at "${backupPath}": ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Add method to class/table/form
 */
async function addMethod(xmlObj: any, objectType: string, args: any): Promise<boolean> {
  const { methodName, methodCode, methodModifiers, methodReturnType, methodParameters } = args;

  if (!methodName) {
    throw new Error('methodName is required for add-method operation');
  }

  // Navigate to Methods node
  const rootKey = getRootKey(objectType);
  const root = xmlObj[rootKey];

  if (!root) {
    throw new Error(`Invalid XML structure: root element <${rootKey}> not found`);
  }

  // Special case: classDeclaration lives in SourceCode > Declaration, not in Methods array.
  // Use add-method with methodName="classDeclaration" to set/replace the class header.
  if (methodName === 'classDeclaration') {
    if (!root.SourceCode || typeof root.SourceCode[0] !== 'object') {
      root.SourceCode = [{}];
    }
    root.SourceCode[0].Declaration = [ensureXppDocComment(methodCode || '')];
    return true;
  }

  // Methods are always under SourceCode > Methods for all D365FO object types
  // (AxClass, AxTable, AxForm all use <SourceCode><Methods>...</Methods></SourceCode>)
  //
  // xml2js edge cases for empty/missing SourceCode:
  //   - absent entirely          → root.SourceCode is undefined         → falsy ✓
  //   - <SourceCode></SourceCode> → root.SourceCode is ['']             → truthy array, element is ''
  //   - <SourceCode/>            → root.SourceCode is ['']             → same
  // We must check the *element* is a proper object, not just that the array exists.
  let methodsContainer: any;
  const sourceCodeEl = Array.isArray(root.SourceCode) ? root.SourceCode[0] : root.SourceCode;
  if (!sourceCodeEl || typeof sourceCodeEl !== 'object') {
    // Absent or empty element – create the full structure from scratch
    root.SourceCode = [{ Methods: [{ Method: [] }] }];
  }
  methodsContainer = root.SourceCode[0];

  let methodsNode = methodsContainer.Methods;
  if (!methodsNode || (Array.isArray(methodsNode) && typeof methodsNode[0] !== 'object')) {
    methodsContainer.Methods = [{ Method: [] }];
    methodsNode = methodsContainer.Methods;
  }

  if (!methodsNode[0].Method) {
    methodsNode[0].Method = [];
  } else if (!Array.isArray(methodsNode[0].Method)) {
    // Single existing method may be parsed as an object instead of a 1-element array
    methodsNode[0].Method = [methodsNode[0].Method];
  }

  // Build full method source — if methodCode already contains the signature use it directly,
  // otherwise assemble from methodModifiers / methodReturnType / methodParameters.
  let fullSource: string;
  if (methodCode && methodCode.includes('(')) {
    // Caller passed a complete method (signature + body)
    fullSource = methodCode;
  } else {
    const modifiers  = methodModifiers  || 'public';
    const retType    = methodReturnType || 'void';
    const params     = methodParameters || '';
    const bodyLines  = methodCode || `// TODO: Implement ${methodName}`;
    fullSource = `${modifiers} ${retType} ${methodName}(${params})\n{\n    ${bodyLines}\n}`;
  }

  // Create method node
  const newMethod = {
    Name: [methodName],
    Source: [ensureXppDocComment(fullSource)],
  };

  methodsNode[0].Method.push(newMethod);

  return true;
}

/**
 * Remove method from class/table/form
 */
async function removeMethod(xmlObj: any, objectType: string, args: any): Promise<boolean> {
  const { methodName } = args;

  if (!methodName) {
    throw new Error('methodName is required for remove-method operation');
  }

  const rootKey = getRootKey(objectType);
  const root = xmlObj[rootKey];

  if (!root) {
    throw new Error(`Invalid XML structure: root element <${rootKey}> not found`);
  }

  // Special case: classDeclaration is the Declaration element, not a Method node.
  if (methodName === 'classDeclaration') {
    throw new Error(
      'classDeclaration cannot be removed. Use add-method with methodName="classDeclaration" to replace the class header.'
    );
  }

  // Methods are always under SourceCode > Methods for all D365FO object types
  const methodsContainer = root.SourceCode?.[0];
  if (!methodsContainer?.Methods?.[0]?.Method) {
    throw new Error('No methods found in object');
  }

  // Also search Declaration — some exporters store classDeclaration as a Method node
  const methods = methodsContainer.Methods[0].Method;
  const index = methods.findIndex((m: any) => m.Name && m.Name[0] === methodName);

  if (index === -1) {
    throw new Error(`Method "${methodName}" not found`);
  }

  methods.splice(index, 1);
  return true;
}

/**
 * Add field to table
 */
async function addField(xmlObj: any, objectType: string, args: any): Promise<boolean> {
  const { fieldName, fieldType, fieldBaseType, fieldMandatory, fieldLabel } = args;

  if (!fieldName) {
    throw new Error('fieldName is required for add-field operation');
  }

  if (!fieldType) {
    throw new Error('fieldType is required for add-field operation');
  }

  if (objectType !== 'table') {
    throw new Error('add-field operation is only supported for tables');
  }

  const rootKey = getRootKey(objectType);
  const root = xmlObj[rootKey];

  if (!root) {
    throw new Error(`Invalid XML structure: root element <${rootKey}> not found`);
  }

  // Ensure Fields container exists.
  // xml2js parses <Fields/> or <Fields></Fields> as [''] (array with empty string),
  // and a completely missing <Fields> as undefined. Both need to be replaced.
  const rawFields = root.Fields;
  const fieldsEmpty =
    !rawFields ||
    rawFields === '' ||
    (Array.isArray(rawFields) && (rawFields.length === 0 || rawFields[0] === '' || rawFields[0] == null));
  if (fieldsEmpty) {
    root.Fields = [{ AxTableField: [] }];
  }
  const fieldsContainer = Array.isArray(root.Fields) ? root.Fields[0] : root.Fields;

  // xml2js with explicitArray:false may store single AxTableField as object, not array
  if (!fieldsContainer.AxTableField) {
    fieldsContainer.AxTableField = [];
  } else if (!Array.isArray(fieldsContainer.AxTableField)) {
    fieldsContainer.AxTableField = [fieldsContainer.AxTableField];
  }

  // D365FO field XML format: <AxTableField xmlns="" i:type="AxTableFieldString">
  // xml2js represents this as { '$': { xmlns: '', 'i:type': 'AxTableFieldString' }, Name: [...] }
  const iType = getFieldNodeName(fieldBaseType || fieldType);
  const newField: any = {
    '$': { xmlns: '', 'i:type': iType },
    Name: [fieldName],
    ExtendedDataType: [fieldType],
  };

  if (fieldLabel) {
    newField.Label = [fieldLabel];
  }

  if (fieldMandatory !== undefined) {
    newField.Mandatory = [fieldMandatory ? 'Yes' : 'No'];
  }

  fieldsContainer.AxTableField.push(newField);

  return true;
}

/**
 * Modify an existing field on a table (change EDT, mandatory, label).
 * At least one of fieldType / fieldMandatory / fieldLabel must be provided.
 */
async function modifyField(xmlObj: any, objectType: string, args: any): Promise<boolean> {
  const { fieldName, fieldType, fieldMandatory, fieldLabel } = args;

  if (!fieldName) {
    throw new Error('fieldName is required for modify-field operation');
  }

  if (fieldType === undefined && fieldMandatory === undefined && fieldLabel === undefined) {
    throw new Error('At least one of fieldType, fieldMandatory or fieldLabel is required for modify-field');
  }

  if (objectType !== 'table') {
    throw new Error('modify-field operation is only supported for tables');
  }

  const rootKey = getRootKey(objectType);
  const root = xmlObj[rootKey];

  if (!root) {
    throw new Error(`Invalid XML structure: root element <${rootKey}> not found`);
  }

  const rawFields = root.Fields;
  const fieldsEmpty =
    !rawFields ||
    rawFields === '' ||
    (Array.isArray(rawFields) && (rawFields.length === 0 || rawFields[0] === '' || rawFields[0] == null));
  if (fieldsEmpty) {
    throw new Error(`Table has no fields — cannot modify field "${fieldName}"`);
  }

  const fieldsContainer = Array.isArray(root.Fields) ? root.Fields[0] : root.Fields;
  if (!Array.isArray(fieldsContainer.AxTableField)) {
    fieldsContainer.AxTableField = fieldsContainer.AxTableField ? [fieldsContainer.AxTableField] : [];
  }

  const field = fieldsContainer.AxTableField.find((f: any) => {
    return Array.isArray(f.Name) ? f.Name[0] === fieldName : f.Name === fieldName;
  });

  if (!field) {
    throw new Error(`Field "${fieldName}" not found in table`);
  }

  // Update EDT (ExtendedDataType) and i:type attribute
  if (fieldType !== undefined) {
    const iType = getFieldNodeName(fieldType);
    if (!field['$']) field['$'] = {};
    field['$']['i:type'] = iType;
    field.ExtendedDataType = [fieldType];
  }

  if (fieldMandatory !== undefined) {
    field.Mandatory = [fieldMandatory ? 'Yes' : 'No'];
  }

  if (fieldLabel !== undefined) {
    field.Label = [fieldLabel];
  }

  return true;
}

/**
 * Rename an existing field on a table.
 * Also updates any index field references that use the old name.
 */
async function renameField(xmlObj: any, objectType: string, args: any): Promise<boolean> {
  const { fieldName, fieldNewName } = args;

  if (!fieldName) throw new Error('fieldName is required for rename-field operation');
  if (!fieldNewName) throw new Error('fieldNewName is required for rename-field operation');
  if (objectType !== 'table') throw new Error('rename-field operation is only supported for tables');

  const rootKey = getRootKey(objectType);
  const root = xmlObj[rootKey];
  if (!root) throw new Error(`Invalid XML structure: root element <${rootKey}> not found`);

  // --- Fix Fields block ---
  // If the field still has the OLD name, rename it.
  // If it already has the NEW name (was renamed by replace-all-fields), skip silently.
  // If the table has no fields at all, that is also fine — we may only be fixing index refs.
  const rawFields = root.Fields;
  const fieldsEmpty =
    !rawFields ||
    rawFields === '' ||
    (Array.isArray(rawFields) && (rawFields.length === 0 || rawFields[0] === '' || rawFields[0] == null));

  if (!fieldsEmpty) {
    const fieldsContainer = Array.isArray(root.Fields) ? root.Fields[0] : root.Fields;
    if (!Array.isArray(fieldsContainer.AxTableField)) {
      fieldsContainer.AxTableField = fieldsContainer.AxTableField ? [fieldsContainer.AxTableField] : [];
    }

    const field = fieldsContainer.AxTableField.find((f: any) =>
      Array.isArray(f.Name) ? f.Name[0] === fieldName : f.Name === fieldName
    );
    if (field) {
      // Field still has old name — rename it
      field.Name = [fieldNewName];
    }
    // If not found: field was already renamed (e.g. via replace-all-fields) — continue to fix refs below
  }

  // --- Fix index DataField references ---
  const fixIndexRefs = (container: any) => {
    if (!container) return;
    const items = Array.isArray(container) ? container : [container];
    for (const item of items) {
      if (Array.isArray(item.Fields?.[0]?.AxTableIndexField)) {
        for (const idxField of item.Fields[0].AxTableIndexField) {
          const cur = Array.isArray(idxField.DataField) ? idxField.DataField[0] : idxField.DataField;
          if (cur === fieldName) {
            idxField.DataField = [fieldNewName];
          }
        }
      }
    }
  };
  fixIndexRefs(root.Indexes?.[0]?.AxTableIndex);

  // --- Fix FieldGroups DataField references ---
  // Structure: FieldGroups[0].AxTableFieldGroup[].Fields[0].AxTableFieldGroupField[].DataField
  const fixFieldGroupRefs = (oldName: string, newName: string, fgContainer: any) => {
    if (!fgContainer) return;
    const groups = Array.isArray(fgContainer) ? fgContainer : [fgContainer];
    for (const group of groups) {
      const fgFields = group.Fields?.[0]?.AxTableFieldGroupField;
      if (!Array.isArray(fgFields)) continue;
      for (const fgField of fgFields) {
        const cur = Array.isArray(fgField.DataField) ? fgField.DataField[0] : fgField.DataField;
        if (cur === oldName) {
          fgField.DataField = [newName];
        }
      }
    }
  };
  fixFieldGroupRefs(fieldName, fieldNewName, root.FieldGroups?.[0]?.AxTableFieldGroup);

  // --- Fix TitleField1/TitleField2 ---
  const tf1 = Array.isArray(root.TitleField1) ? root.TitleField1[0] : root.TitleField1;
  if (tf1 === fieldName) root.TitleField1 = [fieldNewName];
  const tf2 = Array.isArray(root.TitleField2) ? root.TitleField2[0] : root.TitleField2;
  if (tf2 === fieldName) root.TitleField2 = [fieldNewName];

  return true;
}

/**
 * Atomically replace ALL fields in a table with a new field list.
 * Use when field names are corrupted (contain spaces, wrong EDTs, etc.).
 */
async function replaceAllFields(xmlObj: any, objectType: string, args: any): Promise<boolean> {
  const { fields } = args as { fields?: Array<{ name: string; edt?: string; type?: string; mandatory?: boolean; label?: string }> };

  if (!fields || fields.length === 0) {
    throw new Error('fields array is required and must not be empty for replace-all-fields operation');
  }
  if (objectType !== 'table') throw new Error('replace-all-fields operation is only supported for tables');

  const rootKey = getRootKey(objectType);
  const root = xmlObj[rootKey];
  if (!root) throw new Error(`Invalid XML structure: root element <${rootKey}> not found`);

  // Build old→new name map from existing Fields block before overwriting
  // so we can repair index DataField references afterwards.
  const oldToNew = new Map<string, string>();
  const rawFieldsBefore = root.Fields;
  const hasOldFields =
    rawFieldsBefore &&
    rawFieldsBefore !== '' &&
    Array.isArray(rawFieldsBefore) &&
    rawFieldsBefore.length > 0 &&
    rawFieldsBefore[0] !== '' &&
    rawFieldsBefore[0] != null;

  if (hasOldFields) {
    const oldContainer = Array.isArray(rawFieldsBefore) ? rawFieldsBefore[0] : rawFieldsBefore;
    const oldAxFields = Array.isArray(oldContainer.AxTableField)
      ? oldContainer.AxTableField
      : oldContainer.AxTableField ? [oldContainer.AxTableField] : [];

    // Match old fields to new fields by position (best-effort for corrupted names)
    for (let i = 0; i < Math.min(oldAxFields.length, fields.length); i++) {
      const oldName = Array.isArray(oldAxFields[i].Name) ? oldAxFields[i].Name[0] : oldAxFields[i].Name;
      const newName = fields[i].name;
      if (oldName && oldName !== newName) {
        oldToNew.set(oldName, newName);
      }
    }
  }

  // Build new AxTableField array
  const newAxTableFields = fields.map(f => {
    // type= is the explicit base type override (Real/String/Date/…); edt= is the EDT name.
    // Priority: explicit type > edt name lookup > default String
    const iType = f.type ? getFieldNodeName(f.type) : getFieldNodeName(f.edt || 'String');
    const node: any = {
      '$': { xmlns: '', 'i:type': iType },
      Name: [f.name],
    };
    if (f.edt)      node.ExtendedDataType = [f.edt];
    if (f.mandatory) node.Mandatory = ['Yes'];
    if (f.label)     node.Label = [f.label];
    return node;
  });

  root.Fields = [{ AxTableField: newAxTableFields }];

  // Repair index DataField references using the old→new name map
  if (oldToNew.size > 0) {
    const indexes = root.Indexes?.[0]?.AxTableIndex;
    if (indexes) {
      const idxList = Array.isArray(indexes) ? indexes : [indexes];
      for (const idx of idxList) {
        if (Array.isArray(idx.Fields?.[0]?.AxTableIndexField)) {
          for (const idxField of idx.Fields[0].AxTableIndexField) {
            const cur = Array.isArray(idxField.DataField) ? idxField.DataField[0] : idxField.DataField;
            const mapped = oldToNew.get(cur);
            if (mapped) {
              idxField.DataField = [mapped];
            }
          }
        }
      }
    }
    // Repair TitleField1/TitleField2
    const tf1 = Array.isArray(root.TitleField1) ? root.TitleField1[0] : root.TitleField1;
    if (tf1 && oldToNew.has(tf1)) root.TitleField1 = [oldToNew.get(tf1)];
    const tf2 = Array.isArray(root.TitleField2) ? root.TitleField2[0] : root.TitleField2;
    if (tf2 && oldToNew.has(tf2)) root.TitleField2 = [oldToNew.get(tf2)];

    // Repair FieldGroups DataField references
    const fgGroups = root.FieldGroups?.[0]?.AxTableFieldGroup;
    if (fgGroups) {
      const groups = Array.isArray(fgGroups) ? fgGroups : [fgGroups];
      for (const group of groups) {
        const fgFields = group.Fields?.[0]?.AxTableFieldGroupField;
        if (!Array.isArray(fgFields)) continue;
        for (const fgField of fgFields) {
          const cur = Array.isArray(fgField.DataField) ? fgField.DataField[0] : fgField.DataField;
          const mapped = cur ? oldToNew.get(cur) : undefined;
          if (mapped) {
            fgField.DataField = [mapped];
          }
        }
      }
    }
  }

  return true;
}

/**
 * Remove field from table
 */
async function removeField(xmlObj: any, objectType: string, args: any): Promise<boolean> {
  const { fieldName } = args;

  if (!fieldName) {
    throw new Error('fieldName is required for remove-field operation');
  }

  if (objectType !== 'table') {
    throw new Error('remove-field operation is only supported for tables');
  }

  const rootKey = getRootKey(objectType);
  const root = xmlObj[rootKey];

  if (!root) {
    throw new Error(`Invalid XML structure: root element <${rootKey}> not found`);
  }

  const rawFields = root.Fields;
  const fieldsEmpty =
    !rawFields ||
    rawFields === '' ||
    (Array.isArray(rawFields) && (rawFields.length === 0 || rawFields[0] === '' || rawFields[0] == null));
  if (fieldsEmpty) {
    throw new Error(`Table has no fields — cannot remove field "${fieldName}"`);
  }

  const fieldsContainer = Array.isArray(root.Fields) ? root.Fields[0] : root.Fields;
  if (!Array.isArray(fieldsContainer.AxTableField)) {
    fieldsContainer.AxTableField = fieldsContainer.AxTableField ? [fieldsContainer.AxTableField] : [];
  }

  const fields = fieldsContainer.AxTableField;
  const index = fields.findIndex((f: any) => {
    return Array.isArray(f.Name) ? f.Name[0] === fieldName : f.Name === fieldName;
  });

  if (index === -1) {
    throw new Error(`Field "${fieldName}" not found`);
  }

  fields.splice(index, 1);
  return true;
}

/**
 * Modify property value
 */
async function modifyProperty(xmlObj: any, objectType: string, args: any): Promise<boolean> {
  const { propertyPath, propertyValue } = args;

  if (!propertyPath) {
    throw new Error('propertyPath is required for modify-property operation');
  }

  if (propertyValue === undefined) {
    throw new Error('propertyValue is required for modify-property operation');
  }

  // Parse property path (e.g., "Table1.Visible")
  const parts = propertyPath.split('.');
  
  const rootKey = getRootKey(objectType);
  let current = xmlObj[rootKey];

  if (!current) {
    throw new Error(`Invalid XML structure: root element <${rootKey}> not found`);
  }

  // Navigate to property
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (!current[part]) {
      throw new Error(`Property path not found: ${propertyPath} (failed at "${part}")`);
    }
    current = current[part][0];
  }

  // Set property value
  const lastPart = parts[parts.length - 1];
  if (!current[lastPart]) {
    current[lastPart] = [];
  }
  current[lastPart][0] = propertyValue;

  return true;
}

/**
 * Get root key for object type
 */
function getRootKey(objectType: string): string {
  const keyMap: Record<string, string> = {
    class: 'AxClass',
    table: 'AxTable',
    form: 'AxForm',
    enum: 'AxEnum',
    query: 'AxQuery',
    view: 'AxView',
    edt: 'AxEdt',
    'data-entity': 'AxDataEntityView',
    report: 'AxReport',
    'table-extension': 'AxTableExtension',
    'class-extension': 'AxClass',
    'form-extension': 'AxFormExtension',
    'enum-extension': 'AxEnumExtension',
    'edt-extension': 'AxEdtExtension',
    'data-entity-extension': 'AxDataEntityViewExtension',
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
  };

  const key = keyMap[objectType];
  if (!key) {
    throw new Error(`Unknown object type: ${objectType}`);
  }

  return key;
}

/**
 * Get AxTableField i:type attribute value from a primitive type name or EDT name.
 * Checks explicit primitive types first; falls back to EDT name heuristics.
 */
function getFieldNodeName(fieldType: string): string {
  // Map primitive type names
  const typeMap: Record<string, string> = {
    String:      'AxTableFieldString',
    Integer:     'AxTableFieldInt',
    Real:        'AxTableFieldReal',
    Date:        'AxTableFieldDate',
    DateTime:    'AxTableFieldUtcDateTime',
    UtcDateTime: 'AxTableFieldUtcDateTime',
    Enum:        'AxTableFieldEnum',
    Int64:       'AxTableFieldInt64',
    GUID:        'AxTableFieldGuid',
    Guid:        'AxTableFieldGuid',
    Container:   'AxTableFieldContainer',
  };

  const explicit = typeMap[fieldType];
  if (explicit) return explicit;

  // Fall back to EDT name heuristics (for when caller passes EDT name instead of base type)
  const e = fieldType.toLowerCase();
  if (e === 'recid' || e.endsWith('recid') || e.includes('refrecid')) return 'AxTableFieldInt64';
  if (e.includes('utcdatetime') || (e.includes('datetime') && !e.includes('transdate'))) return 'AxTableFieldUtcDateTime';
  if (e.includes('date') && !e.includes('time') && !e.includes('update')) return 'AxTableFieldDate';
  if (e.includes('amount') || e.includes('mst') || e.includes('price') || e.includes('qty')
      || e.includes('percent') || e === 'real') return 'AxTableFieldReal';
  if (e === 'noyesid' || e.endsWith('noyesid') || e === 'noyes') return 'AxTableFieldEnum';
  if ((e.endsWith('int') || e.includes('count') || e.includes('level'))
      && !e.includes('account') && !e.includes('name')) return 'AxTableFieldInt';

  return 'AxTableFieldString';
}

export const modifyD365FileToolDefinition = {
  name: 'modify_d365fo_file',
  description: '✏️ Edit existing D365FO XML files (AxClass, AxTable, AxForm, etc.). Supports atomic operations: add/remove methods, add/remove fields, modify properties. Use this instead of manual file editing to ensure correct XML structure.',
  inputSchema: ModifyD365FileArgsSchema,
};
