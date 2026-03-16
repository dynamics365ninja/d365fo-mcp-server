/**
 * Modify D365FO File Tool
 * Edit existing D365FO XML files (AxClass, AxTable, AxForm, etc.)
 * Supports atomic operations: add method, add field, modify property
 */

import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { XppServerContext } from '../types/context.js';
import * as fs from 'fs/promises';
import { ensureXppDocComment } from '../utils/xppDocGen.js';
import path from 'path';
import { parseStringPromise, Builder } from 'xml2js';
import { getConfigManager } from '../utils/configManager.js';
import { PackageResolver } from '../utils/packageResolver.js';

/**
 * Decode XML entities from X++ source code.
 *
 * X++ source should never contain entity-encoded characters — `/// <summary>`
 * doc comments, generic types like `List<str>`, and comparison operators like
 * `x < y` all use literal `<` and `>`.  When an AI model copies code from an
 * SSRS report's entity-encoded <Text> block and passes it as `methodCode`, the
 * entities would otherwise survive into the CDATA section and corrupt the source.
 *
 * This function decodes the 5 standard XML entities so that source code always
 * contains proper characters before it is stored in the XML object.
 */
export function decodeXmlEntitiesFromXppSource(source: string): string {
  return source
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&#xD;/g, '');
}

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
  operation: z.enum([
    'add-method', 'remove-method',
    'add-field', 'modify-field', 'rename-field', 'replace-all-fields', 'remove-field',
    'add-index', 'remove-index',
    'add-relation', 'remove-relation',
    'add-field-group', 'remove-field-group', 'add-field-to-field-group',
    'add-field-modification',
    'add-data-source',
    'modify-property',
    'add-control',
  ]).describe('Operation to perform'),

  // For add-control (form-extension only)
  controlName: z.string().optional().describe(
    'Name of the new form control to add inside the form extension. ' +
    'e.g. "MyCustPriorityTier". Used as <Name> inside <FormControl>.'
  ),
  parentControl: z.string().optional().describe(
    'Name of the existing parent control/tab/group in the base form to insert into. ' +
    'e.g. "TabGeneral", "HeaderGroup", "TabPageSales". ' +
    'Becomes the <Parent> element of the AxFormExtensionControl wrapper.'
  ),
  controlDataSource: z.string().optional().describe(
    'Data source name for the new control binding (e.g. "CustTable"). ' +
    'Required when controlDataField is provided.'
  ),
  controlDataField: z.string().optional().describe(
    'Data field name for the new control binding (e.g. "MyCustPriorityTier"). ' +
    'The field must already exist in the table (extension) before adding the UI control.'
  ),
  controlType: z.string().optional().describe(
    'Form control type (default: String). Determines i:type and <Type> in the XML. ' +
    'Supported values: String, Integer, Real, CheckBox, ComboBox, Date, DateTime, Int64, Group, Button, CommandButton, MenuFunctionButton. ' +
    'Use CheckBox for NoYes/boolean fields. Use ComboBox for enum fields. ' +
    'If omitted the tool auto-picks based on the EDT base type if controlDataField is provided.'
  ),
  positionType: z.string().optional().describe(
    'Optional positioning: AfterItem | BeforeItem. Omit to append at the end of the parent.'
  ),
  previousSibling: z.string().optional().describe(
    'Name of the sibling control to position after (used with positionType=AfterItem).'
  ),
  
  // For add-method
  methodName: z.string().optional().describe('Name of method to add/remove'),
  methodCode: z.string().optional().describe(
    'X++ code for the method — either the FULL source (access modifiers + return type + name + params + body) ' +
    'or just the method body. When the full source is provided (first real code line contains an access ' +
    'modifier and the method name followed by "("), it is used as-is. When only a body is provided, ' +
    'the signature is assembled from methodModifiers, methodReturnType, methodName, and methodParameters. ' +
    'Alias: sourceCode (preferred when passing a complete CoC skeleton or full method source).'
  ),
  sourceCode: z.string().optional().describe(
    'Alias for methodCode — pass the FULL X++ method source including access modifiers, return type, ' +
    'method name, parameters, attributes (e.g. [ExtensionOf(...)]), and body. ' +
    'This is the preferred parameter when passing a complete CoC skeleton. ' +
    'Either methodCode or sourceCode may be used; sourceCode takes precedence if both are supplied.'
  ),
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

  // For add-index / remove-index (table, table-extension)
  indexName: z.string().optional().describe('Index name for add-index / remove-index.'),
  indexFields: z.array(z.object({
    fieldName: z.string(),
    direction: z.enum(['Asc', 'Desc']).optional(),
  })).optional().describe('Fields that make up the index. Required for add-index.'),
  indexAllowDuplicates: z.boolean().optional().describe('Whether index allows duplicates (default: false = unique).'),
  indexAlternateKey: z.boolean().optional().describe('Whether index is an alternate key.'),
  indexEnabled: z.boolean().optional().describe('Whether index is enabled (default: true).'),

  // For add-relation / remove-relation (table, table-extension)
  relationName: z.string().optional().describe('Relation name for add-relation / remove-relation.'),
  relatedTable: z.string().optional().describe('Name of the related (foreign key) table.'),
  relationConstraints: z.array(z.object({
    fieldName: z.string().describe('Local field name.'),
    relatedFieldName: z.string().describe('Field name in the related table.'),
  })).optional().describe('Field constraints for the relation (field = relatedField pairs).'),
  relationCardinality: z.string().optional().describe('Cardinality on local side: ZeroMore | ZeroOne | ExactlyOne (default: ZeroMore).'),
  relatedTableCardinality: z.string().optional().describe('Cardinality on related side: ZeroMore | ZeroOne | ExactlyOne (default: ExactlyOne).'),
  relationshipType: z.string().optional().describe('Relationship type: Association | Composition | Aggregation | Link | Specialization (default: Association).'),

  // For add-field-group / remove-field-group / add-field-to-field-group (table, table-extension)
  fieldGroupName: z.string().optional().describe('Field group name. For add-field-to-field-group in a table-extension: name of the group (new or existing base-table group).'),
  fieldGroupFields: z.array(z.string()).optional().describe('Initial field names for add-field-group. Can be empty — add fields later with add-field-to-field-group.'),
  fieldGroupLabel: z.string().optional().describe('Label for add-field-group (optional).'),
  extendBaseFieldGroup: z.boolean().optional().describe(
    'Only for table-extension add-field-to-field-group: when true, adds the field to <FieldGroupExtensions> ' +
    '(extending an existing base-table field group). When false/omitted, adds to <FieldGroups> (a new group defined in the extension).'
  ),

  // For add-field-modification (table-extension only)
  // uses fieldName, fieldLabel, fieldMandatory (already defined above)

  // For add-data-source (form-extension)
  dataSourceName: z.string().optional().describe('Data source reference name for add-data-source (e.g. "MyTable_1").'),
  dataSourceTable: z.string().optional().describe('Base table name for add-data-source (e.g. "MyTable").'),

  // For modify-property
  propertyPath: z.string().optional().describe(
    'Property name to set. ' +
    'For tables (AxTable): TableGroup, TitleField1, TitleField2, TableType (TempDB/RegularTable/InMemory), ' +
    'CacheLookup, ClusteredIndex, PrimaryIndex, SaveDataPerCompany, Label, HelpText, Extends, SystemTable. ' +
    'For table-extensions (AxTableExtension): properties are stored inside <PropertyModifications> as ' +
    '<AxPropertyModification> entries. Supported: Label, HelpText, TableGroup, CacheLookup, TitleField1, TitleField2, ' +
    'ClusteredIndex, PrimaryIndex, SaveDataPerCompany, TableType, SystemTable, ' +
    'ModifiedDateTime (Yes/No), CreatedDateTime (Yes/No), ModifiedBy (Yes/No), CreatedBy (Yes/No), ' +
    'CountryRegionCodes (comma-separated, e.g. "CZ,SK"). ' +
    'For EDTs: Extends, StringSize, Label, HelpText, ReferenceTable, ReferenceField. ' +
    'For classes: Extends, Abstract, Final, Label. ' +
    'For nested properties use dot notation, e.g. "Fields.AxTableField.Name" (rare). ' +
    'Examples: propertyPath="TableGroup" propertyValue="Group"; propertyPath="TitleField1" propertyValue="ItemId"; ' +
    'propertyPath="TableType" propertyValue="TempDB"; propertyPath="Extends" propertyValue="WHSZoneId"; ' +
    'propertyPath="ModifiedDateTime" propertyValue="Yes" (table-extension); ' +
    'propertyPath="CountryRegionCodes" propertyValue="CZ,SK" (table-extension)'
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

      case 'add-control':
        modified = await addControl(xmlObj, objectType, args);
        message = `Added control "${args.controlName}" to ${objectType} "${objectName}" (parent: "${args.parentControl}")`;
        break;

      case 'add-index':
        modified = await addIndex(xmlObj, objectType, args);
        message = `Added index "${args.indexName}" to ${objectType} "${objectName}"`;
        break;

      case 'remove-index':
        modified = await removeIndex(xmlObj, objectType, args);
        message = `Removed index "${args.indexName}" from ${objectType} "${objectName}"`;
        break;

      case 'add-relation':
        modified = await addRelation(xmlObj, objectType, args);
        message = `Added relation "${args.relationName}" to ${objectType} "${objectName}"`;
        break;

      case 'remove-relation':
        modified = await removeRelation(xmlObj, objectType, args);
        message = `Removed relation "${args.relationName}" from ${objectType} "${objectName}"`;
        break;

      case 'add-field-group':
        modified = await addFieldGroup(xmlObj, objectType, args);
        message = `Added field group "${args.fieldGroupName}" to ${objectType} "${objectName}"`;
        break;

      case 'remove-field-group':
        modified = await removeFieldGroup(xmlObj, objectType, args);
        message = `Removed field group "${args.fieldGroupName}" from ${objectType} "${objectName}"`;
        break;

      case 'add-field-to-field-group':
        modified = await addFieldToFieldGroup(xmlObj, objectType, args);
        message = `Added field "${args.fieldName}" to field group "${args.fieldGroupName}" in ${objectType} "${objectName}"`;
        break;

      case 'add-field-modification':
        modified = await addFieldModification(xmlObj, objectType, args);
        message = `Applied field modification for "${args.fieldName}" in ${objectType} "${objectName}"`;
        break;

      case 'add-data-source':
        modified = await addDataSource(xmlObj, objectType, args);
        message = `Added data source reference "${args.dataSourceName}" to ${objectType} "${objectName}"`;
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

    // Write file with UTF-8 BOM — required by D365FO metadata deserializer
    // (same as create_d365fo_file; omitting BOM causes "cannot open/deserialize" in VS)
    const utf8BOM = Buffer.from([0xEF, 0xBB, 0xBF]);
    const xmlBuffer = Buffer.concat([utf8BOM, Buffer.from(newXml, 'utf-8')]);
    await fs.writeFile(actualFilePath, xmlBuffer);

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
    // which are never accessible at runtime.  Relative paths (e.g. "ContosoExt/ContosoExt/AxClass/Foo.xml")
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
 * Infer a meaningful default method body for well-known D365FO override methods.
 *
 * Mirrors the approach used in xppDocGen.ts for doc comments: common D365FO
 * method names map to standard X++ patterns (super() calls, parm accessor
 * pattern, typed return values) so generated code compiles immediately without
 * requiring the developer to fill in boilerplate.
 */
function inferDefaultMethodBody(methodName: string, returnType: string, params: string): string {
  const n = methodName.toLowerCase();
  const ret = (returnType || 'void').toLowerCase();

  // Extract positional parameter names (strip type, default value) for super() forwarding.
  // e.g. "FieldId _fieldId, boolean _showError = true" → "_fieldId, _showError"
  const paramNames = params
    ? params.split(',').map(p => {
        const noDefault = p.indexOf('=') !== -1 ? p.substring(0, p.indexOf('=')).trim() : p.trim();
        const parts = noDefault.split(/\s+/).filter(Boolean);
        return parts[parts.length - 1] ?? '';
      }).filter(Boolean).join(', ')
    : '';

  const superCall    = paramNames ? `super(${paramNames});`        : 'super();';
  const superReturn  = paramNames ? `return super(${paramNames});` : 'return super();';

  // ── D365FO table / form override methods ─────────────────────────────────
  switch (n) {
    // Void overrides — call super and return nothing
    case 'initvalue':
    case 'insert':
    case 'doinsert':
    case 'update':
    case 'doupdate':
    case 'delete':
    case 'dodelete':
    case 'postload':
    case 'reread':
    case 'clear':
    case 'init':
    case 'close':
    case 'run':
    case 'modifiedfield':
    case 'modifiedfieldvalue':
    case 'aosvalidateinsert':
    case 'aosvalidateupdate':
    case 'aosvalidatedelete':
      return superCall;

    // Boolean overrides — return super()
    case 'validatewrite':
    case 'validatedelete':
    case 'validatefield':
    case 'validatefieldvalue':
    case 'cansubmittoworkflow':
      return superReturn;

    // main() — entry point; super() is never called
    case 'main':
      return `${methodName} obj = ${methodName}::construct();\nobj.run();`;

    // construct() — factory method returning a new instance
    case 'construct':
      return `return new ${methodName}();`;
  }

  // ── parm accessor pattern ─────────────────────────────────────────────────
  // parmMyField(str _myField = myField) → { myField = _myField; return myField; }
  if (n.startsWith('parm') && paramNames) {
    const fieldName = methodName.substring(4);
    const fieldVar  = fieldName.charAt(0).toLowerCase() + fieldName.substring(1);
    return `${fieldVar} = ${paramNames};\n    return ${fieldVar};`;
  }

  // ── Return-type based defaults ────────────────────────────────────────────
  switch (ret) {
    case 'boolean': return 'return true;';
    case 'str':
    case 'string':  return 'return "";';
    case 'int':
    case 'integer':
    case 'int64':   return 'return 0;';
    case 'real':    return 'return 0.0;';
    case 'date':    return 'return dateNull();';
    case 'utcdatetime': return 'return DateTimeUtil::minValue();';
    case 'container': return 'return conNull();';
  }

  // Fallback for unknown void methods
  return `// TODO: Implement ${methodName}`;
}

/**
 * Determines whether `code` starts with a complete X++ method signature rather than
 * just a method body.
 *
 * A complete signature has its first real code line (skipping blank lines, doc-comment
 * lines, and attribute lines starting with `[`) containing BOTH:
 *   - an X++ access/type modifier keyword (public, protected, private, static, …)
 *   - the method name immediately followed by `(`
 *
 * This is more reliable than a bare `includes('(')` check, which would also match any
 * function call inside the method body (e.g. `myHelper.compute(value)`) and cause the
 * signature to be omitted from the stored XML.
 */
function hasMethodSignatureLine(code: string, methodName: string): boolean {
  const MODIFIER_RE = /\b(public|protected|private|static|final|abstract|virtual|override|server|client|display|edit)\b/;
  for (const line of code.split('\n')) {
    const t = line.trim();
    // Skip blank lines, comments (// /// /* *), and attribute lines [...]
    if (!t || t.startsWith('//') || t.startsWith('/*') || t.startsWith('*') || t.startsWith('[')) continue;
    // First real code line: must contain an access modifier AND methodName followed by '('
    return MODIFIER_RE.test(t) && t.includes(`${methodName}(`);
  }
  return false;
}

async function addMethod(xmlObj: any, objectType: string, args: any): Promise<boolean> {
  // sourceCode is the canonical parameter name used in copilot instructions;
  // methodCode is the legacy name — accept either, with sourceCode taking precedence.
  const effectiveMethodCode: string | undefined = args.sourceCode ?? args.methodCode;
  const { methodName, methodModifiers, methodReturnType, methodParameters } = args;

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
    root.SourceCode[0].Declaration = [ensureXppDocComment(decodeXmlEntitiesFromXppSource(effectiveMethodCode || ''))];
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

  // Build full method source — if the effective code already contains the signature use it
  // directly, otherwise assemble from methodModifiers / methodReturnType / methodParameters.
  // Decode any XML entities first: AI models may copy entity-encoded text from SSRS report
  // <Text> blocks (e.g. &lt;summary&gt;) and pass it as the code argument. Those entities
  // must be decoded to proper characters so the CDATA section is not corrupted.
  const decodedMethodCode = effectiveMethodCode ? decodeXmlEntitiesFromXppSource(effectiveMethodCode) : undefined;
  let fullSource: string;
  if (decodedMethodCode && hasMethodSignatureLine(decodedMethodCode, methodName)) {
    // Caller passed a complete method (signature + body) — use as-is.
    // hasMethodSignatureLine checks that the first real code line (skipping comments/attributes)
    // contains both an access modifier keyword AND the method name followed by '('.
    // This is more reliable than a bare includes('(') check, which would also match function
    // calls inside the body (e.g. myHelper.compute(value)) and silently omit the signature.
    fullSource = decodedMethodCode;
  } else {
    const modifiers  = methodModifiers  || 'public';
    const retType    = methodReturnType || 'void';
    const params     = methodParameters || '';
    const bodyLines  = decodedMethodCode || inferDefaultMethodBody(methodName, retType, params);
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

  if (objectType !== 'table' && objectType !== 'table-extension') {
    throw new Error('add-field operation is only supported for table and table-extension');
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

  if (objectType !== 'table' && objectType !== 'table-extension') {
    throw new Error('modify-field operation is only supported for table and table-extension');
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
  if (objectType !== 'table' && objectType !== 'table-extension') throw new Error('rename-field operation is only supported for table and table-extension');

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

  // --- Fix FieldGroupExtensions DataField references (table-extension only) ---
  if (objectType === 'table-extension') {
    const fgExts = root.FieldGroupExtensions?.[0]?.AxTableFieldGroupExtension;
    if (fgExts) {
      const extList = Array.isArray(fgExts) ? fgExts : [fgExts];
      for (const ext of extList) {
        const fgFields = ext.Fields?.[0]?.AxTableFieldGroupField;
        if (!Array.isArray(fgFields)) continue;
        for (const fgField of fgFields) {
          const cur = Array.isArray(fgField.DataField) ? fgField.DataField[0] : fgField.DataField;
          if (cur === fieldName) fgField.DataField = [fieldNewName];
        }
      }
    }
  }

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
  if (objectType !== 'table' && objectType !== 'table-extension') throw new Error('replace-all-fields operation is only supported for table and table-extension');

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
          if (mapped) fgField.DataField = [mapped];
        }
      }
    }

    // Repair FieldGroupExtensions DataField references (table-extension only)
    if (objectType === 'table-extension') {
      const fgExts = root.FieldGroupExtensions?.[0]?.AxTableFieldGroupExtension;
      if (fgExts) {
        const extList = Array.isArray(fgExts) ? fgExts : [fgExts];
        for (const ext of extList) {
          const fgFields = ext.Fields?.[0]?.AxTableFieldGroupField;
          if (!Array.isArray(fgFields)) continue;
          for (const fgField of fgFields) {
            const cur = Array.isArray(fgField.DataField) ? fgField.DataField[0] : fgField.DataField;
            const mapped = cur ? oldToNew.get(cur) : undefined;
            if (mapped) fgField.DataField = [mapped];
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

  if (objectType !== 'table' && objectType !== 'table-extension') {
    throw new Error('remove-field operation is only supported for table and table-extension');
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

  // Also remove any FieldGroup references that point to the deleted field.
  // Without this, D365FO shows build errors: "Field referenced in FieldGroup not found."
  const fgGroups = root.FieldGroups?.[0]?.AxTableFieldGroup;
  if (Array.isArray(fgGroups)) {
    for (const group of fgGroups) {
      const fgFields = group.Fields?.[0]?.AxTableFieldGroupField;
      if (Array.isArray(fgFields)) {
        group.Fields[0].AxTableFieldGroupField = fgFields.filter((entry: any) => {
          const df = Array.isArray(entry.DataField) ? entry.DataField[0] : entry.DataField;
          return df !== fieldName;
        });
      }
    }
  }

  // Also remove from FieldGroupExtensions (table-extension only)
  if (objectType === 'table-extension') {
    const fgExts = root.FieldGroupExtensions?.[0]?.AxTableFieldGroupExtension;
    if (Array.isArray(fgExts)) {
      for (const ext of fgExts) {
        const fgFields = ext.Fields?.[0]?.AxTableFieldGroupField;
        if (Array.isArray(fgFields)) {
          ext.Fields[0].AxTableFieldGroupField = fgFields.filter((entry: any) => {
            const df = Array.isArray(entry.DataField) ? entry.DataField[0] : entry.DataField;
            return df !== fieldName;
          });
        }
      }
    }
  }

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

  // ── table-extension: properties live inside <PropertyModifications> ───────────────────────────
  // AxTableExtension does NOT expose top-level property elements like AxTable does.
  // Instead all table-level overrides are stored as:
  //   <PropertyModifications>
  //     <AxPropertyModification>
  //       <Name>Label</Name>
  //       <Value>@MyModel:MyLabel</Value>
  //     </AxPropertyModification>
  //   </PropertyModifications>
  //
  // Supported property names (case-sensitive, matching AOT XML exactly):
  //   Label, HelpText, TableGroup, CacheLookup, TitleField1, TitleField2,
  //   ClusteredIndex, PrimaryIndex, SaveDataPerCompany, TableType, SystemTable,
  //   ModifiedDateTime, CreatedDateTime, ModifiedBy, CreatedBy, CountryRegionCodes
  if (objectType === 'table-extension') {
    const rootKey = getRootKey(objectType); // 'AxTableExtension'
    const root = xmlObj[rootKey];
    if (!root) {
      throw new Error(`Invalid XML structure: root element <${rootKey}> not found`);
    }

    // Ensure <PropertyModifications> container exists.
    // xml2js parses <PropertyModifications /> as [''] — must treat as empty.
    const rawPM = root.PropertyModifications;
    const pmEmpty =
      !rawPM ||
      rawPM === '' ||
      (Array.isArray(rawPM) && (rawPM.length === 0 || rawPM[0] === '' || rawPM[0] == null));
    if (pmEmpty) {
      root.PropertyModifications = [{ AxPropertyModification: [] }];
    }
    const pmContainer = Array.isArray(root.PropertyModifications)
      ? root.PropertyModifications[0]
      : root.PropertyModifications;

    if (!pmContainer.AxPropertyModification) {
      pmContainer.AxPropertyModification = [];
    } else if (!Array.isArray(pmContainer.AxPropertyModification)) {
      // Single existing entry parsed as object, not 1-element array
      pmContainer.AxPropertyModification = [pmContainer.AxPropertyModification];
    }

    // Update existing entry or append a new one
    const existing = (pmContainer.AxPropertyModification as any[]).find(
      (m: any) => m.Name && m.Name[0] === propertyPath
    );
    if (existing) {
      existing.Value = [propertyValue];
    } else {
      pmContainer.AxPropertyModification.push({
        Name: [propertyPath],
        Value: [propertyValue],
      });
    }

    return true;
  }

  // Special case: changing the base type of an EDT (i:type XML attribute on the root element).
  // Accepted aliases: BaseType / i:type / edtType — all map to the same XML attribute.
  const edtTypeAliases = new Set(['basetype', 'i:type', 'edttype']);
  if (objectType === 'edt' && edtTypeAliases.has(propertyPath.toLowerCase())) {
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
    const normalizedValue = edtTypeNormMap[propertyValue.toLowerCase()] ?? propertyValue;
    const rootKey = getRootKey(objectType);
    const root = xmlObj[rootKey];
    if (!root) {
      throw new Error(`Invalid XML structure: root element <${rootKey}> not found`);
    }
    if (!root['$']) {
      root['$'] = {};
    }
    root['$']['i:type'] = normalizedValue;
    // Also update StringSize presence: AxEdtString needs it, others should not have it
    if (normalizedValue !== 'AxEdtString') {
      delete root['StringSize'];
    }
    return true;
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
 * Control type → { iType, xmlType } mapping.
 * iType   = value for i:type attribute on <FormControl>
 * xmlType = value for <Type> element inside <FormControl>
 */
function resolveControlTypeAttrs(controlType: string): { iType: string; xmlType: string } {
  const t = controlType.trim();
  // Allow passing the full i:type value like "AxFormStringControl"
  const stripped = t.startsWith('AxForm') && t.endsWith('Control')
    ? t.slice('AxForm'.length, -'Control'.length)
    : t;
  const map: Record<string, { iType: string; xmlType: string }> = {
    String:            { iType: 'AxFormStringControl',          xmlType: 'String' },
    Integer:           { iType: 'AxFormIntControl',             xmlType: 'Integer' },
    Int:               { iType: 'AxFormIntControl',             xmlType: 'Integer' },
    Int64:             { iType: 'AxFormInt64Control',           xmlType: 'Int64' },
    Real:              { iType: 'AxFormRealControl',            xmlType: 'Real' },
    CheckBox:          { iType: 'AxFormCheckBoxControl',        xmlType: 'CheckBox' },
    ComboBox:          { iType: 'AxFormComboBoxControl',        xmlType: 'ComboBox' },
    Date:              { iType: 'AxFormDateControl',            xmlType: 'Date' },
    DateTime:          { iType: 'AxFormDateTimeControl',        xmlType: 'DateTime' },
    UtcDateTime:       { iType: 'AxFormDateTimeControl',        xmlType: 'DateTime' },
    Group:             { iType: 'AxFormGroupControl',           xmlType: 'Group' },
    Button:            { iType: 'AxFormButtonControl',          xmlType: 'Button' },
    CommandButton:     { iType: 'AxFormCommandButtonControl',   xmlType: 'CommandButton' },
    MenuFunctionButton:{ iType: 'AxFormMenuFunctionButtonControl', xmlType: 'MenuFunctionButton' },
    ButtonGroup:       { iType: 'AxFormButtonGroupControl',     xmlType: 'ButtonGroup' },
    Tab:               { iType: 'AxFormTabControl',             xmlType: 'Tab' },
    TabPage:           { iType: 'AxFormTabPageControl',         xmlType: 'TabPage' },
    Grid:              { iType: 'AxFormGridControl',            xmlType: 'Grid' },
  };
  return map[stripped] ?? { iType: `AxForm${stripped}Control`, xmlType: stripped };
}

/**
 * Add a UI control to a form extension (AxFormExtension only).
 * Creates an <AxFormExtensionControl> entry with the new <FormControl> nested inside
 * and <Parent> pointing to the existing parent control in the base form.
 */
async function addControl(xmlObj: any, objectType: string, args: any): Promise<boolean> {
  if (objectType !== 'form-extension') {
    throw new Error('add-control is only supported for form-extension objects');
  }

  const { controlName, parentControl, controlDataSource, controlDataField,
          controlType, positionType, previousSibling } = args;

  if (!controlName) throw new Error('controlName is required for add-control operation');
  if (!parentControl) throw new Error('parentControl is required for add-control operation');

  // Resolve control type attributes
  const typeStr = controlType || 'String';
  const { iType, xmlType } = resolveControlTypeAttrs(typeStr);

  const root = xmlObj['AxFormExtension'];
  if (!root) throw new Error('Invalid XML structure: root element <AxFormExtension> not found');

  // Ensure <Controls> container exists
  const rawControls = root.Controls;
  const controlsEmpty =
    !rawControls ||
    rawControls === '' ||
    (Array.isArray(rawControls) && (rawControls.length === 0 || rawControls[0] === '' || rawControls[0] == null));
  if (controlsEmpty) {
    root.Controls = [{ AxFormExtensionControl: [] }];
  }
  const controlsContainer = Array.isArray(root.Controls) ? root.Controls[0] : root.Controls;

  if (!controlsContainer.AxFormExtensionControl) {
    controlsContainer.AxFormExtensionControl = [];
  } else if (!Array.isArray(controlsContainer.AxFormExtensionControl)) {
    controlsContainer.AxFormExtensionControl = [controlsContainer.AxFormExtensionControl];
  }

  // Build the inner <FormControl> object.
  // D365FO requires xmlns="" and i:type on the FormControl element.
  const formControl: any = {
    '$': { xmlns: '', 'i:type': iType },
    Name: [controlName],
    FilterExpression: ['%1'],
    Type: [xmlType],
    VerticalSpacing: ['-1'],
    FormControlExtension: [{ '$': { 'i:nil': 'true' } }],
  };

  if (controlDataField) formControl.DataField = [controlDataField];
  if (controlDataSource) formControl.DataSource = [controlDataSource];

  // Build the generated wrapper name (unique per control)
  const wrapperName = `FormExtensionControl${controlName}1`;

  // Build the AxFormExtensionControl wrapper
  const wrapper: any = {
    '$': { xmlns: '' },
    Name: [wrapperName],
    FormControl: [formControl],
    Parent: [parentControl],
  };

  if (positionType) wrapper.PositionType = [positionType];
  if (previousSibling) wrapper.PreviousSibling = [previousSibling];

  controlsContainer.AxFormExtensionControl.push(wrapper);
  return true;
}

// ─── Helper: ensure array container ─────────────────────────────────────────
function ensureArrayContainer(root: any, key: string, childKey: string): any {
  const raw = root[key];
  const isEmpty =
    !raw || raw === '' ||
    (Array.isArray(raw) && (raw.length === 0 || raw[0] === '' || raw[0] == null));
  if (isEmpty) {
    root[key] = [{ [childKey]: [] }];
  }
  const container = Array.isArray(root[key]) ? root[key][0] : root[key];
  if (!container[childKey]) {
    container[childKey] = [];
  } else if (!Array.isArray(container[childKey])) {
    container[childKey] = [container[childKey]];
  }
  return container;
}

/**
 * Add an index to a table or table-extension.
 */
async function addIndex(xmlObj: any, objectType: string, args: any): Promise<boolean> {
  if (objectType !== 'table' && objectType !== 'table-extension') {
    throw new Error('add-index is only supported for table and table-extension');
  }
  const { indexName, indexFields, indexAllowDuplicates, indexAlternateKey, indexEnabled } = args;
  if (!indexName) throw new Error('indexName is required for add-index');
  if (!indexFields || (indexFields as any[]).length === 0) throw new Error('indexFields is required for add-index');

  const root = xmlObj[getRootKey(objectType)];
  if (!root) throw new Error(`Invalid XML structure: root element <${getRootKey(objectType)}> not found`);

  const container = ensureArrayContainer(root, 'Indexes', 'AxTableIndex');

  const indexFieldNodes = (indexFields as Array<{ fieldName: string; direction?: string }>).map(f => {
    const node: any = { DataField: [f.fieldName] };
    if (f.direction) node.Direction = [f.direction];
    return node;
  });

  const newIndex: any = {
    Name: [indexName],
    Fields: [{ AxTableIndexField: indexFieldNodes }],
  };
  if (indexAllowDuplicates !== undefined) newIndex.AllowDuplicates = [indexAllowDuplicates ? 'Yes' : 'No'];
  if (indexAlternateKey !== undefined) newIndex.AlternateKey = [indexAlternateKey ? 'Yes' : 'No'];
  if (indexEnabled === false) newIndex.Enabled = ['No'];

  container.AxTableIndex.push(newIndex);
  return true;
}

/**
 * Remove an index from a table or table-extension.
 */
async function removeIndex(xmlObj: any, objectType: string, args: any): Promise<boolean> {
  if (objectType !== 'table' && objectType !== 'table-extension') {
    throw new Error('remove-index is only supported for table and table-extension');
  }
  const { indexName } = args;
  if (!indexName) throw new Error('indexName is required for remove-index');

  const root = xmlObj[getRootKey(objectType)];
  if (!root) throw new Error(`Invalid XML structure: root element <${getRootKey(objectType)}> not found`);

  const raw = root.Indexes;
  const isEmpty = !raw || raw === '' || (Array.isArray(raw) && (raw.length === 0 || raw[0] === '' || raw[0] == null));
  if (isEmpty) throw new Error('No indexes found');

  const container = Array.isArray(root.Indexes) ? root.Indexes[0] : root.Indexes;
  if (!Array.isArray(container.AxTableIndex)) {
    container.AxTableIndex = container.AxTableIndex ? [container.AxTableIndex] : [];
  }
  const idx = container.AxTableIndex.findIndex((i: any) => (Array.isArray(i.Name) ? i.Name[0] : i.Name) === indexName);
  if (idx === -1) throw new Error(`Index "${indexName}" not found`);
  container.AxTableIndex.splice(idx, 1);
  return true;
}

/**
 * Add a relation to a table or table-extension.
 */
async function addRelation(xmlObj: any, objectType: string, args: any): Promise<boolean> {
  if (objectType !== 'table' && objectType !== 'table-extension') {
    throw new Error('add-relation is only supported for table and table-extension');
  }
  const {
    relationName, relatedTable, relationConstraints,
    relationCardinality, relatedTableCardinality, relationshipType,
  } = args;
  if (!relationName) throw new Error('relationName is required for add-relation');
  if (!relatedTable) throw new Error('relatedTable is required for add-relation');

  const root = xmlObj[getRootKey(objectType)];
  if (!root) throw new Error(`Invalid XML structure: root element <${getRootKey(objectType)}> not found`);

  const container = ensureArrayContainer(root, 'Relations', 'AxTableRelation');

  const constraintNodes = ((relationConstraints || []) as Array<{ fieldName: string; relatedFieldName: string }>).map(c => ({
    '$': { xmlns: '', 'i:type': 'AxTableRelationConstraintField' },
    Name: [c.fieldName],
    Field: [c.fieldName],
    RelatedField: [c.relatedFieldName],
  }));

  const newRelation: any = {
    Name: [relationName],
    Cardinality: [relationCardinality || 'ZeroMore'],
    RelatedTable: [relatedTable],
    RelatedTableCardinality: [relatedTableCardinality || 'ExactlyOne'],
    RelationshipType: [relationshipType || 'Association'],
    Constraints: constraintNodes.length > 0 ? [{ AxTableRelationConstraint: constraintNodes }] : [''],
  };

  container.AxTableRelation.push(newRelation);
  return true;
}

/**
 * Remove a relation from a table or table-extension.
 */
async function removeRelation(xmlObj: any, objectType: string, args: any): Promise<boolean> {
  if (objectType !== 'table' && objectType !== 'table-extension') {
    throw new Error('remove-relation is only supported for table and table-extension');
  }
  const { relationName } = args;
  if (!relationName) throw new Error('relationName is required for remove-relation');

  const root = xmlObj[getRootKey(objectType)];
  if (!root) throw new Error(`Invalid XML structure: root element <${getRootKey(objectType)}> not found`);

  const raw = root.Relations;
  const isEmpty = !raw || raw === '' || (Array.isArray(raw) && (raw.length === 0 || raw[0] === '' || raw[0] == null));
  if (isEmpty) throw new Error('No relations found');

  const container = Array.isArray(root.Relations) ? root.Relations[0] : root.Relations;
  if (!Array.isArray(container.AxTableRelation)) {
    container.AxTableRelation = container.AxTableRelation ? [container.AxTableRelation] : [];
  }
  const idx = container.AxTableRelation.findIndex((r: any) => (Array.isArray(r.Name) ? r.Name[0] : r.Name) === relationName);
  if (idx === -1) throw new Error(`Relation "${relationName}" not found`);
  container.AxTableRelation.splice(idx, 1);
  return true;
}

/**
 * Add a field group to a table or table-extension.
 */
async function addFieldGroup(xmlObj: any, objectType: string, args: any): Promise<boolean> {
  if (objectType !== 'table' && objectType !== 'table-extension') {
    throw new Error('add-field-group is only supported for table and table-extension');
  }
  const { fieldGroupName, fieldGroupFields, fieldGroupLabel } = args;
  if (!fieldGroupName) throw new Error('fieldGroupName is required for add-field-group');

  const root = xmlObj[getRootKey(objectType)];
  if (!root) throw new Error(`Invalid XML structure: root element <${getRootKey(objectType)}> not found`);

  const container = ensureArrayContainer(root, 'FieldGroups', 'AxTableFieldGroup');

  const fgFieldNodes = ((fieldGroupFields || []) as string[]).map((f: string) => ({ DataField: [f] }));

  const newFg: any = {
    Name: [fieldGroupName],
    Fields: fgFieldNodes.length > 0 ? [{ AxTableFieldGroupField: fgFieldNodes }] : [''],
  };
  if (fieldGroupLabel) newFg.Label = [fieldGroupLabel];

  container.AxTableFieldGroup.push(newFg);
  return true;
}

/**
 * Remove a field group from a table or table-extension.
 */
async function removeFieldGroup(xmlObj: any, objectType: string, args: any): Promise<boolean> {
  if (objectType !== 'table' && objectType !== 'table-extension') {
    throw new Error('remove-field-group is only supported for table and table-extension');
  }
  const { fieldGroupName } = args;
  if (!fieldGroupName) throw new Error('fieldGroupName is required for remove-field-group');

  const root = xmlObj[getRootKey(objectType)];
  if (!root) throw new Error(`Invalid XML structure: root element <${getRootKey(objectType)}> not found`);

  const raw = root.FieldGroups;
  const isEmpty = !raw || raw === '' || (Array.isArray(raw) && (raw.length === 0 || raw[0] === '' || raw[0] == null));
  if (isEmpty) throw new Error('No field groups found');

  const container = Array.isArray(root.FieldGroups) ? root.FieldGroups[0] : root.FieldGroups;
  if (!Array.isArray(container.AxTableFieldGroup)) {
    container.AxTableFieldGroup = container.AxTableFieldGroup ? [container.AxTableFieldGroup] : [];
  }
  const idx = container.AxTableFieldGroup.findIndex((fg: any) => (Array.isArray(fg.Name) ? fg.Name[0] : fg.Name) === fieldGroupName);
  if (idx === -1) throw new Error(`Field group "${fieldGroupName}" not found`);
  container.AxTableFieldGroup.splice(idx, 1);
  return true;
}

/**
 * Add a field to an existing field group (or extend a base-table field group via FieldGroupExtensions).
 * For table-extension with extendBaseFieldGroup=true: targets <FieldGroupExtensions>.
 * Otherwise: targets <FieldGroups> (both table and table-extension).
 */
async function addFieldToFieldGroup(xmlObj: any, objectType: string, args: any): Promise<boolean> {
  if (objectType !== 'table' && objectType !== 'table-extension') {
    throw new Error('add-field-to-field-group is only supported for table and table-extension');
  }
  const { fieldGroupName, fieldName, extendBaseFieldGroup } = args;
  if (!fieldGroupName) throw new Error('fieldGroupName is required for add-field-to-field-group');
  if (!fieldName) throw new Error('fieldName is required for add-field-to-field-group');

  const root = xmlObj[getRootKey(objectType)];
  if (!root) throw new Error(`Invalid XML structure: root element <${getRootKey(objectType)}> not found`);

  if (objectType === 'table-extension' && extendBaseFieldGroup) {
    // Target FieldGroupExtensions — adds a field to a base-table field group
    const container = ensureArrayContainer(root, 'FieldGroupExtensions', 'AxTableFieldGroupExtension');
    let ext = container.AxTableFieldGroupExtension.find(
      (e: any) => (Array.isArray(e.Name) ? e.Name[0] : e.Name) === fieldGroupName
    );
    if (!ext) {
      ext = { Name: [fieldGroupName], Fields: [{ AxTableFieldGroupField: [] }] };
      container.AxTableFieldGroupExtension.push(ext);
    }
    // Ensure Fields container
    const rawF = ext.Fields;
    const fEmpty = !rawF || rawF === '' || (Array.isArray(rawF) && (rawF.length === 0 || rawF[0] === '' || rawF[0] == null));
    if (fEmpty) ext.Fields = [{ AxTableFieldGroupField: [] }];
    const fc = Array.isArray(ext.Fields) ? ext.Fields[0] : ext.Fields;
    if (!fc.AxTableFieldGroupField) fc.AxTableFieldGroupField = [];
    else if (!Array.isArray(fc.AxTableFieldGroupField)) fc.AxTableFieldGroupField = [fc.AxTableFieldGroupField];
    fc.AxTableFieldGroupField.push({ DataField: [fieldName] });
    return true;
  }

  // Target FieldGroups (new group defined in this object)
  const raw = root.FieldGroups;
  const isEmpty = !raw || raw === '' || (Array.isArray(raw) && (raw.length === 0 || raw[0] === '' || raw[0] == null));
  if (isEmpty) throw new Error('No FieldGroups found. Create a group first with add-field-group.');

  const container = Array.isArray(root.FieldGroups) ? root.FieldGroups[0] : root.FieldGroups;
  if (!Array.isArray(container.AxTableFieldGroup)) {
    container.AxTableFieldGroup = container.AxTableFieldGroup ? [container.AxTableFieldGroup] : [];
  }
  const fg = container.AxTableFieldGroup.find(
    (g: any) => (Array.isArray(g.Name) ? g.Name[0] : g.Name) === fieldGroupName
  );
  if (!fg) throw new Error(`Field group "${fieldGroupName}" not found. Create it first with add-field-group.`);

  const rawF = fg.Fields;
  const fEmpty = !rawF || rawF === '' || (Array.isArray(rawF) && (rawF.length === 0 || rawF[0] === '' || rawF[0] == null));
  if (fEmpty) fg.Fields = [{ AxTableFieldGroupField: [] }];
  const fc = Array.isArray(fg.Fields) ? fg.Fields[0] : fg.Fields;
  if (!fc.AxTableFieldGroupField) fc.AxTableFieldGroupField = [];
  else if (!Array.isArray(fc.AxTableFieldGroupField)) fc.AxTableFieldGroupField = [fc.AxTableFieldGroupField];

  fc.AxTableFieldGroupField.push({ DataField: [fieldName] });
  return true;
}

/**
 * Add or update a FieldModification entry in a table-extension.
 * Use this to change properties (label, mandatory) of a field that exists in the base table.
 */
async function addFieldModification(xmlObj: any, objectType: string, args: any): Promise<boolean> {
  if (objectType !== 'table-extension') {
    throw new Error('add-field-modification is only supported for table-extension');
  }
  const { fieldName, fieldLabel, fieldMandatory } = args;
  if (!fieldName) throw new Error('fieldName is required for add-field-modification');
  if (fieldLabel === undefined && fieldMandatory === undefined) {
    throw new Error('At least one of fieldLabel or fieldMandatory is required for add-field-modification');
  }

  const root = xmlObj['AxTableExtension'];
  if (!root) throw new Error('Invalid XML structure: root element <AxTableExtension> not found');

  const container = ensureArrayContainer(root, 'FieldModifications', 'AxTableFieldModification');

  let fm = container.AxTableFieldModification.find(
    (m: any) => (Array.isArray(m.Name) ? m.Name[0] : m.Name) === fieldName
  );
  if (!fm) {
    fm = { Name: [fieldName] };
    container.AxTableFieldModification.push(fm);
  }
  if (fieldLabel !== undefined) fm.Label = [fieldLabel];
  if (fieldMandatory !== undefined) fm.Mandatory = [fieldMandatory ? 'Yes' : 'No'];

  return true;
}

/**
 * Add a data source reference to a form-extension.
 * Creates an <AxFormDataSourceReference> entry in <DataSourceReferences>.
 */
async function addDataSource(xmlObj: any, objectType: string, args: any): Promise<boolean> {
  if (objectType !== 'form-extension') {
    throw new Error('add-data-source is only supported for form-extension');
  }
  const { dataSourceName, dataSourceTable } = args;
  if (!dataSourceName) throw new Error('dataSourceName is required for add-data-source');
  if (!dataSourceTable) throw new Error('dataSourceTable is required for add-data-source');

  const root = xmlObj['AxFormExtension'];
  if (!root) throw new Error('Invalid XML structure: root element <AxFormExtension> not found');

  const container = ensureArrayContainer(root, 'DataSourceReferences', 'AxFormDataSourceReference');

  container.AxFormDataSourceReference.push({
    '$': { xmlns: '' },
    Name: [dataSourceName],
    DataSource: [dataSourceTable],
  });
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
  description:
    '✏️ Edit existing D365FO XML files (AxClass, AxTable, AxTableExtension, AxForm, AxFormExtension, etc.). ' +
    'Supports atomic operations:\n' +
    '• Methods: add-method, remove-method (table, form, class, table-extension, class-extension)\n' +
    '• Fields: add-field, modify-field, rename-field, replace-all-fields, remove-field (table, table-extension)\n' +
    '• Indexes: add-index, remove-index (table, table-extension)\n' +
    '• Relations: add-relation, remove-relation (table, table-extension)\n' +
    '• Field groups: add-field-group, remove-field-group, add-field-to-field-group (table, table-extension)\n' +
    '• Table-extension only: add-field-modification (modify base-table field label/mandatory)\n' +
    '• Form-extension: add-control (UI control), add-data-source (DataSourceReference)\n' +
    '• Any object: modify-property\n' +
    'Always prefer this tool over replace_string_in_file for XML edits.',
  inputSchema: ModifyD365FileArgsSchema,
};
