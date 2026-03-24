/**
 * Get Report Info Tool
 * Reads an AxReport and returns structured information:
 * datasets (fields, query), designs (RDL summary or full RDL), data methods.
 *
 * PRIMARY: C# bridge (IMetadataProvider) — 100% reliable, always available on VM.
 * FALLBACK: explicit XML file path for newly-created reports not yet in bridge.
 *
 * Eliminates the need for Copilot to run PowerShell Get-Content on report XML files.
 */

import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { XppServerContext } from '../types/context.js';
import { promises as fs } from 'fs';
import { parseStringPromise } from 'xml2js';
import { tryBridgeReport } from '../bridge/bridgeAdapter.js';

const GetReportInfoArgsSchema = z.object({
  reportName: z.string().describe('Name of the AxReport object (without .xml extension)'),
  modelName: z.string().optional().describe('Model name — auto-detected from .mcp.json if not provided'),
  filePath: z.string().optional().describe(
    'Absolute path to the AxReport XML file on disk. ' +
    'Use this for newly-created reports not yet in bridge metadata.'
  ),
  includeFields: z.boolean().optional().default(true).describe('Include AxReportDataSetField entries per dataset'),
  includeRdl: z.boolean().optional().default(false).describe('Include full embedded RDL content inside <Text><![CDATA[…]]> — can be large, default false'),
});

// ─── Internal types ────────────────────────────────────────────────────────────

interface ReportField {
  name: string;
  alias: string;
  dataType?: string;
  caption?: string;
}

interface ReportDataSet {
  name: string;
  dataSourceType: string;
  query: string;
  fields: ReportField[];
  fieldGroups: string[];
}

interface ReportDesign {
  name: string;
  caption?: string;
  dataSet?: string;
  style?: string;
  hasRdl: boolean;
  rdlContent?: string;
  rdlSummary?: string; // top-level RDL element names + counts
}

interface ReportInfo {
  name: string;
  model: string;
  filePath: string;
  hasDataMethods: boolean;
  embeddedImageCount: number;
  dataSets: ReportDataSet[];
  designs: ReportDesign[];
}

// ─── Main handler ──────────────────────────────────────────────────────────────

export async function getReportInfoTool(request: CallToolRequest, context: XppServerContext) {
  try {
    const args = GetReportInfoArgsSchema.parse(request.params.arguments);
    const { reportName, filePath: explicitFilePath, includeFields, includeRdl } = args;

    console.error(`[reportInfo] Looking up report "${reportName}"...`);

    // 1. C# bridge (IMetadataProvider — live D365FO metadata, always available)
    const bridgeResult = await tryBridgeReport(context.bridge, reportName);
    if (bridgeResult) return bridgeResult;

    // 2. Explicit file path fallback for newly-created reports
    if (explicitFilePath) {
      let xmlContent: string | null = null;
      try {
        const raw = await fs.readFile(explicitFilePath, 'utf-8');
        const trimmed = raw.trimStart();
        if (trimmed.startsWith('{')) {
          const meta = JSON.parse(raw);
          if (meta.sourcePath) {
            try { xmlContent = await fs.readFile(meta.sourcePath, 'utf-8'); } catch { /* not accessible */ }
          }
        } else {
          xmlContent = raw;
        }
      } catch { /* file not readable */ }

      if (!xmlContent) {
        return {
          content: [{
            type: 'text',
            text: `❌ File at \`${explicitFilePath}\` could not be read.`,
          }],
          isError: true,
        };
      }

      // Parse XML from explicit path
      const xmlObj = await parseStringPromise(xmlContent, { explicitArray: true, mergeAttrs: false, trim: true });
      const axReport = xmlObj?.AxReport;
      if (!axReport) {
        return { content: [{ type: 'text', text: `❌ File does not contain a valid <AxReport> root element.` }], isError: true };
      }

      const info: ReportInfo = {
        name:                first(axReport.Name) ?? reportName,
        model:               'Unknown',
        filePath:            explicitFilePath,
        hasDataMethods:      !!axReport.DataMethods && axReport.DataMethods[0] !== '',
        embeddedImageCount:  countItems(axReport.EmbeddedImages?.[0], 'AxReportEmbeddedImage'),
        dataSets:            extractDataSets(axReport, includeFields ?? true),
        designs:             extractDesigns(axReport, includeRdl ?? false),
      };

      return formatOutput(info, includeFields ?? true, includeRdl ?? false);
    }

    return {
      content: [{
        type: 'text',
        text: `❌ Report "${reportName}" not found via bridge.\n\n` +
          `If this is a newly-created report, pass the explicit \`filePath\` parameter:\n` +
          `  get_report_info(reportName="${reportName}", filePath="<absolute path to .xml>")`,
      }],
      isError: true,
    };
  } catch (error) {
    return {
      content: [{
        type: 'text',
        text: `❌ Error reading report info: ${error instanceof Error ? error.message : String(error)}`,
      }],
      isError: true,
    };
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

function first(arr: any): string | undefined {
  if (!arr) return undefined;
  if (Array.isArray(arr)) return arr[0] ?? undefined;
  return arr ?? undefined;
}

function countItems(node: any, key: string): number {
  if (!node) return 0;
  return Array.isArray(node[key]) ? node[key].length : 0;
}

function extractDataSets(axReport: any, includeFields: boolean): ReportDataSet[] {
  const result: ReportDataSet[] = [];
  const dataSetsNode = axReport.DataSets?.[0];
  if (!dataSetsNode) return result;

  // DataSets node may use 'AxReportDataSet' (correct) or 'AxReportDataSource' (legacy/wrong)
  const dsArray: any[] = dataSetsNode.AxReportDataSet ?? dataSetsNode.AxReportDataSource ?? [];
  for (const ds of dsArray) {
    const fields: ReportField[] = [];
    if (includeFields) {
      const fieldsNode = ds.Fields?.[0];
      if (fieldsNode && typeof fieldsNode === 'object') {
        const fieldArray: any[] = fieldsNode.AxReportDataSetField ?? [];
        for (const f of fieldArray) {
          fields.push({
            name:     first(f.Name)     ?? '',
            alias:    first(f.Alias)    ?? '',
            dataType: first(f.DataType) ?? undefined,
            caption:  first(f.Caption)  ?? undefined,
          });
        }
      }
    }

    const fgNode = ds.FieldGroups?.[0];
    const fieldGroups: string[] = [];
    if (fgNode && typeof fgNode === 'object') {
      const fgArray: any[] = fgNode.AxReportDataSetFieldGroup ?? [];
      for (const fg of fgArray) {
        fieldGroups.push(first(fg.Name) ?? '');
      }
    }

    result.push({
      name:           first(ds.Name)           ?? 'Unknown',
      dataSourceType: first(ds.DataSourceType) ?? '',
      query:          first(ds.Query)          ?? '',
      fields,
      fieldGroups,
    });
  }
  return result;
}

function extractDesigns(axReport: any, includeRdl: boolean): ReportDesign[] {
  const result: ReportDesign[] = [];
  const designsNode = axReport.Designs?.[0];
  if (!designsNode) return result;

  const designArray: any[] = designsNode.AxReportDesign ?? [];
  for (const d of designArray) {
    const rawText = first(d.Text);  // CDATA string or undefined
    const hasRdl = !!rawText && rawText.trim().length > 0;

    let rdlSummary: string | undefined;
    if (hasRdl && !includeRdl) {
      // Build a compact summary of RDL top-level elements
      rdlSummary = summarizeRdl(rawText!);
    }

    result.push({
      name:       first(d.Name)    ?? 'Unknown',
      caption:    first(d.Caption) ?? undefined,
      dataSet:    first(d.DataSet) ?? undefined,
      style:      first(d.Style)   ?? undefined,
      hasRdl,
      rdlContent: includeRdl && hasRdl ? rawText : undefined,
      rdlSummary: !includeRdl ? rdlSummary : undefined,
    });
  }
  return result;
}

/**
 * Parse the RDL XML string and return a bullet-point summary of top-level elements
 * (DataSources, DataSets, ReportParameters, Page, PageHeader, PageFooter, Body).
 * Never throws — falls back to char count only.
 */
function summarizeRdl(rdl: string): string {
  const lines: string[] = [`Length: ${rdl.length.toLocaleString()} chars`];
  try {
    // Quick regex-based extraction — avoids full parse of potentially huge XML
    const topElements = [
      'DataSources', 'DataSets', 'ReportParameters', 'Page',
      'PageHeader', 'PageFooter', 'Body',
    ];
    for (const el of topElements) {
      const present = rdl.includes(`<${el}>`);
      if (present) lines.push(`  • <${el}> present`);
    }

    // Count DataSet entries
    const dsCount = (rdl.match(/<DataSet\b/g) ?? []).length;
    if (dsCount > 0) lines.push(`  • ${dsCount} DataSet(s) in RDL`);

    // Count ReportParameter entries
    const rp = (rdl.match(/<ReportParameter\b/g) ?? []).length;
    if (rp > 0) lines.push(`  • ${rp} ReportParameter(s)`);

    // Count Tablix/Chart/Matrix
    const tablix = (rdl.match(/<Tablix\b/g) ?? []).length;
    const chart  = (rdl.match(/<Chart\b/g)  ?? []).length;
    if (tablix > 0) lines.push(`  • ${tablix} Tablix region(s)`);
    if (chart  > 0) lines.push(`  • ${chart} Chart(s)`);

    // Detect grouping
    const groups = (rdl.match(/<Group\b/g) ?? []).length;
    if (groups > 0) lines.push(`  • ${groups} Group expression(s)`);

    // RDL language
    const langMatch = rdl.match(/<Language>(.*?)<\/Language>/);
    if (langMatch) lines.push(`  • Language: ${langMatch[1]}`);

  } catch {
    // ignore parse errors
  }
  return lines.join('\n');
}

// ─── Output formatter ──────────────────────────────────────────────────────────

function formatOutput(info: ReportInfo, includeFields: boolean, includeRdl: boolean): any {
  const lines: string[] = [];

  lines.push(`# AxReport: \`${info.name}\``);
  lines.push('');
  lines.push(`**Model:** ${info.model}`);
  lines.push(`**File:** \`${info.filePath}\``);
  lines.push(`**DataMethods:** ${info.hasDataMethods ? '✅ present' : '— none'}`);
  lines.push(`**EmbeddedImages:** ${info.embeddedImageCount}`);
  lines.push('');

  // DataSets
  lines.push(`## 📊 DataSets (${info.dataSets.length})`);
  lines.push('');
  for (const ds of info.dataSets) {
    lines.push(`### DataSet: \`${ds.name}\``);
    lines.push(`- **DataSourceType:** ${ds.dataSourceType}`);
    lines.push(`- **Query:** \`${ds.query}\``);

    if (ds.fieldGroups.length > 0) {
      lines.push(`- **FieldGroups:** ${ds.fieldGroups.join(', ')}`);
    }

    if (includeFields) {
      if (ds.fields.length === 0) {
        lines.push('- **Fields:** *(none — empty `<Fields />` element)*');
      } else {
        lines.push(`- **Fields (${ds.fields.length}):**`);
        lines.push('');
        lines.push('  | Name | Alias | DataType | Caption |');
        lines.push('  |------|-------|----------|---------|');
        for (const f of ds.fields) {
          lines.push(`  | \`${f.name}\` | ${f.alias} | ${f.dataType ?? '—'} | ${f.caption ?? '—'} |`);
        }
      }
    }
    lines.push('');
  }

  // Designs
  lines.push(`## 🎨 Designs (${info.designs.length})`);
  lines.push('');
  for (const d of info.designs) {
    lines.push(`### Design: \`${d.name}\``);
    if (d.caption) lines.push(`- **Caption:** ${d.caption}`);
    if (d.dataSet) lines.push(`- **DataSet:** \`${d.dataSet}\``);
    if (d.style)   lines.push(`- **Style:** ${d.style}`);
    lines.push(`- **Embedded RDL:** ${d.hasRdl ? '✅ present' : '❌ empty'}`);

    if (d.hasRdl && !includeRdl && d.rdlSummary) {
      lines.push(`- **RDL summary:**`);
      lines.push('');
      lines.push('  ```');
      lines.push(d.rdlSummary.split('\n').map(l => `  ${l}`).join('\n'));
      lines.push('  ```');
      lines.push('');
      lines.push('  > Use `includeRdl: true` to retrieve the full RDL content.');
    }

    if (includeRdl && d.rdlContent) {
      lines.push('');
      lines.push('<details><summary>Full RDL</summary>');
      lines.push('');
      lines.push('```xml');
      lines.push(d.rdlContent);
      lines.push('```');
      lines.push('</details>');
    }
    lines.push('');
  }

  return { content: [{ type: 'text', text: lines.join('\n') }] };
}
