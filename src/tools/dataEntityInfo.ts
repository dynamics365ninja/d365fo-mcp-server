/**
 * Data Entity Info Tool
 * Retrieve rich D365FO-specific metadata for data entities (OData, DMF, staging, sources)
 */

import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { XppServerContext } from '../types/context.js';

const DataEntityInfoArgsSchema = z.object({
  entityName: z.string().describe('Name of the data entity (AxDataEntityView)'),
});

export async function dataEntityInfoTool(request: CallToolRequest, context: XppServerContext) {
  try {
    const args = DataEntityInfoArgsSchema.parse(request.params.arguments);
    const db = context.symbolIndex.db;

    // Data entities are indexed under type='view' (they derive from AxDataEntityView)
    // Also check data-entity-extension as those are indexed separately
    const symbol = db.prepare(
      `SELECT name, type, description, signature, model, file_path, source_snippet
       FROM symbols WHERE name = ? AND type IN ('view', 'data-entity-extension')
       ORDER BY CASE WHEN type='view' THEN 0 ELSE 1 END LIMIT 1`
    ).get(args.entityName) as any;

    if (!symbol) {
      // Search using FTS
      const suggestions = db.prepare(
        `SELECT name, type, model FROM symbols
         WHERE type = 'view' AND name LIKE ?
         ORDER BY name LIMIT 10`
      ).all(`%${args.entityName}%`) as any[];

      let text = `Data entity not found: ${args.entityName}\n`;
      if (suggestions.length > 0) {
        text += '\nSimilar views/entities:\n';
        for (const s of suggestions) {
          text += `  ${s.name} (${s.model})\n`;
        }
      }
      text += '\nTip: Data entities are views — try searching with type="view".';
      return { content: [{ type: 'text', text }] };
    }

    let output = `DataEntity: ${symbol.name}\n`;
    output += `Model: ${symbol.model}\n`;
    if (symbol.description) output += `Description: ${symbol.description}\n`;

    // Try to parse D365FO-specific properties from source_snippet or signature
    // These were stored during indexing if available
    const sig = (symbol.signature || '') as string;
    // source_snippet available for additional parsing if needed

    // Entity category (stored in signature during indexing, or infer from name)
    if (sig.includes('EntityCategory:')) {
      const catMatch = sig.match(/EntityCategory:\s*(\w+)/);
      if (catMatch) output += `Category: ${catMatch[1]}\n`;
    } else {
      // Infer category from common naming patterns
      const nameUpper = symbol.name.toUpperCase();
      if (nameUpper.endsWith('V2ENTITY') || nameUpper.endsWith('V3ENTITY') || nameUpper.endsWith('ENTITY')) {
        output += `Type: Data Entity (AxDataEntityView)\n`;
      }
    }

    // Public name for OData (often EntityName without "Entity" suffix)
    const publicNameMatch = sig.match(/PublicEntityName:\s*(\w+)/);
    if (publicNameMatch) {
      output += `Public Name: ${publicNameMatch[1]} (OData resource name)\n`;
    }

    const collectionMatch = sig.match(/PublicCollectionName:\s*(\w+)/);
    if (collectionMatch) {
      output += `Collection: ${collectionMatch[1]}\n`;
    }

    // OData / DMF enabled flags
    if (sig.includes('IsPublic:true') || sig.includes('IsPublic: true')) {
      output += `OData Enabled: Yes\n`;
    }
    if (sig.includes('DataManagementEnabled:true') || sig.includes('DataManagementEnabled: true')) {
      output += `Data Management (DMF): Yes\n`;
    }

    // Staging table (usually EntityName + 'Staging')
    const stagingMatch = sig.match(/StagingTable:\s*(\w+)/);
    if (stagingMatch) {
      output += `Staging Table: ${stagingMatch[1]}\n`;
    } else {
      // Common convention: check if a table with <EntityName minus 'Entity'>Staging exists
      const baseName = symbol.name.replace(/Entity$/, '').replace(/V\d+$/, '');
      const stagingTable = db.prepare(
        `SELECT name FROM symbols WHERE type='table' AND name LIKE ? LIMIT 1`
      ).get(`${baseName}%Staging`) as any;
      if (stagingTable) {
        output += `Staging Table (inferred): ${stagingTable.name}\n`;
      }
    }

    // Data sources: fields from this entity that come from different parent tables
    const fields = db.prepare(
      `SELECT name, signature FROM symbols
       WHERE parent_name = ? AND type = 'field'
       ORDER BY name`
    ).all(args.entityName) as any[];

    if (fields.length > 0) {
      // Extract unique source tables from field signatures
      const sourceTables = new Set<string>();
      for (const f of fields) {
        const srcMatch = (f.signature || '').match(/\[(\w+)\]/);
        if (srcMatch) sourceTables.add(srcMatch[1]);
      }

      output += `\nFields (${fields.length}): `;
      const fieldNames = fields.slice(0, 8).map((f: any) => f.name);
      output += fieldNames.join(', ');
      if (fields.length > 8) output += ` ... (+${fields.length - 8} more)`;
      output += '\n';

      if (sourceTables.size > 0) {
        output += `\nData Sources (${sourceTables.size}): ${[...sourceTables].join(', ')}\n`;
      }
    }

    // Methods (computed columns, virtual fields)
    const methods = db.prepare(
      `SELECT name, signature FROM symbols
       WHERE parent_name = ? AND type = 'method'
       ORDER BY name`
    ).all(args.entityName) as any[];

    if (methods.length > 0) {
      const computedCols = methods.filter((m: any) =>
        (m.signature || '').includes('display') ||
        (m.name || '').startsWith('get') ||
        (m.signature || '').includes('SysComputedColumn')
      );
      if (computedCols.length > 0) {
        output += `\nComputed/Virtual Columns (${computedCols.length}): `;
        output += computedCols.slice(0, 5).map((m: any) => m.name).join(', ');
        if (computedCols.length > 5) output += ` (+${computedCols.length - 5} more)`;
        output += '\n';
      }
    }

    // Keys
    const keys = db.prepare(
      `SELECT name FROM symbols WHERE parent_name = ? AND type = 'index' ORDER BY name`
    ).all(args.entityName) as any[];
    if (keys.length > 0) {
      output += `\nKeys: ${keys.map((k: any) => k.name).join(', ')}\n`;
    }

    if (symbol.file_path) {
      output += `\nSource: ${symbol.file_path}\n`;
    }

    return { content: [{ type: 'text', text: output }] };
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `Error getting data entity info: ${error instanceof Error ? error.message : 'Unknown error'}`,
        },
      ],
      isError: true,
    };
  }
}
