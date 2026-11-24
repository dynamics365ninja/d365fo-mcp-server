/**
 * The cross-model write policy is re-read while the server runs.
 *
 * Consent to write into another model deliberately lives in a file the agent has
 * no tool to write — but it used to take a restart to apply, and "restart the
 * server" mid-task is not an answer anyone accepts. That made the only
 * sanctioned route the expensive one, with all the pressure pointing at cheaper,
 * self-servable ones instead. The guard now re-reads .env before each decision.
 *
 * Only the two write-policy keys are refreshed. Re-projecting paths or
 * credentials under a running index is a different and much riskier thing, so
 * anything else in the file stays as it was at boot.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadEnv, reloadWritePolicy, writePolicyFiles } from '../../src/utils/loadEnv';
import { crossModelWriteAllowedByConfig } from '../../src/utils/crossModelWriteGuard';

let dir: string;
let envPath: string;
const saved = { ...process.env };

/** loadEnv resolves .env from the caller's install root, or from ENV_FILE. */
function bootWith(contents: string) {
  fs.writeFileSync(envPath, contents, 'utf-8');
  process.env.ENV_FILE = envPath;
  loadEnv(`file:///${dir.replace(/\\/g, '/')}/src/bootstrapEnv.ts`);
}

/** Rewrite .env the way a user would, with an mtime the stat can see. */
function userEdits(contents: string) {
  fs.writeFileSync(envPath, contents, 'utf-8');
  const future = new Date(Date.now() + 5_000);
  fs.utimesSync(envPath, future, future);
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'writepolicy-'));
  envPath = path.join(dir, '.env');
  delete process.env.D365FO_ALLOW_CROSS_MODEL_WRITE;
  delete process.env.D365FO_CROSS_MODEL_WRITE_MODELS;
  delete process.env.D365FO_WORKSPACE_MODELS;
  delete process.env.D365FO_CONFIG;
});

afterEach(() => {
  process.env = { ...saved };
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('reloadWritePolicy', () => {
  it('applies an allow-list the user adds after the refusal, with no restart', () => {
    bootWith('D365FO_MODEL_NAME=DemoSK\n');
    expect(crossModelWriteAllowedByConfig('DemoCore')).toBe(false);

    userEdits('D365FO_MODEL_NAME=DemoSK\nD365FO_CROSS_MODEL_WRITE_MODELS=DemoCore\n');

    expect(crossModelWriteAllowedByConfig('DemoCore')).toBe(true);
    // Still only that model — the edit is not a blanket opt-out.
    expect(crossModelWriteAllowedByConfig('DemoOther')).toBe(false);
  });

  it('applies the blanket form too', () => {
    bootWith('');
    expect(crossModelWriteAllowedByConfig('DemoCore')).toBe(false);

    userEdits('D365FO_ALLOW_CROSS_MODEL_WRITE=true\n');

    expect(crossModelWriteAllowedByConfig('DemoCore')).toBe(true);
  });

  it('withdraws consent again when the user removes the line', () => {
    bootWith('D365FO_CROSS_MODEL_WRITE_MODELS=DemoCore\n');
    expect(crossModelWriteAllowedByConfig('DemoCore')).toBe(true);

    userEdits('\n');

    expect(crossModelWriteAllowedByConfig('DemoCore')).toBe(false);
  });

  it('leaves a value the real environment owns alone', () => {
    // Shell / .mcp.json env{} / App Settings outrank the file at boot, and a
    // reload must not quietly invert that.
    process.env.D365FO_CROSS_MODEL_WRITE_MODELS = 'DemoFromShell';
    bootWith('D365FO_CROSS_MODEL_WRITE_MODELS=DemoFromFile\n');

    userEdits('D365FO_CROSS_MODEL_WRITE_MODELS=DemoEditedFile\n');

    expect(crossModelWriteAllowedByConfig('DemoFromShell')).toBe(true);
    expect(crossModelWriteAllowedByConfig('DemoEditedFile')).toBe(false);
  });

  it('refreshes nothing but the write policy', () => {
    bootWith('D365FO_MODEL_NAME=DemoSK\nDB_PATH=/boot/db\n');
    const bootModel = process.env.D365FO_MODEL_NAME;

    userEdits('D365FO_MODEL_NAME=SomethingElse\nDB_PATH=/edited/db\nD365FO_ALLOW_CROSS_MODEL_WRITE=true\n');
    crossModelWriteAllowedByConfig('DemoCore');

    expect(process.env.D365FO_MODEL_NAME).toBe(bootModel);
    expect(process.env.DB_PATH).not.toBe('/edited/db');
  });

  // #1332: in an npm installation the .env sits in the package folder and an
  // update replaces it. The config file next to D365FO_CONFIG does not move.
  it('reads workspace.models from the JSON config, live', () => {
    const configPath = path.join(dir, 'instance.json');
    fs.writeFileSync(configPath, JSON.stringify({ workspace: { modelName: 'DemoSK' } }), 'utf-8');
    process.env.D365FO_CONFIG = configPath;
    bootWith('');
    expect(crossModelWriteAllowedByConfig('DemoSKTests')).toBe(false);

    fs.writeFileSync(configPath, JSON.stringify({ workspace: { modelName: 'DemoSK', models: ['DemoSKTests'] } }), 'utf-8');
    const future = new Date(Date.now() + 5_000);
    fs.utimesSync(configPath, future, future);

    expect(crossModelWriteAllowedByConfig('DemoSKTests')).toBe(true);
    expect(crossModelWriteAllowedByConfig('DemoOther')).toBe(false);
    expect(writePolicyFiles()?.configPath).toBe(configPath);
  });

  it('keeps the policy it has while the config file is half-saved', () => {
    const configPath = path.join(dir, 'instance.json');
    fs.writeFileSync(configPath, JSON.stringify({ workspace: { models: ['DemoSKTests'] } }), 'utf-8');
    process.env.D365FO_CONFIG = configPath;
    bootWith('');
    expect(crossModelWriteAllowedByConfig('DemoSKTests')).toBe(true);

    fs.writeFileSync(configPath, '{ "workspace": { "mod', 'utf-8');
    const future = new Date(Date.now() + 5_000);
    fs.utimesSync(configPath, future, future);

    expect(crossModelWriteAllowedByConfig('DemoSKTests')).toBe(true);
  });

  it('is a no-op when loadEnv never ran', () => {
    // Unit tests and CLI callers import the guard without booting the server.
    expect(() => reloadWritePolicy()).not.toThrow();
  });
});
