import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { decideSyncScope, recordSyncedDeploy } from '../../src/tools/sdlc/udeSyncScope';

const ENV = 'https://contoso-dev.crm.dynamics.com';

describe('decideSyncScope', () => {
  let root: string;
  let pkgDir: string;
  let state: string;

  const touch = (type: string, name: string, secondsAgo: number) => {
    const dir = path.join(pkgDir, 'ContosoExt', type);
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${name}.xml`);
    writeFileSync(file, '<x/>');
    const t = new Date(Date.now() - secondsAgo * 1000);
    utimesSync(file, t, t);
  };

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'ude-sync-scope-'));
    pkgDir = path.join(root, 'ContosoCore');
    mkdirSync(pkgDir, { recursive: true });
    state = path.join(root, 'state', 'sync.json');
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('syncs in full when no synced deployment is known', async () => {
    const d = await decideSyncScope(ENV, pkgDir, state);
    expect(d.fullSync).toBe(true);
    expect(d.reason).toContain('No earlier deployment');
  });

  it('skips the sync when only classes changed since the last synced deployment', async () => {
    touch('AxTable', 'ContosoRentTable', 600);
    await recordSyncedDeploy(ENV, 'ContosoCore', Date.now() - 300_000, state);
    touch('AxClass', 'ContosoRentService', 10);
    const d = await decideSyncScope(ENV, pkgDir, state);
    expect(d.fullSync).toBe(false);
  });

  it.each(['AxTable', 'AxTableExtension', 'AxView', 'AxDataEntityView', 'AxEdt', 'AxEnum', 'AxEnumExtension'])(
    'syncs in full when a %s changed since the last synced deployment', async type => {
      await recordSyncedDeploy(ENV, 'ContosoCore', Date.now() - 300_000, state);
      touch(type, 'ContosoThing', 10);
      const d = await decideSyncScope(ENV, pkgDir, state);
      expect(d.fullSync).toBe(true);
      expect(d.reason).toContain(`${type}/ContosoThing`);
    });

  it('keeps a separate baseline per environment', async () => {
    await recordSyncedDeploy(ENV, 'ContosoCore', Date.now() - 300_000, state);
    expect((await decideSyncScope('https://contoso-test.crm.dynamics.com', pkgDir, state)).fullSync).toBe(true);
  });
});
