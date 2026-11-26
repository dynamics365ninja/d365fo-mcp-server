/**
 * Cross-model write guard.
 *
 * `modify` already refuses to touch objects in standard Microsoft models
 * (isStandardModel), but that check says nothing about the far more common
 * real-world layout: a customer solution split across several CUSTOM models,
 * e.g. a shared `ContosoFinanceCore` plus country models `ContosoFinanceSK` /
 * `ContosoFinanceCZ` that extend it. The workspace's .rnrproj names exactly ONE of
 * them as the target model; every other model is somebody else's code as far as
 * this workspace is concerned.
 *
 * Without this guard the failure is silent and expensive: asked to "add a field
 * to <table>", the agent resolves the table by name, lands in the shared model
 * that happens to own it, and edits it in place. The field is then invisible in
 * the active model's project and version control, and it lands in code every
 * other country model inherits — instead of the one thing that was wanted, a
 * table extension in the active model.
 *
 * ## Consent cannot be self-served
 *
 * The first version of this guard accepted `modelName="<owning model>"` on the
 * call as consent, mirroring the standard-model guard's "explicit modelName =
 * you know what you're doing". For a human that reasoning holds. For an agent it
 * does not: the refusal text told it which parameter to add, so it added the
 * parameter and wrote into the shared model anyway — with a well-argued
 * explanation afterwards. A bypass the caller can mint for itself is not a
 * bypass, it is a speed bump.
 *
 * So consent lives in server configuration, which the caller cannot reach
 * through any tool this server publishes:
 *   - `D365FO_CROSS_MODEL_WRITE_MODELS=ModelA,ModelB` — allow these models,
 *   - `D365FO_ALLOW_CROSS_MODEL_WRITE=true`           — allow any model.
 *
 * It used to take a restart as well, which quietly worked against the guard: the
 * only sanctioned answer cost the user their session, so the pressure was all
 * towards finding a cheaper one. The policy is now re-read from .env on the next
 * attempt (reloadWritePolicy) — the decision stays the user's, it just no longer
 * costs a restart to act on.
 *
 * And the refusal deliberately does NOT hand the caller a workaround: it names
 * the extension route, and says the alternative is the user's decision to make
 * in configuration.
 *
 * ## "The agent has no tool to write it" holds only for THIS server's tools
 *
 * The caller is a coding assistant with generic file editing, and the settings
 * are plain JSON. One refusal was enough for it to find the host's mcp.json and
 * add the allow-list key to the env block itself — writes into the other model
 * then succeeded with a clean ✅, and the only trace was a console.error in a log
 * truncated on every restart, including the one the settings edit triggers.
 *
 * The guard cannot tell which hand wrote its configuration. What it can do is
 * refuse to be quiet: the blanket switch, which lets a write through into ANY
 * model, returns a note the caller prints on its result (standDownNotice), so it
 * reaches the transcript rather than a log nobody opens.
 *
 * ## A workspace develops a SET of models (#1332)
 *
 * The guard first measured every write against one model, the anchor, and
 * treated every other custom model as foreign. That premise is wrong for most
 * real workspaces: a model comes with its test model, a partner solution spans
 * several models, a customer inherits the models of several partners. Writes
 * into a model of the workspace (workspace/workspaceModels.ts: the anchor, the
 * models of the anchor project's solution, `workspace.models`) are ordinary
 * writes now. They are neither refused nor flagged: a note on every write into
 * the test model told the agent to undo correct work.
 *
 * What stays refused is what this guard was written for: a custom model the
 * workspace neither builds in its solution nor lists, i.e. code it consumes.
 */

import { resolveObjectPrefix, applyObjectPrefix, isAsGivenNamingMode, isNoPrefixMode } from './modelClassifier.js';
import { reloadWritePolicy, writePolicyFiles } from './loadEnv.js';
import { isExcludedWorkspaceModel, isWorkspaceModel, workspaceModels } from '../workspace/workspaceModels.js';
import { resolveFormattedExtensionName } from './objectNaming.js';
import type { ModelDependency } from '../metadata/modelDescriptor.js';

/** An extension of the target object that already exists in the active model. */
export interface ExistingExtension {
  name: string;
  type: string;
}

export interface CrossModelWriteCheck {
  /** Object being written, as resolved (may already be an extension). */
  objectName: string;
  /** d365fo_file objectType, e.g. 'table', 'table-extension', 'class'. */
  objectType: string;
  /** Model that owns the write target (the `<Model>` path segment, or the model asked for). */
  owningModel: string | null | undefined;
  /**
   * `<Package>` segment of the same path. A match on EITHER segment counts as
   * "same model": most custom models sit in a package of the same name, but a
   * configured model name occasionally matches only the package (several models
   * in one package, or a model folder named after the package). Accepting both
   * keeps the guard from firing on the workspace's own objects.
   */
  owningPackage?: string | null;
  /**
   * Model the workspace targets (.rnrproj / D365FO_MODEL_NAME) — the WRITE ANCHOR,
   * `configManager.getWriteAnchorModel()`. Not simply "the current active model":
   * after a tool-initiated project switch those differ, and taking the switched
   * value here would let the caller move the target it is being measured against.
   */
  activeModel: string | null | undefined;
  /**
   * Model a `get_workspace_info(projectName=…)` switch made active during this
   * session, when that differs from the anchor. Wording only — it names the
   * bypass out loud instead of letting it read as an unrelated refusal.
   */
  toolSwitchedModel?: string | null;
  /** Extensions of the base object that already exist in the active model. */
  existingExtensions?: ExistingExtension[];
  /**
   * Wording only — what the caller was about to do. 'delete' also suppresses the
   * "extend it from your model instead" remedy: that is the answer for a write
   * that wanted to CHANGE a foreign object, and an extension cannot un-define
   * one, so offering it to a caller who asked to remove something is advice that
   * cannot be followed.
   */
  action?: 'modify' | 'create' | 'delete';
  /**
   * Wording only — a dry run that previews the write. standDownNotice then says
   * what WOULD be written instead of reporting a write that never happened.
   */
  dryRun?: boolean;
  /**
   * Wording only — how `owningModel` stands to `activeModel`, from their descriptors
   * (resolveModelDependency). When the owning model is built ON the active one, a
   * test model being the common case, the active model cannot see it, so "extend it
   * from the active model instead" is advice that cannot compile. Absent or null
   * means "not known", and the usual advice stands.
   */
  dependency?: ModelDependency | null;
  /**
   * The workspace's other models (besides `activeModel`). Absent means "ask
   * workspace/workspaceModels.ts", which is what every writer wants; tests pass
   * it to state the workspace outright.
   */
  workspaceModels?: readonly string[];
}

/** True when the write stays inside the models this workspace develops. */
function staysInWorkspace(check: CrossModelWriteCheck): boolean {
  const { owningModel, activeModel, owningPackage } = check;
  if (activeModel && (eq(owningModel, activeModel) || eq(owningPackage, activeModel))) return true;
  // `workspace.excludeModels` outranks every other reason below (#1342).
  if (!check.workspaceModels && isExcludedWorkspaceModel(owningModel)) return false;
  // The anchor's own descriptor names it in <InternalsVisibleTo>: by the anchor
  // model's own declaration, its test model, developed with it.
  if (check.dependency?.testModelOfBase === true) return true;
  if (check.workspaceModels) {
    return check.workspaceModels.some(m => eq(m, owningModel) || eq(m, owningPackage));
  }
  return isWorkspaceModel(owningModel) || isWorkspaceModel(owningPackage);
}

/** True when D365FO_ALLOW_CROSS_MODEL_WRITE allows a write into any model. */
function blanketAllowance(): boolean {
  reloadWritePolicy();
  const blanket = process.env.D365FO_ALLOW_CROSS_MODEL_WRITE?.trim().toLowerCase();
  return blanket === 'true' || blanket === '1' || blanket === 'yes';
}

/** The workspace's models for a message: the anchor first, then the rest. */
function ownModelsOf(check: CrossModelWriteCheck): string[] {
  if (!check.workspaceModels) return workspaceModels(check.activeModel).map(m => m.name);
  const out = check.activeModel ? [check.activeModel] : [];
  for (const m of check.workspaceModels) if (!out.some(o => eq(o, m))) out.push(m);
  return out;
}

/**
 * Where the user adds a model to the workspace, for the refusal. The JSON
 * config first: it survives a package update, where the .env of an npm
 * installation does not (#1332).
 */
function whereToConfigure(model: string): string {
  const files = writePolicyFiles();
  const where = files
    ? `the server's config file ${files.configPath} (or D365FO_WORKSPACE_MODELS in ${files.envPath})`
    : `the server's config file (or D365FO_WORKSPACE_MODELS in its .env)`;
  return `"${model}" to \`workspace.models\` in ${where}`;
}

/**
 * A description of the cross-model allowance currently in force, or null.
 *
 * Surfaced by get_workspace_info so the state is visible without performing a
 * write to discover it. Only the blanket switch is reported here: the models
 * listed in `workspace.models` are the workspace's own, and get_workspace_info
 * lists them as such.
 */
export function activeCrossModelAllowance(): string | null {
  return blanketAllowance()
    ? 'D365FO_ALLOW_CROSS_MODEL_WRITE=true — writes into ANY model are allowed'
    : null;
}

/**
 * The note to print on a write the guard let through into ANOTHER model.
 *
 * Two paths reach a foreign model without a refusal, and both were silent:
 *   • no anchor to compare against, so the guard stood down rather than block
 *     on a guess;
 *   • configuration allows this model — a decision someone made, and "someone"
 *     is not necessarily the user (see the header).
 * Either way the write lands in code this workspace only consumes, so it belongs
 * in the reply, not only in a log a restart truncates.
 *
 * Returns '' for a write that stayed inside the active model, which is almost
 * every write — callers can concatenate it unconditionally.
 */
/** Past tense of each `action`, for the notices that report a write already made. */
const PAST_TENSE: Record<NonNullable<CrossModelWriteCheck['action']>, string> = {
  create: 'created',
  modify: 'modified',
  delete: 'deleted',
};

export function standDownNotice(check: CrossModelWriteCheck): string {
  const { objectName, owningModel, activeModel } = check;
  const verb = check.action ?? 'modify';
  const happened = check.dryRun ? 'would be' : 'was';
  if (!owningModel) return '';
  if (staysInWorkspace(check)) return '';

  if (!activeModel) {
    return (
      `\n\n⚠️ **Cross-model guard did not run.** "${objectName}" ${happened} written into model ` +
      `"${owningModel}", and this workspace's write anchor model could not be determined — so ` +
      `nothing verified that "${owningModel}" is where you meant it to go. If it is not, undo this ` +
      `and set the model explicitly (\`modelName\` in the server's config) before writing again.`
    );
  }

  // Facts only. The note used to end with "if you did not intend to grant that,
  // undo this write", which reads as an instruction to an agent that did nothing
  // wrong (#1332). Whether the setting was meant is the user's question.
  if (blanketAllowance()) {
    return (
      `\n\nℹ️ "${objectName}" ${happened} ${PAST_TENSE[verb]} in model "${owningModel}", which is not one of ` +
      `this workspace's models (${ownModelsOf(check).join(', ')}). ` +
      `D365FO_ALLOW_CROSS_MODEL_WRITE=true allows writes into any model.`
    );
  }

  // A refusal was due and the caller ignored it — not this function's job to
  // repeat it, but never report the write as ordinary either.
  return '';
}

/** Base object type → the d365fo_file objectType used to extend it. */
const EXTENSION_TYPE_OF: Record<string, string> = {
  table: 'table-extension',
  form: 'form-extension',
  enum: 'enum-extension',
  edt: 'edt-extension',
  view: 'view-extension',
  query: 'query-extension',
  map: 'map-extension',
  'data-entity': 'data-entity-extension',
  menu: 'menu-extension',
  class: 'class-extension',
};

function eq(a: string | null | undefined, b: string | null | undefined): boolean {
  return !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * True when writes into `owningModel` are allowed from this workspace: it is one
 * of the workspace's models (its solution, or `workspace.models` and the older
 * D365FO_CROSS_MODEL_WRITE_MODELS), or the blanket switch is on. Both live in
 * configuration or in the user's solution: a caller cannot grant this to itself
 * mid-conversation through any tool this server publishes.
 */
export function crossModelWriteAllowedByConfig(owningModel: string): boolean {
  // Picks up an edit the user made after the refusal, without a restart. The
  // read is mtime-gated, and only the policy keys are refreshed.
  return blanketAllowance() || isWorkspaceModel(owningModel);
}

/** The base object an extension extends: "CustTable.FooExtension" → "CustTable". */
export function baseObjectOf(objectName: string, objectType: string): string {
  if (objectName.includes('.')) return objectName.slice(0, objectName.indexOf('.'));
  if (objectType === 'class-extension' && objectName.endsWith('_Extension')) {
    return objectName.slice(0, -'_Extension'.length);
  }
  return objectName;
}

/**
 * The name the extension WOULD get in `activeModel`, following that model's own
 * naming (prefix inference + EXTENSION_NAMING_STYLE), or null when the type has
 * no extension form. Class extensions use the `{Base}{Infix}_Extension` shape;
 * everything else the dot-notation element form.
 */
export function suggestedExtensionName(
  baseObject: string,
  baseType: string,
  activeModel: string,
): string | null {
  if (!EXTENSION_TYPE_OF[baseType]) return null;
  // A configured name format names it the way create will; the base type is the
  // type of the object the refused write targeted.
  const formatted = resolveFormattedExtensionName(baseObject, EXTENSION_TYPE_OF[baseType], {
    extendedBase: baseObject,
    baseType,
  });
  if (formatted.kind === 'name') return formatted.name;
  if (formatted.kind !== 'none') return null;
  const prefix = resolveObjectPrefix(activeModel);
  // naming.prefixSource=none still names extensions — after the model. as-given
  // names nothing: the convention is the project's, so only the shape is shown.
  if (isAsGivenNamingMode()) {
    return baseType === 'class' ? `${baseObject}_<YourToken>_Extension` : `${baseObject}.<YourToken>`;
  }
  if (!prefix && !isNoPrefixMode()) return null;
  return baseType === 'class'
    ? applyObjectPrefix(`${baseObject}_Extension`, prefix, activeModel, { knownBase: true })
    : applyObjectPrefix(`${baseObject}.Extension`, prefix, activeModel);
}

/**
 * Refusal message for a write into a model other than the active one, or null
 * when the write is allowed.
 */
export function crossModelWriteRefusal(check: CrossModelWriteCheck): string | null {
  const { objectName, objectType, owningModel, activeModel } = check;
  const verb = check.action ?? 'modify';

  // Nothing to compare against — an unconfigured workspace or a path whose model
  // segment could not be determined. Never block on a guess (but say so: see
  // standDownNotice, which the caller prints on its result).
  if (!owningModel || !activeModel) return null;
  if (staysInWorkspace(check)) return null;
  if (blanketAllowance()) {
    console.error(
      `[crossModelWriteGuard] D365FO_ALLOW_CROSS_MODEL_WRITE allows writes to "${owningModel}" ` +
      `— proceeding with ${verb} of "${objectName}" (active model "${activeModel}")`,
    );
    return null;
  }
  const ownModels = ownModelsOf(check);
  const targets = ownModels.length > 1
    ? `this workspace develops ${ownModels.map(m => `"${m}"`).join(', ')}`
    : `this workspace targets model "${activeModel}"`;

  const isExtension = objectType.endsWith('-extension');
  const baseObject = baseObjectOf(objectName, objectType);
  const baseType = isExtension ? objectType.slice(0, -'-extension'.length) : objectType;
  const extType = EXTENSION_TYPE_OF[baseType];

  const lines = [
    `⛔ Refusing to ${verb} "${objectName}" in model "${owningModel}" — ${targets}.`,
    '',
  ];

  if (eq(check.toolSwitchedModel, owningModel)) {
    lines.push(
      `A get_workspace_info(projectName="${check.toolSwitchedModel}") switch earlier in this ` +
      `session changed which project is ACTIVE. It did not widen what you may read — reading ` +
      `spans every model either way — and it did not change where writes may land. The workspace ` +
      `the user has open still targets "${activeModel}", so that is what writes are anchored to. ` +
      `Switching projects is not a way to get past this refusal.`,
      '',
    );
  }

  // A model built ON the active one (its test model, typically) is the reverse of
  // the case this guard was written for: the active model cannot see it, so the
  // extension remedy below would not compile, and pieces of a feature already in it
  // are where that feature belongs, not traces of a misplaced write.
  const buildsOnActive = check.dependency?.buildsOnBase === true;
  const excluded = !check.workspaceModels && isExcludedWorkspaceModel(owningModel);
  if (excluded) {
    lines.push(
      `"${owningModel}" is listed in \`workspace.excludeModels\`: the user took it out of this ` +
      `workspace's models, whatever its solution or \`workspace.models\` says. It is code that ` +
      `"${activeModel}" only consumes.`,
      '',
    );
  }
  if (buildsOnActive) {
    lines.push(
      `"${owningModel}" is built on "${activeModel}": its descriptor references "${activeModel}", so ` +
      `"${activeModel}" cannot see "${owningModel}", and nothing in "${activeModel}" can extend ` +
      `${baseObject} — such an extension would not compile.`,
      '',
      `There is no in-model route for this ${verb}.`,
      '',
    );
  } else if (!excluded) {
    lines.push(
      `"${owningModel}" is not one of this workspace's models: no project of its solution builds it, ` +
      `and \`workspace.models\` does not list it. The change would land in code that "${activeModel}" ` +
      `only consumes, outside this workspace's projects and version control, and every other model ` +
      `built on "${owningModel}" would inherit it.`,
      '',
    );
  }

  // A NEW object has nothing to extend: the remedy is to create it where this
  // workspace builds. Offering "extend it" here sent the caller off to extend an
  // object that does not exist yet. Not for a label (labels take `model`, and a
  // label file has no extension form either) or a model added to a package.
  const isNewObject = verb === 'create' && !isExtension && objectType !== 'label' && objectType !== 'model-descriptor';

  // No remedy block for a model built on the active one: neither an extension nor a
  // delete has an in-model equivalent there.
  if (isNewObject) {
    lines.push(
      `To create it in this workspace, pass the model it belongs in: ` +
      ownModels.map(m => `modelName="${m}"`).join(' or ') +
      (ownModels.length > 1 ? '.' : ` (or omit modelName).`),
      '',
    );
  } else if (!buildsOnActive && verb === 'delete') {
    // The extension remedy below answers "I need this object to behave
    // differently". It is not an answer to "I need this object gone" — an
    // extension cannot un-define its base — so offering it here would send the
    // caller to build something that does not do what they asked.
    lines.push(
      `An extension cannot remove a foreign object, so there is no in-model equivalent of this ` +
      `delete. If "${objectName}" really has to go, it is deleted from "${owningModel}" by whoever ` +
      `owns that model. If the goal is only that "${activeModel}" stops using it, remove the ` +
      `references in "${activeModel}" — find_references(name="${objectName}") lists them.`,
      '',
    );
  } else if (!buildsOnActive && extType) {
    const existing = (check.existingExtensions ?? []).filter(e => !eq(e.name, objectName));
    lines.push(`Extend it from "${activeModel}" instead:`);
    if (existing.length > 0) {
      lines.push(
        `  • "${activeModel}" already extends ${baseObject} — add to that extension:`,
        ...existing.slice(0, 5).map(
          e => `      d365fo_file(action="modify", objectType="${extType}", objectName="${e.name}", modelName="${activeModel}", operation=…)`,
        ),
      );
    } else {
      const suggested = suggestedExtensionName(baseObject, baseType, activeModel);
      lines.push(
        `  • no extension of ${baseObject} exists in "${activeModel}" yet — create one:`,
        `      d365fo_file(action="create", objectType="${extType}", objectName="${suggested ?? `${baseObject}.<Prefix>Extension`}", modelName="${activeModel}")`,
        `    then add the member to it with action="modify".`,
      );
    }
    lines.push('');
  }

  lines.push(
    `Do NOT route around this guard: no retry with a different filePath, ` +
    `packagePath, or a get_workspace_info project switch.` +
    (buildsOnActive || isNewObject
      ? ''
      : ` Half-finished pieces of this very feature sitting in ` +
        `"${owningModel}" — a matching enum, field, label or scaffold — are evidence that an ` +
        `earlier run made this same mistake, NOT evidence that the feature belongs there.`),
    '',
    `Whether "${owningModel}" is developed in this workspace is the user's decision, not yours. If it ` +
    (excluded
      ? `is, they remove it from \`workspace.excludeModels\` in the server's config file`
      : `is, they add ${whereToConfigure(owningModel)}, or add its project to the solution`) +
    ` — it applies to ` +
    `your next attempt, no restart and no lost session. Ask them, wait for their answer, and report ` +
    `this refusal instead of working past it.`,
  );

  return lines.join('\n');
}
