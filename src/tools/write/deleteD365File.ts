/**
 * d365fo_file(action="delete") — remove an AOT object from the model.
 *
 * The counterpart to `create`, and it has to undo BOTH halves of what create
 * did: the XML file on disk, and the `<Content Include>` entry that makes the
 * element part of a Visual Studio project. Deleting only the file leaves an
 * include pointing at nothing — VS reports it, nothing else does, and the next
 * developer to open the project gets a load error for an object that was
 * intentionally removed weeks earlier.
 *
 * It un-registers from EVERY project of the model that lists the object, not
 * just the active one. An element may legitimately belong to several .rnrproj of
 * one model (see registerFileInActiveProject for the measurement behind that),
 * so cleaning only the active project is exactly the case that leaves a dangling
 * include behind.
 *
 * Guards, in order, and none of them optional:
 *   • the object must resolve to a real file — a name that matches nothing is
 *     reported as ❌, never as "done" (a silent no-op reads as a successful
 *     delete and the object is still in the build);
 *   • path containment — the target must sit under a configured
 *     <PackagesLocalDirectory>/<Package>/<Model>/Ax<Type>/<File>.xml layout, so
 *     an explicit filePath cannot traverse out of the metadata tree;
 *   • model ownership — a file in a standard Microsoft model is refused
 *     outright, and one owned by a different CUSTOM model than the write anchor
 *     goes through the same cross-model refusal every write does.
 *
 * There is no bridge path: MetadataWriteService exposes no delete, and going
 * through the provider would be worse anyway — the file and the project entry
 * are what "deleted" means here, and both are on disk.
 */

import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import * as fs from 'fs/promises';
import path from 'path';
import type { XppServerContext } from '../../types/context.js';
import { getConfigManager, extractModelFromFilePath } from '../../utils/configManager.js';
import { isStandardModel } from '../../utils/modelClassifier.js';
import { normalizeObjectName } from '../../utils/objectNaming.js';
import { assertWritePathAllowed } from '../../utils/pathContainment.js';
import { findD365FileOnDisk } from '../../utils/objectFileLookup.js';
import { ProjectFileManager } from '../../workspace/projectFile.js';
import {
  axFolderForObjectType, resolveMembership, projectDisplayName,
} from '../../workspace/projectMembership.js';
import { forgetCreatedArtifact } from '../../workspace/createdArtifactLedger.js';
import { crossModelWriteRefusal } from '../../utils/crossModelWriteGuard.js';
import { resolveAnchorModel } from './writeAnchorGuard.js';
import { bridgeRefreshProvider } from '../../bridge/index.js';

const DeleteD365FileArgsSchema = z.object({
  objectType: z.string().describe('AOT object type — the same enum action="create" takes.'),
  objectName: z.string().optional().describe(
    'Object name. Optional when filePath is given (derived from the basename). The model prefix is ' +
    'applied on a miss, so the base name create was called with also resolves.'
  ),
  modelName: z.string().optional().describe('Model that owns the object — auto-detected when omitted.'),
  filePath: z.string().optional().describe('Absolute path to the XML — bypasses lookup.'),
  packagePath: z.string().optional().describe('Packages root to search when the metadata lives outside the default PackagesLocalDirectory.'),
  projectPath: z.string().optional().describe('Path to a .rnrproj — added to the set searched for includes to remove.'),
  workspacePath: z.string().optional(),
  solutionPath: z.string().optional(),
  // Accepted and ignored: `delete` never adds anything to a project. Declared so
  // a caller reusing a create/modify argument object is not rejected over it.
  addToProject: z.boolean().optional(),
});

/** `❌`-prefixed failure, in the shape every d365fo_file handler returns. */
function fail(text: string) {
  return { content: [{ type: 'text', text }], isError: true };
}

/**
 * Locate the object's XML. Explicit filePath wins; otherwise the AOT path is
 * rebuilt from config, retried under the name create would have written (the
 * caller usually still holds the UNPREFIXED name it passed to create).
 */
async function resolveDeletionTarget(
  objectType: string,
  objectName: string,
  modelName: string | undefined,
  explicitFilePath: string | undefined,
  packagePath: string | undefined,
): Promise<{ filePath: string; resolvedName: string } | null> {
  if (explicitFilePath) {
    return { filePath: explicitFilePath, resolvedName: path.win32.basename(explicitFilePath, '.xml') };
  }

  const direct = await findD365FileOnDisk(objectType, objectName, modelName, packagePath);
  if (direct) return { filePath: direct, resolvedName: objectName };

  const effectiveModel = modelName || getConfigManager().getModelName() || undefined;
  const normalized = normalizeObjectName(objectName, objectType, effectiveModel);
  if (normalized && normalized.toLowerCase() !== objectName.toLowerCase()) {
    const viaNormalized = await findD365FileOnDisk(objectType, normalized, modelName, packagePath);
    if (viaNormalized) return { filePath: viaNormalized, resolvedName: normalized };
  }
  return null;
}

export async function handleDeleteD365File(
  request: CallToolRequest,
  context?: XppServerContext,
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  const args = DeleteD365FileArgsSchema.parse(request.params.arguments);
  const configManager = getConfigManager();
  await configManager.ensureLoaded();

  const objectType = args.objectType;
  let objectName = args.objectName;
  if (!objectName) {
    if (!args.filePath) {
      return fail(
        `❌ d365fo_file(action="delete"): provide 'objectName' — or 'filePath', from which it is derived.`,
      );
    }
    objectName = path.win32.basename(args.filePath, '.xml');
  }

  // ── 1. Resolve ──────────────────────────────────────────────────────────────
  const target = await resolveDeletionTarget(
    objectType, objectName, args.modelName, args.filePath, args.packagePath,
  );
  if (!target) {
    return fail(
      `❌ Nothing deleted — no ${objectType} named "${objectName}" was found on disk.\n\n` +
      `This is NOT a "already gone, nothing to do" answer: the name may simply be wrong, in which ` +
      `case the real object is still in the model.\n` +
      `  1. Confirm the exact name: search(query="${objectName}") or get_object_info(objectType="${objectType}", name="${objectName}").\n` +
      `  2. Pass modelName="<YourModel>" if the object lives in a model other than the active one.\n` +
      `  3. Pass packagePath="<root that contains the model>" for metadata outside the default PackagesLocalDirectory.\n` +
      `  4. Pass filePath="<absolute path to the .xml>" to bypass lookup entirely.`,
    );
  }

  const { filePath } = target;
  const resolvedName = path.win32.basename(filePath, '.xml');

  // Confirm the file is really there. findD365FileOnDisk checks existence, but an
  // explicit filePath bypasses it — and deleting is the one operation where
  // "the path was a guess" must not be discovered by the unlink.
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) {
      return fail(`❌ Refusing to delete a path that is not a file: ${filePath}`);
    }
  } catch {
    return fail(
      `❌ Nothing deleted — ${filePath} does not exist.\n` +
      `The path came from ${args.filePath ? 'the filePath argument' : 'AOT path resolution'}; ` +
      `re-check the object name and model.`,
    );
  }

  // ── 2. Path containment ─────────────────────────────────────────────────────
  const extraRoots = args.packagePath ? [args.packagePath] : undefined;
  const containment = await assertWritePathAllowed(filePath, args.modelName, { extraRoots });
  if (!containment.ok) {
    return fail(`❌ Refusing to delete ${filePath}: ${containment.reason ?? 'path containment check failed'}`);
  }

  // ── 3. Model ownership ──────────────────────────────────────────────────────
  const modelFromPath = extractModelFromFilePath(filePath);
  if (modelFromPath && isStandardModel(modelFromPath)) {
    return fail(
      `⛔ Refusing to delete "${resolvedName}" — it belongs to the standard Microsoft model ` +
      `"${modelFromPath}".\n\nDeleting a base application object corrupts the installation. ` +
      `If the goal is to stop using it, remove YOUR extension of it instead.`,
    );
  }

  const owningModel = containment.modelSegment ?? modelFromPath ?? null;
  const activeModel = await resolveAnchorModel(configManager);
  const crossModelRefusal = crossModelWriteRefusal({
    objectName: resolvedName,
    objectType,
    owningModel,
    owningPackage: containment.packageSegment ?? modelFromPath,
    activeModel,
    toolSwitchedModel: configManager.getToolProjectSwitch()?.forcedModel ?? null,
    action: 'modify',
    existingExtensions: [],
  });
  if (crossModelRefusal) return fail(crossModelRefusal);

  // ── 4. Un-register from every project of the model that lists it ────────────
  // Done BEFORE the unlink: an include whose file is already gone is the state
  // this is here to prevent, and a project that cannot be written is worth
  // reporting while the object is still whole.
  const axFolder = axFolderForObjectType(objectType);
  const modelForProjects = owningModel ?? args.modelName ?? configManager.getModelName();
  const configuredProjects = configManager.getProjectsForModel?.(modelForProjects) ?? [];
  const activeProject = args.projectPath || (await configManager.getProjectPath()) || undefined;

  const membership = await resolveMembership(
    axFolder,
    resolvedName,
    activeProject,
    configuredProjects,
  );

  const unregistered: string[] = [];
  const unregisterFailures: string[] = [];
  const projectManager = new ProjectFileManager();
  for (const projectPath of membership.owners) {
    try {
      const removed = await projectManager.removeFromProject(projectPath, objectType, resolvedName);
      if (removed) unregistered.push(projectDisplayName(projectPath));
    } catch (e: any) {
      unregisterFailures.push(`${projectDisplayName(projectPath)}: ${e?.message ?? e}`);
    }
  }

  // ── 5. Delete the file ──────────────────────────────────────────────────────
  try {
    await fs.unlink(filePath);
  } catch (e: any) {
    return fail(
      `❌ Failed to delete ${filePath}: ${e?.message ?? e}\n` +
      (unregistered.length > 0
        ? `⚠️ The project entr${unregistered.length === 1 ? 'y' : 'ies'} in ${unregistered.join(', ')} ` +
          `${unregistered.length === 1 ? 'was' : 'were'} already removed — re-add the object there, or ` +
          `retry the delete once the file is not locked (Visual Studio holds open metadata files).`
        : ''),
    );
  }

  // ── 6. Forget the object ────────────────────────────────────────────────────
  // Stale symbols outlive the file and every later search, prepare and
  // validate_code answers from them — the object reads as existing right up to
  // the build that cannot find it.
  let indexNote = '';
  try {
    const { deletedCount } = context?.symbolIndex?.removeSymbolsByFile?.(filePath) ?? { deletedCount: 0 };
    const labelCount = context?.symbolIndex?.removeLabelsByFile?.(filePath) ?? 0;
    indexNote =
      `\n🧹 Index: removed ${deletedCount} symbol(s)` +
      (labelCount > 0 ? ` and ${labelCount} label(s)` : '') + '.';
  } catch (e) {
    console.error(`[delete_d365fo_file] Index cleanup failed (non-fatal): ${e}`);
    indexNote = `\n⚠️ Index cleanup failed — run update_symbol_index if stale hits appear for "${resolvedName}".`;
  }
  // The create may have recorded this path for the non-git undo; that entry now
  // points at nothing and would make undo_last_modification act on a ghost.
  forgetCreatedArtifact(filePath);
  try {
    await bridgeRefreshProvider(context?.bridge);
  } catch { /* bridge not available — nothing loaded it anyway */ }

  // ── 7. Report ───────────────────────────────────────────────────────────────
  const projectNote =
    unregistered.length > 0
      ? `\n✅ Un-registered from ${unregistered.length} project(s): ${unregistered.join(', ')}.` +
        `\nℹ️  Right-click → Reload Project if Visual Studio is open.`
      : membership.status === 'unknown'
        ? `\nℹ️ No .rnrproj could be read, so no project entry was touched. If some project lists ` +
          `\`${axFolder}\\${resolvedName}\`, remove that entry too or the project will fail to load.`
        : `\nℹ️ No project of model "${modelForProjects ?? '(unknown)'}" referenced ` +
          `\`${axFolder}\\${resolvedName}\` — nothing to un-register.`;

  const failureNote = unregisterFailures.length > 0
    ? `\n⚠️ Could not update ${unregisterFailures.length} project file(s): ${unregisterFailures.join('; ')}\n` +
      `The XML is deleted; remove those includes by hand (or close Visual Studio and re-run) or the ` +
      `project will not load.`
    : '';

  return {
    content: [{
      type: 'text',
      text:
        `✅ Deleted D365FO ${objectType} "${resolvedName}".\n\n` +
        `🗑️  File: ${filePath}\n` +
        `📦 Model: ${owningModel ?? modelForProjects ?? '(unknown)'}` +
        projectNote +
        failureNote +
        indexNote +
        `\n\nNext: build_d365fo_project to compile the model without it. References to "${resolvedName}" ` +
        `elsewhere are now compile errors — find_references before deleting is the cheap way to know; ` +
        `if this delete was a mistake, restore the file from source control (there is no undo for it).`,
    }],
  };
}
