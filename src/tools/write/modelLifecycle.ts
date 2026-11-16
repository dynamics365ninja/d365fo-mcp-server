/**
 * Model lifecycle — d365fo_file with objectType="model-descriptor":
 *
 *   action="create"                         → a new model (descriptor + model folder)
 *   action="modify", operation="modify-property" → one descriptor property
 *   action="delete"                         → remove a model
 *
 * add-module-reference / remove-module-reference stay where they were (the
 * modify dispatcher); the read side is get_object_info(objectType="model").
 *
 * A descriptor is not an AOT object, so none of the create pipeline applies
 * (prefixing, grounding, the bridge, .rnrproj membership) and all of this is
 * XML and folders on disk. What DOES apply is every ownership rule the object
 * writers enforce: path containment, no Microsoft model, and the cross-model
 * guard for anything that touches an existing model or package.
 *
 * A model the server created is recorded in configuration — CUSTOM_MODELS and
 * D365FO_CROSS_MODEL_WRITE_MODELS in the loaded .env — because nothing else
 * would know it: the workspace still targets the model its project builds, so
 * without the entry the first object written into the new model is refused by
 * the cross-model guard. Deleting a model takes the entries out again. Both are
 * reported in the reply, never done silently.
 *
 * RENAME is deliberately absent — see docs/MODEL_LIFECYCLE.md for what a rename
 * would have to touch and why most of it is out of this server's reach.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { z } from 'zod';
import type { XppServerContext } from '../../types/context.js';
import { getConfigManager } from '../../utils/configManager.js';
import { assertWritePathAllowed } from '../../utils/pathContainment.js';
import { writeFileAtomic } from '../../utils/atomicFileWrite.js';
import { normalizeD365Xml } from '../../utils/d365XmlNormalizer.js';
import { isCustomModel, registerCustomModel } from '../../utils/modelClassifier.js';
import { crossModelWriteRefusal, standDownNotice } from '../../utils/crossModelWriteGuard.js';
import { loadedEnvFile } from '../../utils/loadEnv.js';
import { updateListSetting, type ListSettingOutcome } from '../../utils/envListSetting.js';
import { findModelDescriptorPath } from '../../utils/objectFileLookup.js';
import {
  invalidateModelVisibility, isValidModuleReferenceName,
} from '../../metadata/modelDescriptor.js';
import {
  scanDescriptors, findModel, packageMates, dependentsOfPackage, findReferenceCycles,
  modelNameProblem, allocateModelId, buildDescriptorXml, setDescriptorProperty, parseDescriptor,
  layerNumber, describeLayer, parseVersion, formatVersion, isDirectory,
  MODEL_LAYERS, EDITABLE_DESCRIPTOR_PROPERTIES,
  type ModelEntry, type ModelInventory,
} from '../../metadata/modelInventory.js';
import { recordCreatedArtifact, forgetCreatedArtifact } from '../../workspace/createdArtifactLedger.js';
import { inferProjectsRoot, removeProject } from '../../workspace/projectScaffold.js';
import { bridgeRefreshProvider } from '../../bridge/index.js';
import { resolveAnchorModel } from './writeAnchorGuard.js';
import { handleCreateProject } from './createProject.js';

const BOM = '﻿';
const CUSTOM_MODELS_KEY = 'CUSTOM_MODELS';
const ALLOW_LIST_KEY = 'D365FO_CROSS_MODEL_WRITE_MODELS';

type ToolResult = { content: Array<{ type: string; text: string }>; isError?: boolean };

const ok = (text: string): ToolResult => ({ content: [{ type: 'text', text }] });
const fail = (text: string): ToolResult => ({ content: [{ type: 'text', text }], isError: true });

/** True for the model-lifecycle calls d365fo_file routes here instead of to the object writers. */
export function isModelDescriptorType(objectType: unknown): boolean {
  return objectType === 'model-descriptor';
}

/** Hooks a test replaces; production passes none. */
export interface ModelLifecycleDeps {
  /** Where settings are persisted. Default: the .env the server loaded. */
  envFile?: { envPath: string; ownedByRealEnv(key: string): boolean } | null;
  /** Source of randomness for the model Id. */
  random?: () => number;
}

interface Roots {
  cfg: ReturnType<typeof getConfigManager>;
  /** Root new metadata is written under, or null when none is configured. */
  writeRoot: string | null;
  /** Every root a descriptor may be visible under, in lookup order. */
  all: string[];
}

async function resolveRoots(explicit?: string): Promise<Roots> {
  const cfg = getConfigManager();
  await cfg.ensureLoaded();
  const custom = await cfg.getCustomPackagesPath().catch(() => null);
  const configured = cfg.getPackagePath();
  const microsoft = await cfg.getMicrosoftPackagesPath().catch(() => null);
  // No machine-wide fallback here: a model is not created on a guessed root.
  const writeRoot = explicit?.trim() || custom || configured || null;
  return {
    cfg,
    writeRoot: writeRoot ? path.resolve(writeRoot) : null,
    all: [explicit, custom, configured, microsoft].filter((r): r is string => !!r && !!r.trim()),
  };
}

/**
 * A model this server must never create into, edit or delete: Microsoft's own.
 * Judged from the descriptor (publisher, or a layer below isv) rather than from
 * CUSTOM_MODELS — a custom model nobody listed there is still the user's.
 */
function looksMicrosoft(model: Pick<ModelEntry, 'publisher' | 'layer'>): boolean {
  return /\bmicrosoft\b/i.test(model.publisher) || (model.layer !== null && model.layer < 8);
}

const sameName = (a: string | null | undefined, b: string | null | undefined) =>
  !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();

const samePath = (a: string, b: string) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

function settingLine(o: ListSettingOutcome, envPath: string | undefined): string {
  if (o.persisted) return `  • ${o.key}=${o.value || '(empty)'} — written to ${envPath}`;
  if (o.appliedToProcess) return `  • ${o.key}=${o.value || '(empty)'} — for THIS server session only: ${o.note}`;
  return `  • ${o.key} unchanged (${o.note ?? 'nothing to change'})`;
}

async function refreshBridge(context: XppServerContext | undefined): Promise<void> {
  try {
    if (context?.bridge) await bridgeRefreshProvider(context.bridge);
  } catch { /* advisory */ }
}

// ── create ───────────────────────────────────────────────────────────────────

const CreateSchema = z.object({
  objectName: z.string().optional(),
  modelName: z.string().optional(),
  packageName: z.string().optional(),
  packagePath: z.string().optional(),
  dryRun: z.boolean().optional(),
  properties: z.record(z.string(), z.unknown()).optional(),
}).passthrough();

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

export async function handleCreateModel(
  rawArgs: Record<string, unknown>,
  context?: XppServerContext,
  deps: ModelLifecycleDeps = {},
): Promise<ToolResult> {
  const label = 'd365fo_file(action="create", objectType="model-descriptor")';
  const bad = (t: string) => fail(`❌ ${label}: ${t}\nNothing was written. Contract: get_knowledge(kind="op-spec", topic="model-descriptor").`);
  const parsed = CreateSchema.safeParse(rawArgs);
  if (!parsed.success) return bad(`invalid arguments — ${parsed.error.message}`);
  const a = parsed.data;
  // Properties may arrive nested (the published shape) or flat.
  const p: Record<string, unknown> = { ...(a as Record<string, unknown>), ...(a.properties ?? {}) };

  // The name is never defaulted: the configured model is the one that already exists.
  const objectName = str(a.objectName);
  const modelArg = str(a.modelName);
  if (objectName && modelArg && !sameName(objectName, modelArg)) {
    return bad(`objectName "${objectName}" and modelName "${modelArg}" disagree — pass the new model's name once, as objectName.`);
  }
  const name = objectName ?? modelArg;
  if (!name) return bad('pass the new model\'s name as objectName.');
  const nameProblem = modelNameProblem(name);
  if (nameProblem) return bad(`"${name}" cannot be a model name: ${nameProblem}.`);

  const roots = await resolveRoots(str(a.packagePath));
  if (!roots.writeRoot) {
    return bad('no packages root is configured to create the model under — set D365FO_CUSTOM_PACKAGES_PATH ' +
      '(or packagePath in the server config), or pass packagePath="<metadata root>".');
  }
  const writeRoot = roots.writeRoot;
  if (!isDirectory(writeRoot)) return bad(`the packages root ${writeRoot} does not exist.`);
  const inventory = scanDescriptors([writeRoot, ...roots.all]);

  // ── name and package ───────────────────────────────────────────────────────
  const clash = findModel(inventory, name);
  if (clash) return bad(`a model named "${clash.name}" already exists: ${clash.descriptorPath}`);

  const packageName = str(p.packageName) ?? name;
  if (!isValidModuleReferenceName(packageName)) return bad(`"${packageName}" is not a package folder name.`);
  const packageDir = path.join(writeRoot, packageName);
  const descriptorPath = path.join(packageDir, 'Descriptor', `${name}.xml`);
  const modelFolder = path.join(packageDir, name);
  const mates = inventory.models.filter(m => sameName(m.packageName, packageName) && samePath(m.root, writeRoot));
  const newPackage = !isDirectory(packageDir);

  if (newPackage) {
    const elsewhere = inventory.packages.get(packageName.toLowerCase());
    if (elsewhere) {
      return bad(`a package folder named "${elsewhere}" already exists under another packages root — a second one ` +
        `under ${writeRoot} would shadow it. Choose another name.`);
    }
  } else {
    if (sameName(packageName, name) && !str(p.packageName)) {
      return bad(`${packageDir} already exists but holds no descriptor for "${name}". If "${name}" is meant to be a ` +
        `second model INSIDE that package, say so with properties.packageName="${packageName}"; otherwise pick another name.`);
    }
    if (mates.length === 0) {
      return bad(`${packageDir} exists but holds no model descriptor, so it is not a package this server can add a model to.`);
    }
    if (mates.some(looksMicrosoft)) {
      return bad(`package "${packageName}" is a Microsoft package (${mates.find(looksMicrosoft)!.name}) — models are never added to it.`);
    }
  }
  if (isDirectory(modelFolder)) return bad(`${modelFolder} already exists.`);

  // A model inside an existing package compiles into that package's assembly, so
  // it is a write into somebody's code and answers to the cross-model guard.
  const anchor = (await resolveAnchorModel(roots.cfg)) || null;
  let guardNote = '';
  if (!newPackage) {
    const mine = mates.find(m => sameName(m.name, anchor)) ?? mates[0];
    const check = {
      objectName: name, objectType: 'model-descriptor', owningModel: mine.name,
      owningPackage: packageName, activeModel: anchor, action: 'create' as const, dryRun: a.dryRun === true,
    };
    const refusal = crossModelWriteRefusal(check);
    if (refusal) return fail(refusal);
    guardNote = standDownNotice(check);
  }

  // ── properties, defaulted from the models beside it ────────────────────────
  const siblings = inventory.models.filter(m => samePath(m.root, writeRoot) && !looksMicrosoft(m));
  const template =
    mates.find(m => sameName(m.name, anchor)) ?? mates[0]
    ?? siblings.find(m => sameName(m.name, anchor))
    ?? mostCommonBy(siblings, m => `${m.layer}|${m.publisher}`);

  let layer: number | null;
  if (p.layer !== undefined && p.layer !== null && p.layer !== '') {
    layer = layerNumber(p.layer);
    if (layer === null) return bad(`layer ${JSON.stringify(p.layer)} is not one of ${MODEL_LAYERS.join(', ')} (or its number 0-15).`);
  } else {
    layer = template?.layer ?? null;
  }
  const publisher = str(p.publisher) ?? (template?.publisher.trim() || undefined);
  if (layer === null || !publisher) {
    return bad(
      `${[layer === null ? 'layer' : '', !publisher ? 'publisher' : ''].filter(Boolean).join(' and ')} not given, and ` +
      `${writeRoot} holds no custom model to take ${layer === null && !publisher ? 'them' : 'it'} from. Ask the user and pass ` +
      `properties.layer (e.g. "cus", "var", "isv", "usr") and properties.publisher.`);
  }
  if (layer < 8) return bad(`layer ${describeLayer(layer)} is a Microsoft layer — a custom model uses isv, var, cus or usr (or their patch layers).`);
  if (/[\r\n]/.test(publisher)) return bad('publisher must be a single line.');

  const displayName = str(p.displayName) ?? name;
  const description = typeof p.description === 'string' ? p.description.trim() : '';
  if (/[\r\n]/.test(displayName)) return bad('displayName must be a single line.');
  const version = p.version === undefined || p.version === null || p.version === ''
    ? { major: 1, minor: 0, build: 0, revision: 0 }
    : parseVersion(p.version);
  if (!version) return bad(`version ${JSON.stringify(p.version)} is not a dotted number such as "1.0.0.0".`);

  // ── module references ──────────────────────────────────────────────────────
  const referencesGiven = p.moduleReferences !== undefined && p.moduleReferences !== null;
  let requested: string[];
  if (referencesGiven) {
    if (!Array.isArray(p.moduleReferences) || p.moduleReferences.some(r => typeof r !== 'string')) {
      return bad('moduleReferences must be an array of package names, e.g. ["ApplicationPlatform", "ApplicationSuite"].');
    }
    requested = (p.moduleReferences as string[]).map(r => r.trim()).filter(Boolean);
  } else {
    // What every X++ model needs; left out when this box cannot see it.
    requested = inventory.packages.has('applicationplatform') ? ['ApplicationPlatform'] : [];
  }
  const references: string[] = [];
  const unresolved: string[] = [];
  for (const ref of requested) {
    if (!isValidModuleReferenceName(ref)) return bad(`module reference ${JSON.stringify(ref)} is not a package folder name.`);
    if (sameName(ref, packageName)) return bad(`a model does not reference its own package ("${ref}").`);
    const onDisk = inventory.packages.get(ref.toLowerCase());
    if (!onDisk) unresolved.push(ref);
    if (!references.some(r => sameName(r, ref))) references.push(onDisk ?? ref);
  }
  if (unresolved.length && p.allowUnresolvedReferences !== true) {
    return bad(
      `module reference${unresolved.length > 1 ? 's' : ''} ${unresolved.map(r => `"${r}"`).join(', ')} name no package folder ` +
      `under ${inventory.roots.join(', ')}. A reference is spelled exactly as its PACKAGE folder is (not the model's ` +
      `display name). If the package is genuinely absent here and present on the build agent, re-run with ` +
      `properties.allowUnresolvedReferences=true.`);
  }
  const cycles = findReferenceCycles(inventory, { packageName, references });
  const ownCycles = cycles.filter(c => c.some(n => sameName(n, packageName)));
  if (ownCycles.length) {
    return bad(`these references would close a reference cycle, which cannot be built: ${ownCycles.map(c => c.join(' → ')).join('; ')}.`);
  }

  // ── id ─────────────────────────────────────────────────────────────────────
  const usedIds = inventory.models.map(m => m.id).filter((id): id is number => id !== null);
  let id: number;
  if (p.id !== undefined && p.id !== null && p.id !== '') {
    id = Number(p.id);
    if (!Number.isInteger(id) || id <= 0) return bad(`id ${JSON.stringify(p.id)} is not a positive whole number.`);
    const owner = inventory.models.find(m => m.id === id);
    if (owner) return bad(`model Id ${id} is already used by "${owner.name}" (${owner.descriptorPath}).`);
  } else {
    id = allocateModelId(usedIds, deps.random);
  }

  // ── containment ────────────────────────────────────────────────────────────
  const containment = await assertWritePathAllowed(descriptorPath, name, {
    extraRoots: a.packagePath ? [a.packagePath] : undefined,
    allowDescriptor: true,
  });
  if (!containment.ok) return fail(`❌ ${label}: ${containment.reason ?? 'path containment check failed'}`);

  const xml = buildDescriptorXml({
    name, displayName, description, id, layer, publisher, modelModule: packageName, version, moduleReferences: references,
  });

  const summary = [
    `Model       : ${name}${displayName !== name ? ` ("${displayName}")` : ''}`,
    `Package     : ${packageName} — ${newPackage ? 'NEW package' : `existing package, beside ${mates.map(m => m.name).join(', ')}`}`,
    `Descriptor  : ${descriptorPath}`,
    `Model folder: ${modelFolder}`,
    `Id          : ${id}${p.id ? '' : ` (free among the ${usedIds.length} descriptors visible here — a model that exists only in another repository or branch cannot be seen)`}`,
    `Layer       : ${describeLayer(layer)}${p.layer === undefined && template ? ` (as ${template.name})` : ''}`,
    `Publisher   : ${publisher}${!str(p.publisher) && template ? ` (as ${template.name})` : ''}`,
    `Version     : ${formatVersion(version)}`,
    `References  : ${references.length ? references.join(', ') : '(none)'}` +
      (!referencesGiven ? ' (default — add more with operation="add-module-reference")' : '') +
      (unresolved.length ? ` — ⚠️ not found on this box: ${unresolved.join(', ')}` : ''),
  ];

  if (a.dryRun === true) {
    return ok(
      `○ DRY RUN — nothing was written. ${label} would create:\n\n${summary.join('\n')}\n\n` +
      `It would also list "${name}" in ${CUSTOM_MODELS_KEY} and ${ALLOW_LIST_KEY} (the server's .env), so objects can ` +
      `be written into it.${guardNote}`);
  }

  // ── write ──────────────────────────────────────────────────────────────────
  const created: string[] = [];
  try {
    for (const dir of [packageDir, path.dirname(descriptorPath), modelFolder]) {
      if (!isDirectory(dir)) {
        await fs.mkdir(dir, { recursive: true });
        created.push(dir);
      }
    }
    await writeFileAtomic(descriptorPath, BOM + normalizeD365Xml(xml));
  } catch (e: any) {
    // Leave nothing half-made: remove only the folders this call created, deepest first.
    for (const dir of created.reverse()) await fs.rmdir(dir).catch(() => {});
    return fail(`❌ ${label}: could not write the model — ${e?.message ?? e}. Nothing was left behind.`);
  }

  recordCreatedArtifact({ filePath: descriptorPath, objectType: 'model-descriptor', objectName: name });
  invalidateModelVisibility(name);

  // Known to configuration from here on — see the header.
  const envFile = deps.envFile !== undefined ? deps.envFile : loadedEnvFile();
  const settings: ListSettingOutcome[] = [];
  if (!isCustomModel(name)) settings.push(await updateListSetting(envFile, CUSTOM_MODELS_KEY, { add: name }));
  registerCustomModel(name);
  if (!sameName(anchor, name)) settings.push(await updateListSetting(envFile, ALLOW_LIST_KEY, { add: name }));
  await refreshBridge(context);

  const lines = [
    `✅ Created model ${name}.`,
    '',
    ...summary,
    '',
    'Configuration:',
    ...(settings.length ? settings.map(s => settingLine(s, envFile?.envPath)) : ['  • nothing to change — the model was already covered.']),
    anchor
      ? `  This workspace still targets "${anchor}". "${name}" is on the cross-model allow-list so that objects can be ` +
        `written into it with modelName="${name}"; tell the user, and take it off the list again if that was not wanted.`
      : '',
    '',
    'Next:',
    `  • Objects: d365fo_file(action="create", …, modelName="${name}") — the model has none yet, so it has no prefix to infer.`,
    `  • Build: build_d365fo_project(modelName="${name}") — a FULL build; the first one creates the package's bin folder.`,
    `  • More references: d365fo_file(action="modify", objectType="model-descriptor", modelName="${name}", operation="add-module-reference", params:{moduleReference:"<Package>"}).`,
    `  • Add the new folder to source control. Undo: d365fo_file(action="undo", filePath="${descriptorPath}").`,
  ].filter(l => l !== '');

  let result = ok(lines.join('\n') + guardNote);

  // Optional VS project, through the ordinary project create.
  const project = p.project && typeof p.project === 'object' && !Array.isArray(p.project)
    ? (p.project as Record<string, unknown>)
    : undefined;
  if (project) {
    const projectsRoot = str(project.projectsRoot) ?? inferProjectsRoot(roots.cfg.getProjectsForModel(anchor)) ?? undefined;
    const made: ToolResult = await handleCreateProject({
      ...project,
      projectName: str(project.projectName) ?? name,
      modelName: name,
      ...(projectsRoot ? { projectsRoot } : {}),
    });
    const text = made.content.map(c => c.text).join('\n');
    result = made.isError
      ? fail(`${lines.join('\n')}${guardNote}\n\n---\n\n⚠️ The model IS created, but its Visual Studio project was not:\n${text}`)
      : ok(`${lines.join('\n')}${guardNote}\n\n---\n\n${text}`);
  }
  return result;
}

function mostCommonBy<T>(items: T[], key: (item: T) => string): T | undefined {
  const counts = new Map<string, { item: T; n: number }>();
  for (const item of items) {
    const k = key(item);
    const hit = counts.get(k);
    if (hit) hit.n++;
    else counts.set(k, { item, n: 1 });
  }
  return [...counts.values()].sort((x, y) => y.n - x.n)[0]?.item;
}

// ── modify-property ──────────────────────────────────────────────────────────

/**
 * modify-property on a descriptor: Description, DisplayName, Publisher, Layer,
 * Version (dotted) or one Version* part. The identity of a model — Name,
 * ModelModule, Id — is refused, with the reason.
 */
export async function handleModelProperty(rawArgs: Record<string, unknown>): Promise<ToolResult> {
  const label = 'd365fo_file(action="modify", objectType="model-descriptor", operation="modify-property")';
  const bad = (t: string) => fail(`❌ ${label}: ${t}\nNothing was written.`);
  const property = str(rawArgs.propertyPath) ?? str(rawArgs.propertyName);
  const rawValue = rawArgs.propertyValue;
  if (!property || rawValue === undefined || rawValue === null) {
    return bad(`pass params.propertyPath (one of ${EDITABLE_DESCRIPTOR_PROPERTIES.join(', ')}) and params.propertyValue.`);
  }
  const value = String(rawValue);
  const packagePath = str(rawArgs.packagePath);
  const modelArg = str(rawArgs.modelName) ?? str(rawArgs.objectName);

  let filePath = str(rawArgs.filePath) ?? null;
  if (!filePath) {
    const found = await findModelDescriptorPath(modelArg, packagePath);
    if (!found) return bad(`no descriptor found for model "${modelArg ?? '(the configured model)'}" — check the name, or pass packagePath / filePath.`);
    filePath = found.filePath;
  }
  const containment = await assertWritePathAllowed(filePath, modelArg, {
    extraRoots: packagePath ? [packagePath] : undefined,
    allowDescriptor: true,
  });
  if (!containment.ok) return bad(containment.reason ?? 'path containment check failed');

  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf-8');
  } catch (e: any) {
    return bad(`could not read ${filePath}: ${e?.message ?? e}`);
  }
  const content = raw.replace(/^﻿/, '').replace(/\r\n/g, '\n');
  const info = parseDescriptor(content);
  if (!info) return bad(`${filePath} is not an <AxModelInfo> descriptor.`);
  if (looksMicrosoft(info)) return bad(`"${info.name}" is a Microsoft model — its descriptor is not edited.`);

  const cfg = getConfigManager();
  const check = {
    objectName: info.name, objectType: 'model-descriptor', owningModel: info.name,
    owningPackage: containment.packageSegment ?? null,
    activeModel: (await resolveAnchorModel(cfg)) || null, action: 'modify' as const,
  };
  const refusal = crossModelWriteRefusal(check);
  if (refusal) return fail(refusal);

  const outcome = setDescriptorProperty(content, property, value);
  if (outcome.kind === 'refused') return bad(outcome.reason + '.');
  if (outcome.kind === 'unchanged') {
    return ok(`ℹ️ ${outcome.element} of model ${info.name} is already ${JSON.stringify(outcome.value)} — nothing was written.`);
  }
  try {
    await writeFileAtomic(filePath, (raw.charCodeAt(0) === 0xfeff ? BOM : '') + normalizeD365Xml(outcome.xml));
  } catch (e: any) {
    return bad(`could not write ${filePath}: ${e?.message ?? e}`);
  }
  invalidateModelVisibility(info.name);
  const layerChange = outcome.changes.find(c => c.element === 'Layer');
  return ok(
    `✅ Model ${info.name}: ` +
    outcome.changes.map(c => `${c.element} ${JSON.stringify(c.from)} → ${JSON.stringify(c.to)}`).join(', ') +
    `\n📁 ${filePath}` +
    (layerChange
      ? `\n⚠️ The layer of a model that is already deployed should not change: the environment keeps the model in ` +
        `the layer it was installed in. Change it only for a model that has not left this machine.`
      : '') +
    `\nThe descriptor is read at build time — run a full build of the model for the change to reach its package.` +
    standDownNotice(check));
}

/**
 * The line add-module-reference appends when the reference it just wrote closes
 * a cycle. A note, not a refusal: by the time it can be computed the write has
 * happened, and the write is one remove-module-reference away from undone.
 */
export async function moduleReferenceCycleNote(modelName: string | undefined, packagePath?: string): Promise<string> {
  try {
    const roots = await resolveRoots(packagePath);
    const inventory = scanDescriptors(roots.all);
    const model = modelName ? findModel(inventory, modelName) : undefined;
    if (!model) return '';
    const cycles = findReferenceCycles(inventory).filter(c => c.some(n => sameName(n, model.packageName)));
    if (!cycles.length) return '';
    return `\n\n⚠️ Reference cycle: ${cycles.map(c => c.join(' → ')).join('; ')}. Packages build in reference order, ` +
      `so none of these can be built first — remove one of the references (operation="remove-module-reference").`;
  } catch {
    return '';
  }
}

// ── delete ───────────────────────────────────────────────────────────────────

const DeleteSchema = z.object({
  objectName: z.string().optional(),
  modelName: z.string().optional(),
  packagePath: z.string().optional(),
  dryRun: z.boolean().optional(),
  force: z.boolean().optional(),
}).passthrough();

/** What a package folder may hold besides its models once they are gone: build output. */
const BUILD_OUTPUT = new Set([
  'bin', 'xppmetadata', 'resources', 'webcontent', 'additionalfiles', 'reports', 'descriptor',
]);
const isBuildOutput = (name: string) =>
  BUILD_OUTPUT.has(name.toLowerCase()) || /^buildmodelresult\./i.test(name) || /\.(log|xref)$/i.test(name);

async function listFiles(dir: string, limit = 5000): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string) => {
    let entries: import('fs').Dirent[];
    try {
      entries = await fs.readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= limit) return;
      const full = path.join(d, e.name);
      if (e.isDirectory()) await walk(full);
      else out.push(full);
    }
  };
  await walk(dir);
  return out;
}

async function isLink(p: string): Promise<boolean> {
  try {
    return (await fs.lstat(p)).isSymbolicLink();
  } catch {
    return false;
  }
}

export async function handleDeleteModel(
  rawArgs: Record<string, unknown>,
  context?: XppServerContext,
  deps: ModelLifecycleDeps = {},
): Promise<ToolResult> {
  const label = 'd365fo_file(action="delete", objectType="model-descriptor")';
  const bad = (t: string) => fail(`❌ ${label}: ${t}\nNothing was deleted.`);
  const parsed = DeleteSchema.safeParse(rawArgs);
  if (!parsed.success) return bad(`invalid arguments — ${parsed.error.message}`);
  const a = parsed.data;
  // A preview unless the caller says dryRun:false — a whole model is not removed by a call that
  // merely omitted a flag. The preview is what the user is shown before saying yes.
  const dryRun = a.dryRun !== false;
  const force = a.force === true;

  // Never defaulted to the configured model: "delete the model" with no name is not a request.
  const objectName = str(a.objectName);
  const modelArg = str(a.modelName);
  if (objectName && modelArg && !sameName(objectName, modelArg)) {
    return bad(`objectName "${objectName}" and modelName "${modelArg}" disagree — name the model to delete once.`);
  }
  const name = objectName ?? modelArg;
  if (!name) return bad('name the model to delete (objectName). It is never taken from the configured model.');

  const roots = await resolveRoots(str(a.packagePath));
  const inventory: ModelInventory = scanDescriptors(roots.all);
  const model = findModel(inventory, name);
  if (!model) {
    return bad(`no model named "${name}" has a descriptor under ${inventory.roots.join(', ') || '(no packages root configured)'}. ` +
      `List the models with get_object_info(objectType="model", name="*").`);
  }
  if (looksMicrosoft(model)) return bad(`"${model.name}" is a Microsoft model (publisher "${model.publisher}", layer ${describeLayer(model.layer)}).`);

  const containment = await assertWritePathAllowed(model.descriptorPath, model.name, {
    extraRoots: a.packagePath ? [a.packagePath] : undefined,
    allowDescriptor: true,
  });
  if (!containment.ok) return bad(containment.reason ?? 'path containment check failed');

  const anchor = (await resolveAnchorModel(roots.cfg)) || null;
  const check = {
    objectName: model.name, objectType: 'model-descriptor', owningModel: model.name,
    owningPackage: model.packageName, activeModel: anchor, action: 'delete' as const, dryRun,
  };
  const refusal = crossModelWriteRefusal(check);
  if (refusal) return fail(refusal);

  const packageDir = path.join(model.root, model.packageName);
  for (const p of [packageDir, model.modelFolder, path.dirname(model.descriptorPath)]) {
    if (await isLink(p)) {
      return bad(`${p} is a symbolic link or junction — deleting through it would remove files somewhere else. ` +
        `Remove the link and the model by hand.`);
    }
  }

  // ── survey ─────────────────────────────────────────────────────────────────
  const mates = packageMates(inventory, model);
  const lastInPackage = mates.length === 0;
  // A reference names the PACKAGE, so it only dangles when the package goes too.
  const dependents = lastInPackage ? dependentsOfPackage(inventory, model.packageName) : [];
  const objects = isDirectory(model.modelFolder) ? await listFiles(model.modelFolder) : [];
  const projects = roots.cfg.getProjectsForModel(model.name);
  const leftovers: string[] = [];
  if (lastInPackage) {
    for (const entry of await fs.readdir(packageDir).catch(() => [] as string[])) {
      if (sameName(entry, model.name) || isBuildOutput(entry)) continue;
      leftovers.push(entry);
    }
  }
  const removePackage = lastInPackage && leftovers.length === 0;

  const plan = [
    `Model       : ${model.name} (Id ${model.id ?? '?'}, layer ${describeLayer(model.layer)}, package ${model.packageName})`,
    `Descriptor  : ${model.descriptorPath}`,
    `Model folder: ${model.modelFolder} — ${objects.length} file(s)` +
      (objects.length ? `:\n${objects.slice(0, 15).map(f => `    ${path.relative(model.modelFolder, f)}`).join('\n')}${objects.length > 15 ? `\n    … ${objects.length - 15} more` : ''}` : ''),
    lastInPackage
      ? removePackage
        ? `Package     : ${packageDir} — its last model, so the whole folder goes (build output included)`
        : `Package     : ${packageDir} — its last model, but the folder is KEPT: it also holds ${leftovers.join(', ')}`
      : `Package     : ${packageDir} — kept, it still holds ${mates.map(m => m.name).join(', ')}`,
    `Referenced by: ${dependents.length ? dependents.map(d => `${d.name} (${d.descriptorPath})`).join('\n               ') : '(no other model)'}`,
    `VS projects : ${projects.length ? projects.join('\n              ') : '(none detected)'}` +
      (projects.length ? '\n              → taken out of their solution(s); the project files stay on disk' : ''),
    `Configuration: "${model.name}" is removed from ${CUSTOM_MODELS_KEY} and ${ALLOW_LIST_KEY}`,
  ];

  const blockers: string[] = [];
  if (dependents.length) {
    blockers.push(`${dependents.length} other model(s) still reference package "${model.packageName}" and would stop compiling: ` +
      `${dependents.map(d => d.name).join(', ')}. Remove the reference from each first ` +
      `(operation="remove-module-reference", moduleReference="${model.packageName}").`);
  }
  if (objects.length) {
    blockers.push(`the model still contains ${objects.length} file(s). Delete the objects first ` +
      `(d365fo_file action="delete" per object), or move them.`);
  }

  if (dryRun) {
    return ok(
      `○ DRY RUN — nothing was deleted. ${label} would remove:\n\n${plan.join('\n')}\n\n` +
      (blockers.length
        ? `⛔ As it stands the delete would be REFUSED:\n${blockers.map(b => `  • ${b}`).join('\n')}\n` +
          `force=true overrides this — only after the user has seen this list and said so.`
        : `Nothing blocks it. It cannot be undone by this server: recovery is \`git restore\` when the metadata is ` +
          `under source control, and nothing otherwise. Confirm with the user, then re-run with dryRun=false.`) +
      `\nA model already DEPLOYED to an environment stays installed there; this only removes the source.`);
  }
  if (blockers.length && !force) {
    return bad(`refusing to delete model "${model.name}":\n${blockers.map(b => `  • ${b}`).join('\n')}\n` +
      `Run it with dryRun=true (the default) to see everything it would remove. force=true overrides this refusal — only after the ` +
      `user has seen that list and said so.`);
  }

  // ── execute ────────────────────────────────────────────────────────────────
  const notes: string[] = [];
  for (const projectPath of projects) {
    try {
      const res = await removeProject({ projectPath, removeFiles: false, otherProjectPaths: projects });
      notes.push(`project ${path.basename(projectPath)}: removed from ${res.solutions.map(s => path.basename(s)).join(', ')} (files left at ${path.dirname(projectPath)})`);
    } catch (e: any) {
      notes.push(`⚠️ project ${path.basename(projectPath)} was NOT unregistered: ${e?.message ?? e}`);
    }
  }

  try {
    if (removePackage) {
      await fs.rm(packageDir, { recursive: true, force: true });
    } else {
      await fs.rm(model.descriptorPath, { force: true });
      await fs.rm(model.modelFolder, { recursive: true, force: true });
      if (lastInPackage) await fs.rmdir(path.dirname(model.descriptorPath)).catch(() => {});
    }
  } catch (e: any) {
    return fail(`❌ ${label}: the delete stopped part-way — ${e?.message ?? e}.\nCheck ${packageDir}; a file locked by ` +
      `Visual Studio or the AOS is the usual cause. Re-run once it is released.`);
  }

  forgetCreatedArtifact(model.descriptorPath);
  invalidateModelVisibility(model.name);
  let dropped = 0;
  for (const file of objects) {
    try {
      dropped += context?.symbolIndex?.removeSymbolsByFile?.(file)?.deletedCount ?? 0;
    } catch { /* advisory */ }
  }
  const envFile = deps.envFile !== undefined ? deps.envFile : loadedEnvFile();
  const settings = [
    await updateListSetting(envFile, CUSTOM_MODELS_KEY, { remove: model.name }),
    await updateListSetting(envFile, ALLOW_LIST_KEY, { remove: model.name }),
  ];
  await refreshBridge(context);

  return ok([
    `✅ Deleted model ${model.name}.`,
    `🗑️ ${removePackage ? packageDir : `${model.descriptorPath}\n🗑️ ${model.modelFolder}`}`,
    lastInPackage && !removePackage ? `ℹ️ ${packageDir} was kept: it also holds ${leftovers.join(', ')}.` : '',
    objects.length ? `${objects.length} file(s) went with it${dropped ? `; ${dropped} symbol(s) dropped from the index` : ''}.` : '',
    ...notes,
    'Configuration:',
    ...settings.map(s => settingLine(s, envFile?.envPath)),
    dependents.length
      ? `⚠️ Still referencing "${model.packageName}" — these no longer compile until the reference is removed: ${dependents.map(d => d.name).join(', ')}.`
      : '',
    sameName(anchor, model.name) ? `⚠️ "${model.name}" was the model this workspace targets — select another project before the next write.` : '',
    'Recovery: `git restore` if the metadata is under source control; otherwise none. A model already deployed to an ' +
      'environment stays installed there until it is uninstalled.',
  ].filter(Boolean).join('\n') + standDownNotice(check));
}

/**
 * After action="undo" removed a descriptor this session created: take away the
 * folders the create made (only while they are empty) and the configuration
 * entries it added. Returns the line undo appends to its reply.
 */
export async function tidyAfterModelUndo(descriptorPath: string, deps: ModelLifecycleDeps = {}): Promise<string> {
  const name = path.basename(descriptorPath).replace(/\.xml$/i, '');
  const descriptorDir = path.dirname(descriptorPath);
  const packageDir = path.dirname(descriptorDir);
  const removed: string[] = [];
  // rmdir, never rm: a folder that has gained content since the create stays.
  for (const dir of [path.join(packageDir, name), descriptorDir, packageDir]) {
    try {
      await fs.rmdir(dir);
      removed.push(dir);
    } catch { /* not empty, or already gone */ }
  }
  invalidateModelVisibility(name);
  const envFile = deps.envFile !== undefined ? deps.envFile : loadedEnvFile();
  const settings = [
    await updateListSetting(envFile, CUSTOM_MODELS_KEY, { remove: name }),
    await updateListSetting(envFile, ALLOW_LIST_KEY, { remove: name }),
  ].filter(o => o.persisted || o.appliedToProcess);
  return (
    (removed.length ? `\nRemoved the empty model folder(s): ${removed.join(', ')}.` : '') +
    (settings.length ? `\n"${name}" was taken out of ${settings.map(o => o.key).join(' and ')}.` : '')
  );
}
