/**
 * Modify D365FO File Tool
 * Edit existing D365FO XML files (AxClass, AxTable, AxForm, etc.)
 * Supports atomic operations: add method, add field, modify property
 */

import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { XppServerContext } from '../types/context.js';
import * as fs from 'fs/promises';

import path from 'path';
import { parseStringPromise } from 'xml2js';
import { getConfigManager, fallbackPackagePath, extractModelFromFilePath } from '../utils/configManager.js';
import { isStandardModel } from '../utils/modelClassifier.js';
import { PackageResolver } from '../utils/packageResolver.js';
import { resolveDbPathLocally } from '../utils/metadataResolver.js';
import { assertWritePathAllowed } from '../utils/pathContainment.js';
import {
  bridgeValidateAfterWrite, canBridgeModify,
  bridgeAddMethod, bridgeRemoveMethod, bridgeAddField, bridgeSetProperty, bridgeReplaceCode,
  bridgeModifyField, bridgeRenameField, bridgeRemoveField, bridgeReplaceAllFields,
  bridgeAddIndex, bridgeRemoveIndex, bridgeAddRelation, bridgeRemoveRelation,
  bridgeAddFieldGroup, bridgeRemoveFieldGroup, bridgeAddFieldToFieldGroup,
  bridgeAddEnumValue, bridgeModifyEnumValue, bridgeRemoveEnumValue,
  bridgeAddControl, bridgeAddDataSource,
  bridgeAddFieldModification, bridgeAddMenuItemToMenu,
} from '../bridge/index.js';
import { invalidateCache } from './updateSymbolIndex.js';
import { ProjectFileManager, ProjectFileFinder } from './createD365File.js';

/**
 * Decode the standard XML entities (&lt;, &gt;, &apos;, &quot;, &amp;) and normalise
 * line endings by stripping xml2js's &#xD; representation of carriage return.
 *
 * IMPORTANT: &amp; is decoded LAST so that sequences like `&amp;quot;` are first
 * turned into `&quot;` and can then, if desired, be decoded to `"`, avoiding
 * incorrect double-unescaping.
 */
function decodeStandardXmlEntities(source: string): string {
  return source
    // xml2js Builder escapes \r as &#xD; — strip it to normalise to LF-only line endings
    .replace(/&#xD;/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');
}

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
  return decodeStandardXmlEntities(source);
}

/**
 * Direct XML file-level replace-code fallback.
 * Used when the C# bridge fails or returns null for replace-code on forms/form-extensions
 * (e.g. control override methods that the SDK doesn't expose via the Methods API).
 *
 * Reads the XML file, performs a simple string replacement inside <Source> CDATA blocks,
 * and writes the file back. This is a last-resort fallback — the bridge is always preferred.
 */
async function directXmlReplaceCode(
  filePath: string,
  oldCode: string,
  newCode: string,
): Promise<{ success: boolean; message: string } | null> {
  try {
    // Read as Buffer to detect and preserve UTF-8 BOM (D365FO XML files use BOM)
    const buf = await fs.readFile(filePath);
    const hasBom = buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF;
    const content = buf.toString('utf-8');

    if (!content.includes(oldCode)) {
      return null; // oldCode not found in file at all
    }

    // Ensure there is exactly one occurrence so we replace the correct block.
    // String.prototype.replace() without /g only replaces the FIRST occurrence,
    // which would silently leave other occurrences and produce ambiguous results.
    const occurrences = content.split(oldCode).length - 1;
    if (occurrences > 1) {
      return {
        success: false,
        message: `❌ directXmlReplaceCode: oldCode appears ${occurrences} times in ${filePath} — replacement is ambiguous. Provide a more specific oldCode snippet.`,
      };
    }

    const updated = content.replace(oldCode, newCode);
    if (updated === content) {
      return null; // no change made
    }

    // Preserve BOM if it was present: Node's utf-8 encoding strips BOM on read
    // but '\uFEFF' prefix restores it on write.
    const bomPrefix = hasBom && !updated.startsWith('\uFEFF') ? '\uFEFF' : '';
    await fs.writeFile(filePath, bomPrefix + updated, 'utf-8');
    console.error(`[modify_d365fo_file] ✅ directXmlReplaceCode fallback: replaced in ${filePath}`);
    return {
      success: true,
      message: `✅ Code replaced via direct XML fallback (bridge was unavailable). File: ${filePath}`,
    };
  } catch (err) {
    console.error(`[modify_d365fo_file] directXmlReplaceCode failed: ${err}`);
    return null;
  }
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
    'add-method', 'remove-method', 'replace-code',
    'add-field', 'modify-field', 'rename-field', 'replace-all-fields', 'remove-field',
    'add-index', 'remove-index',
    'add-relation', 'remove-relation',
    'add-field-group', 'remove-field-group', 'add-field-to-field-group',
    'add-field-modification',
    'add-data-source',
    'modify-property',
    'add-control',
    'add-enum-value', 'modify-enum-value', 'remove-enum-value',
    'add-display-method', 'add-table-method', 'add-menu-item-to-menu',
  ]).describe(
    'Operation to perform. ' +
    'replace-code REQUIRES parameters: oldCode (exact code to find) + newCode (replacement). ' +
    'add-method REQUIRES: methodName + sourceCode. ' +
    'For form control override methods with replace-code, use methodName="ControlName.methodName" (e.g. "PostButton.clicked").'
  ),

  // For add-enum-value / modify-enum-value / remove-enum-value
  enumValueName: z.string().optional().describe(
    'Enum value name for add-enum-value / modify-enum-value / remove-enum-value. ' +
    'E.g. "Approved", "Pending", "Rejected".'
  ),
  enumValueLabel: z.string().optional().describe(
    'Label reference for the enum value (e.g. "@MyModel:Approved"). ' +
    'Used with add-enum-value and modify-enum-value.'
  ),
  enumValueHelpText: z.string().optional().describe(
    'Help text reference for the enum value (e.g. "@MyModel:ApprovedHelp"). Optional.'
  ),
  enumValueInt: z.number().optional().describe(
    'Explicit integer value for the enum value. ' +
    'If omitted for add-enum-value, the next available value is assigned automatically. ' +
    'Use with modify-enum-value to change the integer value (rare — may break existing data).'
  ),

  // For add-display-method
  displayMethodReturnEdt: z.string().optional().describe(
    'EDT or type name the display method returns, e.g. "Name", "AmountMST", "SalesStatus". ' +
    'Used with add-display-method to set the return type automatically.'
  ),

  // For add-table-method
  tableMethodType: z.enum(['find', 'exist', 'findByRecId', 'validateWrite', 'validateDelete', 'initValue']).optional().describe(
    'Standard table method pattern to generate. Used with add-table-method. ' +
    'find: returns a single record by key field. exist: returns true/false. ' +
    'findByRecId: returns record by RecId. validateWrite/validateDelete/initValue: standard overrides.'
  ),
  tableKeyField: z.string().optional().describe(
    'Name of the primary key field for find/exist patterns (e.g. "ItemId", "SalesId"). ' +
    'Used with add-table-method when tableMethodType is find or exist.'
  ),

  // For add-menu-item-to-menu
  menuItemToAdd: z.string().optional().describe(
    'Name of the menu item to add (e.g. "MyCustomForm"). Used with add-menu-item-to-menu.'
  ),
  menuItemToAddType: z.enum(['display', 'action', 'output']).optional().describe(
    'Type of menu item to add: display (form), action (class), output (report). ' +
    'Used with add-menu-item-to-menu. Defaults to display.'
  ),

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
  baseFormName: z.string().optional().describe(
    'Base form name used for auto-resolving parentControl when the extension name does not contain it. ' +
    'E.g. if objectName="SalesOrder.MyExt" the base form is auto-detected as "SalesOrder". ' +
    'Pass this only when auto-detection fails (e.g. the extension has a non-standard name).'
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
  // For replace-code (REQUIRED for operation="replace-code" — do NOT use sourceCode for this)
  oldCode: z.string().optional().describe(
    'REQUIRED for replace-code. Exact existing X++ code snippet to find and replace. ' +
    'Must match the source text exactly (leading/trailing whitespace is trimmed for matching). ' +
    'If methodName is also provided the search is scoped to that method\'s Source block only. ' +
    'For form control override methods, use methodName="ControlName.methodName" (e.g. "PostButton.clicked").'
  ),
  newCode: z.string().optional().describe(
    'REQUIRED for replace-code. Replacement X++ code snippet. ' +
    'Replaces the first occurrence of oldCode in the target source block. ' +
    'Pass empty string "" to delete the matched oldCode snippet.'
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
  addToProject: z.boolean().optional().default(false).describe(
    'When true, adds the modified file to the Visual Studio project (.rnrproj). ' +
    'Use this when the file exists on disk but is not yet tracked in the VS project. ' +
    'Requires projectPath or solutionPath (explicit or via .mcp.json). Default: false.'
  ),
  projectPath: z.string().optional().describe(
    'Path to .rnrproj file. Required for addToProject to work. Auto-detected from .mcp.json if omitted.'
  ),
  solutionPath: z.string().optional().describe(
    'Path to VS solution directory. Used to find .rnrproj when projectPath is not given.'
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

    // ── Auto-resolve parentControl for add-control on form-extension ─────────
    // When `parentControl` is a fuzzy / lowercase string (e.g. "general"), look
    // up the base form XML, walk the control tree, and resolve to the exact name.
    // This makes add-control seamless — no prior get_form_info call required.
    let addControlNote = '';
    if (operation === 'add-control' && objectType === 'form-extension' && args.parentControl) {
      const resolution = await resolveParentControl(
        objectName,
        args.parentControl,
        symbolIndex,
        (args as any).baseFormName,
      );

      if (resolution && 'multiple' in resolution) {
        const candidateList = resolution.multiple
          .slice(0, 20)
          .map(c =>
            `  • \`${c.name}\`` +
            (c.parentName ? ` (parent: \`${c.parentName}\`)` : '') +
            ` — path: ${c.pathStr}`
          )
          .join('\n');
        return {
          content: [{
            type: 'text',
            text:
              `⚠️ **Ambiguous parentControl** — "${args.parentControl}" matches multiple controls in the base form.\n\n` +
              `**Candidates** (${resolution.multiple.length}):\n${candidateList}\n\n` +
              `Re-call \`add-control\` with the exact \`parentControl\` name from the list above.`,
          }],
        };
      }

      if (resolution && 'resolved' in resolution) {
        if (resolution.resolved !== args.parentControl) {
          addControlNote = `\n\n> 🔍 **parentControl** auto-resolved: \`"${args.parentControl}"\` → \`"${resolution.resolved}"\` (${resolution.pathStr})`;
        } else {
          addControlNote = `\n\n> ✅ **parentControl** \`"${resolution.resolved}"\` confirmed in base form (${resolution.pathStr})`;
        }
        (args as any).parentControl = resolution.resolved;
      }
      // null → form not found or no match; proceed with original value (compiler will catch it)
    }

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

    // 1a. Path containment guard — every write target must live under a configured
    //     <PackagesLocalDirectory>/<Package>/<Model>/Ax<Type>/<File>.xml layout.
    //     Refuses path traversal via explicit filePath or JSON sourcePath (security-critical).
    const containment = await assertWritePathAllowed(filePath, modelName);
    if (!containment.ok) {
      throw new Error(containment.reason || 'Path containment check failed');
    }

    // 1b. Model-ownership guard: refuse to modify objects in standard Microsoft models.
    // This prevents accidental writes to ApplicationSuite, ApplicationFoundation, etc.
    const resolvedModelFromPath = extractModelFromFilePath(filePath);
    if (resolvedModelFromPath && isStandardModel(resolvedModelFromPath)) {
      const configManager = getConfigManager();
      const configuredModel = modelName || configManager.getModelName();
      // Only block if the resolved model differs from the user's explicitly configured model.
      // If user explicitly set modelName=ApplicationSuite, they know what they're doing.
      if (!modelName || modelName !== resolvedModelFromPath) {
        throw new Error(
          `⛔ Refusing to modify "${objectName}" — the resolved file belongs to standard Microsoft model "${resolvedModelFromPath}".\n\n` +
          `Your configured model is "${configuredModel || '(not set)'}".\n` +
          `Modifying standard objects is not permitted — it can corrupt the base application.\n\n` +
          `To extend a standard object, create an extension instead:\n` +
          `  • Table: create_d365fo_file(objectType="table-extension", objectName="${objectName}.${configuredModel || 'YourModel'}Extension")\n` +
          `  • Class: create_d365fo_file(objectType="class-extension", objectName="${objectName}_Extension")\n` +
          `  • Form:  create_d365fo_file(objectType="form-extension", objectName="${objectName}.${configuredModel || 'YourModel'}Extension")`
        );
      }
    }

    // 2. Resolve actual XML file path (DB may store JSON metadata with sourcePath)
    let actualFilePath = filePath;
    try {
      const fileContent = await fs.readFile(filePath, 'utf-8');
      const trimmed = fileContent.trimStart();
      if (trimmed.startsWith('{')) {
        const data = JSON.parse(fileContent);
        if (data.sourcePath) {
          // Re-validate the indirect path: sourcePath also comes from user-influenced data.
          const srcContainment = await assertWritePathAllowed(data.sourcePath, modelName);
          if (!srcContainment.ok) {
            throw new Error(`sourcePath rejected: ${srcContainment.reason}`);
          }
          actualFilePath = srcContainment.canonicalPath || data.sourcePath;
        } else {
          throw new Error(`Metadata file has no sourcePath: ${filePath}`);
        }
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

    // ── Bridge-only modify via IMetadataProvider.Update() ────────────────────
    // ALL modify operations go through the C# bridge. The bridge reads, modifies,
    // and writes via the official D365FO metadata API — no xml2js needed.
    // If the bridge is unavailable or fails, we throw an error (no fallback).
    if (!context?.bridge) {
      throw new Error(
        'C# metadata bridge is not available. The bridge is required for all modify operations.\n' +
        'Start the bridge by building the D365MetadataBridge project and restarting the MCP server.'
      );
    }
    if (!canBridgeModify(objectType, operation)) {
      throw new Error(`Operation '${operation}' on object type '${objectType}' is not supported by the bridge.`);
    }

    let bridgeResult: { success: boolean; message: string } | null = null;

    switch (operation) {
      case 'add-method':
      case 'add-display-method':
      case 'add-table-method': {
        if (args.methodName && args.sourceCode) {
          bridgeResult = await bridgeAddMethod(
            context.bridge,
            objectType,
            objectName,
            args.methodName,
            args.sourceCode,
          );
        }
        break;
      }
      case 'remove-method': {
        if (args.methodName) {
          bridgeResult = await bridgeRemoveMethod(
            context.bridge,
            objectType,
            objectName,
            args.methodName,
          );
        }
        break;
      }
      case 'add-field': {
        if (args.fieldName && args.fieldType) {
          // fieldType is the EDT name; fieldBaseType is the primitive base type.
          // When fieldBaseType is omitted, auto-resolve it from the symbol index so the
          // correct AxTableField XML element is emitted. Always pass fieldType as edtName
          // so the <ExtendedDataType> reference is always written — previously, omitting
          // fieldBaseType left edtName undefined and produced fields with no EDT reference.
          const edtName = args.fieldType;
          let baseType: string = (args as any).fieldBaseType ?? '';
          if (!baseType) {
            try {
              const rdb = symbolIndex.getReadDb();
              baseType = resolveEdtBaseTypeForField(edtName, rdb);
            } catch {
              baseType = edtName; // bridge will apply its own name heuristics
            }
          }
          bridgeResult = await bridgeAddField(
            context.bridge,
            objectName,
            args.fieldName,
            baseType,
            edtName,
            args.fieldMandatory,
            args.fieldLabel,
          );
        }
        break;
      }
      case 'modify-field': {
        if (args.fieldName) {
          const fieldProps: Record<string, string> = {};
          if ((args as any).label) fieldProps.label = (args as any).label;
          if ((args as any).helpText) fieldProps.helpText = (args as any).helpText;
          if ((args as any).mandatory !== undefined) fieldProps.mandatory = String((args as any).mandatory);
          if ((args as any).edt) fieldProps.edt = (args as any).edt;
          if ((args as any).enumType) fieldProps.enumType = (args as any).enumType;
          if ((args as any).stringSize) fieldProps.stringSize = String((args as any).stringSize);
          bridgeResult = await bridgeModifyField(
            context.bridge,
            objectName,
            args.fieldName,
            Object.keys(fieldProps).length > 0 ? fieldProps : undefined,
          );
        }
        break;
      }
      case 'rename-field': {
        if (args.fieldName && (args as any).fieldNewName) {
          bridgeResult = await bridgeRenameField(
            context.bridge,
            objectName,
            args.fieldName,
            (args as any).fieldNewName,
          );
        }
        break;
      }
      case 'remove-field': {
        if (args.fieldName) {
          bridgeResult = await bridgeRemoveField(
            context.bridge,
            objectName,
            args.fieldName,
          );
        }
        break;
      }
      case 'replace-all-fields': {
        if ((args as any).fields) {
          bridgeResult = await bridgeReplaceAllFields(
            context.bridge,
            objectName,
            (args as any).fields,
          );
        }
        break;
      }
      case 'add-index': {
        if ((args as any).indexName) {
          bridgeResult = await bridgeAddIndex(
            context.bridge,
            objectName,
            (args as any).indexName,
            (args as any).indexFields,
            (args as any).allowDuplicates,
            (args as any).alternateKey,
          );
        }
        break;
      }
      case 'remove-index': {
        if ((args as any).indexName) {
          bridgeResult = await bridgeRemoveIndex(
            context.bridge,
            objectName,
            (args as any).indexName,
          );
        }
        break;
      }
      case 'add-relation': {
        if ((args as any).relationName && (args as any).relatedTable) {
          bridgeResult = await bridgeAddRelation(
            context.bridge,
            objectName,
            (args as any).relationName,
            (args as any).relatedTable,
            (args as any).relationConstraints,
          );
        }
        break;
      }
      case 'remove-relation': {
        if ((args as any).relationName) {
          bridgeResult = await bridgeRemoveRelation(
            context.bridge,
            objectName,
            (args as any).relationName,
          );
        }
        break;
      }
      case 'add-field-group': {
        if ((args as any).fieldGroupName) {
          bridgeResult = await bridgeAddFieldGroup(
            context.bridge,
            objectName,
            (args as any).fieldGroupName,
            (args as any).fieldGroupLabel,
            (args as any).fields,
          );
        }
        break;
      }
      case 'remove-field-group': {
        if ((args as any).fieldGroupName) {
          bridgeResult = await bridgeRemoveFieldGroup(
            context.bridge,
            objectName,
            (args as any).fieldGroupName,
          );
        }
        break;
      }
      case 'add-field-to-field-group': {
        if ((args as any).fieldGroupName && args.fieldName) {
          bridgeResult = await bridgeAddFieldToFieldGroup(
            context.bridge,
            objectName,
            (args as any).fieldGroupName,
            args.fieldName,
          );
        }
        break;
      }
      case 'modify-property': {
        if (args.propertyPath && args.propertyValue !== undefined) {
          bridgeResult = await bridgeSetProperty(
            context.bridge,
            objectType,
            objectName,
            args.propertyPath,
            args.propertyValue,
          );
        }
        break;
      }
      case 'replace-code': {
        // Auto-detect common mistake: agent sends sourceCode/methodCode instead of oldCode/newCode
        const hasOldNew = args.oldCode && args.newCode !== undefined;
        const sentSourceCode = args.sourceCode || (args as any).methodCode;
        
        if (!hasOldNew && sentSourceCode) {
          throw new Error(
            `⛔ replace-code requires 'oldCode' and 'newCode' — NOT 'sourceCode'/'methodCode'.\n\n` +
            `You sent sourceCode/methodCode but replace-code needs:\n` +
            `  • oldCode = the exact existing snippet to find\n` +
            `  • newCode = the replacement snippet\n\n` +
            `Example:\n` +
            `  modify_d365fo_file(objectType="form", objectName="MyForm",\n` +
            `    operation="replace-code",\n` +
            `    methodName="PostButton.clicked",\n` +
            `    oldCode="ttsbegin;",\n` +
            `    newCode="")\n\n` +
            `If you want to replace an entire existing method, pass the full old method source as oldCode and the full new method source as newCode so the edit stays in place. Use remove-method + add-method only when you intentionally want a remove/add operation.`
          );
        }
        
        if (hasOldNew) {
          // Try bridge first
          bridgeResult = await bridgeReplaceCode(
            context.bridge,
            objectType,
            objectName,
            args.methodName,
            args.oldCode!,
            args.newCode!,
          );

          // Fallback: if bridge returns null (unsupported type or not connected)
          // or success=false (SDK couldn't find the code — e.g. form control override),
          // do direct string replacement in the XML file.
          // This handles form control override methods which the SDK may not expose.
          if (!bridgeResult || !bridgeResult.success) {
            const xmlFallbackResult = await directXmlReplaceCode(
              actualFilePath, args.oldCode!, args.newCode!
            );
            if (xmlFallbackResult) {
              bridgeResult = xmlFallbackResult;
            }
          }
        } else {
          throw new Error(
            `replace-code requires both 'oldCode' and 'newCode' parameters.\n` +
            `  oldCode: ${args.oldCode ? 'provided' : '⛔ MISSING'}\n` +
            `  newCode: ${args.newCode !== undefined ? 'provided' : '⛔ MISSING'}\n` +
            `Note: 'sourceCode' is NOT an alias for replace-code — you must use 'oldCode' and 'newCode'.\n` +
            `For form control override methods, use methodName="ControlName.methodName" (e.g. "PostButton.clicked").`
          );
        }
        break;
      }
      case 'add-enum-value': {
        if ((args as any).enumValueName !== undefined) {
          bridgeResult = await bridgeAddEnumValue(
            context.bridge,
            objectName,
            (args as any).enumValueName,
            (args as any).enumValue ?? 0,
            (args as any).enumValueLabel,
          );
        }
        break;
      }
      case 'modify-enum-value': {
        if ((args as any).enumValueName) {
          const evProps: Record<string, string> = {};
          if ((args as any).enumValueLabel) evProps.label = (args as any).enumValueLabel;
          if ((args as any).enumValue !== undefined) evProps.value = String((args as any).enumValue);
          bridgeResult = await bridgeModifyEnumValue(
            context.bridge,
            objectName,
            (args as any).enumValueName,
            Object.keys(evProps).length > 0 ? evProps : undefined,
          );
        }
        break;
      }
      case 'remove-enum-value': {
        if ((args as any).enumValueName) {
          bridgeResult = await bridgeRemoveEnumValue(
            context.bridge,
            objectName,
            (args as any).enumValueName,
          );
        }
        break;
      }
      case 'add-control': {
        if ((args as any).controlName && (args as any).parentControl) {
          bridgeResult = await bridgeAddControl(
            context.bridge,
            objectName,
            (args as any).controlName,
            (args as any).parentControl,
            (args as any).controlType ?? 'String',
            (args as any).controlDataSource,
            (args as any).controlDataField,
            (args as any).label,
          );
        }
        break;
      }
      case 'add-data-source': {
        if ((args as any).dataSourceName && (args as any).dataSourceTable) {
          bridgeResult = await bridgeAddDataSource(
            context.bridge,
            objectType,
            objectName,
            (args as any).dataSourceName,
            (args as any).dataSourceTable,
            (args as any).joinSource,
            (args as any).linkType,
          );
        }
        break;
      }
      case 'add-field-modification': {
        if (args.fieldName) {
          bridgeResult = await bridgeAddFieldModification(
            context.bridge,
            objectName,
            args.fieldName,
            (args as any).fieldLabel,
            (args as any).fieldMandatory,
          );
        }
        break;
      }
      case 'add-menu-item-to-menu': {
        if ((args as any).menuItemToAdd) {
          bridgeResult = await bridgeAddMenuItemToMenu(
            context.bridge,
            objectName,
            (args as any).menuItemToAdd,
            (args as any).menuItemToAddType,
          );
        }
        break;
      }
      default:
        throw new Error(`Unsupported operation: ${operation}`);
    }

    if (!bridgeResult) {
      const paramHints: Record<string, string[]> = {
        'add-method': ['methodName', 'sourceCode'],
        'remove-method': ['methodName'],
        'replace-code': ['oldCode', 'newCode'],
        'add-field': ['fieldName', 'fieldType'],
        'modify-field': ['fieldName'],
        'rename-field': ['fieldName', 'fieldNewName'],
        'add-index': ['indexName'],
        'remove-index': ['indexName'],
        'add-relation': ['relationName', 'relatedTable'],
        'remove-relation': ['relationName'],
        'add-field-group': ['fieldGroupName'],
        'remove-field-group': ['fieldGroupName'],
        'add-field-to-field-group': ['fieldGroupName', 'fieldName'],
        'add-control': ['controlName', 'parentControl'],
        'add-data-source': ['dataSourceName', 'dataSourceTable'],
        'modify-property': ['propertyPath', 'propertyValue'],
      };
      const required = paramHints[operation] ?? [];
      const missingList = required.filter(p => !(args as any)[p]).map(p => `  ⛔ ${p}: MISSING`);
      const providedList = required.filter(p => (args as any)[p]).map(p => `  ✅ ${p}: provided`);
      throw new Error(
        `Bridge operation '${operation}' returned null — required parameters may be missing.\n` +
        `Required parameters for '${operation}':\n${[...providedList, ...missingList].join('\n')}\n` +
        `Provided args: ${Object.keys(args).filter(k => (args as any)[k] !== undefined).join(', ')}`
      );
    }
    if (!bridgeResult.success) {
      throw new Error(`Bridge operation '${operation}' failed: ${bridgeResult.message}`);
    }

    console.error(`[modify_d365fo_file] ✅ Bridge ${operation}: ${bridgeResult.message}`);

    // Post-write validation (best-effort, fire-and-forget).
    // Not awaited: the validation goes through the sequential bridge stdin/stdout
    // pipe and can take 60s+, which would block all subsequent MCP calls.
    // See: https://github.com/dynamics365ninja/d365fo-mcp-server/issues/407
    let bridgeValidation = '';
    bridgeValidateAfterWrite(
      context.bridge,
      objectType,
      objectName,
    ).then(validationMsg => {
      if (validationMsg) {
        console.error(`[modify_d365fo_file] Bridge validation: ${validationMsg}`);
      }
    }).catch(e => {
      console.error(`[modify_d365fo_file] Bridge validation skipped: ${e}`);
    });

    // Auto-invalidate Redis cache so subsequent reads return fresh data
    try {
      await invalidateCache(context.cache, objectName, objectType, [objectName]);
    } catch { /* Redis not available — non-fatal */ }

    // Optionally add the file to the Visual Studio project
    let projectMessage = '';
    if (args.addToProject) {
      const configManager = getConfigManager();
      await configManager.ensureLoaded();

      let resolvedProjectPath = args.projectPath || await configManager.getProjectPath() || undefined;
      const resolvedSolutionPath = args.solutionPath || await configManager.getSolutionPath() || undefined;

      if (!resolvedProjectPath && resolvedSolutionPath) {
        resolvedProjectPath = await ProjectFileFinder.findProjectInSolution(
          resolvedSolutionPath,
          modelName || configManager.getModelName() || ''
        ) || undefined;
      }

      if (resolvedProjectPath) {
        try {
          await fs.access(resolvedProjectPath);
          const projectManager = new ProjectFileManager();
          const wasAdded = await projectManager.addToProject(
            resolvedProjectPath,
            objectType,
            objectName,
            actualFilePath
          );
          projectMessage = wasAdded
            ? `\n✅ Added to VS project: \`${resolvedProjectPath}\``
            : `\n📋 Already in VS project: \`${resolvedProjectPath}\``;
        } catch (projErr) {
          const errMsg = projErr instanceof Error ? projErr.message : String(projErr);
          projectMessage = `\n⚠️ File modified but could not add to VS project: ${errMsg}`;
        }
      } else {
        projectMessage =
          `\n⚠️ addToProject=true but no projectPath could be resolved.\n` +
          `Add \`projectPath\` to .mcp.json or pass it explicitly.`;
      }
    }

    return {
      content: [
        {
          type: 'text',
          text:
            `✅ ${operation} on ${objectType} "${objectName}" — applied via IMetadataProvider.Update()\n\n` +
            `**File:** ${actualFilePath}${addControlNote}${bridgeValidation}${projectMessage}\n` +
            `🔧 API: ${bridgeResult.message}\n\n` +
            `**Next steps:**\n- Review changes in Visual Studio\n- Build the model to validate`,
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
    const rdb = symbolIndex.getReadDb();
    if (modelName) {
      const stmt = rdb.prepare(`
        SELECT file_path
        FROM symbols
        WHERE type = ? AND name = ? AND model = ?
        LIMIT 1
      `);
      const row = stmt.get(symbolType, objectName, modelName);
      dbResult = row ? row.file_path : null;
    } else {
      // No modelName specified — prefer the user's configured model to avoid
      // accidentally resolving to a standard Microsoft model (issue #369).
      const configuredModel = getConfigManager().getModelName();
      if (configuredModel) {
        const stmtPref = rdb.prepare(`
          SELECT file_path
          FROM symbols
          WHERE type = ? AND name = ? AND model = ?
          LIMIT 1
        `);
        const prefRow = stmtPref.get(symbolType, objectName, configuredModel);
        dbResult = prefRow ? prefRow.file_path : null;
      }
      if (!dbResult) {
        // Fallback: any model (still guarded by the standard-model check after findD365File)
        const stmt = rdb.prepare(`
          SELECT file_path
          FROM symbols
          WHERE type = ? AND name = ?
          ORDER BY model
          LIMIT 1
        `);
        const row = stmt.get(symbolType, objectName);
        dbResult = row ? row.file_path : null;
      }
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
    configManager.getPackagePath() || fallbackPackagePath();

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

// ─── Form parent-control auto-resolution ────────────────────────────────────
//
// When add-control is called with a fuzzy parentControl (e.g. "general"),
// these helpers find the base form XML, walk the control hierarchy, and return
// the exact control name so the caller never has to call get_form_info first.

interface ResolvedControl {
  name: string;
  parentName: string | null;
  pathStr: string;
}

/**
 * Recursively walk an AxFormControl node forest and collect every control.
 */
function walkFormControls(
  nodes: any[],
  out: ResolvedControl[],
  parentName: string | null,
  pathParts: string[],
): void {
  for (const node of nodes) {
    if (!node || typeof node !== 'object') continue;
    const name: string = Array.isArray(node.Name) ? node.Name[0] : (node.Name ?? '');
    if (!name) continue;
    const currentPath = [...pathParts, name];
    out.push({ name, parentName, pathStr: currentPath.join(' › ') });
    const cn = Array.isArray(node.Controls) ? node.Controls[0] : node.Controls;
    if (cn?.AxFormControl) {
      const children = Array.isArray(cn.AxFormControl) ? cn.AxFormControl : [cn.AxFormControl];
      walkFormControls(children, out, name, currentPath);
    }
  }
}

/**
 * Extract all controls from a parsed AxForm xmlObj.
 */
function allControlsFromFormXmlObj(xmlObj: any): ResolvedControl[] {
  const results: ResolvedControl[] = [];
  const axForm = xmlObj.AxForm;
  if (!axForm) return results;

  const designNode = Array.isArray(axForm.Design) ? axForm.Design[0] : axForm.Design;
  if (!designNode) return results;

  let rootNodes: any[] = [];
  // AxFormDesign wrapper (standard D365FO 10.0 format)
  if (designNode.AxFormDesign) {
    const fds = Array.isArray(designNode.AxFormDesign) ? designNode.AxFormDesign : [designNode.AxFormDesign];
    for (const fd of fds) {
      const cn = Array.isArray(fd.Controls) ? fd.Controls[0] : fd.Controls;
      if (cn?.AxFormControl) {
        const items = Array.isArray(cn.AxFormControl) ? cn.AxFormControl : [cn.AxFormControl];
        rootNodes = rootNodes.concat(items);
      }
    }
  } else if (designNode.Controls) {
    const cn = Array.isArray(designNode.Controls) ? designNode.Controls[0] : designNode.Controls;
    if (cn?.AxFormControl) {
      rootNodes = Array.isArray(cn.AxFormControl) ? cn.AxFormControl : [cn.AxFormControl];
    }
  }
  walkFormControls(rootNodes, results, null, []);
  return results;
}

/**
 * Locate the base form XML on disk, trying DB path → remapped path → filesystem scan.
 * Returns raw XML content, or null if not accessible.
 */
async function findBaseFormXml(baseFormName: string, symbolIndex: any): Promise<string | null> {
  // Helper: read a file, transparently following JSON metadata proxies.
  async function tryRead(p: string): Promise<string | null> {
    try {
      const raw = await fs.readFile(p, 'utf-8');
      if (raw.trimStart().startsWith('{')) {
        const data = JSON.parse(raw);
        if (data.sourcePath) {
          try { return await fs.readFile(data.sourcePath, 'utf-8'); } catch { return null; }
        }
        return null;
      }
      return raw;
    } catch { return null; }
  }

  // 1. Symbol DB lookup
  let dbFilePath: string | null = null;
  try {
    const rdb = symbolIndex.getReadDb();
    const row = rdb.prepare(
      `SELECT file_path FROM symbols WHERE type = 'form' AND name = ? LIMIT 1`
    ).get(baseFormName) as any;
    if (row?.file_path) dbFilePath = row.file_path;
  } catch { /* ignore */ }

  if (dbFilePath) {
    // Try absolute DB path as-is
    const direct = await tryRead(dbFilePath);
    if (direct) return direct;

    // DB stored a relative path — join with configured packagePath
    if (!path.isAbsolute(dbFilePath)) {
      const cm = getConfigManager();
      await cm.ensureLoaded();
      const pkgPath = cm.getPackagePath() || fallbackPackagePath();
      const abs = await tryRead(path.join(pkgPath, dbFilePath));
      if (abs) return abs;
    }

    // Build-agent path remapping (e.g. /home/vsts/... → local PackagesLocalDirectory)
    const remapped = await resolveDbPathLocally(dbFilePath);
    if (remapped) {
      const content = await tryRead(remapped);
      if (content) return content;
    }
  }

  // 2. Filesystem scan using model from config
  const diskPath = await findD365FileOnDisk('form', baseFormName);
  if (diskPath) return tryRead(diskPath);

  return null;
}

/**
 * Resolve a possibly-fuzzy `parentControl` value to the exact control name in the base form.
 *
 * Returns:
 *  { resolved, pathStr }   — unique case-insensitive substring match (use this name)
 *  { multiple }            — ambiguous (return candidates to caller)
 *  null                    — form not found or no controls matched; caller uses original value
 */
async function resolveParentControl(
  extensionObjectName: string,
  parentControlQuery: string,
  symbolIndex: any,
  explicitBaseFormName?: string,
): Promise<{ resolved: string; pathStr: string } | { multiple: ResolvedControl[] } | null> {
  // Base form name: "CustTable.MyExt" → "CustTable"
  const baseFormName = explicitBaseFormName || extensionObjectName.split('.')[0];
  if (!baseFormName) return null;

  const xmlContent = await findBaseFormXml(baseFormName, symbolIndex);
  if (!xmlContent) return null;

  let xmlObj: any;
  try { xmlObj = await parseStringPromise(xmlContent); } catch { return null; }

  const all = allControlsFromFormXmlObj(xmlObj);
  const lq = parentControlQuery.toLowerCase();
  const matches = all.filter(c => c.name.toLowerCase().includes(lq));

  if (matches.length === 0) return null; // No match — caller proceeds with original
  if (matches.length === 1) return { resolved: matches[0].name, pathStr: matches[0].pathStr };

  // Multiple substring matches — try an exact case-insensitive match first
  const exact = matches.filter(c => c.name.toLowerCase() === lq);
  if (exact.length === 1) return { resolved: exact[0].name, pathStr: exact[0].pathStr };

  return { multiple: matches };
}

export const modifyD365FileToolDefinition = {
  name: 'modify_d365fo_file',
  description:
    '✏️ Edit existing D365FO XML files (AxClass, AxTable, AxTableExtension, AxForm, AxFormExtension, etc.). ' +
    'Supports atomic operations:\n' +
    '• Methods: add-method, remove-method (table, form, class, table-extension, class-extension). add-method updates an existing method in place when the name already exists, preserving method order.\n' +
    '• Fields: add-field, modify-field, rename-field, replace-all-fields, remove-field (table, table-extension)\n' +
    '• Indexes: add-index, remove-index (table, table-extension)\n' +
    '• Relations: add-relation, remove-relation (table, table-extension)\n' +
    '• Field groups: add-field-group, remove-field-group, add-field-to-field-group (table, table-extension)\n' +
    '• Table-extension only: add-field-modification (modify base-table field label/mandatory)\n' +
    '• Form-extension: add-control (UI control), add-data-source (DataSourceReference)\n' +
    '• Any object: modify-property\n' +
    'Always prefer this tool over replace_string_in_file for XML edits.\n' +
    'Pass addToProject=true to also register the file in the Visual Studio .rnrproj (useful when the extension file existed on disk but was not yet in the project).',
  inputSchema: ModifyD365FileArgsSchema,
};

/**
 * Resolve the primitive base type for an EDT by walking the edt_metadata chain.
 * Used by add-field to auto-fill fieldBaseType when the caller omits it.
 * A newly-created EDT not yet in the index returns the EDT name so the bridge
 * can still apply its own name-based heuristics.
 */
function resolveEdtBaseTypeForField(edtName: string, db: any, depth = 0): string {
  const PRIMITIVES = new Set([
    'String', 'Integer', 'Int64', 'Real', 'Date', 'UtcDateTime', 'DateTime',
    'Enum', 'Container', 'Guid', 'GUID',
  ]);
  if (depth > 8) return edtName;
  if (PRIMITIVES.has(edtName)) return edtName;
  try {
    const row = db.prepare(
      `SELECT extends, enum_type FROM edt_metadata WHERE edt_name = ? LIMIT 1`
    ).get(edtName) as { extends: string | null; enum_type: string | null } | undefined;
    if (!row) return edtName; // not yet indexed — let bridge use name heuristics
    if (row.enum_type && !row.extends) return 'Enum';
    if (!row.extends) return edtName;
    if (PRIMITIVES.has(row.extends)) return row.extends;
    return resolveEdtBaseTypeForField(row.extends, db, depth + 1);
  } catch {
    return edtName;
  }
}
