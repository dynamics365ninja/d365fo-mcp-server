/**
 * Search Labels Tool
 * Full-text search across indexed AxLabelFile entries.
 * Returns matching labels with their ID, text, comment and model/language info.
 *
 * Typical use-cases:
 *  - Find existing labels before creating new ones
 *  - Discover the @ABC:MyLabel reference syntax to use in code or metadata
 *  - List all labels for a specific label file / model
 */

import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { XppServerContext } from '../../types/context.js';
import { getConfigManager } from '../../utils/configManager.js';
import {
  crossModelLabelWarning,
  formatLabelReference,
  isLabelLikelyResolvable,
  labelProvenanceWarning,
} from '../../utils/labelReference.js';
import { recordLabelSearch, repeatSearchNotice, searchBudgetNotice } from './labelSearchHistory.js';
import { createPhaseTimer } from '../../utils/phaseTimer.js';

/**
 * Emitted only when a label the current model can actually resolve was found.
 * `labels` reads it back to decide whether a batch of queries found anything
 * reusable, so keep the two in step.
 */
export const REUSABLE_MARKER = '💡 Use the label reference syntax in X++:';

/**
 * Opens the answer for a query that matched nothing. `labels` reads it back to
 * collapse those sections in a batch — a paragraph of identical advice repeated
 * once per phrasing was most of a 5 KB result — so keep the two in step.
 */
export const NO_HITS_MARKER = 'No labels found matching';

/**
 * What to do when nothing reusable came back.
 *
 * Rephrasing is the wrong next move and used to be the only one suggested: one
 * benchmark run spent 19 separate `action="search"` calls guessing English
 * wordings for the same message ("cannot be decreased", "rating cannot be
 * lowered", "%1 cannot be lower than %2"), and the answer was "create your own"
 * from the first call onwards. Every phrasing queries the same index, so say
 * that, and hand over the call that ends the loop.
 */
const CREATE_CALL_ADVICE =
  `      labels(action="create", createIfMissing=true, labelFileId="<your model's label file>",\n` +
  `             model="<your model>", labelId="<MeaningOfTheText>",\n` +
  `             translations=[{language:"en-US", text:"…"}])\n` +
  `   createIfMissing reuses the label when it already exists, so that call stands on its own:\n` +
  `   a search before a create is NEVER necessary. Several labels at once — one call, not one each:\n` +
  `      labels(action="create", createIfMissing=true, labelFileId=…, model=…,\n` +
  `             labels=[{labelId:"…", translations:[…]}, {labelId:"…", translations:[…]}])\n` +
  `   And for a label you only need in an object you are about to write, skip this entirely:\n` +
  `   d365fo_file create/modify resolve a raw-text label (or fieldLabel) themselves and report\n` +
  `   which @Ref they reused or created.\n` +
  `   Rephrasing does not help: every wording queries the same index. To try several at once,\n` +
  `   pass query as an array — labels(action="search", query=["…", "…", "…"]) — one call, not one each.\n`;

export const NO_REUSE_ADVICE =
  `➡️  Nothing reusable here — create your own label and move on:\n` + CREATE_CALL_ADVICE;

/**
 * Same call, for the branch where hits DID come back.
 *
 * NO_REUSE_ADVICE opens with "Nothing reusable here", which contradicts a verdict
 * that just reported a resolvable label. Callers resolve the contradiction by
 * searching again — the loop the verdict exists to end.
 */
export const SOME_REUSE_ADVICE =
  `➡️  If none of the hits above says what you need, create your own label and move on:\n` + CREATE_CALL_ADVICE;

const SearchLabelsArgsSchema = z.object({
  query: z
    .string()
    .describe(
      'Search text — searches label ID, label text and comments (e.g. "customer name", "MyFeature", "batch")',
    ),
  language: z
    .string()
    .optional()
    .default('en-US')
    .describe('Language/locale to search in (default: en-US). Examples: cs, de, sk, en-US'),
  model: z
    .string()
    .optional()
    .describe('Restrict results to a specific model (e.g. ContosoExt, ApplicationPlatform)'),
  labelFileId: z
    .string()
    .optional()
    .describe(
      'Restrict results to ONE label file ID (e.g. ContosoExt, SYS). Omitting it searches every label ' +
      'file at once — the default, and almost always what you want. Running the same query once per ' +
      'label file buys nothing but round trips.',
    ),
  maxResults: z
    .number()
    .optional()
    .describe('Maximum number of labels to list (default 10). Truncated sets report how many more matched.'),
  limit: z.number().optional().describe('Legacy alias of maxResults.'),
  verbose: z
    .boolean()
    .optional()
    .default(false)
    .describe('One line per label by default; true restores the multi-line text/comment/model block.'),
});

/** Labels listed per search unless the caller raises it — a broad phrase query matches dozens (#832). */
const DEFAULT_MAX_RESULTS = 10;

/**
 * How many rows to pull from the index beyond the display cap so the footer can
 * state an exact "and N more". Bounded on purpose — an exact count is not worth
 * scanning the whole label index, so past this the footer says "N+ more".
 */
const OVERFETCH_CAP = 200;

/** Best-effort current model: explicit arg → configured model → env. Never throws. */
function resolveCurrentModel(explicit?: string): string | undefined {
  if (explicit) return explicit;
  try {
    const configured = getConfigManager().getModelName();
    if (configured) return configured;
  } catch { /* config not loaded — fall through */ }
  return process.env.D365FO_MODEL_NAME || undefined;
}

export async function searchLabelsTool(request: CallToolRequest, context: XppServerContext) {
  try {
    const args = SearchLabelsArgsSchema.parse(request.params.arguments);
    const { symbolIndex } = context;
    const { query, language, model, labelFileId, verbose } = args;

    const requested = args.maxResults ?? args.limit;
    const maxResults = requested !== undefined && requested > 0 ? Math.floor(requested) : DEFAULT_MAX_RESULTS;
    // Over-fetch so the truncation footer can quantify what it hid.
    const probeLimit = Math.max(maxResults + 1, OVERFETCH_CAP);

    // Phase-timed through the same helper every slow write uses, so a `labels`
    // call that costs seconds says WHERE they went instead of only that it did.
    // Silent below SLOW_CALL_LOG_MS (10 s by default); set SLOW_CALL_LOG_MS=0 to
    // re-measure every call, which is what the 2026-08-25 audit needed and did
    // not have: a 5.6 s mean over 268 real calls that no aggregate could attribute.
    const timer = createPhaseTimer();
    const results = await timer.time('label index query (FTS5)', async () =>
      symbolIndex.searchLabels(query, { language, model, labelFileId, limit: probeLimit }));

    if (results.length === 0) {
      // Named before the advice: a caller that has already tried five wordings
      // needs to hear that it has, not the same paragraph a sixth time.
      const repeatNotice = `${searchBudgetNotice()}${repeatSearchNotice([query])}`;
      recordLabelSearch(query, true);
      return {
        content: [
          {
            type: 'text',
            text:
              `${NO_HITS_MARKER} "${query}"` +
              (language !== 'en-US' ? ` in language "${language}"` : '') +
              (model ? ` in model "${model}"` : '') +
              '.\n\n' +
              (repeatNotice ? `${repeatNotice}\n` : '') +
              NO_REUSE_ADVICE +
              `💡 To search a different language use the language parameter (e.g. "cs", "de", "sk").` +
              timer.render(),
          },
        ],
      };
    }

    recordLabelSearch(query, false);

    // Normalise column names (DB returns snake_case)
    const normalise = (r: any) => ({
      labelId: r.label_id ?? r.labelId,
      labelFileId: r.label_file_id ?? r.labelFileId,
      model: r.model,
      language: r.language,
      text: r.text,
      comment: r.comment ?? null,
    });

    const currentModel = await timer.time('resolve current model', async () => resolveCurrentModel(args.model));

    // The index was queried past the display cap; only the first maxResults are rendered.
    const hidden = Math.max(0, results.length - maxResults);
    const atProbeCap = results.length >= probeLimit;
    const total = `${results.length}${atProbeCap ? '+' : ''}`;
    const scope = `[language: ${language}${model ? `, model: ${model}` : ''}]`;

    // The stop rides on the branch that FOUND something too. A hit means the
    // model can resolve that label, not that it says what the caller needs, so
    // this branch is the one a rephrasing loop actually lives on — it used to be
    // the only one carrying no count at all.
    const budgetStop = searchBudgetNotice();

    const lines: string[] = [
      ...(budgetStop ? [budgetStop] : []),
      hidden > 0
        ? `Found ${total} label(s) matching "${query}" ${scope} — showing first ${maxResults}:`
        : `Found ${results.length} label(s) matching "${query}" ${scope}:`,
      '',
    ];

    const normalised = results.slice(0, maxResults).map(normalise);

    // Owners of the flagged rows, in result order — named once below instead of
    // repeating the same sentence on every line (#832).
    const flaggedModels: string[] = [];
    let flaggedCount = 0;

    for (const r of normalised) {
      // X++ label reference syntax — never double-prefix an id that already
      // carries its label file id (#33/#41: `@SYS:@SYS67433` is rejected by xppbp).
      const ref = formatLabelReference(r.labelFileId, r.labelId);
      const resolvable = isLabelLikelyResolvable(r.labelFileId, r.model, currentModel);
      if (!resolvable) {
        flaggedCount++;
        if (!flaggedModels.includes(r.model)) flaggedModels.push(r.model);
      }

      if (verbose) {
        lines.push(`  ${ref}${resolvable ? '' : `   ${labelProvenanceWarning(r.model)}`}`);
        lines.push(`  Text    : ${r.text}`);
        if (r.comment) lines.push(`  Comment : ${r.comment}`);
        lines.push(`  Model   : ${r.model}  |  LabelFile: ${r.labelFileId}`);
        lines.push('');
      } else {
        // One line per label: @File:Id — "Text" [owner], with ⚠️ marking the rows
        // the hoisted ownership warning below is about.
        const text = (r.text ?? '').replace(/\s+/g, ' ').trim();
        lines.push(`  ${ref} — "${text}" [${r.model}]${resolvable ? '' : ' ⚠️'}`);
      }
    }

    if (hidden > 0) {
      if (!verbose) lines.push('');
      lines.push(`… and ${hidden}${atProbeCap ? '+' : ''} more — narrow the query or raise maxResults`);
      lines.push('');
    } else if (!verbose) {
      lines.push('');
    }

    // Once per result set, not once per label (#832).
    if (flaggedCount > 0 && !verbose) lines.push(crossModelLabelWarning(flaggedModels, flaggedCount));

    // Only ever *recommend* a label the model can actually resolve — suggesting an
    // unreferenced one is what produced BPErrorUnknownLabel in the sweep (#33/#41).
    const recommended = normalised.find(r => isLabelLikelyResolvable(r.labelFileId, r.model, currentModel));
    if (recommended) {
      const ref = formatLabelReference(recommended.labelFileId, recommended.labelId);
      lines.push(`${REUSABLE_MARKER}  literalStr("${ref}")`);
      lines.push(`💡 Or in metadata XML:  <Label>${ref}</Label>`);
    } else {
      lines.push(
        `⚠️ None of these labels is in a core label file (SYS/…) or in your own model, so none is ` +
        `recommended as-is: referencing one raises BPErrorUnknownLabel unless your model references ` +
        `its package.`,
      );
      lines.push('');
      lines.push(NO_REUSE_ADVICE.trimEnd());
    }

    lines.push(timer.render());

    return {
      content: [{ type: 'text', text: lines.join('\n') }],
    };
  } catch (err: any) {
    return {
      content: [{ type: 'text', text: `Error searching labels: ${err.message}` }],
      isError: true,
    };
  }
}

// This handler has no schema of its own — it is reached through a unified
// tool. Tool registration (name, description, inputSchema) lives in
// src/server/toolSchemas/, one file per published tool, aggregated by
// toolSchemas/index.ts. It is NOT in mcpServer.ts; that file only spreads
// the aggregated array into the ListTools response.
