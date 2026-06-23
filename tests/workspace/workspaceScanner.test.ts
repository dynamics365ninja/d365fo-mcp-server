/**
 * WorkspaceScanner cache + invalidation (Phase 3a context pipeline).
 * Uses a real temp directory so glob/mtime behaviour is exercised end to end.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { WorkspaceScanner } from '../../src/workspace/workspaceScanner.js';

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-scan-'));
  await fs.mkdir(path.join(root, 'AxClass'), { recursive: true });
  await fs.writeFile(path.join(root, 'AxClass', 'Foo.xml'), '<AxClass><Name>Foo</Name></AxClass>');
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('WorkspaceScanner caching', () => {
  it('serves cached results within the TTL and refreshes after invalidate()', async () => {
    const scanner = new WorkspaceScanner();

    const first = await scanner.scanWorkspace(root);
    expect(first.map((f) => f.name)).toEqual(['Foo']);
    expect(first[0].type).toBe('class');

    // Add a second object — within the TTL the cache should hide it.
    await fs.writeFile(path.join(root, 'AxClass', 'Bar.xml'), '<AxClass><Name>Bar</Name></AxClass>');
    const cached = await scanner.scanWorkspace(root);
    expect(cached.map((f) => f.name)).toEqual(['Foo']);

    // After invalidation the next scan re-reads from disk.
    scanner.invalidate();
    const fresh = await scanner.scanWorkspace(root);
    expect(fresh.map((f) => f.name).sort()).toEqual(['Bar', 'Foo']);
  });

  it('invalidate(path) only clears the targeted workspace', async () => {
    const scanner = new WorkspaceScanner();
    await scanner.scanWorkspace(root);
    // Invalidating an unrelated path leaves our cache intact.
    scanner.invalidate('K:\\some\\other\\path');
    await fs.writeFile(path.join(root, 'AxClass', 'Baz.xml'), '<AxClass><Name>Baz</Name></AxClass>');
    const stillCached = await scanner.scanWorkspace(root);
    expect(stillCached.map((f) => f.name)).toEqual(['Foo']);
  });
});
