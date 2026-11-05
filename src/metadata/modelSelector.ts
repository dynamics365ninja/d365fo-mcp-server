/**
 * Model selection by name, glob mask and exclusion — what `--models` and `--deps` of the version
 * scripts accept: `Contoso*`, `ContosoApp_*,Fabrikam*`, `*,!ContosoDemo*`.
 *
 * A model has a module name (the folder name in an extract) and may have a display name ("Contoso
 * Core" for the module `ContosoCore`); a mask matches either. A spec is a comma-separated list. A
 * leading `!` excludes. A spec with only exclusions starts from every model. Matching ignores case,
 * like X++ does.
 */

import * as fs from 'fs';
import * as path from 'path';
import { listModels } from './versionDiff.js';

export interface ModelName {
  /** Module name: the folder of the model in an extracted-metadata directory. */
  name: string;
  /** Other names the model answers to (display name). */
  aliases?: string[];
}

export function globToRegExp(glob: string): RegExp {
  const body = glob
    .trim()
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${body}$`, 'i');
}

export interface ModelSpec {
  include: RegExp[];
  exclude: RegExp[];
  /** The mask entries as written, for messages. */
  patterns: string[];
}

export function parseModelSpec(spec: string | string[] | undefined): ModelSpec {
  const parts = (Array.isArray(spec) ? spec : (spec ?? '').split(','))
    .flatMap(p => p.split(','))
    .map(p => p.trim())
    .filter(Boolean);
  return {
    include: parts.filter(p => !p.startsWith('!')).map(globToRegExp),
    exclude: parts.filter(p => p.startsWith('!')).map(p => globToRegExp(p.slice(1))),
    patterns: parts,
  };
}

const answersTo = (m: ModelName, res: RegExp[]): boolean =>
  res.some(re => [m.name, ...(m.aliases ?? [])].some(n => re.test(n)));

/** The candidates the spec selects, in the order given. */
export function selectModels(spec: string | string[] | undefined, candidates: ModelName[]): string[] {
  const s = parseModelSpec(spec);
  return candidates
    .filter(m => (s.include.length === 0 || answersTo(m, s.include)) && !answersTo(m, s.exclude))
    .map(m => m.name);
}

/** True when the spec names models exactly (no mask); a missing one is then an error, not an empty match. */
export const isExactSpec = (spec: string | undefined): boolean => !/[*?!]/.test(spec ?? '');

/** Models of an extracted-metadata directory with the display name binary-ISV records carry. */
export function listModelNames(dir: string): ModelName[] {
  return listModels(dir).map(name => {
    const classes = path.join(dir, name, 'classes');
    const first = fs.existsSync(classes) ? fs.readdirSync(classes).find(f => f.endsWith('.json')) : undefined;
    let display: string | undefined;
    if (first) {
      try {
        display = (
          JSON.parse(fs.readFileSync(path.join(classes, first), 'utf-8')) as { binaryIsv?: { displayName?: string } }
        ).binaryIsv?.displayName;
      } catch {
        // an unreadable record just has no alias
      }
    }
    return { name, aliases: display && display !== name ? [display] : [] };
  });
}

/** What a mask selected on each side of a comparison, and what only one side has. */
export interface SideSelection {
  from: string[];
  to: string[];
  both: string[];
  onlyInFrom: string[];
  onlyInTo: string[];
}

export function selectOnBothSides(
  spec: string | undefined,
  from: ModelName[],
  to: ModelName[],
  skip: string[] = [],
): SideSelection {
  const drop = new Set(skip.map(s => s.toLowerCase()));
  const f = selectModels(spec, from).filter(m => !drop.has(m.toLowerCase()));
  const t = selectModels(spec, to).filter(m => !drop.has(m.toLowerCase()));
  const inT = new Set(t.map(m => m.toLowerCase()));
  const inF = new Set(f.map(m => m.toLowerCase()));
  return {
    from: f,
    to: t,
    both: f.filter(m => inT.has(m.toLowerCase())).sort(),
    onlyInFrom: f.filter(m => !inT.has(m.toLowerCase())).sort(),
    onlyInTo: t.filter(m => !inF.has(m.toLowerCase())).sort(),
  };
}
