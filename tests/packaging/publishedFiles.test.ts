/**
 * What the published tarball must and must not contain.
 *
 * `npm i -g d365fo-mcp` is a full installation: the CLI runs the setup wizard,
 * builds the C# bridge and rebuilds the metadata index from the package
 * directory, with no checkout and no devDependencies to fall back on. Every
 * file those steps need therefore has to survive `npm pack` — and `files`
 * entries override .gitignore, so it is just as easy to publish something that
 * should never leave the machine.
 *
 * The list is computed with `npm pack --dry-run`, which is the same code path
 * `npm publish` uses, rather than by re-implementing npm's include rules here.
 */
import { execSync } from 'node:child_process';
import * as path from 'node:path';
import { describe, it, expect, beforeAll } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '..', '..');

let packed: string[];

beforeAll(() => {
  // --ignore-scripts: prepublishOnly would otherwise run a full build here.
  // npm is a .cmd shim on Windows, which cannot be spawned without a shell
  // (EINVAL since the Node 18 hardening) — hence execSync over a constant
  // command line rather than execFileSync with an args array.
  const out = execSync('npm pack --dry-run --json --ignore-scripts', {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const report = JSON.parse(out) as [{ files: { path: string }[] }];
  packed = report[0].files.map(f => f.path.replace(/\\/g, '/'));
}, 120_000);

describe('published package contents', () => {
  it('ships the CLI entry point the bin field names', () => {
    expect(packed).toContain('dist/cli/index.js');
    expect(packed).toContain('dist/index.js');
  });

  it('ships the bundled index scripts, so an npm install can build an index', () => {
    // These are what src/cli/context.ts calls extractScriptDist/buildDbScriptDist;
    // without them `d365fo-mcp index` has nothing to run outside a checkout.
    expect(packed).toContain('dist/scripts/extract-metadata.js');
    expect(packed).toContain('dist/scripts/build-database.js');
    // Loaded by `new Worker(new URL('./symbolCountsWorker.js', import.meta.url))`
    // from inside the build-database bundle, so it must sit beside it.
    expect(packed).toContain('dist/scripts/symbolCountsWorker.js');
  });

  it('ships the C# bridge sources, so the wizard can build the write path', () => {
    expect(packed).toContain('bridge/D365MetadataBridge/D365MetadataBridge.csproj');
    expect(packed).toContain('bridge/D365MetadataBridge/Program.cs');
  });

  it('leaves build output of the bridge behind', () => {
    const artefacts = packed.filter(p => /^bridge\/.*\/(bin|obj)\//.test(p));
    expect(artefacts, 'bridge build output must not be published').toEqual([]);
  });

  it('never publishes local configuration', () => {
    // config/d365fo-mcp.json and config/secrets.json are this machine's
    // settings — git-ignored, and a `files` entry naming config/ would
    // republish them to every user and overwrite theirs on install.
    const local = packed.filter(p => p.startsWith('config/'));
    expect(local, 'local configuration must not be published').toEqual([]);
  });

  it('leaves developer-only weight out', () => {
    expect(packed.filter(p => p.endsWith('.map'))).toEqual([]);
    expect(packed.filter(p => p.startsWith('dist/eval/'))).toEqual([]);
    expect(packed.filter(p => p.startsWith('data/'))).toEqual([]);
  });
});
