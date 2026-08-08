/**
 * Absolute paths for file_path values read out of the symbol index.
 *
 * The index holds both shapes: most rows are absolute, but a measured 5,345 are
 * package-relative, left over from an extraction that ran with the packages
 * root as its cwd. Passing one of those to fs.readFile resolves it against the
 * CURRENT cwd — the user's home, for a server VS Code spawned — and produces an
 * ENOENT naming a path that could never exist. That is exactly how
 * object_patterns(action="validate") failed on a form that was right there:
 *
 *   C:\Users\<user>\ContosoCore\ContosoCore\AxForm\Foo.xml
 */

import { describe, it, expect } from 'vitest';
import { resolveIndexedFilePath } from '../../src/utils/packagesRoot.js';

const K = 'K:\\AosService\\PackagesLocalDirectory';
const C = 'C:\\AosService\\PackagesLocalDirectory';
const REL = 'ContosoCore/ContosoCore/AxForm/Foo.xml';

/** What a Windows root + relative path must produce, on any host. */
const joined = (root: string, rel: string) => `${root}\\${rel.replace(/\//g, '\\')}`;

describe('resolveIndexedFilePath', () => {
  it('leaves an absolute Windows path untouched, on any host', () => {
    // path.isAbsolute says a "K:\…" path is RELATIVE on POSIX, so this used to
    // join an already-absolute path onto a root and produce
    // /home/runner/…/K:\…\K:\…. CI runs Linux while every path handled here
    // comes from a Windows metadata store.
    const abs = `${K}\\M\\M\\AxForm\\Foo.xml`;
    expect(resolveIndexedFilePath(abs, { roots: [K], exists: () => true })).toBe(abs);
  });

  it('leaves a UNC path untouched', () => {
    const unc = '\\\\server\\share\\M\\AxForm\\Foo.xml';
    expect(resolveIndexedFilePath(unc, { roots: [K], exists: () => true })).toBe(unc);
  });

  it('resolves a package-relative path against the packages root, not the cwd', () => {
    const out = resolveIndexedFilePath(REL, { roots: [K], exists: () => true });
    expect(out).toBe(joined(K, REL));
    expect(out.toLowerCase()).not.toContain('users');
    expect(out.toLowerCase()).not.toContain('home');
  });

  it('picks the root the file actually exists under', () => {
    const wanted = joined(K, REL);
    const out = resolveIndexedFilePath(REL, { roots: [C, K], exists: p => p === wanted });
    expect(out).toBe(wanted);
  });

  it('names a recognisable path even when the file is under no root', () => {
    // Better a wrong-but-plausible packages path in the error than one under $HOME.
    const out = resolveIndexedFilePath(REL, { roots: [K], exists: () => false });
    expect(out).toBe(joined(K, REL));
  });

  it('does not double up separators when the root carries a trailing one', () => {
    const out = resolveIndexedFilePath(REL, { roots: [`${K}\\`], exists: () => true });
    expect(out).toBe(joined(K, REL));
  });

  it('falls back to the default root when nothing was detected', () => {
    const out = resolveIndexedFilePath(REL, { roots: [], exists: () => false });
    expect(out.toLowerCase()).toContain('packageslocaldirectory');
  });

  it('passes an empty path through rather than inventing one', () => {
    expect(resolveIndexedFilePath('', { roots: [K], exists: () => true })).toBe('');
  });
});
