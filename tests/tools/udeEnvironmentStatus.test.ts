import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { udeEnvironmentSection, udeEnvironmentStatusLines } from '../../src/tools/sdlc/udeEnvironmentStatus';
import { recordDeploy } from '../../src/tools/sdlc/udeSyncScope';
import type { DataverseClient } from '../../src/tools/sdlc/udeSysTest';

const ENV = 'https://contoso-dev.crm.dynamics.com';
const S = '@OData.Community.Display.V1.FormattedValue';

const clientReturning = (value: unknown[], status = 200): DataverseClient & { urls: string[] } => {
  const urls: string[] = [];
  return {
    url: ENV,
    urls,
    getToken: async () => 'token',
    fetch: (async (u: string) => {
      urls.push(String(u));
      return new Response(JSON.stringify({ value }), { status });
    }) as unknown as typeof fetch,
  };
};

const row = (name: string, createdon: string, statecode: number, status: string, modifiedon = createdon) => ({
  msprov_name: name, createdon, modifiedon, statecode, [`statuscode${S}`]: status,
});

describe('UDE environment status', () => {
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
    root = mkdtempSync(path.join(os.tmpdir(), 'ude-env-status-'));
    pkgDir = path.join(root, 'ContosoCore');
    mkdirSync(pkgDir, { recursive: true });
    state = path.join(root, 'state.json');
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('reports a running operation, the last deploy and newer local files', async () => {
    const client = clientReturning([
      row('Unit Test Execution', '2026-11-18T10:05:00Z', 0, 'In progress'),
      row('Deploy', '2026-11-18T09:00:00Z', 1, 'Succeeded', '2026-11-18T09:20:00Z'),
    ]);
    touch('AxClass', 'ContosoRentService', 10);
    touch('AxTable', 'ContosoRentTable', 600);
    await recordDeploy(ENV, 'ContosoCore', Date.now() - 300_000, state);
    const text = (await udeEnvironmentStatusLines({ client, packageDir: pkgDir, stateFile: state })).join('\n');
    expect(text).toContain('Running now      : Unit Test Execution (since 2026-11-18 10:05 UTC)');
    expect(text).toContain('Last deploy      : Succeeded, 2026-11-18 09:20 UTC');
    expect(text).toContain('1 local file(s) newer than the last deploy');
    expect(text).toContain('AxClass/ContosoRentService');
    expect(text).not.toContain('ContosoRentTable');
    expect(client.urls[0]).toContain('msprov_operationhistories');
  });

  it('says nothing is running and nothing is newer', async () => {
    const client = clientReturning([row('Deploy', '2026-11-18T09:00:00Z', 1, 'Succeeded')]);
    touch('AxClass', 'ContosoRentService', 600);
    await recordDeploy(ENV, 'ContosoCore', Date.now() - 300_000, state);
    const text = (await udeEnvironmentStatusLines({ client, packageDir: pkgDir, stateFile: state })).join('\n');
    expect(text).toContain('Running now      : nothing');
    expect(text).toContain('no local file is newer');
  });

  it('is silent when the environment errors, sign-in is missing or it is too slow', async () => {
    const failing = clientReturning([], 503);
    expect(await udeEnvironmentSection(async () => pkgDir, { client: failing, stateFile: state })).toEqual([]);
    const notSignedIn: DataverseClient = { url: ENV, getToken: async () => { throw new Error('Not signed in'); } };
    expect(await udeEnvironmentSection(async () => pkgDir, { client: notSignedIn })).toEqual([]);
    const slow: DataverseClient = {
      url: ENV, getToken: async () => 't',
      fetch: (() => new Promise(() => {})) as unknown as typeof fetch,
    };
    expect(await udeEnvironmentSection(async () => pkgDir, { client: slow }, 50)).toEqual([]);
  });

  it('adds nothing without a Dataverse URL configured', async () => {
    const saved = process.env.D365FO_DATAVERSE_URL;
    delete process.env.D365FO_DATAVERSE_URL;
    try {
      expect(await udeEnvironmentSection(async () => pkgDir)).toEqual([]);
    } finally {
      if (saved !== undefined) process.env.D365FO_DATAVERSE_URL = saved;
    }
  });
});
