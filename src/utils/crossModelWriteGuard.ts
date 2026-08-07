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
 * So consent lives ONLY in server configuration, which a human edits and which
 * takes a restart:
 *   - `D365FO_CROSS_MODEL_WRITE_MODELS=ModelA,ModelB` — allow these models,
 *   - `D365FO_ALLOW_CROSS_MODEL_WRITE=true`           — allow any model.
 *
 * And the refusal deliberately does NOT hand the caller a workaround: it names
 * the extension route, and says the alternative is the user's decision to make
 * in configuration.
 */

import { resolveObjectPrefix, applyObjectPrefix } from './modelClassifier.js';

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
  /** Wording only — what the caller was about to do. */
  action?: 'modify' | 'create';
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
 * True when the OPERATOR has allowed writes into `owningModel` from another
 * workspace — a blanket opt-out, or an explicit per-model allow-list. Both live
 * in the environment: a caller cannot grant this to itself mid-conversation.
 */
export function crossModelWriteAllowedByConfig(owningModel: string): boolean {
  const blanket = process.env.D365FO_ALLOW_CROSS_MODEL_WRITE?.trim().toLowerCase();
  if (blanket === 'true' || blanket === '1' || blanket === 'yes') return true;

  return (process.env.D365FO_CROSS_MODEL_WRITE_MODELS ?? '')
    .split(',')
    .some(m => eq(m, owningModel));
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
  const prefix = resolveObjectPrefix(activeModel);
  if (!prefix) return null;
  return baseType === 'class'
    ? applyObjectPrefix(`${baseObject}_Extension`, prefix, activeModel)
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
  // segment could not be determined. Never block on a guess.
  if (!owningModel || !activeModel) return null;
  if (eq(owningModel, activeModel) || eq(check.owningPackage, activeModel)) return null;
  if (crossModelWriteAllowedByConfig(owningModel)) {
    console.error(
      `[crossModelWriteGuard] configuration allows cross-model writes to "${owningModel}" ` +
      `— proceeding with ${verb} of "${objectName}" (active model "${activeModel}")`,
    );
    return null;
  }

  const isExtension = objectType.endsWith('-extension');
  const baseObject = baseObjectOf(objectName, objectType);
  const baseType = isExtension ? objectType.slice(0, -'-extension'.length) : objectType;
  const extType = EXTENSION_TYPE_OF[baseType];

  const lines = [
    `⛔ Refusing to ${verb} "${objectName}" in model "${owningModel}" — this workspace ` +
    `targets model "${activeModel}".`,
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

  lines.push(
    `"${owningModel}" is a different model: the change would land in code that "${activeModel}" ` +
    `only consumes, it would not appear in this workspace's project or version control, and every ` +
    `other model built on "${owningModel}" would inherit it.`,
    '',
  );

  if (extType) {
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
    `Do NOT route around this guard: no retry with a different modelName, filePath, ` +
    `packagePath, or a get_workspace_info project switch. Half-finished pieces of this very feature sitting in ` +
    `"${owningModel}" — a matching enum, field, label or scaffold — are evidence that an ` +
    `earlier run made this same mistake, NOT evidence that the feature belongs there.`,
    '',
    `Writing into "${owningModel}" is the user's decision, not yours. If they want it, they ` +
    `set D365FO_CROSS_MODEL_WRITE_MODELS=${owningModel} (or D365FO_ALLOW_CROSS_MODEL_WRITE=true) ` +
    `in the server configuration and restart. Ask them; report this refusal instead of working past it.`,
  );

  return lines.join('\n');
}
