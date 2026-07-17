import fs from 'fs';
import path from 'path';
import { XppMetadataParser } from '../metadata/xmlParser.js';
import { parseLabelFile } from '../metadata/labelParser.js';
import type { XppServerContext } from '../types/context.js';
import type { XppSymbol } from '../metadata/types.js';
import { bridgeRefreshProvider } from '../bridge/index.js';

// Tool registration (name, description, inputSchema) lives inline in
// src/server/mcpServer.ts - the single source of truth for tool instructions.

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
function extractModelFromPath(filePath: string): string | null {
  const parts = filePath.replace(/\//g, '\\').split('\\');
  // Find the AOT folder index (e.g. AxClass, AxTable)
  const aotIdx = parts.findIndex(p => p.toLowerCase() in AOT_FOLDER_TYPE_MAP);
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

export const updateSymbolIndexTool = async (params: any, context: XppServerContext) => {
  const { filePath } = params;
  try {
    const { symbolIndex } = context;

    // Refresh mode (no filePath): refreshes the bridge provider and drops workspace
    // caches, lighter than a full reindex. Per-object SQLite indexing still needs filePath.
    if (!filePath || (typeof filePath === 'string' && filePath.trim().length === 0)) {
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
    // A file just changed on disk — drop the workspace scan cache so the
    // context pipeline (recently-edited / active object) reflects it at once.
    context.workspaceScanner?.invalidate?.();
    const pathParts = filePath.split(/[\\/]/);
    const fileName = pathParts[pathParts.length - 1] ?? filePath;
    const objectName = fileName.replace(/\.[^.]+$/, '');
    const parts = filePath.replace(/\//g, '\\').split('\\');
    const aotFolder = parts.find((p: string) => p.toLowerCase() in AOT_FOLDER_TYPE_MAP) ?? '';
    const objectType: XppSymbol['type'] = AOT_FOLDER_TYPE_MAP[aotFolder.toLowerCase()] ?? 'class';

    // File deleted: clean up stale index entries
    if (!fs.existsSync(filePath)) {
      console.error(`[update_symbol_index] File deleted — cleaning up stale entries for "${objectName}"`);

      // 1. Remove symbols from SQLite
      const { deletedCount } = symbolIndex.removeSymbolsByFile(filePath);

      // 2. Remove labels from labels DB (label files live alongside XML)
      const labelCount = symbolIndex.removeLabelsByFile(filePath);

      // 3. Refresh bridge so it no longer sees the deleted file
      try {
        await bridgeRefreshProvider(context.bridge);
      } catch { /* bridge not available */ }

      symbolIndex.touchLastIndexed?.();

      const parts_cleaned: string[] = [];
      if (deletedCount > 0) parts_cleaned.push(`${deletedCount} symbol(s)`);
      if (labelCount > 0) parts_cleaned.push(`${labelCount} label(s)`);
      const summary = parts_cleaned.length > 0 ? parts_cleaned.join(' + ') : 'no stale entries found';

      return {
        content: [{
          type: 'text',
          text: `🗑️ File deleted — cleaned up ${summary} for **${objectName}** (${objectType}).\n` +
            `Bridge refreshed.`
        }]
      };
    }

    // File exists: re-index
    const model = extractModelFromPath(filePath) ?? 'Unknown';

    // Label files are indexed in labels DB (not symbols DB).
    if (isLabelTextFile(filePath)) {
      const parsedFileName = parseLabelFileName(filePath);
      if (!parsedFileName) {
        return {
          content: [{
            type: 'text',
            text: `❌ Error updating label index: invalid label filename format for ${path.basename(filePath)} (expected {LabelFileId}.{locale}.label.txt).`,
          }],
          isError: true,
        };
      }

      const { labelFileId, language } = parsedFileName;
      const removedCount = symbolIndex.removeLabelsByFile(filePath);

      let insertedCount = 0;
      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const labels = parseLabelFile(content, labelFileId, model, language, filePath);
        if (labels.length > 0) {
          symbolIndex.bulkAddLabels(labels.map(lbl => ({
            labelId: lbl.labelId,
            labelFileId: lbl.labelFileId,
            model: lbl.model,
            language: lbl.language,
            text: lbl.text,
            comment: lbl.comment,
            filePath: lbl.filePath,
          })));
          insertedCount = labels.length;
        }
      } catch (e: any) {
        return {
          content: [{ type: 'text', text: `❌ Error updating label index: ${e.message}` }],
          isError: true,
        };
      }

      symbolIndex.touchLastIndexed?.();

      return {
        content: [{
          type: 'text',
          text: `✅ Label index updated for **${path.basename(filePath)}** (model: ${model}, language: ${language}).\n\n` +
            `Removed: ${removedCount} stale entr${removedCount === 1 ? 'y' : 'ies'}\n` +
            `Inserted: ${insertedCount} label${insertedCount !== 1 ? 's' : ''}`,

        }],
      };
    }

    const parser = new XppMetadataParser();

    console.error(`[update_symbol_index] Re-indexing ${objectType} "${objectName}" (model: ${model})`);

    // 1. Remove all existing symbols for this file so stale entries don't linger.
    // removeSymbolsByFile matches every stored path form (absolute Windows path
    // or PackagesLocalDirectory-relative, either slash style) — see symbolIndex.ts.
    const { deletedCount } = symbolIndex.removeSymbolsByFile(filePath);

    // 1b. Refresh C# bridge metadata provider so it picks up the updated file
    try {
      const refreshResult = await bridgeRefreshProvider(context.bridge);
      if (refreshResult) {
        console.error(`[update_symbol_index] Bridge provider refreshed in ${refreshResult.elapsedMs}ms`);
      }
    } catch (e) {
      console.error(`[update_symbol_index] Bridge refresh skipped: ${e}`);
    }

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
            description: classData.documentation,
            extendsClass: classData.extends,
            implementsInterfaces: classData.implements?.join(', '),
          });
          insertedCount++;
          for (const method of classData.methods ?? []) {
            const params = method.parameters?.map((p: any) => `${p.type} ${p.name}`).join(', ') ?? '';
            symbolIndex.addSymbol({
              name: method.name,
              type: 'method',
              parentName: classData.name,
              signature: `${method.returnType} ${method.name}(${params})`,
              filePath,
              model,
              source: method.source,
            });
            insertedCount++;
          }
        });
        insert();
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
            const params = method.parameters?.map((p: any) => `${p.type} ${p.name}`).join(', ') ?? '';
            symbolIndex.addSymbol({
              name: method.name,
              type: 'method',
              parentName: tableData.name,
              signature: `${method.returnType} ${method.name}(${params})`,
              filePath,
              model,
              source: method.source,
              sourceSnippet: method.sourceSnippet,
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
    } else if (objectType === 'form' || objectType === 'form-extension') {
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

    return {
      content: [{
        type: 'text',
        text: `✅ Symbol index updated for **${objectName}** (${objectType}, model: ${model}).\n\n` +
          `Removed: ${deletedCount} stale entr${deletedCount === 1 ? 'y' : 'ies'}\n` +
          `Inserted: ${insertedCount} symbol${insertedCount !== 1 ? 's' : ''}`
      }]
    };
  } catch (error: any) {
    console.error('Error updating symbol index:', error);
    return {
      content: [{ type: 'text', text: `❌ Error updating symbol index: ${error.message}` }],
      isError: true
    };
  }
};
