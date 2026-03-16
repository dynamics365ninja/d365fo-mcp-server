/**
 * Generate Smart Report Tool
 * AI-driven SSRS report generation using indexed metadata patterns.
 *
 * Generates up to 5 D365FO objects in a single call:
 *   1. TmpTable (AxTable, TableType=TempDB) — holds report rows
 *   2. Contract class (DataContractAttribute) — dialog parameters
 *   3. DP class (SrsReportDataProviderBase) — fills TmpTable
 *   4. Controller class (SrsReportRunController) — optional, for menu item
 *   5. Report (AxReport + RDL) — dataset + design bound to the DP/TmpTable
 *
 * Architecture follows generate_smart_table / generate_smart_form patterns:
 *   - Exported Tool definition + async handler
 *   - Symbol index queries for EDT resolution, copyFrom, patterns
 *   - Dual-path output: Azure/Linux returns XML/source text; Windows writes + adds to project
 *
 * References:
 *   - "Microsoft Dynamics AX 2012 Reporting Cookbook" (chapters 2–4)
 *   - D365FO SSRS best practices: Contract–DP–Controller trio
 *   - XmlTemplateGenerator.generateAxReportXml() for AxReport XML skeleton
 */

import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { XppSymbolIndex } from '../metadata/symbolIndex.js';
import { SmartXmlBuilder, TableFieldSpec } from '../utils/smartXmlBuilder.js';
import { XmlTemplateGenerator } from './createD365File.js';
import { ProjectFileManager } from './createD365File.js';
import path from 'path';
import fs from 'fs';
import { getConfigManager } from '../utils/configManager.js';
import { resolveObjectPrefix, applyObjectPrefix } from '../utils/modelClassifier.js';
import { extractModelFromProject, findProjectInSolution } from '../utils/projectUtils.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface ReportFieldSpec {
  /** Field name on the TmpTable (e.g. "ItemId", "Amount") */
  name: string;
  /** EDT to use (auto-suggested from name when omitted) */
  edt?: string;
  /** .NET data type for RDL (auto-resolved from EDT when omitted) */
  dataType?: string;
  /** Label ref for column caption (e.g. "@SYS12345") */
  label?: string;
}

interface ContractParamSpec {
  /** Parameter name (becomes parm method on Contract class) */
  name: string;
  /** X++ type — EDT name or primitive (e.g. "CustAccount", "TransDate", "str") */
  type?: string;
  /** Label for dialog prompt */
  label?: string;
  /** Default value expression (X++ literal, e.g. `DateTimeUtil::getSystemDateTime()`) */
  defaultValue?: string;
  /** Whether this parameter is mandatory (generates validation in Contract) */
  mandatory?: boolean;
}

interface GenerateSmartReportArgs {
  /** Base report name (prefix applied automatically from model) */
  name: string;
  /** Human-readable caption / label for the report (used in RDL title + menu item) */
  caption?: string;
  /** Comma-separated field hints for the TmpTable (like fieldsHint in generate_smart_table) */
  fieldsHint?: string;
  /** Structured field specs (takes priority over fieldsHint when both provided) */
  fields?: ReportFieldSpec[];
  /** Contract class dialog parameters */
  contractParams?: ContractParamSpec[];
  /** Whether to generate a Controller class (default: true) */
  generateController?: boolean;
  /** RDL design style: SimpleList (default), GroupedWithTotals */
  designStyle?: string;
  /** Copy structure from an existing report (reads fields from its DP's TmpTable) */
  copyFrom?: string;
  /** Model name (auto-detected from projectPath) */
  modelName?: string;
  /** Path to .rnrproj file */
  projectPath?: string;
  /** Path to solution directory */
  solutionPath?: string;
  /** Base packages directory path */
  packagePath?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool definition
// ─────────────────────────────────────────────────────────────────────────────

export const generateSmartReportTool: Tool = {
  name: 'generate_smart_report',
  description:
    `🎨 AI-driven SSRS report generation — creates up to 5 D365FO objects in one call.

Generates:
1. TmpTable (TempDB) — report data storage
2. Contract class (DataContractAttribute) — dialog parameters
3. DP class (SrsReportDataProviderBase) — data processing
4. Controller class (SrsReportRunController) — menu item entry point (optional)
5. AxReport XML + RDL design — dataset + tablix bound to DP/TmpTable

Strategies:
- fieldsHint: comma-separated field names → auto-suggest EDTs, build TmpTable + report fields
- fields: structured field specs with explicit EDTs and data types
- contractParams: dialog parameters → Contract class with parm methods
- copyFrom: copy field structure from existing report's TmpTable
- designStyle: SimpleList (flat tablix) or GroupedWithTotals

Examples:
- generate_smart_report(name="InventByZones", fieldsHint="ItemId, ItemName, Qty, Zone", caption="Inventory by Zones")
- generate_smart_report(name="CustBalance", fieldsHint="CustAccount, Name, Balance", contractParams=[{name: "FromDate", type: "TransDate"}])
- generate_smart_report(name="SalesReport", copyFrom="SalesInvoice")`,
  inputSchema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'Base report name WITHOUT model prefix (e.g. "InventByZones"). Prefix is applied automatically from the model name.',
      },
      caption: {
        type: 'string',
        description: 'Human-readable caption/title for the report (e.g. "Inventory by Zones"). Used in RDL header and menu item.',
      },
      fieldsHint: {
        type: 'string',
        description:
          'Comma-separated field names for the TmpTable (e.g. "ItemId, ItemName, Qty, Zone"). ' +
          'EDTs are auto-suggested from names. Use this for quick generation. ' +
          'For full control, use the `fields` array parameter instead.',
      },
      fields: {
        type: 'array',
        description: 'Structured field specs. Takes priority over fieldsHint.',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Field name' },
            edt: { type: 'string', description: 'EDT name (auto-suggested when omitted)' },
            dataType: { type: 'string', description: '.NET data type for RDL (e.g. "System.String", "System.Double")' },
            label: { type: 'string', description: 'Label ref for column caption' },
          },
          required: ['name'],
        },
      },
      contractParams: {
        type: 'array',
        description: 'Dialog parameters for the Contract class.',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Parameter name (becomes parm method)' },
            type: { type: 'string', description: 'X++ type — EDT or primitive (e.g. "TransDate", "CustAccount")' },
            label: { type: 'string', description: 'Dialog prompt label' },
            mandatory: { type: 'boolean', description: 'Whether parameter is required' },
          },
          required: ['name'],
        },
      },
      generateController: {
        type: 'boolean',
        description: 'Whether to generate a Controller class (default: true)',
      },
      designStyle: {
        type: 'string',
        description: 'RDL design pattern: "SimpleList" (default — flat detail tablix) or "GroupedWithTotals" (row group + sum aggregates)',
      },
      copyFrom: {
        type: 'string',
        description: 'Copy field structure from an existing report name (reads fields from its DP TmpTable)',
      },
      modelName: {
        type: 'string',
        description: 'Model name (auto-detected from projectPath)',
      },
      projectPath: {
        type: 'string',
        description: 'Path to .rnrproj file',
      },
      solutionPath: {
        type: 'string',
        description: 'Path to solution directory',
      },
      packagePath: {
        type: 'string',
        description: 'Base packages directory path',
      },
    },
    required: ['name'],
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Handler
// ─────────────────────────────────────────────────────────────────────────────

export async function handleGenerateSmartReport(
  args: GenerateSmartReportArgs,
  symbolIndex: XppSymbolIndex
): Promise<any> {
  const {
    name,
    caption,
    fieldsHint,
    fields: structuredFields,
    contractParams = [],
    generateController = true,
    designStyle: _designStyle = 'SimpleList', // reserved for GroupedWithTotals in future
    copyFrom,
    modelName,
    projectPath,
    solutionPath,
    packagePath: argPackagePath,
  } = args;

  const log = (msg: string) => console.error(`[generateSmartReport] ${msg}`);
  log(`Generating report: ${name}, fields=${fieldsHint ?? '(structured)'}, copyFrom=${copyFrom ?? 'none'}, contractParams=${contractParams.length}`);

  // ── Resolve model / prefix / paths (same pattern as generateSmartTable) ────
  const configManager = getConfigManager();
  await configManager.ensureLoaded();

  const resolvedPackagePath = argPackagePath || configManager.getPackagePath();
  if (!resolvedPackagePath && process.platform === 'win32') {
    throw new Error(
      '❌ Cannot determine PackagesLocalDirectory path.\n\n' +
      'Neither C:\\AosService\\PackagesLocalDirectory nor K:\\AosService\\PackagesLocalDirectory were found.\n\n' +
      'Add "packagePath" to your .mcp.json or pass packagePath to this tool call.'
    );
  }
  const pkgPath = resolvedPackagePath || 'K:\\AosService\\PackagesLocalDirectory';

  let resolvedProjectPath = projectPath;
  let resolvedSolutionPath = solutionPath;
  if (!resolvedProjectPath && !resolvedSolutionPath) {
    resolvedProjectPath = (await configManager.getProjectPath()) || undefined;
    resolvedSolutionPath = (await configManager.getSolutionPath()) || undefined;
  }

  let resolvedModel = modelName;
  if (resolvedProjectPath) {
    const extracted = extractModelFromProject(resolvedProjectPath);
    if (extracted) resolvedModel = extracted;
  } else if (resolvedSolutionPath) {
    const proj = findProjectInSolution(resolvedSolutionPath);
    if (proj) {
      const extracted = extractModelFromProject(proj);
      if (extracted) resolvedModel = extracted;
    }
  }

  const isNonWindows = process.platform !== 'win32';

  if (!resolvedModel) {
    const configModel = configManager.getModelName();
    const autoModel = configModel ? null : (await configManager.getAutoDetectedModelName());
    resolvedModel = configModel || autoModel || process.env.D365FO_MODEL_NAME || modelName || undefined;
    if (!resolvedModel && !isNonWindows) {
      throw new Error(
        'Could not resolve model name. Provide modelName, projectPath, or solutionPath, ' +
        'or configure projectPath/solutionPath in .mcp.json or set D365FO_MODEL_NAME env var.'
      );
    }
  }

  log(`Model: ${resolvedModel ?? '(none)'}`);

  // Apply prefix
  const objectPrefix = resolvedModel ? resolveObjectPrefix(resolvedModel) : '';
  const finalName = objectPrefix ? applyObjectPrefix(name, objectPrefix) : name;
  if (finalName !== name) log(`Applied prefix: ${name} → ${finalName}`);

  // Derived object names
  const tmpTableName = `${finalName}Tmp`;
  const contractClassName = `${finalName}Contract`;
  const dpClassName = `${finalName}DP`;
  const controllerClassName = `${finalName}Controller`;
  const reportCaption = caption || finalName;

  // ── Resolve fields ─────────────────────────────────────────────────────────
  let reportFields: ReportFieldSpec[] = [];

  // Strategy 1: copyFrom — read fields from existing report's TmpTable
  if (copyFrom) {
    log(`Copying field structure from: ${copyFrom}`);
    try {
      const db = symbolIndex.db;
      // Try to find the DP class's TmpTable
      const dpSearch = db.prepare(
        `SELECT name FROM symbols WHERE type = 'class' AND name LIKE ? LIMIT 1`
      ).get(`${copyFrom}%DP`) as { name: string } | undefined;

      let srcTmpTable: string | undefined;
      if (dpSearch) {
        // Search for a TmpTable-like table referenced by the DP class
        const tmpSearch = db.prepare(
          `SELECT name FROM symbols WHERE type = 'table' AND name LIKE ? LIMIT 1`
        ).get(`${copyFrom}%Tmp`) as { name: string } | undefined;
        srcTmpTable = tmpSearch?.name;
      }

      if (!srcTmpTable) {
        // Try the direct convention: <ReportName>Tmp
        const directTmp = db.prepare(
          `SELECT name FROM symbols WHERE type = 'table' AND name = ? LIMIT 1`
        ).get(`${copyFrom}Tmp`) as { name: string } | undefined;
        srcTmpTable = directTmp?.name;
      }

      if (srcTmpTable) {
        const dbFields = db.prepare(
          `SELECT name, signature FROM symbols WHERE type = 'field' AND parent_name = ? ORDER BY name`
        ).all(srcTmpTable) as Array<{ name: string; signature: string }>;

        reportFields = dbFields
          .filter(f => !['RecId', 'RecVersion', 'DataAreaId', 'Partition', 'TableId'].includes(f.name))
          .map(f => ({
            name: f.name,
            edt: f.signature || undefined,
            dataType: resolveRdlDataType(f.signature, symbolIndex.db),
          }));
        log(`Copied ${reportFields.length} fields from ${srcTmpTable}`);
      } else {
        log(`⚠ Could not find TmpTable for "${copyFrom}" — falling back to fieldsHint`);
      }
    } catch (err) {
      log(`⚠ copyFrom failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Strategy 2: structuredFields (explicit specs from the caller)
  if (structuredFields && structuredFields.length > 0 && reportFields.length === 0) {
    reportFields = structuredFields.map(f => ({
      ...f,
      edt: f.edt || suggestEdtFromFieldName(f.name),
      dataType: f.dataType || resolveRdlDataType(f.edt || suggestEdtFromFieldName(f.name), symbolIndex.db),
    }));
    log(`Using ${reportFields.length} structured fields`);
  }

  // Strategy 3: fieldsHint — parse comma-separated names, suggest EDTs
  if (fieldsHint && reportFields.length === 0) {
    const hints = fieldsHint.split(',').map(s => s.trim()).filter(Boolean);
    reportFields = hints.map(h => {
      const edt = suggestEdtFromFieldName(h);
      return {
        name: h,
        edt,
        dataType: resolveRdlDataType(edt, symbolIndex.db),
      };
    });
    log(`Parsed ${reportFields.length} fields from fieldsHint`);
  }

  // Fallback: no fields at all
  if (reportFields.length === 0) {
    return {
      content: [{
        type: 'text',
        text: [
          `❌ **CANNOT GENERATE REPORT — no fields provided!**`,
          ``,
          `Pass one of:`,
          `- \`fieldsHint="ItemId, Name, Qty, Amount"\` — comma-separated field names`,
          `- \`fields=[{name:"ItemId", edt:"ItemId"}, ...]\` — structured specs`,
          `- \`copyFrom="ExistingReport"\` — copy from another report's TmpTable`,
          ``,
          `⛔ No XML has been generated. Call \`generate_smart_report\` again with fields.`,
        ].join('\n'),
      }],
      isError: true,
    };
  }

  // ── Generate all 5 objects ─────────────────────────────────────────────────
  const generatedObjects: Array<{
    objectType: string;
    objectName: string;
    aotFolder: string;
    content: string;
  }> = [];

  // ──────────────────────────────────────────────────────────────────────────
  // 1. TmpTable (AxTable with TableType=TempDB)
  // ──────────────────────────────────────────────────────────────────────────
  const tableFields: TableFieldSpec[] = reportFields.map(f => ({
    name: f.name,
    edt: f.edt,
    type: resolveFieldType(f.edt, symbolIndex.db),
  }));

  const builder = new SmartXmlBuilder();
  const tmpTableXml = builder.buildTableXml({
    name: tmpTableName,
    label: `${reportCaption} (temp)`,
    tableGroup: 'Framework',
    fields: tableFields,
    indexes: [builder.buildPrimaryKeyIndex(tmpTableName, [tableFields[0]?.name || 'RecId'])],
  });
  // Inject TempDB table type — SmartXmlBuilder doesn't have a tableType param,
  // so we insert it right after <TableGroup>
  const tmpTableXmlFinal = tmpTableXml.replace(
    '</AxTable>',
    '\t<TableType>TempDB</TableType>\n</AxTable>'
  );

  generatedObjects.push({
    objectType: 'table',
    objectName: tmpTableName,
    aotFolder: 'AxTable',
    content: tmpTableXmlFinal,
  });
  log(`Generated TmpTable: ${tmpTableName} (${tableFields.length} fields)`);

  // ──────────────────────────────────────────────────────────────────────────
  // 2. Contract class
  // ──────────────────────────────────────────────────────────────────────────
  const contractParms = contractParams.map(p => ({
    ...p,
    type: p.type || 'str',
  }));

  const contractMemberDecls = contractParms
    .map(p => `    ${p.type} ${p.name};`)
    .join('\n');

  const contractParmMethods = contractParms.map(p => {
    const methodName = `parm${p.name.charAt(0).toUpperCase()}${p.name.slice(1)}`;
    const labelAttr = p.label ? `,\n        SysOperationLabelAttribute('${p.label}')` : '';
    const mandatoryAttr = p.mandatory ? `,\n        SysOperationMandatoryAttribute(true)` : '';
    return [
      `    /// <summary>`,
      `    /// Gets or sets the ${p.name} parameter.`,
      `    /// </summary>`,
      `    /// <param name="_${p.name}">The ${p.name} value.</param>`,
      `    /// <returns>The current ${p.name} value.</returns>`,
      `    [DataMemberAttribute('${p.name}')${labelAttr}${mandatoryAttr}]`,
      `    public ${p.type} ${methodName}(${p.type} _${p.name} = ${p.name})`,
      `    {`,
      `        ${p.name} = _${p.name};`,
      `        return ${p.name};`,
      `    }`,
    ].join('\n');
  }).join('\n\n');

  const contractSourceCode = [
    `/// <summary>`,
    `/// Data contract for the ${reportCaption} report.`,
    `/// Defines dialog parameters shown to the user before report execution.`,
    `/// </summary>`,
    `[DataContractAttribute]`,
    `public class ${contractClassName}`,
    `{`,
    contractMemberDecls || '    // No dialog parameters',
    `}`,
    ``,
    ...(contractParmMethods ? [contractParmMethods] : []),
  ].join('\n');

  const contractXml = XmlTemplateGenerator.generateAxClassXml(
    contractClassName,
    contractSourceCode
  );

  generatedObjects.push({
    objectType: 'class',
    objectName: contractClassName,
    aotFolder: 'AxClass',
    content: contractXml,
  });
  log(`Generated Contract: ${contractClassName} (${contractParms.length} params)`);

  // ──────────────────────────────────────────────────────────────────────────
  // 3. DP class (Data Provider)
  // ──────────────────────────────────────────────────────────────────────────
  const tmpTableVarName = tmpTableName.charAt(0).toLowerCase() + tmpTableName.slice(1);
  const contractVarName = 'contract';

  // Build the processReport body — populates TmpTable from contract parameters
  const fieldAssignments = reportFields.map(f =>
    `            ${tmpTableVarName}.${f.name} = ''; // TODO: populate from data source`
  ).join('\n');

  const contractFetch = contractParms.length > 0
    ? [
        `        ${contractClassName} ${contractVarName} = this.parmDataContract() as ${contractClassName};`,
        ...contractParms.map(p => {
          const methodName = `parm${p.name.charAt(0).toUpperCase()}${p.name.slice(1)}`;
          return `        ${p.type} ${p.name} = ${contractVarName}.${methodName}();`;
        }),
        ``,
      ].join('\n')
    : `        // No contract parameters`;

  const dpSourceCode = [
    `/// <summary>`,
    `/// Data provider for the ${reportCaption} report.`,
    `/// Extends <c>SrsReportDataProviderBase</c> and populates the <c>${tmpTableName}</c> temporary table.`,
    `/// </summary>`,
    `[`,
    `    SRSReportParameterAttribute(classStr(${contractClassName}))`,
    `]`,
    `public class ${dpClassName} extends SrsReportDataProviderBase`,
    `{`,
    `    ${tmpTableName} ${tmpTableVarName};`,
    `}`,
    ``,
    `    /// <summary>`,
    `    /// Returns the temporary table buffer used by the report dataset.`,
    `    /// </summary>`,
    `    /// <returns>The <c>${tmpTableName}</c> table buffer.</returns>`,
    `    [SRSReportDataSetAttribute(tableStr(${tmpTableName}))]`,
    `    public ${tmpTableName} get${tmpTableName}()`,
    `    {`,
    `        select ${tmpTableVarName};`,
    `        return ${tmpTableVarName};`,
    `    }`,
    ``,
    `    /// <summary>`,
    `    /// Main data processing method. Populates the <c>${tmpTableName}</c> temporary table`,
    `    /// with report data based on the contract parameters.`,
    `    /// </summary>`,
    `    public void processReport()`,
    `    {`,
    contractFetch,
    ``,
    `        // TODO: Replace with actual query / business logic`,
    `        // Example pattern:`,
    `        //   while select sourceTable`,
    `        //       where sourceTable.Field == paramValue`,
    `        //   {`,
    `        //       ${tmpTableVarName}.clear();`,
    fieldAssignments,
    `        //       ${tmpTableVarName}.insert();`,
    `        //   }`,
    `    }`,
  ].join('\n');

  const dpXml = XmlTemplateGenerator.generateAxClassXml(dpClassName, dpSourceCode);

  generatedObjects.push({
    objectType: 'class',
    objectName: dpClassName,
    aotFolder: 'AxClass',
    content: dpXml,
  });
  log(`Generated DP: ${dpClassName}`);

  // ──────────────────────────────────────────────────────────────────────────
  // 4. Controller class (optional)
  // ──────────────────────────────────────────────────────────────────────────
  if (generateController) {
    const controllerSourceCode = [
      `/// <summary>`,
      `/// Controller for the ${reportCaption} report.`,
      `/// Extends <c>SrsReportRunController</c> to provide menu item integration`,
      `/// and optional pre-prompt contract modifications.`,
      `/// </summary>`,
      `public class ${controllerClassName} extends SrsReportRunController`,
      `{`,
      `}`,
      ``,
      `    /// <summary>`,
      `    /// Entry point for the report. Creates the controller and starts execution.`,
      `    /// </summary>`,
      `    /// <param name="_args">The <c>Args</c> object from the menu item caller.</param>`,
      `    public static void main(Args _args)`,
      `    {`,
      `        ${controllerClassName} controller = new ${controllerClassName}();`,
      `        controller.parmReportName(ssrsReportStr(${finalName}, Report));`,
      `        controller.parmArgs(_args);`,
      `        controller.startOperation();`,
      `    }`,
      ``,
      `    /// <summary>`,
      `    /// Modifies the contract before the dialog is shown to the user.`,
      `    /// Override to set default parameter values or apply business rules.`,
      `    /// </summary>`,
      `    protected void prePromptModifyContract()`,
      `    {`,
      `        ${contractClassName} ${contractVarName} = this.parmReportContract().parmRdpContract() as ${contractClassName};`,
      `        // TODO: Set default parameter values here`,
      `        // Example: ${contractVarName}.parmFromDate(DateTimeUtil::getToday(DateTimeUtil::getUserPreferredTimeZone()));`,
      `    }`,
    ].join('\n');

    const controllerXml = XmlTemplateGenerator.generateAxClassXml(
      controllerClassName,
      controllerSourceCode
    );

    generatedObjects.push({
      objectType: 'class',
      objectName: controllerClassName,
      aotFolder: 'AxClass',
      content: controllerXml,
    });
    log(`Generated Controller: ${controllerClassName}`);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 5. AxReport XML + RDL
  // ──────────────────────────────────────────────────────────────────────────
  const reportFieldDefs = reportFields.map(f => ({
    name: f.name,
    alias: `${tmpTableName}.1.${f.name}`,
    dataType: f.dataType || 'System.String',
    caption: f.label,
  }));

  const reportContractParams = contractParms.map(p => ({
    name: p.name,
    dataType: contractParamToRdlType(p.type || 'str'),
    label: p.label,
  }));

  const reportXml = XmlTemplateGenerator.generateAxReportXml(finalName, {
    dpClassName,
    tmpTableName,
    datasetName: tmpTableName,
    designName: 'Report',
    caption: reportCaption,
    fields: reportFieldDefs,
    contractParams: reportContractParams,
  });

  generatedObjects.push({
    objectType: 'report',
    objectName: finalName,
    aotFolder: 'AxReport',
    content: reportXml,
  });
  log(`Generated Report: ${finalName} (${reportFieldDefs.length} fields, ${reportContractParams.length} contract params)`);

  // ── Output ─────────────────────────────────────────────────────────────────
  const objectSummary = generatedObjects.map(o => `   - ${o.objectType}: **${o.objectName}**`).join('\n');

  if (isNonWindows) {
    // Azure/Linux: return all XML/source blocks as text
    log(`Non-Windows — returning ${generatedObjects.length} object XMLs as text`);

    const createCalls = generatedObjects.map(o => {
      return [
        `\`\`\``,
        `create_d365fo_file(`,
        `  objectType="${o.objectType}",`,
        `  objectName="${o.objectName}",`,
        `  xmlContent="<XML block #${generatedObjects.indexOf(o) + 1} below>",`,
        `  addToProject=true`,
        `)`,
        `\`\`\``,
      ].join('\n');
    }).join('\n');

    const xmlBlocks = generatedObjects.map((o, i) => {
      return [
        `### ${i + 1}. ${o.objectType}: ${o.objectName}`,
        `\`\`\`xml`,
        o.content,
        `\`\`\``,
      ].join('\n');
    }).join('\n\n');

    return {
      content: [{
        type: 'text',
        text: [
          `✅ SSRS Report generated: **${finalName}** (${generatedObjects.length} objects)`,
          resolvedModel ? `   Model: ${resolvedModel}` : `   ℹ️ No model resolved — no prefix applied.`,
          objectSummary,
          ``,
          `ℹ️ MCP server is running on Azure/Linux — file writing is handled by the local Windows companion.`,
          ``,
          `**✅ MANDATORY NEXT STEPS — call \`create_d365fo_file\` for EACH object below, in this order:**`,
          ``,
          createCalls,
          ``,
          `⛔ NEVER use \`create_file\`, PowerShell scripts, or any built-in file tool.`,
          `⛔ NEVER skip any of the ${generatedObjects.length} create calls — all objects are required for the report to build.`,
          ``,
          `---`,
          ``,
          xmlBlocks,
        ].join('\n'),
      }],
    };
  }

  // Windows: write all objects to disk
  if (!resolvedModel) {
    return {
      content: [{
        type: 'text',
        text:
          `❌ Cannot write report files: model name could not be resolved.\n\n` +
          `Add \`projectPath\` to .mcp.json so the tool can extract the model name from your .rnrproj.`,
      }],
      isError: true,
    };
  }

  const effectiveProjectPath = resolvedProjectPath ||
    (await configManager.getProjectPath()) ||
    undefined;

  const results: string[] = [];
  for (const obj of generatedObjects) {
    const targetPath = path.join(pkgPath, resolvedModel!, resolvedModel!, obj.aotFolder, `${obj.objectName}.xml`);
    const normalizedPath = targetPath.replace(/\//g, '\\');

    const dir = path.dirname(normalizedPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // Reports need UTF-8 BOM
    if (obj.objectType === 'report') {
      const bom = Buffer.from([0xEF, 0xBB, 0xBF]);
      fs.writeFileSync(normalizedPath, Buffer.concat([bom, Buffer.from(obj.content, 'utf-8')]));
    } else {
      fs.writeFileSync(normalizedPath, obj.content, 'utf-8');
    }

    let projectMsg = '';
    if (effectiveProjectPath) {
      try {
        const projectManager = new ProjectFileManager();
        const wasAdded = await projectManager.addToProject(
          effectiveProjectPath,
          obj.objectType as any,
          obj.objectName,
          normalizedPath
        );
        projectMsg = wasAdded ? ' ✅ added to project' : ' (already in project)';
      } catch (e) {
        projectMsg = ` ⚠️ project add failed: ${e instanceof Error ? e.message : String(e)}`;
      }
    }

    results.push(`📁 ${obj.objectType}: ${normalizedPath}${projectMsg}`);
    log(`Created: ${normalizedPath}`);
  }

  return {
    content: [{
      type: 'text',
      text: [
        `✅ SSRS Report **${finalName}** created directly on Windows VM (${generatedObjects.length} objects):`,
        ``,
        `📦 Model: ${resolvedModel}`,
        results.join('\n'),
        ``,
        `⛔ DO NOT call \`create_d365fo_file\` — all files are already written to disk.`,
        `⛔ DO NOT call \`generate_smart_report\` again — task is COMPLETE.`,
        ``,
        `Next steps:`,
        `1. Open Visual Studio and reload the project (close/reopen solution)`,
        `2. Add the SSRS report design in Visual Studio Report Designer`,
        `3. Build the project to compile all objects`,
        `4. Deploy to the report server (right-click report → Deploy)`,
        `5. Create an Output menu item pointing to ${controllerClassName || dpClassName}`,
      ].join('\n'),
    }],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Suggest EDT based on field name heuristics (shared with generateSmartTable).
 */
function suggestEdtFromFieldName(fieldName: string): string {
  const n = fieldName.toLowerCase();
  if (n === 'recid') return 'RecId';
  if (n === 'accountnum' || n === 'accountnumber') return 'CustAccount';
  if (n.includes('custaccount') || n.includes('customeraccount')) return 'CustAccount';
  if (n.includes('vendaccount') || (n.includes('vendor') && n.includes('account'))) return 'VendAccount';
  if (n === 'name' || n === 'itemname') return 'Name';
  if (n.includes('name')) return 'Name';
  if (n === 'description' || n === 'desc') return 'Description';
  if (n.includes('description')) return 'Description';
  if (n.includes('amount') || n.includes('balance')) return 'AmountMST';
  if (n.includes('quantity') || n.includes('qty')) return 'Qty';
  if (n.includes('price')) return 'PriceUnit';
  if (n === 'fromdate' || n === 'validfrom') return 'TransDate';
  if (n === 'todate' || n === 'validto') return 'TransDate';
  if (n.includes('date')) return 'TransDate';
  if (n.includes('itemid') || n === 'item') return 'ItemId';
  if (n.includes('custgroup')) return 'CustGroupId';
  if (n.includes('cust')) return 'CustAccount';
  if (n.includes('vend')) return 'VendAccount';
  if (n.includes('percent') || n.includes('pct')) return 'Percent';
  if (n.includes('zone')) return 'WHSZoneId';
  if (n.includes('warehouse') || n === 'whs') return 'InventLocationId';
  return 'String255';
}

/**
 * Resolve .NET data type for RDL from an EDT name by checking edt_metadata.
 */
function resolveRdlDataType(edtName: string | undefined, db: any): string {
  if (!edtName) return 'System.String';
  const baseType = resolveEdtBaseType(edtName, db);
  switch (baseType) {
    case 'Real':        return 'System.Double';
    case 'Integer':     return 'System.Int32';
    case 'Int64':       return 'System.Int64';
    case 'Date':        return 'System.DateTime';
    case 'UtcDateTime': return 'System.DateTime';
    case 'DateTime':    return 'System.DateTime';
    case 'Guid':
    case 'GUID':        return 'System.String';
    case 'Container':   return 'System.Byte[]';
    case 'Enum':        return 'System.Int32';
    default:            return 'System.String';
  }
}

/**
 * Walk EDT extends chain to find primitive base type (same as generateSmartTable).
 */
function resolveEdtBaseType(edtName: string, db: any, depth = 0): string {
  const PRIMITIVES = new Set([
    'String', 'Integer', 'Int64', 'Real', 'Date', 'UtcDateTime', 'DateTime',
    'Enum', 'Container', 'Guid', 'GUID',
  ]);
  if (depth > 8) return 'String';
  if (PRIMITIVES.has(edtName)) return edtName;
  try {
    const row = db.prepare(
      `SELECT extends FROM edt_metadata WHERE edt_name = ? LIMIT 1`
    ).get(edtName) as { extends: string | null } | undefined;
    if (!row || !row.extends) return 'String';
    if (PRIMITIVES.has(row.extends)) return row.extends;
    return resolveEdtBaseType(row.extends, db, depth + 1);
  } catch { return 'String'; }
}

/**
 * Resolve AxTableField type from EDT (for SmartXmlBuilder).
 */
function resolveFieldType(edtName: string | undefined, db: any): string | undefined {
  if (!edtName) return undefined;
  const base = resolveEdtBaseType(edtName, db);
  // SmartXmlBuilder uses these type strings to pick AxTableFieldXxx
  switch (base) {
    case 'Real':        return 'Real';
    case 'Integer':     return 'Integer';
    case 'Int64':       return 'Int64';
    case 'Date':        return 'Date';
    case 'UtcDateTime': return 'UtcDateTime';
    case 'DateTime':    return 'UtcDateTime';
    case 'Enum':        return 'Enum';
    case 'Container':   return 'Container';
    case 'Guid':
    case 'GUID':        return 'Guid';
    default:            return undefined; // String is default
  }
}

/**
 * Map X++ contract param types to RDL .NET types.
 */
function contractParamToRdlType(xppType: string): string {
  const t = xppType.toLowerCase();
  if (t === 'real' || t === 'amountmst' || t === 'qty' || t === 'percent') return 'System.Double';
  if (t === 'int' || t === 'integer') return 'System.Int32';
  if (t === 'int64' || t === 'recid' || t === 'refrecid') return 'System.Int64';
  if (t.includes('date')) return 'System.DateTime';
  return 'System.String';
}
