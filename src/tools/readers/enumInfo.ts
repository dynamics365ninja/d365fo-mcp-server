/**
 * Get Enum Info Tool
 * Extract enum values and enum properties.
 *
 * Read-path priority (same chain as tableInfo / viewInfo):
 *   1. C# bridge (IMetadataProvider) — live metadata.
 *   2. Symbol index → extracted-metadata JSON / AxEnum XML (indexed or remapped path).
 *   3. Disk scan — an enum created this session and not yet indexed.
 */

import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { parseStringPromise } from '../../utils/xml.js';
import type { XppServerContext } from '../../types/context.js';
import { tryBridgeEnum } from '../../bridge/bridgeAdapter.js';
import { readEnumRawXml, buildObjectTypeMismatchMessage } from '../../utils/metadataResolver.js';
import { describeKernelEnum } from '../../knowledge/kernelEnums.js';
import {
  resolveIndexedObject,
  readXmlFile,
  storedCopyFor,
  indexedXmlSourceLabel,
  indexedSourceNote,
  bridgeUnavailableNote,
  type IndexedObjectRef,
} from '../../utils/indexedXmlLookup.js';
import { binaryIsvNotice, isBinaryIsvPath } from '../../metadata/binaryModelImport.js';
import { findD365FileOnDisk } from '../../utils/objectFileLookup.js';

const GetEnumInfoArgsSchema = z.object({
  enumName: z.string().describe('Name of the enum'),
  modelName: z.string().optional().describe('Model name (auto-detected if not provided)'),
  includeLabels: z.boolean().optional().default(true).describe('Include enum value labels'),
  includeWorkspace: z.boolean().optional().default(false).describe('Include workspace files'),
  workspacePath: z.string().optional().describe('Path to workspace'),
});

export async function getEnumInfoTool(request: CallToolRequest, context: XppServerContext) {
  try {
    const args = GetEnumInfoArgsSchema.parse(request.params.arguments);

    // 0. Enums the X++ runtime defines have no AOT element, so every probe below
    //    correctly fails and the not-found reply then advised searching other
    //    spellings and running update_symbol_index on a file that cannot exist —
    //    while the EDT reader hands out the name (NoYesId -> "Enum Type: NoYes")
    //    in the first place. Answered up front instead of bottoming out.
    const kernel = describeKernelEnum(args.enumName);
    if (kernel) return { content: [{ type: 'text' as const, text: kernel }] };

    // 1. C# bridge (IMetadataProvider — live D365FO metadata)
    const bridgeResult = await tryBridgeEnum(context.bridge, args.enumName);
    if (bridgeResult) return bridgeResult;

    // 2. Symbol index → extracted metadata JSON, then the indexed XML file.
    //    A silent bridge is not proof the enum is missing (#14).
    const ref = await resolveIndexedObject(
      context.symbolIndex.getReadDb(), args.enumName, ['enum'], args.modelName,
    );
    if (ref) {
      const extractedXml = await readEnumRawXml(ref.model, ref.name);
      const fileXml = extractedXml
        ?? (ref.localPath ? await readXmlFile(ref.localPath) : null);
      // A binary ISV model has no file at all: the copy stored at index time is its only
      // source once the extracted JSON is not on this host.
      const stored = fileXml ? null : storedCopyFor(context.symbolIndex.getReadDb(), ref);
      const xml = fileXml ?? stored?.xml ?? null;
      const source = extractedXml ? 'symbol index (extracted metadata)'
        : stored ? indexedXmlSourceLabel(stored)
        : `XML: ${ref.localPath}`;
      // `ref` goes through so a JSON cache that outlived its AxEnum.xml is labelled
      // a stale row rather than rendered as a live enum — the ghost enum of #874's run.
      const formatted = xml && await formatEnumXml(ref.name, ref.model, xml, source, args.includeLabels, ref);
      if (formatted) return formatted;
      if (isBinaryIsvPath(ref.indexedPath)) {
        return { content: [{ type: 'text' as const, text:
          `# Enum: \`${ref.name}\`\n\n**Model:** ${ref.model}\n\n` +
          binaryIsvNotice(`the enum is in binary model ${ref.model} and its values are not available on this host ` +
            '(neither the extracted metadata nor a stored copy in the index is here). ' +
            'Re-run `npm run extract-binary-models` and update the index to get them') }] };
      }
    }

    // 3. Disk scan — an enum created this session and not yet indexed
    const diskPath = await findD365FileOnDisk('enum', args.enumName, args.modelName);
    if (diskPath) {
      const xml = await readXmlFile(diskPath);
      const formatted = xml && await formatEnumXml(
        args.enumName, args.modelName ?? 'Unknown', xml,
        `live file (not yet in bridge metadata): ${diskPath}`, args.includeLabels,
      );
      if (formatted) return formatted;
    }

    let text = `Enum "${args.enumName}" not found via bridge, symbol index, or on disk.\n`;
    text += bridgeUnavailableNote(context);
    try {
      text += buildObjectTypeMismatchMessage(context.symbolIndex.getReadDb(), args.enumName, 'enum');
    } catch { /* DB unavailable */ }
    return { content: [{ type: 'text', text }], isError: true };
  } catch (error) {
    return {
      content: [{
        type: 'text',
        text: `❌ Error getting enum info: ${error instanceof Error ? error.message : 'Unknown error'}`,
      }],
      isError: true,
    };
  }
}

/** Parse AxEnum XML and render values. Returns null when the XML isn't an AxEnum. */
async function formatEnumXml(
  enumName: string,
  model: string,
  xml: string,
  source: string,
  includeLabels: boolean,
  ref?: IndexedObjectRef | null,
): Promise<{ content: { type: 'text'; text: string }[] } | null> {
  let axEnum: any;
  try {
    axEnum = (await parseStringPromise(xml))?.AxEnum;
  } catch {
    return null;
  }
  if (!axEnum) return null;

  const values = (axEnum.EnumValues?.[0]?.AxEnumValue ?? []).map((v: any) => ({
    name: v.Name?.[0] ?? 'Unknown',
    value: v.Value?.[0] != null ? parseInt(v.Value[0], 10) : 0,
    label: includeLabels ? v.Label?.[0] : undefined,
  }));

  let out = `# Enum: \`${axEnum.Name?.[0] ?? enumName}\`\n\n`;
  out += `**Model:** ${model}\n`;
  out += `**Extensible:** ${axEnum.IsExtensible?.[0] === 'Yes' ? 'Yes' : 'No'}\n`;
  const binaryIsv = isBinaryIsvPath(ref?.indexedPath);
  // A binary model's dump has no UseEnumValue, so printing "No" would be a guess.
  if (!binaryIsv) out += `**Use Enum Value:** ${axEnum.UseEnumValue?.[0] === 'Yes' ? 'Yes' : 'No'}\n`;
  if (axEnum.Label?.[0]) out += `**Label:** ${axEnum.Label[0]}\n`;
  if (binaryIsv) out += `\n${binaryIsvNotice('no AxEnum XML exists, the values come from the compiled metadata')}`;
  out += indexedSourceNote(source, ref);

  if (values.length > 0) {
    out += `## 📋 Enum Values (${values.length})\n\n`;
    out += `| Name | Value${includeLabels ? ' | Label' : ''} |\n`;
    out += `|------|-------${includeLabels ? '|-------' : ''}|\n`;
    for (const v of values) {
      out += `| ${v.name} | ${v.value}${includeLabels ? ` | ${v.label || '—'}` : ''} |\n`;
    }
  }

  return { content: [{ type: 'text', text: out }] };
}

// This handler has no schema of its own — it is reached through a unified
// tool. Tool registration (name, description, inputSchema) lives in
// src/server/toolSchemas/, one file per published tool, aggregated by
// toolSchemas/index.ts. It is NOT in mcpServer.ts; that file only spreads
// the aggregated array into the ListTools response.
