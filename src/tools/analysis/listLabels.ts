/**
 * labels(action="list") — page through the labels of ONE label file.
 *
 * `search` answers "which label says X"; this answers "what is in this label
 * file", with the filters an audit needs (id prefix, developer comment, a
 * language that has no translation yet). It reads the .label.txt files of every
 * language straight from disk through parseLabelFile — the same parser the
 * indexer uses — so the answer is the file's, not the index's: a label written
 * by hand, by a checkout or before the last index refresh is listed too. The
 * index is only asked WHERE the label file lives (getLabelFilePaths).
 *
 * Output is paged (maxResults + offset) and bounded in size; it never ends
 * mid-list without saying how many labels matched and how to get the rest.
 */

import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { promises as fs } from 'fs';
import * as path from 'path';
import type { XppServerContext } from '../../types/context.js';
import { parseLabelFile } from '../../metadata/labelParser.js';
import { formatLabelReference } from '../../utils/labelReference.js';

const DEFAULT_MAX_RESULTS = 50;
const MAX_MAX_RESULTS = 500;
/** Kept under the `labels` response cap (responseCaps.ts) so a page is never cut by it. */
const OUTPUT_BUDGET_CHARS = 10_000;

const ListLabelsArgsSchema = z.object({
  model: z.string().min(1),
  labelFileId: z.string().min(1),
  language: z.string().optional().default('en-US'),
  idPrefix: z.string().optional(),
  comment: z.string().optional(),
  missingLanguage: z.string().optional(),
  maxResults: z.number().optional(),
  limit: z.number().optional(),
  offset: z.number().optional(),
  verbose: z.boolean().optional().default(false),
});

interface LangEntry { text: string; comment?: string }
interface Row { labelId: string; byLang: Map<string, LangEntry> }

const norm = (lang: string) => lang.toLowerCase().replace(/_/g, '-');
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();

export async function listLabelsTool(request: CallToolRequest, context: XppServerContext) {
  try {
    const given = (request.params.arguments ?? {}) as Record<string, unknown>;
    if (!given.model || !given.labelFileId) {
      return {
        content: [{
          type: 'text',
          text: '❌ labels(action="list") needs model and labelFileId. To see which label files a model has, ' +
            'use labels(action="info", model="<model>") (without labelId).',
        }],
        isError: true,
      };
    }
    const args = ListLabelsArgsSchema.parse(given);
    const { model, idPrefix, verbose } = args;
    let labelFileId = args.labelFileId;
    const requested = args.maxResults ?? args.limit;
    const pageSize = requested !== undefined && requested > 0
      ? Math.min(MAX_MAX_RESULTS, Math.max(1, Math.floor(requested))) : DEFAULT_MAX_RESULTS;
    const offset = args.offset !== undefined && args.offset > 0 ? Math.floor(args.offset) : 0;

    let paths = context.symbolIndex.getLabelFilePaths(labelFileId, model);
    if (paths.length === 0) {
      // The path lookup is case-sensitive; getLabelFileIds falls back to NOCASE and
      // returns the stored spelling.
      const canonical = context.symbolIndex.getLabelFileIds(model, labelFileId)[0];
      if (canonical && canonical.labelFileId !== labelFileId) {
        labelFileId = canonical.labelFileId;
        paths = context.symbolIndex.getLabelFilePaths(labelFileId, model);
      }
    }
    if (paths.length === 0) {
      return {
        content: [{
          type: 'text',
          text: `❌ labels(action="list"): label file "${labelFileId}" of model "${model}" is not in the index. ` +
            `labels(action="info", model="${model}") lists the label files of the model.`,
        }],
        isError: true,
      };
    }

    // Every language of the label file that exists on disk, not only the indexed
    // ones: LABEL_LANGUAGES can leave a language out of the index, and
    // missingLanguage must not call such a language "missing".
    const resourcesDir = path.dirname(path.dirname(paths[0].filePath));
    const wantedName = (lang: string) => `${labelFileId}.${lang}.label.txt`.toLowerCase();
    const files: Array<{ language: string; file: string }> = [];
    let langDirs: string[] = [];
    try { langDirs = await fs.readdir(resourcesDir); } catch { /* index built elsewhere */ }
    for (const dir of langDirs) {
      let names: string[];
      try { names = await fs.readdir(path.join(resourcesDir, dir)); } catch { continue; }
      const hit = names.find(n => n.toLowerCase() === wantedName(dir));
      if (hit) files.push({ language: dir, file: path.join(resourcesDir, dir, hit) });
    }
    // Requested language first, then en-US, then the rest: rows are added in this order, so
    // "file order" is the order of that language's file, with labels it lacks after.
    const rank = (l: string) => (norm(l) === norm(args.language) ? 0 : norm(l) === 'en-us' ? 1 : 2);
    files.sort((a, b) => rank(a.language) - rank(b.language) || a.language.localeCompare(b.language));
    if (files.length === 0) {
      return {
        content: [{
          type: 'text',
          text: `❌ labels(action="list"): no .label.txt of "${labelFileId}" found on disk next to the indexed path ` +
            `${paths[0].filePath} — the index was built on another machine or the files were removed.`,
        }],
        isError: true,
      };
    }

    const rows = new Map<string, Row>();
    for (const f of files) {
      let content: string;
      try { content = await fs.readFile(f.file, 'utf-8'); } catch { continue; }
      for (const l of parseLabelFile(content, labelFileId, model, f.language, f.file)) {
        let row = rows.get(l.labelId);
        if (!row) rows.set(l.labelId, row = { labelId: l.labelId, byLang: new Map() });
        row.byLang.set(norm(f.language), { text: l.text, comment: l.comment });
      }
    }

    const lang = norm(args.language);
    const all = [...rows.values()];
    const commentNeedle = args.comment?.toLowerCase();
    const prefixNeedle = idPrefix?.toLowerCase();
    const missing = args.missingLanguage ? norm(args.missingLanguage) : undefined;
    const matched = all.filter(r => {
      if (prefixNeedle && !r.labelId.toLowerCase().startsWith(prefixNeedle)) return false;
      if (commentNeedle && ![...r.byLang.values()].some(e => (e.comment ?? '').toLowerCase().includes(commentNeedle))) return false;
      if (missing && (r.byLang.get(missing)?.text ?? '').trim() !== '') return false;
      return true;
    });

    const filters = [
      idPrefix ? `idPrefix "${idPrefix}"` : '',
      args.comment ? `comment "${args.comment}"` : '',
      missing ? `no "${args.missingLanguage}" translation` : '',
    ].filter(Boolean).join(', ');
    const langsOnDisk = files.map(f => f.language).sort().join(', ');
    const head = `Label file ${labelFileId} [${model}] — ${matched.length} of ${all.length} label(s)` +
      `${filters ? ` match ${filters}` : ''} (languages on disk: ${langsOnDisk})`;

    const warnings: string[] = [];
    if (missing && !files.some(f => norm(f.language) === missing)) {
      warnings.push(`⚠️ There is no .label.txt for "${args.missingLanguage}" at all, so every label counts as missing it.`);
    }
    if (!files.some(f => norm(f.language) === lang)) {
      warnings.push(`⚠️ No "${args.language}" file — the text column is empty; pass language=<one of the languages on disk>.`);
    }

    if (offset >= matched.length) {
      return {
        content: [{
          type: 'text',
          text: [head, ...warnings, '',
            matched.length === 0
              ? 'No labels match.'
              : `offset ${offset} is past the last match (${matched.length}); use offset 0..${matched.length - 1}.`,
          ].join('\n'),
        }],
      };
    }

    const render = (r: Row): string => {
      const ref = formatLabelReference(labelFileId, r.labelId);
      const primary = r.byLang.get(lang) ?? [...r.byLang.values()][0];
      const comment = oneLine((r.byLang.get(lang)?.comment ?? primary?.comment) ?? '');
      if (!verbose) {
        return `  ${ref} — "${oneLine(r.byLang.get(lang)?.text ?? '')}"${comment ? `  ;${comment}` : ''}`;
      }
      const block = [`  ${ref}${comment ? `  ;${comment}` : ''}`];
      const ordered = [...files].sort((a, b) =>
        norm(a.language) === lang ? -1 : norm(b.language) === lang ? 1 : a.language.localeCompare(b.language));
      for (const f of ordered) {
        const e = r.byLang.get(norm(f.language));
        block.push(`    [${f.language}] ${e ? oneLine(e.text) : '(missing)'}`);
      }
      return block.join('\n');
    };

    const lines: string[] = [];
    let used = head.length;
    let shown = 0;
    for (const r of matched.slice(offset, offset + pageSize)) {
      let line = render(r);
      // Always show at least one row so the offset advances; a single row that alone
      // exceeds the budget (verbose, dozens of languages) is shortened, never cut by the cap.
      if (shown > 0 && used + line.length + 1 > OUTPUT_BUDGET_CHARS) break;
      if (shown === 0 && line.length > OUTPUT_BUDGET_CHARS - 1_500) {
        line = `${line.slice(0, OUTPUT_BUDGET_CHARS - 1_500)} … (row shortened)`;
      }
      lines.push(line);
      used += line.length + 1;
      shown++;
    }
    const next = offset + shown;
    const remaining = matched.length - next;
    const out = [`${head} — showing ${offset + 1}–${next}:`, ...warnings, '', ...lines];
    if (remaining > 0) {
      out.push('', `… ${remaining} more matched (${matched.length} total). Next page: ` +
        `labels(action="list", model="${model}", labelFileId="${labelFileId}", params={offset:${next}}) ` +
        `— repeat the same filters; maxResults (max ${MAX_MAX_RESULTS}) sets the page size.`);
    } else {
      out.push('', `End of list (${matched.length} matched).`);
    }
    return { content: [{ type: 'text', text: out.join('\n') }] };
  } catch (err: any) {
    return {
      content: [{ type: 'text', text: `Error listing labels: ${err.message}` }],
      isError: true,
    };
  }
}
