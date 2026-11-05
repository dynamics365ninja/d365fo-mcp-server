/**
 * The part of a Microsoft PackagesLocalDirectory that our models actually refer to.
 *
 * Comparing two platform builds against ISV and customer models does not need all ~580,000 symbols of
 * the application: it needs the classes, tables, EDTs and enums our code names, and what those inherit
 * from or are typed with. `slicePld` finds them by name (readdir only), follows the references between
 * them (`extends`, `implements`, EDT and enum types of fields) and copies just those object files into a
 * small packages tree, which the stock `extract-metadata` then reads like any other.
 *
 * What it does NOT follow: calls inside method bodies of the copied objects (they are not needed to
 * compare signatures), and table extensions (an extension adds members, it does not move the base).
 */

import * as fs from 'fs';
import * as path from 'path';

/** AOT folders a slice keeps; the version scripts compare these four kinds. */
export const SLICE_FOLDERS = ['AxClass', 'AxTable', 'AxEdt', 'AxEnum'] as const;

export interface PldObject {
  packageDir: string;
  model: string;
  folder: (typeof SLICE_FOLDERS)[number];
  file: string;
}

const isDir = (p: string): boolean => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/** Name (lower case, no extension) -> where the object lives, over every `<Package>/<Model>/Ax*` of the PLD. */
export function indexPld(pld: string, skipModels: Set<string> = new Set()): Map<string, PldObject> {
  const index = new Map<string, PldObject>();
  for (const pkg of fs.readdirSync(pld)) {
    const packageDir = path.join(pld, pkg);
    if (!isDir(packageDir)) continue;
    for (const model of fs.readdirSync(packageDir)) {
      if (skipModels.has(model.toLowerCase()) || !isDir(path.join(packageDir, model))) continue;
      for (const folder of SLICE_FOLDERS) {
        const dir = path.join(packageDir, model, folder);
        if (!isDir(dir)) continue;
        for (const file of fs.readdirSync(dir)) {
          if (!file.endsWith('.xml')) continue;
          const key = file.slice(0, -4).toLowerCase();
          // The first definition wins; a name defined twice across models is a platform bug, not ours to resolve.
          if (!index.has(key)) index.set(key, { packageDir, model, folder, file });
        }
      }
    }
  }
  return index;
}

/** Every identifier-like token in the extracted JSON of our models: what our code and signatures name. */
export function collectTokens(oursDir: string, models: string[]): Set<string> {
  const tokens = new Set<string>();
  for (const model of models) {
    for (const sub of ['classes', 'tables', 'edts', 'enums', 'class-extensions']) {
      const dir = path.join(oursDir, model, sub);
      if (!fs.existsSync(dir)) continue;
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.json')) continue;
        for (const t of fs.readFileSync(path.join(dir, f), 'utf-8').match(/[A-Za-z_]\w*/g) ?? [])
          tokens.add(t.toLowerCase());
      }
    }
  }
  return tokens;
}

const REFERENCES = [
  /<Extends>\s*([A-Za-z_]\w*)\s*<\/Extends>/g,
  /\bextends\s+([A-Za-z_]\w*)/gi,
  /\bimplements\s+([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*)/gi,
  /<ExtendedDataType>\s*([A-Za-z_]\w*)\s*<\/ExtendedDataType>/g,
  /<EnumType>\s*([A-Za-z_]\w*)\s*<\/EnumType>/g,
  /<RelatedTable>\s*([A-Za-z_]\w*)\s*<\/RelatedTable>/g,
];

function referencedNames(xml: string): string[] {
  const out: string[] = [];
  for (const re of REFERENCES) {
    re.lastIndex = 0;
    for (let m = re.exec(xml); m; m = re.exec(xml)) out.push(...m[1].split(',').map(x => x.trim().toLowerCase()));
  }
  return out;
}

export interface SliceResult {
  models: string[];
  files: number;
  /** Objects the tokens matched directly, before following references. */
  matched: number;
}

/** Copies the objects named by `tokens`, and what they refer to, into `outRoot/<Package>/<Model>/<Ax*>/`. */
export function slicePld(
  pld: string,
  tokens: Set<string>,
  outRoot: string,
  skipModels: Set<string> = new Set(),
): SliceResult {
  const index = indexPld(pld, skipModels);
  const wanted = new Map<string, PldObject>();
  const queue: string[] = [];
  for (const t of tokens) {
    const o = index.get(t);
    if (o && !wanted.has(t)) {
      wanted.set(t, o);
      queue.push(t);
    }
  }
  const matched = wanted.size;
  while (queue.length) {
    const o = wanted.get(queue.pop() as string) as PldObject;
    const xml = fs.readFileSync(path.join(o.packageDir, o.model, o.folder, o.file), 'utf-8');
    for (const name of referencedNames(xml)) {
      const next = index.get(name);
      if (next && !wanted.has(name)) {
        wanted.set(name, next);
        queue.push(name);
      }
    }
  }
  const models = new Set<string>();
  for (const o of wanted.values()) {
    const dest = path.join(outRoot, path.basename(o.packageDir), o.model, o.folder);
    fs.mkdirSync(dest, { recursive: true });
    fs.copyFileSync(path.join(o.packageDir, o.model, o.folder, o.file), path.join(dest, o.file));
    models.add(o.model);
  }
  // A model needs one of the marker folders to be walked at all.
  for (const o of wanted.values())
    fs.mkdirSync(path.join(outRoot, path.basename(o.packageDir), o.model, 'AxClass'), { recursive: true });
  return { models: [...models].sort(), files: wanted.size, matched };
}
