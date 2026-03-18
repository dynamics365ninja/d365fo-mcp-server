import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import { XppMetadataParser } from '../metadata/xmlParser.js';
import type { XppServerContext } from '../types/context.js';
import type { XppSymbol } from '../metadata/types.js';

export const updateSymbolIndexToolDefinition = {
  name: 'update_symbol_index',
  description: 'Index a newly generated or modified D365FO XML file immediately so references to it work without restarting the server.',
  parameters: z.object({
    filePath: z.string().describe('The absolute path to the modified or created XML file')
  })
};

/** Map AOT folder names to symbol types */
const AOT_FOLDER_TYPE_MAP: Record<string, XppSymbol['type']> = {
  'axclass': 'class',
  'axtable': 'table',
  'axtableextension': 'table-extension',
  'axform': 'form',
  'axformextension': 'form-extension',
  'axenum': 'enum',
  'axenumsextension': 'enum-extension',
  'axedt': 'edt',
  'axedtsextension': 'edt-extension',
  'axquery': 'query',
  'axview': 'view',
  'axreport': 'report',
  'axsecurityprivilege': 'security-privilege',
  'axsecurityduty': 'security-duty',
  'axsecurityrole': 'security-role',
  'axmenuitemaction': 'menu-item-action',
  'axmenuitemdisplay': 'menu-item-display',
  'axmenuitemoutput': 'menu-item-output',
};

/**
 * Extract model name from AOT file path.
 * Pattern: {packagesRoot}\{package}\{model}\Ax{Type}\{Name}.xml
 * or:      {packagesRoot}\{model}\{model}\Ax{Type}\{Name}.xml
 */
function extractModelFromPath(filePath: string): string | null {
  const parts = filePath.replace(/\//g, '\\').split('\\');
  // Find the AOT folder index (e.g. AxClass, AxTable)
  const aotIdx = parts.findIndex(p => p.toLowerCase() in AOT_FOLDER_TYPE_MAP);
  if (aotIdx >= 2) {
    return parts[aotIdx - 1]; // folder immediately before the AOT folder = model name
  }
  return null;
}

export const updateSymbolIndexTool = async (params: any, context: XppServerContext) => {
  const { filePath } = params;
  try {
    if (!fs.existsSync(filePath)) {
      return {
        content: [{ type: 'text', text: `⚠️ File not found at ${filePath}` }]
      };
    }

    const { symbolIndex } = context;
    const parser = new XppMetadataParser();
    const objectName = path.parse(filePath).name;
    const parts = filePath.replace(/\//g, '\\').split('\\');
    const aotFolder = parts.find((p: string) => p.toLowerCase() in AOT_FOLDER_TYPE_MAP) ?? '';
    const objectType: XppSymbol['type'] = AOT_FOLDER_TYPE_MAP[aotFolder.toLowerCase()] ?? 'class';
    const model = extractModelFromPath(filePath) ?? 'Unknown';

    console.error(`[update_symbol_index] Re-indexing ${objectType} "${objectName}" (model: ${model})`);

    // 1. Remove all existing symbols for this file so stale entries don't linger
    const deleted = symbolIndex.db
      .prepare(`DELETE FROM symbols WHERE file_path = ?`)
      .run(filePath);
    const deletedCount = deleted.changes;

    // 2. Re-parse the XML and insert fresh symbols
    let insertedCount = 0;
    const tx = symbolIndex.db.transaction(() => {
      // Minimal fallback for types not handled individually below
      symbolIndex.addSymbol({
        name: objectName,
        type: objectType,
        filePath,
        model,
      });
      insertedCount++;
    });

    // For classes and tables, parse XML to get methods/fields too
    if (objectType === 'class') {
      const result = await parser.parseClassFile(filePath, model);
      if (result.success && result.data) {
        const classData = result.data;
        const insert = symbolIndex.db.transaction(() => {
          symbolIndex.addSymbol({
            name: classData.name,
            type: 'class',
            signature: classData.extends ? `extends ${classData.extends}` : undefined,
            filePath,
            model,
            description: classData.documentation,
            extendsClass: classData.extends,
            implementsInterfaces: classData.implements?.join(', '),
          });
          insertedCount++;
          for (const method of classData.methods ?? []) {
            const params = method.parameters?.map((p: any) => `${p.type} ${p.name}`).join(', ') ?? '';
            symbolIndex.addSymbol({
              name: method.name,
              type: 'method',
              parentName: classData.name,
              signature: `${method.returnType} ${method.name}(${params})`,
              filePath,
              model,
              source: method.source,
            });
            insertedCount++;
          }
        });
        insert();
      } else {
        // Fallback: just index the object name
        tx();
      }
    } else if (objectType === 'table') {
      const result = await parser.parseTableFile(filePath, model);
      if (result.success && result.data) {
        const tableData = result.data;
        const insert = symbolIndex.db.transaction(() => {
          symbolIndex.addSymbol({
            name: tableData.name,
            type: 'table',
            filePath,
            model,
          });
          insertedCount++;
          for (const field of tableData.fields ?? []) {
            symbolIndex.addSymbol({
              name: field.name,
              type: 'field',
              parentName: tableData.name,
              signature: field.type,
              filePath,
              model,
            });
            insertedCount++;
          }
        });
        insert();
      } else {
        tx();
      }
    } else if (objectType === 'edt') {
      const result = await parser.parseEdtFile(filePath, model);
      if (result.success && result.data) {
        const edtData = result.data as any;
        symbolIndex.addSymbol({
          name: edtData.name ?? objectName,
          type: 'edt',
          signature: edtData.extends ?? undefined,
          filePath,
          model,
        });
        insertedCount++;
      } else {
        tx();
      }
    } else if (objectType === 'form' || objectType === 'form-extension') {
      const result = await parser.parseFormFile(filePath, model);
      if (result.success && result.data) {
        const formData = result.data as any;
        symbolIndex.addSymbol({
          name: formData.name ?? objectName,
          type: objectType,
          filePath,
          model,
        });
        insertedCount++;
      } else {
        tx();
      }
    } else {
      tx();
    }

    return {
      content: [{
        type: 'text',
        text: `✅ Symbol index updated for **${objectName}** (${objectType}, model: ${model}).\n\n` +
          `Removed: ${deletedCount} stale entr${deletedCount === 1 ? 'y' : 'ies'}\n` +
          `Inserted: ${insertedCount} symbol${insertedCount !== 1 ? 's' : ''}`
      }]
    };
  } catch (error: any) {
    console.error('Error updating symbol index:', error);
    return {
      content: [{ type: 'text', text: `❌ Error updating symbol index: ${error.message}` }],
      isError: true
    };
  }
};
