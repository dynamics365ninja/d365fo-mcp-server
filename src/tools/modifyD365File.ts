/**
 * Modify D365FO File Tool
 * Edit existing D365FO XML files (AxClass, AxTable, AxForm, etc.)
 * Supports atomic operations: add method, add field, modify property
 */

import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { XppServerContext } from '../types/context.js';
import { promises as fs } from 'fs';
import { parseStringPromise, Builder } from 'xml2js';

const ModifyD365FileArgsSchema = z.object({
  objectType: z.enum(['class', 'table', 'form', 'enum', 'query', 'view']).describe('Type of D365FO object'),
  objectName: z.string().describe('Name of the object to modify'),
  operation: z.enum(['add-method', 'add-field', 'modify-property', 'remove-method', 'remove-field']).describe('Operation to perform'),
  
  // For add-method
  methodName: z.string().optional().describe('Name of method to add/remove'),
  methodCode: z.string().optional().describe('X++ code for the method body'),
  methodModifiers: z.string().optional().describe('Method modifiers (e.g., "public static")'),
  methodReturnType: z.string().optional().describe('Return type of method'),
  methodParameters: z.string().optional().describe('Method parameters (e.g., "str _param1, int _param2")'),
  
  // For add-field (tables)
  fieldName: z.string().optional().describe('Name of field to add/remove'),
  fieldType: z.string().optional().describe('Extended data type or base type'),
  fieldMandatory: z.boolean().optional().describe('Is field mandatory'),
  fieldLabel: z.string().optional().describe('Field label'),
  
  // For modify-property
  propertyPath: z.string().optional().describe('Path to property (e.g., "Table1.Visible")'),
  propertyValue: z.string().optional().describe('New property value'),
  
  // Options
  createBackup: z.boolean().optional().default(true).describe('Create backup before modification'),
  modelName: z.string().optional().describe('Model name (auto-detected if not provided)'),
  packageName: z.string().optional().describe('Package name. Auto-resolved if omitted.'),
  workspacePath: z.string().optional().describe('Path to workspace for finding file'),
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
      workspacePath 
    } = args;

    // 1. Find the file
    const filePath = await findD365File(symbolIndex, objectType, objectName, modelName, workspacePath);
    
    if (!filePath) {
      throw new Error(`File not found for ${objectType} "${objectName}". Make sure the object exists and is indexed.`);
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
      throw new Error(`Cannot read file: ${filePath}`);
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
    
    const newXml = builder.buildObject(xmlObj);
    await fs.writeFile(actualFilePath, newXml, 'utf-8');

    // 6. Return success
    return {
      content: [
        {
          type: 'text',
          text: `✅ ${message}\n\n**File:** ${actualFilePath}\n**Backup:** ${createBackup ? 'Created' : 'Skipped'}\n\n**Next steps:**\n- Review changes in Visual Studio\n- Build the model to validate\n- Commit changes to source control`,
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
  _workspacePath?: string
): Promise<string | null> {
  // Map object type to symbol type
  const typeMap: Record<string, string> = {
    class: 'class',
    table: 'table',
    form: 'form',
    enum: 'enum',
    query: 'query',
    view: 'view',
  };

  const symbolType = typeMap[objectType];
  if (!symbolType) {
    throw new Error(`Unsupported object type: ${objectType}`);
  }

  // Query database
  let stmt;
  if (modelName) {
    stmt = symbolIndex.db.prepare(`
      SELECT file_path
      FROM symbols
      WHERE type = ? AND name = ? AND model = ?
      LIMIT 1
    `);
    const row = stmt.get(symbolType, objectName, modelName);
    return row ? row.file_path : null;
  } else {
    stmt = symbolIndex.db.prepare(`
      SELECT file_path
      FROM symbols
      WHERE type = ? AND name = ?
      ORDER BY model
      LIMIT 1
    `);
    const row = stmt.get(symbolType, objectName);
    return row ? row.file_path : null;
  }
}

/**
 * Create file backup
 */
async function createFileBackup(filePath: string): Promise<void> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
  const backupPath = `${filePath}.backup-${timestamp}`;
  await fs.copyFile(filePath, backupPath);
}

/**
 * Add method to class/table/form
 */
async function addMethod(xmlObj: any, objectType: string, args: any): Promise<boolean> {
  const { methodName, methodCode, methodModifiers: _methodModifiers, methodReturnType: _methodReturnType, methodParameters: _methodParameters } = args;

  if (!methodName) {
    throw new Error('methodName is required for add-method operation');
  }

  // Navigate to Methods node
  const rootKey = getRootKey(objectType);
  const root = xmlObj[rootKey];

  if (!root) {
    throw new Error(`Invalid XML structure: root element <${rootKey}> not found`);
  }

  // Methods are always under SourceCode > Methods for all D365FO object types
  // (AxClass, AxTable, AxForm all use <SourceCode><Methods>...</Methods></SourceCode>)
  let methodsContainer: any;
  if (!root.SourceCode) {
    root.SourceCode = [{ Methods: [{ Method: [] }] }];
  }
  methodsContainer = root.SourceCode[0];

  let methodsNode = methodsContainer.Methods;
  if (!methodsNode) {
    methodsContainer.Methods = [{ Method: [] }];
    methodsNode = methodsContainer.Methods;
  }

  if (!methodsNode[0].Method) {
    methodsNode[0].Method = [];
  }

  // Create method node
  const newMethod = {
    Name: [methodName],
    Source: [methodCode || `// TODO: Implement ${methodName}\nreturn;`],
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

  // Methods are always under SourceCode > Methods for all D365FO object types
  const methodsContainer = root.SourceCode?.[0];
  if (!methodsContainer?.Methods?.[0]?.Method) {
    throw new Error('No methods found in object');
  }

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
  const { fieldName, fieldType, fieldMandatory, fieldLabel } = args;

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

  // Ensure Fields container exists
  if (!root.Fields || root.Fields === '') {
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
  const iType = getFieldNodeName(fieldType);
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

  if (!root?.Fields?.[0]?.AxTableField) {
    throw new Error('No fields found in table');
  }

  const fields = root.Fields[0].AxTableField;
  const index = fields.findIndex((f: any) => {
    // Field might be wrapped in different type nodes
    const fieldObj = Object.values(f)[0];
    return Array.isArray(fieldObj) && fieldObj[0].Name && fieldObj[0].Name[0] === fieldName;
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
  };

  const key = keyMap[objectType];
  if (!key) {
    throw new Error(`Unknown object type: ${objectType}`);
  }

  return key;
}

/**
 * Get field node name based on field type
 */
function getFieldNodeName(fieldType: string): string {
  // Map EDT to field node type
  const typeMap: Record<string, string> = {
    String: 'AxTableFieldString',
    Integer: 'AxTableFieldInt',
    Real: 'AxTableFieldReal',
    Date: 'AxTableFieldDate',
    DateTime: 'AxTableFieldDateTime',
    Enum: 'AxTableFieldEnum',
    Int64: 'AxTableFieldInt64',
    GUID: 'AxTableFieldGuid',
  };

  // Default to string if unknown
  return typeMap[fieldType] || 'AxTableFieldString';
}

export const modifyD365FileToolDefinition = {
  name: 'modify_d365fo_file',
  description: '✏️ Edit existing D365FO XML files (AxClass, AxTable, AxForm, etc.). Supports atomic operations: add/remove methods, add/remove fields, modify properties. Creates automatic backups. Use this instead of manual file editing to ensure correct XML structure.',
  inputSchema: ModifyD365FileArgsSchema,
};
