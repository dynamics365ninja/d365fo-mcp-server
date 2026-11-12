import path from 'path';
import { readdir, stat } from 'fs/promises';
import { willRecompile } from './odataActionGuard.js';

/**
 * Guards a model's type shapes against xppc's incremental mode.
 *
 * With `-incremental`, xppc recompiles the elements whose own source changed. Code that only USES
 * a changed table, EDT or enum is not among them, so a change that breaks it — a field moved to an
 * EDT of another base type, a removed enum value — is reported as 0 errors, and the next full
 * build fails. A changed type shape therefore makes the build a full one, as the OData guard does
 * for entities with actions (odataActionGuard.ts).
 */

/** Element types that define the shape other code compiles against, in the order they are reported. */
const SCHEMA_SOURCE_TYPES = ['AxTable', 'AxTableExtension', 'AxEdt', 'AxEdtExtension', 'AxEnum', 'AxEnumExtension'];

/**
 * The types xppc writes a compiler-metadata copy for. Of the six, only tables: the XppMetadata
 * tree of a package holds AxClass, AxTable, AxForm, AxView, AxMap, AxQuery and the entity types,
 * one file per source file, and no folder at all for table extensions, EDTs or enums.
 */
const TYPES_WITH_OWN_COPY = new Set(['AxTable']);

const NOUNS: Record<string, [string, string]> = {
  AxTable: ['table', 'tables'],
  AxTableExtension: ['table extension', 'table extensions'],
  AxEdt: ['EDT', 'EDTs'],
  AxEdtExtension: ['EDT extension', 'EDT extensions'],
  AxEnum: ['enum', 'enums'],
  AxEnumExtension: ['enum extension', 'enum extensions'],
};

/** What {@link scanSchemaChanges} found in one package. */
export interface SchemaChangeScanResult {
  /** `<AxType>/<Name>` of each table, EDT, enum or extension of one changed since the last build. */
  changed: string[];
  /** Non-fatal per-file problems; the file is treated as unchanged. */
  errors: string[];
}

/**
 * The tables, EDTs, enums and their extensions of this package that changed since its last build.
 *
 * A table uses the signal the OData guard and pruneStaleCompilerMetadata use: its source is newer
 * than its own `XppMetadata` file, or has none. The other five types have no such file, so they
 * are compared with the newest file anywhere in the package's XppMetadata tree, which is the last
 * time a build wrote compiler metadata back. A full build clears and rewrites that whole tree, so
 * the full build this scan asks for moves the baseline past every source and the next build is
 * incremental again. A false "newer" (a git checkout that rewrote unchanged files) costs one full
 * build. Run it BEFORE the prune, which deletes stale metadata files and touches their sources.
 *
 * A package without an XppMetadata tree was never built: nothing is reported, the build runs as
 * asked. With a tree that holds no file there is no baseline for the five types and only tables
 * are checked.
 */
export async function scanSchemaChanges(
  compilerMetadataRoot: string,
  sourceRoot: string,
  packageName: string,
): Promise<SchemaChangeScanResult> {
  const result: SchemaChangeScanResult = { changed: [], errors: [] };
  const packageDir = path.join(sourceRoot, packageName);
  const xppMetadataDir = path.join(compilerMetadataRoot, packageName, 'XppMetadata');

  let metaModels;
  try {
    metaModels = await readdir(xppMetadataDir, { withFileTypes: true });
  } catch {
    // No tree yet (the model was never built), or unreadable — no baseline either way.
    return result;
  }

  let models;
  try {
    models = await readdir(packageDir, { withFileTypes: true });
  } catch (err: any) {
    result.errors.push(`${packageDir}: ${err?.message ?? err}`);
    return result;
  }

  const candidates: { sourceFile: string; metaFile: string; type: string; name: string }[] = [];
  for (const model of models) {
    if (!model.isDirectory() || model.name.toLowerCase() === 'xppmetadata') continue;
    for (const type of SCHEMA_SOURCE_TYPES) {
      const sourceTypeDir = path.join(packageDir, model.name, type);
      let files;
      try {
        files = await readdir(sourceTypeDir, { withFileTypes: true });
      } catch (err: any) {
        // Most models have no folder for most of these types.
        if (err?.code !== 'ENOENT' && err?.code !== 'ENOTDIR')
          result.errors.push(`${sourceTypeDir}: ${err?.message ?? err}`);
        continue;
      }
      for (const file of files) {
        if (!file.isFile() || !file.name.toLowerCase().endsWith('.xml')) continue;
        candidates.push({
          sourceFile: path.join(sourceTypeDir, file.name),
          metaFile: path.join(xppMetadataDir, model.name, type, file.name),
          type,
          name: path.basename(file.name, '.xml'),
        });
      }
    }
  }
  if (candidates.length === 0) return result;

  const lastWriteBack = candidates.some(c => !TYPES_WITH_OWN_COPY.has(c.type))
    ? await newestCompilerMetadata(xppMetadataDir, metaModels.filter(m => m.isDirectory()).map(m => m.name), result.errors)
    : null;

  const changed: { type: string; name: string }[] = [];
  await pooled(candidates, async c => {
    try {
      const isChanged = TYPES_WITH_OWN_COPY.has(c.type)
        ? await willRecompile(c.sourceFile, c.metaFile)
        : lastWriteBack !== null && (await stat(c.sourceFile)).mtimeMs > lastWriteBack;
      if (isChanged) changed.push({ type: c.type, name: c.name });
    } catch (err: any) {
      result.errors.push(`${c.sourceFile}: ${err?.message ?? err}`);
    }
  });
  result.changed = changed
    .sort((a, b) =>
      SCHEMA_SOURCE_TYPES.indexOf(a.type) - SCHEMA_SOURCE_TYPES.indexOf(b.type) || a.name.localeCompare(b.name))
    .map(c => `${c.type}/${c.name}`);
  return result;
}

/** `2 tables, 1 EDT changed since the last build: A, B, C`, for logs and results. */
export function describeSchemaChanges(changed: string[], max = 5): string {
  const counts = new Map<string, number>();
  for (const c of changed) {
    const type = c.slice(0, c.indexOf('/'));
    counts.set(type, (counts.get(type) ?? 0) + 1);
  }
  const summary = SCHEMA_SOURCE_TYPES
    .filter(type => counts.has(type))
    .map(type => `${counts.get(type)} ${NOUNS[type][counts.get(type) === 1 ? 0 : 1]}`)
    .join(', ');
  const names = changed.slice(0, max).map(c => c.slice(c.indexOf('/') + 1)).join(', ');
  return `${summary} changed since the last build: ${names}${changed.length > max ? `, … (+${changed.length - max})` : ''}`;
}

const SCAN_CONCURRENCY = 16;

async function pooled<T>(items: T[], work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(SCAN_CONCURRENCY, items.length) }, async () => {
      while (next < items.length) await work(items[next++]);
    }),
  );
}

/** The newest mtime of any `<Model>\<AxType>\<Name>.xml` in the tree, or null when it holds none. */
async function newestCompilerMetadata(xppMetadataDir: string, modelNames: string[], errors: string[]): Promise<number | null> {
  const files: string[] = [];
  for (const model of modelNames) {
    const modelDir = path.join(xppMetadataDir, model);
    try {
      for (const type of await readdir(modelDir, { withFileTypes: true })) {
        if (!type.isDirectory()) continue;
        const typeDir = path.join(modelDir, type.name);
        for (const file of await readdir(typeDir, { withFileTypes: true })) {
          if (file.isFile() && file.name.toLowerCase().endsWith('.xml')) files.push(path.join(typeDir, file.name));
        }
      }
    } catch (err: any) {
      errors.push(`${modelDir}: ${err?.message ?? err}`);
    }
  }
  let newest: number | null = null;
  await pooled(files, async file => {
    try {
      const mtime = (await stat(file)).mtimeMs;
      if (newest === null || mtime > newest) newest = mtime;
    } catch {
      // Removed while scanning: it is not the newest file any more.
    }
  });
  return newest;
}
