/**
 * WorkspaceScanner containment: a link inside the workspace that resolves outside
 * the workspace root must not surface as a workspace file, while links that stay
 * inside the root and a workspace root that is itself a link keep working.
 *
 * Uses real temp directories. Where the OS refuses to create a link (no privilege)
 * the affected assertions are skipped, the way pathContainmentSymlink.test.ts does.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { WorkspaceScanner } from '../../src/workspace/workspaceScanner.js';

let base: string;
let root: string;
let outside: string;

const CLASS_XML = '<AxClass><Name>X</Name></AxClass>';

/** Create a link; false when the OS refuses (e.g. no symlink privilege on Windows). */
function tryLink(target: string, linkPath: string, kind: 'file' | 'dir'): boolean {
  try {
    const type = kind === 'file' ? 'file' : process.platform === 'win32' ? 'junction' : 'dir';
    fs.symlinkSync(target, linkPath, type);
    return true;
  } catch {
    return false;
  }
}

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-link-'));
  root = path.join(base, 'workspace');
  outside = path.join(base, 'outside');
  fs.mkdirSync(path.join(root, 'AxClass'), { recursive: true });
  fs.mkdirSync(path.join(outside, 'AxClass'), { recursive: true });
  fs.writeFileSync(path.join(root, 'AxClass', 'ContosoInside.xml'), CLASS_XML);
  fs.writeFileSync(path.join(outside, 'AxClass', 'ContosoOutside.xml'), CLASS_XML);
});

afterEach(() => {
  vi.restoreAllMocks();
  try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* best-effort */ }
});

describe('WorkspaceScanner — links that resolve outside the workspace root', () => {
  it('skips a file link pointing outside the root and keeps the plain file', async () => {
    const linked = tryLink(
      path.join(outside, 'AxClass', 'ContosoOutside.xml'),
      path.join(root, 'AxClass', 'ContosoEscapeLink.xml'),
      'file',
    );
    if (!linked) return; // environment can't create file links — skip
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const files = await new WorkspaceScanner().scanWorkspace(root);

    expect(files.map(f => f.name)).toEqual(['ContosoInside']);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('ContosoEscapeLink.xml'));
  });

  it('skips files below a directory link (junction) pointing outside the root', async () => {
    if (!tryLink(outside, path.join(root, 'LinkedOut'), 'dir')) return;
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const files = await new WorkspaceScanner().scanWorkspace(root);

    // Whether or not the platform's glob walks into the link, nothing reached
    // through it may be reported.
    expect(files.map(f => f.name)).toEqual(['ContosoInside']);
    expect(files.some(f => f.path.includes('LinkedOut'))).toBe(false);
  });

  it('keeps a file link whose target is inside the root', async () => {
    const linked = tryLink(
      path.join(root, 'AxClass', 'ContosoInside.xml'),
      path.join(root, 'AxClass', 'ContosoInsideLink.xml'),
      'file',
    );
    if (!linked) return;

    const files = await new WorkspaceScanner().scanWorkspace(root);

    expect(files.map(f => f.name).sort()).toEqual(['ContosoInside', 'ContosoInsideLink']);
  });

  it('scans a workspace whose root is itself a directory link', async () => {
    const viaLink = path.join(base, 'workspace-link');
    if (!tryLink(root, viaLink, 'dir')) return;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const files = await new WorkspaceScanner().scanWorkspace(viaLink);

    expect(files.map(f => f.name)).toEqual(['ContosoInside']);
    expect(files[0].path.startsWith(viaLink)).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });
});
