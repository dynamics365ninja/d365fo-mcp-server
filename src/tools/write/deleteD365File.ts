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
 *   • grounding — the gate create and modify apply to *-extension objects, under
 *     GROUNDING_ENFORCE=true. Exempting the one action that cannot be undone
 *     would mean an agent barred from CREATING an extension without a prepare
 *     token is free to DELETE one;
 *   • the object must resolve to a real file — a name that matches nothing is
 *     reported as ❌, never as "done" (a silent no-op reads as a successful
 *     delete and the object is still in the build);
 *   • path containment — the target must sit under a configured
 *     <PackagesLocalDirectory>/<Package>/<Model>/Ax<Type>/<File>.xml layout, so
 *     an explicit filePath cannot traverse out of the metadata tree;
 *   • objectType against the file's own Ax<Type> folder — everything downstream
 *     trusts objectType, and axFolderForObjectType answers 'AxClass' for anything
 *     it does not recognise, so a mismatch would delete this file and un-register
 *     a different object;
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
import { enforceGrounding } from '../../utils/provenanceStore.js';
import { resolveAnchorModel } from './writeAnchorGuard.js';
import { bridgeRefreshProvider } from '../../bridge/index.js';
import {
  removeDiagnosticSuppressionsByPathPrefix, suppressionPathSegmentsForObjectType,
} from '../../utils/ignoreDiagnosticListXml.js';
import { writeFileAtomic } from '../../utils/atomicFileWrite.js';
import { normalizeD365Xml } from '../../utils/d365XmlNormalizer.js';

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
  groundingToken: z.string().optional().describe(
    'prepare(mode="change") token — required for *-extension objects when GROUNDING_ENFORCE=true, ' +
    'the same gate create and modify apply.'
  ),
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
 *
 * Only the path comes back: the object's real name is the file's basename in
 * every branch, and the caller derives it there. Returning a second, separately
 * computed name invites the two to disagree.
 */
async function resolveDeletionTarget(
  objectType: string,
  objectName: string,
  modelName: string | undefined,
  explicitFilePath: string | undefined,
  packagePath: string | undefined,
): Promise<string | null> {
  if (explicitFilePath) return explicitFilePath;

  const direct = await findD365FileOnDisk(objectType, objectName, modelName, packagePath);
  if (direct) return direct;

  const effectiveModel = modelName || getConfigManager().getModelName() || undefined;
  const normalized = normalizeObjectName(objectName, objectType, effectiveModel);
  if (normalized && normalized.toLowerCase() !== objectName.toLowerCase()) {
    const viaNormalized = await findD365FileOnDisk(objectType, normalized, modelName, packagePath);
    if (viaNormalized) return viaNormalized;
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

  // ── 0. Grounding ────────────────────────────────────────────────────────────
  // The same gate create and modify apply to extension objects, and there is no
  // argument for exempting the one action that cannot be undone: an agent barred
  // from CREATING a table extension without a prepare token must not be free to
  // DELETE one. Enforced only when GROUNDING_ENFORCE=true (see enforceGrounding).
  if (objectType.endsWith('-extension')) {
    const groundingError = enforceGrounding(
      args.groundingToken,
      `d365fo_file(action="delete", objectType="${objectType}", objectName="${objectName}")`,
      objectName,
    );
    if (groundingError) return groundingError;
  }

  // ── 1. Resolve ──────────────────────────────────────────────────────────────
  const filePath = await resolveDeletionTarget(
    objectType, objectName, args.modelName, args.filePath, args.packagePath,
  );
  if (!filePath) {
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

  // ── 2b. objectType must match the folder the file actually sits in ──────────
  // Everything downstream trusts objectType: the un-register step builds its
  // `<Content Include>` from it, and axFolderForObjectType answers 'AxClass' for
  // anything it does not recognise. So `objectType="form"` with a filePath under
  // AxTable deletes the table and then hunts for `AxForm\<Name>` in the projects —
  // and an objectType outside the enum deletes the file while un-registering a
  // same-named CLASS. Both are caller mistakes; neither should be survivable.
  const expectedFolder = axFolderForObjectType(objectType);
  const actualFolder = path.win32.basename(path.win32.dirname(filePath));
  if (actualFolder && actualFolder.toLowerCase() !== expectedFolder.toLowerCase()) {
    return fail(
      `❌ Refusing to delete ${filePath}: objectType="${objectType}" maps to the AOT folder ` +
      `"${expectedFolder}", but the file sits in "${actualFolder}".\n\n` +
      `Deleting it under the wrong type would un-register \`${expectedFolder}\\${resolvedName}\` — a ` +
      `different object — and leave this one's project entry behind.\n` +
      `  • Pass the objectType that matches the folder ("${actualFolder}"), or\n` +
      `  • drop filePath and let the name resolve, if the type is the one you meant.`,
    );
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
    action: 'delete',
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
      // `owners` came from resolveMembership, which read this very project and
      // found the include. A remover that then matches nothing is a disagreement
      // between the two, not an absent entry — and swallowing it produces exactly
      // the state this step exists to prevent: the file unlinked, the include
      // still there, and a report saying no project referenced the object.
      else unregisterFailures.push(
        `${projectDisplayName(projectPath)}: lists \`${axFolder}\\${resolvedName}\` but the entry did ` +
        `not match on removal`,
      );
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

  // ── 6b. Suppression cleanup ──────────────────────────────────────────────────
  // A deleted object's own <Diagnostic> entries in {Model}_BPSuppressions.xml
  // outlive it otherwise: each one's <Path> addresses a dynamics:// target that
  // now resolves to nothing, and nobody notices until BP-check is re-run long
  // after the deletion (exactly what forced a manual XML edit before this
  // existed — see ignoreDiagnosticListXml.ts). Best-effort and non-fatal: the
  // object is already gone from disk either way, so a cleanup failure here must
  // not turn a successful delete into a reported failure.
  let suppressionNote = '';
  if (objectType !== 'ignore-diagnostic-list') {
    try {
      // EVERY list in the model's AxIgnoreDiagnosticList folder, not just
      // {Model}_BPSuppressions.xml. Measured on a shipped PackagesLocalDirectory:
      // one model routinely carries several lists, and their names are tied to
      // neither the model nor a convention — ApplicationFoundation alone ships
      // ApplicationFoundation_BPSuppressions.xml, ApplicationIntegration_BPSuppressions.xml,
      // ApplicationFoundation_CompatibilityChecker.xml, CompatErrors.xml and
      // CompileError.xml, while model "Electronic Reporting Application Suite
      // Integration" names its list ER_App_Suite_Int_BPSuppressions.xml. xppbp
      // reads all of them, so cleaning one by its assumed name leaves the rest
      // silencing rules against an object that no longer exists.
      //
      // The folder is derived from the deleted object's own path — it is the
      // sibling of its Ax<Type> folder — which also gets the <Package> segment
      // right for a package != model layout without re-resolving anything.
      const listsFolder = path.win32.join(
        path.win32.dirname(path.win32.dirname(filePath)), 'AxIgnoreDiagnosticList',
      );
      const prefixes = suppressionPathSegmentsForObjectType(objectType, axFolder)
        .map(segment => `dynamics://${segment}/${resolvedName}`);

      const listFiles = (await fs.readdir(listsFolder).catch(() => [] as string[]))
        .filter(entry => entry.toLowerCase().endsWith('.xml'));

      const removedMonikers: string[] = [];
      const cleanedFiles: string[] = [];
      for (const entry of listFiles) {
        const listPath = path.win32.join(listsFolder, entry);
        const raw = await fs.readFile(listPath, 'utf-8');
        const content = raw.replace(/^﻿/, '').replace(/\r\n/g, '\n');
        const { xml, removed } = removeDiagnosticSuppressionsByPathPrefix(content, prefixes);
        if (removed.length === 0) continue;
        await writeFileAtomic(listPath, normalizeD365Xml(xml));
        removedMonikers.push(...removed.map(r => r.moniker));
        cleanedFiles.push(entry);
      }

      if (removedMonikers.length > 0) {
        suppressionNote =
          `\n🧹 BP suppressions: removed ${removedMonikers.length} stale <Diagnostic> ` +
          `entr${removedMonikers.length === 1 ? 'y' : 'ies'} (${removedMonikers.join(', ')}) from ` +
          `${cleanedFiles.join(', ')} in ${listsFolder}.`;
      }
    } catch (e) {
      console.error(`[delete_d365fo_file] Suppression cleanup failed (non-fatal): ${e}`);
      suppressionNote =
        `\n⚠️ BP suppression cleanup failed — check "${resolvedName}"'s entries in the model's ` +
        `AxIgnoreDiagnosticList\\*.xml by hand: ${e instanceof Error ? e.message : e}`;
    }
  }

  // ── 7. Report ───────────────────────────────────────────────────────────────
  // "Nothing to un-register" is a claim about the PROJECTS, and it is only true
  // when none of them listed the object. Deriving it from `unregistered` being
  // empty spoke for the failures too: a project that was an owner and could not
  // be updated came back as "no project referenced it", which is the dangling
  // include the failure note two lines below is warning about.
  const projectNote =
    unregistered.length > 0
      ? `\n✅ Un-registered from ${unregistered.length} project(s): ${unregistered.join(', ')}.` +
        `\nℹ️  Right-click → Reload Project if Visual Studio is open.`
      : unregisterFailures.length > 0
        ? '' // the failure note below is the whole story
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
        suppressionNote +
        // Deliberately short: "run find_references before deleting" was advice the
        // reader can no longer act on, and the undo paragraph restated in prose what
        // the one call already says.
        `\n\nNext: build_d365fo_project — every remaining reference to "${resolvedName}" is now a compile error ` +
        `(find_references lists them).\n` +
        `Undo (git-backed models only): undo_last_modification(filePath="${filePath}") restores the XML, but not the ` +
        `project entr${unregistered.length === 1 ? 'y' : 'ies'} removed above — re-add ` +
        `${unregistered.length > 0 ? `\`${axFolder}\\${resolvedName}\` in ${unregistered.join(', ')}` : 'any project entry'} ` +
        `by hand or from source control.`,
    }],
  };
}
