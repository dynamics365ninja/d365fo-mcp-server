/**
 * d365fo_file(action="project") — VS project operations, discriminated by `operation`:
 * create | delete | add-object | remove-object.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { z } from 'zod';
import { getConfigManager } from '../../utils/configManager.js';
import { findD365FileOnDisk } from '../../utils/objectFileLookup.js';
import { PackageResolver } from '../../utils/packageResolver.js';
import { extractModelNameFromProject } from '../../utils/workspaceDetector.js';
import { assertProjectPathAllowed } from '../../utils/pathContainment.js';
import { ProjectFileManager } from '../../workspace/projectFile.js';
import { solutionsListingProject, solutionMateProjects } from '../../workspace/projectScaffold.js';
import { axFolderForObjectType, hasAxFolder, resolveMembership } from '../../workspace/projectMembership.js';
import { handleCreateProject, handleDeleteProject } from './createProject.js';
import { withToolErrorCode, hoistToolErrorCode } from '../../utils/toolError.js';

export const PROJECT_OPERATIONS = ['create', 'delete', 'add-object', 'remove-object'] as const;
const MAX_OBJECTS = 20;

const text = (t: string, isError = false) => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) });

const MembershipSchema = z.object({
  objects: z.array(z.object({ objectType: z.string(), objectName: z.string() })).optional(),
  objectType: z.string().optional(),
  objectName: z.string().optional(),
  projectPath: z.string().optional(),
  modelName: z.string().optional(),
  packagePath: z.string().optional(),
  languages: z.array(z.string()).optional(),
  allowOrphan: z.boolean().optional(),
}).passthrough();

export async function handleProject(args: Record<string, unknown>) {
  const op = typeof args.operation === 'string' ? args.operation.trim().toLowerCase() : '';
  switch (op) {
    case 'create': return handleCreateProject(args);
    case 'delete': return handleDeleteProject(args);
    case 'add-object':
    case 'remove-object': return handleMembership(op, args);
    default:
      return text(withToolErrorCode('E_UNSUPPORTED_OPERATION',
        `❌ d365fo_file(action="project"): operation must be one of ${PROJECT_OPERATIONS.join(' | ')}` +
        `${op ? ` (got "${op}")` : ''}, passed in params. Contract: get_knowledge(kind="op-spec", topic="project").`),
        true,
      );
  }
}

async function handleMembership(op: 'add-object' | 'remove-object', args: Record<string, unknown>) {
  const label = `d365fo_file(action="project", operation="${op}")`;
  const bad = (t: string) => text(hoistToolErrorCode(`❌ ${label}: ${t}`), true);
  const parsed = MembershipSchema.safeParse(args);
  if (!parsed.success) return bad(`invalid arguments — ${parsed.error.message}`);
  const a = parsed.data;

  const objects = a.objects ?? (a.objectType && a.objectName ? [{ objectType: a.objectType, objectName: a.objectName }] : []);
  if (!objects.length) return bad('pass objects[] or objectType + objectName.');
  if (objects.length > MAX_OBJECTS) return bad(`${objects.length} objects, max ${MAX_OBJECTS} per call.`);

  const cfg = getConfigManager();
  await cfg.ensureLoaded();
  const explicit = a.projectPath?.trim();
  const projectPath = path.resolve(explicit || (await cfg.getProjectPath()) || '');
  if (!explicit && !(await cfg.getProjectPath())) {
    const candidates = cfg.getProjectsForModel(a.modelName?.trim() || cfg.getModelName());
    return bad(withToolErrorCode('E_NO_PROJECT', 'no active project (it is kept in memory only, so a server restart clears it) — pass projectPath.') +
      (candidates.length ? `\nProjects of the model:\n${candidates.slice(0, 15).map(c => `  - ${c}`).join('\n')}` : ''));
  }
  if (!projectPath.toLowerCase().endsWith('.rnrproj')) return bad('projectPath must be a .rnrproj file.');
  // The active project included: it may have been activated by a create in any folder.
  const contained = await assertProjectPathAllowed(projectPath);
  if (!contained.ok) return bad(contained.reason!);

  // A path the caller supplied must be a known project, not just any .rnrproj.
  const known = cfg.getAllDetectedProjects().some(p => p.projectPath && path.resolve(p.projectPath).toLowerCase() === projectPath.toLowerCase());
  if (explicit && !known && !(await solutionsListingProject(projectPath)).length) {
    return bad(`${projectPath} is not listed in a solution beside it and is not a detected project — refusing.`);
  }

  // The project's own <Model> decides: an object of any other model registered in it
  // fails the VS build, and orphans are judged against that model's projects.
  const projectModel = await extractModelNameFromProject(projectPath);
  if (projectModel && a.modelName?.trim() && a.modelName.trim().toLowerCase() !== projectModel.toLowerCase()) {
    return bad(`${path.basename(projectPath)} builds model ${projectModel}, not ${a.modelName.trim()} — ` +
      `a project holds objects of its own model only.`);
  }
  const modelName = projectModel || a.modelName?.trim() || cfg.getModelName() || undefined;
  const self = projectPath.toLowerCase();
  const siblings = [...new Map(
    [...cfg.getProjectsForModel(modelName), ...(await solutionMateProjects(projectPath))]
      .filter(p => path.resolve(p).toLowerCase() !== self)
      .map(p => [path.resolve(p).toLowerCase(), p]),
  ).values()];
  const mgr = new ProjectFileManager();
  const rows: string[] = [];
  let failed = 0;

  for (const { objectType, objectName } of objects) {
    const id = `${objectType} ${objectName}`;
    const fail = (why: string) => { failed++; rows.push(`❌ ${id}: ${why}`); };
    if (objectType === 'label-file') {
      if (op === 'remove-object') { fail('label-file removal is not supported.'); continue; }
      try {
        const onDisk = await labelLanguages(cfg, modelName, objectName, a.packagePath);
        if (!onDisk.length) { fail('no label descriptor files (<name>_<lang>.xml) found in the model — check the label file name.'); continue; }
        // An explicit list is checked against the files too: an entry for a language
        // with no file fails the VS build later, and the value lands in an Include path.
        let langs = onDisk;
        if (a.languages?.length) {
          const missing = a.languages.filter(l => !onDisk.some(d => d.toLowerCase() === l.toLowerCase()));
          if (missing.length) {
            fail(`no ${objectName}_<lang>.xml for ${missing.join(', ')} — on disk: ${onDisk.join(', ')}.`);
            continue;
          }
          langs = onDisk.filter(d => a.languages!.some(l => l.toLowerCase() === d.toLowerCase()));
        }
        const added = await mgr.addLabelToProject(projectPath, objectName, langs);
        rows.push(added.length ? `✅ ${id}: added (${langs.join(', ')}).` : `ℹ️ ${id}: already in the project.`);
      } catch (e) { fail((e as Error)?.message ?? String(e)); }
      continue;
    }
    if (!hasAxFolder(objectType)) { fail('unknown objectType (same enum as create).'); continue; }
    try {
      if (op === 'add-object') {
        const file = await findD365FileOnDisk(objectType, objectName, modelName, a.packagePath);
        if (!file) { fail('no such file on disk — pass the final name (prefix included), or create it first.'); continue; }
        rows.push((await mgr.addToProject(projectPath, objectType, objectName, ''))
          ? `✅ ${id}: added.`
          : `ℹ️ ${id}: already in the project.`);
      } else {
        const m = await resolveMembership(axFolderForObjectType(objectType), objectName, projectPath, siblings);
        if (m.status !== 'active') { rows.push(`ℹ️ ${id}: not in the project.`); continue; }
        if (m.owners.length < 2 && !a.allowOrphan) {
          fail('the only project referencing it — it would leave Visual Studio (allowOrphan=true to remove anyway).');
          continue;
        }
        rows.push((await mgr.removeFromProject(projectPath, objectType, objectName))
          ? `✅ ${id}: removed (file untouched).`
          : `ℹ️ ${id}: not in the project.`);
      }
    } catch (e) {
      fail((e as Error)?.message ?? String(e));
    }
  }

  const head = `${failed ? '⚠️' : '✅'} ${label} on ${path.basename(projectPath)} — ${objects.length - failed}/${objects.length} ok`;
  return text(`${head}\n${rows.join('\n')}\nReload the project in Visual Studio if it is open.`, failed > 0);
}

/** Languages a label file has on disk: the `<id>_<lang>.xml` descriptors in the model's AxLabelFile folder. */
async function labelLanguages(
  cfg: ReturnType<typeof getConfigManager>, modelName: string | undefined, labelFileId: string, packagePath?: string,
): Promise<string[]> {
  if (!modelName) throw new Error('modelName is required for a label file.');
  const roots = [packagePath, cfg.getPackagePath(), await cfg.getCustomPackagesPath(), await cfg.getMicrosoftPackagesPath()]
    .filter((r): r is string => !!r);
  const resolved = await new PackageResolver(roots).resolve(modelName);
  const dir = resolved
    ? path.join(resolved.rootPath, resolved.packageName, modelName, 'AxLabelFile')
    : path.join(roots[0] ?? '', modelName, modelName, 'AxLabelFile');
  const prefix = `${labelFileId}_`.toLowerCase();
  const files = await fs.readdir(dir).catch(() => [] as string[]);
  return files
    .filter(f => f.toLowerCase().startsWith(prefix) && f.toLowerCase().endsWith('.xml'))
    .map(f => f.slice(prefix.length, -'.xml'.length));
}
