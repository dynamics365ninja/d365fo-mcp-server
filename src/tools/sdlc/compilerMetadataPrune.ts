import path from 'path';
import { readdir, rmdir, stat, unlink, utimes } from 'fs/promises';

/**
 * Remove the compiler-metadata copy of ONE element whose source was just deleted.
 *
 * The source is `<root>\<Package>\<Model>\<AxType>\<Name>.xml`; its copy is
 * `<root>\<Package>\XppMetadata\<Model>\<AxType>\<Name>.xml` — the layout
 * pruneStaleCompilerMetadata pairs. That prune removes such a phantom, but only during
 * an incremental build of this server. An `undo` or `delete` followed by a Visual
 * Studio build or a packaging step kept the deleted element in the metadata and so in
 * the `.md` manifests. This applies the prune's own rule ("source gone → delete the
 * file") at the moment the source goes, then removes the copy's type folder if that
 * left it empty (non-recursive: a folder with anything else in it stays).
 *
 * Does nothing while the source still exists. Never throws — the delete it follows
 * has already succeeded. Returns the removed path, or null.
 */
export async function removeCompilerMetadataFor(sourceFile: string): Promise<string | null> {
  try {
    await stat(sourceFile);
    return null; // source still there: the copy is not a phantom
  } catch (err: any) {
    if (err?.code !== 'ENOENT') return null;
  }
  const typeDir = path.dirname(sourceFile);
  const modelDir = path.dirname(typeDir);
  const packageDir = path.dirname(modelDir);
  const metaTypeDir = path.join(packageDir, 'XppMetadata', path.basename(modelDir), path.basename(typeDir));
  const metaFile = path.join(metaTypeDir, path.basename(sourceFile));
  try {
    await unlink(metaFile);
  } catch {
    return null;
  }
  try {
    await rmdir(metaTypeDir);
  } catch {
    // Not empty, or already gone — either way nothing more to do.
  }
  return metaFile;
}

/**
 * What {@link pruneStaleCompilerMetadata} did to one package's XppMetadata tree.
 * Paths are the XppMetadata files removed, so the build log can name them.
 */
export interface CompilerMetadataPruneResult {
  /** Files whose source changed after they were written; the source was touched so xppc recompiles it. */
  stale: string[];
  /** Files whose source no longer exists — nothing would ever rewrite or remove them. */
  phantoms: string[];
  /** Model folders left alone because the package has no source for them (a binary-only deployment). */
  skippedModels: string[];
  /** Non-fatal per-file problems; the file is left as it was. */
  errors: string[];
  /** Metadata files examined. */
  scanned: number;
}

/**
 * Remove the compiler-metadata files an incremental build would otherwise leave stale.
 *
 * xppc's "Metadata Write-Back" rewrites `<compilermetadata>\<Package>\XppMetadata\<Model>\<AxType>\<Name>.xml`
 * when an element GAINS something, but not when it loses something. Measured on 7.0.7996.33, with
 * `-incremental`: a field removed from a class stays declared in its XppMetadata file, while a field
 * renamed is written back correctly; a deleted class keeps its file forever. `RuntimeMetadataWriter`
 * serializes that tree into the `.md` manifests (see generateMetadata.ts), so the deployed package
 * declares members its IL no longer has — under a green build. A full build clears the whole tree
 * first (removeModelCompilerMetadata); an incremental build cannot, because xppc then writes back
 * only the elements it recompiles and every unchanged element would vanish from the metadata.
 *
 * So this works per file, on the one signal that is sound: a stale file is never rewritten, so its
 * mtime is older than its source's.
 *
 *  - Source newer than the metadata file → delete the file AND touch the source. The touch is not
 *    optional. xppc decides what to recompile from the source mtime against its own baseline (an
 *    edit with the mtime pinned back is not compiled at all), so a change that an earlier build
 *    already compiled — a Visual Studio build, or one from before this fix — is no longer "changed"
 *    to xppc. Deleting its metadata without the touch makes the element disappear from the
 *    metadata instead of refreshing it. With the touch it is recompiled and written back, and that
 *    holds even when it fails to compile (the write-back still runs, and the element stays
 *    "changed" for the next build). If the touch fails, the file is kept — stale beats missing.
 *  - Source gone → delete the file. Nothing else will.
 *  - Model folder with no source at all → leave the whole model alone; that is a package deployed
 *    without source, and its metadata is the only copy.
 *
 * A census of all 109,672 XppMetadata files on a UDE box found no element whose metadata path
 * differed from its source path; the only files without a source (58) were genuinely deleted
 * elements. A false "newer" (a git checkout that rewrote an unchanged file) costs one recompile of
 * that element and nothing else: after the build the metadata is newer again.
 */
export async function pruneStaleCompilerMetadata(
  compilerMetadataRoot: string,
  sourceRoot: string,
  packageName: string,
): Promise<CompilerMetadataPruneResult> {
  const result: CompilerMetadataPruneResult = { stale: [], phantoms: [], skippedModels: [], errors: [], scanned: 0 };
  const xppMetadataDir = path.join(compilerMetadataRoot, packageName, 'XppMetadata');

  let models;
  try {
    models = await readdir(xppMetadataDir, { withFileTypes: true });
  } catch {
    // No tree yet (the model was never built), or unreadable — nothing to prune either way.
    return result;
  }

  const pairs: { metaFile: string; sourceFile: string }[] = [];
  for (const model of models) {
    if (!model.isDirectory()) continue;
    const sourceModelDir = path.join(sourceRoot, packageName, model.name);
    try {
      if (!(await stat(sourceModelDir)).isDirectory()) throw new Error('not a directory');
    } catch {
      result.skippedModels.push(model.name);
      continue;
    }

    const metaModelDir = path.join(xppMetadataDir, model.name);
    let types;
    try {
      types = await readdir(metaModelDir, { withFileTypes: true });
    } catch (err: any) {
      result.errors.push(`${metaModelDir}: ${err?.message ?? err}`);
      continue;
    }

    for (const type of types) {
      if (!type.isDirectory()) continue;
      const metaTypeDir = path.join(metaModelDir, type.name);
      let files;
      try {
        files = await readdir(metaTypeDir, { withFileTypes: true });
      } catch (err: any) {
        result.errors.push(`${metaTypeDir}: ${err?.message ?? err}`);
        continue;
      }

      for (const file of files) {
        if (!file.isFile() || !file.name.toLowerCase().endsWith('.xml')) continue;
        pairs.push({
          metaFile: path.join(metaTypeDir, file.name),
          sourceFile: path.join(sourceModelDir, type.name, file.name),
        });
      }
    }
  }

  result.scanned = pairs.length;
  // Two stats per element, every incremental build. Sequential that was 2.2 s for a
  // 4,426-element package on a UDE box; 16 at a time, 0.29 s (32 and 64 were no faster).
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(STAT_CONCURRENCY, pairs.length) }, async () => {
    while (next < pairs.length) {
      const pair = pairs[next++];
      await pruneOne(pair.metaFile, pair.sourceFile, result);
    }
  }));

  return result;
}

const STAT_CONCURRENCY = 16;

async function pruneOne(metaFile: string, sourceFile: string, result: CompilerMetadataPruneResult): Promise<void> {
  try {
    let sourceMtime: number;
    try {
      sourceMtime = (await stat(sourceFile)).mtimeMs;
    } catch (err: any) {
      if (err?.code !== 'ENOENT') throw err;
      await unlink(metaFile);
      result.phantoms.push(metaFile);
      return;
    }

    if (sourceMtime <= (await stat(metaFile)).mtimeMs) return;

    // Touch first: without it xppc may not recompile the element, and deleting the
    // metadata would then drop the element instead of refreshing it.
    const now = new Date();
    await utimes(sourceFile, now, now);
    await unlink(metaFile);
    result.stale.push(metaFile);
  } catch (err: any) {
    result.errors.push(`${metaFile}: ${err?.message ?? err}`);
  }
}
