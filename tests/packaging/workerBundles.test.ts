/**
 * Every worker a bundled script can reach must be bundled beside it.
 *
 * `d365fo-mcp index` on an npm install runs dist/scripts/build-database.js —
 * an esbuild bundle that inlines src/metadata/symbolIndex.ts. Inside that
 * bundle `new URL('./someWorker.js', import.meta.url)` resolves against
 * dist/scripts/, not dist/metadata/ where tsc emitted the worker, so a worker
 * that is not listed as its own esbuild entry point fails at runtime with
 *
 *   [SymbolIndex] idx_symbols_file_path worker error:
 *     Error: Cannot find module ...\dist\scripts\buildIndexWorker.js
 *
 * and only on a big enough database, only on an npm install, and only as a
 * logged best-effort failure — the index is silently never built. That is
 * about as invisible as a packaging bug gets, hence this gate.
 *
 * Reads the sources rather than dist/, so it decides something on a fresh
 * clone with nothing built.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it, expect } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const METADATA_DIR = path.join(REPO_ROOT, 'src', 'metadata');

/** Worker entry points referenced as `new URL('./x.js', import.meta.url)`. */
function referencedWorkers(): string[] {
  const found = new Set<string>();
  for (const file of fs.readdirSync(METADATA_DIR).filter(f => f.endsWith('.ts'))) {
    const src = fs.readFileSync(path.join(METADATA_DIR, file), 'utf8');
    for (const m of src.matchAll(/new URL\(\s*'\.\/([A-Za-z0-9_]+)\.js'\s*,\s*import\.meta\.url\s*\)/g)) {
      found.add(m[1]);
    }
  }
  return [...found].sort();
}

const buildScripts = (
  JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  }
).scripts['build:scripts'];

describe('worker bundling', () => {
  it('finds the worker references it is meant to guard', () => {
    // A regex that silently stops matching would turn every assertion below
    // into a vacuous pass.
    expect(referencedWorkers()).toContain('buildIndexWorker');
  });

  it('bundles every src/metadata worker into dist/scripts', () => {
    const missing = referencedWorkers().filter(
      w => !buildScripts.includes(`src/metadata/${w}.ts`),
    );
    expect(
      missing,
      'these workers are loaded relative to a bundle in dist/scripts but are only ' +
      'emitted to dist/metadata — add them as esbuild entry points in build:scripts',
    ).toEqual([]);
  });

  it('bundles them with dist/scripts as the output directory', () => {
    // build:scripts is a chain of esbuild invocations; the entry point is only
    // in the right place if the invocation carrying it also targets dist/scripts.
    for (const worker of referencedWorkers()) {
      const carrying = buildScripts
        .split('&&')
        .filter(cmd => cmd.includes(`src/metadata/${worker}.ts`));
      expect(carrying.length, `${worker} is not an esbuild entry point`).toBeGreaterThan(0);
      for (const cmd of carrying) {
        expect(cmd, `${worker} is bundled somewhere other than dist/scripts`)
          .toContain('--outdir=dist/scripts');
      }
    }
  });
});
