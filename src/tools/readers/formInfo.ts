/**
 * Get Form Info Tool
 * Extract form structure: controls, datasources, methods
 * Returns control hierarchy, datasource configuration, form methods
 *
 * PRIMARY: C# bridge (IMetadataProvider) — 100% reliable, always available on VM.
 * FALLBACK: explicitFilePath bypass for newly-created forms not yet in bridge.
 * XML parsing helpers are shared by both paths for searchControl filtering.
 */

import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { XppServerContext } from '../../types/context.js';
import { promises as fs } from 'fs';
import { parseStringPromise } from '../../utils/xml.js';
import { tryBridgeForm } from '../../bridge/bridgeAdapter.js';
import { readIndexedXml, resolveIndexedObject } from '../../utils/indexedXmlLookup.js';
import { isCustomModel } from '../../utils/modelClassifier.js';
import {
  countFormControls,
  findControlElementOrderViolations,
  formatElementOrderViolations,
} from '../../validation/formControlElementOrder.js';
import { describeBridgeStartup } from '../../bridge/bridgeReadiness.js';
import { assertWritePathAllowed } from '../../utils/pathContainment.js';
import {
  createControlBudget, chargeControl, chargeSkippedSubtree, controlsFooter,
  DEFAULT_MAX_CONTROLS, type ControlBudget,
} from '../../utils/payloadBudget.js';

const GetFormInfoArgsSchema = z.object({
  formName: z.string().describe('Name of the form'),
  modelName: z.string().optional().describe('Model name (auto-detected if not provided)'),
  filePath: z.string().optional().describe(
    'Absolute path to the form XML file on disk. ' +
    'Use this when get_object_info(objectType="form") previously returned a "could not be read from disk" warning with a guessed path. ' +
    'Bypasses the DB path lookup entirely. ' +
    'Example: filePath="K:\\AOSService\\PackagesLocalDirectory\\ContosoCore\\ContosoCore\\AxForm\\MyForm.xml"'
  ),
  includeControls: z.boolean().optional().default(true).describe('Include control hierarchy'),
  includeDataSources: z.boolean().optional().default(true).describe('Include datasource information'),
  includeMethods: z.boolean().optional().default(true).describe('Include form methods'),
  includeWorkspace: z.boolean().optional().default(false).describe('Include workspace files'),
  workspacePath: z.string().optional().describe('Path to workspace'),
  searchControl: z.string().optional().describe(
    'Case-insensitive substring search for a control by name. ' +
    'Returns matching controls with their full path, parent name, and immediate children. ' +
    'Use this to find the exact name of a tab, group, or field (e.g. searchControl="General"). ' +
    'NEVER use PowerShell Get-Content to search form XML — use this parameter instead.'
  ),
  maxControls: z.number().optional().describe(
    `Cap on how many controls the tree renders (default ${DEFAULT_MAX_CONTROLS}). ` +
    'Prefer searchControl over raising this — a platform form has >1000 controls.'
  ),
});

interface FormControl {
  name: string;
  type: string;
  properties: Record<string, string>;
  children: FormControl[];
}

interface FormDataSource {
  name: string;
  table: string;
  allowEdit: boolean;
  allowCreate: boolean;
  allowDelete: boolean;
  fields: string[];
  methods: string[];
}

interface FormMethod {
  name: string;
  signature: string;
}

interface FormInfo {
  name: string;
  model: string;
  design: FormControl[];
  dataSources: FormDataSource[];
  methods: FormMethod[];
}

export async function getFormInfoTool(request: CallToolRequest, context: XppServerContext) {
  try {
    const args = GetFormInfoArgsSchema.parse(request.params.arguments);
    const { 
      formName, 
      filePath: explicitFilePath,
      includeControls, 
      includeDataSources, 
      includeMethods,
      searchControl,
      maxControls,
    } = args;

    // Explicit filePath skips the bridge — retry path for newly-created forms not yet indexed.
    if (explicitFilePath) {
      // Validate the path is within a configured D365FO package root before reading —
      // otherwise a prompt-injection attack could read arbitrary local files.
      const containment = await assertWritePathAllowed(explicitFilePath);
      if (!containment.ok) {
        return {
          content: [{ type: 'text', text:
            `❌ get_object_info(form): filePath rejected — ${containment.reason}`,
          }],
          isError: true,
        };
      }
      let xmlContent: string | null = null;
      try {
        xmlContent = await fs.readFile(explicitFilePath, 'utf-8');
      } catch (e) {
        return {
          content: [{ type: 'text', text:
            `❌ get_object_info(form): cannot read form XML at explicit filePath="${explicitFilePath}": ` +
            `${e instanceof Error ? e.message : String(e)}\n\n` +
            `Check the path is correct and accessible. DO NOT use PowerShell — fix the filePath parameter.`,
          }],
          isError: true,
        };
      }
      return await parseAndFormatForm(formName, 'Unknown', xmlContent, includeControls, includeDataSources, includeMethods, searchControl, maxControls);
    }

    // searchControl is implemented on the XML path only, so the bridge — which
    // answers first in full mode — silently returned the WHOLE tree instead of
    // the matches. On CustTable (635 controls) that blew the response cap, and
    // the truncation message then advised using searchControl: the option the
    // caller had already passed. An eval run lost a cycle dumping the form to a
    // file and grepping it. So when a search is asked for, prefer the path that
    // can actually perform it.
    const wantsSearch = Boolean(searchControl);

    if (!wantsSearch) {
      const bridgeResult = await tryBridgeForm(context.bridge, formName, maxControls);
      if (bridgeResult) {
        // The bridge cannot know it is short — whatever the deserializer dropped
        // was gone before it looked. Compare against the file (#985).
        const note = await bridgeCrossCheckWarning(
          context, formName, bridgeResult.content?.[0]?.text ?? '', args.modelName,
        );
        return prefixResult(bridgeResult, note);
      }
    }

    // Symbol index → form XML. A silent bridge is not proof the form is missing:
    // it also happens when the bridge is down or its provider does not cover that
    // package, while `search` still resolves the form.
    const indexed = await readIndexedXml(
      context.symbolIndex.getReadDb(), formName, ['form'], args.modelName,
    );
    if (indexed) {
      try {
        return await parseAndFormatForm(
          indexed.ref.name, indexed.ref.model, indexed.xml,
          includeControls, includeDataSources, includeMethods, searchControl, maxControls,
        );
      } catch { /* not a usable AxForm XML — fall through to the error below */ }
    }

    // The XML was unreachable and a search was asked for. The bridge can still
    // describe the form, but it cannot filter — say so rather than returning a
    // full tree that looks like the search found everything.
    if (wantsSearch) {
      const bridgeFallback = await tryBridgeForm(context.bridge, formName, maxControls);
      if (bridgeFallback) {
        const note =
          `⚠️ searchControl="${searchControl}" was NOT applied: the form XML is not in the symbol ` +
          `index (run update_symbol_index, or pass options={filePath:"<absolute path>"}), and the ` +
          `bridge reader cannot filter. The full control tree follows.\n\n`;
        const first = bridgeFallback.content?.[0];
        if (first && typeof first.text === 'string') first.text = note + first.text;
        return bridgeFallback;
      }
    }

    // Determine why the bridge returned nothing to give an actionable error message.
    // "still starting" and "not connected" are different problems with different
    // remedies (retry vs. fix the config) — describeBridgeStartup separates them.
    let bridgeNote: string;
    const startupNote = describeBridgeStartup(context);
    if (startupNote) {
      bridgeNote = startupNote;
    } else if (!context.bridge?.metadataAvailable) {
      bridgeNote =
        `The C# bridge is connected but the metadata provider failed to initialize. ` +
        `Check the bridge log for details — the packages path may be incorrect or the ` +
        `D365FO bin directory may be missing.`;
    } else {
      bridgeNote =
        `The bridge is connected and metadata is available, but form "${formName}" was not found ` +
        `in either the primary or reference packages path. Verify the form name spelling or ` +
        `pass the explicit filePath parameter:\n` +
        `  get_object_info(objectType="form", name="${formName}", options={filePath:"<absolute path to .xml>"})`;
    }

    return {
      content: [{
        type: 'text',
        text: `Form "${formName}" not found.\n\n${bridgeNote}`,
      }],
      isError: true,
    };
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `❌ Error getting form info: ${error instanceof Error ? error.message : 'Unknown error'}`,
        },
      ],
      isError: true,
    };
  }
}

// Elements the platform cannot see (issue #985)

/**
 * The warning block for a form whose XML writes elements out of the order the
 * metadata deserializer expects, or '' when the document is clean.
 *
 * AOT metadata XML is order-sensitive and the deserializer drops a misplaced
 * element in silence. When the dropped element is a container's `<Controls>`,
 * every control under it is in the file and invisible to the platform — that is
 * #979, where a scaffolded form carried 16 controls of which the compiler could
 * reach 14. The reader is where an agent finds out what a form contains before
 * writing to it, so it is where the discrepancy has to be said out loud.
 *
 * `providerCount` is the number the bridge reported, when a bridge answer is
 * being cross-checked; omit it on the pure-XML paths, where there is no second
 * number and inventing one would be worse than saying nothing.
 */
function elementOrderWarning(xml: string, providerCount?: number): string {
  const violations = findControlElementOrderViolations(xml).filter(v => v.kind === 'order');
  const documentCount = countFormControls(xml);
  const countsDiffer = providerCount !== undefined && providerCount !== documentCount;
  if (violations.length === 0 && !countsDiffer) return '';

  const lines: string[] = [];
  if (countsDiffer) {
    lines.push(
      `⚠️ **This form's XML holds ${documentCount} controls; the metadata provider reports ` +
      `${providerCount}.** The ${documentCount - providerCount} missing one(s) are in the file and ` +
      `invisible to the platform — the compiler will not see them either.`,
    );
  } else {
    lines.push(
      `⚠️ **${violations.length} element(s) in this form are written out of order, and the ` +
      `metadata deserializer drops those silently.** Anything under a dropped \`<Controls>\` is ` +
      `in the file and invisible to the platform.`,
    );
  }

  if (violations.length > 0) {
    lines.push('', formatElementOrderViolations(violations));
    lines.push(
      '',
      'Fix the ORDER in the AxForm XML — the canonical sequence per control type is mined from ' +
      'shipped metadata in `src/validation/formControlElementOrder.generated.ts` ' +
      '(e.g. on a group control `<DataGroup>` and `<DataSource>` come AFTER `</Controls>`).',
    );
  } else {
    lines.push(
      '',
      'No element-order violation was found, so the cause is something else the provider ' +
      'rejected — compare the file against a shipped form of the same shape.',
    );
  }
  return `${lines.join('\n')}\n\n---\n\n`;
}

/** Prefix a tool result's first text block with `note`, if there is anything to say. */
function prefixResult<T extends { content?: Array<{ text?: string }> }>(result: T, note: string): T {
  if (!note) return result;
  const first = result.content?.[0];
  if (first && typeof first.text === 'string') first.text = note + first.text;
  return result;
}

/**
 * Cross-check a bridge answer against the form's XML on disk.
 *
 * The bridge reads through `IMetadataProvider` — the same reader the compiler
 * uses — so anything dropped for being out of order is ALREADY gone by the time
 * it answers, and it cannot know it is short. The only way to notice from that
 * path is to compare against the raw file.
 *
 * Restricted to CUSTOM models on purpose. Microsoft's own forms were written by
 * Microsoft's tooling and are not the ones this server or its user can have
 * broken; reading SalesTable.xml off disk on every `get_object_info(form)` call
 * would be a real cost for a warning that will never fire. The index row is
 * consulted first (cheap) precisely so the file read can be skipped.
 */
async function bridgeCrossCheckWarning(
  context: XppServerContext,
  formName: string,
  bridgeText: string,
  modelName?: string,
): Promise<string> {
  try {
    const ref = await resolveIndexedObject(context.symbolIndex.getReadDb(), formName, ['form'], modelName);
    if (!ref?.localPath || !isCustomModel(ref.model)) return '';

    // The rendered tree is capped by maxControls, but the Summary line is not —
    // it reports the true total the bridge saw.
    const reported = /Controls:\s*(\d+)/.exec(bridgeText.slice(bridgeText.indexOf('📈 Summary')));
    if (!reported) return '';

    const xml = await fs.readFile(ref.localPath, 'utf-8');
    return elementOrderWarning(xml, Number(reported[1]));
  } catch {
    // A cross-check that cannot run is not a finding — the bridge answer stands.
    return '';
  }
}

// Shared XML parse + format helper

/**
 * Parse form XML and return the formatted tool response.
 * Shared by both the normal DB-lookup path and the explicit filePath bypass.
 */
async function parseAndFormatForm(
  formName: string,
  modelName: string,
  xmlContent: string,
  includeControls: boolean,
  includeDataSources: boolean,
  includeMethods: boolean,
  searchControl?: string,
  maxControls?: number,
) {
  const xmlObj = await parseStringPromise(xmlContent);

  const formInfo: FormInfo = {
    name: formName,
    model: modelName,
    design: [],
    dataSources: [],
    methods: [],
  };

  const axForm = xmlObj.AxForm;
  if (!axForm) {
    throw new Error('Invalid AxForm XML structure');
  }

  if (includeDataSources && axForm.DataSources) {
    formInfo.dataSources = extractDataSources(axForm.DataSources[0]);
  }
  if (includeControls && axForm.Design) {
    formInfo.design = extractControls(axForm.Design[0]);
  }
  if (includeMethods && axForm.SourceCode && axForm.SourceCode[0] && axForm.SourceCode[0].Methods) {
    formInfo.methods = extractMethods(axForm.SourceCode[0].Methods[0]);
  }

  // This path reads the RAW document, so it sees every control — including the
  // ones the metadata provider has already dropped for being out of order, which
  // is exactly why the two disagree (#979, #985). Say so before reporting a tree
  // the platform cannot fully see. The search branch gets it too: a control name
  // looked up here is about to be written against.
  const orderNote = elementOrderWarning(xmlContent);

  if (searchControl) {
    const matches = searchControlsInHierarchy(formInfo.design, searchControl);
    return prefixResult({
      content: [{ type: 'text', text: formatControlSearchResults(formInfo.name, formInfo.model, matches, searchControl) }],
    }, orderNote);
  }

  return prefixResult(
    formatFormOutput(formInfo, includeControls, includeDataSources, includeMethods, maxControls),
    orderNote,
  );
}

// Control search helpers

interface ControlSearchResult {
  control: FormControl;
  /** Full name path from root, e.g. ['Design', 'Tab', 'TabPageGeneral'] */
  path: string[];
  /** Direct parent control name, or null if top-level */
  parentName: string | null;
}

/**
 * Walk the control hierarchy recursively and collect all controls whose name
 * contains `query` (case-insensitive).
 */
function searchControlsInHierarchy(
  controls: FormControl[],
  query: string,
  path: string[] = [],
  parentName: string | null = null,
): ControlSearchResult[] {
  const results: ControlSearchResult[] = [];
  const lowerQuery = query.toLowerCase();

  for (const ctrl of controls) {
    const currentPath = [...path, ctrl.name];
    if (ctrl.name.toLowerCase().includes(lowerQuery)) {
      results.push({ control: ctrl, path: currentPath, parentName });
    }
    // Always recurse regardless of whether this node matched
    results.push(...searchControlsInHierarchy(ctrl.children, query, currentPath, ctrl.name));
  }

  return results;
}

/**
 * Format the search results in a way that gives the AI exactly what it needs
 * to write a form extension: exact control name, path, parent, and children.
 */
function formatControlSearchResults(
  formName: string,
  modelName: string,
  results: ControlSearchResult[],
  query: string,
): string {
  let out = `# Form: \`${formName}\` (${modelName}) — control search: "${query}"\n\n`;

  if (results.length === 0) {
    out += `No controls found matching "${query}".\n\n`;
    out += `Tip: call get_object_info(objectType="form", name=...) without searchControl to browse the full control hierarchy.\n`;
    return out;
  }

  out += `Found **${results.length}** control(s):\n\n`;

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    out += `---\n`;
    out += `**[${i + 1}] ${r.control.name}** (${r.control.type})\n`;
    out += `Path: \`${r.path.join(' › ')}\`\n`;
    if (r.parentName) {
      out += `Parent: \`${r.parentName}\`\n`;
    }

    // Key properties
    const propPairs = Object.entries(r.control.properties);
    if (propPairs.length > 0) {
      out += `Properties: ${propPairs.map(([k, v]) => `${k}=${v}`).join(' | ')}\n`;
    }

    // Children list (for knowing what's already inside)
    if (r.control.children.length > 0) {
      out += `\nChildren (${r.control.children.length}):\n`;
      const shown = r.control.children.slice(0, 15);
      for (const child of shown) {
        const extras: string[] = [];
        if (child.properties.DataSource) extras.push(`DS: ${child.properties.DataSource}`);
        if (child.properties.DataField) extras.push(`Field: ${child.properties.DataField}`);
        if (child.properties.Caption) extras.push(`Caption: ${child.properties.Caption}`);
        const extStr = extras.length > 0 ? `  [${extras.join(', ')}]` : '';
        out += `  • \`${child.name}\` (${child.type})${extStr}\n`;
      }
      if (r.control.children.length > 15) {
        out += `  … and ${r.control.children.length - 15} more\n`;
      }
    }

    // The parameter names here MUST be the ones add-control actually declares
    // (src/tools/specs/d365foFileOpSpecs.ts): this hint said parent=/after=,
    // which the operation does not read, so an agent following the tool's own
    // instruction wrote nothing and paid a full round trip to be told the real
    // spelling. `parent`/`after` are registered as aliases too, so the older
    // spelling keeps working — but the hint names the contract.
    out += `\n💡 **Form extension usage:**\n`;
    out += `  • Add a control **inside** \`${r.control.name}\`: set \`parentControl="${r.control.name}"\`\n`;
    if (r.parentName) {
      out += `  • Add a control **after** \`${r.control.name}\`: set \`parentControl="${r.parentName}", previousSibling="${r.control.name}"\`\n`;
    }
    out += `\n`;
  }

  return out;
}

function extractDataSources(dataSourcesNode: any): FormDataSource[] {
  const dataSources: FormDataSource[] = [];

  // Form XML uses AxFormDataSource (not AxFormDataSourceRoot)
  const dsArray = dataSourcesNode.AxFormDataSource || dataSourcesNode.AxFormDataSourceRoot;
  if (!dsArray) {
    return dataSources;
  }

  for (const dsNode of dsArray) {
    const ds: FormDataSource = {
      name: dsNode.Name ? dsNode.Name[0] : 'Unknown',
      table: dsNode.Table ? dsNode.Table[0] : 'Unknown',
      allowEdit: dsNode.AllowEdit ? dsNode.AllowEdit[0] === 'Yes' : true,
      allowCreate: dsNode.AllowCreate ? dsNode.AllowCreate[0] === 'Yes' : true,
      allowDelete: dsNode.AllowDelete ? dsNode.AllowDelete[0] === 'Yes' : true,
      fields: [],
      methods: [],
    };

    // Extract fields
    if (dsNode.Fields && dsNode.Fields[0]) {
      ds.fields = extractDataSourceFields(dsNode.Fields[0]);
    }

    // Extract methods
    if (dsNode.Methods && dsNode.Methods[0] && dsNode.Methods[0].Method) {
      ds.methods = dsNode.Methods[0].Method.map((m: any) => m.Name ? m.Name[0] : 'Unknown');
    }

    dataSources.push(ds);
  }

  return dataSources;
}

function extractDataSourceFields(fieldsNode: any): string[] {
  const fields: string[] = [];

  if (fieldsNode.AxFormDataSourceField) {
    for (const fieldNode of fieldsNode.AxFormDataSourceField) {
      const fieldName = fieldNode.DataField ? fieldNode.DataField[0] : 'Unknown';
      fields.push(fieldName);
    }
  }

  return fields;
}

function extractControls(designNode: any): FormControl[] {
  const controls: FormControl[] = [];

  // Design XML can be Design > AxFormDesign > Controls > AxFormControl[] (newer)
  // or Design > Controls > AxFormControl[] (older format).
  let controlsNode = null;
  if (designNode.AxFormDesign && designNode.AxFormDesign[0]) {
    controlsNode = designNode.AxFormDesign[0].Controls;
  } else if (designNode.Controls) {
    controlsNode = designNode.Controls;
  }
  
  if (controlsNode && controlsNode[0] && controlsNode[0].AxFormControl) {
    for (const node of controlsNode[0].AxFormControl) {
      const control = extractControl(node);
      if (control) {
        controls.push(control);
      }
    }
  }

  return controls;
}

function extractControl(node: any): FormControl | null {
  if (!node) return null;

  const control: FormControl = {
    name: node.Name ? node.Name[0] : 'Unknown',
    type: node.Type ? node.Type[0] : 'Group',
    properties: {},
    children: [],
  };

  const propertiesToExtract = [
    'Caption',
    'Visible',
    'Enabled',
    'AutoDeclaration',
    'DataSource',
    'DataField',
    'DataMethod',
    'HelpText',
    'Label',
    'Width',
    'Height',
  ];

  for (const prop of propertiesToExtract) {
    if (node[prop]) {
      control.properties[prop] = node[prop][0];
    }
  }

  if (node.Controls && node.Controls[0] && node.Controls[0].AxFormControl) {
    for (const childNode of node.Controls[0].AxFormControl) {
      const childControl = extractControl(childNode);
      if (childControl) {
        control.children.push(childControl);
      }
    }
  }

  return control;
}

function extractMethods(methodsNode: any): FormMethod[] {
  const methods: FormMethod[] = [];

  if (!methodsNode.Method) {
    return methods;
  }

  for (const methodNode of methodsNode.Method) {
    const name = methodNode.Name ? methodNode.Name[0] : 'Unknown';
    const source = methodNode.Source ? methodNode.Source[0] : '';
    const signature = source.split('\n')[0].trim(); // first line as signature

    methods.push({
      name,
      signature,
    });
  }

  return methods;
}

function formatFormOutput(
  formInfo: FormInfo,
  includeControls: boolean,
  includeDataSources: boolean,
  includeMethods: boolean,
  maxControls?: number,
): any {
  let output = `# Form: \`${formInfo.name}\`\n\n`;
  output += `**Model:** ${formInfo.model}\n\n`;

  if (includeDataSources && formInfo.dataSources.length > 0) {
    output += `## 📊 Data Sources\n\n`;
    for (const ds of formInfo.dataSources) {
      output += `### ${ds.name}\n\n`;
      output += `**Table:** \`${ds.table}\`\n`;
      output += `**Permissions:**\n`;
      output += `- Allow Edit: ${ds.allowEdit ? '✅' : '❌'}\n`;
      output += `- Allow Create: ${ds.allowCreate ? '✅' : '❌'}\n`;
      output += `- Allow Delete: ${ds.allowDelete ? '✅' : '❌'}\n`;
      
      if (ds.fields.length > 0) {
        output += `\n**Fields (${ds.fields.length}):**\n`;
        for (const field of ds.fields.slice(0, 20)) {
          output += `- ${field}\n`;
        }
        if (ds.fields.length > 20) {
          output += `- ... (${ds.fields.length - 20} more fields)\n`;
        }
      }

      if (ds.methods.length > 0) {
        output += `\n**Methods (${ds.methods.length}):**\n`;
        for (const method of ds.methods) {
          output += `- ${method}\n`;
        }
      }

      output += `\n`;
    }
  }

  if (includeControls && formInfo.design.length > 0) {
    // Capped like the bridge tree: this path had no limit either, so a platform
    // form rendered its full >1000-node tree into a single response.
    const budget = createControlBudget(maxControls);
    output += `## 🎨 Design (Controls)\n\n`;
    output += formatControlHierarchy(formInfo.design, 0, budget);
    output += controlsFooter(budget);
  }

  if (includeMethods && formInfo.methods.length > 0) {
    output += `## 🔧 Form Methods\n\n`;
    for (const method of formInfo.methods) {
      output += `### ${method.name}\n\n`;
      output += `\`\`\`xpp\n${method.signature}\n\`\`\`\n\n`;
    }
  }

  output += `## 📈 Summary\n\n`;
  output += `- **Data Sources:** ${formInfo.dataSources.length}\n`;
  output += `- **Controls:** ${countControls(formInfo.design)}\n`;
  output += `- **Methods:** ${formInfo.methods.length}\n`;

  return {
    content: [
      {
        type: 'text',
        text: output,
      },
    ],
  };
}

function formatControlHierarchy(controls: FormControl[], indent: number, budget: ControlBudget): string {
  let output = '';
  const indentStr = '  '.repeat(indent);

  for (const control of controls) {
    if (!chargeControl(budget)) {
      chargeSkippedSubtree(budget, control.children.length ? countControls(control.children) : 0);
      continue;
    }
    output += `${indentStr}- **${control.name}** (${control.type})\n`;
    
    const importantProps = ['Caption', 'DataSource', 'DataField', 'Visible', 'Enabled'];
    const propsToShow = Object.entries(control.properties)
      .filter(([key]) => importantProps.includes(key))
      .map(([key, value]) => `${key}: ${value}`)
      .join(', ');
    
    if (propsToShow) {
      output += `${indentStr}  *${propsToShow}*\n`;
    }

    if (control.children.length > 0) {
      output += formatControlHierarchy(control.children, indent + 1, budget);
    }
  }

  return output;
}

function countControls(controls: FormControl[]): number {
  let count = controls.length;
  for (const control of controls) {
    count += countControls(control.children);
  }
  return count;
}

// This handler has no schema of its own — it is reached through a unified
// tool. Tool registration (name, description, inputSchema) lives in
// src/server/toolSchemas/, one file per published tool, aggregated by
// toolSchemas/index.ts. It is NOT in mcpServer.ts; that file only spreads
// the aggregated array into the ListTools response.
