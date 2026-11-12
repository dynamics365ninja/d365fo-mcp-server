/**
 * WorkspaceScanner resolves the workspace root once per scan, and a plain file
 * (no link on the way to it) costs no realpath at all.
 *
 * Before this the containment check ran for every glob result and resolved both
 * the file and the root each time, synchronously.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const spy = vi.hoisted(() => ({ realpathCalls: [] as string[] }));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  const realpathSync = Object.assign(
    (p: any, ...rest: any[]) => {
      spy.realpathCalls.push(String(p));
      return (actual.realpathSync as any)(p, ...rest);
    },
    { native: actual.realpathSync.native },
  );
  return { ...actual, realpathSync, default: { ...actual, realpathSync } };
});

import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { WorkspaceScanner } from '../../src/workspace/workspaceScanner.js';

let base: string;
let root: string;
let outside: string;

const NAMES = ['ContosoA', 'ContosoB', 'ContosoC', 'ContosoD', 'ContosoE'];

beforeEach(async () => {
  base = await fsp.mkdtemp(path.join(os.tmpdir(), 'ws-once-'));
  root = path.join(base, 'workspace');
  outside = path.join(base, 'outside');
  await fsp.mkdir(path.join(root, 'ContosoExt', 'AxClass'), { recursive: true });
  await fsp.mkdir(path.join(root, 'ContosoExt', 'AxTable'), { recursive: true });
  await fsp.mkdir(outside, { recursive: true });
  for (const n of NAMES) {
    await fsp.writeFile(path.join(root, 'ContosoExt', 'AxClass', `${n}.xml`), '<AxClass />');
    await fsp.writeFile(path.join(root, 'ContosoExt', 'AxTable', `${n}Table.xml`), '<AxTable />');
  }
  spy.realpathCalls.length = 0;
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fsp.rm(base, { recursive: true, force: true });
});

const norm = (p: string) => p.replace(/\\/g, '/').toLowerCase();

describe('WorkspaceScanner — realpath cost of a scan', () => {
  it('resolves the root once and never resolves a plain file', async () => {
    const files = await new WorkspaceScanner().scanWorkspace(root);

    expect(files).toHaveLength(NAMES.length * 2);
    const rootCalls = spy.realpathCalls.filter(p => norm(p) === norm(root));
    const fileCalls = spy.realpathCalls.filter(p => norm(p).endsWith('.xml'));
    expect(rootCalls).toHaveLength(1);
    expect(fileCalls).toEqual([]);
    expect(spy.realpathCalls).toHaveLength(1);
  });

  it('does not resolve anything on a cached scan, and resolves the root again after invalidate()', async () => {
    const scanner = new WorkspaceScanner();
    await scanner.scanWorkspace(root);
    await scanner.scanWorkspace(root);
    expect(spy.realpathCalls).toHaveLength(1);

    scanner.invalidate();
    await scanner.scanWorkspace(root);
    expect(spy.realpathCalls).toHaveLength(2);
  });

  it('resolves only the link when one entry is a link, and still rejects an escape', async () => {
    const target = path.join(outside, 'ContosoEscape.xml');
    await fsp.writeFile(target, '<AxClass />');
    try {
      await fsp.symlink(target, path.join(root, 'ContosoExt', 'AxClass', 'ContosoEscapeLink.xml'), 'file');
    } catch {
      return; // environment can't create file links — skip
    }
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const files = await new WorkspaceScanner().scanWorkspace(root);

    expect(files.map(f => f.name)).not.toContain('ContosoEscapeLink');
    expect(files).toHaveLength(NAMES.length * 2);
    const fileCalls = spy.realpathCalls.filter(p => norm(p).endsWith('.xml'));
    expect(fileCalls.map(p => path.basename(p))).toEqual(['ContosoEscapeLink.xml']);
    expect(spy.realpathCalls.filter(p => norm(p) === norm(root))).toHaveLength(1);
  });

  it('returns files in the same order on every scan', async () => {
    const scanner = new WorkspaceScanner();
    const first = (await scanner.scanWorkspace(root)).map(f => f.path);
    scanner.invalidate();
    const second = (await scanner.scanWorkspace(root)).map(f => f.path);
    expect(second).toEqual(first);
  });
});
