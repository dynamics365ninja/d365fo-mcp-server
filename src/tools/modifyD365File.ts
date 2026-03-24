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
import { resolveDbPathLocally } from '../utils/metadataResolver.js';
import { bridgeValidateAfterWrite, canBridgeModify, bridgeAddMethod, bridgeAddField, bridgeSetProperty, bridgeReplaceCode } from '../bridge/index.js';
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
      const decoded = decodeStandardXmlEntities(innerRaw);
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
  ]).describe('Operation to perform'),

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
  // For replace-code
  oldCode: z.string().optional().describe(
    'Exact existing X++ code snippet to find and replace. Used with operation="replace-code". ' +
    'Must match the source text exactly (leading/trailing whitespace is trimmed for matching). ' +
    'If methodName is also provided the search is scoped to that method\'s Source block only.'
  ),
  newCode: z.string().optional().describe(
    'Replacement X++ code snippet. Used with operation="replace-code". ' +
    'Replaces the first occurrence of oldCode in the target source block.'
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
  dryRun: z.boolean().optional().default(false).describe(
    'When true, computes the change and returns a unified diff preview WITHOUT writing to disk. ' +
    'Use this to show the user exactly what will be modified before applying. ' +
    'Call again with dryRun=false (or omit it) to apply the changes.'
  ),
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

/**
 * Generate a unified-diff preview between two XML strings.
 *
 * The algorithm locates hunks of changed lines by computing a simple
 * longest-common-subsequence (LCS) at the line level.  For typical D365FO
 * modifications (inserting a method block, adding a field, changing a
 * property) the hunk set is small and the output is easy to read.
 */
function generateUnifiedDiff(original: string, modified: string, contextLines = 4): string {
  if (original === modified) return '(no changes detected)';

  const origLines = original.split('\n');
  const modLines  = modified.split('\n');

  // --- LCS table (space-optimised: only two rows needed) ---
  const m = origLines.length;
  const n = modLines.length;

  // lcsMemo[i][j] = LCS length for origLines[0..i-1] vs modLines[0..j-1]
  // We keep the full table so we can back-track the edit script.
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = origLines[i - 1] === modLines[j - 1]
        ? dp[i - 1][j - 1] + 1
        : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }

  // Back-track to produce an edit script: each entry is [tag, line]
  // tag: '=' keep, '-' delete, '+' insert
  type EditEntry = ['=' | '-' | '+', string];
  const edits: EditEntry[] = [];
  let i = m, j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && origLines[i - 1] === modLines[j - 1]) {
      edits.push(['=', origLines[i - 1]]);
      i--; j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      edits.push(['+', modLines[j - 1]]);
      j--;
    } else {
      edits.push(['-', origLines[i - 1]]);
      i--;
    }
  }
  edits.reverse();

  // --- Group edits into hunks with context ---
  // A hunk is a maximal run of non-'=' lines, padded by contextLines '=' on each side.
  const hunks: string[] = [];
  let eIdx = 0;
  let origLine = 1; // 1-based line counter in original
  let modLine  = 1; // 1-based line counter in modified

  while (eIdx < edits.length) {
    // Skip unchanged lines until we find a change
    if (edits[eIdx][0] === '=') {
      origLine++;
      modLine++;
      eIdx++;
      continue;
    }

    // We're at a change — collect context before it
    const hunkStart = eIdx;
    // Find end of this cluster of changes
    let hunkEnd = eIdx;
    while (hunkEnd < edits.length && edits[hunkEnd][0] !== '=') hunkEnd++;
    // Extend hunkEnd to absorb context (skip over short '=' gaps between changes)
    let look = hunkEnd;
    while (look < edits.length) {
      // Count consecutive '=' lines
      let eqCount = 0;
      while (look + eqCount < edits.length && edits[look + eqCount][0] === '=') eqCount++;
      if (eqCount === 0) { hunkEnd = look + 1; look++; continue; }  // another change
      if (eqCount <= contextLines * 2) { look += eqCount; hunkEnd = look; continue; } // merge
      break; // gap is large enough to split
    }

    // Collect context lines before this hunk
    const preCtx: string[] = [];
    for (let k = Math.min(contextLines, hunkStart); k > 0; k--) {
      const e = edits[hunkStart - k];
      if (e[0] === '=') preCtx.unshift(' ' + e[1]);
    }

    // Compute hunk header line numbers
    // Recount from global origin because we need exact numbers
    let hOrig = origLine - preCtx.length;
    let hMod  = modLine - preCtx.length;

    const hunkLines: string[] = [];
    for (const l of preCtx) hunkLines.push(l);

    for (let k = hunkStart; k < hunkEnd; k++) {
      const [tag, line] = edits[k];
      if (tag === '=') { hunkLines.push(' ' + line); origLine++; modLine++; }
      else if (tag === '-') { hunkLines.push('-' + line); origLine++; }
      else { hunkLines.push('+' + line); modLine++; }
    }

    // Context after
    let postCtx = 0;
    for (let k = hunkEnd; k < edits.length && postCtx < contextLines; k++) {
      if (edits[k][0] === '=') { hunkLines.push(' ' + edits[k][1]); postCtx++; origLine++; modLine++; eIdx = k + 1; }
      else break;
    }
    eIdx = Math.max(eIdx, hunkEnd);

    const origCount = hunkLines.filter(l => l[0] !== '+').length;
    const modCount  = hunkLines.filter(l => l[0] !== '-').length;
    hunks.push(`@@ -${hOrig},${origCount} +${hMod},${modCount} @@`);
    for (const l of hunkLines) hunks.push(l);
  }

  return hunks.length > 0 ? hunks.join('\n') : '(no changes detected)';
}

export async function modifyD365FileTool(request: CallToolRequest, context: XppServerContext) {
  try {
    const args = ModifyD365FileArgsSchema.parse(request.params.arguments);
    const { symbolIndex } = context;
    const {
      objectType,
      objectName,
      operation,
      createBackup,
      dryRun,
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

    // 3. Create backup of the actual XML file (skip in dry-run — nothing is written)
    if (createBackup && !dryRun) {
      await createFileBackup(actualFilePath);
    }

    // ── Phase 4: Bridge-first modify via IMetadataProvider.Update() ──────────
    // For supported operations (add-method, add-field, modify-property, replace-code)
    // on supported types (class, table, enum, edt): try C# bridge first.
    // The bridge reads/modifies/writes via the official API — no xml2js needed.
    // Skip for dry-run (bridge writes directly, cannot preview diff).
    if (!dryRun && context?.bridge && canBridgeModify(objectType, operation)) {
      try {
        let bridgeResult: { success: boolean; message: string } | null = null;

        switch (operation) {
          case 'add-method': {
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
          case 'add-field': {
            if (args.fieldName && args.fieldType) {
              bridgeResult = await bridgeAddField(
                context.bridge,
                objectName,
                args.fieldName,
                args.fieldType,
                (args as any).edt,
                (args as any).mandatory,
                (args as any).label,
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
            if (args.oldCode && args.newCode) {
              bridgeResult = await bridgeReplaceCode(
                context.bridge,
                objectType,
                objectName,
                args.methodName,
                args.oldCode,
                args.newCode,
              );
            }
            break;
          }
        }

        if (bridgeResult?.success) {
          console.error(`[modify_d365fo_file] ✅ Bridge ${operation}: ${bridgeResult.message}`);

          // Post-write validation (best-effort)
          let bridgeValidation = '';
          try {
            const validationMsg = await bridgeValidateAfterWrite(
              context.bridge,
              objectType,
              objectName,
            );
            if (validationMsg) bridgeValidation = `\n${validationMsg}`;
          } catch (_e) { /* skip */ }

          return {
            content: [
              {
                type: 'text',
                text:
                  `✅ ${operation} on ${objectType} "${objectName}" — applied via IMetadataProvider.Update()\n\n` +
                  `**File:** ${actualFilePath}${addControlNote}${bridgeValidation}\n` +
                  `🔧 API: ${bridgeResult.message}\n\n` +
                  `**Next steps:**\n- Review changes in Visual Studio\n- Build the model to validate`,
              },
            ],
          };
        }
        // bridgeResult is null or success=false → fall through to xml2js path
        if (bridgeResult) {
          console.error(`[modify_d365fo_file] Bridge ${operation} returned success=false — falling back to xml2js`);
        }
      } catch (bridgeErr) {
        console.error(`[modify_d365fo_file] Bridge ${operation} failed, falling back to xml2js: ${bridgeErr}`);
      }
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

      case 'replace-code': {
        const scope = args.methodName ? ` in method "${args.methodName}"` : '';
        modified = await replaceCode(xmlObj, objectType, args);
        message = `Replaced code snippet${scope} in ${objectType} "${objectName}"`;
        break;
      }
      
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

      case 'add-enum-value':
        modified = await addEnumValue(xmlObj, args);
        message = `Added enum value "${args.enumValueName}" to ${objectType} "${objectName}"`;
        break;

      case 'modify-enum-value':
        modified = await modifyEnumValue(xmlObj, args);
        message = `Modified enum value "${args.enumValueName}" in ${objectType} "${objectName}"`;
        break;

      case 'remove-enum-value':
        modified = await removeEnumValue(xmlObj, args);
        message = `Removed enum value "${args.enumValueName}" from ${objectType} "${objectName}"`;
        break;

      case 'add-display-method':
        modified = await addDisplayMethod(xmlObj, objectType, args);
        message = `Added display method "${args.methodName}" to ${objectType} "${objectName}"`;
        break;

      case 'add-table-method':
        modified = await addTableMethod(xmlObj, args);
        message = `Added table method "${args.tableMethodType ?? args.methodName}" to table "${objectName}"`;
        break;

      case 'add-menu-item-to-menu':
        modified = await addMenuItemToMenu(xmlObj, objectType, args);
        message = `Added menu item "${args.menuItemToAdd}" to ${objectType} "${objectName}"`;
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
    // AxReport: re-wrap <Text> blocks (RDL design content) in CDATA.
    // xml2js strips CDATA on parse and Builder entity-encodes < > & on serialize;
    // rewrapXmlTagAsCdata decodes those entities and restores the CDATA wrapper.
    if (objectType === 'report') {
      newXml = rewrapXmlTagAsCdata('Text', newXml);
    }

    // 6a. Dry-run: return a unified-diff preview without touching the file
    if (dryRun) {
      const diff = generateUnifiedDiff(xmlContent, newXml);
      const opLabel = `${operation} on ${objectType} \`${objectName}\``;
      return {
        content: [
          {
            type: 'text',
            text:
              `## 🔍 Preview (dry-run) — changes NOT applied\n\n` +
              `| Property | Value |\n` +
              `|---|---|\n` +
              `| **Operation** | \`${opLabel}\` |\n` +
              `| **File** | \`${actualFilePath}\` |\n\n` +
              `### What will change\n\n` +
              `\`\`\`diff\n${diff}\n\`\`\`\n\n` +
              `> ✅ To apply the changes, call again **without** the \`dryRun\` parameter (or with \`dryRun: false\`).` +
              addControlNote,
          },
        ],
      };
    }

    // Write file with UTF-8 BOM — required by D365FO metadata deserializer
    // (same as create_d365fo_file; omitting BOM causes "cannot open/deserialize" in VS)
    const utf8BOM = Buffer.from([0xEF, 0xBB, 0xBF]);
    const xmlBuffer = Buffer.concat([utf8BOM, Buffer.from(newXml, 'utf-8')]);
    await fs.writeFile(actualFilePath, xmlBuffer);

    // 6a2. Post-write validation via C# bridge (best-effort)
    let bridgeValidation = '';
    try {
      const validationMsg = await bridgeValidateAfterWrite(
        context.bridge,
        objectType,
        objectName,
      );
      if (validationMsg) {
        bridgeValidation = `\n${validationMsg}`;
        console.error(`[modify_d365fo_file] Bridge validation: ${validationMsg}`);
      }
    } catch (e) {
      console.error(`[modify_d365fo_file] Bridge validation skipped: ${e}`);
    }

    // 6b. Optionally add the file to the Visual Studio project
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

    // 6c. Return success — include diff so user can see what was actually written
    const appliedDiff = generateUnifiedDiff(xmlContent, newXml);
    return {
      content: [
        {
          type: 'text',
          text:
            `✅ ${message}\n\n` +
            `**File:** ${actualFilePath}${addControlNote}${bridgeValidation}${projectMessage}\n\n` +
            `### Applied changes\n\n` +
            `\`\`\`diff\n${appliedDiff}\n\`\`\`\n\n` +
            `**Next steps:**\n- Review changes in Visual Studio\n- Build the model to validate\n- Commit changes to source control`,
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

/**
 * Replace a specific X++ code snippet inside a method Source block or the class Declaration.
 *
 * Finds the first occurrence of `oldCode` in:
 *   – the named method's <Source> block (when methodName is provided), or
 *   – the classDeclaration <Declaration> block (when methodName="classDeclaration"), or
 *   – every Source block in order (Declaration first, then Methods) until one matches.
 *
 * Behaviour mirrors replace_string_in_file: the surrounding code is preserved and
 * the match position is maintained — only the matched text is overwritten.
 */

/**
 * Recursively search all string leaf values in a parsed xml2js object tree and
 * replace the first occurrence of `oldText` with `newText`.
 * Returns true when a replacement was made.
 */
function replaceInXmlObjRecursive(obj: any, oldText: string, newText: string): boolean {
  if (!obj || typeof obj !== 'object') return false;

  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      if (typeof obj[i] === 'string') {
        if (obj[i].includes(oldText)) {
          obj[i] = obj[i].replace(oldText, newText);
          return true;
        }
      } else {
        if (replaceInXmlObjRecursive(obj[i], oldText, newText)) return true;
      }
    }
  } else {
    for (const key of Object.keys(obj)) {
      if (replaceInXmlObjRecursive(obj[key], oldText, newText)) return true;
    }
  }
  return false;
}

async function replaceCode(xmlObj: any, objectType: string, args: any): Promise<boolean> {
  // AxReport has no <SourceCode> block — its content is the RDL XML stored in
  // <Designs><AxReportDesign><Text> (CDATA) plus property values across the tree.
  // For reports we perform a recursive text search-and-replace across the whole xmlObj.
  if (objectType === 'report') {
    const { oldCode, newCode } = args;
    if (!oldCode) throw new Error('oldCode is required for replace-code operation');
    if (newCode === undefined || newCode === null)
      throw new Error('newCode is required for replace-code operation (pass "" to delete)');

    const decodedOld = decodeXmlEntitiesFromXppSource(oldCode);
    const decodedNew = decodeXmlEntitiesFromXppSource(newCode);

    if (!replaceInXmlObjRecursive(xmlObj, decodedOld, decodedNew)) {
      throw new Error(
        `oldCode not found anywhere in the report XML.\n` +
        `Searched for:\n${decodedOld}\n\n` +
        `Tip: use get_report_info() to inspect the current report structure and verify the exact text.`
      );
    }
    return true;
  }

  const { methodName, oldCode, newCode } = args;

  if (!oldCode) {
    throw new Error('oldCode is required for replace-code operation');
  }
  if (newCode === undefined || newCode === null) {
    throw new Error('newCode is required for replace-code operation (pass "" to delete)');
  }

  // Decode XML entities so that AI-provided snippets (e.g. &lt;summary&gt;) match the
  // decoded source text that is stored in the CDATA block after the initial xml2js parse.
  const decodedOld = decodeXmlEntitiesFromXppSource(oldCode);
  const decodedNew = decodeXmlEntitiesFromXppSource(newCode);

  const rootKey = getRootKey(objectType);
  const root = xmlObj[rootKey];
  if (!root) {
    throw new Error(`Invalid XML structure: root element <${rootKey}> not found`);
  }

  const sourceCodeEl = Array.isArray(root.SourceCode) ? root.SourceCode[0] : root.SourceCode;
  if (!sourceCodeEl || typeof sourceCodeEl !== 'object') {
    throw new Error('No <SourceCode> block found in object');
  }

  // ── Helper: replace first occurrence, return true on success ────────────
  function replaceIn(container: any, prop: string): boolean {
    const val: string = container[prop]?.[0] ?? '';
    if (!val.includes(decodedOld)) return false;
    container[prop][0] = val.replace(decodedOld, decodedNew);
    return true;
  }

  // ── Scoped to a specific method / classDeclaration ───────────────────────
  if (methodName) {
    if (methodName === 'classDeclaration') {
      if (!sourceCodeEl.Declaration?.[0]) {
        throw new Error('No <Declaration> block found');
      }
      if (!replaceIn(sourceCodeEl, 'Declaration')) {
        throw new Error(
          `oldCode not found in classDeclaration.\n` +
          `Searched for:\n${decodedOld}\n\n` +
          `Use get_method_source(className, "classDeclaration") to see the current source.`
        );
      }
      return true;
    }

    const methodsNode = sourceCodeEl.Methods?.[0];
    if (!methodsNode?.Method) {
      throw new Error(`No methods found in object`);
    }
    const methods: any[] = Array.isArray(methodsNode.Method)
      ? methodsNode.Method
      : [methodsNode.Method];
    const method = methods.find((m: any) => m.Name?.[0] === methodName);
    if (!method) {
      throw new Error(
        `Method "${methodName}" not found. ` +
        `Use get_class_info() to list available methods.`
      );
    }
    if (!replaceIn(method, 'Source')) {
      throw new Error(
        `oldCode not found in method "${methodName}".\n` +
        `Searched for:\n${decodedOld}\n\n` +
        `Use get_method_source(className, "${methodName}") to see the current source.`
      );
    }
    return true;
  }

  // ── No scope — search Declaration then all Method Sources ────────────────
  if (sourceCodeEl.Declaration?.[0] && replaceIn(sourceCodeEl, 'Declaration')) {
    return true;
  }

  const methodsNode = sourceCodeEl.Methods?.[0];
  if (methodsNode?.Method) {
    const methods: any[] = Array.isArray(methodsNode.Method)
      ? methodsNode.Method
      : [methodsNode.Method];
    for (const method of methods) {
      if (replaceIn(method, 'Source')) return true;
    }
  }

  throw new Error(
    `oldCode not found in any Source or Declaration block.\n` +
    `Searched for:\n${decodedOld}\n\n` +
    `Tip: provide methodName to scope the search, or use get_method_source() to inspect current content.`
  );
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

  // Replace existing method with same name instead of pushing a duplicate.
  // X++ does not support method overloading/overriding at the XML level — two
  // <Method> nodes with the same <Name> cause serialisation/compiler errors.
  const existingIdx = methodsNode[0].Method.findIndex(
    (m: any) => m.Name && m.Name[0] === methodName
  );
  if (existingIdx !== -1) {
    methodsNode[0].Method[existingIdx] = newMethod;
  } else {
    methodsNode[0].Method.push(newMethod);
  }

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
    const row = symbolIndex.db.prepare(
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
      const pkgPath = cm.getPackagePath() || 'K:\\AosService\\PackagesLocalDirectory';
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

  // Check for duplicate — field group with this name already exists
  const existing = container.AxTableFieldGroup.find(
    (fg: any) => (Array.isArray(fg.Name) ? fg.Name[0] : fg.Name) === fieldGroupName
  );
  if (existing) {
    throw new Error(`Field group "${fieldGroupName}" already exists in this ${objectType}. Use add-field-to-field-group to add fields to it.`);
  }

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
/**
 * Add a new value to an AxEnum.
 * Supported object types: enum, enum-extension.
 */
async function addEnumValue(xmlObj: any, args: any): Promise<boolean> {
  const { enumValueName, enumValueLabel, enumValueHelpText, enumValueInt } = args;
  if (!enumValueName) throw new Error('enumValueName is required for add-enum-value');

  // Resolve root — AxEnum or AxEnumExtension
  const root = xmlObj['AxEnum'] || xmlObj['AxEnumExtension'];
  if (!root) throw new Error('Invalid XML structure: root element <AxEnum> or <AxEnumExtension> not found');

  // Normalise EnumValues to array container
  const container = ensureArrayContainer(root, 'EnumValues', 'AxEnumValue');

  // Check for duplicate name
  if (container.AxEnumValue.some((v: any) => v.Name === enumValueName)) {
    throw new Error(`Enum value "${enumValueName}" already exists`);
  }

  // Determine the integer value: explicit or max + 1
  let intValue: number;
  if (typeof enumValueInt === 'number') {
    intValue = enumValueInt;
  } else {
    const existing: number[] = container.AxEnumValue
      .map((v: any) => parseInt(v.Value ?? '0', 10))
      .filter((n: number) => !isNaN(n));
    intValue = existing.length > 0 ? Math.max(...existing) + 1 : 0;
  }

  const newValue: any = { Name: enumValueName };
  if (enumValueLabel)    newValue.Label    = enumValueLabel;
  if (enumValueHelpText) newValue.HelpText = enumValueHelpText;
  // D365FO convention: omit <Value> for 0
  if (intValue !== 0) newValue.Value = String(intValue);

  container.AxEnumValue.push(newValue);
  return true;
}

/**
 * Modify an existing enum value (label, helpText, integer value).
 * Supported object types: enum, enum-extension.
 */
async function modifyEnumValue(xmlObj: any, args: any): Promise<boolean> {
  const { enumValueName, enumValueLabel, enumValueHelpText, enumValueInt } = args;
  if (!enumValueName) throw new Error('enumValueName is required for modify-enum-value');

  const root = xmlObj['AxEnum'] || xmlObj['AxEnumExtension'];
  if (!root) throw new Error('Invalid XML structure: root element <AxEnum> or <AxEnumExtension> not found');

  const container = ensureArrayContainer(root, 'EnumValues', 'AxEnumValue');
  const found = container.AxEnumValue.find((v: any) => v.Name === enumValueName);
  if (!found) throw new Error(`Enum value "${enumValueName}" not found`);

  if (enumValueLabel    !== undefined) found.Label    = enumValueLabel;
  if (enumValueHelpText !== undefined) found.HelpText = enumValueHelpText;
  if (typeof enumValueInt === 'number') {
    found.Value = enumValueInt === 0 ? undefined : String(enumValueInt);
  }
  return true;
}

/**
 * Remove an existing enum value.
 * Supported object types: enum, enum-extension.
 */
async function removeEnumValue(xmlObj: any, args: any): Promise<boolean> {
  const { enumValueName } = args;
  if (!enumValueName) throw new Error('enumValueName is required for remove-enum-value');

  const root = xmlObj['AxEnum'] || xmlObj['AxEnumExtension'];
  if (!root) throw new Error('Invalid XML structure: root element <AxEnum> or <AxEnumExtension> not found');

  const container = ensureArrayContainer(root, 'EnumValues', 'AxEnumValue');
  const before = container.AxEnumValue.length;
  container.AxEnumValue = container.AxEnumValue.filter((v: any) => v.Name !== enumValueName);

  if (container.AxEnumValue.length === before) {
    throw new Error(`Enum value "${enumValueName}" not found`);
  }
  return true;
}

/**
 * Add a display method to a table.
 * Automatically prepends [SysClientCacheDataMethodAttribute(true)] if not already present.
 */
async function addDisplayMethod(xmlObj: any, objectType: string, args: any): Promise<boolean> {
  if (objectType !== 'table' && objectType !== 'table-extension' && objectType !== 'form') {
    throw new Error('add-display-method is only supported for table, table-extension, and form');
  }
  if (!args.methodName) throw new Error('methodName is required for add-display-method');

  const returnType = args.displayMethodReturnEdt || args.methodReturnType || 'str';
  const body = args.sourceCode
    ? decodeXmlEntitiesFromXppSource(args.sourceCode)
    : `    // TODO: compute and return the display value\n    return '';`;

  // Build display method source — prepend attribute if caller didn't include it
  let fullSource = body;
  if (!fullSource.includes('SysClientCacheDataMethodAttribute') &&
      !fullSource.includes('display ')) {
    const params = args.methodParameters || '';
    fullSource =
      `[SysClientCacheDataMethodAttribute(true)]\n` +
      `public display ${returnType} ${args.methodName}(${params})\n{\n${body}\n}`;
  }

  const newArgs = { ...args, sourceCode: fullSource };
  return addMethod(xmlObj, objectType, newArgs);
}

/**
 * Add a standard table method (find, exist, findByRecId, validateWrite, validateDelete, initValue).
 * Generates the canonical boilerplate for each pattern.
 */
async function addTableMethod(xmlObj: any, args: any): Promise<boolean> {
  const methodType = args.tableMethodType;
  const tableName  = args.objectName as string;
  const keyField   = args.tableKeyField || `${tableName}Id`;

  if (!methodType && !args.methodName) {
    throw new Error('tableMethodType or methodName is required for add-table-method');
  }

  let fullSource: string;
  switch (methodType) {
    case 'find':
      fullSource =
`/// <summary>Finds a ${tableName} record by its primary key.</summary>
/// <param name="_id">The key value to look up.</param>
/// <param name="_forUpdate">Set to true to lock the record for update (forupdate).</param>
/// <returns>The found record, or an empty buffer if not found.</returns>
public static ${tableName} find(${keyField} _id, boolean _forUpdate = false)
{
    ${tableName} record;

    if (_id)
    {
        if (_forUpdate)
        {
            record.selectForUpdate(true);
        }

        select firstonly record
            where record.${keyField} == _id;
    }

    return record;
}`;
      break;

    case 'exist':
      fullSource =
`/// <summary>Checks whether a ${tableName} record with the given key exists.</summary>
/// <param name="_id">The key value to check.</param>
/// <returns>True if a record exists, false otherwise.</returns>
public static boolean exist(${keyField} _id)
{
    return _id && (select firstonly RecId from ${tableName}
                   where ${tableName}.${keyField} == _id).RecId != 0;
}`;
      break;

    case 'findByRecId':
      fullSource =
`/// <summary>Finds a ${tableName} record by its RecId.</summary>
/// <param name="_recId">The RecId to look up.</param>
/// <param name="_forUpdate">Set to true to lock the record for update.</param>
/// <returns>The found record, or an empty buffer if not found.</returns>
public static ${tableName} findByRecId(RecId _recId, boolean _forUpdate = false)
{
    ${tableName} record;

    if (_recId)
    {
        if (_forUpdate)
        {
            record.selectForUpdate(true);
        }

        select firstonly record
            where record.RecId == _recId;
    }

    return record;
}`;
      break;

    case 'validateWrite':
      fullSource =
`/// <summary>Validates the record before it is written to the database.</summary>
/// <returns>True if validation passes, false otherwise.</returns>
public boolean validateWrite()
{
    boolean ret = super();

    // Add custom validation rules
    if (ret)
    {
        if (!this.${keyField})
        {
            ret = checkFailed(strFmt("@SYS53447", fieldPName(${tableName}, ${keyField})));
        }
    }

    return ret;
}`;
      break;

    case 'validateDelete':
      fullSource =
`/// <summary>Validates that the record can be safely deleted.</summary>
/// <returns>True if deletion is allowed, false otherwise.</returns>
public boolean validateDelete()
{
    boolean ret = super();

    // Add custom deletion guards here
    // Example: prevent deletion if referenced by another table
    // if (AnotherTable::existFor${tableName}(this.RecId))
    // {
    //     ret = checkFailed("@MyModel:CannotDeleteReferenced");
    // }

    return ret;
}`;
      break;

    case 'initValue':
      fullSource =
`/// <summary>Initialises default field values when a new record is created.</summary>
public void initValue()
{
    super();

    // Set default values for new records
    // this.Status = ${tableName}Status::Open;
}`;
      break;

    default:
      // Fallback: just delegate to addMethod with the provided args
      return addMethod(xmlObj, 'table', args);
  }

  const newArgs = { ...args, sourceCode: fullSource };
  return addMethod(xmlObj, 'table', newArgs);
}

/**
 * Add a menu item reference to an existing menu or menu-extension XML.
 */
async function addMenuItemToMenu(xmlObj: any, objectType: string, args: any): Promise<boolean> {
  if (objectType !== 'menu' && objectType !== 'menu-extension') {
    throw new Error('add-menu-item-to-menu is only supported for menu and menu-extension');
  }
  if (!args.menuItemToAdd) throw new Error('menuItemToAdd is required for add-menu-item-to-menu');

  const rootKey = getRootKey(objectType);
  const root = xmlObj[rootKey];
  if (!root) throw new Error(`Invalid XML structure: root element <${rootKey}> not found`);

  const itemType    = args.menuItemToAddType || 'display';
  const nodeTypeMap: Record<string, string> = {
    display: 'AxMenuItemDisplay',
    action:  'AxMenuItemAction',
    output:  'AxMenuItemOutput',
  };
  const nodeType = nodeTypeMap[itemType] || 'AxMenuItemDisplay';

  // Ensure MenuItems container exists
  if (!root.MenuItems || (Array.isArray(root.MenuItems) && typeof root.MenuItems[0] !== 'object')) {
    root.MenuItems = [{}];
  }
  const menuItemsContainer = Array.isArray(root.MenuItems) ? root.MenuItems[0] : root.MenuItems;

  // Ensure array for the node type
  if (!menuItemsContainer[nodeType]) {
    menuItemsContainer[nodeType] = [];
  } else if (!Array.isArray(menuItemsContainer[nodeType])) {
    menuItemsContainer[nodeType] = [menuItemsContainer[nodeType]];
  }

  // Check for duplicate
  const existing = menuItemsContainer[nodeType].find((item: any) => item.Name === args.menuItemToAdd);
  if (existing) {
    throw new Error(`Menu item "${args.menuItemToAdd}" already exists in this menu`);
  }

  // Add the menu item reference
  menuItemsContainer[nodeType].push({ Name: args.menuItemToAdd });
  return true;
}

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
    'Always prefer this tool over replace_string_in_file for XML edits.\n' +
    'Pass addToProject=true to also register the file in the Visual Studio .rnrproj (useful when the extension file existed on disk but was not yet in the project).',
  inputSchema: ModifyD365FileArgsSchema,
};
