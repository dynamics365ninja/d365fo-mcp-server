/**
 * `labels` write-plumbing parameter specs — fetched on demand instead of being
 * inlined in the wire schema.
 *
 * Same trade as issue #825 made for d365fo_file and generate_object: `labels`
 * was the single largest tool in the ListTools payload (6,197 of 53,450 chars,
 * against a 6,200 per-tool cap), and most of that was create/rename plumbing —
 * packageName, packagePath, projectPath, solutionPath, addToProject,
 * createLabelFileIfMissing, sortLabels, languages, searchPaths, updateIndex,
 * allowExtensionLabelFile, defaultComment, description. Every one of them is
 * auto-resolved in the normal path, so the overwhelmingly common call never
 * names any of them — yet all thirteen were re-sent on every single request.
 *
 * They remain fully accepted: the handler merges `{...args, ...args.params}`,
 * so both the flat and the nested spelling work. Reachable as
 * get_knowledge(kind="op-spec", topic="labels").
 *
 * tests/tools/labelsOpSpecs.test.ts guards that the schema and this file do not
 * drift apart — a parameter must be in exactly one of them.
 */

/** Parameter name → its contract. Everything here is accepted but unpublished:
 *  the thirteen above left the wire schema, and createIfMissing was added here
 *  rather than to it (the payload had 124 chars of headroom). */
export const LABELS_OVERRIDE_PARAMS: Record<string, string> = {
  packageName:
    '[create|rename] Package name for the model. Auto-resolved if omitted.',
  packagePath:
    '[create|rename] Root packages path. Auto-detected from environment config if omitted.',
  projectPath:
    '[create] Path to the .rnrproj project file. Auto-detected from .mcp.json if omitted.',
  solutionPath:
    '[create] Path to the .sln solution directory. Fallback to find .rnrproj if projectPath is not set.',
  addToProject:
    '[create] Add label file XML descriptors to the VS project (default: true).',
  createIfMissing:
    '[create] Upsert-lite: create the label when absent, and when it already exists reuse it ' +
    '(existing text untouched) and report "@labelFileId:labelId" as a success instead of an ' +
    '"already exists" warning. Default false — PASS IT. A search before a create is never ' +
    'necessary with it: this one call IS the search-then-create pair. Combine with labels[] to ' +
    'do a whole object\'s labels in one call. It never overwrites — use action="update" for that.',
  createLabelFileIfMissing:
    '[create] Create the AxLabelFile structure if missing (default: true). A wrong-path guard still ' +
    'fails loudly when the model directory is not found, so no phantom file is produced. ' +
    'Set false to fail fast instead.',
  sortLabels:
    '[create] Sort labels alphabetically in .label.txt (default true, from LABEL_SORT_ORDER env; ' +
    'false = append at end).',
  languages:
    '[create] string[] — restrict which language .label.txt files are written (e.g. ["en-US"]). ' +
    'Omitted = every language the label file already has; a supplied translation adds a language ' +
    'only when LABEL_LANGUAGES lists it (exact code, fi is not fi-FI), else it is reported as "Not ' +
    'written"; a label file with no language yet starts with every LABEL_LANGUAGES language. Pass ' +
    'it only to add a language to a label file on purpose.',
  defaultComment:
    '[create] Developer comment for languages without an explicit comment. On update, an existing ' +
    'comment is replaced only by a comment, defaultComment or description the call states.',
  description:
    '[create] Label description (comment line in .label.txt). Defaults to the VS project name from ' +
    '.rnrproj when omitted, then falls back to labelFileId. Per-translation comment and ' +
    'defaultComment take priority.',
  searchPaths:
    '[rename] string[] — additional absolute directory paths to scan for X++ / XML references.',
  updateIndex:
    '[create|rename] Update the MCP label index after writing (default: true).',
  allowExtensionLabelFile:
    '[create|rename] Allow writing to a label file EXTENSION ("_Extension" marker). Default false — ' +
    "new labels belong in the model's ORIGINAL label file.",
  exact:
    '[search] true = exact lookup: the labels whose TEXT equals the given text after normalising both ' +
    'sides (Unicode NFC, trimmed, inner whitespace runs as one space, case-insensitive incl. umlauts). ' +
    'No word match, substring, stemming or ranking. Searches every label file and model in that ' +
    'language; model / labelFileId narrow it. Text from query (string or string[], in `language`, ' +
    'default en-US) and/or texts[]. Answer, one block per text: `"<text>" (<language>) — N exact match(es):`, ' +
    'with more than one match a distribution line `N exact matches: <model> (custom): <file> n; ' +
    '<model>: <file> n, <file> n` (custom models first, then by count; at most 8 model/label-file groups, ' +
    'then "and N more groups"), then `@File:Id  [model]  <language>: "<text>"` per listed match followed by ' +
    'that label\'s other indexed languages, one line each, then `… and N more exact match(es)`. Listed ' +
    'order is fixed: custom models (CUSTOM_MODELS, EXTENSION_PREFIX, D365FO_MODEL_NAME) first, then label ' +
    'file id, then label id, case-insensitive; the cut (maxMatches) comes after sorting, so a custom copy ' +
    'is never the one left out. With no custom model configured every model counts as standard. ' +
    'No match: `no exact match for "<text>" (<language>)`, with "language X is not indexed" when it has ' +
    'no rows, and a warning when the candidate set was cut off. Not counted toward the search-call budget ' +
    'and never answered with a STOP notice: it is deterministic, so one call per label and language is fine.',
  maxMatches:
    '[search, exact=true] Integer 1..50, default 20: exact matches listed per text (each with its ' +
    'translations). The count, the distribution line and "… and N more" always cover all of them. ' +
    'Out of range is an error.',
  texts:
    '[search, exact=true] [{language, text}, …], max 12 per call together with query — e.g. ' +
    '[{language:"en-US", text:"Posting"}, {language:"de", text:"Buchungen"}]. Each entry is looked up ' +
    'on its own; a missing language means `language` (default en-US).',
};

/** The contract rendered for get_knowledge(kind="op-spec", topic="labels"). */
export function renderLabelsOpSpec(): string {
  return [
    'labels — write plumbing (action=create / action=rename) and exact search (action=search, exact=true)',
    '',
    'Exact lookup — "which label\'s text is exactly X?", one call per label is fine:',
    '  labels(action="search", exact=true, query="Posting")',
    '  labels(action="search", params={exact:true, texts:[{language:"en-US", text:"Posting"},',
    '                                                     {language:"de", text:"Buchungen"}]})',
    '  labels(action="search", exact=true, query="Buchungen", language="de", maxMatches=5)',
    '',
    'FIRST, the shape that removes the round trips (measured over 1,515 real MCP',
    'calls: 268 `labels` calls against 171 writes, and `labels`→`labels` the most',
    'frequent consecutive pair in the corpus, 177 times — nearly all of it',
    'search-then-info-then-create, once per label):',
    '  • createIfMissing=true — do NOT search first. It creates when absent and',
    '    reuses when present, so the create IS the search.',
    '  • labels=[{labelId, translations}, …] — every label of an object in ONE',
    '    call, shared labelFileId/model at the top level.',
    '  • query=["…","…","…"] on search — several phrasings in ONE call.',
    '  • best of all, no `labels` call at all: d365fo_file create/modify resolve a',
    '    raw-text label / fieldLabel to an existing or new @Ref by themselves and',
    '    report which one they used (autoCorrect=false opts out).',
    '',
    'These are accepted flat or nested in `params`; all are optional and',
    'auto-resolved when omitted, which is why they are not in the wire schema.',
    'The published schema already carries everything a normal call needs:',
    'action, labelId, labelFileId, model, translations[], labels[], query,',
    'language, maxResults, verbose, oldLabelId, newLabelId, dryRun.',
    '',
    ...Object.entries(LABELS_OVERRIDE_PARAMS).map(([k, v]) => `  ${k}: ${v}`),
  ].join('\n');
}
