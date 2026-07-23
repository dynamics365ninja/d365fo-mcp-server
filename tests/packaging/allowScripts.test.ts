/**
 * Install-script gates.
 *
 * npm 12 blocks package lifecycle scripts (preinstall/install/postinstall)
 * unless the root package.json pre-approves them by exact `name@version`. A
 * blocked script still exits 0 with a warning, so the breakage is silent and
 * surfaces far from its cause.
 *
 * That has two separate consequences, and one test each:
 *
 *  1. Runtime dependencies. Users installing with `npm install -g d365fo-mcp`
 *     have no root package.json of ours to approve anything, so an install
 *     script in the runtime closure means a warning they must act on — and,
 *     for a native module, a package that fails on first use. This is why the
 *     symbol index runs on core node:sqlite instead of better-sqlite3; the
 *     closure has to stay script-free for that to keep paying off.
 *
 *  2. Dev dependencies. Ours (esbuild) are approved in `allowScripts`, and the
 *     pins have to track the lockfile — a bump that does not update them in the
 *     same commit would silently stop running the script for contributors.
 *
 * Optional packages are exempt: fsevents is macOS-only and degrades to polling.
 */

import * as fs from 'fs';
import * as path from 'path';
import { describe, it, expect } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '..', '..');

interface LockEntry {
  version?: string;
  hasInstallScript?: boolean;
  optional?: boolean;
  dev?: boolean;
}

const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as {
  allowScripts?: Record<string, boolean>;
};
const lock = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package-lock.json'), 'utf8')) as {
  packages: Record<string, LockEntry>;
};

const allowScripts = pkg.allowScripts ?? {};

/** `node_modules/foo` and `node_modules/a/node_modules/b` → `foo` / `b`. */
function packageName(lockPath: string): string {
  return lockPath.split('node_modules/').pop()!;
}

/** Every non-optional locked package whose install would run a script. */
const scriptPackages = Object.entries(lock.packages)
  .filter(([lockPath, entry]) => lockPath !== '' && entry.hasInstallScript && !entry.optional)
  .map(([lockPath, entry]) => ({
    id: `${packageName(lockPath)}@${entry.version}`,
    lockPath,
    dev: entry.dev === true,
  }));

describe('install scripts', () => {
  // Guards the extraction itself: esbuild always qualifies, so an empty list
  // would mean the lockfile shape changed and these gates went vacuous rather
  // than green.
  it('finds the install-script packages in the lockfile at all', () => {
    expect(scriptPackages.map(p => p.id)).toContain('esbuild@0.28.1');
  });

  it('keeps the published runtime closure free of install scripts', () => {
    const runtime = scriptPackages.filter(p => !p.dev);
    expect(
      runtime.map(p => p.id),
      '\nThese ship to users, and `npm install -g d365fo-mcp` cannot approve ' +
        'their install scripts — it warns and skips them. Replace the dependency ' +
        'or move it to devDependencies:\n' +
        runtime.map(p => `  ${p.id} (${p.lockPath})`).join('\n'),
    ).toEqual([]);
  });

  it('pins every dev package that runs an install script', () => {
    const uncovered = scriptPackages.filter(p => allowScripts[p.id] !== true);
    expect(
      uncovered.map(p => p.id),
      '\nInstall scripts blocked under npm 12 — add each to "allowScripts" in package.json:\n' +
        uncovered.map(p => `  "${p.id}": true`).join('\n'),
    ).toEqual([]);
  });

  it('has no stale pin left behind by a dependency bump', () => {
    const locked = new Set(scriptPackages.map(p => p.id));
    const stale = Object.keys(allowScripts).filter(id => !locked.has(id));
    expect(
      stale,
      '\nThese "allowScripts" pins match nothing in package-lock.json — the ' +
        'dependency moved and the approval no longer applies:\n' +
        stale.map(id => `  ${id}`).join('\n'),
    ).toEqual([]);
  });
});
