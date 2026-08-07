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
 * So a write whose resolved file lives in a model other than the active one is
 * refused by default, with the extension route spelled out. Two deliberate
 * escape hatches, mirroring the standard-model guard's "explicit modelName =
 * you know what you're doing":
 *   - `modelName="<owning model>"` on the call — a per-call, per-model opt-in,
 *   - `D365FO_ALLOW_CROSS_MODEL_WRITE=true` — an environment-wide opt-out for
 *     setups where one server really does serve several models.
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
  /** Model that owns the resolved file (the `<Model>` path segment). */
  owningModel: string | null | undefined;
  /**
   * `<Package>` segment of the same path. A match on EITHER segment counts as
   * "same model": most custom models sit in a package of the same name, but a
   * configured model name occasionally matches only the package (several models
   * in one package, or a model folder named after the package). Accepting both
   * keeps the guard from firing on the workspace's own objects.
   */
  owningPackage?: string | null;
  /** Model the workspace targets (.rnrproj / D365FO_MODEL_NAME). */
  activeModel: string | null | undefined;
  /** `modelName` as passed by the caller — the per-call opt-in. */
  explicitModelName?: string | null;
  /** Extensions of the base object that already exist in the active model. */
  existingExtensions?: ExistingExtension[];
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

/** True when the operator has opted out of the guard environment-wide. */
function guardDisabled(): boolean {
  const v = process.env.D365FO_ALLOW_CROSS_MODEL_WRITE?.trim().toLowerCase();
  return v === 'true' || v === '1' || v === 'yes';
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
  const { objectName, objectType, owningModel, activeModel, explicitModelName } = check;

  // Nothing to compare against — an unconfigured workspace or a path whose model
  // segment could not be determined. Never block on a guess.
  if (!owningModel || !activeModel) return null;
  if (eq(owningModel, activeModel) || eq(check.owningPackage, activeModel)) return null;
  // Per-call opt-in: the caller named the owning model (or its package) outright.
  if (eq(explicitModelName, owningModel) || eq(explicitModelName, check.owningPackage)) return null;
  if (guardDisabled()) {
    console.error(
      `[crossModelWriteGuard] D365FO_ALLOW_CROSS_MODEL_WRITE — allowing write to "${objectName}" ` +
      `in model "${owningModel}" (active model "${activeModel}")`,
    );
    return null;
  }

  const isExtension = objectType.endsWith('-extension');
  const baseObject = baseObjectOf(objectName, objectType);
  const baseType = isExtension ? objectType.slice(0, -'-extension'.length) : objectType;
  const extType = EXTENSION_TYPE_OF[baseType];

  const lines = [
    `⛔ Refusing to modify "${objectName}" — it belongs to model "${owningModel}", ` +
    `not to this workspace's model "${activeModel}".`,
    '',
    `"${owningModel}" is a different model: the change would land in code that "${activeModel}" ` +
    `only consumes, it would not appear in this workspace's project or version control, and every ` +
    `other model built on "${owningModel}" would inherit it.`,
    '',
  ];

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
    `If editing "${owningModel}" in place is genuinely what you want, say so explicitly:`,
    `  • pass modelName="${owningModel}" on this call, or`,
    `  • switch the workspace to that model: get_workspace_info(projectName="${owningModel}"), or`,
    `  • set D365FO_ALLOW_CROSS_MODEL_WRITE=true to disable this guard for the whole server.`,
  );

  return lines.join('\n');
}
