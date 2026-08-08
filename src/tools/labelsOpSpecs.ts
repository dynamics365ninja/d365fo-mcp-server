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
    '"already exists" warning. Default false. One call replaces search-then-create. It never ' +
    'overwrites — use action="update" for that.',
  createLabelFileIfMissing:
    '[create] Create the AxLabelFile structure if missing (default: true). A wrong-path guard still ' +
    'fails loudly when the model directory is not found, so no phantom file is produced. ' +
    'Set false to fail fast instead.',
  sortLabels:
    '[create] Sort labels alphabetically in .label.txt (default true, from LABEL_SORT_ORDER env; ' +
    'false = append at end).',
  languages:
    '[create] string[] — restrict which language .label.txt files are written (e.g. ["en-US"]). ' +
    'Omitted = every language folder present in the model.',
  defaultComment:
    '[create] Developer comment for languages without an explicit comment.',
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
};

/** The contract rendered for get_knowledge(kind="op-spec", topic="labels"). */
export function renderLabelsOpSpec(): string {
  return [
    'labels — write plumbing (action=create / action=rename)',
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
