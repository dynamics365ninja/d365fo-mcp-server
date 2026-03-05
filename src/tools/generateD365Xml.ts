/**
 * D365FO XML Generator Tool
 * Generates D365FO XML content for classes, tables, enums, etc.
 * Returns XML as text - user/Copilot creates the physical file
 * Works remotely through Azure (no file system access needed)
 */

import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { getConfigManager } from '../utils/configManager.js';
import { ensureXppDocComment } from '../utils/xppDocGen.js';
import { decodeXmlEntitiesFromXppSource } from './modifyD365File.js';

const GenerateD365XmlArgsSchema = z.object({
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
    .describe('Type of D365FO object'),
  objectName: z
    .string()
    .describe('Name of the object (e.g., MyHelperClass, MyCustomTable)'),
  modelName: z
    .string()
    .optional()
    .describe('Model name (e.g., ContosoExtensions). Auto-detected from mcp.json if omitted.'),
  sourceCode: z
    .string()
    .optional()
    .describe('X++ source code for the object (class declaration, methods, etc.)'),
  properties: z
    .record(z.string(), z.any())
    .optional()
    .describe('Additional properties for the object (extends, implements, label, etc.)'),
});

/**
 * XML Template Generator for D365FO Objects
 */
class XmlTemplateGenerator {

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
    if (!rest.trim()) {
      const innerResult = XmlTemplateGenerator.extractInnerClassMethods(declaration);
      if (innerResult) {
        return innerResult;
      }
      return { declaration, methods: [] };
    }

    // ── FIX: Rescue member-variable declarations that appear OUTSIDE the class {}
    const nextBraceInRest = rest.indexOf('{');
    if (nextBraceInRest !== -1) {
      const preMethodText = rest.substring(0, nextBraceInRest);
      const varLines = preMethodText
        .split('\n')
        .filter(l => { const t = l.trim(); return t.endsWith(';') && !t.includes('('); });
      if (varLines.length > 0) {
        const injected = varLines.map(l => '    ' + l.trim()).join('\n');
        declaration = declaration.replace(/}(\s*)$/, `\n${injected}\n}`);
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

    // ── Fallback: methods inside class {} ─────────────────────────────────────
    // See the same comment in createD365File.ts for the full rationale.
    // When methods are inside the class body, extract them so they become proper
    // <Method> elements separated by blank lines via .join('\n\n').
    if (methods.length === 0) {
      const innerResult = XmlTemplateGenerator.extractInnerClassMethods(declaration);
      if (innerResult) {
        return innerResult;
      }
    }

    return { declaration, methods };
  }

  /**
   * Extract methods defined INSIDE the class body (depth-1 inside {}).
   * Mirror of the same method in createD365File.ts — kept in sync manually.
   * See createD365File.ts for the full documentation.
   */
  static extractInnerClassMethods(classDeclaration: string): {
    declaration: string;
    methods: Array<{ name: string; source: string }>;
  } | null {
    const classOpenIdx = classDeclaration.indexOf('{');
    const classCloseIdx = classDeclaration.lastIndexOf('}');
    if (classOpenIdx === -1 || classCloseIdx <= classOpenIdx) return null;

    const classBody = classDeclaration.substring(classOpenIdx + 1, classCloseIdx);
    const methods: Array<{ name: string; source: string }> = [];
    const memberVarLines: string[] = [];

    let pos = 0;
    while (pos < classBody.length) {
      const nextBrace = classBody.indexOf('{', pos);
      if (nextBrace === -1) {
        for (const line of classBody.substring(pos).split('\n')) {
          const t = line.trim();
          if (t.length > 0 && t.endsWith(';') && !t.includes('(') &&
              !t.startsWith('//') && !t.startsWith('*')) {
            memberVarLines.push(t);
          }
        }
        break;
      }

      const sigText = classBody.substring(pos, nextBrace);

      let depth = 0;
      let bodyEnd = -1;
      for (let i = nextBrace; i < classBody.length; i++) {
        if (classBody[i] === '{') depth++;
        else if (classBody[i] === '}') {
          depth--;
          if (depth === 0) { bodyEnd = i; break; }
        }
      }
      if (bodyEnd === -1) break;

      const parenIdx = sigText.lastIndexOf('(');
      if (parenIdx !== -1) {
        for (const line of sigText.split('\n')) {
          const t = line.trim();
          if (t.length > 0 && t.endsWith(';') && !t.includes('(') &&
              !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('[')) {
            memberVarLines.push(t);
          }
        }

        const beforeLastParen = sigText.substring(0, parenIdx);
        const lastNewlineBeforeLastParen = beforeLastParen.lastIndexOf('\n');
        let methodStartInSig = lastNewlineBeforeLastParen !== -1
          ? lastNewlineBeforeLastParen + 1
          : 0;

        const sigBeforeMethod = sigText.substring(0, methodStartInSig);
        const sigBeforeLines = sigBeforeMethod.split('\n').reverse();
        let droppedChars = 0;
        for (const line of sigBeforeLines) {
          const t = line.trim();
          if (t.length === 0 || t.startsWith('[') || t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) {
            droppedChars += line.length + 1;
          } else {
            break;
          }
        }
        methodStartInSig = Math.max(0, methodStartInSig - droppedChars);

        const methodSource = classBody
          .substring(pos + methodStartInSig, bodyEnd + 1)
          .trim();

        const nameMatch = sigText.substring(0, parenIdx).match(/(\w+)\s*$/);
        const methodName = nameMatch ? nameMatch[1] : `method${methods.length + 1}`;
        methods.push({ name: methodName, source: methodSource });
      } else {
        for (const line of sigText.split('\n')) {
          const t = line.trim();
          if (t.length > 0 && t.endsWith(';') && !t.includes('(') &&
              !t.startsWith('//') && !t.startsWith('*')) {
            memberVarLines.push(t);
          }
        }
      }
      pos = bodyEnd + 1;
    }

    if (methods.length === 0) return null;

    const classHeader = classDeclaration.substring(0, classOpenIdx + 1);
    const memberVarsXpp = memberVarLines.length > 0
      ? '\n' + memberVarLines.map(v => '    ' + v).join('\n') + '\n'
      : '\n';

    return {
      declaration: classHeader + memberVarsXpp + '}',
      methods,
    };
  }

  /**
   * Generate AxClass XML structure
   */
  static generateAxClassXml(
    className: string,
    sourceCode?: string,
    properties?: Record<string, any>
  ): string {
    // Decode XML entities that AI models may introduce when copying from SSRS report
    // entity-encoded <Text> blocks (e.g. &lt;summary&gt; → <summary>).
    const rawSource = decodeXmlEntitiesFromXppSource(sourceCode || `public class ${className}\n{\n}`);

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
    const indentMethodSource = (src: string): string =>
      src.split('\n').map(line => '    ' + line).join('\n');

    const methodsXml =
      methods.length === 0
        ? '\t\t<Methods />\n'
        : `\t\t<Methods>\n${methods
            .map(
              m =>
                `\t\t\t<Method>\n\t\t\t\t<Name>${m.name}</Name>\n\t\t\t\t<Source><![CDATA[\n${indentMethodSource(ensureXppDocComment(m.source))}\n\n]]></Source>\n\t\t\t</Method>`
            )
            .join('\n\n')}\n\t\t</Methods>\n`;

    return `<?xml version="1.0" encoding="utf-8"?>
<AxClass xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
\t<Name>${className}</Name>
${extendsAttr}${implementsAttr}${isFinalAttr}${isAbstractAttr}\t<SourceCode>
\t\t<Declaration><![CDATA[
${ensureXppDocComment(declaration)}
]]></Declaration>
${methodsXml}\t</SourceCode>
</AxClass>
`;
  }

  /**
   * Generate AxTable XML structure
   */
  static generateAxTableXml(
    tableName: string,
    properties?: Record<string, any>
  ): string {
    const label = properties?.label || tableName;
    const tableGroup = properties?.tableGroup || 'Main';
    const titleField1 = properties?.titleField1 || '';
    const titleField2 = properties?.titleField2 || '';

    const titleField1Xml = titleField1
      ? `\t<TitleField1>${titleField1}</TitleField1>\n`
      : '';
    const titleField2Xml = titleField2
      ? `\t<TitleField2>${titleField2}</TitleField2>\n`
      : '';

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
\t<Label>${label}</Label>
\t<TableGroup>${tableGroup}</TableGroup>
${titleField1Xml}${titleField2Xml}\t<DeleteActions />
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
\t<Fields />
\t<Indexes />
\t<Relations />
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
    const isExtensible = properties?.isExtensible ? 'Yes' : 'No';

    return `<?xml version="1.0" encoding="utf-8"?>
<AxEnum xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
\t<Name>${enumName}</Name>
\t<Label>${label}</Label>
\t<IsExtensible>${isExtensible}</IsExtensible>
\t<EnumValues />
</AxEnum>
`;
  }

  /**
   * Generate AxForm XML structure
   */
  static generateAxFormXml(
    formName: string,
    _properties?: Record<string, any>
  ): string {
    // D365FO forms require xmlns="Microsoft.Dynamics.AX.Metadata.V6" and SourceCode first
    // NOTE: <Label> is intentionally absent — AxForm files do not carry a top-level <Label>.
    return `<?xml version="1.0" encoding="utf-8"?>
<AxForm xmlns:i="http://www.w3.org/2001/XMLSchema-instance" xmlns="Microsoft.Dynamics.AX.Metadata.V6">
\t<Name>${formName}</Name>
\t<SourceCode>
\t\t<Methods xmlns="">
\t\t\t<Method>
\t\t\t\t<Name>classDeclaration</Name>
\t\t\t\t<Source><!\[CDATA[
    [Form]
    public class ${formName} extends FormRun
    {
    }

]]></Source>
\t\t\t</Method>
\t\t</Methods>
\t\t<DataSources xmlns="" />
\t\t<DataControls xmlns="" />
\t\t<Members xmlns="" />
\t</SourceCode>
\t<DataSources />
\t<Design>
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
    const label = properties?.label || queryName;

    return `<?xml version="1.0" encoding="utf-8"?>
<AxQuery xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
\t<Name>${queryName}</Name>
\t<Label>${label}</Label>
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
\t<ViewMetadata />
\t<Fields />
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

    return `<?xml version="1.0" encoding="utf-8"?>
<AxDataEntityView xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
\t<Name>${entityName}</Name>
\t<Label>${label}</Label>
\t<PublicEntityName>${publicEntityName}</PublicEntityName>
\t<DataSources />
\t<Fields />
\t<Keys />
\t<Mappings />
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
   *   datasets      - Array of { name, dpClassName, tmpTableName, fields?, aotQuery?, contractParams? } for multi-dataset reports
   *   contractParams - Array of { name, dataType?, label?, defaultValue? } → contract class parameters (DataMember)
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
      contractParams?: Array<{ name: string; dataType?: string; label?: string; defaultValue?: string }>;
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
        contractParams: properties?.contractParams as Array<{ name: string; dataType?: string; label?: string; defaultValue?: string }> | undefined,
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

    // ── UUID helper — use Node.js crypto for guaranteed RFC-4122 v4 format ──
    const uuid = (): string => crypto.randomUUID();

    // ── Build one AxReportDataSet XML entry ──
    const buildDatasetXml = (ds: DatasetDef): string => {
      const dpParamName = `${ds.dpClassName.toUpperCase()}_DynamicParameter`;
      const contractDatasetParamsXml = (ds.contractParams || []).map(cp => {
        const pn = `${ds.name}_ds_${cp.name}`;
        const dt = cp.dataType || 'System.String';
        return `\t\t\t\t<AxReportDataSetParameter>\n\t\t\t\t\t<Name>${pn}</Name>\n\t\t\t\t\t<Alias>${pn}</Alias>\n\t\t\t\t\t<DataType>${dt}</DataType>\n\t\t\t\t\t<Parameter>${pn}</Parameter>\n\t\t\t\t</AxReportDataSetParameter>`;
      }).join('\n');
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
${contractDatasetParamsXml ? contractDatasetParamsXml + '\n' : ''}\t\t\t\t<AxReportDataSetParameter>
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

    // Contract parameters (from DataContract class with [DataMember] attributes)
    const contractParamsXml = (firstDs.contractParams || []).map(cp => {
      const dataTypeLine = cp.dataType ? `\n\t\t\t\t<DataType>${cp.dataType}</DataType>` : '';
      const promptLine = cp.label ? `\n\t\t\t\t<PromptString>${cp.label}</PromptString>` : '';
      return `\t\t\t<AxReportParameterBase xmlns=""
\t\t\t\t\ti:type="AxReportParameter">
\t\t\t\t<Name>${firstDs.name}_ds_${cp.name}</Name>${dataTypeLine}${promptLine}
\t\t\t\t<DefaultValue />
\t\t\t\t<Values />
\t\t\t</AxReportParameterBase>`;
    }).join('\n');

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
${contractParamsXml}${contractParamsXml ? '\n' : ''}\t\t\t<AxReportParameterBase xmlns=""
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

      const buildRdlDataset = (ds: DatasetDef): string => {
        const dsDpParam   = `${ds.dpClassName.toUpperCase()}_DynamicParameter`;
        const contractParamNamesRdl = (ds.contractParams || []).map(cp => `${ds.name}_ds_${cp.name}`);
        const paramNames  = [
          'AX_PartitionKey', 'AX_CompanyName', 'AX_UserContext',
          'AX_RenderingCulture', 'AX_ReportContext', 'AX_RdpPreProcessedId',
          ...contractParamNamesRdl,
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
      <rd:DataSetID>${uuid()}</rd:DataSetID>
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

      // ── Build a simple detail tablix for each dataset so the design is not empty ──
      const buildRdlTablix = (ds: DatasetDef): string => {
        if (!ds.fields || ds.fields.length === 0) return '';
        const n      = ds.fields.length;
        const colW   = +Math.min(1.5, 7 / n).toFixed(2);
        const totalW = +(colW * n).toFixed(2);
        const grp    = `Details_${ds.name}`;
        const cols   = ds.fields.map(() =>
          `            <TablixColumn><Width>${colW}in</Width></TablixColumn>`).join('\n');
        const hCells = ds.fields.map(f => [
          `            <TablixCell><CellContents>`,
          `              <Textbox Name="Textbox_${f.name}_H">`,
          `                <CanGrow>true</CanGrow><Value>${f.name}</Value>`,
          `                <Style><FontWeight>Bold</FontWeight>`,
          `                  <BackgroundColor>LightGrey</BackgroundColor>`,
          `                  <Border><Style>Solid</Style></Border>`,
          `                  <PaddingLeft>2pt</PaddingLeft><PaddingRight>2pt</PaddingRight>`,
          `                  <PaddingTop>2pt</PaddingTop><PaddingBottom>2pt</PaddingBottom>`,
          `                </Style></Textbox>`,
          `            </CellContents></TablixCell>`,
        ].join('\n')).join('\n');
        const dCells = ds.fields.map(f => [
          `            <TablixCell><CellContents>`,
          `              <Textbox Name="Textbox_${f.name}">`,
          `                <CanGrow>true</CanGrow><Value>=Fields!${f.name}.Value</Value>`,
          `                <Style><Border><Style>Solid</Style></Border>`,
          `                  <PaddingLeft>2pt</PaddingLeft><PaddingRight>2pt</PaddingRight>`,
          `                  <PaddingTop>2pt</PaddingTop><PaddingBottom>2pt</PaddingBottom>`,
          `                </Style></Textbox>`,
          `            </CellContents></TablixCell>`,
        ].join('\n')).join('\n');
        const cMembers = ds.fields.map(() => `          <TablixMember />`).join('\n');
        return [
          `        <Tablix Name="Tablix_${ds.name}">`,
          `          <TablixBody>`,
          `            <TablixColumns>`,
          cols,
          `            </TablixColumns>`,
          `            <TablixRows>`,
          `              <TablixRow><Height>0.25in</Height><TablixCells>`,
          hCells,
          `              </TablixCells></TablixRow>`,
          `              <TablixRow><Height>0.25in</Height><TablixCells>`,
          dCells,
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
          `            <TablixMember><Group Name="${grp}"><DataGroupName>${grp}</DataGroupName></Group></TablixMember>`,
          `          </TablixMembers></TablixRowHierarchy>`,
          `          <DataSetName>${ds.name}</DataSetName>`,
          `          <Top>0.5in</Top><Left>0.5in</Left>`,
          `          <Height>0.5in</Height><Width>${totalW}in</Width>`,
          `          <Style><Border><Style>Solid</Style></Border></Style>`,
          `        </Tablix>`,
        ].join('\n');
      };
      const rdlBodyItemsXml = datasets.map(buildRdlTablix).filter(Boolean).join('\n');
      const rdlBodyTag = rdlBodyItemsXml
        ? `        <ReportItems>\n${rdlBodyItemsXml}\n        </ReportItems>`
        : `        <ReportItems />`;

      const contractRdlParams = (firstDs.contractParams || []).map(cp => ({
        name: `${firstDs.name}_ds_${cp.name}`,
        nullable: true, blank: true, usedInQuery: true,
      }));
      const rdlParamDefs = [
        { name: 'AX_PartitionKey',      nullable: true,  blank: true,  usedInQuery: false },
        { name: 'AX_CompanyName',        nullable: false, blank: false, usedInQuery: false },
        { name: 'AX_UserContext',        nullable: true,  blank: true,  usedInQuery: false },
        { name: 'AX_RenderingCulture',   nullable: true,  blank: true,  usedInQuery: false },
        { name: 'AX_ReportContext',       nullable: true,  blank: true,  usedInQuery: true  },
        { name: 'AX_RdpPreProcessedId',  nullable: true,  blank: true,  usedInQuery: false },
        { name: dpParamName,             nullable: true,  blank: true,  usedInQuery: false },
        ...contractRdlParams,
      ];
      const rdlParamsXml = `  <ReportParameters>\n` +
        rdlParamDefs.map(p => {
          const nullLine  = p.nullable     ? `\n      <Nullable>true</Nullable>`        : '';
          const blankLine = p.blank        ? `\n      <AllowBlank>true</AllowBlank>`    : '';
          const usedLine  = p.usedInQuery  ? `\n      <UsedInQuery>true</UsedInQuery>` : '';
          return `    <ReportParameter Name="${p.name}">\n      <DataType>String</DataType>${nullLine}${blankLine}\n      <Prompt>${p.name}</Prompt>\n      <Hidden>true</Hidden>${usedLine}\n    </ReportParameter>`;
        }).join('\n') + `\n  </ReportParameters>`;

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
${rdlBodyTag}
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
    // Sanitize: fix old-schema <Header> inside <TablixMember> — renamed to <TablixHeader> in 2016 RDL.
    // This handles AI-generated or older-tool-generated RDL that still uses the pre-2016 element name.
    const rdl = (rdlContent || buildRdlSkeleton())
      .replace(/<Header>/g, '<TablixHeader>')
      .replace(/<\/Header>/g, '</TablixHeader>');
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
   * Main generate method
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
      case 'table':
        return this.generateAxTableXml(objectName, properties);
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

  static generateAxSimpleExtensionXml(rootElement: string, name: string): string {
    return `<?xml version="1.0" encoding="utf-8"?>
<${rootElement} xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
\t<Name>${name}</Name>
\t<PropertyModifications />
</${rootElement}>`;
  }

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

  static generateAxMenuItemXml(
    itemType: string,
    name: string,
    properties?: Record<string, any>
  ): string {
    const elemName = itemType === 'menu-item-action' ? 'AxMenuItemAction'
      : itemType === 'menu-item-output' ? 'AxMenuItemOutput'
      : 'AxMenuItemDisplay';
    const targetObject = properties?.targetObject || properties?.object || name;
    const label = properties?.label || '@TODO:LabelId';

    // Determine ObjectType based on item type and explicit properties.
    // D365FO serializer rules (confirmed from real XML files):
    //   - AxMenuItemAction:  ObjectType is always "Class"; must be present.
    //   - AxMenuItemDisplay: ObjectType is OMITTED when targeting a Form (default);
    //                        use "Class" only when explicitly set.
    //   - AxMenuItemOutput:  ObjectType is "Class" (controller) or "SSRSReport";
    //                        "Report" is NOT a valid value — real files use "SSRSReport".
    const explicitObjType: string | undefined = properties?.objectType || properties?.targetType;
    let objType: string | undefined;
    if (itemType === 'menu-item-action') {
      objType = explicitObjType || 'Class';
    } else if (itemType === 'menu-item-output') {
      if (explicitObjType === 'Report') {
        objType = 'SSRSReport';
      } else {
        objType = explicitObjType || 'Class';
      }
    } else {
      // Display: omit ObjectType when targeting a Form (implicit default)
      if (explicitObjType && explicitObjType !== 'Form') {
        objType = explicitObjType;
      }
    }

    const objectTypeXml = objType ? `\n\t<ObjectType>${objType}</ObjectType>` : '';
    return `<?xml version="1.0" encoding="utf-8"?>
<${elemName} xmlns:i="http://www.w3.org/2001/XMLSchema-instance" xmlns="Microsoft.Dynamics.AX.Metadata.V1">
\t<Name>${name}</Name>
\t<Label>${label}</Label>
\t<Object>${targetObject}</Object>${objectTypeXml}
</${elemName}>`;
  }

  static generateAxMenuXml(name: string, properties?: Record<string, any>): string {
    const label = properties?.label || '@TODO:LabelId';
    return `<?xml version="1.0" encoding="utf-8"?>
<AxMenu xmlns:i="http://www.w3.org/2001/XMLSchema-instance" xmlns="Microsoft.Dynamics.AX.Metadata.V1">
\t<Name>${name}</Name>
\t<Label>${label}</Label>
\t<Elements />
</AxMenu>`;
  }

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

  static generateAxSecurityDutyXml(name: string, properties?: Record<string, any>): string {
    const label = properties?.label || '@TODO:LabelId';
    return `<?xml version="1.0" encoding="utf-8"?>
<AxSecurityDuty xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
\t<Name>${name}</Name>
\t<Label>${label}</Label>
\t<Privileges />
</AxSecurityDuty>`;
  }

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
}

/**
 * Generate D365FO XML handler function
 */
export async function handleGenerateD365Xml(
  request: CallToolRequest
): Promise<{ content: Array<{ type: string; text: string }> }> {
  const args = GenerateD365XmlArgsSchema.parse(request.params.arguments);

  try {
    // Resolve model name: arg → mcp.json modelName → workspacePath segment
    const configManager = getConfigManager();
    const modelName = args.modelName || configManager.getModelName();
    if (!modelName) {
      const errorMsg =
        '❌ ERROR: modelName could not be resolved.\n\n' +
        'Provide it in one of these ways:\n' +
        '  1. Pass modelName explicitly in the tool call arguments\n' +
        '  2. Add modelName to .mcp.json context: { "context": { "modelName": "YourModel" } }\n' +
        '  3. Add workspacePath ending with the package/model name: { "context": { "workspacePath": "K:\\\\...\\\\YourModel" } }';
      return { content: [{ type: 'text', text: errorMsg }] };
    }

    console.error(
      `[generate_d365fo_xml] Generating XML for ${args.objectType}: ${args.objectName}, model: ${modelName}`
    );

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

    // Generate XML content
    let xmlContent = XmlTemplateGenerator.generate(
      args.objectType,
      args.objectName,
      args.sourceCode,
      args.properties
    );

    // For reports: convert any remaining CDATA <Text> to entity-encoded form.
    // The generator now emits entity-encoded directly, but guard against xmlContent
    // passed in pre-generated form with CDATA.
    if (args.objectType === 'report') {
      xmlContent = xmlContent.replace(
        /<Text><!\[CDATA\[([\s\S]*?)\]\]><\/Text>/g,
        (_m, inner: string) =>
          `<Text>${inner.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</Text>`
      );
    }

    console.error(
      `[generate_d365fo_xml] Generated XML content: ${xmlContent.length} bytes`
    );

    // Construct recommended file path
    const recommendedPath = `K:\\AosService\\PackagesLocalDirectory\\${modelName}\\${modelName}\\${objectFolder}\\${args.objectName}.xml`;

    // Return XML content with instructions
    const instructions = `✅ Generated D365FO ${args.objectType} XML for: ${args.objectName}

📋 Model: ${modelName}
📁 Recommended path: ${recommendedPath}

⚠️ CRITICAL NEXT STEPS (GitHub Copilot MUST do this):

1. **Create the file** using create_file tool:
   - Path: ${recommendedPath}
   - Content: Use the XML content below (between xml markers)
   - ⚠️ IMPORTANT: D365FO requires UTF-8 with BOM encoding!
   - VS Code create_file uses UTF-8 without BOM by default, which may cause "unicode substitution character" errors

2. **If you see encoding errors**, manually add UTF-8 BOM:
   - Open file in hex editor
   - Ensure first 3 bytes are: EF BB BF (UTF-8 BOM)
   - Or use create_d365fo_file tool instead (if MCP server runs on local Windows)

3. **Add to Visual Studio project** (.rnrproj):
   <Content Include="${recommendedPath.replace(/\\/g, '\\\\')}" />
   
4. **Build the project** to synchronize with AOT

---

📄 XML Content (copy exactly, do not modify):

\`\`\`xml
${xmlContent}
\`\`\`

---

💡 **Alternative:** If MCP server runs on local Windows, use \`create_d365fo_file\` tool instead - it handles UTF-8 BOM automatically and adds to VS project.`;

    return {
      content: [
        {
          type: 'text',
          text: instructions,
        },
      ],
    };
  } catch (error) {
    console.error(`[generate_d365fo_xml] Error:`, error);
    return {
      content: [
        {
          type: 'text',
          text: `❌ Error generating D365FO XML:\n\n${error instanceof Error ? error.message : 'Unknown error'}`,
        },
      ],
    };
  }
}
