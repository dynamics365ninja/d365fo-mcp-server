/**
 * get_object_info(objectType="model") — the read side of the model lifecycle.
 *
 * One model: what its descriptor says, what it references (each reference
 * checked against the package folders actually present), which models
 * reference IT, the cycles it takes part in, and its projects and objects.
 * name="*": every custom model at a glance, plus the problems worth knowing
 * about before a create, a delete or a build — cycles and references that
 * resolve to nothing.
 *
 * Reads descriptors from disk, not from the symbol index: a descriptor is not
 * an indexed object, and a model created a second ago has to be visible here.
 */

import * as fs from 'fs/promises';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { XppServerContext } from '../../types/context.js';
import { getConfigManager } from '../../utils/configManager.js';
import {
  scanDescriptors, findModel, packageMates, dependentsOfPackage, findReferenceCycles,
  unresolvedReferences, describeLayer, formatVersion, isMicrosoftModel, type ModelEntry, type ModelInventory,
} from '../../metadata/modelInventory.js';

const ArgsSchema = z.object({
  modelName: z.string(),
  /** List Microsoft's models too (name="*"). */
  includeStandard: z.boolean().optional(),
  packagePath: z.string().optional(),
}).passthrough();

const isMicrosoft = (m: ModelEntry) => isMicrosoftModel(m);
const sameName = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

async function inventoryOf(packagePath?: string): Promise<{ inventory: ModelInventory; anchor: string | null; projectsOf(model: string): string[] }> {
  const cfg = getConfigManager();
  await cfg.ensureLoaded();
  const roots = [
    packagePath,
    await cfg.getCustomPackagesPath().catch(() => null),
    cfg.getPackagePath(),
    await cfg.getMicrosoftPackagesPath().catch(() => null),
  ];
  return {
    inventory: scanDescriptors(roots),
    anchor: cfg.getWriteAnchorModel?.() ?? cfg.getModelName?.() ?? null,
    projectsOf: model => cfg.getProjectsForModel?.(model) ?? [],
  };
}

/** Ax* folder → file count, for the objects a model holds. */
async function objectCounts(modelFolder: string): Promise<Array<[string, number]>> {
  const out: Array<[string, number]> = [];
  let folders: string[];
  try {
    folders = await fs.readdir(modelFolder);
  } catch {
    return out;
  }
  for (const folder of folders.sort()) {
    try {
      const files = await fs.readdir(`${modelFolder}/${folder}`, { recursive: true, withFileTypes: true });
      const count = files.filter(f => f.isFile()).length;
      if (count) out.push([folder, count]);
    } catch { /* a file beside the Ax* folders */ }
  }
  return out;
}

function renderList(inventory: ModelInventory, anchor: string | null, includeStandard: boolean): string {
  const custom = inventory.models.filter(m => !isMicrosoft(m));
  const shown = (includeStandard ? inventory.models : custom)
    .slice().sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  const lines = [
    `# Models (${custom.length} custom, ${inventory.models.length - custom.length} Microsoft${includeStandard ? '' : ' — not listed'})`,
    '',
    `Roots: ${inventory.roots.join(', ') || '(none configured)'}`,
    '',
    '| Model | Package | Id | Layer | Version | References | Referenced by |',
    '|---|---|---|---|---|---|---|',
    ...shown.map(m =>
      `| ${m.name}${anchor && sameName(m.name, anchor) ? ' ← workspace' : ''} | ${m.packageName} | ${m.id ?? '?'} | ` +
      `${describeLayer(m.layer)} | ${formatVersion(m.version)} | ${m.moduleReferences.length} | ` +
      `${dependentsOfPackage(inventory, m.packageName).length} |`),
  ];
  if (!shown.length) lines.push('| *(none)* | | | | | | |');

  const problems: string[] = [];
  const customPackages = new Set(custom.map(m => m.packageName.toLowerCase()));
  for (const cycle of findReferenceCycles(inventory)) {
    if (cycle.some(n => customPackages.has(n.toLowerCase()))) problems.push(`Reference cycle: ${cycle.join(' → ')}`);
  }
  for (const m of custom) {
    const missing = unresolvedReferences(inventory, m.moduleReferences);
    if (missing.length) problems.push(`${m.name} references ${missing.join(', ')} — no such package folder on this box`);
  }
  const ids = new Map<number, string[]>();
  for (const m of inventory.models) if (m.id !== null) ids.set(m.id, [...(ids.get(m.id) ?? []), m.name]);
  for (const [id, names] of ids) {
    if (names.length > 1 && names.some(n => custom.some(c => c.name === n))) problems.push(`Model Id ${id} is used by ${names.join(' and ')}`);
  }
  lines.push('', '## Problems', '', ...(problems.length ? problems.map(p => `- ⚠️ ${p}`) : ['None found.']));
  lines.push(
    '',
    'One model in detail: get_object_info(objectType="model", name="<Model>"). ' +
    'Create / edit / delete: get_knowledge(kind="op-spec", topic="model-descriptor").',
  );
  return lines.join('\n');
}

async function renderOne(inventory: ModelInventory, model: ModelEntry, anchor: string | null, projects: string[]): Promise<string> {
  const mates = packageMates(inventory, model);
  const dependents = dependentsOfPackage(inventory, model.packageName);
  const missing = new Set(unresolvedReferences(inventory, model.moduleReferences).map(r => r.toLowerCase()));
  const cycles = findReferenceCycles(inventory).filter(c => c.some(n => sameName(n, model.packageName)));
  const counts = await objectCounts(model.modelFolder);
  const total = counts.reduce((n, [, c]) => n + c, 0);
  const twin = inventory.models.find(m => m !== model && m.id !== null && m.id === model.id);

  return [
    `# Model: \`${model.name}\`${anchor && sameName(model.name, anchor) ? ' (the model this workspace targets)' : ''}`,
    '',
    `**Display name:** ${model.displayName || '—'}`,
    `**Description:** ${model.description || '—'}`,
    `**Publisher:** ${model.publisher || '—'}`,
    `**Layer:** ${describeLayer(model.layer)}`,
    `**Id:** ${model.id ?? '?'}${twin ? ` ⚠️ also used by ${twin.name}` : ''}`,
    `**Version:** ${formatVersion(model.version)}`,
    `**Package:** ${model.packageName}${mates.length ? ` — shared with ${mates.map(m => m.name).join(', ')}` : ''}`,
    `**Descriptor:** \`${model.descriptorPath}\``,
    `**Model folder:** \`${model.modelFolder}\``,
    '',
    `## Module references (${model.moduleReferences.length})`,
    '',
    model.moduleReferences.length
      ? model.moduleReferences.map(r => `- ${r}${missing.has(r.toLowerCase()) ? ' ⚠️ no such package folder on this box' : ''}`).join('\n')
      : '*(none — the model sees only its own package)*',
    '',
    `## Referenced by (${dependents.length})`,
    '',
    dependents.length
      ? dependents.map(d => `- ${d.name}${isMicrosoft(d) ? '' : ` — \`${d.descriptorPath}\``}`).join('\n')
      : `*(no model references package ${model.packageName})*`,
    '',
    ...(cycles.length ? ['## ⚠️ Reference cycles', '', ...cycles.map(c => `- ${c.join(' → ')}`), ''] : []),
    `## Objects (${total} file${total === 1 ? '' : 's'})`,
    '',
    counts.length ? counts.map(([folder, n]) => `- ${folder}: ${n}`).join('\n') : '*(empty)*',
    '',
    `## Visual Studio projects (${projects.length})`,
    '',
    projects.length ? projects.map(p => `- \`${p}\``).join('\n') : '*(none detected)*',
    '',
    'Unused references and missing ones for the code actually written are a compile question — ' +
    'build_d365fo_project reports the latter; nothing here reads the source.',
  ].join('\n');
}

export async function modelInfoTool(request: CallToolRequest, _context: XppServerContext) {
  try {
    const args = ArgsSchema.parse(request.params.arguments);
    const { inventory, anchor, projectsOf } = await inventoryOf(args.packagePath);
    const wanted = args.modelName.trim();
    if (wanted === '*' || wanted.toLowerCase() === 'all') {
      return { content: [{ type: 'text', text: renderList(inventory, anchor, args.includeStandard === true) }] };
    }
    const model = findModel(inventory, wanted)
      // A package name is what references spell, so accept it when it is unambiguous.
      ?? (() => {
        const inPackage = inventory.models.filter(m => sameName(m.packageName, wanted));
        return inPackage.length === 1 ? inPackage[0] : undefined;
      })();
    if (!model) {
      const custom = inventory.models.filter(m => !isMicrosoft(m)).map(m => m.name).sort();
      return {
        content: [{
          type: 'text',
          text: `❌ No model named "${wanted}" has a descriptor under ${inventory.roots.join(', ') || '(no packages root configured)'}.\n` +
            `Custom models here: ${custom.length ? custom.join(', ') : '(none)'}.\n` +
            `List them all with get_object_info(objectType="model", name="*").`,
        }],
        isError: true,
      };
    }
    return { content: [{ type: 'text', text: await renderOne(inventory, model, anchor, projectsOf(model.name)) }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error reading model: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}
