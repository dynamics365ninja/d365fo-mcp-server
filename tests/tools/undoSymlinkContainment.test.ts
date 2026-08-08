/**
 * undo_last_modification must resolve a target reached through a symlinked
 * package/model directory (audit 2.4 #20).
 *
 * `git rev-parse --show-toplevel` answers with the RESOLVED repository root, while
 * the tool is handed the path the agent used — which on this VM goes through a
 * junction (…/PackagesLocalDirectory/<Model> → a repo checkout). A purely lexical
 * path.relative() between the two climbs out of the repo ("..\\..\\…"), so undo
 * answered "Refusing operation outside repository root" for every file it was
 * supposed to be able to revert, and the repo-relative path it would have handed
 * git was one git has never heard of. The write path was given the
 * lexical-OR-realpath rule (utils/pathContainment.isUnder); undo was left behind.
 */

import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { isInsideRepo, toRepoRelative } from '../../src/tools/sdlc/undoLastModification';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'd365fo-undo-symlink-'));
const repoRoot = path.join(root, 'repo');
const objectDir = path.join(repoRoot, 'Contoso', 'Contoso', 'AxClass');
const objectFile = path.join(objectDir, 'ConDemoHelper.xml');

fs.mkdirSync(objectDir, { recursive: true });
fs.writeFileSync(objectFile, '<AxClass><Name>ConDemoHelper</Name></AxClass>');

const linkRoot = path.join(root, 'PackagesLocalDirectory');
let linked = true;
try {
  fs.symlinkSync(repoRoot, linkRoot, 'junction');
} catch {
  linked = false; // no symlink privilege on this host
}
const linkedFile = path.join(linkRoot, 'Contoso', 'Contoso', 'AxClass', 'ConDemoHelper.xml');

afterAll(() => {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* locked */ }
});

describe('undo containment through a symlinked package directory', () => {
  it.skipIf(!linked)('accepts a file reached through the symlink', () => {
    // The realpath'd root git reports vs. the as-given path the agent holds.
    expect(isInsideRepo(fs.realpathSync(repoRoot), linkedFile)).toBe(true);
  });

  it.skipIf(!linked)('derives the repo-relative path git can act on', () => {
    expect(toRepoRelative(fs.realpathSync(repoRoot), linkedFile))
      .toBe('Contoso/Contoso/AxClass/ConDemoHelper.xml');
  });

  it('still refuses a path outside the repository', () => {
    const outside = path.join(root, 'elsewhere', 'Other.xml');
    expect(isInsideRepo(fs.realpathSync(repoRoot), outside)).toBe(false);
  });

  it('still refuses a traversal that climbs out of the repository', () => {
    const traversal = path.join(repoRoot, '..', 'elsewhere', 'Other.xml');
    expect(isInsideRepo(fs.realpathSync(repoRoot), traversal)).toBe(false);
  });

  it('keeps the plain in-repo case on its lexical form', () => {
    expect(isInsideRepo(repoRoot, objectFile)).toBe(true);
    expect(toRepoRelative(repoRoot, objectFile)).toBe('Contoso/Contoso/AxClass/ConDemoHelper.xml');
  });
});
