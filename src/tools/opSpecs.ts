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
import { d365foFileTool } from '../server/toolSchemas/d365foFile.js';

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
 */
export function renderPrepareOpSpec(args: {
  mode: 'change' | 'create';
  objectType?: string;
  operation?: string;
  methodName?: string;
}): string[] {
  const { mode, objectType, operation, methodName } = args;
  const lines: string[] = [];

  if (mode === 'create') {
    if (!objectType) return lines;
    lines.push(`### Write contract — d365fo_file(action="create", objectType="${objectType}")`);
    lines.push(renderCreatePropertySpec(objectType));
  } else {
    const op = operation && findKey(D365FO_FILE_OP_SPECS, normalize(operation))
      ? findKey(D365FO_FILE_OP_SPECS, normalize(operation))!
      : (methodName ? 'add-method' : undefined);
    if (!op) {
      lines.push(
        '### Write contract',
        'Pick the operation, then get_knowledge(kind="op-spec", topic="<operation>") for its parameters — ' +
        'or pass `operation` to prepare and the contract comes back here.',
      );
      return lines;
    }
    lines.push(`### Write contract — d365fo_file(action="modify", operation="${op}")`);
    lines.push(renderOpSpec(op));
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

  return renderOpSpecIndex(topic);
}
