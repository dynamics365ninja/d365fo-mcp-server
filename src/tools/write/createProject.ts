/** Handlers for d365fo_file(action="project") operations create and delete. File work is in workspace/projectScaffold.ts. */

import * as path from 'path';
import { z } from 'zod';
import { getConfigManager } from '../../utils/configManager.js';
import { isStandardModel } from '../../utils/modelClassifier.js';
import { extractModelNameFromProject } from '../../utils/workspaceDetector.js';
import { assertProjectPathAllowed } from '../../utils/pathContainment.js';
import { withToolErrorCode, hoistToolErrorCode } from '../../utils/toolError.js';
import {
  scaffoldProject, removeProject, validateProjectName, ScaffoldError, inferProjectsRoot, looksLikeProjectsRoot,
  type SolutionMode,
} from '../../workspace/projectScaffold.js';

const ArgsSchema = z.object({
  projectName: z.string(),
  modelName: z.string().optional(),
  projectsRoot: z.string().optional(),
  solutionMode: z.enum(['auto', 'shared', 'per-project', 'none']).optional(),
  solutionFile: z.string().optional(),
  displayName: z.string().optional(),
  dependsOn: z.array(z.string()).optional(),
  activate: z.boolean().optional(),
}).passthrough();

function fail(text: string) {
  return { content: [{ type: 'text', text: hoistToolErrorCode(`❌ d365fo_file(action="project", operation="create"): ${text}`) }], isError: true };
}

export async function handleCreateProject(args: Record<string, unknown>) {
  const parsed = ArgsSchema.safeParse(args);
  if (!parsed.success) {
    return fail(
      `invalid arguments — ${parsed.error.message}\n` +
      `Contract: get_knowledge(kind="op-spec", topic="project").`,
    );
  }
  const a = parsed.data;
  const cfg = getConfigManager();
  await cfg.ensureLoaded();

  const modelName = a.modelName?.trim() || cfg.getModelName() || '';
  if (!modelName) {
    return fail('no modelName given and none could be detected — pass modelName (the custom model the project builds).');
  }
  // The configured model is the user's own; refuse only other models that look standard.
  const isConfiguredModel = cfg.getModelName()?.toLowerCase() === modelName.toLowerCase();
  if (isStandardModel(modelName) && !isConfiguredModel && !cfg.getProjectsForModel(modelName).length) {
    return fail(withToolErrorCode('E_MODEL_NOT_WRITABLE',
      `"${modelName}" looks like a standard Microsoft model — refusing to create a project for it ` +
      `(if it is your custom model, list it in CUSTOM_MODELS).`));
  }

  const siblings = cfg.getProjectsForModel(modelName);
  let projectsRoot = a.projectsRoot?.trim() || '';
  if (!projectsRoot) {
    projectsRoot = inferProjectsRoot(siblings) ?? '';
  }
  if (!projectsRoot) {
    const solution = await cfg.getSolutionPath();
    if (solution) projectsRoot = solution;
  }
  if (!projectsRoot) {
    return fail(
      `cannot tell where the projects of "${modelName}" live: the model has no existing project and no ` +
      `solutionPath is configured. Ask the user for the projects folder and pass projectsRoot ` +
      `(e.g. <repo>\\src\\Projects\\${modelName}).`,
    );
  }
  projectsRoot = path.resolve(projectsRoot);
  const contained = await assertProjectPathAllowed(projectsRoot);
  if (!contained.ok) return fail(contained.reason!);
  if (!(await looksLikeProjectsRoot(projectsRoot))) {
    return fail(
      `${projectsRoot} holds no .sln or .rnrproj (directly or one folder down), so it does not look like a ` +
      `projects folder — refusing to create files there. If this really is a brand-new model, create its ` +
      `first project in Visual Studio once, or ask the user to confirm the folder.`,
    );
  }

  let result;
  try {
    result = await scaffoldProject({
      projectName: a.projectName,
      modelName,
      projectsRoot,
      solutionMode: (a.solutionMode ?? 'auto') as SolutionMode,
      solutionFile: a.solutionFile,
      displayName: a.displayName,
      dependsOn: a.dependsOn,
      templateProject: siblings[0],
    });
  } catch (e) {
    if (e instanceof ScaffoldError) return fail(e.message);
    return fail(`unexpected error — ${(e as Error)?.message ?? e}`);
  }

  // Make it the target of the next create. forceProject, not setRuntimeContext: a
  // projectPath the detection cache has never seen makes setRuntimeContext drop the
  // detected project (the model then reads null) AND the write anchor, so a project
  // made for another model would let the next create write there unchecked.
  let activated = false;
  if (a.activate !== false) {
    try { activated = (await cfg.forceProject(result.projectPath)) !== null; } catch { /* advisory */ }
  }

  const lines = [
    `✅ Created project ${a.projectName} (model ${modelName}) — solution layout: ${result.solutionMode}.`,
    ...result.written.map(f => `📁 ${f}`),
    `projectPath: ${result.projectPath}`,
    result.solutionPath
      ? `solution: ${result.solutionPath}${result.dependsOn.length ? ` (builds after: ${result.dependsOn.join(', ')})` : ''}`
      : 'solution: none — the project is not in any .sln',
    activated
      ? 'It is now the active project: objects created next are registered into it (addToProject).'
      : 'Not activated — pass projectPath on later creates to register objects into it.',
    'If Visual Studio has the solution open, reload it (Solution Explorer → Reload) to see the new project.',
  ];
  return { content: [{ type: 'text', text: lines.join('\n') }] };
}

const DeleteArgsSchema = z.object({
  projectPath: z.string().optional(),
  projectName: z.string().optional(),
  modelName: z.string().optional(),
  projectsRoot: z.string().optional(),
  removeFiles: z.boolean().optional(),
}).passthrough();

/** d365fo_file(action="project", operation="delete") — see the op-spec for the contract. */
export async function handleDeleteProject(args: Record<string, unknown>) {
  const label = 'd365fo_file(action="project", operation="delete")';
  const bad = (text: string) => ({ content: [{ type: 'text', text: `❌ ${label}: ${text}` }], isError: true });
  const parsed = DeleteArgsSchema.safeParse(args);
  if (!parsed.success) return bad(`invalid arguments — ${parsed.error.message}`);
  const a = parsed.data;
  const cfg = getConfigManager();
  await cfg.ensureLoaded();

  let projectPath = a.projectPath?.trim() || '';
  if (!projectPath) {
    if (!a.projectName) return bad('pass projectPath (the .rnrproj) or projectName.');
    const nameError = validateProjectName(a.projectName);
    if (nameError) return bad(nameError);
    const locatingModel = a.modelName?.trim() || cfg.getModelName() || '';
    const root = a.projectsRoot?.trim() || inferProjectsRoot(cfg.getProjectsForModel(locatingModel)) || '';
    if (!root) return bad('cannot tell where the project lives — pass projectPath.');
    projectPath = path.join(root, a.projectName, `${a.projectName}.rnrproj`);
  }
  projectPath = path.resolve(projectPath);
  // The projects folder, not just the .rnrproj: the shared .sln this rewrites sits
  // beside the project folder, one level above the project itself.
  const contained = await assertProjectPathAllowed(path.dirname(path.dirname(projectPath)));
  if (!contained.ok) return bad(contained.reason!);
  // Orphans are judged against the projects of the model THIS project builds, which
  // need not be the configured one.
  const modelName = (await extractModelNameFromProject(projectPath)) || a.modelName?.trim() || cfg.getModelName() || '';
  const siblings = cfg.getProjectsForModel(modelName);
  // This unlinks files: stay inside a folder that looks like a projects folder.
  if (!(await looksLikeProjectsRoot(path.dirname(path.dirname(projectPath))))) {
    return bad(`${projectPath} is not inside a projects folder (no .sln/.rnrproj around it) — refusing.`);
  }

  let result;
  try {
    result = await removeProject({
      projectPath, removeFiles: a.removeFiles === true, otherProjectPaths: siblings,
    });
  } catch (e) {
    if (e instanceof ScaffoldError) return bad(e.message);
    return bad(`unexpected error — ${(e as Error)?.message ?? e}`);
  }

  const lines = [
    `✅ Removed project ${path.basename(projectPath, '.rnrproj')}.`,
    ...result.solutions.map(s => `solution updated: ${s}`),
    ...result.removed.map(f => `🗑️ ${f}`),
    result.removed.length
      ? 'The project folder is deleted. If the repo is under git, `git restore` brings it back.'
      : 'The project files were left on disk (removeFiles not set).',
    'Model metadata was NOT touched — every object it listed is still on disk and still compiles.',
  ];
  if (result.orphanedElements.length) {
    const shown = result.orphanedElements.slice(0, 20).map(e => `  - ${e}`);
    lines.push(
      `⚠️ ${result.orphanedElements.length} element(s) it listed are in no other project of the model, so they ` +
      `no longer appear in Visual Studio (they still build):\n${shown.join('\n')}` +
      (result.orphanedElements.length > 20 ? '\n  - …' : ''),
    );
  }
  try {
    const active = await cfg.getProjectPath();
    if (active && path.resolve(active).toLowerCase() === projectPath.toLowerCase()) {
      lines.push('⚠️ This was the active project — pass projectPath on the next create, or create/select another project.');
    }
  } catch { /* advisory */ }
  lines.push('If Visual Studio has the solution open, reload it.');
  return { content: [{ type: 'text', text: lines.join('\n') }] };
}
