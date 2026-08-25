/**
 * Op-spec lookup — the on-demand replacement for the parameter contracts that
 * used to be inlined in the `d365fo_file` and `generate_object` wire schemas.
 *
 * Issue #825: those two schemas were 18,5 KB of the 63 KB ListTools payload,
 * re-sent on every request, because each inlined a discriminated union of every
 * operation and its parameters. The discriminators (`action`, `operation`,
 * `objectType`, `mode`, `pattern`) stay in the schema as closed enums — the
 * parameters behind the one the agent picks are fetched here, once.
 *
 * Reachable as get_knowledge(kind="op-spec", topic="<operation|objectType|mode>");
 * every validation error that reports a missing parameter names that call, so
 * the contract is never more than one lookup away.
 */

import {
  D365FO_FILE_OP_SPECS,
  renderOpSpec,
  renderCreatePropertySpec,
} from './d365foFileOpSpecs.js';
import {
  GENERATE_OBJECT_MODE_SPECS,
  renderGenerateObjectSpec,
} from './generateObjectOpSpecs.js';
import { LABELS_OVERRIDE_PARAMS, renderLabelsOpSpec } from './labelsOpSpecs.js';
import { d365foFileTool } from '../../server/toolSchemas/d365foFile.js';

/**
 * Every objectType the schema offers, taken from the published enum so the
 * lookup answers for ALL of them — including the ones that take no extra
 * `properties`. Falling through to the index for a valid objectType would read
 * as "that type does not exist".
 */
const D365FO_FILE_OBJECT_TYPES: readonly string[] =
  (d365foFileTool.inputSchema.properties.objectType.enum as readonly string[]);

/** Tool-qualified topics (`d365fo_file.add-index`) resolve to the bare key. */
const TOOL_PREFIXES = ['d365fo_file.', 'd365fo_file:', 'generate_object.', 'generate_object:'];

/** Topics that resolve to the `labels` write-plumbing contract. */
const LABELS_TOPICS = ['labels', 'label', 'labels.create', 'labels.rename', 'create-label'];

/**
 * Real questions that are not op-specs, answered with the tool that does answer them.
 *
 * These are asked, and the catalogue is the wrong reply: a caller who has just been
 * told "Final name: X (prefix auto-applied)" and wants to know how the prefix is
 * chosen reaches for topic="naming" or topic="prefix", gets back the full list of 30
 * modify operations, and is no closer — twice in one observed session, ~2 round trips
 * spent on a dead end at the exact moment the caller was already unsure about a name.
 */
const TOPIC_REDIRECTS: Record<string, string> = {
  // `delete` is an ACTION, not an operation, so it has no entry in
  // D365FO_FILE_OP_SPECS to resolve against — and it is the one action whose
  // contract a caller most wants before calling it. Without this it fell through
  // to the catalogue of 33 modify operations, none of which is what was asked.
  delete: 'delete',
  'delete-object': 'delete',
  'remove-object': 'delete',
  naming: 'naming',
  prefix: 'naming',
  'object-naming': 'naming',
  'model-prefix': 'naming',
  'extension-prefix': 'naming',
  suffix: 'naming',
};

const REDIRECT_ANSWERS: Record<string, string> = {
  delete: [
    'd365fo_file(action="delete") — remove an AOT object from the model.',
    '',
    'Removes the object XML from disk AND the <Content Include> entry from every .rnrproj of the',
    'model that lists it. Confirm with the user first, and run find_references first — every',
    'remaining reference becomes a compile error. Recovery is only partial: when the model directory',
    'is under git, undo_last_modification(filePath=…) restores the XML but NOT the project entries.',
    '',
    '  REQUIRED objectType (string): the same enum action="create" takes. It must match the AOT',
    '      folder the file actually sits in — a mismatch is refused, because the un-register step',
    '      builds its <Content Include> from it and would clean a different object.',
    '  REQUIRED objectName (string): base name; the model prefix is applied on a miss, so the name',
    '      passed to create resolves too. Optional when filePath is given (derived from the basename).',
    '  optional modelName (string): owning model — auto-detected when omitted.',
    '  optional filePath (string): absolute path to the .xml, bypassing lookup.',
    '  optional packagePath (string): packages root, for metadata outside PackagesLocalDirectory.',
    '  optional projectPath (string): a .rnrproj to include in the set searched for includes to remove.',
    '  optional groundingToken (string): from prepare(mode="change"). Required for *-extension',
    '      objects when GROUNDING_ENFORCE=true — the same gate create and modify apply.',
    '',
    'Refused, never silently skipped: an object that resolves to nothing (❌, so a wrong name is not',
    'read as a completed delete), an objectType that disagrees with the file\'s AOT folder, a file in',
    'a standard Microsoft model, one owned by a different custom model than the write anchor, and any',
    'path outside the allowed metadata roots. A project that lists the object but whose entry could',
    'not be removed is reported as ⚠️, never as "no project referenced it".',
    '',
    'Deleting a form control or a privilege entry point instead of a whole object:',
    '  get_knowledge(kind="op-spec", topic="remove-control")',
    '  get_knowledge(kind="op-spec", topic="remove-entry-point")',
  ].join('\n'),
  naming: [
    'Naming is not an op-spec — it is resolved per model, so ask the tools that know your model:',
    '',
    '  validate_object_naming(objectType, proposedName[, baseObjectName])',
    '      → the rules applied, the effective prefix and where it came from, and a conflict check.',
    '  get_workspace_info()',
    '      → the model, the effective prefix, and the extension token this server applies.',
    '  prepare(mode="create", objectName, objectType)',
    '      → the exact final name d365fo_file(action="create") will write, collision-checked.',
    '',
    'The short version:',
    '  • Pass the BASE name to d365fo_file(action="create") — the prefix is applied for you.',
    '    Do NOT pre-apply it and do NOT add a leading separator; both double up.',
    '  • The prefix is inferred from the model\'s own objects and beats EXTENSION_PREFIX.',
    '    Pin the configured value instead with naming.prefixSource=config.',
    '  • Regular objects keep the model\'s separator (ConSK_MyEnum); extension elements',
    '    use the PascalCase infix without one (MyTable.ConSkExtension,',
    '    MyTableConSk_Extension).',
  ].join('\n'),
};

function normalize(topic: string): string {
  let t = topic.trim();
  for (const prefix of TOOL_PREFIXES) {
    if (t.toLowerCase().startsWith(prefix)) {
      t = t.slice(prefix.length);
      break;
    }
  }
  return t.toLowerCase();
}

/** Case-insensitive key match against a spec registry. */
function findKey(registry: Record<string, unknown>, needle: string): string | undefined {
  return Object.keys(registry).find(k => k.toLowerCase() === needle);
}

/**
 * Resolution/placement params d365fo_file accepts for ANY action. They are not
 * in the published schema (they are auto-detected in the normal path and cost
 * ~370 B per request there), so they are documented here and accepted nested in
 * `params` — the dispatcher merges `{...args, ...args.params}`.
 */
const D365FO_FILE_OVERRIDE_PARAMS: Record<string, string> = {
  packageName: 'Package name — auto-resolved from modelName; pass only if they differ.',
  packagePath: 'Base package path (default: auto-detected PackagesLocalDirectory).',
  solutionPath: 'VS solution directory — used to find the .rnrproj when projectPath is unset.',
  workspacePath: '[modify] Workspace path used to locate the object file.',
  bpCheck:
    '[create|modify] true = run the best-practice check on the object in THIS call, ' +
    'instead of spending a round trip on run_bp_check afterwards. Off by default: ' +
    'xppbp needs the compiler and takes seconds, which is the wrong trade for the common case. ' +
    'The write result already carries an on-disk + .rnrproj verification without it.',
};

/** Every topic the lookup answers, grouped for the index listing. */
export function opSpecTopics(): { modifyOperations: string[]; createObjectTypes: string[]; generateModes: string[] } {
  return {
    modifyOperations: Object.keys(D365FO_FILE_OP_SPECS),
    createObjectTypes: [...D365FO_FILE_OBJECT_TYPES],
    generateModes: Object.keys(GENERATE_OBJECT_MODE_SPECS),
  };
}

/** The catalogue returned when no topic (or an unrecognised one) is given. */
export function renderOpSpecIndex(unknownTopic?: string): string {
  const topics = opSpecTopics();
  const head = unknownTopic
    ? `No op-spec for topic '${unknownTopic}'. Ask for one of these instead:`
    : 'Op-spec lookup — get_knowledge(kind="op-spec", topic="<one of these>"):';
  return [
    head,
    '',
    'd365fo_file(action="modify") operations:',
    `  ${topics.modifyOperations.join(', ')}`,
    '',
    'd365fo_file(action="create") objectTypes (the `properties` contract):',
    `  ${topics.createObjectTypes.join(', ')}`,
    '',
    'generate_object modes:',
    `  ${topics.generateModes.join(', ')}`,
    '',
    'd365fo_file(action="delete") — the contract for removing an object (topic="delete").',
    '',
    'd365fo_file resolution overrides (any action, nested in `params`):',
    ...Object.entries(D365FO_FILE_OVERRIDE_PARAMS).map(([k, v]) => `  ${k}: ${v}`),
    '',
    'labels write plumbing (topic="labels", nested in `params`):',
    `  ${Object.keys(LABELS_OVERRIDE_PARAMS).join(', ')}`,
  ].join('\n');
}

/**
 * The op-spec section `prepare` carries in its own output.
 *
 * Deferring the parameter contracts out of the wire schema (#825) traded schema
 * bytes for a DISCOVERY HOP: nearly every write flow then spent a round trip on
 * get_knowledge(kind="op-spec", …) — or, worse, a failed write that returned the
 * spec in its error. prepare already knows the objectType and, for a change, the
 * method, so it can hand the contract over in the call the agent was making
 * anyway. That is a few hundred bytes against a whole round trip.
 *
 * `operation` is used when the caller names one. Otherwise a change targeting a
 * method is going to write one, so add-method's contract is the right guess; a
 * change with no method has no confident guess and only gets the pointer.
 *
 * SEVERAL operations, not one. An ordinary table change is add-field AND
 * add-index AND add-field-to-field-group; rendering only the first still left
 * the agent to spend a get_knowledge(kind="op-spec") round trip on the rest,
 * which is the hop this section exists to remove (get_knowledge was called 186
 * times against 81 prepares in the sampled sessions). `operation` therefore
 * accepts a comma-separated string or an array — a clause in the wire schema
 * rather than a second parameter block, because ListTools bytes are billed
 * every session.
 */
function splitOperations(operation: unknown): string[] {
  const raw = Array.isArray(operation) ? operation : [operation];
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string') continue;
    for (const part of entry.split(',')) {
      const t = part.trim();
      // De-duplicate: "add-field,add-field" must not print the contract twice.
      if (t && !out.includes(t)) out.push(t);
    }
  }
  return out;
}

export function renderPrepareOpSpec(args: {
  mode: 'change' | 'create';
  objectType?: string;
  operation?: string | string[];
  methodName?: string;
}): string[] {
  const { mode, objectType, operation, methodName } = args;
  const lines: string[] = [];

  if (mode === 'create') {
    if (!objectType) return lines;
    lines.push(`### Write contract — d365fo_file(action="create", objectType="${objectType}")`);
    lines.push(renderCreatePropertySpec(objectType));
    lines.push('');
    return lines;
  }

  const requested = splitOperations(operation);
  const resolved: string[] = [];
  const unknown: string[] = [];
  for (const name of requested) {
    const key = findKey(D365FO_FILE_OP_SPECS, normalize(name));
    if (key) {
      if (!resolved.includes(key)) resolved.push(key);
    } else {
      unknown.push(name);
    }
  }
  // A method-targeting change is going to write a method, so add-method is the
  // right guess when nothing resolved.
  if (resolved.length === 0 && methodName) resolved.push('add-method');

  if (resolved.length === 0) {
    lines.push(
      '### Write contract',
      'Pick the operation, then get_knowledge(kind="op-spec", topic="<operation>") for its parameters — ' +
      'or pass `operation` to prepare (comma-separated for several) and the contracts come back here.',
    );
    if (unknown.length > 0) {
      lines.push(`_No operation matched ${unknown.map(u => `"${u}"`).join(', ')}._`);
    }
    return lines;
  }

  for (const op of resolved) {
    lines.push(`### Write contract — d365fo_file(action="modify", operation="${op}")`);
    lines.push(renderOpSpec(op));
  }
  if (unknown.length > 0) {
    lines.push(
      `_No operation matched ${unknown.map(u => `"${u}"`).join(', ')} — ` +
      'get_knowledge(kind="op-spec") lists every operation name._',
    );
  }
  if (resolved.length > 1) {
    // The point of asking for several at once: they can also be WRITTEN at once.
    lines.push('_All of the above can go in ONE d365fo_file(action="modify") call via `operations[]`._');
  }

  lines.push('');
  return lines;
}

/**
 * Resolve one topic to its full parameter contract. Resolution order is
 * modify operation → generate_object mode → create objectType; the three key
 * spaces do not overlap, so the order only decides what an ambiguous future
 * key would hit.
 */
export function lookupOpSpec(topic?: string): string {
  if (!topic || !topic.trim()) return renderOpSpecIndex();
  const needle = normalize(topic);

  const operation = findKey(D365FO_FILE_OP_SPECS, needle);
  if (operation) return renderOpSpec(operation);

  const mode = findKey(GENERATE_OBJECT_MODE_SPECS, needle);
  if (mode) return renderGenerateObjectSpec(mode);

  const objectType = D365FO_FILE_OBJECT_TYPES.find(t => t.toLowerCase() === needle);
  if (objectType) return renderCreatePropertySpec(objectType);

  if (LABELS_TOPICS.includes(needle)) return renderLabelsOpSpec();

  const redirect = TOPIC_REDIRECTS[needle];
  if (redirect && REDIRECT_ANSWERS[redirect]) return REDIRECT_ANSWERS[redirect];

  return renderOpSpecIndex(topic);
}
