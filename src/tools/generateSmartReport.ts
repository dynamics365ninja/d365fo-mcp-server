/**
 * Generate Smart Report Tool
 * AI-driven SSRS report generation using indexed metadata patterns.
 *
 * Generates up to 7+ D365FO objects in a single call:
 *   1. TmpTable(s) (AxTable, TableType=TempDB) — holds report rows; extras for additionalDatasets
 *   2. Contract class (DataContractAttribute) — dialog parameters, optional validate()
 *   3. DP class (SrsReportDataProviderBase/PreProcess) — fills TmpTable, query-based or manual
 *   4. Controller class (SrsReportRunController/SrsPrintMgmtController) — optional
 *   5. Output menu item (AxMenuItemOutput) — generated together with Controller
 *   6. Report (AxReport + RDL) — multi-dataset, page header, optional GroupedWithTotals tablix
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
  /** AOT query name — when provided, DP uses query-based processReport() via this.parmQuery() */
  aotQuery?: string;
  /** Table name of the caller record (e.g. "CustTable") — generates parmArgs() pre-fill in Controller prePromptModifyContract() */
  callerTableName?: string;
  /** When true, DP extends SrsReportDataProviderPreProcess instead of SrsReportDataProviderBase */
  preProcess?: boolean;
  /** Controller variant: "simple" (SrsReportRunController) or "printMgmt" (SrsPrintMgmtController) */
  controllerType?: 'simple' | 'printMgmt';
  /** Additional datasets — each generates an extra TmpTable (TempDB) and a get<Table>() method in the DP */
  additionalDatasets?: Array<{ name: string; fieldsHint?: string; fields?: ReportFieldSpec[] }>;
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
    `🎨 AI-driven SSRS report generation — creates up to 7 D365FO objects in one call.

Generates:
1. TmpTable(s) (TempDB) — report data rows; extra tables for each additionalDatasets entry
2. Contract class — dialog parameters with optional auto-generated validate()
3. DP class (SrsReportDataProviderBase or PreProcess) — with query-based or manual processReport()
4. Controller class (SrsReportRunController or SrsPrintMgmtController) — optional
5. Output menu item (AxMenuItemOutput) — generated together with Controller
6. AxReport XML + RDL — multi-dataset, page header (company/title/date), optional GroupedWithTotals tablix

Strategies:
- fieldsHint: comma-separated field names → auto-suggest EDTs, build TmpTable + report fields
- fields: structured field specs with explicit EDTs and data types
- contractParams: dialog parameters → Contract class with parm methods + validate()
- copyFrom: copy field structure from existing report's TmpTable
- designStyle: "SimpleList" (default) or "GroupedWithTotals" (row group + SUM aggregates)
- aotQuery: query-based DP using this.parmQuery() instead of manual while-select
- callerTableName: pre-fill contract from args.record() in prePromptModifyContract()
- controllerType: "simple" (default) or "printMgmt" (SrsPrintMgmtController)
- preProcess: true → SrsReportDataProviderPreProcess with preProcess() stub
- additionalDatasets: extra TmpTables + DP getters for multi-dataset reports

Examples:
- generate_smart_report(name="InventByZones", fieldsHint="ItemId, ItemName, Qty, Zone", caption="Inventory by Zones")
- generate_smart_report(name="CustBalance", fieldsHint="CustAccount, Name, Balance", contractParams=[{name:"FromDate",type:"TransDate",mandatory:true},{name:"ToDate",type:"TransDate"}])
- generate_smart_report(name="SalesReport", copyFrom="SalesInvoice", designStyle="GroupedWithTotals")
- generate_smart_report(name="CustOpenItems", fieldsHint="CustAccount, Amount, DueDate", callerTableName="CustTable", aotQuery="CustOpenTrans")`,
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
      aotQuery: {
        type: 'string',
        description: 'AOT query name. When provided, the DP uses a query-based processReport() with this.parmQuery() instead of a manual while-select placeholder.',
      },
      callerTableName: {
        type: 'string',
        description: 'Table name of the caller record (e.g. "CustTable"). Generates parmArgs() pre-fill in prePromptModifyContract() that reads args.record() and maps matching fields to contract params.',
      },
      preProcess: {
        type: 'boolean',
        description: 'When true, DP extends SrsReportDataProviderPreProcess instead of SrsReportDataProviderBase. Generates a preProcess() stub and removes [SRSReportParameterAttribute] (contract passed via Controller).',
      },
      controllerType: {
        type: 'string',
        description: '"simple" (default — SrsReportRunController) or "printMgmt" (SrsPrintMgmtController with parmPrintMgmtDocType). Only relevant when generateController=true.',
      },
      additionalDatasets: {
        type: 'array',
        description: 'Extra datasets. Each entry generates an additional TmpTable (TempDB) and a corresponding get<Table>() method in the DP.',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Dataset name suffix (e.g. "Header" → MyReportHeaderTmp)' },
            fieldsHint: { type: 'string', description: 'Comma-separated field names for this extra dataset' },
            fields: {
              type: 'array',
              items: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
            },
          },
          required: ['name'],
        },
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
    designStyle = 'SimpleList',
    copyFrom,
    aotQuery,
    callerTableName,
    preProcess = false,
    controllerType = 'simple',
    additionalDatasets = [],
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

  // ── Resolve additional datasets (Improvement 9) ───────────────────────────
  type ResolvedExtraDataset = {
    name: string;
    tmpTableName: string;
    fields: ReportFieldSpec[];
    tableFields: TableFieldSpec[];
  };
  const resolvedExtraDatasets: ResolvedExtraDataset[] = additionalDatasets.map((ds: { name: string; fieldsHint?: string; fields?: ReportFieldSpec[] }) => {
    const cap = ds.name.charAt(0).toUpperCase() + ds.name.slice(1);
    const dsTmpName = `${finalName}${cap}Tmp`;
    let dsFields: ReportFieldSpec[] = [];
    if (ds.fields && ds.fields.length > 0) {
      dsFields = ds.fields.map((f: ReportFieldSpec) => ({
        ...f,
        edt: f.edt || suggestEdtFromFieldName(f.name),
        dataType: f.dataType || resolveRdlDataType(f.edt || suggestEdtFromFieldName(f.name), symbolIndex.db),
      }));
    } else if (ds.fieldsHint) {
      const hints = ds.fieldsHint.split(',').map((s: string) => s.trim()).filter(Boolean);
      dsFields = hints.map((h: string) => {
        const edt = suggestEdtFromFieldName(h);
        return { name: h, edt, dataType: resolveRdlDataType(edt, symbolIndex.db) };
      });
    }
    return {
      name: ds.name,
      tmpTableName: dsTmpName,
      fields: dsFields,
      tableFields: dsFields.map((f: ReportFieldSpec) => ({
        name: f.name,
        edt: f.edt,
        type: resolveFieldType(f.edt, symbolIndex.db),
      })),
    };
  });

  // ── Generate objects ────────────────────────────────────────────────────────
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

  // Additional TmpTables for multi-dataset (Improvement 9)
  for (const ds of resolvedExtraDatasets) {
    if (ds.tableFields.length === 0) {
      log(`⚠ Skipping extra dataset "${ds.name}" — no fields resolved`);
      continue;
    }
    const dsTblXml = builder.buildTableXml({
      name: ds.tmpTableName,
      label: `${reportCaption} - ${ds.name} (temp)`,
      tableGroup: 'Framework',
      fields: ds.tableFields,
      indexes: [builder.buildPrimaryKeyIndex(ds.tmpTableName, [ds.tableFields[0]?.name || 'RecId'])],
    });
    generatedObjects.push({
      objectType: 'table',
      objectName: ds.tmpTableName,
      aotFolder: 'AxTable',
      content: dsTblXml.replace('</AxTable>', '\t<TableType>TempDB</TableType>\n</AxTable>'),
    });
    log(`Generated extra TmpTable: ${ds.tmpTableName} (${ds.tableFields.length} fields)`);
  }

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
    // Use explicit defaultValue when provided, else fall back to the member variable (standard parm pattern)
    const defaultExpr = p.defaultValue ? p.defaultValue : p.name;
    return [
      `    /// <summary>`,
      `    /// Gets or sets the ${p.name} parameter.`,
      `    /// </summary>`,
      `    /// <param name="_${p.name}">The ${p.name} value.</param>`,
      `    /// <returns>The current ${p.name} value.</returns>`,
      `    [DataMemberAttribute('${p.name}')${labelAttr}${mandatoryAttr}]`,
      `    public ${p.type} ${methodName}(${p.type} _${p.name} = ${defaultExpr})`,
      `    {`,
      `        ${p.name} = _${p.name};`,
      `        return ${p.name};`,
      `    }`,
    ].join('\n');
  }).join('\n\n');

  // ── Build validate() method when there are mandatory params or a date range ─
  const mandatoryContractParams = contractParms.filter(p => p.mandatory);
  const fromDateParam = contractParms.find(p => {
    const n = p.name.toLowerCase();
    return n === 'fromdate' || n === 'validfrom' || n === 'datefrom';
  });
  const toDateParam = contractParms.find(p => {
    const n = p.name.toLowerCase();
    return n === 'todate' || n === 'validto' || n === 'dateto';
  });
  const needsValidate = mandatoryContractParams.length > 0 || (fromDateParam && toDateParam);

  const mandatoryChecks = mandatoryContractParams.map(p => [
    `        if (!${p.name})`,
    `        {`,
    `            ret = checkFailed(strFmt("@SYS53419", "${p.name}"));`,
    `        }`,
  ].join('\n')).join('\n');

  const dateRangeCheck = (fromDateParam && toDateParam) ? [
    `        if (${fromDateParam.name} && ${toDateParam.name} && ${fromDateParam.name} > ${toDateParam.name})`,
    `        {`,
    `            ret = checkFailed(strFmt("@SYS300396", "${fromDateParam.name}"));`,
    `        }`,
  ].join('\n') : '';

  const validateMethod = needsValidate ? [
    `    /// <summary>`,
    `    /// Validates the contract parameters before the report runs.`,
    `    /// </summary>`,
    `    /// <returns>true if all parameters are valid; otherwise false.</returns>`,
    `    public boolean validate()`,
    `    {`,
    `        boolean ret = true;`,
    ...(mandatoryChecks ? [mandatoryChecks] : []),
    ...(dateRangeCheck ? [dateRangeCheck] : []),
    `        return ret;`,
    `    }`,
  ].join('\n') : '';

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
    ...(validateMethod ? ['', validateMethod] : []),
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

  // Determine base class
  const dpBaseClass = preProcess ? 'SrsReportDataProviderPreProcess' : 'SrsReportDataProviderBase';

  // Class-level attributes
  // PreProcess: no [SRSReportParameterAttribute] — contract is passed via Controller
  // aotQuery: add [SRSReportQueryAttribute]
  let dpAttrLines: string[] = [];
  if (!preProcess) dpAttrLines.push(`    SRSReportParameterAttribute(classStr(${contractClassName}))`);
  if (aotQuery)   dpAttrLines.push(`    SRSReportQueryAttribute(queryStr(${aotQuery}))`);
  const dpClassAttr = dpAttrLines.length > 0
    ? `[\n${dpAttrLines.join(',\n')}\n]`
    : '';

  // Contract parameter fetch (skip for PreProcess — contract accessed differently)
  const contractFetchLines = (contractParms.length > 0 && !preProcess)
    ? [
        `        ${contractClassName} ${contractVarName} = this.parmDataContract() as ${contractClassName};`,
        ...contractParms.map(p => {
          const methodName = `parm${p.name.charAt(0).toUpperCase()}${p.name.slice(1)}`;
          return `        ${p.type} ${p.name} = ${contractVarName}.${methodName}();`;
        }),
        ``,
      ]
    : [`        // No contract parameters`];
  const contractFetch = contractFetchLines.join('\n');

  // processReport body — query-based vs manual skeleton
  // For aotQuery: try to resolve the first datasource table so we can generate
  // tableNum()-based, type-safe code instead of the generic Common/getNo(1) fallback.
  const querySourceTable = aotQuery
    ? resolveAotQueryFirstTable(aotQuery, symbolIndex.db)
    : undefined;
  if (querySourceTable) log(`Resolved aotQuery "${aotQuery}" first datasource: ${querySourceTable}`);

  let processReportBody: string;
  if (aotQuery) {
    // tableNum() validates the table exists at X++ compile time — much safer than getNo(1)
    const tableDecl = querySourceTable
      ? `${querySourceTable} sourceRecord = queryRun.get(tableNum(${querySourceTable}));`
      : `Common sourceRecord = queryRun.getNo(1); // TODO: replace Common with the actual table type`;
    const queryAssignments = reportFields.map(f =>
      `            ${tmpTableVarName}.${f.name} = sourceRecord.${f.name}; // TODO: map from ${querySourceTable ?? 'query result'}`
    ).join('\n');
    processReportBody = [
      contractFetch,
      ``,
      `        // Query-based data retrieval \u2014 driven by AOT query "${aotQuery}"`,
      `        QueryRun queryRun = new QueryRun(this.parmQuery());`,
      `        while (queryRun.next())`,
      `        {`,
      `            ${tableDecl}`,
      `            ${tmpTableVarName}.clear();`,
      queryAssignments,
      `            ${tmpTableVarName}.insert();`,
      `        }`,
    ].join('\n');
  } else {
    const fieldComments = reportFields.map(f =>
      `        //       ${tmpTableVarName}.${f.name} = ''; // TODO: populate from data source`
    ).join('\n');
    processReportBody = [
      contractFetch,
      ``,
      `        // TODO: Replace with actual query / business logic`,
      `        // Example pattern:`,
      `        //   while select sourceTable`,
      `        //       where sourceTable.Field == paramValue`,
      `        //   {`,
      `        //       ${tmpTableVarName}.clear();`,
      fieldComments,
      `        //       ${tmpTableVarName}.insert();`,
      `        //   }`,
    ].join('\n');
  }

  // preProcess() stub (Improvement 6)
  const preProcessMethodLines = preProcess ? [
    ``,
    `    /// <summary>`,
    `    /// Called before the report dialog is shown. Use for heavy pre-processing.`,
    `    /// </summary>`,
    `    public void preProcess()`,
    `    {`,
    `        // TODO: Implement pre-processing logic (called BEFORE the report dialog).`,
    `        // Prepare data, validate prerequisites, or set session-scoped variables.`,
    `    }`,
  ] : [];

  // Additional member variable declarations for extra datasets
  const extraDpMembers = resolvedExtraDatasets
    .map(ds => `    ${ds.tmpTableName} ${ds.tmpTableName.charAt(0).toLowerCase() + ds.tmpTableName.slice(1)};`)
    .join('\n');

  // Additional get<Table>() methods for extra datasets
  const extraDpGetters = resolvedExtraDatasets.map(ds => {
    const varN = ds.tmpTableName.charAt(0).toLowerCase() + ds.tmpTableName.slice(1);
    return [
      ``,
      `    /// <summary>`,
      `    /// Returns the <c>${ds.tmpTableName}</c> buffer for the "${ds.name}" dataset.`,
      `    /// </summary>`,
      `    /// <returns>The <c>${ds.tmpTableName}</c> table buffer.</returns>`,
      `    [SRSReportDataSetAttribute(tableStr(${ds.tmpTableName}))]`,
      `    public ${ds.tmpTableName} get${ds.tmpTableName}()`,
      `    {`,
      `        select ${varN};`,
      `        return ${varN};`,
      `    }`,
    ].join('\n');
  }).join('\n');

  const dpSourceCode = [
    `/// <summary>`,
    `/// Data provider for the ${reportCaption} report.`,
    `/// Extends <c>${dpBaseClass}</c> and populates the <c>${tmpTableName}</c> temporary table.`,
    `/// </summary>`,
    dpClassAttr,
    `public class ${dpClassName} extends ${dpBaseClass}`,
    `{`,
    `    ${tmpTableName} ${tmpTableVarName};`,
    ...(extraDpMembers ? [extraDpMembers] : []),
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
    ...(extraDpGetters ? [extraDpGetters] : []),
    ...preProcessMethodLines,
    ``,
    `    /// <summary>`,
    `    /// Main data processing method. Populates the <c>${tmpTableName}</c> temporary table`,
    `    /// with report data based on the contract parameters.`,
    `    /// </summary>`,
    `    public void processReport()`,
    `    {`,
    processReportBody,
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
    const isPrintMgmt = controllerType === 'printMgmt';
    const ctrlBaseClass = isPrintMgmt ? 'SrsPrintMgmtController' : 'SrsReportRunController';

    // Build main() — differs between simple and printMgmt
    const mainMethod = isPrintMgmt ? [
      `    /// <summary>`,
      `    /// Entry point. Creates a print-management controller and starts the report.`,
      `    /// </summary>`,
      `    /// <param name="_args">The <c>Args</c> object from the menu item caller.</param>`,
      `    public static void main(Args _args)`,
      `    {`,
      `        ${controllerClassName} controller = new ${controllerClassName}();`,
      `        controller.parmArgs(_args);`,
      `        // TODO: Replace SalesOrderConfirmation with the correct PrintMgmtDocumentType`,
      `        controller.parmPrintMgmtDocType(PrintMgmtDocumentType::SalesOrderConfirmation);`,
      `        controller.parmReportName(ssrsReportStr(${finalName}, Report));`,
      `        controller.startOperation();`,
      `    }`,
    ].join('\n') : [
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
    ].join('\n');

    // Build prePromptModifyContract() — with optional parmArgs() pre-fill (Improvement 2)
    let prePromptBody: string;
    if (callerTableName && contractParms.length > 0) {
      // Try to match contract params to caller table fields by name heuristics
      const callerVarName = callerTableName.charAt(0).toLowerCase() + callerTableName.slice(1);
      const prefillLines = contractParms.flatMap(p => {
        // Heuristic: param name matches a field pattern on the caller table
        // e.g. CustAccount → callerRecord.AccountNum  (common D365FO convention)
        const fieldGuess = p.name.charAt(0).toUpperCase() + p.name.slice(1); // CustAccount → CustAccount
        const methodName = `parm${p.name.charAt(0).toUpperCase()}${p.name.slice(1)}`;
        return [
          `        if (${callerVarName}.${fieldGuess} != ${p.type === 'TransDate' ? 'dateNull()' : (p.type === 'str' || !p.type) ? '""' : '0'})`,
          `            ${contractVarName}.${methodName}(${callerVarName}.${fieldGuess});`,
        ];
      });
      prePromptBody = [
        `        ${contractClassName} ${contractVarName} = this.parmReportContract().parmRdpContract() as ${contractClassName};`,
        `        ${callerTableName} ${callerVarName} = this.parmArgs().record() as ${callerTableName};`,
        `        if (${callerVarName})`,
        `        {`,
        ...prefillLines.map(l => `    ${l}`),
        `        }`,
      ].join('\n');
    } else {
      prePromptBody = [
        `        ${contractClassName} ${contractVarName} = this.parmReportContract().parmRdpContract() as ${contractClassName};`,
        `        // TODO: Set default parameter values here`,
        `        // Example: ${contractVarName}.parmFromDate(DateTimeUtil::getToday(DateTimeUtil::getUserPreferredTimeZone()));`,
      ].join('\n');
    }

    const prePromptMethod = [
      `    /// <summary>`,
      `    /// Modifies the contract before the dialog is shown to the user.`,
      `    /// Override to set default parameter values or pre-fill from the caller record.`,
      `    /// </summary>`,
      `    protected void prePromptModifyContract()`,
      `    {`,
      prePromptBody,
      `    }`,
    ].join('\n');

    const controllerSourceCode = [
      `/// <summary>`,
      `/// Controller for the ${reportCaption} report.`,
      `/// Extends <c>${ctrlBaseClass}</c> to provide menu item integration`,
      `/// and pre-prompt contract initialization.`,
      `/// </summary>`,
      `public class ${controllerClassName} extends ${ctrlBaseClass}`,
      `{`,
      `}`,
      ``,
      mainMethod,
      ``,
      prePromptMethod,
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
    log(`Generated Controller: ${controllerClassName} (${controllerType}, callerTable=${callerTableName ?? 'none'})`);

    // ── 5. Output menu item (AxMenuItemOutput) ─────────────────────────────
    const menuItemXml = XmlTemplateGenerator.generateAxMenuItemXml(
      'menu-item-output',
      finalName,
      {
        targetObject: controllerClassName,
        objectType: 'Class',
        label: reportCaption,
      }
    );
    generatedObjects.push({
      objectType: 'menu-item-output',
      objectName: finalName,
      aotFolder: 'AxMenuItemOutput',
      content: menuItemXml,
    });
    log(`Generated output menu item: ${finalName} → ${controllerClassName}`);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 6. AxReport XML + RDL (multi-dataset, page header, optional grouped tablix)
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

  // Build report properties — multi-dataset when additionalDatasets present (Improvement 9)
  const reportProps: Record<string, any> = {
    designName: 'Report',
    caption: reportCaption,
    contractParams: reportContractParams,
  };

  if (resolvedExtraDatasets.length > 0) {
    reportProps.datasets = [
      {
        name: tmpTableName,
        dpClassName,
        tmpTableName,
        fields: reportFieldDefs,
        contractParams: reportContractParams,
        ...(aotQuery ? { aotQuery } : {}),
      },
      ...resolvedExtraDatasets.map(ds => ({
        name: ds.tmpTableName,
        dpClassName,
        tmpTableName: ds.tmpTableName,
        fields: ds.fields.map(f => ({
          name: f.name,
          alias: `${ds.tmpTableName}.1.${f.name}`,
          dataType: f.dataType || 'System.String',
          caption: f.label,
        })),
      })),
    ];
  } else {
    reportProps.dpClassName = dpClassName;
    reportProps.tmpTableName = tmpTableName;
    reportProps.datasetName = tmpTableName;
    reportProps.fields = reportFieldDefs;
    if (aotQuery) reportProps.aotQuery = aotQuery;
  }

  let reportXml = XmlTemplateGenerator.generateAxReportXml(finalName, reportProps);

  // Improvement 7: inject RDL page header (always on — company name, title, execution time)
  reportXml = injectRdlPageHeader(reportXml, reportCaption);

  // Improvement 1: replace standard tablix with grouped design when requested
  if (designStyle === 'GroupedWithTotals') {
    reportXml = injectGroupedTablix(reportXml, reportFields, tmpTableName);
    log(`Applied GroupedWithTotals RDL design`);
  }

  generatedObjects.push({
    objectType: 'report',
    objectName: finalName,
    aotFolder: 'AxReport',
    content: reportXml,
  });
  log(`Generated Report: ${finalName} (${reportFieldDefs.length} fields, ${reportContractParams.length} contract params, ${resolvedExtraDatasets.length} extra datasets)`);

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
        `2. Open the AxReport in Report Designer and fine-tune the RDL design`,
        `3. Build the project to compile all objects`,
        `4. Deploy to the report server (right-click report → Deploy)`,
      ].join('\n'),
    }],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

// ── Improvement 7: RDL page header injection ──────────────────────────────────
/**
 * Injects an RDL <PageHeader> with company name, report title, and execution time
 * into every ReportSection inside the AxReport XML (CDATA-embedded RDL).
 * The header is placed before the closing </ReportSection> tag.
 */
function injectRdlPageHeader(axReportXml: string, caption: string): string {
  const pageHeaderXml = [
    `      <PageHeader>`,
    `        <PrintOnFirstPage>true</PrintOnFirstPage>`,
    `        <PrintOnLastPage>true</PrintOnLastPage>`,
    `        <Height>0.5in</Height>`,
    `        <ReportItems>`,
    `          <Textbox Name="CompanyName">`,
    `            <CanGrow>true</CanGrow>`,
    `            <Value>=Parameters!AX_CompanyName.Value</Value>`,
    `            <Style><FontWeight>Bold</FontWeight><FontSize>10pt</FontSize></Style>`,
    `            <Top>0in</Top><Left>0in</Left><Width>4in</Width><Height>0.25in</Height>`,
    `          </Textbox>`,
    `          <Textbox Name="ReportTitle">`,
    `            <CanGrow>true</CanGrow>`,
    `            <Value>${caption.replace(/[<>&"]/g, c => c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '&' ? '&amp;' : '&quot;')}</Value>`,
    `            <Style><FontSize>9pt</FontSize></Style>`,
    `            <Top>0.25in</Top><Left>0in</Left><Width>4in</Width><Height>0.25in</Height>`,
    `          </Textbox>`,
    `          <Textbox Name="ExecutionTime">`,
    `            <CanGrow>true</CanGrow>`,
    `            <Value>=Globals!ExecutionTime</Value>`,
    `            <Style><TextAlign>Right</TextAlign><FontSize>8pt</FontSize></Style>`,
    `            <Top>0in</Top><Left>4in</Left><Width>3in</Width><Height>0.25in</Height>`,
    `          </Textbox>`,
    `        </ReportItems>`,
    `      </PageHeader>`,
  ].join('\n');
  // Inject before <Body> (correct per RDL 2016 schema: PageHeader must precede Body)
  return axReportXml.replace(/(<ReportSection>)(\n\s*)(<Body>)/g, `$1$2${pageHeaderXml}$2$3`);
}

// ── Improvement 1: GroupedWithTotals tablix injection ────────────────────────
/**
 * Replaces the auto-generated flat detail tablix in the RDL with a grouped tablix.
 * Groups on the first non-numeric field; adds SUM() subtotals for numeric fields,
 * and a grand-total footer row at the bottom.
 */
function injectGroupedTablix(
  axReportXml: string,
  fields: ReportFieldSpec[],
  datasetName: string
): string {
  if (fields.length === 0) return axReportXml;

  // Classify fields
  const numericTypes = new Set(['System.Double', 'System.Int32', 'System.Int64']);
  const groupField = fields.find(f => !numericTypes.has(f.dataType ?? '')) ?? fields[0];
  const numericFields = fields.filter(f => numericTypes.has(f.dataType ?? ''));

  const n = fields.length;
  const colW = +Math.min(1.5, 7 / n).toFixed(2);
  const totalW = +(colW * n).toFixed(2);
  const rowGrp = `Group_${groupField.name}`;
  const detailGrp = `Details_${datasetName}`;

  const cols = fields.map(() =>
    `            <TablixColumn><Width>${colW}in</Width></TablixColumn>`).join('\n');

  // Header row (bold grey)
  const hCells = fields.map(f => [
    `            <TablixCell><CellContents>`,
    `              <Textbox Name="Hdr_${f.name}">`,
    `                <CanGrow>true</CanGrow><Value>${f.name}</Value>`,
    `                <Style><FontWeight>Bold</FontWeight><BackgroundColor>LightGrey</BackgroundColor>`,
    `                  <Border><Style>Solid</Style></Border>`,
    `                  <PaddingLeft>2pt</PaddingLeft><PaddingRight>2pt</PaddingRight>`,
    `                  <PaddingTop>2pt</PaddingTop><PaddingBottom>2pt</PaddingBottom>`,
    `                </Style></Textbox>`,
    `            </CellContents></TablixCell>`,
  ].join('\n')).join('\n');

  // Group header row (field value + subtotals for numerics, light blue)
  const grpCells = fields.map(f => {
    const isGrp = f.name === groupField.name;
    const isNum = numericFields.some(nf => nf.name === f.name);
    const val = isGrp ? `=Fields!${f.name}.Value` : isNum ? `=Sum(Fields!${f.name}.Value)` : ``;
    return [
      `            <TablixCell><CellContents>`,
      `              <Textbox Name="Grp_${f.name}">`,
      `                <CanGrow>true</CanGrow><Value>${val}</Value>`,
      `                <Style><FontWeight>Bold</FontWeight><BackgroundColor>AliceBlue</BackgroundColor>`,
      `                  <Border><Style>Solid</Style></Border>`,
      `                  <PaddingLeft>2pt</PaddingLeft><PaddingRight>2pt</PaddingRight>`,
      `                  <PaddingTop>2pt</PaddingTop><PaddingBottom>2pt</PaddingBottom>`,
      `                </Style></Textbox>`,
      `            </CellContents></TablixCell>`,
    ].join('\n');
  }).join('\n');

  // Detail row
  const dCells = fields.map(f => [
    `            <TablixCell><CellContents>`,
    `              <Textbox Name="Det_${f.name}">`,
    `                <CanGrow>true</CanGrow><Value>=Fields!${f.name}.Value</Value>`,
    `                <Style><Border><Style>Solid</Style></Border>`,
    `                  <PaddingLeft>2pt</PaddingLeft><PaddingRight>2pt</PaddingRight>`,
    `                  <PaddingTop>2pt</PaddingTop><PaddingBottom>2pt</PaddingBottom>`,
    `                </Style></Textbox>`,
    `            </CellContents></TablixCell>`,
  ].join('\n')).join('\n');

  // Grand total footer row (yellow)
  const totCells = fields.map(f => {
    const isNum = numericFields.some(nf => nf.name === f.name);
    const val = isNum ? `=Sum(Fields!${f.name}.Value)` : (f.name === groupField.name ? `"Total"` : `""`);
    return [
      `            <TablixCell><CellContents>`,
      `              <Textbox Name="Tot_${f.name}">`,
      `                <CanGrow>true</CanGrow><Value>${val}</Value>`,
      `                <Style><FontWeight>Bold</FontWeight><BackgroundColor>LightYellow</BackgroundColor>`,
      `                  <Border><Style>Solid</Style></Border>`,
      `                  <PaddingLeft>2pt</PaddingLeft><PaddingRight>2pt</PaddingRight>`,
      `                  <PaddingTop>2pt</PaddingTop><PaddingBottom>2pt</PaddingBottom>`,
      `                </Style></Textbox>`,
      `            </CellContents></TablixCell>`,
    ].join('\n');
  }).join('\n');

  const cMembers = fields.map(() => `          <TablixMember />`).join('\n');

  const groupedTablix = [
    `        <Tablix Name="Tablix_${datasetName}">`,
    `          <TablixBody>`,
    `            <TablixColumns>`,
    cols,
    `            </TablixColumns>`,
    `            <TablixRows>`,
    `              <TablixRow><Height>0.25in</Height><TablixCells>`,
    hCells,
    `              </TablixCells></TablixRow>`,
    `              <TablixRow><Height>0.25in</Height><TablixCells>`,
    grpCells,
    `              </TablixCells></TablixRow>`,
    `              <TablixRow><Height>0.25in</Height><TablixCells>`,
    dCells,
    `              </TablixCells></TablixRow>`,
    `              <TablixRow><Height>0.25in</Height><TablixCells>`,
    totCells,
    `              </TablixCells></TablixRow>`,
    `            </TablixRows>`,
    `          </TablixBody>`,
    `          <TablixColumnHierarchy><TablixMembers>`,
    cMembers,
    `          </TablixMembers></TablixColumnHierarchy>`,
    `          <TablixRowHierarchy><TablixMembers>`,
    `            <TablixMember>`,
    `              <KeepWithGroup>After</KeepWithGroup>`,
    `              <RepeatOnNewPage>true</RepeatOnNewPage>`,
    `            </TablixMember>`,
    `            <TablixMember>`,
    `              <Group Name="${rowGrp}">`,
    `                <DataGroupName>${rowGrp}</DataGroupName>`,
    `                <GroupExpressions>`,
    `                  <GroupExpression>=Fields!${groupField.name}.Value</GroupExpression>`,
    `                </GroupExpressions>`,
    `              </Group>`,
    `              <TablixMembers>`,
    `                <TablixMember><Group Name="${detailGrp}"><DataGroupName>${detailGrp}</DataGroupName></Group></TablixMember>`,
    `              </TablixMembers>`,
    `            </TablixMember>`,
    `            <TablixMember>`,
    `              <Group Name="Total_${datasetName}"><DataGroupName>Total_${datasetName}</DataGroupName></Group>`,
    `            </TablixMember>`,
    `          </TablixMembers></TablixRowHierarchy>`,
    `          <DataSetName>${datasetName}</DataSetName>`,
    `          <Top>0.5in</Top><Left>0.5in</Left>`,
    `          <Height>1in</Height><Width>${totalW}in</Width>`,
    `          <Style><Border><Style>Solid</Style></Border></Style>`,
    `        </Tablix>`,
  ].join('\n');

  // Replace the existing flat tablix for this dataset
  const tablixRe = new RegExp(
    `        <Tablix Name="Tablix_${datasetName}">[\\s\\S]*?        </Tablix>`,
    'g'
  );
  const replaced = axReportXml.replace(tablixRe, groupedTablix);
  // If nothing matched (e.g. no fields were generated), return unchanged
  return replaced;
}

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
 * Resolve the first datasource table name for an AOT query from the symbol index.
 * When found the caller can generate `tableNum(TableName)` — a compile-time-validated
 * table reference — instead of the generic `getNo(1)` / `Common` pattern.
 * Returns undefined when the query is not in the index (non-Windows, or unknown query).
 */
function resolveAotQueryFirstTable(queryName: string, db: any): string | undefined {
  try {
    // Strategy 1: explicit query_datasource symbols (parent_name = query name)
    const ds = db.prepare(
      `SELECT name FROM symbols
       WHERE type IN ('query_datasource','querydatasource','QueryDataSource')
         AND parent_name = ?
       ORDER BY rowid
       LIMIT 1`
    ).get(queryName) as { name: string } | undefined;
    if (ds?.name) return ds.name;

    // Strategy 2: query symbol's signature may contain comma-separated table names
    const q = db.prepare(
      `SELECT signature FROM symbols
       WHERE type IN ('query','Query')
         AND name = ?
       LIMIT 1`
    ).get(queryName) as { signature: string | null } | undefined;
    if (q?.signature) {
      const first = q.signature.split(/[,;|]/)[0].trim();
      if (first) return first;
    }

    return undefined;
  } catch {
    return undefined;
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
