import fs from 'fs';
import path from 'path';
import { XppMetadataParser, buildClassExtensionRecord } from '../../metadata/xmlParser.js';
import { parseLabelFile } from '../../metadata/labelParser.js';
import type { XppServerContext } from '../../types/context.js';
import type { XppSymbol } from '../../metadata/types.js';
import { renderMethodSignature } from '../../metadata/xppDeclaration.js';
import { bridgeRefreshProvider } from '../../bridge/index.js';
import { getLastRefreshStartedAt } from '../../bridge/debouncedRefresh.js';

// Tool registration (name, description, inputSchema) lives in
// src/server/toolSchemas/updateSymbolIndex.ts — the single source of truth for tool
// instructions. It is NOT in mcpServer.ts; that file only spreads the
// aggregated toolSchemas array into the ListTools response.

/** Map AOT folder names to symbol types */
const AOT_FOLDER_TYPE_MAP: Record<string, XppSymbol['type']> = {
  'axclass': 'class',
  'axtable': 'table',
  'axtableextension': 'table-extension',
  'axform': 'form',
  'axformextension': 'form-extension',
  'axenum': 'enum',
  'axenumextension': 'enum-extension',
  'axedt': 'edt',
  'axedtextension': 'edt-extension',
  'axquery': 'query',
  'axquerysimpleextension': 'query-extension',
  'axview': 'view',
  'axviewextension': 'view-extension',
  // Full builds store data entities as type 'view' (see indexViews) — keep parity.
  'axdataentityview': 'view',
  'axdataentityviewextension': 'data-entity-extension',
  'axreport': 'report',
  'axmap': 'map',
  'axmapextension': 'map-extension',
  // #34: AxMenu was missing here, so a menu was indexed as type=class (the `?? 'class'`
  // default below) AND model=Unknown (extractModelFromPath only recognised MAPPED folders).
  'axmenu': 'menu',
  'axmenuextension': 'menu-extension',
  'axservice': 'service',
  'axservicegroup': 'service-group',
  'axconfigurationkey': 'configuration-key',
  'axlicensecode': 'license-code',
  'axsecuritypolicy': 'security-policy',
  'axmacrodictionary': 'macro',
  'axsecurityprivilege': 'security-privilege',
  'axsecurityduty': 'security-duty',
  'axsecuritydutyextension': 'security-duty-extension',
  'axsecurityrole': 'security-role',
  'axsecurityroleextension': 'security-role-extension',
  'axmenuitemaction': 'menu-item-action',
  'axmenuitemactionextension': 'menu-item-action-extension',
  'axmenuitemdisplay': 'menu-item-display',
  'axmenuitemdisplayextension': 'menu-item-display-extension',
  'axmenuitemoutput': 'menu-item-output',
  'axmenuitemoutputextension': 'menu-item-output-extension',
};

/**
 * Extract model name from AOT file path.
 * Pattern: {packagesRoot}\{package}\{model}\Ax{Type}\{Name}.xml
 * or:      {packagesRoot}\{model}\{model}\Ax{Type}\{Name}.xml
 */
/** Any AOT element folder, mapped or not (AxMenu, AxWorkflowType, …). */
const AOT_FOLDER_PATTERN = /^ax[a-z]/i;

/**
 * The types that own an extension_metadata row, taken from the map above so a
 * new Ax*Extension folder cannot be added without one.
 *
 * class-extension is deliberately absent: the AOT has no AxClassExtension
 * artifact, so a class extension arrives as an AxClass file and is recognised by
 * its [ExtensionOf] attribute in the class branch instead.
 */
const EXTENSION_OBJECT_TYPES = new Set<string>(
  Object.values(AOT_FOLDER_TYPE_MAP).filter(t => t.endsWith('-extension')),
);

/** True for an AOT element folder segment — mapped types plus everything else Ax*. */
export function isAotFolder(segment: string): boolean {
  return segment.toLowerCase() in AOT_FOLDER_TYPE_MAP || AOT_FOLDER_PATTERN.test(segment);
}

function extractModelFromPath(filePath: string): string | null {
  const parts = filePath.replace(/\//g, '\\').split('\\');
  // Find the AOT folder index (e.g. AxClass, AxTable).
  // #34: this used to accept only folders present in AOT_FOLDER_TYPE_MAP, so an
  // AxMenu path yielded model="Unknown" purely because the type map had a hole.
  // Any Ax* element folder identifies the model, whether or not we can type it.
  const aotIdx = parts.findIndex(p => isAotFolder(p));
  if (aotIdx >= 2) {
    return parts[aotIdx - 1]; // folder immediately before the AOT folder = model name
  }

  // Label file path pattern: ...\{model}\AxLabelFile\LabelResources\{locale}\{LabelFileId}.{locale}.label.txt
  const labelIdx = parts.findIndex(p => p.toLowerCase() === 'axlabelfile');
  if (labelIdx >= 1) {
    return parts[labelIdx - 1];
  }

  return null;
}

/**
 * Symbol type for an AOT folder segment.
 *
 * #34: the old expression was `AOT_FOLDER_TYPE_MAP[folder] ?? 'class'`, which
 * turned every unmapped AOT folder into a CLASS — an AxMenu was indexed as
 * `type=class`, poisoning search and every type-scoped lookup. A folder we can
 * name but not map now yields its own derived type (`AxWorkflowType` →
 * `workflowtype`) instead of a confident lie; `class` remains the fallback only
 * when the path carries no AOT folder at all.
 */
export function classifyAotFolder(aotFolder: string): XppSymbol['type'] {
  const key = aotFolder.toLowerCase();
  const mapped = AOT_FOLDER_TYPE_MAP[key];
  if (mapped) return mapped;
  if (AOT_FOLDER_PATTERN.test(aotFolder)) {
    // Derived, deliberately outside the curated union — it is a truthful label
    // for a type this server does not model, and stays searchable.
    return key.replace(/^ax/, '') as XppSymbol['type'];
  }
  return 'class';
}

function isLabelTextFile(filePath: string): boolean {
  return filePath.toLowerCase().endsWith('.label.txt');
}

function normalizeLocale(locale: string): string {
  return locale
    .split('-')
    .map((part, idx) => (idx === 0 ? part.toLowerCase() : part.toUpperCase()))
    .join('-');
}

function parseLabelFileName(filePath: string): { labelFileId: string; language: string } | null {
  const parts = filePath.split(/[\\/]/);
  const baseName = parts[parts.length - 1] ?? '';
  const withoutSuffix = baseName.replace(/\.label\.txt$/i, '');
  const dotIdx = withoutSuffix.lastIndexOf('.');
  if (dotIdx < 0) return null;

  const labelFileId = withoutSuffix.substring(0, dotIdx);
  const language = withoutSuffix.substring(dotIdx + 1);
  if (!labelFileId || !language) return null;

  return {
    labelFileId,
    language: normalizeLocale(language),
  };
}

/**
 * Accept one path or many. Callers that just created a handful of objects used to
 * have to make one tool call per file, and each of those calls paid for its own
 * full DiskProvider rebuild — the batch form pays for one.
 */
function normalizeFilePaths(filePath: unknown): string[] {
  const raw = Array.isArray(filePath) ? filePath : [filePath];
  return raw
    .filter((p): p is string => typeof p === 'string')
    .map(p => p.trim())
    .filter(p => p.length > 0);
}

/**
 * Newest mtime across the batch; 0 when nothing exists on disk (pure deletions).
 * Used to decide whether the bridge provider is already new enough.
 */
function newestMtimeMs(filePaths: string[]): number {
  let newest = 0;
  for (const fp of filePaths) {
    try {
      const { mtimeMs } = fs.statSync(fp);
      if (mtimeMs > newest) newest = mtimeMs;
    } catch { /* deleted or unreadable — nothing to date */ }
  }
  return newest;
}

/**
 * Said out loud when the call was redundant (#830). The skip itself is old news;
 * saying nothing about it is what kept the agent making the call — four times in
 * one audited session, each as the only tool call in its turn.
 */
const REDUNDANT_CALL_NOTE =
  'ℹ️ This call was not needed. The bridge provider was already refreshed after these file(s) ' +
  'were written — `d365fo_file` create/modify refreshes it on its way out, so no rebuild was run. ' +
  'Only call `update_symbol_index` for files changed OUTSIDE this server.';

/**
 * Refresh the C# provider once for the whole batch — and only when it could
 * actually learn something.
 *
 * d365fo_file's create/modify paths already refresh the provider on their way
 * out, so the update_symbol_index call that conventionally follows them was
 * rebuilding a provider that had been rebuilt moments earlier and could not see
 * anything new. A refresh that STARTED after the newest file was written has, by
 * definition, already read every file in this batch.
 */
async function refreshBridgeForBatch(
  context: XppServerContext,
  filePaths: string[],
): Promise<{ note: string; redundant: boolean }> {
  const newest = newestMtimeMs(filePaths);
  if (newest > 0 && getLastRefreshStartedAt() > newest) {
    return { note: REDUNDANT_CALL_NOTE, redundant: true };
  }
  try {
    const result = await bridgeRefreshProvider(context.bridge);
    return {
      note: result
        ? `Bridge provider refreshed in ${result.elapsedMs}ms.`
        : 'Bridge provider not available (skipped).',
      redundant: false,
    };
  } catch (e: any) {
    return { note: `Bridge refresh skipped: ${e?.message ?? e}`, redundant: false };
  }
}

export const updateSymbolIndexTool = async (params: any, context: XppServerContext) => {
  const filePaths = normalizeFilePaths(params?.filePath);

  // Refresh mode (no filePath): refreshes the bridge provider and drops workspace
  // caches, lighter than a full reindex. Per-object SQLite indexing still needs filePath.
  if (filePaths.length === 0) {
    return refreshOnly(context);
  }

  // A file just changed on disk — drop the workspace scan cache so the
  // context pipeline (recently-edited / active object) reflects it at once.
  context.workspaceScanner?.invalidate?.();

  // One refresh for the batch, before indexing, so a per-file failure cannot
  // leave the provider stale.
  const bridge = await refreshBridgeForBatch(context, filePaths);

  const results: Array<{ text: string; isError: boolean }> = [];
  for (const fp of filePaths) {
    results.push(await indexOneFile(fp, context));
  }

  // A redundant call leads with the note instead of burying it under a success
  // message the agent reads as "this call did something" (#830). The SQLite
  // reindex below still runs — it is milliseconds, and nothing else populates
  // the symbol DB — but the expensive DiskProvider rebuild was skipped.
  const lead = bridge.redundant ? `${bridge.note}\n\n` : '';
  const trail = bridge.redundant ? '' : bridge.note;

  // Single file keeps its original single-message shape; only a real batch gets
  // the roll-up, so existing callers and their assertions see no change.
  if (results.length === 1) {
    return {
      content: [{ type: 'text', text: `${lead}${results[0].text}${trail ? `\n\n${trail}` : ''}` }],
      ...(results[0].isError ? { isError: true } : {}),
    };
  }

  const failed = results.filter(r => r.isError).length;
  return {
    content: [{
      type: 'text',
      text:
        `${lead}Indexed ${results.length - failed}/${results.length} file(s) in one pass.` +
        `${trail ? ` ${trail}` : ''}\n\n` +
        results.map(r => r.text).join('\n\n'),
    }],
    ...(failed === results.length ? { isError: true } : {}),
  };
};

/** Bridge/cache refresh with no file to index. */
async function refreshOnly(context: XppServerContext) {
  context.workspaceScanner?.invalidate?.();
  let bridgeNote = 'Bridge provider not available (skipped).';
  try {
    const refreshResult = await bridgeRefreshProvider(context.bridge);
    if (refreshResult) {
      bridgeNote = `Bridge provider refreshed in ${refreshResult.elapsedMs}ms — newly created objects are now resolvable by bridge-backed operations.`;
    }
  } catch (e: any) {
    bridgeNote = `Bridge refresh skipped: ${e?.message ?? e}`;
  }
  // Note: deliberately no touchLastIndexed() here — nothing was reindexed in
  // SQLite, and bumping the timestamp would make get_workspace_info report a
  // possibly stale index as fresh (see src/utils/indexStaleness.ts).
  return {
    content: [{
      type: 'text',
      text:
        `🔄 **Bridge/cache refresh** (no filePath supplied).\n\n` +
        `${bridgeNote}\n` +
        `Workspace scan cache invalidated.\n\n` +
        `ℹ️ The SQLite symbol index itself was NOT reindexed. To fully index a specific new ` +
        `object into the searchable symbol DB (so scaffolding resolves its EDTs/enums and ` +
        `references work), call this tool again with \`filePath\` pointing at the created ` +
        `\`.xml\` (e.g. the new AxEnum/AxEdt/AxTable file).`,
    }],
  };
}

/**
 * Index (or clean up after) exactly ONE file. The bridge refresh is the caller's
 * job — it is per-batch, not per-file, which is what made a multi-object update
 * cost one full DiskProvider rebuild per object.
 */
/**
 * Index ONE file into the SQLite symbol/label index.
 *
 * Exported so the create/modify paths can do this in-process on their way out
 * (see inlineIndexUpsert.ts) instead of the agent spending a round trip on
 * update_symbol_index — which was the last legitimate mid-task reason to call
 * that tool at all.
 */
/**
 * Refresh the extension_metadata row for one Ax*Extension file.
 *
 * Returns the identity the caller needs for the symbol row, or null when the
 * file does not parse as an extension — in which case the caller falls back to
 * the bare object row, which is what every extension used to get.
 */
async function reindexExtensionMetadata(
  filePath: string,
  objectType: string,
  model: string,
  symbolIndex: XppServerContext['symbolIndex'],
  parser: XppMetadataParser,
): Promise<{ name: string; baseObjectName: string } | null> {
  const parsed = await parser.parseExtensionFile(filePath, objectType);
  if (!parsed.success || !parsed.data?.name) return null;
  const data = parsed.data;
  symbolIndex.upsertExtensionMetadata?.({
    extensionName: data.name,
    extensionType: objectType,
    baseObjectName: data.baseObjectName,
    addedFields: data.addedFields,
    addedMethods: data.addedMethods,
    addedIndexes: data.addedIndexes,
    cocMethods: data.cocMethods,
    eventSubscriptions: data.eventSubscriptions,
    model,
  });
  return { name: data.name, baseObjectName: data.baseObjectName };
}

export async function indexOneFile(
  filePath: string,
  context: XppServerContext,
): Promise<{ text: string; isError: boolean }> {
  const ok = (text: string) => ({ text, isError: false });
  const err = (text: string) => ({ text, isError: true });
  try {
    const { symbolIndex } = context;
    const pathParts = filePath.split(/[\\/]/);
    const fileName = pathParts[pathParts.length - 1] ?? filePath;
    const objectName = fileName.replace(/\.[^.]+$/, '');
    const parts = filePath.replace(/\//g, '\\').split('\\');
    const aotFolder = parts.find((p: string) => isAotFolder(p)) ?? '';
    const objectType: XppSymbol['type'] = classifyAotFolder(aotFolder);

    // File deleted: clean up stale index entries
    if (!fs.existsSync(filePath)) {
      console.error(`[update_symbol_index] File deleted — cleaning up stale entries for "${objectName}"`);

      // 1. Remove symbols from SQLite
      const { deletedCount } = symbolIndex.removeSymbolsByFile(filePath);

      // 2. Remove labels from labels DB (label files live alongside XML)
      const labelCount = symbolIndex.removeLabelsByFile(filePath);

      // 2b. extension_metadata is keyed by name + type + model, not by path, so
      // removeSymbolsByFile above cannot reach it. Both spellings are tried
      // because a class extension is an AxClass file; each is a no-op when the
      // row is not there.
      const deletedModel = extractModelFromPath(filePath) ?? 'Unknown';
      const metaCount =
        (symbolIndex.removeExtensionMetadata?.(objectName, objectType, deletedModel) ?? 0) +
        (objectType === 'class'
          ? (symbolIndex.removeExtensionMetadata?.(objectName, 'class-extension', deletedModel) ?? 0)
          : 0);

      // The bridge refresh that stops it seeing the deleted file is the caller's
      // per-batch one.
      symbolIndex.touchLastIndexed?.();

      const parts_cleaned: string[] = [];
      if (deletedCount > 0) parts_cleaned.push(`${deletedCount} symbol(s)`);
      if (labelCount > 0) parts_cleaned.push(`${labelCount} label(s)`);
      if (metaCount > 0) parts_cleaned.push(`${metaCount} extension record(s)`);
      const summary = parts_cleaned.length > 0 ? parts_cleaned.join(' + ') : 'no stale entries found';

      return ok(`🗑️ File deleted — cleaned up ${summary} for **${objectName}** (${objectType}).`);
    }

    // File exists: re-index
    const model = extractModelFromPath(filePath) ?? 'Unknown';

    // Label files are indexed in labels DB (not symbols DB).
    if (isLabelTextFile(filePath)) {
      const parsedFileName = parseLabelFileName(filePath);
      if (!parsedFileName) {
        return err(
          `❌ Error updating label index: invalid label filename format for ${path.basename(filePath)} (expected {LabelFileId}.{locale}.label.txt).`
        );
      }

      const { labelFileId, language } = parsedFileName;
      const removedCount = symbolIndex.removeLabelsByFile(filePath);

      let insertedCount = 0;
      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const labels = parseLabelFile(content, labelFileId, model, language, filePath);
        if (labels.length > 0) {
          // keepTriggers: one label file is not a reason to re-tokenise every label in
          // the database (~105 s on the production DB, event loop blocked throughout).
          // removeLabelsByFile above already pruned the old FTS rows via labels_ad.
          symbolIndex.bulkAddLabels(labels.map(lbl => ({
            labelId: lbl.labelId,
            labelFileId: lbl.labelFileId,
            model: lbl.model,
            language: lbl.language,
            text: lbl.text,
            comment: lbl.comment,
            filePath: lbl.filePath,
          })), { skipFtsRebuild: true, keepTriggers: true });
          insertedCount = labels.length;
        }
      } catch (e: any) {
        return err(`❌ Error updating label index: ${e.message}`);
      }

      symbolIndex.touchLastIndexed?.();

      return ok(
        `✅ Label index updated for **${path.basename(filePath)}** (model: ${model}, language: ${language}).\n\n` +
        `Removed: ${removedCount} stale entr${removedCount === 1 ? 'y' : 'ies'}\n` +
        `Inserted: ${insertedCount} label${insertedCount !== 1 ? 's' : ''}`
      );
    }

    const parser = new XppMetadataParser();

    console.error(`[update_symbol_index] Re-indexing ${objectType} "${objectName}" (model: ${model})`);

    // 1. Remove all existing symbols for this file so stale entries don't linger.
    // removeSymbolsByFile matches every stored path form (absolute Windows path
    // or PackagesLocalDirectory-relative, either slash style) — see symbolIndex.ts.
    const { deletedCount } = symbolIndex.removeSymbolsByFile(filePath);

    // The C# bridge provider refresh happens once per batch in the caller.

    // 2. Re-parse the XML and insert fresh symbols
    let insertedCount = 0;
    const tx = symbolIndex.db.transaction(() => {
      // Minimal fallback for types not handled individually below
      symbolIndex.addSymbol({
        name: objectName,
        type: objectType,
        filePath,
        model,
      });
      insertedCount++;
    });

    // For classes and tables, parse XML to get methods/fields too
    if (objectType === 'class') {
      const result = await parser.parseClassFile(filePath, model);
      if (result.success && result.data) {
        const classData = result.data;
        const insert = symbolIndex.db.transaction(() => {
          symbolIndex.addSymbol({
            name: classData.name,
            type: 'class',
            signature: classData.extends ? `extends ${classData.extends}` : undefined,
            filePath,
            model,
            description: classData.description || classData.documentation,
            tags: classData.tags?.join(', '),
            extendsClass: classData.extends,
            implementsInterfaces: classData.implements?.join(', '),
            visibility: classData.visibility,
            usedTypes: classData.usedTypes?.join(', '),
          });
          insertedCount++;
          for (const method of classData.methods ?? []) {
            symbolIndex.addSymbol({
              name: method.name,
              type: 'method',
              parentName: classData.name,
              signature: renderMethodSignature(method),
              filePath,
              model,
              description: method.documentation,
              tags: method.tags?.join(', '),
              sourceSnippet: method.sourceSnippet,
              source: method.source,
              complexity: method.complexity,
              usedTypes: method.usedTypes?.join(', '),
              methodCalls: method.methodCalls?.join(', '),
              inlineComments: method.inlineComments,
            });
            insertedCount++;
          }
        });
        insert();
        // A class carrying [ExtensionOf(...)] is also an extension — the AOT has
        // no separate artifact for one — and resolveReferences resolves an
        // extension-added or CoC-wrapped method through extension_metadata.
        const extension = buildClassExtensionRecord(classData, model);
        if (extension) {
          symbolIndex.upsertExtensionMetadata?.({
            extensionName: extension.name,
            extensionType: 'class-extension',
            baseObjectName: extension.baseObjectName,
            addedFields: extension.addedFields,
            addedMethods: extension.addedMethods,
            addedIndexes: extension.addedIndexes,
            cocMethods: extension.cocMethods,
            eventSubscriptions: extension.eventSubscriptions,
            model,
          });
        }
      } else {
        // Fallback: just index the object name
        tx();
      }
    } else if (objectType === 'table') {
      const result = await parser.parseTableFile(filePath, model);
      if (result.success && result.data) {
        const tableData = result.data;
        const insert = symbolIndex.db.transaction(() => {
          symbolIndex.addSymbol({
            name: tableData.name,
            type: 'table',
            signature: tableData.label || undefined,
            filePath,
            model,
          });
          insertedCount++;
          for (const field of tableData.fields ?? []) {
            // Store the field's EDT/EnumType as its signature, not the bare base type
            // (String/Real/Enum/...) — consumers like resolveFieldEdt() in
            // modifyD365File.ts need an X++-usable type name here.
            symbolIndex.addSymbol({
              name: field.name,
              type: 'field',
              parentName: tableData.name,
              signature: field.extendedDataType || field.enumType || field.type,
              filePath,
              model,
            });
            insertedCount++;
          }
          // Re-insert table methods too — the full build (indexTables) indexes
          // them, and the delete above just removed them; skipping them here
          // would silently drop a table's methods on every incremental reindex.
          for (const method of tableData.methods ?? []) {
            symbolIndex.addSymbol({
              name: method.name,
              type: 'method',
              parentName: tableData.name,
              signature: renderMethodSignature(method),
              filePath,
              model,
              description: method.documentation,
              tags: method.tags?.join(', '),
              sourceSnippet: method.sourceSnippet,
              source: method.source,
              complexity: method.complexity,
              usedTypes: method.usedTypes?.join(', '),
              methodCalls: method.methodCalls?.join(', '),
              inlineComments: method.inlineComments,
            });
            insertedCount++;
          }
        });
        insert();
      } else {
        tx();
      }
    } else if (objectType === 'view') {
      // #801: views/data entities (axview and axdataentityview both classify as
      // 'view', see AOT_FOLDER_TYPE_MAP above) had no rebuild branch, so a resync
      // deleted every field/method symbol and re-inserted a single bare object
      // row — silently reporting success. Mirrors indexViews (the full build).
      const result = await parser.parseViewFile(filePath, model);
      if (result.success && result.data) {
        const viewData = result.data;
        const insert = symbolIndex.db.transaction(() => {
          symbolIndex.addSymbol({
            name: viewData.name,
            type: 'view',
            signature: viewData.type || undefined,
            filePath,
            model,
            description: viewData.label,
          });
          insertedCount++;
          for (const field of viewData.fields ?? []) {
            symbolIndex.addSymbol({
              name: field.name,
              type: 'field',
              parentName: viewData.name,
              signature: field.dataMethod || field.dataField || undefined,
              filePath,
              model,
            });
            insertedCount++;
          }
          for (const method of viewData.methods ?? []) {
            symbolIndex.addSymbol({
              name: method.name,
              type: 'method',
              parentName: viewData.name,
              signature: renderMethodSignature(method),
              filePath,
              model,
              description: method.documentation,
              tags: method.tags?.join(', '),
              sourceSnippet: method.sourceSnippet,
              source: method.source,
              complexity: method.complexity,
              usedTypes: method.usedTypes?.join(', '),
              methodCalls: method.methodCalls?.join(', '),
              inlineComments: method.inlineComments,
            });
            insertedCount++;
          }
        });
        insert();
      } else {
        tx();
      }
    } else if (objectType === 'edt') {
      const result = await parser.parseEdtFile(filePath, model);
      if (result.success && result.data) {
        const edtData = result.data as any;
        const edtName = edtData.name ?? objectName;
        symbolIndex.addSymbol({
          name: edtName,
          type: 'edt',
          signature: edtData.extends ?? undefined,
          filePath,
          model,
        });
        insertedCount++;
        // Also populate edt_metadata so scaffolding (resolveEdtBaseType / resolveBestEdt)
        // can resolve this EDT's base type and relation.
        try {
          symbolIndex.db
            .prepare(`DELETE FROM edt_metadata WHERE edt_name = ? AND model = ?`)
            .run(edtName, model);
          symbolIndex.db.prepare(`
            INSERT OR REPLACE INTO edt_metadata (
              edt_name, extends, enum_type, reference_table, relation_type,
              string_size, database_string_size, display_length, label, model
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            edtName,
            edtData.extends ?? null,
            edtData.enumType ?? null,
            edtData.referenceTable ?? null,
            edtData.relationType ?? null,
            edtData.stringSize ?? null,
            edtData.databaseStringSize ?? null,
            edtData.displayLength ?? null,
            edtData.label ?? null,
            model,
          );
        } catch (e) {
          console.error(`[update_symbol_index] edt_metadata upsert skipped for ${edtName}: ${e}`);
        }
      } else {
        tx();
      }
    } else if (EXTENSION_OBJECT_TYPES.has(objectType)) {
      // One branch for every Ax*Extension kind, form extensions included: they
      // differ only in which tag holds the added members, which
      // parseExtensionFile already knows. The symbol row carries the base object
      // the way the full build writes it, so the two paths agree.
      const extension = await reindexExtensionMetadata(filePath, objectType, model, symbolIndex, parser);
      if (extension) {
        symbolIndex.addSymbol({
          name: extension.name,
          type: objectType,
          parentName: extension.baseObjectName || undefined,
          extendsClass: extension.baseObjectName || undefined,
          signature: extension.baseObjectName || undefined,
          filePath,
          model,
        });
        insertedCount++;
      } else {
        tx();
      }
    } else if (objectType === 'form') {
      const result = await parser.parseFormFile(filePath, model);
      if (result.success && result.data) {
        const formData = result.data as any;
        symbolIndex.addSymbol({
          name: formData.name ?? objectName,
          type: objectType,
          filePath,
          model,
        });
        insertedCount++;
      } else {
        tx();
      }
    } else if (objectType === 'security-privilege') {
      // Populate security_privilege_entries so security_info(coverage) can see
      // this privilege's entry points.
      const result = await parser.parseSecurityPrivilegeFile(filePath);
      if (result.success && result.data) {
        const privData = result.data;
        symbolIndex.addSymbol({
          name: privData.name ?? objectName,
          type: 'security-privilege',
          filePath,
          model,
          description: privData.label,
        });
        insertedCount++;
        symbolIndex.db
          .prepare(`DELETE FROM security_privilege_entries WHERE privilege_name = ? AND model = ?`)
          .run(privData.name ?? objectName, model);
        const insertEntry = symbolIndex.db.prepare(`
          INSERT OR IGNORE INTO security_privilege_entries
            (privilege_name, entry_point_name, object_type, access_level, model)
          VALUES (?, ?, ?, ?, ?)
        `);
        for (const ep of privData.entryPoints ?? []) {
          if (!ep.name) continue;
          insertEntry.run(privData.name ?? objectName, ep.name, ep.objectType ?? null, ep.accessLevel ?? null, model);
          insertedCount++;
        }
      } else {
        tx();
      }
    } else if (objectType === 'security-duty') {
      // Populates security_duty_privileges — see security-privilege branch above.
      const result = await parser.parseSecurityDutyFile(filePath);
      if (result.success && result.data) {
        const dutyData = result.data;
        symbolIndex.addSymbol({
          name: dutyData.name ?? objectName,
          type: 'security-duty',
          filePath,
          model,
          description: dutyData.label,
        });
        insertedCount++;
        symbolIndex.db
          .prepare(`DELETE FROM security_duty_privileges WHERE duty_name = ? AND model = ?`)
          .run(dutyData.name ?? objectName, model);
        const insertPriv = symbolIndex.db.prepare(`
          INSERT OR IGNORE INTO security_duty_privileges (duty_name, privilege_name, model)
          VALUES (?, ?, ?)
        `);
        for (const priv of dutyData.privileges ?? []) {
          insertPriv.run(dutyData.name ?? objectName, priv, model);
          insertedCount++;
        }
      } else {
        tx();
      }
    } else if (objectType === 'security-role') {
      // Populates security_role_duties — see security-privilege branch above.
      const result = await parser.parseSecurityRoleFile(filePath);
      if (result.success && result.data) {
        const roleData = result.data;
        symbolIndex.addSymbol({
          name: roleData.name ?? objectName,
          type: 'security-role',
          filePath,
          model,
          description: roleData.label,
        });
        insertedCount++;
        symbolIndex.db
          .prepare(`DELETE FROM security_role_duties WHERE role_name = ? AND model = ?`)
          .run(roleData.name ?? objectName, model);
        const insertDuty = symbolIndex.db.prepare(`
          INSERT OR IGNORE INTO security_role_duties (role_name, duty_name, model)
          VALUES (?, ?, ?)
        `);
        for (const duty of roleData.duties ?? []) {
          insertDuty.run(roleData.name ?? objectName, duty, model);
          insertedCount++;
        }
      } else {
        tx();
      }
    } else if (
      objectType === 'menu-item-display' ||
      objectType === 'menu-item-action' ||
      objectType === 'menu-item-output'
    ) {
      // Populate menu_item_targets so security_info(coverage)'s object -> menu
      // items lookup works for this menu item.
      const itemType = objectType === 'menu-item-display' ? 'display' : objectType === 'menu-item-action' ? 'action' : 'output';
      const result = await parser.parseMenuItemFile(filePath, itemType);
      if (result.success && result.data) {
        const miData = result.data;
        symbolIndex.addSymbol({
          name: miData.name ?? objectName,
          type: objectType,
          filePath,
          model,
          description: miData.label,
        });
        insertedCount++;
        symbolIndex.db
          .prepare(`DELETE FROM menu_item_targets WHERE menu_item_name = ? AND model = ?`)
          .run(miData.name ?? objectName, model);
        symbolIndex.db.prepare(`
          INSERT INTO menu_item_targets
            (menu_item_name, menu_item_type, target_object, target_type, security_privilege, label, model)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
          miData.name ?? objectName,
          objectType,
          miData.targetObject ?? null,
          miData.targetType ?? null,
          miData.securityPrivilege ?? null,
          miData.label ?? null,
          model,
        );
        insertedCount++;
      } else {
        tx();
      }
    } else {
      tx();
    }

    symbolIndex.touchLastIndexed?.();

    return ok(
      `✅ Symbol index updated for **${objectName}** (${objectType}, model: ${model}).\n\n` +
      `Removed: ${deletedCount} stale entr${deletedCount === 1 ? 'y' : 'ies'}\n` +
      `Inserted: ${insertedCount} symbol${insertedCount !== 1 ? 's' : ''}`
    );
  } catch (error: any) {
    console.error('Error updating symbol index:', error);
    return err(`❌ Error updating symbol index (${path.basename(filePath)}): ${error.message}`);
  }
}
