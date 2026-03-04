/**
 * D365FO File Creator Tool
 * Creates physical XML files in the AOT package structure
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { Parser, Builder } from 'xml2js';
import { getConfigManager } from '../utils/configManager.js';
import { registerCustomModel, resolveObjectPrefix, applyObjectPrefix } from '../utils/modelClassifier.js';
import { PackageResolver } from '../utils/packageResolver.js';

const CreateD365FileArgsSchema = z.object({
  objectType: z
    .enum([
      'class', 'table', 'enum', 'form', 'query', 'view', 'data-entity', 'report',
      'edt', 'edt-extension',
      'table-extension', 'form-extension', 'data-entity-extension', 'enum-extension',
      'menu-item-display', 'menu-item-action', 'menu-item-output',
      'menu-item-display-extension', 'menu-item-action-extension', 'menu-item-output-extension',
      'menu', 'menu-extension',
      'security-privilege', 'security-duty', 'security-role',
    ])
    .describe('Type of D365FO object to create'),
  objectName: z
    .string()
    .describe('Name of the object (e.g., MyHelperClass, MyCustomTable)'),
  modelName: z
    .string()
    .optional()
    .describe('Model name (e.g., ContosoExtensions). Auto-detected from mcp.json if omitted.'),
  packageName: z
    .string()
    .optional()
    .describe('Package name (e.g., CustomExtensions, ApplicationSuite). Auto-resolved from model name if omitted.'),
  packagePath: z
    .string()
    .optional()
    .describe('Base package path (default: K:\\AosService\\PackagesLocalDirectory)'),
  sourceCode: z
    .string()
    .optional()
    .describe('X++ source code for the object (class declaration, methods, etc.)'),
  properties: z
    .record(z.string(), z.any())
    .optional()
    .describe('Additional properties for the object (extends, implements, etc.)'),
  addToProject: z
    .boolean()
    .optional()
    .default(true)
    .describe('Whether to automatically add file to Visual Studio project (default: true — always pass true unless explicitly told not to)'),
  projectPath: z
    .string()
    .optional()
    .describe('Path to .rnrproj file. Required for addToProject to work. If not specified, auto-detected from .mcp.json or workspace context.'),
  solutionPath: z
    .string()
    .optional()
    .describe('Path to active VS solution directory. Used to find .rnrproj when projectPath is not given.'),
  xmlContent: z
    .string()
    .optional()
    .describe(
      'Custom XML content to write verbatim instead of generating a template. ' +
      'Use this in hybrid setups: call generate_smart_table / generate_smart_form on Azure ' +
      'to get AI-driven XML, then pass that XML here on the local Windows VM to write the file ' +
      'and add it to the VS2022 project.'
    ),
  overwrite: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      'Allow overwriting an existing file. Use together with xmlContent when you need to completely ' +
      'rewrite an object (e.g. table with corrupted field names). Default: false (returns error if file already exists).'
    ),
});

/**
 * Project File Finder
 * Finds .rnrproj files in solution directory or specific paths
 */
class ProjectFileFinder {
  /**
   * Find .rnrproj file in solution directory
   * Recursively searches for .rnrproj files matching the model name (up to 3 levels deep)
   */
  static async findProjectInSolution(
    solutionPath: string,
    modelName: string
  ): Promise<string | null> {
    return ProjectFileFinder.findRecursive(solutionPath, modelName, 0, 3);
  }

  private static async findRecursive(
    dir: string,
    modelName: string,
    currentDepth: number,
    maxDepth: number
  ): Promise<string | null> {
    if (currentDepth > maxDepth) return null;

    try {
      await fs.access(dir);
    } catch {
      return null;
    }

    let files: string[];
    try {
      files = await fs.readdir(dir);
    } catch {
      return null;
    }

    // Check .rnrproj files at this level first
    const projectFiles = files.filter(file =>
      file.endsWith('.rnrproj') &&
      (file.includes(modelName) || file === `${modelName}.rnrproj`)
    );

    if (projectFiles.length > 0) {
      return path.join(dir, projectFiles[0]);
    }

    // Recurse into subdirectories
    for (const file of files) {
      const fullPath = path.join(dir, file);
      try {
        const stat = await fs.stat(fullPath);
        if (stat.isDirectory()) {
          const found = await ProjectFileFinder.findRecursive(fullPath, modelName, currentDepth + 1, maxDepth);
          if (found) return found;
        }
      } catch {
        continue;
      }
    }

    return null;
  }
}

/**
 * Map a D365FO base type name to the XML i:type attribute used in <AxTableField>.
 * If the explicit fieldType is not a known primitive, fall back to name-based heuristics
 * using edtName (same heuristics as SmartXmlBuilder.getAxTableFieldType).
 */
function fieldTypeToAxType(fieldType: string, edtName?: string): string {
  const typeMap: Record<string, string> = {
    String:      'AxTableFieldString',
    Integer:     'AxTableFieldInt',
    Int64:       'AxTableFieldInt64',
    Real:        'AxTableFieldReal',
    Date:        'AxTableFieldDate',
    DateTime:    'AxTableFieldUtcDateTime',
    UtcDateTime: 'AxTableFieldUtcDateTime',
    Enum:        'AxTableFieldEnum',
    GUID:        'AxTableFieldGuid',
    Guid:        'AxTableFieldGuid',
    Container:   'AxTableFieldContainer',
  };

  const explicit = typeMap[fieldType];
  if (explicit) return explicit;

  // Fall back to EDT name heuristics (mirrors SmartXmlBuilder.getAxTableFieldType)
  const hint = edtName || fieldType;
  if (hint) {
    const e = hint.toLowerCase();
    if (e === 'recid' || e.endsWith('recid') || e.includes('refrecid')) return 'AxTableFieldInt64';
    if (e.includes('utcdatetime') || (e.includes('datetime') && !e.includes('transdate'))) return 'AxTableFieldUtcDateTime';
    if (e.includes('date') && !e.includes('time') && !e.includes('update')) return 'AxTableFieldDate';
    if (e.includes('amount') || e.includes('mst') || e.includes('price') || e.includes('qty')
        || e.includes('percent') || e === 'real') return 'AxTableFieldReal';
    if (e === 'noyesid' || e.endsWith('noyesid') || e === 'noyes') return 'AxTableFieldEnum';
    if ((e.endsWith('int') || e.includes('count') || e.includes('level'))
        && !e.includes('account') && !e.includes('name')) return 'AxTableFieldInt';
  }

  return 'AxTableFieldString';
}

/**
 * XML Templates for different D365FO object types
 */
export class XmlTemplateGenerator {

  /**
   * Split X++ class source into the Declaration block (class header + field
   * declarations) and individual method bodies, as required by D365FO XML.
   *
   * D365FO XML structure:
   *   <Declaration> = class keyword + field declarations (the outer {} block)
   *   <Methods>     = one <Method><Name/><Source/></Method> per method body
   *
   * AI generators often emit the entire source (header + methods) as a single
   * string.  This helper separates them so the generated XML is correct.
   */
  static splitXppClassSource(fullSource: string): {
    declaration: string;
    methods: Array<{ name: string; source: string }>;
  } {
    // Find the '{' that opens the class body
    const firstBrace = fullSource.indexOf('{');
    if (firstBrace === -1) return { declaration: fullSource, methods: [] };

    // Walk to the matching '}' that closes the class header block
    let depth = 0;
    let classEndIdx = -1;
    for (let i = firstBrace; i < fullSource.length; i++) {
      if (fullSource[i] === '{') depth++;
      else if (fullSource[i] === '}') {
        depth--;
        if (depth === 0) { classEndIdx = i; break; }
      }
    }
    if (classEndIdx === -1) return { declaration: fullSource, methods: [] };

    let declaration = fullSource.substring(0, classEndIdx + 1);
    const rest = fullSource.substring(classEndIdx + 1);
    if (!rest.trim()) return { declaration, methods: [] };

    // ── FIX: Rescue member-variable declarations that appear OUTSIDE the class {}
    // Some AI generators emit variable declarations after the class closing brace but
    // before the first method (e.g. "}\nint myVar;\npublic void foo() { }").
    // D365FO requires them inside the <Declaration> CDATA block. Detect and inject them now.
    const nextBraceInRest = rest.indexOf('{');
    if (nextBraceInRest !== -1) {
      const preMethodText = rest.substring(0, nextBraceInRest);
      const varLines = preMethodText
        .split('\n')
        .filter(l => {
          const t = l.trim();
          // A variable declaration ends with ';' and does NOT contain '(' (not a method call/signature)
          return t.endsWith(';') && !t.includes('(');
        });
      if (varLines.length > 0) {
        // Inject the rescued declarations into the class body, just before the closing '}'
        const injected = varLines.map(l => '    ' + l.trim()).join('\n');
        declaration = declaration.replace(/}(\s*)$/, `\n${injected}\n}`);
        console.error(
          `[splitXppClassSource] Rescued ${varLines.length} member variable declaration(s) ` +
          'found outside the class {} block — injected into <Declaration>.'
        );
      }
    }

    // Parse each method block from the remaining source
    const methods: Array<{ name: string; source: string }> = [];
    let pos = 0;
    while (pos < rest.length) {
      const nextBrace = rest.indexOf('{', pos);
      if (nextBrace === -1) break;

      const sigText = rest.substring(pos, nextBrace);

      // Find the matching '}' for this method body (depth-counting)
      let d = 0;
      let bodyEnd = -1;
      for (let i = nextBrace; i < rest.length; i++) {
        if (rest[i] === '{') d++;
        else if (rest[i] === '}') {
          d--;
          if (d === 0) { bodyEnd = i; break; }
        }
      }
      if (bodyEnd === -1) break;

      const methodSource = rest.substring(pos, bodyEnd + 1).trim();

      // Extract method name: last identifier before '(' in the signature
      const parenIdx = sigText.lastIndexOf('(');
      const nameMatch =
        parenIdx !== -1 ? sigText.substring(0, parenIdx).match(/(\w+)\s*$/) : null;
      const methodName = nameMatch ? nameMatch[1] : `method${methods.length + 1}`;

      methods.push({ name: methodName, source: methodSource });
      pos = bodyEnd + 1;
    }

    return { declaration, methods };
  }
  /**
   * Generate AxClass XML structure
   */
  static generateAxClassXml(
    className: string,
    sourceCode?: string,
    properties?: Record<string, any>
  ): string {
    const rawSource = sourceCode || `public class ${className}\n{\n}`;

    // Split full X++ source into Declaration (class header + fields) and Methods.
    // D365FO XML requires member variable declarations in <Declaration> and
    // each method body as a separate <Method> element under <Methods>.
    const { declaration, methods } = XmlTemplateGenerator.splitXppClassSource(rawSource);

    const extendsAttr = properties?.extends
      ? `\t<Extends>${properties.extends}</Extends>\n`
      : '';
    const implementsAttr = properties?.implements
      ? `\t<Implements>${properties.implements}</Implements>\n`
      : '';
    const isFinalAttr = properties?.isFinal ? `\t<IsFinal>Yes</IsFinal>\n` : '';
    const isAbstractAttr = properties?.isAbstract
      ? `\t<IsAbstract>Yes</IsAbstract>\n`
      : '';

    // D365FO convention: method source is always indented by 4 spaces inside <Source>.
    // This matches what VS writes and what the compiler/Designer expect to see.
    const indentMethodSource = (src: string): string =>
      src.split('\n').map(line => '    ' + line).join('\n');

    const methodsXml =
      methods.length === 0
        ? '\t\t<Methods />\n'
        : `\t\t<Methods>\n${methods
            .map(
              m =>
                `\t\t\t<Method>\n\t\t\t\t<Name>${m.name}</Name>\n\t\t\t\t<Source><![CDATA[\n${indentMethodSource(m.source)}\n]]></Source>\n\t\t\t</Method>`
            )
            .join('\n\n')}\n\t\t</Methods>\n`;

    return `<?xml version="1.0" encoding="utf-8"?>
<AxClass xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
\t<Name>${className}</Name>
${extendsAttr}${implementsAttr}${isFinalAttr}${isAbstractAttr}\t<SourceCode>
\t\t<Declaration><![CDATA[
${declaration}
]]></Declaration>
${methodsXml}\t</SourceCode>
</AxClass>
`;
  }

  /**
   * Generate AxTable XML structure (based on real D365FO table structure)
   */
  static generateAxTableXml(
    tableName: string,
    properties?: Record<string, any>
  ): string {
    const label = properties?.label || tableName;
    const tableGroup = properties?.tableGroup || 'Main';
    const titleField1 = properties?.titleField1 || '';
    const titleField2 = properties?.titleField2 || '';
    const configKey = properties?.configurationKey || '';
    const primaryIndex = properties?.primaryIndex || '';
    const cacheLookup = properties?.cacheLookup || '';

    // Build optional configuration key
    const configKeyXml = configKey
      ? `\t<ConfigurationKey>${configKey}</ConfigurationKey>\n`
      : '';

    // Build optional cache lookup (only if explicitly set)
    const cacheLookupXml = cacheLookup
      ? `\t<CacheLookup>${cacheLookup}</CacheLookup>\n`
      : '';

    // Build optional primary index (NOTE: ClusteredIndex is NOT in real D365FO files)
    const primaryIndexXml = primaryIndex
      ? `\t<PrimaryIndex>${primaryIndex}</PrimaryIndex>\n\t<ReplacementKey>${primaryIndex}</ReplacementKey>\n`
      : '';

    // Build <Fields> block from properties.fields array (TableFieldSpec[]).
    // Copilot may pass field definitions via properties.fields or via sourceCode JSON —
    // both paths merge into properties before calling here (see generate()).
    const fieldSpecs: Array<{ name: string; edt?: string; type?: string; mandatory?: boolean; label?: string }> =
      Array.isArray(properties?.fields) ? properties.fields : [];

    let fieldsXml: string;
    if (fieldSpecs.length === 0) {
      fieldsXml = '\t<Fields />\n';
    } else {
      fieldsXml = '\t<Fields>\n';
      for (const f of fieldSpecs) {
        // Determine i:type: use explicit type if provided, otherwise derive from EDT name heuristics.
        // NEVER default to AxTableFieldString blindly when an EDT is present — EDT base type matters!
        const iType = fieldTypeToAxType(f.type || 'String', f.edt);
        fieldsXml += `\t\t<AxTableField xmlns="" i:type="${iType}">\n`;
        fieldsXml += `\t\t\t<Name>${f.name}</Name>\n`;
        if (f.edt)       fieldsXml += `\t\t\t<ExtendedDataType>${f.edt}</ExtendedDataType>\n`;
        if (f.mandatory) fieldsXml += `\t\t\t<Mandatory>Yes</Mandatory>\n`;
        if (f.label)     fieldsXml += `\t\t\t<Label>${f.label}</Label>\n`;
        fieldsXml += `\t\t</AxTableField>\n`;
      }
      fieldsXml += '\t</Fields>\n';
    }

    return `<?xml version="1.0" encoding="utf-8"?>
<AxTable xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
\t<Name>${tableName}</Name>
\t<SourceCode>
\t\t<Declaration><![CDATA[
public class ${tableName} extends common
{
}
]]></Declaration>
\t\t<Methods />
\t</SourceCode>
${configKeyXml}\t<Label>${label}</Label>
\t<TableGroup>${tableGroup}</TableGroup>
\t<TitleField1>${titleField1}</TitleField1>
\t<TitleField2>${titleField2}</TitleField2>
${cacheLookupXml}${primaryIndexXml}\t<DeleteActions />
\t<FieldGroups>
\t\t<AxTableFieldGroup>
\t\t\t<Name>AutoReport</Name>
\t\t\t<Fields />
\t\t</AxTableFieldGroup>
\t\t<AxTableFieldGroup>
\t\t\t<Name>AutoLookup</Name>
\t\t\t<Fields />
\t\t</AxTableFieldGroup>
\t\t<AxTableFieldGroup>
\t\t\t<Name>AutoIdentification</Name>
\t\t\t<AutoPopulate>Yes</AutoPopulate>
\t\t\t<Fields />
\t\t</AxTableFieldGroup>
\t\t<AxTableFieldGroup>
\t\t\t<Name>AutoSummary</Name>
\t\t\t<Fields />
\t\t</AxTableFieldGroup>
\t\t<AxTableFieldGroup>
\t\t\t<Name>AutoBrowse</Name>
\t\t\t<Fields />
\t\t</AxTableFieldGroup>
\t</FieldGroups>
${fieldsXml}\t<Indexes />
\t<Mappings />
\t<Relations />
\t<StateMachines />
</AxTable>
`;
  }

  /**
   * Generate AxEnum XML structure
   */
  static generateAxEnumXml(
    enumName: string,
    properties?: Record<string, any>
  ): string {
    const label = properties?.label || enumName;
    const useEnumValue = properties?.useEnumValue ? 'Yes' : 'No';

    return `<?xml version="1.0" encoding="utf-8"?>
<AxEnum xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
\t<Name>${enumName}</Name>
\t<Label>${label}</Label>
\t<UseEnumValue>${useEnumValue}</UseEnumValue>
\t<EnumValues />
</AxEnum>
`;
  }

  /**
   * Generate AxForm XML structure (based on real D365FO form structure)
   */
  static generateAxFormXml(
    formName: string,
    properties?: Record<string, any>
  ): string {
    const caption = properties?.caption || `@${formName}`;
    const formTemplate = properties?.formTemplate || 'DetailsPage';
    const pattern = properties?.pattern || 'DetailsTransaction';
    const dataSource = properties?.dataSource || '';
    const interactionClass = properties?.interactionClass || '';
    const style = properties?.style || 'DetailsFormTransaction';

    // Build class declaration for SourceCode
    const extendsFrom = properties?.extends || 'FormRun';
    const classDeclaration = properties?.classDeclaration || 
      `[Form]\npublic class ${formName} extends ${extendsFrom}\n{\n}`;

    // Build optional InteractionClass
    const interactionClassXml = interactionClass
      ? `\t<InteractionClass>${interactionClass}</InteractionClass>\n`
      : '';

    // Build DataSource reference for Design
    const dataSourceXml = dataSource
      ? `\t\t<DataSource xmlns="">${dataSource}</DataSource>\n`
      : '';

    return `<?xml version="1.0" encoding="utf-8"?>
<AxForm xmlns:i="http://www.w3.org/2001/XMLSchema-instance" xmlns="Microsoft.Dynamics.AX.Metadata.V6">
\t<Name>${formName}</Name>
\t<SourceCode>
\t\t<Methods xmlns="">
\t\t\t<Method>
\t\t\t\t<Name>classDeclaration</Name>
\t\t\t\t<Source><![CDATA[
${classDeclaration}
]]></Source>
\t\t\t</Method>
\t\t</Methods>
\t</SourceCode>
\t<FormTemplate>${formTemplate}</FormTemplate>
${interactionClassXml}\t<DataSources />
\t<Design>
\t\t<Caption xmlns="">${caption}</Caption>
${dataSourceXml}\t\t<Pattern xmlns="">${pattern}</Pattern>
\t\t<Style xmlns="">${style}</Style>
\t\t<Controls xmlns="" />
\t</Design>
\t<Parts />
</AxForm>
`;
  }

  /**
   * Generate AxQuery XML structure
   */
  static generateAxQueryXml(
    queryName: string,
    properties?: Record<string, any>
  ): string {
    const title = properties?.title || queryName;

    return `<?xml version="1.0" encoding="utf-8"?>
<AxQuery xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
\t<Name>${queryName}</Name>
\t<Title>${title}</Title>
\t<DataSources />
</AxQuery>
`;
  }

  /**
   * Generate AxView XML structure
   */
  static generateAxViewXml(
    viewName: string,
    properties?: Record<string, any>
  ): string {
    const label = properties?.label || viewName;

    return `<?xml version="1.0" encoding="utf-8"?>
<AxView xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
\t<Name>${viewName}</Name>
\t<Label>${label}</Label>
\t<Fields />
\t<Mappings />
\t<Metadata />
\t<ViewMetadata />
</AxView>
`;
  }

  /**
   * Generate AxDataEntityView XML structure
   */
  static generateAxDataEntityXml(
    entityName: string,
    properties?: Record<string, any>
  ): string {
    const label = properties?.label || entityName;
    const publicEntityName = properties?.publicEntityName || entityName;
    const publicCollectionName =
      properties?.publicCollectionName || `${entityName}Collection`;

    return `<?xml version="1.0" encoding="utf-8"?>
<AxDataEntityView xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
\t<Name>${entityName}</Name>
\t<Label>${label}</Label>
\t<DataManagementEnabled>Yes</DataManagementEnabled>
\t<DataManagementStagingTable>${entityName}Staging</DataManagementStagingTable>
\t<EntityCategory>Transaction</EntityCategory>
\t<IsPublic>Yes</IsPublic>
\t<PublicCollectionName>${publicCollectionName}</PublicCollectionName>
\t<PublicEntityName>${publicEntityName}</PublicEntityName>
\t<Fields />
\t<Keys />
\t<Mappings />
\t<Ranges />
\t<Relations />
\t<ViewMetadata />
</AxDataEntityView>
`;
  }

  /**
   * Generate AxReport XML skeleton.
   *
   * properties:
   *   dpClassName   - Data Provider class name          (default: <ReportName>DP)
   *   tmpTableName  - TempDB table name                 (default: <ReportName>Tmp)
   *   datasetName   - AxReportDataSet name              (default: tmpTableName)
   *   designName    - AxReportDesign name               (default: 'Report')
   *   caption       - Design caption label ref           (e.g. '@MyModel:MyLabel')
   *   style         - Design style template             (e.g. 'TableStyleTemplate')
   *   aotQuery      - AOT query name for DynamicParameter (e.g. 'SalesTable')
   *   fields        - Array of { name, alias?, dataType?, caption?, disableAutoCreate? } → AxReportDataSetField
   *   datasets      - Array of { name, dpClassName, tmpTableName, fields?, aotQuery? } for multi-dataset reports
   *   rdlContent    - Full RDL XML string to embed (auto-generated from fields when omitted)
   *
   * AOT structure generated (mirrors real D365FO reports like AslReports_CashOrder_CZ):
   *   <AxReport xmlns="Microsoft.Dynamics.AX.Metadata.V2">
   *     <DataMethods />
   *     <DataSets>
   *       <AxReportDataSet xmlns="">           ← one per dataset
   *         <Fields>…</Fields>
   *         <Parameters>   ← 6 AX system params + {DPCLASS}_DynamicParameter
   *       </AxReportDataSet>
   *     </DataSets>
   *     <DefaultParameterGroup>               ← 6 AX params + DynamicParameter (with AOTQuery+DataType)
   *     <Designs>
   *       <AxReportDesign xmlns="" i:type="AxReportPrecisionDesign">
   *         <Text><![CDATA[…RDL…]]></Text>   ← 2016 schema with DataSources/DataSets/ReportParameters
   *         <DisableIndividualTransformation><Name>…</Name></DisableIndividualTransformation>
   *     </Designs>
   *   </AxReport>
   */
  static generateAxReportXml(
    reportName: string,
    properties?: Record<string, any>
  ): string {
    // ── Type helpers ─────────────────────────────────────────────────────────
    type FieldDef = {
      name: string; alias?: string; dataType?: string;
      caption?: string; disableAutoCreate?: boolean;
    };
    type DatasetDef = {
      name: string; dpClassName: string; tmpTableName: string;
      fields?: FieldDef[]; aotQuery?: string;
    };

    // ── Resolve datasets (multi-dataset array OR single-dataset shorthand) ──
    let datasets: DatasetDef[];
    if (properties?.datasets && Array.isArray(properties.datasets)) {
      datasets = properties.datasets as DatasetDef[];
    } else {
      const tmpTableName = properties?.tmpTableName || `${reportName}Tmp`;
      const dpClassName  = properties?.dpClassName  || `${reportName}DP`;
      const datasetName  = properties?.datasetName  || tmpTableName;
      datasets = [{
        name:         datasetName,
        dpClassName,
        tmpTableName,
        fields:       properties?.fields    as FieldDef[] | undefined,
        aotQuery:     properties?.aotQuery  as string     | undefined,
      }];
    }
    const designName = properties?.designName || 'Report';

    // ── RDL .NET type mapping ──
    const rdlType = (dt?: string): string => {
      switch (dt) {
        case 'System.Double':   return 'System.Double';
        case 'System.Int32':    return 'System.Int32';
        case 'System.Int64':    return 'System.Int64';
        case 'System.DateTime': return 'System.DateTime';
        case 'System.Byte[]':   return 'System.Byte[]';
        default:                return 'System.String';
      }
    };

    // ── UUID helper ──
    const uuid = (): string =>
      'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = Math.random() * 16 | 0;
        return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
      });

    // ── Build one AxReportDataSet XML entry ──
    const buildDatasetXml = (ds: DatasetDef): string => {
      const dpParamName = `${ds.dpClassName.toUpperCase()}_DynamicParameter`;
      let fieldsXml: string;
      if (ds.fields && ds.fields.length > 0) {
        const entries = ds.fields.map(f => {
          const alias      = f.alias    || `${ds.tmpTableName}.1.${f.name}`;
          const capLine    = f.caption          ? `\n\t\t\t\t<Caption>${f.caption}</Caption>`                                 : '';
          const dtLine     = f.dataType         ? `\n\t\t\t\t<DataType>${f.dataType}</DataType>`                              : '';
          const disableLine = f.disableAutoCreate ? `\n\t\t\t\t<DisableAutoCreateInDataRegion>true</DisableAutoCreateInDataRegion>` : '';
          return [
            `\t\t\t<AxReportDataSetField>`,
            `\t\t\t\t<Name>${f.name}</Name>`,
            `\t\t\t\t<Alias>${alias}</Alias>${capLine}${dtLine}${disableLine}`,
            `\t\t\t\t<DisplayWidth>Auto</DisplayWidth>`,
            `\t\t\t\t<UserDefined>false</UserDefined>`,
            `\t\t\t</AxReportDataSetField>`,
          ].join('\n');
        });
        fieldsXml = `\t\t\t<Fields>\n${entries.join('\n')}\n\t\t\t</Fields>`;
      } else {
        fieldsXml = `\t\t\t<Fields />`;
      }
      return `\t\t<AxReportDataSet xmlns="">
\t\t\t<Name>${ds.name}</Name>
\t\t\t<DataSourceType>ReportDataProvider</DataSourceType>
\t\t\t<Query>SELECT * FROM ${ds.dpClassName}.${ds.tmpTableName}</Query>
\t\t\t<FieldGroups />
${fieldsXml}
\t\t\t<Parameters>
\t\t\t\t<AxReportDataSetParameter>
\t\t\t\t\t<Name>AX_PartitionKey</Name>
\t\t\t\t\t<Alias>AX_PartitionKey</Alias>
\t\t\t\t\t<DataType>System.String</DataType>
\t\t\t\t\t<Parameter>AX_PartitionKey</Parameter>
\t\t\t\t</AxReportDataSetParameter>
\t\t\t\t<AxReportDataSetParameter>
\t\t\t\t\t<Name>AX_CompanyName</Name>
\t\t\t\t\t<Alias>AX_CompanyName</Alias>
\t\t\t\t\t<DataType>System.String</DataType>
\t\t\t\t\t<Parameter>AX_CompanyName</Parameter>
\t\t\t\t</AxReportDataSetParameter>
\t\t\t\t<AxReportDataSetParameter>
\t\t\t\t\t<Name>AX_UserContext</Name>
\t\t\t\t\t<Alias>AX_UserContext</Alias>
\t\t\t\t\t<DataType>System.String</DataType>
\t\t\t\t\t<Parameter>AX_UserContext</Parameter>
\t\t\t\t</AxReportDataSetParameter>
\t\t\t\t<AxReportDataSetParameter>
\t\t\t\t\t<Name>AX_RenderingCulture</Name>
\t\t\t\t\t<Alias>AX_RenderingCulture</Alias>
\t\t\t\t\t<DataType>System.String</DataType>
\t\t\t\t\t<Parameter>AX_RenderingCulture</Parameter>
\t\t\t\t</AxReportDataSetParameter>
\t\t\t\t<AxReportDataSetParameter>
\t\t\t\t\t<Name>AX_ReportContext</Name>
\t\t\t\t\t<Alias>AX_ReportContext</Alias>
\t\t\t\t\t<DataType>System.String</DataType>
\t\t\t\t\t<Parameter>AX_ReportContext</Parameter>
\t\t\t\t</AxReportDataSetParameter>
\t\t\t\t<AxReportDataSetParameter>
\t\t\t\t\t<Name>AX_RdpPreProcessedId</Name>
\t\t\t\t\t<Alias>AX_RdpPreProcessedId</Alias>
\t\t\t\t\t<DataType>System.String</DataType>
\t\t\t\t\t<Parameter>AX_RdpPreProcessedId</Parameter>
\t\t\t\t</AxReportDataSetParameter>
\t\t\t\t<AxReportDataSetParameter>
\t\t\t\t\t<Name>${dpParamName}</Name>
\t\t\t\t\t<Alias>${dpParamName}</Alias>
\t\t\t\t\t<DataType>Microsoft.Dynamics.AX.Framework.Services.Client.QueryMetadata</DataType>
\t\t\t\t\t<Parameter>${dpParamName}</Parameter>
\t\t\t\t</AxReportDataSetParameter>
\t\t\t</Parameters>
\t\t</AxReportDataSet>`;
    };

    const datasetsXml = datasets.map(buildDatasetXml).join('\n');

    // ── DefaultParameterGroup (uses first dataset's DP for DynamicParameter) ──
    const firstDs      = datasets[0];
    const dpParamName  = `${firstDs.dpClassName.toUpperCase()}_DynamicParameter`;
    const aotQueryLine = firstDs.aotQuery ? `\n\t\t\t\t<AOTQuery>${firstDs.aotQuery}</AOTQuery>` : '';

    const defaultParamGroupXml = `\t<DefaultParameterGroup>
\t\t<Name xmlns="">Parameters</Name>
\t\t<ReportParameterBases xmlns="">
\t\t\t<AxReportParameterBase xmlns=""
\t\t\t\t\ti:type="AxReportParameter">
\t\t\t\t<Name>AX_PartitionKey</Name>
\t\t\t\t<AllowBlank>true</AllowBlank>
\t\t\t\t<Nullable>true</Nullable>
\t\t\t\t<UserVisibility>Hidden</UserVisibility>
\t\t\t\t<DefaultValue />
\t\t\t\t<Values />
\t\t\t</AxReportParameterBase>
\t\t\t<AxReportParameterBase xmlns=""
\t\t\t\t\ti:type="AxReportParameter">
\t\t\t\t<Name>AX_CompanyName</Name>
\t\t\t\t<UserVisibility>Hidden</UserVisibility>
\t\t\t\t<DefaultValue />
\t\t\t\t<Values />
\t\t\t</AxReportParameterBase>
\t\t\t<AxReportParameterBase xmlns=""
\t\t\t\t\ti:type="AxReportParameter">
\t\t\t\t<Name>AX_UserContext</Name>
\t\t\t\t<AllowBlank>true</AllowBlank>
\t\t\t\t<Nullable>true</Nullable>
\t\t\t\t<UserVisibility>Hidden</UserVisibility>
\t\t\t\t<DefaultValue />
\t\t\t\t<Values />
\t\t\t</AxReportParameterBase>
\t\t\t<AxReportParameterBase xmlns=""
\t\t\t\t\ti:type="AxReportParameter">
\t\t\t\t<Name>AX_RenderingCulture</Name>
\t\t\t\t<AllowBlank>true</AllowBlank>
\t\t\t\t<Nullable>true</Nullable>
\t\t\t\t<UserVisibility>Hidden</UserVisibility>
\t\t\t\t<DefaultValue />
\t\t\t\t<Values />
\t\t\t</AxReportParameterBase>
\t\t\t<AxReportParameterBase xmlns=""
\t\t\t\t\ti:type="AxReportParameter">
\t\t\t\t<Name>AX_ReportContext</Name>
\t\t\t\t<AllowBlank>true</AllowBlank>
\t\t\t\t<Nullable>true</Nullable>
\t\t\t\t<UserVisibility>Hidden</UserVisibility>
\t\t\t\t<DefaultValue />
\t\t\t\t<Values />
\t\t\t</AxReportParameterBase>
\t\t\t<AxReportParameterBase xmlns=""
\t\t\t\t\ti:type="AxReportParameter">
\t\t\t\t<Name>AX_RdpPreProcessedId</Name>
\t\t\t\t<AllowBlank>true</AllowBlank>
\t\t\t\t<Nullable>true</Nullable>
\t\t\t\t<UserVisibility>Hidden</UserVisibility>
\t\t\t\t<DefaultValue />
\t\t\t\t<Values />
\t\t\t</AxReportParameterBase>
\t\t\t<AxReportParameterBase xmlns=""
\t\t\t\t\ti:type="AxReportParameter">
\t\t\t\t<Name>${dpParamName}</Name>${aotQueryLine}
\t\t\t\t<AllowBlank>true</AllowBlank>
\t\t\t\t<DataType>Microsoft.Dynamics.AX.Framework.Services.Client.QueryMetadata</DataType>
\t\t\t\t<Nullable>true</Nullable>
\t\t\t\t<UserVisibility>Hidden</UserVisibility>
\t\t\t\t<DefaultValue />
\t\t\t\t<Values />
\t\t\t</AxReportParameterBase>
\t\t</ReportParameterBases>
\t</DefaultParameterGroup>`;

    // ── Auto-generate RDL skeleton (2016 namespace, mirrors real D365FO reports) ──
    const buildRdlSkeleton = (): string => {
      const ns2016 = 'http://schemas.microsoft.com/sqlserver/reporting/2016/01/reportdefinition';
      const nsRd   = 'http://schemas.microsoft.com/SQLServer/reporting/reportdesigner';

      // DataSources block — single shared AX data source
      const rdlDataSourcesXml =
`  <DataSources>
    <DataSource Name="AutoGen__ReportDataProvider">
      <Transaction>true</Transaction>
      <ConnectionProperties>
        <DataProvider>AXREPORTDATAPROVIDER</DataProvider>
        <ConnectString />
        <IntegratedSecurity>true</IntegratedSecurity>
      </ConnectionProperties>
      <rd:DataSourceID>${uuid()}</rd:DataSourceID>
    </DataSource>
  </DataSources>`;

      // Build one RDL DataSet per AxReportDataSet
      const buildRdlDataset = (ds: DatasetDef): string => {
        const dsDpParam   = `${ds.dpClassName.toUpperCase()}_DynamicParameter`;
        const paramNames  = [
          'AX_PartitionKey', 'AX_CompanyName', 'AX_UserContext',
          'AX_RenderingCulture', 'AX_ReportContext', 'AX_RdpPreProcessedId',
          dsDpParam,
        ];
        const queryParams = paramNames
          .map(p =>
            `          <QueryParameter Name="${p}">\n            <Value>=Parameters!${p}.Value</Value>\n          </QueryParameter>`)
          .join('\n');

        let rdlFields = '';
        if (ds.fields && ds.fields.length > 0) {
          const flines = ds.fields.map(f => {
            const alias = f.alias || `${ds.tmpTableName}.1.${f.name}`;
            return `        <Field Name="${f.name}">\n          <DataField>${alias}</DataField>\n          <rd:TypeName>${rdlType(f.dataType)}</rd:TypeName>\n        </Field>`;
          });
          rdlFields = `      <Fields>\n${flines.join('\n')}\n      </Fields>\n`;
        }
        return `    <DataSet Name="${ds.name}">
      <Query>
        <DataSourceName>AutoGen__ReportDataProvider</DataSourceName>
        <QueryParameters>
${queryParams}
        </QueryParameters>
        <CommandText>SELECT * FROM ${ds.dpClassName}.${ds.tmpTableName}</CommandText>
        <rd:UseGenericDesigner>true</rd:UseGenericDesigner>
      </Query>
${rdlFields}      <rd:DataSetInfo>
        <rd:DataSetName>${ds.name}</rd:DataSetName>
        <rd:TableName>Fields</rd:TableName>
        <rd:TableAdapterFillMethod>Fill</rd:TableAdapterFillMethod>
        <rd:TableAdapterGetDataMethod>GetData</rd:TableAdapterGetDataMethod>
        <rd:TableAdapterName>FieldsTableAdapter</rd:TableAdapterName>
      </rd:DataSetInfo>
    </DataSet>`;
      };

      const rdlDatasetsXml = `  <DataSets>\n${datasets.map(buildRdlDataset).join('\n')}\n  </DataSets>`;

      // ReportParameters — 6 AX system params + DynamicParameter (all hidden)
      const rdlParamDefs = [
        { name: 'AX_PartitionKey',      nullable: true,  blank: true,  usedInQuery: false },
        { name: 'AX_CompanyName',        nullable: false, blank: false, usedInQuery: false },
        { name: 'AX_UserContext',        nullable: true,  blank: true,  usedInQuery: false },
        { name: 'AX_RenderingCulture',   nullable: true,  blank: true,  usedInQuery: false },
        { name: 'AX_ReportContext',       nullable: true,  blank: true,  usedInQuery: true  },
        { name: 'AX_RdpPreProcessedId',  nullable: true,  blank: true,  usedInQuery: false },
        { name: dpParamName,             nullable: true,  blank: true,  usedInQuery: false },
      ];
      const rdlParamsXml = `  <ReportParameters>\n` +
        rdlParamDefs.map(p => {
          const nullLine  = p.nullable     ? `\n      <Nullable>true</Nullable>`        : '';
          const blankLine = p.blank        ? `\n      <AllowBlank>true</AllowBlank>`    : '';
          const usedLine  = p.usedInQuery  ? `\n      <UsedInQuery>True</UsedInQuery>` : '';
          return `    <ReportParameter Name="${p.name}">\n      <DataType>String</DataType>${nullLine}${blankLine}\n      <Prompt>${p.name}</Prompt>\n      <Hidden>true</Hidden>${usedLine}\n    </ReportParameter>`;
        }).join('\n') + `\n  </ReportParameters>`;

      // ReportParametersLayout
      const cellDefs = rdlParamDefs
        .map((p, i) =>
          `        <CellDefinition>\n          <ColumnIndex>${i}</ColumnIndex>\n          <RowIndex>0</RowIndex>\n          <ParameterName>${p.name}</ParameterName>\n        </CellDefinition>`)
        .join('\n');
      const rdlParamLayoutXml =
`  <ReportParametersLayout>
    <GridLayoutDefinition>
      <NumberOfColumns>${rdlParamDefs.length}</NumberOfColumns>
      <NumberOfRows>1</NumberOfRows>
      <CellDefinitions>
${cellDefs}
      </CellDefinitions>
    </GridLayoutDefinition>
  </ReportParametersLayout>`;

      return `<?xml version="1.0" encoding="utf-8"?>
<Report xmlns="${ns2016}" xmlns:rd="${nsRd}">
  <AutoRefresh>0</AutoRefresh>
${rdlDataSourcesXml}
${rdlDatasetsXml}
  <ReportSections>
    <ReportSection>
      <Body>
        <ReportItems />
        <Height>1in</Height>
        <Style>
          <Border>
            <Style>None</Style>
          </Border>
        </Style>
      </Body>
      <Width>7.5in</Width>
      <Page>
        <PageHeight>11.69in</PageHeight>
        <PageWidth>8.27in</PageWidth>
        <InteractiveHeight>11in</InteractiveHeight>
        <InteractiveWidth>8.5in</InteractiveWidth>
        <LeftMargin>0.2in</LeftMargin>
        <TopMargin>0.2in</TopMargin>
        <Style />
      </Page>
    </ReportSection>
  </ReportSections>
${rdlParamsXml}
${rdlParamLayoutXml}
  <Language>en-US</Language>
  <rd:ReportUnitType>Inch</rd:ReportUnitType>
  <rd:ReportID>${uuid()}</rd:ReportID>
</Report>`;
    };

    // ── Design block ──
    const captionLine = properties?.caption ? `\n\t\t\t<Caption>${properties.caption}</Caption>` : '';
    const styleLine   = properties?.style   ? `\n\t\t\t<Style>${properties.style}</Style>`       : '';
    const rdlContent  = properties?.rdlContent as string | undefined;
    const rdl         = rdlContent || buildRdlSkeleton();
    const textElement = `\n\t\t\t<Text><![CDATA[${rdl}]]></Text>`;

    return `<?xml version="1.0" encoding="utf-8"?>
<AxReport xmlns:i="http://www.w3.org/2001/XMLSchema-instance" xmlns="Microsoft.Dynamics.AX.Metadata.V2">
\t<Name>${reportName}</Name>
\t<DataMethods />
\t<DataSets>
${datasetsXml}
\t</DataSets>
${defaultParamGroupXml}
\t<Designs>
\t\t<AxReportDesign xmlns=""
\t\t\t\ti:type="AxReportPrecisionDesign">
\t\t\t<Name>${designName}</Name>${captionLine}${styleLine}${textElement}
\t\t\t<DisableIndividualTransformation>
\t\t\t\t<Name>DisableIndividualTransformation</Name>
\t\t\t</DisableIndividualTransformation>
\t\t</AxReportDesign>
\t</Designs>
\t<EmbeddedImages />
</AxReport>`;
  }

  /**
   * Generate XML based on object type
   */
  static generate(
    objectType: string,
    objectName: string,
    sourceCode?: string,
    properties?: Record<string, any>
  ): string {
    switch (objectType) {
      case 'class':
        return this.generateAxClassXml(objectName, sourceCode, properties);
      case 'table': {
        // sourceCode is not used for tables directly, but Copilot may pass field
        // definitions as a JSON string in sourceCode. Try to parse and merge into properties.
        let mergedProperties = properties;
        if (sourceCode && sourceCode.trim().startsWith('{')) {
          try {
            const parsed = JSON.parse(sourceCode);
            if (parsed && (Array.isArray(parsed.fields) || parsed.label || parsed.tableGroup)) {
              mergedProperties = { ...parsed, ...properties }; // explicit properties win
              console.error('[create_d365fo_file] Parsed table field definitions from sourceCode JSON');
            }
          } catch {
            // Not valid JSON — ignore
          }
        }
        return this.generateAxTableXml(objectName, mergedProperties);
      }
      case 'enum':
        return this.generateAxEnumXml(objectName, properties);
      case 'form':
        return this.generateAxFormXml(objectName, properties);
      case 'query':
        return this.generateAxQueryXml(objectName, properties);
      case 'view':
        return this.generateAxViewXml(objectName, properties);
      case 'data-entity':
        return this.generateAxDataEntityXml(objectName, properties);
      case 'report':
        return this.generateAxReportXml(objectName, properties);
      case 'edt':
        return this.generateAxEdtXml(objectName, properties);
      case 'table-extension':
        return this.generateAxTableExtensionXml(objectName);
      case 'form-extension':
        return this.generateAxFormExtensionXml(objectName);
      case 'edt-extension':
        return this.generateAxSimpleExtensionXml('AxEdtExtension', objectName);
      case 'enum-extension':
        return this.generateAxSimpleExtensionXml('AxEnumExtension', objectName);
      case 'data-entity-extension':
        return this.generateAxSimpleExtensionXml('AxDataEntityViewExtension', objectName);
      case 'menu-item-display':
      case 'menu-item-action':
      case 'menu-item-output':
        return this.generateAxMenuItemXml(objectType, objectName, properties);
      case 'menu-item-display-extension':
        return this.generateAxSimpleExtensionXml('AxMenuItemDisplayExtension', objectName);
      case 'menu-item-action-extension':
        return this.generateAxSimpleExtensionXml('AxMenuItemActionExtension', objectName);
      case 'menu-item-output-extension':
        return this.generateAxSimpleExtensionXml('AxMenuItemOutputExtension', objectName);
      case 'menu':
        return this.generateAxMenuXml(objectName, properties);
      case 'menu-extension':
        return this.generateAxMenuExtensionXml(objectName);
      case 'security-privilege':
        return this.generateAxSecurityPrivilegeXml(objectName, properties);
      case 'security-duty':
        return this.generateAxSecurityDutyXml(objectName, properties);
      case 'security-role':
        return this.generateAxSecurityRoleXml(objectName, properties);
      default:
        throw new Error(`Unsupported object type: ${objectType}`);
    }
  }

  /**
   * Sanitize AxReport XML to guarantee the structural elements required by the D365FO
   * Visual Studio Designer metadata loader, regardless of whether the XML was generated
   * by the template or supplied verbatim by a caller via the xmlContent parameter.
   *
   * Required invariants:
   *  1. xmlns="Microsoft.Dynamics.AX.Metadata.V2" on <AxReport> root
   *  2. <DataMethods /> directly after <Name>…</Name>
   *  3. xmlns="" on every <AxReportDataSet> child element (namespace reset)
   *  4. </AxReport> closing tag present (guard against truncated XML)
   *  5. <AxReportDesign> has xmlns="" and i:type="AxReportPrecisionDesign" attributes
   *     (VS Designer won't show Designs sub-nodes without these)
   */
  static sanitizeReportXml(xml: string): string {
    // 1. Ensure xmlns="Microsoft.Dynamics.AX.Metadata.V2" on <AxReport> opening tag
    if (!xml.includes('xmlns="Microsoft.Dynamics.AX.Metadata.V2"')) {
      xml = xml.replace(/<AxReport(\s[^>]*)?>/, (match) => {
        // Insert the namespace attribute before the closing > of the tag
        return match.slice(0, -1) + ' xmlns="Microsoft.Dynamics.AX.Metadata.V2">';
      });
      console.error('[sanitizeReportXml] Added xmlns="Microsoft.Dynamics.AX.Metadata.V2" to <AxReport>');
    }

    // 2. Ensure <DataMethods /> exists directly after the top-level <Name>
    if (!xml.includes('<DataMethods')) {
      // Match only the first <Name>…</Name> (the report's own name, not nested ones)
      xml = xml.replace(/(<Name>[^<]*<\/Name>)/, '$1\n\t<DataMethods />');
      console.error('[sanitizeReportXml] Inserted missing <DataMethods />');
    }

    // 3. Ensure xmlns="" on each <AxReportDataSet> (bare tag without the attribute)
    if (xml.includes('<AxReportDataSet>')) {
      xml = xml.replace(/<AxReportDataSet>/g, '<AxReportDataSet xmlns="">');
      console.error('[sanitizeReportXml] Added xmlns="" to <AxReportDataSet> elements');
    }

    // 4. Ensure </AxReport> closing tag is present (guard against truncated XML)
    const trimmed = xml.trimEnd();
    if (!trimmed.endsWith('</AxReport>')) {
      xml = trimmed + '\n</AxReport>';
      console.error('[sanitizeReportXml] Appended missing </AxReport> closing tag');
    }

    // 5. Ensure <AxReportDesign> has xmlns="" and i:type="AxReportPrecisionDesign"
    //    VS Designer requires both attributes to render the Designs sub-tree correctly.
    //    Match bare <AxReportDesign> or one that is already partially attributed.
    xml = xml.replace(/<AxReportDesign(\s[^>]*)?>/, (match, attrs: string | undefined) => {
      const current = attrs || '';
      let updated = current;
      if (!updated.includes('xmlns=""')) {
        updated = ` xmlns=""${updated}`;
      }
      if (!updated.includes('i:type=')) {
        updated += `\n\t\t\t\ti:type="AxReportPrecisionDesign"`;
      }
      if (updated === current) return match; // nothing changed — idempotent
      console.error('[sanitizeReportXml] Fixed <AxReportDesign> attributes (xmlns="" + i:type)');
      return `<AxReportDesign${updated}>`;
    });


    // 6. Ensure <Parameters> block inside <AxReportDataSet> for real RDP datasets.
    //    Skipped for stub/minimal datasets that have no <DataSourceType>.
    if (xml.includes('<DataSourceType>') && !xml.includes('<Parameters>')) {
      const axDatasetParams =
        '\t\t\t<Parameters>\n' +
        '\t\t\t\t<AxReportDataSetParameter>\n' +
        '\t\t\t\t\t<Name>AX_PartitionKey</Name>\n' +
        '\t\t\t\t\t<Alias>AX_PartitionKey</Alias>\n' +
        '\t\t\t\t\t<DataType>System.String</DataType>\n' +
        '\t\t\t\t\t<Parameter>AX_PartitionKey</Parameter>\n' +
        '\t\t\t\t</AxReportDataSetParameter>\n' +
        '\t\t\t\t<AxReportDataSetParameter>\n' +
        '\t\t\t\t\t<Name>AX_CompanyName</Name>\n' +
        '\t\t\t\t\t<Alias>AX_CompanyName</Alias>\n' +
        '\t\t\t\t\t<DataType>System.String</DataType>\n' +
        '\t\t\t\t\t<Parameter>AX_CompanyName</Parameter>\n' +
        '\t\t\t\t</AxReportDataSetParameter>\n' +
        '\t\t\t\t<AxReportDataSetParameter>\n' +
        '\t\t\t\t\t<Name>AX_UserContext</Name>\n' +
        '\t\t\t\t\t<Alias>AX_UserContext</Alias>\n' +
        '\t\t\t\t\t<DataType>System.String</DataType>\n' +
        '\t\t\t\t\t<Parameter>AX_UserContext</Parameter>\n' +
        '\t\t\t\t</AxReportDataSetParameter>\n' +
        '\t\t\t\t<AxReportDataSetParameter>\n' +
        '\t\t\t\t\t<Name>AX_RenderingCulture</Name>\n' +
        '\t\t\t\t\t<Alias>AX_RenderingCulture</Alias>\n' +
        '\t\t\t\t\t<DataType>System.String</DataType>\n' +
        '\t\t\t\t\t<Parameter>AX_RenderingCulture</Parameter>\n' +
        '\t\t\t\t</AxReportDataSetParameter>\n' +
        '\t\t\t\t<AxReportDataSetParameter>\n' +
        '\t\t\t\t\t<Name>AX_ReportContext</Name>\n' +
        '\t\t\t\t\t<Alias>AX_ReportContext</Alias>\n' +
        '\t\t\t\t\t<DataType>System.String</DataType>\n' +
        '\t\t\t\t\t<Parameter>AX_ReportContext</Parameter>\n' +
        '\t\t\t\t</AxReportDataSetParameter>\n' +
        '\t\t\t\t<AxReportDataSetParameter>\n' +
        '\t\t\t\t\t<Name>AX_RdpPreProcessedId</Name>\n' +
        '\t\t\t\t\t<Alias>AX_RdpPreProcessedId</Alias>\n' +
        '\t\t\t\t\t<DataType>System.String</DataType>\n' +
        '\t\t\t\t\t<Parameter>AX_RdpPreProcessedId</Parameter>\n' +
        '\t\t\t\t</AxReportDataSetParameter>\n' +
        '\t\t\t</Parameters>';
      if (xml.includes('</Fields>')) {
        xml = xml.replace('</Fields>', `</Fields>\n${axDatasetParams}`);
      } else if (xml.includes('<Fields />')) {
        xml = xml.replace('<Fields />', `<Fields />\n${axDatasetParams}`);
      } else {
        xml = xml.replace('</AxReportDataSet>', `${axDatasetParams}\n\t\t</AxReportDataSet>`);
      }
      console.error('[sanitizeReportXml] Added missing <Parameters> to <AxReportDataSet>');
    }

    // 7. Ensure <DefaultParameterGroup> before <Designs> for real RDP datasets.
    if (xml.includes('<DataSourceType>') && !xml.includes('<DefaultParameterGroup>') && xml.includes('<Designs>')) {
      const defaultParamGroup =
        '\t<DefaultParameterGroup>\n' +
        '\t\t<Name xmlns="">Parameters</Name>\n' +
        '\t\t<ReportParameterBases xmlns="">\n' +
        '\t\t\t<AxReportParameterBase xmlns=""\n' +
        '\t\t\t\t\ti:type="AxReportParameter">\n' +
        '\t\t\t\t<Name>AX_PartitionKey</Name>\n' +
        '\t\t\t\t<AllowBlank>true</AllowBlank>\n' +
        '\t\t\t\t<Nullable>true</Nullable>\n' +
        '\t\t\t\t<UserVisibility>Hidden</UserVisibility>\n' +
        '\t\t\t\t<DefaultValue />\n' +
        '\t\t\t\t<Values />\n' +
        '\t\t\t</AxReportParameterBase>\n' +
        '\t\t\t<AxReportParameterBase xmlns=""\n' +
        '\t\t\t\t\ti:type="AxReportParameter">\n' +
        '\t\t\t\t<Name>AX_CompanyName</Name>\n' +
        '\t\t\t\t<UserVisibility>Hidden</UserVisibility>\n' +
        '\t\t\t\t<DefaultValue />\n' +
        '\t\t\t\t<Values />\n' +
        '\t\t\t</AxReportParameterBase>\n' +
        '\t\t\t<AxReportParameterBase xmlns=""\n' +
        '\t\t\t\t\ti:type="AxReportParameter">\n' +
        '\t\t\t\t<Name>AX_UserContext</Name>\n' +
        '\t\t\t\t<AllowBlank>true</AllowBlank>\n' +
        '\t\t\t\t<Nullable>true</Nullable>\n' +
        '\t\t\t\t<UserVisibility>Hidden</UserVisibility>\n' +
        '\t\t\t\t<DefaultValue />\n' +
        '\t\t\t\t<Values />\n' +
        '\t\t\t</AxReportParameterBase>\n' +
        '\t\t\t<AxReportParameterBase xmlns=""\n' +
        '\t\t\t\t\ti:type="AxReportParameter">\n' +
        '\t\t\t\t<Name>AX_RenderingCulture</Name>\n' +
        '\t\t\t\t<AllowBlank>true</AllowBlank>\n' +
        '\t\t\t\t<Nullable>true</Nullable>\n' +
        '\t\t\t\t<UserVisibility>Hidden</UserVisibility>\n' +
        '\t\t\t\t<DefaultValue />\n' +
        '\t\t\t\t<Values />\n' +
        '\t\t\t</AxReportParameterBase>\n' +
        '\t\t\t<AxReportParameterBase xmlns=""\n' +
        '\t\t\t\t\ti:type="AxReportParameter">\n' +
        '\t\t\t\t<Name>AX_ReportContext</Name>\n' +
        '\t\t\t\t<AllowBlank>true</AllowBlank>\n' +
        '\t\t\t\t<Nullable>true</Nullable>\n' +
        '\t\t\t\t<UserVisibility>Hidden</UserVisibility>\n' +
        '\t\t\t\t<DefaultValue />\n' +
        '\t\t\t\t<Values />\n' +
        '\t\t\t</AxReportParameterBase>\n' +
        '\t\t\t<AxReportParameterBase xmlns=""\n' +
        '\t\t\t\t\ti:type="AxReportParameter">\n' +
        '\t\t\t\t<Name>AX_RdpPreProcessedId</Name>\n' +
        '\t\t\t\t<AllowBlank>true</AllowBlank>\n' +
        '\t\t\t\t<Nullable>true</Nullable>\n' +
        '\t\t\t\t<UserVisibility>Hidden</UserVisibility>\n' +
        '\t\t\t\t<DefaultValue />\n' +
        '\t\t\t\t<Values />\n' +
        '\t\t\t</AxReportParameterBase>\n' +
        '\t\t</ReportParameterBases>\n' +
        '\t</DefaultParameterGroup>';
      xml = xml.replace('<Designs>', `${defaultParamGroup}\n\t<Designs>`);
      console.error('[sanitizeReportXml] Added missing <DefaultParameterGroup>');
    }

    // 8. Fix embedded RDL structural issues based on the SSRS namespace version:
    //    2008/01 — <PageHeader>/<PageFooter> must be inside <Page> (direct child of <Report>).
    //    2010/01+ (2010, 2016, future) — <Body> and <Page> must NOT be direct children of
    //              <Report>; they must be wrapped in:
    //              <ReportSections><ReportSection>...</ReportSection></ReportSections>
    //              Placing <Page> directly under <Report> causes:
    //              "Deserialization failed: invalid child element 'Page'" in VS Designer.
    xml = xml.replace(/(<Text><!\[CDATA\[)([\s\S]*?)(\]\]><\/Text>)/, (_whole, open, rdl, close) => {
      const is2008 = rdl.includes('reporting/2008/01/reportdefinition');
      // Any SSRS namespace newer than 2008 requires ReportSections wrapping
      const isModernRdl = !is2008 && /reporting\/20\d\d\/\d\d\/reportdefinition/.test(rdl);
      const is2010 = isModernRdl; // kept for branch clarity below
      let fixedRdl = rdl;
      let changed = false;

      if (is2010 && !rdl.includes('<ReportSections>')) {
        // 2010 schema: collect any stray Body/Page/PageHeader/PageFooter that are direct
        // children of <Report>, then wrap them in ReportSections/ReportSection.
        let pageEl = '';
        const existingPageMatch = fixedRdl.match(/<Page(?:\s[^>]*)?>([\s\S]*?)<\/Page>/);
        if (existingPageMatch) {
          pageEl = existingPageMatch[0];
          fixedRdl = fixedRdl.replace(existingPageMatch[0], '');
        } else {
          let pageInner = '';
          const phMatch = fixedRdl.match(/<PageHeader[\s\S]*?<\/PageHeader>/);
          if (phMatch) { pageInner += phMatch[0]; fixedRdl = fixedRdl.replace(phMatch[0], ''); }
          const pfMatch = fixedRdl.match(/<PageFooter[\s\S]*?<\/PageFooter>/);
          if (pfMatch) { pageInner += (pageInner ? '\n' : '') + pfMatch[0]; fixedRdl = fixedRdl.replace(pfMatch[0], ''); }
          if (pageInner) pageEl = '<Page>\n' + pageInner.trim() + '\n</Page>';
        }
        const bodyMatch = fixedRdl.match(/<Body[\s\S]*?<\/Body>/);
        let sectionContent = '';
        if (bodyMatch) { sectionContent += bodyMatch[0]; fixedRdl = fixedRdl.replace(bodyMatch[0], ''); }
        if (pageEl) sectionContent += (sectionContent ? '\n' : '') + pageEl;
        if (sectionContent) {
          const reportSections =
            '<ReportSections>\n<ReportSection>\n' + sectionContent.trim() + '\n</ReportSection>\n</ReportSections>';
          fixedRdl = fixedRdl.includes('</Report>')
            ? fixedRdl.replace('</Report>', reportSections + '\n</Report>')
            : fixedRdl + '\n' + reportSections;
          changed = true;
          const rdlVersion = rdl.match(/reporting\/(20\d\d\/\d\d)\/reportdefinition/)?.[1] ?? 'modern';
          console.error(`[sanitizeReportXml] Wrapped Body+Page in <ReportSections>/<ReportSection> for ${rdlVersion} RDL`);
        }

      } else if (is2008 && (rdl.includes('<PageHeader') || rdl.includes('<PageFooter'))) {
        // 2008 schema: <PageHeader>/<PageFooter> must be inside <Page>, not direct children of <Report>.
        // A real D365FO RDL always has a <Page> element (PageWidth/Height/Margins) but PageHeader is
        // still a sibling — the old guard `!rdl.match(/<Page...>/)` incorrectly skipped this case.
        // Strategy:
        //   a) If <Page> already exists — inject PageHeader/PageFooter before </Page>.
        //   b) If <Page> doesn't exist — create one after </Body>.
        const pageMatch = fixedRdl.match(/<Page(?:\s[^>]*)?>[\s\S]*?<\/Page>/);
        const alreadyInPage = !!pageMatch &&
          (pageMatch[0].includes('<PageHeader') || pageMatch[0].includes('<PageFooter'));
        if (!alreadyInPage) {
          let pageInner = '';
          const phMatch = fixedRdl.match(/<PageHeader[\s\S]*?<\/PageHeader>/);
          if (phMatch) { pageInner += phMatch[0]; fixedRdl = fixedRdl.replace(phMatch[0], ''); }
          const pfMatch = fixedRdl.match(/<PageFooter[\s\S]*?<\/PageFooter>/);
          if (pfMatch) { pageInner += (pageInner ? '\n' : '') + pfMatch[0]; fixedRdl = fixedRdl.replace(pfMatch[0], ''); }
          if (pageInner) {
            if (pageMatch) {
              // Inject into the existing <Page> before </Page>
              const updatedPage = pageMatch[0].replace('</Page>', pageInner.trim() + '\n</Page>');
              fixedRdl = fixedRdl.replace(pageMatch[0], updatedPage);
            } else {
              // No existing <Page> — create one after </Body>
              const pageEl = '<Page>\n' + pageInner.trim() + '\n</Page>';
              fixedRdl = fixedRdl.includes('</Body>')
                ? fixedRdl.replace('</Body>', '</Body>\n' + pageEl)
                : fixedRdl.replace('</Report>', pageEl + '\n</Report>');
            }
            changed = true;
            console.error('[sanitizeReportXml] Moved <PageHeader>/<PageFooter> inside <Page> in 2008 RDL');
          }
        }
      }

      if (!changed) return _whole;
      return open + fixedRdl + close;
    });

    // 9. Fix wrong margin element names inside embedded RDL.
    //    Some AI-generated RDLs use CSS-style names (MarginTop, MarginLeft, …) instead of
    //    the correct SSRS RDL names (TopMargin, LeftMargin, …).  All SSRS namespace versions
    //    require the XMargin form — MarginX causes "invalid child element 'MarginTop'" in
    //    VS Designer even though the value and namespace are otherwise correct.
    if (xml.includes('<MarginTop>') || xml.includes('<MarginBottom>') ||
        xml.includes('<MarginLeft>') || xml.includes('<MarginRight>')) {
      xml = xml
        .replace(/<MarginTop>/g,    '<TopMargin>')   .replace(/<\/MarginTop>/g,    '</TopMargin>')
        .replace(/<MarginBottom>/g, '<BottomMargin>').replace(/<\/MarginBottom>/g, '</BottomMargin>')
        .replace(/<MarginLeft>/g,   '<LeftMargin>')  .replace(/<\/MarginLeft>/g,   '</LeftMargin>')
        .replace(/<MarginRight>/g,  '<RightMargin>') .replace(/<\/MarginRight>/g,  '</RightMargin>');
      console.error('[sanitizeReportXml] Fixed wrong margin element names (MarginX → XMargin) in embedded RDL');
    }

    // 10. Ensure <Body> inside embedded RDL <ReportSection> has <ReportItems /> as its first
    //     child element.  SSRS schema requires the order: ReportItems → Height → Style.
    //     Without <ReportItems>, VS Designer can't surface the DataSet in the Report Data panel
    //     (it appears as if the dataset "disappeared") and may refuse to open the report.
    xml = xml.replace(/(<Text><!\[CDATA\[)([\s\S]*?)(\]\]><\/Text>)/, (_whole, open, rdl, close) => {
      // Match a <Body> that contains <Height> or <Style> but lacks <ReportItems>
      // (i.e., an empty skeleton body without any report items)
      const fixedRdl = rdl.replace(
        /<Body>\s*\n(\s*)((?!<ReportItems)[\s\S]*?)<\/Body>/,
        (_bodyMatch: string, indent: string, bodyContent: string) => {
          // Only add <ReportItems /> when the body has no report items at all
          if (bodyContent.includes('<ReportItems')) return _bodyMatch;
          console.error('[sanitizeReportXml] Added missing <ReportItems /> as first child of <Body> in embedded RDL');
          return `<Body>\n${indent}<ReportItems />\n${indent}${bodyContent.trimStart()}</Body>`;
        }
      );
      if (fixedRdl === rdl) return _whole;
      return open + fixedRdl + close;
    });

    // 11. Fix doubled closing tags inside embedded RDL CDATA.
    //     AI generators sometimes emit </Foo></Foo> (the closing tag twice).
    //     These are invalid XML and cause "Deserialization failed" in VS Designer.
    //     Pattern: </TagName></TagName>  →  </TagName>
    xml = xml.replace(/(<Text><!\[CDATA\[)([\s\S]*?)(\]\]><\/Text>)/, (_whole, open, rdl, close) => {
      const fixedRdl = rdl.replace(/<\/(\w+)><\/\1>/g, (_m: string, tag: string) => {
        console.error(`[sanitizeReportXml] Removed doubled closing tag </${tag}></${tag}> in embedded RDL`);
        return `</${tag}>`;
      });
      if (fixedRdl === rdl) return _whole;
      return open + fixedRdl + close;
    });

    // 12. Fix <Value> as direct child of <Textbox> in embedded RDL.
    //     SSRS 2008+ schema requires: <Textbox> → <Paragraphs><Paragraph><TextRuns><TextRun><Value>
    //     AI generators sometimes emit <Value> directly inside <Textbox>, which causes:
    //     "invalid child element 'Value'" error in VS Designer.
    //     This fix wraps any bare <Value>…</Value> found as a direct child of <Textbox>
    //     into the correct paragraph/textrun structure.
    xml = xml.replace(/(<Text><!\[CDATA\[)([\s\S]*?)(\]\]><\/Text>)/, (_whole, open, rdl, close) => {
      // Look for <Textbox ...> that contains a direct <Value> child (not inside <TextRun>)
      const fixedRdl = rdl.replace(
        /(<Textbox\b[^>]*>)([\s\S]*?)(<\/Textbox>)/g,
        (tbMatch: string, tbOpen: string, tbContent: string, tbClose: string) => {
          // Only act if there is a <Value> but no <Paragraphs> wrapping yet
          if (!tbContent.includes('<Value>') && !tbContent.includes('<Value =')) return tbMatch;
          if (tbContent.includes('<Paragraphs>')) return tbMatch;
          const fixedContent = tbContent.replace(
            /<Value>([\s\S]*?)<\/Value>/,
            (_vMatch: string, val: string) => {
              console.error('[sanitizeReportXml] Wrapped bare <Value> in <Textbox> into <Paragraphs> structure');
              return `<Paragraphs>\n            <Paragraph>\n              <TextRuns>\n                <TextRun>\n                  <Value>${val}</Value>\n                  <Style />\n                </TextRun>\n              </TextRuns>\n              <Style />\n            </Paragraph>\n          </Paragraphs>`;
            }
          );
          if (fixedContent === tbContent) return tbMatch;
          return tbOpen + fixedContent + tbClose;
        }
      );
      if (fixedRdl === rdl) return _whole;
      return open + fixedRdl + close;
    });

    // 13. Fix <ColSpan>/<RowSpan> as direct children of <TablixCell>.
    //     SSRS schema only allows CellContents, DataElementName, DataElementOutput
    //     as direct children of <TablixCell>. ColSpan/RowSpan must be INSIDE
    //     <CellContents> (after the report item, before </CellContents>).
    //     AI generators emit them BEFORE or AFTER the <CellContents> block:
    //       <TablixCell><ColSpan>2</ColSpan><CellContents>...</CellContents></TablixCell>
    //       <TablixCell><CellContents>...</CellContents><ColSpan>2</ColSpan></TablixCell>
    //     Both cause "invalid child element 'ColSpan'" deserialization error.
    xml = xml.replace(/(<Text><!\[CDATA\[)([\s\S]*?)(\]\]><\/Text>)/, (_whole, open, rdl, close) => {
      const fixedRdl = rdl.replace(
        /(<TablixCell>)([\s\S]*?)(<\/TablixCell>)/g,
        (tcMatch: string, tcOpen: string, tcContent: string, tcClose: string) => {
          // Use indexOf to split tcContent into: beforeCC / ccBlock / afterCC.
          // This reliably handles spans placed either before OR after CellContents.
          const ccStart = tcContent.indexOf('<CellContents');
          const ccEnd   = tcContent.indexOf('</CellContents>');
          if (ccStart === -1 || ccEnd === -1) return tcMatch;

          const beforeCC = tcContent.substring(0, ccStart);
          const ccBlock  = tcContent.substring(ccStart, ccEnd + '</CellContents>'.length);
          const afterCC  = tcContent.substring(ccEnd + '</CellContents>'.length);

          // Collect ColSpan/RowSpan from anywhere outside CellContents
          const spanTagRe = () => /[ \t\r\n]*<(ColSpan|RowSpan)>[^<]*<\/\1>/g;
          let spans = '';
          const cleanBefore = beforeCC.replace(spanTagRe(), (m) => { spans += '\n' + m.trim(); return ''; });
          const cleanAfter  = afterCC.replace( spanTagRe(), (m) => { spans += '\n' + m.trim(); return ''; });

          if (!spans) return tcMatch;

          // Move collected spans inside CellContents, just before </CellContents>
          const fixedCC = ccBlock.replace('</CellContents>', `${spans}\n</CellContents>`);
          console.error('[sanitizeReportXml] Moved <ColSpan>/<RowSpan> from <TablixCell> into <CellContents> in embedded RDL');
          return tcOpen + cleanBefore + fixedCC + cleanAfter + tcClose;
        }
      );
      if (fixedRdl === rdl) return _whole;
      return open + fixedRdl + close;
    });

    // 14. Fix flat border properties as direct children of <Style>.
    //     SSRS <Style> only accepts <Border>, <TopBorder>, <BottomBorder>,
    //     <LeftBorder>, <RightBorder> as border wrappers — not flat attributes
    //     like <BorderStyle>, <BorderColor>, <BorderWidth>.
    //     AI generators often emit:
    //       <Style><BorderStyle>Solid</BorderStyle><BorderColor>#000</BorderColor></Style>
    //     but the correct form is:
    //       <Style><Border><Style>Solid</Style><Color>#000</Color></Border></Style>
    //     Same pattern applies to TopBorderStyle/TopBorderColor/TopBorderWidth etc.
    //
    //     Previous approach (matching <Style>…</Style> blocks non-greedily) had a
    //     nesting failure: if an outer <Style> contained a nested <Style> element
    //     (e.g. <Border><Style>Solid</Style>…</Border>) BEFORE a flat <BorderStyle>,
    //     the non-greedy regex would bind the outer opening <Style> to the inner
    //     closing </Style>, leaving the flat tag unprocessed.
    //
    //     New approach: scan the CDATA directly for flat border-property clusters
    //     and replace them with the correct wrapper, independent of the containing
    //     <Style> block.  Adjacent flat tags (same group, separated only by
    //     whitespace) are collapsed into a single wrapper element.
    xml = xml.replace(/(<Text><!\[CDATA\[)([\s\S]*?)(\]\]><\/Text>)/g, (_whole, open, rdl, close) => {
      let fixedRdl = rdl;
      let changed = false;

      const groups: Array<[string, string]> = [
        ['Border',       'Border'],
        ['TopBorder',    'TopBorder'],
        ['BottomBorder', 'BottomBorder'],
        ['LeftBorder',   'LeftBorder'],
        ['RightBorder',  'RightBorder'],
      ];

      for (const [prefix, wrapper] of groups) {
        const st = `${prefix}Style`;
        const ct = `${prefix}Color`;
        const wt = `${prefix}Width`;

        if (!new RegExp(`<(?:${st}|${ct}|${wt})>`).test(fixedRdl)) continue;

        // Build a regex that matches a cluster of 1–3 adjacent flat border tags
        // for this group (in any order, with optional whitespace between them).
        const singleTag =
          `(?:<${st}>([^<]*)<\\/${st}>|<${ct}>([^<]*)<\\/${ct}>|<${wt}>([^<]*)<\\/${wt}>)`;
        const clusterRe = new RegExp(
          `${singleTag}(?:\\s*${singleTag})?(?:\\s*${singleTag})?`,
          'g'
        );

        fixedRdl = fixedRdl.replace(clusterRe, (match: string) => {
          // Extract each flat-tag value from the matched cluster via side-effect callbacks.
          let bStyle = '', bColor = '', bWidth = '';
          match.replace(new RegExp(`<${st}>([^<]*)<\\/${st}>`), (_: string, v: string) => { bStyle = v; return ''; });
          match.replace(new RegExp(`<${ct}>([^<]*)<\\/${ct}>`), (_: string, v: string) => { bColor = v; return ''; });
          match.replace(new RegExp(`<${wt}>([^<]*)<\\/${wt}>`), (_: string, v: string) => { bWidth = v; return ''; });

          let inner = '';
          if (bStyle) inner += `<Style>${bStyle}</Style>`;
          if (bColor) inner += `<Color>${bColor}</Color>`;
          if (bWidth) inner += `<Width>${bWidth}</Width>`;

          changed = true;
          return `<${wrapper}>${inner}</${wrapper}>`;
        });
      }

      if (!changed) return _whole;
      console.error('[sanitizeReportXml] Wrapped flat border properties into <Border> inside <Style> in embedded RDL');
      return open + fixedRdl + close;
    });

    // 15. Fix absorbed TablixCells following a ColSpan > 1.
    //     Confirmed by real D365FO reports: when <CellContents> has <ColSpan>N</ColSpan>,
    //     the next N-1 sibling TablixCells in the same <TablixCells> block must be empty
    //     (<TablixCell />). AI generators give those absorbed cells full CellContents,
    //     causing VS Report Designer to render an empty/broken design surface.
    //     Approach: for each <ColSpan>N</ColSpan>, trace past its containing
    //     </CellContents></TablixCell> then depth-count-walk the next N-1 TablixCells
    //     and replace any non-empty ones with <TablixCell />.
    xml = xml.replace(/(<Text><!\[CDATA\[)([\s\S]*?)(\]\]><\/Text>)/, (_whole, open, rdl, close) => {
      let fixedRdl = rdl;
      const patches: { start: number; end: number }[] = [];

      const csRe = /<ColSpan>(\d+)<\/ColSpan>/g;
      let csMatch: RegExpExecArray | null;
      while ((csMatch = csRe.exec(fixedRdl)) !== null) {
        const span = parseInt(csMatch[1], 10);
        if (span <= 1) continue;

        // Find </CellContents> that closes the CellContents containing this ColSpan
        const ccCloseIdx = fixedRdl.indexOf('</CellContents>', csMatch.index + csMatch[0].length);
        if (ccCloseIdx === -1) continue;
        // Find </TablixCell> that closes the TablixCell containing this CellContents
        const tcCloseIdx = fixedRdl.indexOf('</TablixCell>', ccCloseIdx + '</CellContents>'.length);
        if (tcCloseIdx === -1) continue;

        let pos = tcCloseIdx + '</TablixCell>'.length;

        for (let i = 0; i < span - 1; i++) {
          // Skip whitespace
          while (pos < fixedRdl.length && /\s/.test(fixedRdl[pos])) pos++;

          if (fixedRdl.startsWith('<TablixCell />', pos) || fixedRdl.startsWith('<TablixCell/>', pos)) {
            // Already empty — advance
            pos += fixedRdl.startsWith('<TablixCell />', pos) ? '<TablixCell />'.length : '<TablixCell/>'.length;
            continue;
          }
          if (!fixedRdl.startsWith('<TablixCell>', pos)) break; // Not a TablixCell

          // Walk to balanced </TablixCell>, counting nested TablixCell depth
          let depth = 1;
          let search = pos + '<TablixCell>'.length;
          while (depth > 0 && search < fixedRdl.length) {
            const nextOpen  = fixedRdl.indexOf('<TablixCell>',  search);
            const nextClose = fixedRdl.indexOf('</TablixCell>', search);
            if (nextClose === -1) { depth = 0; break; }
            if (nextOpen !== -1 && nextOpen < nextClose) {
              depth++;
              search = nextOpen + '<TablixCell>'.length;
            } else {
              depth--;
              search = nextClose + '</TablixCell>'.length;
            }
          }
          const cellEnd = search;
          patches.push({ start: pos, end: cellEnd });
          pos = cellEnd;
        }
      }

      if (patches.length === 0) return _whole;
      // Apply patches in reverse order to preserve string positions
      patches.sort((a, b) => b.start - a.start);
      let result = fixedRdl;
      for (const p of patches) {
        result = result.substring(0, p.start) + '<TablixCell />' + result.substring(p.end);
      }
      console.error(`[sanitizeReportXml] Emptied ${patches.length} absorbed TablixCell(s) following ColSpan in embedded RDL`);
      return open + result + close;
    });

    // 16. Rename reversed border side wrapper element names.
    //     SSRS schema expects <TopBorder>, <BottomBorder>, <LeftBorder>, <RightBorder>.
    //     AI generators often emit them reversed: <BorderTop>, <BorderBottom>, etc.
    //     The inner content (<Style>, <Color>, <Width>) is already correct — only
    //     the wrapper element name needs to change.
    if (xml.includes('<BorderTop>') || xml.includes('<BorderBottom>') ||
        xml.includes('<BorderLeft>') || xml.includes('<BorderRight>')) {
      xml = xml
        .replace(/<BorderTop>/g,     '<TopBorder>')    .replace(/<\/BorderTop>/g,     '</TopBorder>')
        .replace(/<BorderBottom>/g,  '<BottomBorder>') .replace(/<\/BorderBottom>/g,  '</BottomBorder>')
        .replace(/<BorderLeft>/g,    '<LeftBorder>')   .replace(/<\/BorderLeft>/g,    '</LeftBorder>')
        .replace(/<BorderRight>/g,   '<RightBorder>')  .replace(/<\/BorderRight>/g,   '</RightBorder>');
      console.error('[sanitizeReportXml] Fixed reversed border side wrapper names (BorderXxx → XxxBorder) in RDL');
    }

    // 17. Add missing </Style> before </Paragraph> when Paragraph-level Style is
    //     left unclosed. AI generators sometimes emit:
    //       <Paragraph><TextRuns>...</TextRuns><Style><TextAlign>Right</TextAlign></Paragraph>
    //     The </Style> before </Paragraph> is missing, which makes the XML
    //     malformed (</Paragraph> appears to close inside <Style>) and causes
    //     SSRS deserialization to fail entirely.
    xml = xml.replace(/(<Text><!\[CDATA\[)([\s\S]*?)(\]\]><\/Text>)/, (_whole, open, rdl, close) => {
      const fixedRdl = rdl.replace(
        /<Paragraph>([\s\S]*?)<\/Paragraph>/g,
        (match: string, inner: string) => {
          const opens  = (inner.match(/<Style>/g)  || []).length;
          const closes = (inner.match(/<\/Style>/g) || []).length;
          if (opens === closes) return match;
          const missing = opens - closes;
          console.error('[sanitizeReportXml] Added missing </Style> tag(s) inside <Paragraph> in embedded RDL');
          return `<Paragraph>${inner}${'</Style>'.repeat(missing)}</Paragraph>`;
        }
      );
      if (fixedRdl === rdl) return _whole;
      return open + fixedRdl + close;
    });

    // 18. Reconcile TablixCells count with TablixColumns count.
    //     Each TablixRow must have exactly as many TablixCell elements as there
    //     are TablixColumn entries in the enclosing Tablix's TablixColumns block.
    //     When the counts are mismatched VS Report Designer throws:
    //       "Index was out of range. Must be non-negative and less than the size
    //        of the collection. Parameter name: index"
    //
    //     Two cases are handled:
    //       A) A TablixRow has FEWER cells than TablixColumns → pad with <TablixCell />
    //       B) TablixColumns has FEWER entries than max cells per row → pad columns
    //
    //     The fix finds each top-level <Tablix>…</Tablix> block using depth
    //     tracking (to handle multiple/nested Tablix controls correctly) and
    //     reconciles column vs cell counts within each one independently.
    xml = xml.replace(/(<Text><!\[CDATA\[)([\s\S]*?)(\]\]><\/Text>)/g, (_whole, open, rdl, close) => {
      let fixedRdl = rdl;
      let changed = false;

      const processTablix = (block: string): string => {
        // Count declared TablixColumn entries (exclude TablixColumns container)
        const colsMatch = block.match(/<TablixColumns>([\s\S]*?)<\/TablixColumns>/);
        if (!colsMatch) return block;
        const colCount = (colsMatch[1].match(/<TablixColumn[\s>\/]/g) || []).length;
        if (colCount === 0) return block;

        // Sub-case A: pad each TablixCells block that has too few cells
        let result = block.replace(
          /(<TablixCells>)([\s\S]*?)(<\/TablixCells>)/g,
          (m: string, o: string, inner: string, c: string) => {
            const n = (inner.match(/<TablixCell[\s>\/]/g) || []).length;
            if (n >= colCount) return m;
            changed = true;
            const padding = Array(colCount - n).fill('\t\t\t\t<TablixCell />').join('\n');
            return `${o}${inner}\n${padding}\n\t\t\t${c}`;
          }
        );

        // Sub-case B: ensure TablixColumns has enough entries
        const cellsBlocks = result.match(/<TablixCells>([\s\S]*?)<\/TablixCells>/g) || [];
        const maxCells = cellsBlocks.reduce((mx, b) => {
          const n = (b.match(/<TablixCell[\s>\/]/g) || []).length;
          return n > mx ? n : mx;
        }, 0);
        if (maxCells > colCount) {
          const extra = Array(maxCells - colCount)
            .fill('\t\t<TablixColumn><Width>1in</Width></TablixColumn>')
            .join('\n');
          result = result.replace('</TablixColumns>', `\n${extra}\n\t\t</TablixColumns>`);
          changed = true;
        }

        return result;
      };

      // Depth-tracking scan for each top-level <Tablix>…</Tablix> block.
      // Child elements (<TablixBody>, <TablixColumns>, <TablixCell>, …) all have
      // letters immediately after '<Tablix', so the main element is identified by
      // '<Tablix' followed by '>', ' ', tab, or newline.
      let pos = 0;
      while (pos < fixedRdl.length) {
        const tagStart = fixedRdl.indexOf('<Tablix', pos);
        if (tagStart < 0) break;

        const ch = fixedRdl[tagStart + 7];
        if (ch !== '>' && ch !== ' ' && ch !== '\t' && ch !== '\n' && ch !== '\r') {
          pos = tagStart + 8;
          continue;
        }

        // Self-closing <Tablix /> — skip
        const tagEndIdx = fixedRdl.indexOf('>', tagStart);
        if (tagEndIdx < 0) break;
        if (fixedRdl[tagEndIdx - 1] === '/') { pos = tagEndIdx + 1; continue; }

        // Depth-scan for matching </Tablix>
        let depth = 1;
        let scan = tagEndIdx + 1;
        let closeTagPos = -1;
        while (depth > 0 && scan < fixedRdl.length) {
          const nxtOpen  = fixedRdl.indexOf('<Tablix', scan);
          const nxtClose = fixedRdl.indexOf('</Tablix>', scan);
          if (nxtClose < 0) break;

          if (nxtOpen >= 0 && nxtOpen < nxtClose) {
            const nc = fixedRdl[nxtOpen + 7];
            if (nc === '>' || nc === ' ' || nc === '\t' || nc === '\n' || nc === '\r') {
              depth++;
              const innerTagEnd = fixedRdl.indexOf('>', nxtOpen);
              scan = innerTagEnd >= 0 ? innerTagEnd + 1 : nxtOpen + 8;
            } else {
              scan = nxtOpen + 8;
            }
          } else {
            depth--;
            if (depth === 0) closeTagPos = nxtClose;
            scan = nxtClose + 9; // '</Tablix>'.length === 9
          }
        }

        if (closeTagPos < 0) break;
        const blockEnd = closeTagPos + 9;
        const block = fixedRdl.substring(tagStart, blockEnd);
        const fixed  = processTablix(block);
        if (fixed !== block) {
          fixedRdl = fixedRdl.substring(0, tagStart) + fixed + fixedRdl.substring(blockEnd);
          pos = tagStart + fixed.length;
        } else {
          pos = blockEnd;
        }
      }

      if (!changed) return _whole;
      console.error('[sanitizeReportXml] Reconciled TablixCell count with TablixColumn count in embedded RDL');
      return open + fixedRdl + close;
    });

    return xml;
  }

  /**
   * Convert <Text><![CDATA[…RDL…]]></Text> to XML entity-encoded form.
   *
   * D365FO stores and expects the embedded RDL as entity-encoded text, not CDATA:
   *   <Text>&lt;?xml version="1.0"?&gt;&lt;Report ...&gt;...&lt;/Report&gt;</Text>
   *
   * CDATA is valid XML and semantically equivalent, but the VS Designer metadata loader
   * does not render <Designs> correctly when the <Text> value uses CDATA — the design
   * appears empty even though no parse error is raised. Using entity encoding matches
   * what VS writes natively and fixes the empty-design issue.
   *
   * This is a SEPARATE method from sanitizeReportXml intentionally:
   *   - sanitizeReportXml operates on CDATA form (efficient regex over raw XML text)
   *   - encodeReportTextElement runs AFTER sanitize, just before writing to disk
   */
  static encodeReportTextElement(xml: string): string {
    return xml.replace(/<Text><!\[CDATA\[([\s\S]*?)\]\]><\/Text>/g, (_match, rdlInner: string) => {
      const encoded = rdlInner
        .replace(/&/g, '&amp;')   // must be first to avoid double-encoding
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
      return `<Text>${encoded}</Text>`;
    });
  }

  /**
   * Generate AxEdt XML (Extended Data Type).
   * Default i:type is AxEdtString; override via properties.edtType.
   */
  static generateAxEdtXml(name: string, properties?: Record<string, any>): string {
    const edtType = properties?.edtType || 'AxEdtString';
    const label = properties?.label || '@TODO:LabelId';
    const extends_ = properties?.extends ? `\n\t<Extends>${properties.extends}</Extends>` : '';
    const stringSize = edtType === 'AxEdtString'
      ? `\n\t<StringSize>${properties?.stringSize ?? 30}</StringSize>` : '';
    return `<?xml version="1.0" encoding="utf-8"?>
<AxEdt xmlns:i="http://www.w3.org/2001/XMLSchema-instance" xmlns=""
\ti:type="${edtType}">
\t<Name>${name}</Name>
\t<Label>${label}</Label>${extends_}
\t<ArrayElements />
\t<Relations />
\t<TableReferences />${stringSize}
</AxEdt>`;
  }

  /**
   * Generate a minimal extension XML for AxEdtExtension, AxEnumExtension,
   * AxDataEntityViewExtension, AxMenuItemDisplayExtension, AxMenuItemActionExtension,
   * AxMenuItemOutputExtension.
   * Name convention: BaseObjectName.ExtensionName  (e.g. CustTable.MyExtension)
   */
  static generateAxSimpleExtensionXml(rootElement: string, name: string): string {
    return `<?xml version="1.0" encoding="utf-8"?>
<${rootElement} xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
\t<Name>${name}</Name>
\t<PropertyModifications />
</${rootElement}>`;
  }

  /**
   * Generate AxTableExtension XML.
   * Name convention: TableName.ExtensionName
   */
  static generateAxTableExtensionXml(name: string): string {
    return `<?xml version="1.0" encoding="utf-8"?>
<AxTableExtension xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
\t<Name>${name}</Name>
\t<FieldGroupExtensions />
\t<FieldGroups />
\t<FieldModifications />
\t<Fields />
\t<FullTextIndexes />
\t<Indexes />
\t<Mappings />
\t<PropertyModifications />
\t<RelationExtensions />
\t<RelationModifications />
\t<Relations />
</AxTableExtension>`;
  }

  /**
   * Generate AxFormExtension XML.
   * Name convention: FormName.ExtensionName
   */
  static generateAxFormExtensionXml(name: string): string {
    return `<?xml version="1.0" encoding="utf-8"?>
<AxFormExtension xmlns:i="http://www.w3.org/2001/XMLSchema-instance" xmlns="Microsoft.Dynamics.AX.Metadata.V6">
\t<Name>${name}</Name>
\t<ControlModifications />
\t<Controls />
\t<DataSourceModifications />
\t<DataSourceReferences />
\t<DataSources />
\t<Parts />
\t<PropertyModifications />
</AxFormExtension>`;
  }

  /**
   * Generate AxSecurityPrivilege XML.
   */
  static generateAxSecurityPrivilegeXml(name: string, properties?: Record<string, any>): string {
    const label = properties?.label || '@TODO:LabelId';
    return `<?xml version="1.0" encoding="utf-8"?>
<AxSecurityPrivilege xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
\t<Name>${name}</Name>
\t<Label>${label}</Label>
\t<DataEntityPermissions />
\t<DirectAccessPermissions />
\t<EntryPoints />
\t<FormControlOverrides />
</AxSecurityPrivilege>`;
  }

  /**
   * Generate AxSecurityDuty XML.
   */
  static generateAxSecurityDutyXml(name: string, properties?: Record<string, any>): string {
    const label = properties?.label || '@TODO:LabelId';
    return `<?xml version="1.0" encoding="utf-8"?>
<AxSecurityDuty xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
\t<Name>${name}</Name>
\t<Label>${label}</Label>
\t<Privileges />
</AxSecurityDuty>`;
  }

  /**
   * Generate AxSecurityRole XML.
   */
  static generateAxSecurityRoleXml(name: string, properties?: Record<string, any>): string {
    const label = properties?.label || '@TODO:LabelId';
    return `<?xml version="1.0" encoding="utf-8"?>
<AxSecurityRole xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
\t<Name>${name}</Name>
\t<Label>${label}</Label>
\t<DirectAccessPermissions />
\t<Duties />
\t<Privileges />
\t<SubRoles />
</AxSecurityRole>`;
  }

  /**
   * Generate AxMenu XML.
   */
  static generateAxMenuXml(name: string, properties?: Record<string, any>): string {
    const label = properties?.label || '@TODO:LabelId';
    return `<?xml version="1.0" encoding="utf-8"?>
<AxMenu xmlns:i="http://www.w3.org/2001/XMLSchema-instance" xmlns="Microsoft.Dynamics.AX.Metadata.V1">
\t<Name>${name}</Name>
\t<Label>${label}</Label>
\t<Elements />
</AxMenu>`;
  }

  /**
   * Generate AxMenuExtension XML.
   * Name convention: MenuName.ExtensionName
   */
  static generateAxMenuExtensionXml(name: string): string {
    return `<?xml version="1.0" encoding="utf-8"?>
<AxMenuExtension xmlns:i="http://www.w3.org/2001/XMLSchema-instance" xmlns="Microsoft.Dynamics.AX.Metadata.V1">
\t<Name>${name}</Name>
\t<Customizations />
\t<Elements />
\t<MenuElementModifications />
\t<PropertyModifications />
</AxMenuExtension>`;
  }

  /**
   * Generate AxMenuItemDisplay / AxMenuItemAction / AxMenuItemOutput XML.
   *
   * AOT folder mapping:
   *   menu-item-display → AxMenuItemDisplay  (ObjectType: Form)
   *   menu-item-action  → AxMenuItemAction   (ObjectType: Class)
   *   menu-item-output  → AxMenuItemOutput   (ObjectType: Report)
   */
  static generateAxMenuItemXml(
    itemType: 'menu-item-display' | 'menu-item-action' | 'menu-item-output',
    name: string,
    properties?: Record<string, any>
  ): string {
    const elemName = itemType === 'menu-item-action' ? 'AxMenuItemAction'
      : itemType === 'menu-item-output' ? 'AxMenuItemOutput'
      : 'AxMenuItemDisplay';
    const objType = itemType === 'menu-item-action' ? 'Class'
      : itemType === 'menu-item-output' ? 'Report'
      : 'Form';
    const targetObject = properties?.targetObject || properties?.object || name;
    const label = properties?.label || '@TODO:LabelId';
    return `<?xml version="1.0" encoding="utf-8"?>
<${elemName} xmlns:i="http://www.w3.org/2001/XMLSchema-instance" xmlns="Microsoft.Dynamics.AX.Metadata.V1">
\t<Name>${name}</Name>
\t<Label>${label}</Label>
\t<Object>${targetObject}</Object>
\t<ObjectType>${objType}</ObjectType>
</${elemName}>`;
  }

  /**
   * Ensure AxMenuItemAction/Display/Output XML always has the required
   * xmlns="Microsoft.Dynamics.AX.Metadata.V1" namespace on the root element.
   * D365FO metadata deserializer rejects the file without it.
   */
  static sanitizeMenuItemXml(xml: string): string {
    return xml.replace(
      /<(AxMenuItem(?:Action|Display|Output))(\s[^>]*)?>/,
      (match, tag: string, attrs: string | undefined) => {
        const current = attrs || '';
        if (current.includes('xmlns="Microsoft.Dynamics.AX.Metadata.V1"')) return match;
        return `<${tag}${current} xmlns="Microsoft.Dynamics.AX.Metadata.V1">`;
      }
    );
  }
}

/**
 * Visual Studio Project (.rnrproj) Manipulator
 */
export class ProjectFileManager {
  private parser: Parser;
  private builder: Builder;

  constructor() {
    this.parser = new Parser({
      explicitArray: false,
      mergeAttrs: false,
      trim: true,
    });
    this.builder = new Builder({
      xmldec: { version: '1.0', encoding: 'utf-8' },
      renderOpts: { pretty: true, indent: '  ' },
    });
  }

  /**
   * Get friendly display folder name for project (used in Folder Include and Link)
   * e.g. class → Classes, enum → Base Enums
   */
  private getFolderName(objectType: string): string {
    const folderMap: Record<string, string> = {
      class: 'Classes',
      table: 'Tables',
      enum: 'Base Enums',
      form: 'Forms',
      query: 'Queries',
      view: 'Views',
      'data-entity': 'Data Entities',
      'table-extension': 'Table Extensions',
      'form-extension': 'Form Extensions',
      'data-entity-extension': 'Data Entity Extensions',
      report: 'Reports',
      'menu-item-display': 'Menu Items Display',
      'menu-item-action': 'Menu Items Action',
      'menu-item-output': 'Menu Items Output',
      'menu-item-display-extension': 'Menu Item Display Extensions',
      'menu-item-action-extension': 'Menu Item Action Extensions',
      'menu-item-output-extension': 'Menu Item Output Extensions',
      edt: 'Extended Data Types',
      'edt-extension': 'EDT Extensions',
      'enum-extension': 'Enum Extensions',
      menu: 'Menus',
      'menu-extension': 'Menu Extensions',
      'security-privilege': 'Security Privileges',
      'security-duty': 'Security Duties',
      'security-role': 'Security Roles',
    };
    return folderMap[objectType] || 'Classes';
  }

  /**
   * Get AOT folder prefix for Content Include path (no .xml extension)
   * e.g. class → AxClass, enum → AxEnum, data-entity → AxDataEntityView
   */
  private getAxFolderPrefix(objectType: string): string {
    const prefixMap: Record<string, string> = {
      class: 'AxClass',
      table: 'AxTable',
      enum: 'AxEnum',
      form: 'AxForm',
      query: 'AxQuery',
      view: 'AxView',
      'data-entity': 'AxDataEntityView',
      'table-extension': 'AxTableExtension',
      'form-extension': 'AxFormExtension',
      'data-entity-extension': 'AxDataEntityViewExtension',
      report: 'AxReport',
      'menu-item-display': 'AxMenuItemDisplay',
      'menu-item-action': 'AxMenuItemAction',
      'menu-item-output': 'AxMenuItemOutput',
      'menu-item-display-extension': 'AxMenuItemDisplayExtension',
      'menu-item-action-extension': 'AxMenuItemActionExtension',
      'menu-item-output-extension': 'AxMenuItemOutputExtension',
      edt: 'AxEdt',
      'edt-extension': 'AxEdtExtension',
      'enum-extension': 'AxEnumExtension',
      menu: 'AxMenu',
      'menu-extension': 'AxMenuExtension',
      'security-privilege': 'AxSecurityPrivilege',
      'security-duty': 'AxSecurityDuty',
      'security-role': 'AxSecurityRole',
    };
    return prefixMap[objectType] || 'AxClass';
  }

  /**
   * Add file reference to Visual Studio project
   * D365FO projects use ABSOLUTE paths to XML files in PackagesLocalDirectory
   * Returns true if file was added, false if file already exists in project
   */
  async addToProject(
    projectPath: string,
    objectType: string,
    objectName: string,
    absoluteXmlPath: string
  ): Promise<boolean> {
    console.error(
      `[ProjectFileManager] Adding to project: ${projectPath}, type: ${objectType}, name: ${objectName}`
    );
    console.error(`[ProjectFileManager] Absolute XML path: ${absoluteXmlPath}`);

    // Read project file
    const projectXml = await fs.readFile(projectPath, 'utf-8');
    const project = await this.parser.parseStringPromise(projectXml);

    console.error(
      `[ProjectFileManager] Parsed project, ItemGroup count: ${Array.isArray(project.Project.ItemGroup) ? project.Project.ItemGroup.length : 'single'}`
    );

    // Ensure project structure exists
    if (!project.Project) {
      throw new Error('Invalid .rnrproj file structure');
    }

    // Initialize ItemGroup if not exists
    if (!project.Project.ItemGroup) {
      project.Project.ItemGroup = [{ Folder: [] }, { Content: [] }];
    }

    // Convert to array if single ItemGroup
    if (!Array.isArray(project.Project.ItemGroup)) {
      project.Project.ItemGroup = [project.Project.ItemGroup];
    }

    // Find or create Folder ItemGroup
    let folderGroup = project.Project.ItemGroup.find(
      (group: any) => group.Folder !== undefined
    );
    if (!folderGroup) {
      folderGroup = { Folder: [] };
      project.Project.ItemGroup.push(folderGroup);
    }

    // Find or create Content ItemGroup
    let contentGroup = project.Project.ItemGroup.find(
      (group: any) => group.Content !== undefined
    );
    if (!contentGroup) {
      contentGroup = { Content: [] };
      project.Project.ItemGroup.push(contentGroup);
    }

    // Ensure arrays
    if (!Array.isArray(folderGroup.Folder)) {
      folderGroup.Folder = folderGroup.Folder ? [folderGroup.Folder] : [];
    }
    if (!Array.isArray(contentGroup.Content)) {
      contentGroup.Content = contentGroup.Content ? [contentGroup.Content] : [];
    }

    // Get folder names for project organization
    const displayFolderName = this.getFolderName(objectType);
    const axFolderPrefix = this.getAxFolderPrefix(objectType);

    // Add folder if not exists (uses friendly display name, e.g. "Classes\")
    const folderExists = folderGroup.Folder.some(
      (folder: any) =>
        folder.$ && folder.$.Include === `${displayFolderName}\\`
    );
    if (!folderExists) {
      folderGroup.Folder.push({
        $: { Include: `${displayFolderName}\\` },
      });
    }

    // D365FO .rnrproj standard:
    //   Content Include = AxClass\ObjectName  (Ax prefix, NO .xml extension)
    //   Link            = Classes\ObjectName  (display name, NO .xml extension)
    const contentInclude = `${axFolderPrefix}\\${objectName}`;
    const linkPath = `${displayFolderName}\\${objectName}`;

    // Check if file already in project
    const fileExists = contentGroup.Content.some(
      (content: any) =>
        content.$ && content.$.Include === contentInclude
    );

    if (fileExists) {
      console.error(
        `[ProjectFileManager] File ${objectName} is already in the project - skipping`
      );
      return false; // File already exists in project
    }

    // Add file reference
    contentGroup.Content.push({
      $: { Include: contentInclude },
      SubType: 'Content',
      Name: objectName,
      Link: linkPath,
    });

    console.error(
      `[ProjectFileManager] Added file reference to project, Content items: ${contentGroup.Content.length}`
    );

    // Write back to project file
    const updatedXml = this.builder.buildObject(project);
    await fs.writeFile(projectPath, updatedXml, 'utf-8');

    console.error(`[ProjectFileManager] Project file saved successfully`);
    return true; // File successfully added
  }

  /**
   * Extract ModelName from Visual Studio project file
   * Returns the actual model name from PropertyGroup/Model or PropertyGroup/ModelName
   */
  async extractModelName(projectPath: string): Promise<string | null> {
    try {
      console.error(
        `[ProjectFileManager] Extracting model name from: ${projectPath}`
      );

      // Read project file
      const projectXml = await fs.readFile(projectPath, 'utf-8');
      const project = await this.parser.parseStringPromise(projectXml);

      // Look for PropertyGroup with Model or ModelName
      if (project.Project && project.Project.PropertyGroup) {
        const propertyGroups = Array.isArray(project.Project.PropertyGroup)
          ? project.Project.PropertyGroup
          : [project.Project.PropertyGroup];

        for (const group of propertyGroups) {
          // Try <Model> tag first (standard D365FO format)
          if (group.Model) {
            const modelName = group.Model;
            console.error(
              `[ProjectFileManager] Found Model in project: ${modelName}`
            );
            return modelName;
          }
          
          // Fallback to <ModelName> tag (alternative format)
          if (group.ModelName) {
            const modelName = group.ModelName;
            console.error(
              `[ProjectFileManager] Found ModelName in project: ${modelName}`
            );
            return modelName;
          }
        }
      }

      console.error(
        `[ProjectFileManager] No Model or ModelName found in project file`
      );
      return null;
    } catch (error) {
      console.error(
        `[ProjectFileManager] Error extracting model name:`,
        error
      );
      return null;
    }
  }
}

/**
 * Create D365FO file handler function
 */
export async function handleCreateD365File(
  request: CallToolRequest
): Promise<{ content: Array<{ type: string; text: string }> }> {
  const args = CreateD365FileArgsSchema.parse(request.params.arguments);

  try {
    // Step 1: Try to find and parse .rnrproj to get actual ModelName
    let actualModelName = args.modelName;
    let wasAutoExtracted = false;
    let projectPathToUse = args.projectPath;
    let solutionPathToUse = args.solutionPath;
    
    console.error(
      `[create_d365fo_file] Initial modelName: ${actualModelName}`
    );

    // If neither projectPath nor solutionPath provided, try to get from config or auto-detect
    if (!projectPathToUse && !solutionPathToUse) {
      const configManager = getConfigManager();

      // Try to auto-detect from workspace (async)
      projectPathToUse = await configManager.getProjectPath() || undefined;
      solutionPathToUse = await configManager.getSolutionPath() || undefined;

      // If model name was not passed as argument, try to resolve from mcp.json config
      if (!actualModelName) {
        actualModelName = configManager.getModelName() ?? undefined;
        if (actualModelName) {
          const ctx = configManager.getContext();
          const source = ctx?.modelName ? 'modelName (mcp.json)' : 'workspacePath (mcp.json)';
          console.error(`[create_d365fo_file] Using modelName from ${source}: ${actualModelName}`);
        }
      }

      if (projectPathToUse) {
        console.error(
          `[create_d365fo_file] Using projectPath (auto-detected or from .mcp.json): ${projectPathToUse}`
        );
      } else if (solutionPathToUse) {
        console.error(
          `[create_d365fo_file] Using solutionPath (auto-detected or from .mcp.json): ${solutionPathToUse}`
        );
      }
    }

    // If projectPath is available, extract model name from it
    if (projectPathToUse) {
      const projectManager = new ProjectFileManager();
      const extractedModelName = await projectManager.extractModelName(
        projectPathToUse
      );
      if (extractedModelName) {
        actualModelName = extractedModelName;
        wasAutoExtracted = true;
        console.error(
          `[create_d365fo_file] Extracted ModelName from projectPath: ${actualModelName}`
        );
        
        // ✨ Register extracted model as custom (since it came from user's project)
        registerCustomModel(actualModelName);
      }
    }
    // If solutionPath is available, try to find .rnrproj and extract model name
    else if (solutionPathToUse) {
      const foundProjectPath = await ProjectFileFinder.findProjectInSolution(
        solutionPathToUse,
        actualModelName ?? ''
      );
      
      if (foundProjectPath) {
        const projectManager = new ProjectFileManager();
        const extractedModelName = await projectManager.extractModelName(
          foundProjectPath
        );
        if (extractedModelName) {
          actualModelName = extractedModelName;
          wasAutoExtracted = true;
          console.error(
            `[create_d365fo_file] Extracted ModelName from solutionPath .rnrproj: ${actualModelName}`
          );
          
          // ✨ Register extracted model as custom (since it came from user's project)
          registerCustomModel(actualModelName);
        }
      }
    }

    // ⚠️ CRITICAL: modelName is required — must come from args, mcp.json, or .rnrproj extraction
    if (!actualModelName) {
      const errorMsg =
        '❌ ERROR: modelName could not be resolved.\n\n' +
        'Provide it in one of these ways:\n' +
        '  1. Pass modelName explicitly in the tool call arguments\n' +
        '  2. Add modelName to .mcp.json context: { "context": { "modelName": "YourModel" } }\n' +
        '  3. Add workspacePath ending with the package/model name: { "context": { "workspacePath": "C:\\\\AosService\\\\PackagesLocalDirectory\\\\YourModel" } }\n' +
        '  4. Add projectPath or solutionPath to .mcp.json so the model is auto-extracted from .rnrproj';
      console.error(`[create_d365fo_file] ${errorMsg}`);
      return { content: [{ type: 'text', text: errorMsg }] };
    }

    // ⚠️ CRITICAL WARNING: If no project/solution path available anywhere
    if (!projectPathToUse && !solutionPathToUse) {
      console.error(
        `[create_d365fo_file] ⚠️ WARNING: No projectPath or solutionPath available (not in args, not in .mcp.json)!`
      );
      console.error(
        `[create_d365fo_file] ⚠️ Using modelName AS-IS: "${actualModelName}"`
      );
      console.error(
        `[create_d365fo_file] ⚠️ If "${actualModelName}" is a Microsoft model (e.g., ApplicationSuite), this will create the file in the WRONG location!`
      );
      console.error(
        `[create_d365fo_file] ⚠️ Add projectPath or solutionPath to .mcp.json config to auto-extract correct ModelName from .rnrproj!`
      );
      
      // Extra validation: Check for suspicious/placeholder model names
      const suspiciousNames = ['auto', 'test', 'example', 'temp', 'undefined', 'null'];
      // Known Microsoft standard D365FO models — NEVER use for custom code
      const knownMicrosoftModels = [
        'applicationsuite', 'applicationcommon', 'applicationfoundation', 'applicationplatform',
        'applicationwebcomponents', 'applicationworkspaces', 'foundation',
        'directory', 'dimensions', 'currency', 'calendar', 'casemanagement',
        'contactperson', 'datasharing', 'dataupgrade', 'datamaintenance',
        'electronicreporting', 'electronicreportingcore',
        'banktype', 'banktypes', 'benefitsmanagement', 'creditmanagement',
      ];
      const modelLower = actualModelName.toLowerCase();
      const isPlaceholder = suspiciousNames.includes(modelLower);
      const isMicrosoftModel = knownMicrosoftModels.includes(modelLower);

      if (isPlaceholder || isMicrosoftModel) {
        const reason = isPlaceholder
          ? `"${actualModelName}" is a placeholder value, not a real D365FO model`
          : `"${actualModelName}" is a Microsoft standard model — custom code must NEVER be created there`;
        const errorMsg =
          `❌ ERROR: ${reason}\n\n` +
          `Root cause: No projectPath or solutionPath was found (not in tool args, not in .mcp.json config).\n` +
          `Without projectPath, the tool uses the modelName parameter AS-IS, which is wrong.\n\n` +
          `To fix — add projectPath to .mcp.json (in the MCP server directory)::\n` +
          `  {\n` +
          `    "servers": {\n` +
          `      "context": {\n` +
          `        "projectPath": "C:\\\\VSProjects\\\\YourSolution\\\\YourProject\\\\YourProject.rnrproj",\n` +
          `        "solutionPath": "C:\\\\VSProjects\\\\YourSolution",\n` +
          `        "packagePath": "C:\\\\AosService\\\\PackagesLocalDirectory"\n` +
          `      }\n` +
          `    }\n` +
          `  }\n\n` +
          `Or pass projectPath explicitly in the tool call arguments.`;

        console.error(`[create_d365fo_file] ${errorMsg}`);

        return {
          content: [
            {
              type: 'text',
              text: errorMsg
            }
          ]
        };
      }
    }

    console.error(
      `[create_d365fo_file] Final ModelName to use: ${actualModelName}${wasAutoExtracted ? ' (auto-extracted ✓)' : ' (as-is, NOT auto-extracted ⚠️)'}`
    );

    // Apply extension prefix to object name
    const objectPrefix = resolveObjectPrefix(actualModelName);
    const finalObjectName = applyObjectPrefix(args.objectName, objectPrefix);
    if (finalObjectName !== args.objectName) {
      console.error(`[create_d365fo_file] Applied prefix "${objectPrefix}": ${args.objectName} → ${finalObjectName}`);
    }

    // Determine object folder based on type
    const objectFolderMap: Record<string, string> = {
      class: 'AxClass',
      table: 'AxTable',
      enum: 'AxEnum',
      form: 'AxForm',
      query: 'AxQuery',
      view: 'AxView',
      'data-entity': 'AxDataEntityView',
      report: 'AxReport',
      edt: 'AxEdt',
      'edt-extension': 'AxEdtExtension',
      'table-extension': 'AxTableExtension',
      'form-extension': 'AxFormExtension',
      'data-entity-extension': 'AxDataEntityViewExtension',
      'enum-extension': 'AxEnumExtension',
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

    const objectFolder = objectFolderMap[args.objectType];
    if (!objectFolder) {
      throw new Error(`Unsupported object type: ${args.objectType}`);
    }

    // Construct full path - resolve package name
    // Package name can differ from model name in any environment (not just UDE).
    const configManager = getConfigManager();
    const configPackagePath = configManager.getPackagePath();
    const envType = await configManager.getDevEnvironmentType();

    let basePath: string;
    let resolvedPackageName: string;

    if (args.packageName) {
      // Explicit packageName always wins, regardless of environment type
      resolvedPackageName = args.packageName;
      if (envType === 'ude') {
        const customPath = await configManager.getCustomPackagesPath();
        basePath = customPath || args.packagePath || configPackagePath || 'K:\\AosService\\PackagesLocalDirectory';
      } else {
        basePath = args.packagePath || configPackagePath || 'K:\\AosService\\PackagesLocalDirectory';
      }
    } else if (envType === 'ude') {
      // UDE mode: auto-resolve package name via descriptor scan
      const customPath = await configManager.getCustomPackagesPath();
      const msPath = await configManager.getMicrosoftPackagesPath();
      const roots = [customPath, msPath].filter(Boolean) as string[];

      const resolver = new PackageResolver(roots);
      const resolved = await resolver.resolve(actualModelName);

      if (resolved) {
        resolvedPackageName = resolved.packageName;
        basePath = resolved.rootPath;
      } else {
        // Fallback: assume package == model (common case)
        resolvedPackageName = actualModelName;
        basePath = customPath || args.packagePath || configPackagePath || 'K:\\AosService\\PackagesLocalDirectory';
      }
    } else {
      // Traditional mode without explicit packageName: assume package == model
      resolvedPackageName = actualModelName;
      basePath =
        args.packagePath ||
        configPackagePath ||
        'K:\\AosService\\PackagesLocalDirectory';
    }

    console.error(
      `[create_d365fo_file] Environment: ${envType}, Package: ${resolvedPackageName}, Model: ${actualModelName}`,
    );

    const modelPath = path.join(
      basePath,
      resolvedPackageName,
      actualModelName,
      objectFolder,
    );
    const fileName = `${finalObjectName}.xml`;
    const fullPath = path.join(modelPath, fileName);

    // Security: prevent path traversal. path.join() resolves ".." segments,
    // so a crafted modelName/objectName could escape basePath entirely.
    // Resolve both paths and assert the target stays within basePath.
    const resolvedBase = path.resolve(basePath);
    const resolvedTarget = path.resolve(fullPath);
    if (!resolvedTarget.startsWith(resolvedBase + path.sep) && resolvedTarget !== resolvedBase) {
      throw new Error(
        `❌ Security error: resolved path "${resolvedTarget}" is outside base directory "${resolvedBase}".\n` +
        `Check modelName, packageName, objectName, and packagePath for path traversal sequences.`
      );
    }

    // Normalize path to Windows format (backslashes) for consistency
    const normalizedFullPath = fullPath.replace(/\//g, '\\');

    // Ensure directory exists (create if needed)
    const directory = path.dirname(normalizedFullPath);
    console.error(
      `[create_d365fo_file] Ensuring directory exists: ${directory}`
    );
    
    // Check if this looks like a Windows path on non-Windows system
    if (process.platform !== 'win32' && /^[A-Z]:\\/.test(normalizedFullPath)) {
      throw new Error(
        `❌ Cannot create D365FO file on non-Windows system!\n\n` +
        `Attempting to create: ${normalizedFullPath}\n` +
        `Running on: ${process.platform}\n\n` +
        `The create_d365fo_file tool requires:\n` +
        `1. Running on Windows (local D365FO VM)\n` +
        `2. Direct access to PackagesLocalDirectory (e.g. C:\\AosService\\PackagesLocalDirectory)\n\n` +
        `This tool CANNOT work through Azure MCP proxy (runs on Linux).\n\n` +
        `Solutions:\n` +
        `- Run MCP server locally on D365FO Windows VM\n` +
        `- Use VS 2022 with local MCP stdio transport\n` +
        `- DO NOT use Azure HTTP proxy for file creation\n`
      );
    }
    
    // Verify drive/root exists before attempting recursive mkdir
    // (Node.js gives a cryptic '\\?' error when the drive letter doesn't exist)
    const driveOrRoot = path.parse(directory).root; // e.g. "K:\" or "C:\"
    if (driveOrRoot) {
      try {
        await fs.access(driveOrRoot);
      } catch {
        throw new Error(
          `❌ Drive or root path does not exist: ${driveOrRoot}\n\n` +
          `Attempting to create: ${directory}\n\n` +
          `The packagePath in your .mcp.json points to a drive that is not accessible.\n` +
          `Update "packagePath" in .mcp.json to match your actual D365FO installation:\n\n` +
          `Common paths:\n` +
          `  C:\\AosService\\PackagesLocalDirectory\n` +
          `  K:\\AosService\\PackagesLocalDirectory\n` +
          `  J:\\AosService\\PackagesLocalDirectory\n\n` +
          `Current packagePath: ${basePath}\n` +
          `Current drive checked: ${driveOrRoot}`
        );
      }
    }

    try {
      await fs.mkdir(directory, { recursive: true });
      console.error(`[create_d365fo_file] Directory ready: ${directory}`);
    } catch (mkdirError) {
      console.error(
        `[create_d365fo_file] Failed to create directory:`,
        mkdirError
      );
      const hint =
        (mkdirError instanceof Error && mkdirError.message.includes('\\?'))
          ? `\n\nHint: The path "${directory}" could not be created. ` +
            `Verify the drive letter exists and the path is correct. ` +
            `Update "packagePath" in .mcp.json to fix this.`
          : '';
      throw new Error(
        `Failed to create directory ${directory}: ${mkdirError instanceof Error ? mkdirError.message : 'Unknown error'}${hint}`
      );
    }

    // Check if file already exists
    let fileExisted = false;
    try {
      await fs.access(normalizedFullPath);
      fileExisted = true;
    } catch {
      // File does not exist — normal creation path
    }

    if (fileExisted) {
      if (!args.overwrite) {
        return {
          content: [
            {
              type: 'text',
              text: `⚠️ File already exists: ${normalizedFullPath}\n\nOptions:\n` +
                `  1. Pass overwrite=true together with xmlContent to replace the file.\n` +
                `  2. Use modify_d365fo_file to make targeted changes (rename-field, replace-all-fields, modify-property, …).\n` +
                `  3. Choose a different objectName.`,
            },
          ],
        };
      }
    }

    // Generate (or use provided) XML content
    let xmlContent = args.xmlContent
      ? args.xmlContent
      : XmlTemplateGenerator.generate(
          args.objectType,
          finalObjectName,
          args.sourceCode,
          args.properties
        );

    // CRITICAL FIX: Replace unprefixed class/table names with prefixed finalObjectName
    // When xmlContent or sourceCode contains `class MyClass` but finalObjectName is `MyPrefixMyClass`,
    // the file would be named MyPrefixMyClass.xml but contain `class MyClass` — inconsistency!
    if (finalObjectName !== args.objectName && (args.xmlContent || args.sourceCode)) {
      // Pattern to match: `class OriginalName` or `public class OriginalName`
      const classPattern = new RegExp(
        `\\b(public\\s+|private\\s+|protected\\s+|internal\\s+|final\\s+)?class\\s+${args.objectName}\\b`,
        'g'
      );
      const replacedContent = xmlContent.replace(classPattern, (match) => {
        return match.replace(args.objectName, finalObjectName);
      });
      
      if (replacedContent !== xmlContent) {
        console.error(
          `[create_d365fo_file] ✅ Fixed class name inconsistency: ` +
          `replaced \`class ${args.objectName}\` with \`class ${finalObjectName}\` in XML content`
        );
        xmlContent = replacedContent;
      }
    }

    // Sanitize AxReport XML structure — ensures required D365FO VS Designer elements
    // are always present, regardless of whether xmlContent came from the template or a caller.
    if (args.objectType === 'report') {
      xmlContent = XmlTemplateGenerator.sanitizeReportXml(xmlContent);
      // Convert remaining <Text><![CDATA[…]]></Text> to entity-encoded form.
      // sanitizeReportXml operates on CDATA internally; this final step converts
      // the output so that D365FO VS Designer renders the design correctly.
      xmlContent = XmlTemplateGenerator.encodeReportTextElement(xmlContent);
    }

    // Sanitize menu item XML — D365FO metadata deserializer requires
    // xmlns="Microsoft.Dynamics.AX.Metadata.V1" on the root element.
    if (args.objectType === 'menu-item-display' ||
        args.objectType === 'menu-item-action' ||
        args.objectType === 'menu-item-output') {
      xmlContent = XmlTemplateGenerator.sanitizeMenuItemXml(xmlContent);
    }

    // Debug: Log XML content length
    const xmlSource = args.xmlContent ? 'provided by caller' : 'generated from template';
    console.error(
      `[create_d365fo_file] XML content (${xmlSource}): ${xmlContent.length} bytes`
    );
    console.error(
      `[create_d365fo_file] XML preview: ${xmlContent.substring(0, 200)}...`
    );

    // Write file with UTF-8 BOM (required for D365FO XML files)
    try {
      const utf8BOM = Buffer.from([0xEF, 0xBB, 0xBF]);
      const xmlBuffer = Buffer.concat([utf8BOM, Buffer.from(xmlContent, 'utf-8')]);
      await fs.writeFile(normalizedFullPath, xmlBuffer);
      console.error(
        `[create_d365fo_file] File written successfully with UTF-8 BOM: ${normalizedFullPath}`
      );
    } catch (writeError) {
      console.error(`[create_d365fo_file] Failed to write file:`, writeError);
      
      // Check if it's a disk/path issue
      const errorMessage = writeError instanceof Error ? writeError.message : String(writeError);
      if (errorMessage.includes('EINVAL') || errorMessage.includes('ENOENT')) {
        throw new Error(
          `Failed to write file to ${normalizedFullPath}.\n\n` +
          `Possible causes:\n` +
          `1. Drive K:\\ does not exist (running on Linux/Mac? Use packagePath parameter to override)\n` +
          `2. Directory ${path.dirname(normalizedFullPath)} is not accessible\n` +
          `3. Insufficient permissions\n\n` +
          `Original error: ${errorMessage}`
        );
      }
      throw writeError;
    }

    // Verify file was written
    const stats = await fs.stat(normalizedFullPath);
    console.error(
      `[create_d365fo_file] File written: ${normalizedFullPath}, size: ${stats.size} bytes`
    );

    // Add to Visual Studio project if requested
    let projectMessage = '';
    if (args.addToProject) {
      console.error(
        `[create_d365fo_file] addToProject requested, solutionPath: ${solutionPathToUse}, projectPath: ${projectPathToUse}`
      );

      // Try to find project file if not explicitly specified
      // Use projectPathToUse which includes values from .mcp.json config
      let projectPath = projectPathToUse;
      
      if (!projectPath && solutionPathToUse) {
        // Try to find project in solution directory
        // Use solutionPathToUse which includes values from .mcp.json config
        console.error(
          `[create_d365fo_file] Searching for .rnrproj in solution: ${solutionPathToUse}, model: ${actualModelName}`
        );
        const detectedPath = await ProjectFileFinder.findProjectInSolution(
          solutionPathToUse,
          actualModelName
        );

        if (!detectedPath) {
          console.error(
            `[create_d365fo_file] No .rnrproj found in solution directory`
          );
          projectMessage = `\n⚠️ Could not find .rnrproj file for model '${actualModelName}' in solution directory.\n` +
            `Searched in: ${solutionPathToUse}\n` +
            `Please specify projectPath parameter explicitly or add it to .mcp.json.\n`;
        } else {
          console.error(
            `[create_d365fo_file] Found project file: ${detectedPath}`
          );
          projectPath = detectedPath;
        }
      } else if (!projectPath) {
        projectMessage = `\n⚠️ Cannot add to project: projectPath could not be resolved.\n` +
          `Add projectPath to .mcp.json config, or pass it as a tool argument.\n` +
          `Example .mcp.json: { "servers": { "context": { "projectPath": "K:\\\\VSProjects\\\\MySolution\\\\MyModel\\\\MyModel.rnrproj" } } }\n`;
      }

      if (projectPath) {
        try {
          console.error(
            `[create_d365fo_file] Adding to project: ${projectPath}`
          );
          // Validate project file exists
          await fs.access(projectPath);

          // D365FO projects expect ABSOLUTE paths to XML files, not relative
          // The full path must point to the exact XML location in PackagesLocalDirectory
          // Ensure Windows path format with backslashes
          const absoluteXmlPath = normalizedFullPath;

          console.error(
            `[create_d365fo_file] Absolute XML path: ${absoluteXmlPath}`
          );

          // Add to project
          const projectManager = new ProjectFileManager();
          const wasAdded = await projectManager.addToProject(
            projectPath,
            args.objectType,
            finalObjectName,
            absoluteXmlPath
          );

          if (wasAdded) {
            console.error(`[create_d365fo_file] Successfully added to project`);
            projectMessage = `\n✅ Successfully added to Visual Studio project:\n📋 Project: ${projectPath}\n` +
              `ℹ️  If the file does not appear in VS Solution Explorer, right-click the project → Reload Project.`;
          } else {
            console.error(`[create_d365fo_file] File already exists in project`);
            projectMessage = `\n✅ File already exists in Visual Studio project:\n📋 Project: ${projectPath}\n`;
          }
        } catch (projectError) {
          const errMsg = projectError instanceof Error ? projectError.message : 'Unknown error';
          const isLocked = errMsg.includes('EBUSY') || errMsg.includes('EPERM') || errMsg.includes('EACCES');
          console.error(
            `[create_d365fo_file] Failed to add to project:`,
            projectError
          );
          projectMessage = `\n⚠️ File created but failed to add to project:\n${errMsg}\n` +
            (isLocked
              ? `This usually means Visual Studio has the .rnrproj file locked.\n` +
                `Close Visual Studio (or unload the project), re-run the tool, then reopen.\n`
              : '');
        }
      } else if (!projectMessage) {
        // No projectPath found from any source — surface this in the response so AI and user see it
        projectMessage = `\n⚠️ addToProject=true but no projectPath could be resolved.\n` +
          `The file was created on disk but was NOT added to the Visual Studio project.\n\n` +
          `To fix this, add projectPath to your .mcp.json:\n` +
          `  {\n` +
          `    "servers": { "context": {\n` +
          `      "projectPath": "K:\\\\VSProjects\\\\YourSolution\\\\YourModel\\\\YourModel.rnrproj"\n` +
          `    } }\n` +
          `  }\n` +
          `Until then, add the file manually in Visual Studio: right-click project → Add Existing Item → ${normalizedFullPath}\n`;
      }
    }

    // Build success message
    const nextSteps = args.addToProject
      ? `Next steps:\n` +
        `1. Reload project in Visual Studio (or close/reopen solution)\n` +
        `2. Build the project to synchronize the object\n` +
        `3. Refresh AOT in Visual Studio to see the new object\n`
      : `Next steps:\n` +
        `1. Add the file to your Visual Studio project (.rnrproj)\n` +
        `2. Build the project to synchronize the object\n` +
        `3. Refresh AOT in Visual Studio to see the new object\n`;

    // Return success message with file path
    return {
      content: [
        {
          type: 'text',
          text: `✅ Successfully created D365FO ${args.objectType} file:\n\n` +
            `📁 Path: ${normalizedFullPath}\n` +
            `📄 Object: ${finalObjectName}${finalObjectName !== args.objectName ? ` (prefixed from "${args.objectName}")` : ''}\n` +
            `📦 Model: ${actualModelName}\n` +
            `🔧 Type: ${objectFolder}\n` +
            projectMessage +
            `\n${nextSteps}\n` +
            `⛔ TASK COMPLETE — do NOT call \`generate_smart_table\`, \`generate_smart_form\`, or \`create_d365fo_file\` again for this object.`,
        },
      ],
    };
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `❌ Error creating D365FO file:\n\n${error instanceof Error ? error.message : 'Unknown error'}`,
        },
      ],
    };
  }
}

export const createD365FileToolDefinition = {
  name: 'create_d365fo_file',
  description:
    'Creates a physical D365FO XML file in the correct AOT package structure. ' +
    'This tool generates the complete XML metadata file for classes, tables, enums, forms, etc. ' +
    'and saves it to the proper location in PackagesLocalDirectory. ' +
    'Use this instead of creating files in the project folder directly.',
  inputSchema: CreateD365FileArgsSchema,
};