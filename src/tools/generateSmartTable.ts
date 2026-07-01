/**
 * Generate Smart Table Tool
 * AI-driven table generation using indexed metadata patterns
 */

import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { XppSymbolIndex } from '../metadata/symbolIndex.js';
import { SmartXmlBuilder, TableFieldSpec, TableIndexSpec, TableRelationSpec } from '../utils/smartXmlBuilder.js';
import { bridgeCreateSmartTable } from '../bridge/index.js';
import type { BridgeClient } from '../bridge/bridgeClient.js';
import path from 'path';
import fs from 'fs';
import { getConfigManager } from '../utils/configManager.js';
import { resolveObjectPrefix, applyObjectPrefix, getObjectSuffix, applyObjectSuffix } from '../utils/modelClassifier.js';
import { ProjectFileManager } from './createD365File.js';
import { extractModelFromProject, findProjectInSolution } from '../utils/projectUtils.js';
import { normalizeD365Xml } from '../utils/d365XmlNormalizer.js';

interface GenerateSmartTableArgs {
  name: string;
  label?: string;
  tableGroup?: string;
  /**
   * Table storage type. Defined by the TableType property (source: MSDN).
   *   Regular / RegularTable — DEFAULT. Permanent table stored in the main database.
   *   TempDB                 — Temporary table in SQL Server TempDB. Dropped when no longer used
   *                            by the current method. Joins/set operations are efficient.
   *   InMemory               — Temporary ISAM file on AOS/client tier. SQL Server has no connection.
   *                            Joins/set operations are usually INEFFICIENT. Same as old AX 2009 "Temporary".
   */
  tableType?: string;
  copyFrom?: string;
  fieldsHint?: string;
  primaryKeyFields?: string[];
  generateCommonFields?: boolean;
  modelName?: string;
  projectPath?: string;
  solutionPath?: string;
  packagePath?: string;
  /**
   * Standard method names to generate and embed in the XML.
   * Supported: "find", "exist"
   * Example: ["find", "exist"]
   */
  methods?: string[];
}

export const generateSmartTableTool: Tool = {
  name: 'generate_smart_table',
  description: 'Generate AxTable XML with AI-driven field/index/relation suggestions based on indexed patterns. Can copy structure from existing tables, analyze table group patterns, or use field hints.',
  inputSchema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'Table name (e.g., "MyCustomTable")',
      },
      label: {
        type: 'string',
        description: 'Optional label for the table',
      },
      tableGroup: {
        type: 'string',
        description:
          'Table group (business role). Defined by the system enum TableGroup (source: MSDN). ' +
          'Valid values: ' +
          '"Miscellaneous" = DEFAULT for new tables, does not fit other categories (e.g. TableExpImpDef); ' +
          '"Main" = principal/master table for a central business object, static base data (e.g. CustTable, VendTable); ' +
          '"Transaction" = transaction data, usually not edited directly (e.g. CustTrans, VendTrans); ' +
          '"Parameter" = setup/parameter data for a Main table, typically one record per company (e.g. CustParameters); ' +
          '"Group" = categorisation for a Main table, one-to-many with Main (e.g. CustGroup, VendGroup); ' +
          '"WorksheetHeader" = worksheet header that categorises WorksheetLine rows (e.g. SalesTable); ' +
          '"WorksheetLine" = lines to be validated and turned into transactions, may be deleted safely (e.g. SalesLine); ' +
          '"Reference" = shared reference/lookup data across modules; ' +
          '"Framework" = internal Microsoft framework/infrastructure tables. ' +
          '⛔ NEVER pass "TempDB" or "InMemory" here — those are TableType values, NOT TableGroup values. ' +
          'For temporary tables use tableType="TempDB" and keep tableGroup as "Main" (typical choice for Tmp tables).',
      },
      tableType: {
        type: 'string',
        description:
          'Table storage type (TableType property, source: MSDN). Valid values: ' +
          '"Regular" / "RegularTable" = DEFAULT, permanent table in main database — omit for regular tables; ' +
          '"TempDB" = temporary table in SQL Server TempDB, dropped when no longer used by current method, ' +
          'joins and set operations are EFFICIENT — use for SSRS report tmp tables and session-scoped data; ' +
          '"InMemory" = temporary ISAM file on AOS/client tier, SQL Server has no connection to it, ' +
          'joins and set operations are usually INEFFICIENT — equivalent to old AX 2009 "Temporary" property. ' +
          '⛔ NEVER pass this value as tableGroup — they are completely separate properties.',
      },
      copyFrom: {
        type: 'string',
        description: 'Optional: Copy structure from existing table (name)',
  },
      fieldsHint: {
        type: 'string',
        description:
          'REQUIRED when the user mentions any fields, columns, or data. ' +
          'Extract ALL field names from the user description and pass them here as a comma-separated list. ' +
          'WITHOUT this parameter only generic default fields are generated and the table will be INCOMPLETE. ' +
          'Natural language → fieldsHint mapping examples: ' +
          '"Account number" → "AccountNum", ' +
          '"Name" → "Name", ' +
          '"Description" or "popis" → "Description", ' +
          '"platnost od" or "ValidFrom" or "from date" → "ValidFrom", ' +
          '"platnost do" or "ValidTo" or "to date" → "ValidTo", ' +
          '"active" or "active flag" → "Active", ' +
          '"customer" or "customer account" → "CustAccount". ' +
          'Example call: fieldsHint="AccountNum, Name, Description, ValidFrom, ValidTo". ' +
          '⚠️ EDT auto-suggestion is index-based: custom EDTs/enums created in the SAME SESSION are not yet in the ' +
          'index and those fields will fall back to String255. Call update_symbol_index BEFORE scaffolding to ensure ' +
          'the new custom EDTs are resolved correctly.',
      },
      primaryKeyFields: {
        type: 'array',
        items: { type: 'string' },
        description:
          'REQUIRED when user specifies a composite primary key (multiple fields). ' +
          'List ALL fields that form the primary key index. ' +
          'Without this, only the first mandatory field is used as PK — composite PKs will be WRONG. ' +
          'Example: user says "primary key is Account number and Name" → primaryKeyFields=["AccountNum", "Name"]. ' +
          'Single-field PK can be omitted — the tool auto-detects it from fieldsHint mandatory fields.',
      },
      generateCommonFields: {
        type: 'boolean',
        description: 'If true, analyze table group patterns and generate common fields automatically',
      },
      modelName: {
        type: 'string',
        description: 'Model name for file creation (auto-detected from projectPath)',
      },
      projectPath: {
        type: 'string',
        description: 'Path to .rnrproj file (used to extract correct ModelName)',
      },
      solutionPath: {
        type: 'string',
        description: 'Path to solution directory (alternative to projectPath)',
      },
      packagePath: {
        type: 'string',
        description:
          'Base packages directory path (e.g. "C:\\AosService\\PackagesLocalDirectory"). ' +
          'Auto-detected from .mcp.json; only needed when the default K: fallback is wrong.',
      },
      methods: {
        type: 'array',
        items: { type: 'string' },
        description:
          'ALWAYS pass ["find", "exist"] when the user asks for those methods. ' +
          'Methods are embedded directly in the generated XML. ' +
          'Supported values: "find", "exist". ' +
          '⛔ NEVER omit this and then call d365fo_file(action="modify") to add methods afterwards — ' +
          'd365fo_file(action="modify") CANNOT write files on Azure/Linux.',
      },
    },
    required: ['name'],
  },
};

export async function handleGenerateSmartTable(
  args: GenerateSmartTableArgs,
  symbolIndex: XppSymbolIndex,
  bridge?: BridgeClient,
): Promise<any> {
  const {
    name,
    label,
    tableGroup = 'Main',
    tableType,
    copyFrom,
    fieldsHint,
    primaryKeyFields,
    generateCommonFields,
    modelName,
    projectPath,
    solutionPath,
    packagePath: argPackagePath,
    methods: requestedMethods,
  } = args;

  // Guard: 'TempDB' and 'InMemory' are NOT valid TableGroup values.
  if (tableGroup === 'TempDB' || tableGroup === 'InMemory') {
    return {
      content: [{
        type: 'text',
        text: [
          `❌ **Invalid parameter: tableGroup="${tableGroup}"**`,
          ``,
          `'${tableGroup}' is a **TableType** value, NOT a **TableGroup** value.`,
          `These are two completely different D365FO table properties:`,
          ``,
          `| Property | Purpose | Valid values |`,
          `|----------|---------|--------------|`,
          `| **TableType** | Storage type | RegularTable, TempDB, InMemory |`,
          `| **TableGroup** | Business role | Miscellaneous (default), Main, Transaction, Parameter, Group, WorksheetHeader, WorksheetLine, Reference, Framework |`,
          ``,
          `TableGroup meanings (source: MSDN / system enum TableGroup):`,
          `  Miscellaneous   — DEFAULT for new tables; does not fit any other category`,
          `  Main            — master/base object table, static data (e.g. CustTable, VendTable)`,
          `  Transaction     — transaction data, not edited directly (e.g. CustTrans, VendTrans)`,
          `  Parameter       — setup data for a Main table, usually one record/company (e.g. CustParameters)`,
          `  Group           — categorisation for a Main table, one-to-many with Main (e.g. CustGroup)`,
          `  WorksheetHeader — worksheet header, one-to-many with WorksheetLine (e.g. SalesTable)`,
          `  WorksheetLine   — lines to validate → transactions, may be deleted safely (e.g. SalesLine)`,
          `  Reference       — shared reference/lookup data across modules`,
          `  Framework       — internal Microsoft framework/infrastructure tables`,
          ``,
          `🔄 **Call generate again** with the corrected parameters:`,
          `\`\`\``,
          `generate_object(mode="scaffold", `,
          `  objectType="table",`,
          `  name="${name}",`,
          `  tableType="${tableGroup}",       ← move here`,
          `  tableGroup="Main",               ← use a valid TableGroup value`,
          `  fieldsHint="...",`,
          `)`,
          `\`\`\``,
        ].join('\n'),
      }],
      isError: true,
    };
  }

  console.log(`[generateSmartTable] Generating table: ${name}, tableGroup=${tableGroup}, tableType=${tableType ?? 'Regular'}, copyFrom=${copyFrom}`);
  const builder = new SmartXmlBuilder(symbolIndex);
  let fields: TableFieldSpec[] = [];
  let indexes: TableIndexSpec[] = [];
  let relations: TableRelationSpec[] = [];
  let usedFallback = false; // true when fieldsHint was missing and generic defaults were used

  // Strategy 1: Copy from existing table
  if (copyFrom) {
    console.log(`[generateSmartTable] Copying structure from: ${copyFrom}`);
    try {
      const db = symbolIndex.getReadDb();

      // Copy fields directly from the symbols DB
      const dbFields = db.prepare(`
        SELECT name, signature FROM symbols
        WHERE type = 'field' AND parent_name = ?
        ORDER BY name
      `).all(copyFrom) as Array<{ name: string; signature: string }>;

      if (dbFields.length === 0) {
        throw new Error(`Table "${copyFrom}" not found or has no indexed fields`);
      }

      fields = dbFields.map((f: { name: string; signature: string }) => ({
        name: f.name,
        edt: f.signature || undefined,
      }));

      // Copy relations from table_relations
      const dbRelations = db.prepare(`
        SELECT relation_name, target_table, constraint_fields FROM table_relations
        WHERE source_table = ?
      `).all(copyFrom) as Array<{ relation_name: string; target_table: string; constraint_fields: string | null }>;

      relations = dbRelations.map((rel: { relation_name: string; target_table: string; constraint_fields: string | null }) => ({
        name: rel.relation_name.replace(copyFrom, name),
        targetTable: rel.target_table,
        constraints: rel.constraint_fields ? JSON.parse(rel.constraint_fields) : [],
      }));

      console.log(`[generateSmartTable] Copied ${fields.length} fields, ${relations.length} relations from ${copyFrom}`);
    } catch (error) {
      console.error(`[generateSmartTable] Failed to copy from ${copyFrom}:`, error);
      throw new Error(`Failed to copy structure from ${copyFrom}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // Strategy 2: Generate common fields based on table group patterns.
  // Skipped when explicit fieldsHint is given (the caller stated the fields).
  if (generateCommonFields && !copyFrom && !fieldsHint) {
    console.log(`[generateSmartTable] Analyzing patterns for table group: ${tableGroup}`);
    try {
      const db = symbolIndex.getReadDb();

      // Use heuristic name patterns (matching analyzeTableGroup logic)
      const namePatterns: Record<string, string> = {
        Transaction: '%Trans%',
        Parameter: '%Parameters',
        Main: '%Table',
      };
      const namePattern = namePatterns[tableGroup];

      const sampleTables = db.prepare(`
        SELECT DISTINCT name FROM symbols
        WHERE type = 'table'
        ${namePattern ? 'AND name LIKE ?' : ''}
        LIMIT 20
      `).all(...(namePattern ? [namePattern] : [])) as Array<{ name: string }>;

      if (sampleTables.length > 0) {
        // Build field frequency map
        const fieldFrequency = new Map<string, { edt: string; count: number }>();
        for (const table of sampleTables) {
          const tableFields = db.prepare(`
            SELECT name, signature FROM symbols
            WHERE type = 'field' AND parent_name = ?
          `).all(table.name) as Array<{ name: string; signature: string }>;

          for (const field of tableFields) {
            if (!field.signature) continue;
            const key = `${field.name}:${field.signature}`;
            const existing = fieldFrequency.get(key);
            if (existing) {
              existing.count++;
            } else {
              fieldFrequency.set(key, { edt: field.signature, count: 1 });
            }
          }
        }

        // Add fields appearing in 30%+ of sample tables, excluding infrastructure fields.
        const threshold = Math.max(1, Math.floor(sampleTables.length * 0.3));
        const commonFields = Array.from(fieldFrequency.entries())
          .filter(([key, data]) => data.count >= threshold && !isInfrastructureField(key.split(':')[0]))
          .sort((a, b) => b[1].count - a[1].count)
          .slice(0, 10);

        for (const [key, data] of commonFields) {
          const fieldName = key.split(':')[0];
          if (!fields.find(f => f.name === fieldName)) {
            fields.push({ name: fieldName, edt: data.edt });
          }
        }

        console.log(`[generateSmartTable] Generated ${fields.length} fields from ${tableGroup} table group patterns`);
      }
    } catch (error) {
      console.warn(`[generateSmartTable] Pattern analysis failed:`, error);
      // Continue without pattern-based fields
    }
  }

  // Strategy 3: Parse field hints and suggest EDTs
  if (fieldsHint && !copyFrom) {
    console.log(`[generateSmartTable] Parsing field hints: ${fieldsHint}`);
    const hintFields = fieldsHint.split(',').map(s => s.trim()).filter(s => s.length > 0);

    // Guard: reject reserved system field names before any generation attempt.
    // Adding a field named e.g. "CreatedDateTime" produces a compiler error:
    // "Invalid field name; 'CreatedDateTime' is reserved for system fields."
    // The platform auto-provides these fields; users should NOT declare them.
    const reservedHits = hintFields.filter(f => RESERVED_SYSTEM_FIELD_NAMES.has(f.toLowerCase()));
    if (reservedHits.length > 0) {
      return {
        content: [{
          type: 'text',
          text: [
            `❌ **Reserved system field name(s): ${reservedHits.map(f => `"${f}"`).join(', ')}**`,
            ``,
            `These names are reserved by the D365FO platform. Adding a custom field with one of`,
            `these names causes the compiler error:`,
            `  "Invalid field name; '<name>' is reserved for system fields."`,
            ``,
            `**The platform auto-provides these fields** at the table level — you do NOT need to declare them:`,
            `  • \`CreatedDateTime\`, \`ModifiedDateTime\` — auto-tracked creation/modification timestamps`,
            `  • \`CreatedBy\`, \`ModifiedBy\`             — auto-tracked user references`,
            `  • \`RecId\`, \`RecVersion\`                 — system record identity/concurrency`,
            `  • \`DataAreaId\`, \`Partition\`             — multi-company/partition isolation`,
            ``,
            `**To fix:** rename the field(s) to a non-reserved name. Examples:`,
            `${reservedHits.map(f => {
              const suggestions: Record<string, string> = {
                createddatetime: '"NoteDateTime", "DocumentDateTime", "EventDateTime"',
                modifieddatetime: '"LastModifiedOn", "UpdatedDateTime"',
                createdby: '"AuthorId", "RequestedBy"',
                modifiedby: '"LastModifiedUser"',
              };
              return `  • "${f}" → ${suggestions[f.toLowerCase()] ?? '"CustomFieldName"'}`;
            }).join('\n')}`,
            ``,
            `🔄 **Call generate again** with the corrected \`fieldsHint\`.`,
          ].join('\n'),
        }],
        isError: true,
      };
    }

    const hintDb = symbolIndex.getReadDb();

    for (const hint of hintFields) {
      // Duplicate field name in hint list (e.g. agent passed the EDT name twice: "AmountMST, AmountMST"
      // instead of distinct field names like "DailyRate, LineAmount"). Preserve both by suffixing the
      // second occurrence rather than silently dropping it — the caller wanted two separate fields.
      let fieldName = hint;
      if (fields.find(f => f.name === fieldName)) {
        let suffix = 2;
        while (fields.find(f => f.name === `${hint}${suffix}`)) suffix++;
        fieldName = `${hint}${suffix}`;
        console.warn(`[generateSmartTable] Duplicate hint "${hint}" → renamed to "${fieldName}"`);
      }

      const edt = resolveBestEdt(hint, hintDb);
      const hintLower = hint.toLowerCase();
      // Mark as mandatory only when the field name IS an identifier (ends with 'Id',
      // equals 'RecId', or exactly 'AccountNum'/'CustAccount' patterns).
      // Do NOT match fields that merely CONTAIN 'id' mid-word (e.g. ValidFrom, Description).
      const isMandatory =
        hintLower === 'recid' ||
        /id$/.test(hintLower) ||          // SalesId, CustId, AccountId …
        hintLower === 'accountnum' ||      // D365FO conventional PK fields
        hintLower === 'accountnumber' ||
        hintLower === 'num' ||
        hintLower === 'code';
      fields.push({
        name: fieldName,
        edt,
        mandatory: isMandatory,
      });
    }

    console.log(`[generateSmartTable] Added ${hintFields.length} fields from hints`);
  }

  // Fallback: Generate sensible defaults when no fields were provided at all
  if (fields.length === 0) {
    usedFallback = true;
    console.warn(`[generateSmartTable] No fieldsHint provided — generating GENERIC defaults only. The table will be incomplete!`);
    const nameLower = name.toLowerCase();
    // Derive reasonable defaults from table name and group
    if (nameLower.includes('account') || tableGroup === 'Main') {
      fields.push({ name: 'AccountNum', edt: 'CustAccount', mandatory: true });
      fields.push({ name: 'Name', edt: 'Name' });
      fields.push({ name: 'Description', edt: 'Description' });
    } else if (tableGroup === 'Transaction') {
      fields.push({ name: 'AccountNum', edt: 'LedgerAccount', mandatory: true });
      fields.push({ name: 'TransDate', edt: 'TransDate' });
      fields.push({ name: 'Amount', edt: 'AmountMST' });
    } else if (tableGroup === 'Parameter') {
      fields.push({ name: 'Key', edt: 'String255', mandatory: true });
      fields.push({ name: 'Value', edt: 'String255' });
    } else {
      // Generic fallback
      fields.push({ name: 'RecId', edt: 'RecId', mandatory: true });
    }
  }

  // Resolve EDT base type from edt_metadata for each field that has an EDT but no explicit type.
  // Without this, all EDT fields default to AxTableFieldString even for Real/Date/Int64 EDTs.
  // Also validate that every EDT actually exists in the indexed metadata.
  const edtWarnings: string[] = [];
  const missingEdts: Array<{ field: string; edt: string }> = [];
  {
    const db = symbolIndex.getReadDb();
    for (const f of fields) {
      // The resolved "EDT" may actually be an enum (e.g. a custom RentStatus enum
      // or a field that resolveBestEdt echoed back as a same-session custom type).
      // An enum-backed field must be AxTableFieldEnum + EnumType, not String + EDT.
      if (f.edt && !f.enumType && isEnumName(f.edt, db)) {
        f.enumType = f.edt;
        f.type = 'Enum';
        f.edt = undefined;
        continue;
      }
      if (f.edt && !f.type) {
        // Authoritative base type from the C# bridge (live IMetadataProvider) when
        // available. The symbol index stores extends=null for ROOT Date/Real/Int64
        // EDTs (e.g. TransDate→Date, Qty→Real), so resolveEdtBaseType wrongly
        // defaulted them to String — the #1 source of "scaffold made my date/amount
        // field a string". The bridge reads the real AxEdt element type and resolves
        // it correctly. Fall back to the index + name heuristic only when the bridge
        // is unavailable (Azure/Linux) or doesn't know the EDT.
        f.type = await bridgeEdtBaseType(bridge, f.edt)
              ?? resolveEdtBaseType(f.edt, db)
              ?? heuristicEdtBaseType(f.edt);
      }
      // Validate EDT exists in the symbol index
      if (f.edt) {
        const edtExists = validateEdtExists(f.edt, db);
        if (!edtExists) {
          edtWarnings.push(`⚠️ Field "${f.name}": "${f.edt}" not found in indexed metadata as an EDT or enum — if it is a same-session custom type, call update_symbol_index on its file first, then regenerate. Otherwise this will cause a build error.`);
          missingEdts.push({ field: f.name, edt: f.edt });
        }
      }
    }
  }

  // ── BP rule: BPErrorEDTNotMigrated ─────────────────────────────────────────
  // When a field uses an EDT that carries an implicit relation (e.g. ItemId → InventTable),
  // D365FO BP requires an explicit table relation on the table — otherwise you get:
  //   BPErrorEDTNotMigrated: The relation under the EDT must be migrated to table relation.
  //   BPUpgradeMetadataEDTRelation: EDT relation found in field X. It should be migrated.
  // Auto-detect from edt_metadata.reference_table and generate matching relations.
  {
    const db = symbolIndex.getReadDb();
    for (const f of fields) {
      if (!f.edt) continue;
      // Skip if a relation for this field already exists
      if (relations.some(r => r.constraints.some(c => c.field === f.name))) continue;

      try {
        const edtRow = db.prepare(
          `SELECT reference_table FROM edt_metadata WHERE edt_name = ? AND reference_table IS NOT NULL AND reference_table != '' LIMIT 1`
        ).get(f.edt) as { reference_table: string } | undefined;

        if (edtRow?.reference_table) {
          // Determine the related field — typically the EDT name itself is the PK field on the target table
          // e.g. ItemId EDT → InventTable.ItemId, WHSZoneId → WHSZone.WHSZoneId
          const relatedField = f.edt;  // The EDT name is the canonical field name on the target table
          relations.push({
            name: f.name,
            targetTable: edtRow.reference_table,
            constraints: [{ field: f.name, relatedField }],
          });
          console.log(`[generateSmartTable] Auto-migrated EDT relation: ${f.name} (${f.edt}) → ${edtRow.reference_table}.${relatedField}`);
        }
      } catch {
        // Skip if edt_metadata query fails
      }
    }
  }

  // If primaryKeyFields is specified, mark those fields as mandatory (overrides auto-detection)
  if (primaryKeyFields && primaryKeyFields.length > 0) {
    for (const pkFieldName of primaryKeyFields) {
      const f = fields.find(f => f.name === pkFieldName);
      if (f) { f.mandatory = true; }
    }
  }

  // Ensure primary key index exists
  const hasAnyUniqueIndex = indexes.some(idx => idx.unique || idx.clustered);
  if (!hasAnyUniqueIndex && fields.length > 0) {
    if (primaryKeyFields && primaryKeyFields.length > 0) {
      // Use explicitly provided composite/single PK fields
      indexes.unshift(builder.buildPrimaryKeyIndex(name, primaryKeyFields));
      console.log(`[generateSmartTable] Added primary key index on [${primaryKeyFields.join(', ')}] (from primaryKeyFields)`);
    } else {
      // Auto-detect: prefer first mandatory non-RecId field, fall back to RecId
      const pkField = fields.find(f => f.mandatory && f.name !== 'RecId')?.name
        ?? fields.find(f => f.name === 'RecId')?.name
        ?? fields[0].name;
      indexes.unshift(builder.buildPrimaryKeyIndex(name, [pkField]));
      console.log(`[generateSmartTable] Added primary key index on ${pkField}`);
    }
  }

  // Determine package path
  // Ensure .mcp.json is loaded before reading packagePath — getPackagePath() is synchronous
  // and may miss packagePath from config if ensureLoaded() was not yet called.
  const configManager = getConfigManager();
  await configManager.ensureLoaded();
  // Prefer the bridge's custom packages root (where bridge-backed writes actually land,
  // e.g. a repo metadata checkout like K:\repos\…\metadata) so the exists-guard, the
  // fallback write target, and the reported path all match the real write location.
  // Falls back to the standard PackagesLocalDirectory for traditional environments.
  const customPackagesRoot = await configManager.getCustomPackagesPath();
  const resolvedPackagePath = argPackagePath || customPackagesRoot || configManager.getPackagePath();
  // getPackagePath() already probes C:\ and K:\ well-known locations before returning null,
  // so reaching here with null means neither location exists on this machine.
  if (!resolvedPackagePath && process.platform === 'win32') {
    throw new Error(
      '\u274c Cannot determine PackagesLocalDirectory path.\n\n' +
      'Neither C:\\AosService\\PackagesLocalDirectory nor K:\\AosService\\PackagesLocalDirectory were found.\n\n' +
      'If your D365FO installation is on a different drive, add one of the following to your .mcp.json:\n' +
      '  \u2022 "packagePath": "<drive>:\\\\AosService\\\\PackagesLocalDirectory"\n' +
      '  \u2022 "workspacePath": "<drive>:\\\\AosService\\\\PackagesLocalDirectory\\\\YourModel"\n' +
      '  \u2022 "projectPath": "<drive>:\\\\VSProjects\\\\YourSolution\\\\YourProject\\\\YourProject.rnrproj"\n\n' +
      'Or pass packagePath directly to this tool call.\n\n' +
      'UDE environments: packagePath is not used — configure customPackagesPath/microsoftPackagesPath instead.'
    );
  }
  const packagePath = resolvedPackagePath || 'K:\\AosService\\PackagesLocalDirectory';

  // Resolve project/solution path — fall back to configManager (from .mcp.json / auto-detection)
  let resolvedProjectPath = projectPath;
  let resolvedSolutionPath = solutionPath;
  if (!resolvedProjectPath && !resolvedSolutionPath) {
    resolvedProjectPath = (await configManager.getProjectPath()) || undefined;
    resolvedSolutionPath = (await configManager.getSolutionPath()) || undefined;
    if (resolvedProjectPath) {
      console.log(`[generateSmartTable] Using projectPath from config/auto-detect: ${resolvedProjectPath}`);
    } else if (resolvedSolutionPath) {
      console.log(`[generateSmartTable] Using solutionPath from config/auto-detect: ${resolvedSolutionPath}`);
    }
  }

  // Resolve actual model name — always prefer extracting from .rnrproj over using modelName arg
  let resolvedModel = modelName;
  if (resolvedProjectPath) {
    const extracted = extractModelFromProject(resolvedProjectPath);
    if (extracted) {
      resolvedModel = extracted;
      console.log(`[generateSmartTable] Extracted model from .rnrproj: ${resolvedModel}`);
    }
  } else if (resolvedSolutionPath) {
    const project = findProjectInSolution(resolvedSolutionPath);
    if (project) {
      const extracted = extractModelFromProject(project);
      if (extracted) {
        resolvedModel = extracted;
        console.log(`[generateSmartTable] Extracted model from solution .rnrproj: ${resolvedModel}`);
      }
    }
  }

  const isNonWindows = process.platform !== 'win32';

  if (!resolvedModel) {
    // Both Windows and Azure/Linux: .rnrproj extraction failed (or wasn't attempted).
    // Fall back in this order:
    //   1. .mcp.json context (modelName field or last segment of workspacePath) — user explicitly configured
    //   2. Auto-detected model name (async) — e.g. from PackagesLocalDirectory regex in well-known paths scan
    //   3. D365FO_MODEL_NAME env var
    //   4. modelName arg — LAST because the AI often passes a placeholder like "any" or "whatever"
    // Only throw when every source is exhausted.
    const configModel = configManager.getModelName();
    const autoModel = configModel ? null : (await configManager.getAutoDetectedModelName());
    resolvedModel = configModel || autoModel || process.env.D365FO_MODEL_NAME || modelName || undefined;
    if (resolvedModel) {
      const ctx = configManager.getContext();
      const source = configModel === resolvedModel
        ? (ctx?.modelName ? 'modelName (mcp.json)' : 'workspacePath (mcp.json)')
        : autoModel === resolvedModel ? 'auto-detected (well-known paths)'
        : process.env.D365FO_MODEL_NAME === resolvedModel ? 'D365FO_MODEL_NAME env var'
        : 'modelName arg (fallback)';
      console.log(`[generateSmartTable] Using model from ${source}: ${resolvedModel}`);
    } else if (!isNonWindows) {
      // Windows VM: all sources exhausted — tell the user exactly what to configure.
      throw new Error(
        'Could not resolve model name. Provide modelName, projectPath, or solutionPath, ' +
        'or configure projectPath/solutionPath in .mcp.json or set D365FO_MODEL_NAME env var.'
      );
    }
    // Non-Windows: if still null we continue without a prefix (XML will be returned as text).
  }

  console.log(`[generateSmartTable] Using model: ${resolvedModel ?? '(none — no prefix)'}`);

  // Apply extension prefix to table name (skip when model unknown)
  const objectPrefix = resolvedModel ? resolveObjectPrefix(resolvedModel) : '';
  let finalName = objectPrefix ? applyObjectPrefix(name, objectPrefix) : name;
  const objectSuffix = getObjectSuffix();
  finalName = applyObjectSuffix(finalName, objectSuffix);
  if (finalName !== name) {
    console.log(`[generateSmartTable] Applied naming: ${name} → ${finalName}`);
  }

  // Generate standard methods (find, exist) based on primary key fields
  const generatedMethods: Array<{ name: string; source: string }> = [];
  if (requestedMethods && requestedMethods.length > 0) {
    // Determine primary key fields from unique non-RecId index, or first non-RecId fields
    const uniqueIdx = indexes.find(idx => idx.unique && !idx.fields.every(f => f === 'RecId'));
    const pkFields = uniqueIdx
      ? uniqueIdx.fields.filter(f => f !== 'RecId')
      : fields.filter(f => f.name !== 'RecId').slice(0, 1).map(f => f.name);

    const buildParams = (withType: boolean) =>
      pkFields.map(f => {
        const edt = fields.find(fld => fld.name === f)?.edt || 'str';
        return withType ? `${edt} _${f.charAt(0).toLowerCase() + f.slice(1)}` : `_${f.charAt(0).toLowerCase() + f.slice(1)}`;
      }).join(', ');

    const whereClause = pkFields
      .map(f => `${finalName}.${f} == _${f.charAt(0).toLowerCase() + f.slice(1)}`)
      .join('\n            && ');

    for (const methodName of requestedMethods) {
      if (methodName === 'find') {
        const params = buildParams(true);
        generatedMethods.push({
          name: 'find',
          source: [
            `public static ${finalName} find(${params}, boolean _forupdate = false)`,
            `{`,
            `    ${finalName}  local;`,
            ``,
            `    if (_forupdate)`,
            `    {`,
            `        local.selectForUpdate(_forupdate);`,
            `    }`,
            ``,
            `    select firstOnly local`,
            `        where ${whereClause};`,
            ``,
            `    return local;`,
            `}`,
          ].join('\n'),
        });
      } else if (methodName === 'exist') {
        const params = buildParams(true);
        generatedMethods.push({
          name: 'exist',
          source: [
            `public static boolean exist(${params})`,
            `{`,
            `    return (select firstOnly RecId from ${finalName}`,
            `                where ${whereClause}).RecId != 0;`,
            `}`,
          ].join('\n'),
        });
      }
    }
    if (generatedMethods.length > 0) {
      console.log(`[generateSmartTable] Generated methods: ${generatedMethods.map(m => m.name).join(', ')}`);
    }
  }

  // HARD-BLOCK: when no fieldsHint was provided (and no copyFrom / generateCommonFields),
  // return an error immediately — do NOT generate any XML that the AI might use.
  // The AI MUST retry with explicit fieldsHint extracted from the user's description.
  if (usedFallback) {
    console.error(`[generateSmartTable] ❌ BLOCKED — fieldsHint not provided for table "${name}"`);
    return {
      content: [{
        type: 'text',
        text: [
          `❌ **CANNOT GENERATE TABLE — \`fieldsHint\` is REQUIRED!**`,
          ``,
          `The user described specific fields but you did NOT pass \`fieldsHint\`. Without it the table`,
          `will be empty (no fields, no indexes, no methods). No XML has been generated.`,
          ``,
          `🔄 **YOU MUST call \`generate\` AGAIN** with ALL fields extracted from the user's description:`,
          ``,
          `\`\`\``,
          `generate_object(mode="scaffold", `,
          `  objectType="table",`,
          `  name="${name}",                           ← base name WITHOUT model prefix`,
          `  fieldsHint="Field1, Field2, Field3",      ← REQUIRED: extract ALL fields from the user`,
          `  primaryKeyFields=["Field1", "Field2"],    ← ALL PK fields (omit for single-field PK)`,
          `  methods=["find", "exist"],                ← include if user requested these`,
          `  tableGroup="${tableGroup}",`,
          `)`,
          `\`\`\``,
          ``,
          `**Common Czech → D365FO field name mappings:**`,
          `| User phrase | fieldsHint value |`,
          `|-------------|-----------------|`,
          `| "Account number" / "číslo účtu" | \`AccountNum\` |`,
          `| "Name" / "název" | \`Name\` |`,
          `| "Description" / "popis" | \`Description\` |`,
          `| "platnost od" / "from date" / "valid from" | \`ValidFrom\` |`,
          `| "platnost do" / "to date" / "valid to" | \`ValidTo\` |`,
          `| "active" / "aktivní" / "flag" | \`Active\` |`,
          ``,
          `⛔ NEVER call \`d365fo_file(action="create")\` without first regenerating — there is no XML to use.`,
          `⛔ NEVER call \`d365fo_file(action="modify")\` to add missing fields — it CANNOT write on Azure/Linux.`,
        ].join('\n'),
      }],
      isError: true,
    };
  }

  // On non-Windows (Azure/Linux): generate XML via SmartXmlBuilder and return as text
  // The bridge is not available on non-Windows — file writing is handled by the local companion.
  if (isNonWindows) {
    const xml = builder.buildTableXml({
      name: finalName,
      label: label || finalName,
      tableGroup,
      tableType,
      fields,
      indexes,
      relations,
      methods: generatedMethods.length > 0 ? generatedMethods : undefined,
    });

    console.log(`[generateSmartTable] Generated XML for Azure/Linux (${xml.length} bytes)`);

    const noModelNote = resolvedModel
      ? ''
      : `\n> ⚠️  No model resolved — XML generated without prefix. Pass \`modelName\` with the actual model name from .mcp.json (e.g. \`"ContosoExt"\`) for correct object naming.\n> 🚨 **IMPORTANT**: Do NOT add a prefix to the \`name\` parameter when calling this tool — the tool applies the prefix automatically from \`modelName\`. Passing a name that already includes the prefix will result in double-prefixing.`;
    const nextStep = [
      ``,
      `**✅ MANDATORY NEXT STEP — immediately call \`d365fo_file(action="create")\` with the XML below:**`,
      `\`\`\``,
      `d365fo_file(action="create", `,
      `  objectType="table",`,
      `  objectName="${finalName}",`,
      `  xmlContent="<copy the full XML block below>",`,
      `  addToProject=true`,
      `)`,
      `\`\`\``,
      `⛔ NEVER use \`create_file\`, PowerShell scripts, or any built-in file tool — they corrupt D365FO metadata and break VS project integration.`,
      `⛔ NEVER call \`d365fo_file(action="modify")\` to add methods — the \`methods\` parameter in \`generate\` already embedded them in the XML above.`,
      `⛔ NEVER call \`analyze_code(mode="implementations")\` or \`analyze_code(mode="api-usage")\` between this step and \`d365fo_file(action="create")\` — those tools are expensive and their result is not needed for file creation. Call them AFTER the file is created if the user explicitly asks.`,
    ].join('\n');
    const edtWarningBlock = edtWarnings.length > 0
      ? `\n### ⚠️ EDT Validation Warnings\n${edtWarnings.join('\n')}\n`
      : '';
    return {
      content: [{
        type: 'text',
        text: [
          `✅ Table XML generated for **${finalName}**` + (resolvedModel ? ` (model: ${resolvedModel})` : ''),
          `   Fields: ${fields.length}, Indexes: ${indexes.length}, Relations: ${relations.length}`,
          edtWarningBlock,
          noModelNote,
          ``,
          `ℹ️  MCP server is running on Azure/Linux — file writing is handled by the local Windows companion. This is the expected hybrid workflow.`,
          nextStep,
          ``,
          `\`\`\`xml`,
          xml,
          `\`\`\``,
        ].join('\n'),
      }],
    };
  }

  // ── Windows: Bridge-first creation via C# CreateSmartTable ──
  // The C# bridge applies all BP-smart defaults (CacheLookup, FieldGroups, DeleteActions,
  // TitleField1/2, PrimaryIndex/ClusteredIndex) using the official IMetadataProvider API.
  // Falls back to SmartXmlBuilder → fs.writeFile if bridge is unavailable.

  // Guard: refuse to overwrite an existing table file via bridge path (would destroy existing methods, fields, etc.)
  if (resolvedModel) {
    const bridgeTargetPath = path.join(packagePath, resolvedModel, resolvedModel, 'AxTable', `${finalName}.xml`).replace(/\//g, '\\');
    if (fs.existsSync(bridgeTargetPath)) {
      throw new Error(
        `⚠️ Table "${finalName}" already exists at:\n${bridgeTargetPath}\n\n` +
        `\`generate_object(mode="scaffold", objectType="table")\` is for **NEW** tables only.\n` +
        `Use \`d365fo_file(action="modify")\` to add fields, methods, or indexes to an existing table.\n` +
        `Use \`get_object_info(objectType="table", name="${finalName}")\` to inspect the current structure.`
      );
    }
  }

  if (bridge && resolvedModel) {
    // ── Pre-write reference gate ──────────────────────────────────────────────
    // scaffold's bridge path writes the table to disk in one shot, bypassing the
    // validate_code gate that d365fo_file(create) runs. Refuse to write when a
    // field references an EDT that exists neither in the index NOR on disk — that
    // always fails at build ("metadata error / BPErrorEDT"). An EDT that is on
    // disk but unindexed (a same-session custom type) is allowed through: xppc
    // reads it from disk, so the table builds. (Only the bridge write path is
    // gated; the Azure/Linux text + fs-fallback paths keep their advisory
    // warnings, since the index may legitimately be incomplete there.)
    const modelDir = path.join(packagePath, resolvedModel, resolvedModel).replace(/\//g, '\\');
    const unbuildable = selectUnbuildableEdts(missingEdts, modelDir);
    if (unbuildable.length > 0) {
      return {
        isError: true,
        content: [{
          type: 'text',
          text: [
            `⛔ Refusing to write table **${finalName}** — ${unbuildable.length} field(s) reference an EDT that exists neither in the index nor on disk:`,
            ...unbuildable.map(u => `  • Field "${u.field}" → EDT "${u.edt}" (not found)`),
            ``,
            `Writing now would produce a table that fails to build. Fix the EDT name(s) — use`,
            `suggest_edt or search to find the correct one. For a same-session custom EDT, create`,
            `the EDT first (and call \`update_symbol_index\` on its file), then re-run scaffold.`,
          ].join('\n'),
        }],
      };
    }

    console.log(`[generateSmartTable] Attempting bridge-first creation for ${finalName}...`);
    const bridgeResult = await bridgeCreateSmartTable(bridge, {
      objectName: finalName,
      modelName: resolvedModel,
      tableGroup,
      tableType,
      label: label || finalName,
      fields: fields.map(f => ({
        name: f.name,
        fieldType: f.type || undefined,
        edt: f.edt || undefined,
        enumType: f.enumType || undefined,
        mandatory: f.mandatory || false,
        label: f.label || undefined,
      })),
      indexes: indexes.map(ix => ({
        name: ix.name,
        fields: ix.fields,
        allowDuplicates: !ix.unique,
        alternateKey: !!ix.unique,
      })),
      relations: relations.map(rel => ({
        name: rel.name,
        relatedTable: rel.targetTable,
        constraints: rel.constraints.map(c => ({
          field: c.field,
          relatedField: c.relatedField,
        })),
      })),
      methods: generatedMethods.length > 0
        ? generatedMethods.map(m => ({ name: m.name, source: m.source }))
        : undefined,
    });

    if (bridgeResult?.success && bridgeResult.filePath) {
      console.log(`[generateSmartTable] ✅ Created via C# bridge: ${bridgeResult.filePath}`);

      // Add to Visual Studio project
      let projectMessage = '';
      const effectiveProjectPath = resolvedProjectPath ||
        (await getConfigManager().getProjectPath()) ||
        undefined;

      if (effectiveProjectPath) {
        try {
          const projectManager = new ProjectFileManager();
          const wasAdded = await projectManager.addToProject(
            effectiveProjectPath,
            'table',
            finalName,
            bridgeResult.filePath,
          );
          projectMessage = wasAdded
            ? `\n✅ Added to Visual Studio project:\n📋 Project: ${effectiveProjectPath}`
            : `\n✅ Already in Visual Studio project:\n📋 Project: ${effectiveProjectPath}`;
        } catch (projErr) {
          projectMessage = `\n⚠️ File created but could not be added to project: ${projErr instanceof Error ? projErr.message : String(projErr)}`;
        }
      } else {
        projectMessage = `\n⚠️ addToProject skipped — no projectPath found in .mcp.json or tool args.`;
      }

      const edtWarningBlock = edtWarnings.length > 0
        ? `\n### ⚠️ EDT Validation Warnings\n${edtWarnings.join('\n')}\n`
        : '';

      const bp = bridgeResult.bpDefaults;
      const bpSummary = bp
        ? `\n📋 BP Defaults: CacheLookup=${bp.cacheLookup}, SaveDataPerCo=${bp.saveDataPerCompany}, ` +
          `TitleField1=${bp.titleField1 ?? '(none)'}, TitleField2=${bp.titleField2 ?? '(none)'}, ` +
          `PrimaryIdx=${bp.primaryIndex ?? '(none)'}, ClusteredIdx=${bp.clusteredIndex ?? '(none)'}, ` +
          `FieldGroups=${bp.fieldGroupCount ?? 5}, DeleteActions=${bp.deleteActionCount ?? 0}`
        : '';

      return {
        content: [
          {
            type: 'text',
            text: [
              `✅ Table **${finalName}** created via C# DevTools API (IMetadataProvider).`,
              ``,
              `📁 File: ${bridgeResult.filePath}`,
              `📦 Model: ${resolvedModel}`,
              `📊 Fields: ${fields.length}, Indexes: ${indexes.length}, Relations: ${relations.length}`,
              `🔧 API: ${bridgeResult.api ?? 'IMetaTableProvider.Create (Smart)'}`,
              bpSummary,
              edtWarningBlock,
              projectMessage,
              ``,
              `⛔ DO NOT call \`d365fo_file(action="create")\` — the file is already written to disk at the path above. Calling d365fo_file would create a DUPLICATE at a different path which causes build conflicts.`,
              `⛔ DO NOT call \`generate\` again — task is COMPLETE.`,
              ``,
              `Next steps for the user:`,
              `1. Reload the project in Visual Studio (or close/reopen solution)`,
              `2. Build the project to synchronize the table`,
              `3. Refresh AOT to see the new object`,
            ].join('\n'),
          },
        ],
      };
    }

    // Bridge failed — fall through to SmartXmlBuilder fallback
    console.warn(`[generateSmartTable] Bridge createSmartTable failed, falling back to SmartXmlBuilder`);
  }

  // ── Fallback: SmartXmlBuilder → fs.writeFile (no bridge or bridge unavailable) ──
  // Generate XML
  const xml = builder.buildTableXml({
    name: finalName,
    label: label || finalName,
    tableGroup,
    tableType,
    fields,
    indexes,
    relations,
    methods: generatedMethods.length > 0 ? generatedMethods : undefined,
  });

  console.log(`[generateSmartTable] Generated XML via SmartXmlBuilder (${xml.length} bytes)`);

  // Write to file
  const targetPath = path.join(packagePath, resolvedModel!, resolvedModel!, 'AxTable', `${finalName}.xml`);

  // Normalize path to Windows format (backslashes) for consistency
  const normalizedPath = targetPath.replace(/\//g, '\\');

  // Reject Windows paths when running on non-Windows (e.g. Linux Azure proxy)
  if (process.platform !== 'win32' && /^[A-Z]:\\/.test(normalizedPath)) {
    throw new Error(
      `❌ Cannot create D365FO file on non-Windows system!\n\n` +
      `Attempting to create: ${normalizedPath}\n` +
      `Running on: ${process.platform}\n\n` +
      `The generate tool (objectType="table") requires direct access to the D365FO Windows VM.\n` +
      `Run the MCP server locally on the D365FO Windows VM.`
    );
  }

  // Verify drive/root exists before attempting recursive mkdir
  const driveOrRoot = path.parse(normalizedPath).root;
  if (driveOrRoot && !fs.existsSync(driveOrRoot)) {
    throw new Error(
      `❌ Drive or root path does not exist: ${driveOrRoot}\n\n` +
      `Attempting to create: ${normalizedPath}\n\n` +
      `Update "packagePath" in .mcp.json to match your actual D365FO installation.`
    );
  }

  // Create directory if needed
  const dir = path.dirname(normalizedPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Guard: refuse to overwrite an existing table file (would destroy existing methods, fields, etc.)
  if (fs.existsSync(normalizedPath)) {
    throw new Error(
      `⚠️ Table "${finalName}" already exists at:\n${normalizedPath}\n\n` +
      `\`generate_object(mode="scaffold", objectType="table")\` is for **NEW** tables only.\n` +
      `Use \`d365fo_file(action="modify")\` to add fields, methods, or indexes to an existing table.\n` +
      `Use \`get_object_info(objectType="table", name="${finalName}")\` to inspect the current structure.`
    );
  }

  // Write file
  fs.writeFileSync(normalizedPath, normalizeD365Xml(xml), 'utf-8');
  console.log(`[generateSmartTable] Created file: ${normalizedPath}`);

  // Add to Visual Studio project if a projectPath is known
  let projectMessage = '';
  const effectiveProjectPath = resolvedProjectPath ||
    (await getConfigManager().getProjectPath()) ||
    undefined;

  if (effectiveProjectPath) {
    try {
      const projectManager = new ProjectFileManager();
      const wasAdded = await projectManager.addToProject(
        effectiveProjectPath,
        'table',
        finalName,
        normalizedPath
      );
      projectMessage = wasAdded
        ? `\n✅ Added to Visual Studio project:\n📋 Project: ${effectiveProjectPath}`
        : `\n✅ Already in Visual Studio project:\n📋 Project: ${effectiveProjectPath}`;
      console.log(`[generateSmartTable] addToProject result: ${wasAdded ? 'added' : 'already present'}`);
    } catch (projErr) {
      projectMessage = `\n⚠️ File created but could not be added to project: ${projErr instanceof Error ? projErr.message : String(projErr)}`;
      console.error(`[generateSmartTable] addToProject error:`, projErr);
    }
  } else {
    projectMessage = `\n⚠️ addToProject skipped — no projectPath found in .mcp.json or tool args.`;
  }

  const edtWarningBlock = edtWarnings.length > 0
    ? `\n### ⚠️ EDT Validation Warnings\n${edtWarnings.join('\n')}\n`
    : '';

  return {
    content: [
      {
        type: 'text',
        text: [
          `✅ Table **${finalName}** created directly on the Windows VM.`,
          ``,
          `📁 File: ${normalizedPath}`,
          `📦 Model: ${resolvedModel}`,
          `📊 Fields: ${fields.length}, Indexes: ${indexes.length}, Relations: ${relations.length}`,
          edtWarningBlock,
          projectMessage,
          ``,
          `⛔ DO NOT call \`d365fo_file(action="create")\` — the file is already written to disk at the path above. Calling d365fo_file would create a DUPLICATE at a different path which causes build conflicts.`,
          `⛔ DO NOT call \`generate\` again — task is COMPLETE.`,
          ``,
          `Next steps for the user:`,
          `1. Reload the project in Visual Studio (or close/reopen solution)`,
          `2. Build the project to synchronize the table`,
          `3. Refresh AOT to see the new object`,
        ].join('\n'),
      },
    ],
  };
}

/**
 * Resolve an EDT's primitive base type via the C# bridge (live IMetadataProvider).
 *
 * The bridge reads the real AxEdt element type (AxEdtDate/AxEdtReal/AxEdtInt64/…),
 * so it correctly distinguishes a ROOT Date/Real EDT from a String one — which the
 * symbol index CANNOT, because it stores extends=null for root EDTs regardless of
 * their primitive. Returns a token compatible with resolveEdtBaseType
 * (String/Integer/Real/Date/Int64/Guid/…), or undefined when the bridge is
 * unavailable, doesn't know the EDT, or reports it as Enum (enum-backed EDTs are
 * handled separately via the enumType path, so we must not emit a bare "Enum" here).
 */
async function bridgeEdtBaseType(bridge: BridgeClient | undefined, edtName: string): Promise<string | undefined> {
  if (!bridge?.isReady) return undefined;
  try {
    const info = await bridge.readEdt(edtName);
    const bt = (info as any)?.baseType;
    if (typeof bt !== 'string' || bt.length === 0 || bt === 'Enum') return undefined;
    return bt;
  } catch {
    return undefined;
  }
}

/**
 * Resolve the primitive base type for a D365FO EDT by walking the edt_metadata chain.
 * The `extends` column in edt_metadata stores either a primitive type name
 * (String, Real, Int64, Date, UtcDateTime, Enum, Container, Guid, Integer) or
 * another EDT name. We follow the chain until we reach a primitive type.
 *
 * ⚠️ Index limitation: ROOT EDTs that extend a primitive store extends=null, so this
 * cannot tell a Date/Real root EDT from a String one and defaults such cases to
 * String. Prefer bridgeEdtBaseType() when a bridge is available; this is the
 * offline (Azure/Linux) fallback.
 *
 * Returns a base type string compatible with fieldTypeToAxType(), e.g.:
 *   "Qty" → "Real", "TransDate" → "Date", "ItemId" → "String"
 */
export function resolveEdtBaseType(edtName: string, db: any, depth = 0): string | undefined {
  // D365FO primitive types − these map directly to AxTableField types
  const PRIMITIVES = new Set([
    'String', 'Integer', 'Int64', 'Real', 'Date', 'UtcDateTime', 'DateTime',
    'Enum', 'Container', 'Guid', 'GUID',
  ]);

  if (depth > 8) return 'String'; // guard against circular chains

  if (PRIMITIVES.has(edtName)) return edtName;

  try {
    const row = db.prepare(
      `SELECT extends, enum_type, string_size FROM edt_metadata WHERE edt_name = ? LIMIT 1`
    ).get(edtName) as { extends: string | null; enum_type: string | null; string_size: string | number | null } | undefined;

    // EDT not found in the index (e.g. a custom EDT not yet indexed, or a standard OOB EDT
    // whose index wasn't loaded). Return undefined so callers fall back to EDT-name heuristics
    // in getAxTableFieldType() instead of blindly defaulting to AxTableFieldString.
    if (!row) return undefined;
    // Enum-based EDT: extends is null but enum_type is set (e.g. SalesStatus, PurchStatus)
    if (row.enum_type && !row.extends) return 'Enum';
    if (!row.extends) {
      // ROOT EDT: the index does NOT record the primitive (AxEdtDate/Real/Int64/String all
      // store extends=null). A real string EDT carries a string_size; without one we genuinely
      // CANNOT tell String from Date/Real/Int64 — so return undefined and let the caller's
      // name heuristic (or the bridge) decide, instead of mislabeling e.g. TransDate/Qty as
      // String. This is the #1 "scaffold turned my date/amount field into a string" bug.
      return row.string_size != null ? 'String' : undefined;
    }
    if (PRIMITIVES.has(row.extends)) return row.extends;

    // Follow chain to the parent EDT
    return resolveEdtBaseType(row.extends, db, depth + 1);
  } catch {
    return undefined;
  }
}

/**
 * Heuristic base type from an EDT/field name when the EDT is not in the index
 * (e.g. a standard EDT whose edt_metadata wasn't loaded, or a same-session EDT).
 * Mirrors SmartXmlBuilder.getAxTableFieldType's name heuristics but returns the
 * primitive base type so it can be passed explicitly to the C# bridge (which
 * otherwise defaults unknown EDTs to AxTableFieldString).
 * Returns undefined for genuinely unrecognizable names (caller keeps EDT-as-string).
 */
export function heuristicEdtBaseType(edtName: string): string | undefined {
  const e = edtName.toLowerCase();
  if (e === 'recid' || e.endsWith('recid') || e.includes('refrecid')) return 'Int64';
  if (e.includes('utcdatetime') || (e.includes('datetime') && !e.includes('transdate'))) return 'UtcDateTime';
  if (e.includes('date') && !e.includes('time') && !e.includes('update')) return 'Date';
  if (e.includes('amount') || e.includes('price') || e.includes('qty') || e.includes('quantity')
      || e.includes('percent') || e.includes('rate') || e === 'real' || e.endsWith('mst')) return 'Real';
  if ((e.endsWith('int') || e.includes('count') || e.includes('level'))
      && !e.includes('account') && !e.includes('name')) return 'Integer';
  return undefined;
}

/**
 * Check whether a name refers to an indexed ENUM (not an EDT). Used to emit
 * AxTableFieldEnum + EnumType instead of AxTableFieldString + ExtendedDataType
 * for fields whose "EDT" is actually a base enum (e.g. a custom RentStatus enum).
 */
export function isEnumName(name: string, db: any): boolean {
  try {
    const row = db.prepare(
      `SELECT 1 FROM symbols WHERE name = ? COLLATE NOCASE AND type IN ('enum', 'enum-extension') LIMIT 1`
    ).get(name);
    return !!row;
  } catch {
    return false;
  }
}

/**
 * Check whether an EDT exists in the indexed edt_metadata.
 * Falls back to checking the symbols table for EDT type entries.
 */
/**
 * From the EDTs that resolve to neither an indexed EDT nor an enum, select those
 * that are ALSO absent from disk — i.e. truly missing and guaranteed to fail the
 * build. An EDT whose `AxEdt/<name>.xml` exists in the model package (a
 * same-session custom EDT not yet indexed) is NOT returned: xppc reads it from
 * disk, so the table will build. Used to gate scaffold's one-shot bridge write
 * without false-blocking the valid same-session-EDT workflow.
 *
 * `existsOnDisk` is injectable for testing; defaults to fs.existsSync.
 */
export function selectUnbuildableEdts(
  missingEdts: Array<{ field: string; edt: string }>,
  modelDir: string,
  existsOnDisk: (p: string) => boolean = fs.existsSync,
): Array<{ field: string; edt: string }> {
  return missingEdts.filter(({ edt }) => {
    const edtFile = path.join(modelDir, 'AxEdt', `${edt}.xml`);
    return !existsOnDisk(edtFile);
  });
}

function validateEdtExists(edtName: string, db: any): boolean {
  // Skip validation for well-known D365FO primitive/system EDTs that may not be in our index
  const SYSTEM_EDTS = new Set([
    'RecId', 'String255', 'Name', 'Description', 'NoYesId', 'RefRecId',
  ]);
  if (SYSTEM_EDTS.has(edtName)) return true;

  try {
    // Check edt_metadata first (most reliable)
    const edtRow = db.prepare(
      `SELECT 1 FROM edt_metadata WHERE edt_name = ? LIMIT 1`
    ).get(edtName);
    if (edtRow) return true;

    // Fallback: check symbols table for EDT type entries
    const symRow = db.prepare(
      `SELECT 1 FROM symbols WHERE name = ? AND type = 'edt' LIMIT 1`
    ).get(edtName);
    if (symRow) return true;

    return false;
  } catch {
    // If DB query fails, don't block generation — just skip validation
    return true;
  }
}

/**
 * Suggest EDT based on field name heuristics
 */
/**
 * D365FO system-managed field names that are reserved by the platform.
 * Attempting to declare a custom field with one of these names produces
 * the compiler error: "Invalid field name; '<name>' is reserved for system fields."
 * The platform auto-provides these fields — users should NOT add them manually.
 */
export const RESERVED_SYSTEM_FIELD_NAMES = new Set([
  'createddatetime', 'modifieddatetime',
  'createdby', 'modifiedby',
  'createdtransactionid', 'modifiedtransactionid',
  'recid', 'recversion', 'dataareaid', 'partition',
  'tableid', 'instancerelationtype',
]);

/** Framework/audit fields that should never be auto-injected from frequency mining. */
export function isInfrastructureField(fieldName: string): boolean {
  const INFRA = new Set([
    'mcrholdcode', 'mcrholduserid', 'mcrholddatetime',
    'sortorder', 'displayorder',
    ...RESERVED_SYSTEM_FIELD_NAMES,
  ]);
  return INFRA.has(fieldName.toLowerCase());
}

/**
 * Single common field words that, on their own, don't pin down a domain EDT.
 * A fuzzy EDT that merely prepends a domain prefix to one of these
 * (e.g. "Status" → "CovStatus", "Type" → "LedgerPostingType") scores high on
 * containment but is the wrong concept, so for these names we accept only an
 * exact EDT match and otherwise fall through to the name heuristic / string
 * default. Multi-word field names like "RentEquipmentId" are specific enough
 * that a prefixed EDT ("ContosoRentEquipmentId") is a genuinely good match.
 */
const GENERIC_FIELD_WORDS = new Set([
  'status', 'type', 'category', 'group', 'code', 'class', 'state', 'kind',
  'level', 'priority', 'value', 'key', 'order', 'sequence', 'version',
  'mode', 'role', 'reason', 'method', 'action', 'source', 'target', 'color',
  'size', 'unit', 'parent', 'child', 'owner', 'number', 'line',
]);

/** True when a field name is a single generic word (see GENERIC_FIELD_WORDS). */
function isGenericFieldWord(fieldName: string): boolean {
  return GENERIC_FIELD_WORDS.has(fieldName.toLowerCase());
}

/** Confidence (0–1) that an EDT name matches a field name, by containment. */
function edtNameConfidence(field: string, edt: string): number {
  const f = field.toLowerCase();
  const e = edt.toLowerCase();
  if (f === e) return 1.0;
  if (e.includes(f)) return 0.9 - (e.length - f.length) * 0.01;
  if (f.includes(e)) return 0.8 - (f.length - e.length) * 0.01;
  return 0;
}

/**
 * Resolve the best EDT for a field name, preferring real indexed EDTs over name
 * heuristics. Order: exact EDT-name match → strong fuzzy match (≥0.8) → heuristic
 * that exists in this environment → weaker fuzzy match (≥0.6) → raw heuristic.
 */
export function resolveBestEdt(fieldName: string, db: any): string {
  try {
    const exact = db.prepare(
      `SELECT edt_name FROM edt_metadata WHERE edt_name = ? COLLATE NOCASE LIMIT 1`
    ).get(fieldName) as { edt_name: string } | undefined;
    if (exact) return exact.edt_name;

    // Generic single-word fields don't accept fuzzy matches — a prefixed EDT
    // (CovStatus for "Status") is a different concept. Only their exact match
    // above counts; otherwise fall through to the heuristic / string default.
    const acceptFuzzy = !isGenericFieldWord(fieldName);

    const candidates = db.prepare(
      `SELECT edt_name FROM edt_metadata WHERE edt_name LIKE ? COLLATE NOCASE ORDER BY LENGTH(edt_name) ASC LIMIT 30`
    ).all(`%${fieldName}%`) as Array<{ edt_name: string }>;
    let best = '';
    let bestConf = 0;
    for (const c of candidates) {
      const conf = edtNameConfidence(fieldName, c.edt_name);
      if (conf > bestConf) { bestConf = conf; best = c.edt_name; }
    }
    if (acceptFuzzy && best && bestConf >= 0.8) return best;

    const heuristic = suggestEdtFromFieldName(fieldName);
    // If the heuristic only fell back to the generic String255, and the fieldName itself
    // looks like a PascalCase custom EDT (starts uppercase, ≥5 chars, non-generic), return
    // the fieldName directly — it's likely a custom EDT not yet in the index.
    // The edtWarnings system will validate it later and warn if it truly doesn't exist.
    // Only echo the field name back as a presumed same-session custom EDT when it
    // looks like a multi-part domain-specific name (≥3 CamelCase tokens, e.g.
    // "ContosoRentEquipmentId"). Short 1-2 token names like "NoteText" or "NoteId"
    // are NOT custom EDT echoes — they are generic column names that default to the
    // heuristic result instead. The edtWarnings system validates echoed names later.
    const camelTokens = fieldName.split(/(?=[A-Z])/).filter(t => t.length > 0);
    if (heuristic === 'String255' && acceptFuzzy && camelTokens.length >= 3 && /^[A-Z]/.test(fieldName)) {
      return fieldName;
    }
    if (validateEdtExists(heuristic, db)) return heuristic;

    if (acceptFuzzy && best && bestConf >= 0.6) return best;
  } catch {
    /* DB unavailable — fall back to the pure heuristic below */
  }
  return suggestEdtFromFieldName(fieldName);
}

export function suggestEdtFromFieldName(fieldName: string): string {
  const nameLower = fieldName.toLowerCase();

  // Common patterns
  if (nameLower === 'recid') return 'RecId';
  if (nameLower === 'accountnum' || nameLower === 'accountnumber') return 'CustAccount';
  if (nameLower.includes('custaccount') || nameLower.includes('customeraccount')) return 'CustAccount';
  if (nameLower.includes('vendaccount') || (nameLower.includes('vendor') && nameLower.includes('account'))) return 'VendAccount';
  if (nameLower === 'name') return 'Name';
  if (nameLower.includes('name')) return 'Name';
  if (nameLower === 'description') return 'Description';
  if (nameLower.includes('description') || nameLower === 'desc') return 'Description';
  if (nameLower.includes('subject') || nameLower === 'title') return 'Name';
  // Long-text / memo fields → Notes (unlimited string, base type String -1)
  if (nameLower === 'notes' || nameLower === 'note' || nameLower === 'notetext' ||
      nameLower.endsWith('text') || nameLower.endsWith('notes') ||
      nameLower === 'body' || nameLower === 'content' || nameLower === 'message') return 'Notes';
  if (nameLower.includes('amount')) return 'AmountMST';
  if (nameLower.includes('rate')) return 'AmountMST';
  if (nameLower.includes('quantity') || nameLower.includes('qty')) return 'Qty';
  if (nameLower.includes('price')) return 'PriceUnit';
  // Only the bare effectivity names map to the *DateTime EDTs; other "*date" → TransDate.
  if (nameLower === 'validfrom') return 'ValidFromDateTime';
  if (nameLower === 'validto') return 'ValidToDateTime';
  if (nameLower.includes('datetime') || nameLower.includes('time')) return 'TransDateTime';
  if (nameLower.includes('date')) return 'TransDate';
  if (nameLower.includes('account')) return 'LedgerAccount';
  if (nameLower.includes('customer') || nameLower.includes('cust')) return 'CustAccount';
  if (nameLower.includes('vendor') || nameLower.includes('vend')) return 'VendAccount';
  if (nameLower.includes('item')) return 'ItemId';
  if (nameLower.includes('percent') || nameLower.includes('pct')) return 'Percent';
  if (nameLower.includes('enabled') || nameLower.includes('active') || nameLower.includes('flag')) return 'NoYesId';

  // No blanket "*id → Num" / "status → NoYesId" rule: those force the wrong base type.
  // Such fields fall through to the string default unless resolveBestEdt matches a real EDT.

  // Default to string
  return 'String255';
}

// extractModelFromProject and findProjectInSolution moved to ../utils/projectUtils.ts
