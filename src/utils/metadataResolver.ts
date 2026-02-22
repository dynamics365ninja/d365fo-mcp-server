/**
 * Metadata Resolver
 *
 * Resolves D365FO object metadata from the local extracted-metadata/ folder.
 * The SQLite DB stores file_path values that point to the Azure DevOps build-agent
 * (e.g. C:\home\vsts\work\1\...) which is never accessible at runtime.
 * Instead, this module reads the pre-extracted JSON/XML from extracted-metadata/.
 *
 * Folder layout:
 *   extracted-metadata/{ModelName}/classes/{ClassName}.json   → { name, model, methods[], ... }
 *   extracted-metadata/{ModelName}/enums/{EnumName}.json      → { raw: "<xml>..." }
 *   extracted-metadata/{ModelName}/tables/{TableName}.json    → { name, model, fields[], ... }
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

// Resolve path relative to this file, not to process.cwd()
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTRACTED_METADATA_BASE = path.resolve(__dirname, '../../extracted-metadata');

export type ExtractedObjectType = 'classes' | 'enums' | 'tables' | 'views';

export interface ExtractedViewField {
  name: string;
  dataSource?: string;
  dataField?: string;
  dataMethod?: string;
  isComputed: boolean;
}

export interface ExtractedViewRelation {
  name: string;
  relatedTable: string;
  relationType: string;
  cardinality: string;
}

export interface ExtractedViewMetadata {
  name: string;
  model: string;
  sourcePath: string;
  type: 'view' | 'data-entity';
  label?: string;
  isPublic?: boolean;
  isReadOnly?: boolean;
  primaryKey?: string;
  fields: ExtractedViewField[];
  relations: ExtractedViewRelation[];
  methods: Array<{ name: string } | string>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Path helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the absolute path to an extracted-metadata JSON file.
 * Returns null if the file doesn't exist (no throw).
 */
export async function resolveMetadataJsonPath(
  model: string,
  objectType: ExtractedObjectType,
  name: string
): Promise<string | null> {
  const filePath = path.join(EXTRACTED_METADATA_BASE, model, objectType, `${name}.json`);
  try {
    await fs.access(filePath);
    return filePath;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Class metadata
// ─────────────────────────────────────────────────────────────────────────────

export interface ExtractedMethodParam {
  type: string;
  name: string;
  defaultValue?: string;
}

export interface ExtractedMethod {
  name: string;
  visibility: string;
  returnType: string;
  parameters: ExtractedMethodParam[];
  isStatic: boolean;
  source?: string;
  sourceSnippet?: string;
}

export interface ExtractedClassMetadata {
  name: string;
  model: string;
  sourcePath: string;
  declaration?: string;
  extends?: string;
  implements?: string[];
  isAbstract?: boolean;
  isFinal?: boolean;
  methods: ExtractedMethod[];
}

/**
 * Read class metadata from extracted-metadata JSON.
 * Returns null if the file is not available.
 */
export async function readClassMetadata(
  model: string,
  className: string
): Promise<ExtractedClassMetadata | null> {
  const filePath = await resolveMetadataJsonPath(model, 'classes', className);
  if (!filePath) return null;

  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    const data = JSON.parse(raw) as ExtractedClassMetadata;

    // Normalise parameter format: parameters may be stored as raw "@{type=X; name=Y}" strings
    for (const method of data.methods ?? []) {
      method.parameters = (method.parameters ?? []).map((p: any) => {
        if (typeof p === 'string') {
          // Parse "@{type=RecId; name=_legalEntityRecId}" PowerShell serialization
          const typeMatch = p.match(/type=([^;}\s]+)/);
          const nameMatch = p.match(/name=([^;}\s]+)/);
          return {
            type: typeMatch?.[1] ?? 'var',
            name: nameMatch?.[1] ?? '_param',
          } as ExtractedMethodParam;
        }
        return p as ExtractedMethodParam;
      });
    }

    return data;
  } catch {
    return null;
  }
}

/**
 * Read a specific method from extracted class metadata.
 */
export async function readMethodMetadata(
  model: string,
  className: string,
  methodName: string
): Promise<ExtractedMethod | null> {
  const classData = await readClassMetadata(model, className);
  if (!classData) return null;

  return classData.methods.find(m => m.name === methodName) ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Enum metadata (raw XML embedded in JSON)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Read the raw XML string from an extracted-metadata enum JSON file.
 * Returns null if not available.
 */
export async function readEnumRawXml(
  model: string,
  enumName: string
): Promise<string | null> {
  const filePath = await resolveMetadataJsonPath(model, 'enums', enumName);
  if (!filePath) return null;

  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    const data = JSON.parse(raw);
    return typeof data.raw === 'string' ? data.raw : null;
  } catch {
    return null;
  }
}

export async function readViewMetadata(
  model: string,
  viewName: string
): Promise<ExtractedViewMetadata | null> {
  const filePath = await resolveMetadataJsonPath(model, 'views', viewName);
  if (!filePath) return null;

  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(raw) as ExtractedViewMetadata;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Generic "not available" message for objects without extracted metadata
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// Type-mismatch detection (shared across tools)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Query the symbol index DB to find what top-level types a given name exists as.
 * Ignores 'method' and 'field' rows — those are children, not top-level objects.
 *
 * @param db - better-sqlite3 Database instance (symbolIndex.db)
 * @param name - the object name to look up
 */
export function detectObjectTypeInDb(
  db: any,
  name: string
): Array<{ type: string; model: string }> {
  try {
    const stmt = db.prepare(`
      SELECT DISTINCT type, model
      FROM symbols
      WHERE name = ?
        AND type NOT IN ('method', 'field')
      ORDER BY type
      LIMIT 10
    `);
    return stmt.all(name) as Array<{ type: string; model: string }>;
  } catch {
    return [];
  }
}

/**
 * Build a Markdown warning section when an object was looked up as one type
 * (e.g. 'class') but actually exists in the DB as a different type (form, table …).
 *
 * Returns an empty string when no mismatch is detected.
 *
 * @param db           - better-sqlite3 Database instance
 * @param name         - the object name that was not found
 * @param expectedType - the type that was searched for (default: 'class')
 */
export function buildObjectTypeMismatchMessage(
  db: any,
  name: string,
  expectedType: string = 'class'
): string {
  const existingTypes = detectObjectTypeInDb(db, name);
  if (existingTypes.length === 0) return '';

  const expectedEntries = existingTypes.filter(t => t.type === expectedType);
  const otherEntries = existingTypes.filter(t => t.type !== expectedType);

  // Only emit a warning when the object does NOT exist as the expected type
  if (expectedEntries.length > 0 || otherEntries.length === 0) return '';

  let section = `\n\n⚠️ **Type Mismatch:** \`${name}\` is not a **${expectedType}** — it exists in the index as:\n\n`;
  for (const entry of otherEntries) {
    section += `- **${entry.type}** (model: ${entry.model})\n`;
  }

  const uniqueTypes = [...new Map(otherEntries.map(e => [e.type, e])).values()];
  section += `\n💡 **Use the correct tool instead:**\n`;
  for (const entry of uniqueTypes) {
    switch (entry.type) {
      case 'form':
        section += `- \`get_form_info(formName="${name}")\` — inspect form datasources, controls, and methods\n`;
        break;
      case 'table':
        section += `- \`get_table_info(tableName="${name}")\` — inspect table fields and methods\n`;
        break;
      case 'view':
        section += `- \`get_view_info(viewName="${name}")\` — inspect view fields and methods\n`;
        break;
      case 'query':
        section += `- \`get_query_info(queryName="${name}")\` — inspect query datasources\n`;
        break;
      case 'enum':
        section += `- \`get_enum_info(enumName="${name}")\` — inspect enum values\n`;
        break;
    }
  }

  return section;
}

/**
 * Build a friendly error explaining that the XML for this object type
 * is not available in the current deployment (no D365FO installation).
 */
export function buildXmlNotAvailableMessage(
  objectType: string,
  objectName: string,
  dbFilePath: string
): string {
  return (
    `❌ Cannot read ${objectType} metadata for "${objectName}".\n\n` +
    `The metadata database was built on an Azure DevOps build agent and stores file paths\n` +
    `that are not accessible in the current environment:\n` +
    `  ${dbFilePath}\n\n` +
    `To use this tool you need either:\n` +
    `1. Run the MCP server locally on a D365FO Windows VM where that path exists, OR\n` +
    `2. Ensure the ${objectType} XML files are accessible at the path above.\n\n` +
    `Note: ${objectType}s are not included in the pre-extracted JSON metadata (classes/tables/enums, and now views when extraction is run with latest parser).`
  );
}
