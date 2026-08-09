/**
 * object_patterns(domain="form", action="repair") — auto-fill the missing
 * required top-level controls of an existing form from its declared pattern.
 *
 * The "fill an existing form" counterpart to TRUDUtils' Form Template Control
 * Builder. Loads a form (xml / formName / filePath), reads its <Pattern>,
 * generates the absent required controls from the catalog and splices them in
 * (existing controls preserved verbatim — see formControlRepair). Re-validates
 * and returns the repaired XML; it does NOT write — hand the XML to
 * d365fo_file(action="create", overwrite=true) after reviewing it.
 */

import * as fs from 'fs/promises';
import { z } from 'zod';
import { Parser } from '../../utils/xml.js';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import type { XppServerContext } from '../../types/context.js';
import { walkFormDesign } from '../../metadata/formPatternMiner.js';
import { resolvePatternExact } from '../../knowledge/formPatterns/index.js';
import { validateFormPatternXml } from '../../validation/formPatternValidator.js';
import { repairFormXml } from '../../utils/formControlRepair.js';
import { type ExpandFormOptions } from '../../utils/formControlExpander.js';
import { lookupSymbolNocase } from '../../utils/symbolLookup.js';
import { resolveIndexedFilePath } from '../../utils/packagesRoot.js';

const RepairArgsSchema = z.object({
  xml: z.string().optional().describe('Complete AxForm XML to repair. Provide this OR formName/filePath.'),
  formName: z.string().optional().describe('Name of an indexed form — loaded from the metadata store.'),
  filePath: z.string().optional().describe('Explicit path to an AxForm XML file.'),
});

function text(s: string, isError = false) {
  return { content: [{ type: 'text' as const, text: s }], ...(isError ? { isError: true } : {}) };
}

/** First datasource (name + table) declared on the form, for grid generation. */
function firstDataSource(xml: string): { name?: string; table?: string } {
  const block = xml.match(/<AxFormDataSource[^>]*>([\s\S]*?)<\/AxFormDataSource>/)?.[1];
  if (!block) return {};
  return {
    name: block.match(/<Name>([^<]+)<\/Name>/)?.[1]?.trim(),
    table: block.match(/<Table>([^<]+)<\/Table>/)?.[1]?.trim(),
  };
}

export async function repairFormControlsTool(
  request: CallToolRequest,
  context: XppServerContext,
) {
  const parsed = RepairArgsSchema.safeParse(request.params?.arguments ?? {});
  if (!parsed.success) {
    return text(`❌ Invalid parameters: ${parsed.error.message}`, true);
  }
  const { xml, formName, filePath } = parsed.data;

  // Load the form XML (same precedence as validate)
  let formXml = xml;
  let source = 'provided XML';
  try {
    if (!formXml && filePath) {
      formXml = await fs.readFile(filePath, 'utf-8');
      source = filePath;
    } else if (!formXml && formName) {
      const db = context.symbolIndex?.getReadDb?.();
      const row = db
        ?.prepare(`SELECT file_path FROM symbols WHERE type = 'form' AND name = ? LIMIT 1`)
        ?.get(formName) as { file_path?: string } | undefined;
      if (!row?.file_path) {
        return text(`❌ Form "${formName}" not found in the symbol index. Pass filePath or xml directly.`, true);
      }
      // Package-relative file_path rows resolve against the packages root, not
      // the process cwd — see resolveIndexedFilePath.
      const resolved = resolveIndexedFilePath(row.file_path);
      formXml = await fs.readFile(resolved, 'utf-8');
      source = `${formName} (${resolved})`;
    }
  } catch (e) {
    return text(`❌ Could not read form XML: ${e instanceof Error ? e.message : String(e)}`, true);
  }
  if (!formXml) {
    return text('❌ Provide one of: xml, formName, or filePath.', true);
  }

  // Resolve the declared pattern
  let design;
  try {
    const xmlParser = new Parser({ explicitArray: false, mergeAttrs: true, trim: true });
    const tree = await xmlParser.parseStringPromise(formXml);
    if (!tree?.AxForm?.Design) {
      return text('❌ Not an AxForm document, or it has no <Design>.', true);
    }
    design = walkFormDesign(tree.AxForm.Design);
  } catch (e) {
    return text(`❌ XML parse error: ${e instanceof Error ? e.message.split('\n')[0] : 'invalid XML'}`, true);
  }

  if (!design.pattern) {
    return text(
      `ℹ️ ${source} declares no <Pattern> on Design — nothing to repair against.\n\n` +
        `Assign a pattern first (object_patterns(domain="form", action="analyze") to pick one), then repair.`,
    );
  }
  const spec = resolvePatternExact(design.pattern);
  if (!spec) {
    return text(
      `❌ Form declares an unknown pattern "${design.pattern}" — cannot repair. ` +
        `Fix the <Pattern> value first (object_patterns(domain="form", action="validate")).`,
      true,
    );
  }

  // Build generation options from the form's own datasource
  const formNameInXml = formXml.match(/<AxForm[^>]*>[\s\S]*?<Name>([^<]+)<\/Name>/)?.[1]?.trim();
  const ds = firstDataSource(formXml);
  let gridFields: string[] | undefined;
  if (ds.table) {
    try {
      const db = context.symbolIndex.getReadDb();
      // Canonicalize first — `parent_name = ? COLLATE NOCASE` cannot use
      // idx_parent_type_name and scans all 360k field rows (180 s cold).
      const canonical = lookupSymbolNocase(db, ds.table)?.name ?? ds.table;
      const rows = db
        .prepare(`SELECT name FROM symbols WHERE type = 'field' AND parent_name = ? ORDER BY name`)
        .all(canonical) as Array<{ name: string }>;
      gridFields = rows
        .map((r) => r.name)
        .filter((n) => !['RecId', 'RecVersion', 'DataAreaId', 'Partition'].includes(n))
        .slice(0, 8);
    } catch {
      /* index unavailable — grids will be emitted empty */
    }
  }
  const opt: ExpandFormOptions = {
    formName: formNameInXml ?? formName ?? 'Form',
    dsName: ds.name,
    dsTable: ds.table,
    gridFields,
  };

  // Before / after validation around the splice
  const before = await validateFormPatternXml(formXml);
  const beforeErrors = before.violations.filter((v) => v.severity === 'error').length;

  const result = repairFormXml(formXml, spec, opt);

  if (!result.changed) {
    const unfixNote =
      result.unfixable.length > 0
        ? `\n\nCould not auto-add:\n` + result.unfixable.map((u) => `  • ${u.id} — ${u.reason}`).join('\n')
        : '';
    return text(
      `✅ ${source} — no missing required top-level controls for pattern **${spec.xmlName}**. Nothing to repair.` +
        (beforeErrors > 0
          ? `\n\n⚠️ ${beforeErrors} pattern error(s) remain, but they are deeper than the top level (sub-pattern/order/child issues). Use action="validate" to see them.`
          : '') +
        unfixNote,
    );
  }

  const after = await validateFormPatternXml(result.xml);
  const afterErrors = after.violations.filter((v) => v.severity === 'error').length;

  const lines: string[] = [
    `🛠️ Repaired **${spec.xmlName}** form (${source})`,
    ``,
    `Added ${result.added.length} required control(s):`,
    ...result.added.map((a) => `  • ${a.type} ("${a.id}")`),
    ``,
    `Pattern errors: ${beforeErrors} → ${afterErrors}.`,
  ];
  if (result.unfixable.length > 0) {
    lines.push('', 'Still needs manual attention:', ...result.unfixable.map((u) => `  • ${u.id} — ${u.reason}`));
  }
  lines.push(
    '',
    `**Next step:** review the XML, then write it with ` +
      `\`d365fo_file(action="create", objectType="form", objectName="${opt.formName}", overwrite=true, xmlContent="…")\`.`,
    '',
    '```xml',
    result.xml,
    '```',
  );
  return text(lines.join('\n'), afterErrors > beforeErrors);
}
