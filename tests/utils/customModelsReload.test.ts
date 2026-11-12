/**
 * The custom-models list is re-read while the server runs.
 *
 * A developer adds a model (a new test model, say) to the list and the server
 * kept calling it a Microsoft standard, read-only model until it was restarted,
 * because the list was projected onto process.env once at boot. The classifier
 * now follows the .env / JSON config file the value came from.
 *
 * Only this one setting is refreshed, on the same terms as the write policy:
 * gated on the files' mtime, and a value the real environment owns stays put.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadEnv, reloadCustomModels } from '../../src/utils/loadEnv';
import {
  clearAutoDetectedModels,
  getCustomModels,
  isCustomModel,
  isStandardModel,
  registerCustomModel,
} from '../../src/utils/modelClassifier';

let dir: string;
let envPath: string;
let configPath: string;
// One clock for the whole file, only ever moving forward, like the real one.
let clock = Date.now();
const saved = { ...process.env };

/** loadEnv resolves .env from the caller's install root, or from ENV_FILE. */
function boot() {
  process.env.ENV_FILE = envPath;
  loadEnv(`file:///${dir.replace(/\\/g, '/')}/src/bootstrapEnv.ts`);
}

let edits = 0;
/** Rewrite a file the way a user would, with an mtime the stat can see. */
function userEdits(file: string, contents: string) {
  fs.writeFileSync(file, contents, 'utf-8');
  const future = new Date(Date.now() + 5_000 * ++edits);
  fs.utimesSync(file, future, future);
}

function configJson(models: string[] | undefined): string {
  return JSON.stringify({ version: 1, environment: models ? { customModels: models } : {} });
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'custommodels-'));
  envPath = path.join(dir, '.env');
  configPath = path.join(dir, 'config', 'd365fo-mcp.json');
  delete process.env.CUSTOM_MODELS;
  delete process.env.EXTENSION_PREFIX;
  delete process.env.D365FO_MODEL_NAME;
  delete process.env.D365FO_CONFIG;
  clearAutoDetectedModels();
  // The classifier rations its file check to once a second. Step the clock past
  // that on every read so each assertion sees the files as they are now.
  vi.spyOn(Date, 'now').mockImplementation(() => (clock += 2_000));
});

afterEach(() => {
  vi.restoreAllMocks();
  process.env = { ...saved };
  clearAutoDetectedModels();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('custom-models list from .env', () => {
  it('treats a model added after boot as custom, with no restart', () => {
    fs.writeFileSync(envPath, 'CUSTOM_MODELS=ContosoCore\n', 'utf-8');
    boot();
    expect(isCustomModel('ContosoExt')).toBe(false);
    expect(isStandardModel('ContosoExt')).toBe(true);

    userEdits(envPath, 'CUSTOM_MODELS=ContosoCore,ContosoExt\n');

    expect(getCustomModels()).toEqual(['ContosoCore', 'ContosoExt']);
    expect(isCustomModel('ContosoExt')).toBe(true);
    expect(isStandardModel('ContosoExt')).toBe(false);
    expect(isCustomModel('ContosoCore')).toBe(true);
  });

  it('stops treating a model as custom once it is taken off the list', () => {
    fs.writeFileSync(envPath, 'CUSTOM_MODELS=ContosoCore,ContosoExt\n', 'utf-8');
    boot();
    expect(isCustomModel('ContosoExt')).toBe(true);

    userEdits(envPath, 'CUSTOM_MODELS=ContosoCore\n');

    expect(isCustomModel('ContosoExt')).toBe(false);
    expect(isCustomModel('ContosoCore')).toBe(true);
  });

  it('empties the list when the line is removed', () => {
    fs.writeFileSync(envPath, 'CUSTOM_MODELS=ContosoExt\n', 'utf-8');
    boot();

    userEdits(envPath, '\n');

    expect(getCustomModels()).toEqual([]);
    expect(isStandardModel('ContosoExt')).toBe(true);
  });

  it('keeps a model that was registered by other means when the list shrinks', () => {
    // Auto-detection (workspace, project, a write) registers models on its own.
    // Those are a separate source and must survive an edit of the list.
    fs.writeFileSync(envPath, 'CUSTOM_MODELS=FabrikamTools,ContosoExt\n', 'utf-8');
    boot();
    registerCustomModel('FabrikamTools');

    userEdits(envPath, '\n');

    expect(isCustomModel('FabrikamTools')).toBe(true);
    expect(isCustomModel('ContosoExt')).toBe(false);
  });

  it('leaves a value the real environment owns alone', () => {
    // Shell / .mcp.json env{} / App Settings outrank the files at boot, and a
    // reload must not quietly invert that.
    process.env.CUSTOM_MODELS = 'ContosoFromShell';
    fs.writeFileSync(envPath, 'CUSTOM_MODELS=ContosoCore\n', 'utf-8');
    boot();

    userEdits(envPath, 'CUSTOM_MODELS=ContosoExt\n');

    expect(getCustomModels()).toEqual(['ContosoFromShell']);
    expect(isCustomModel('ContosoExt')).toBe(false);
  });

  it('does not re-read a file whose mtime did not move', () => {
    // A whole-second mtime, so setting it back is exact on every file system.
    const stamp = new Date(1_700_000_000_000);
    fs.writeFileSync(envPath, 'CUSTOM_MODELS=ContosoCore\n', 'utf-8');
    fs.utimesSync(envPath, stamp, stamp);
    boot();

    fs.writeFileSync(envPath, 'CUSTOM_MODELS=ContosoExt\n', 'utf-8');
    fs.utimesSync(envPath, stamp, stamp);

    expect(getCustomModels()).toEqual(['ContosoCore']);
  });

  it('checks the files at most once a second', () => {
    fs.writeFileSync(envPath, 'CUSTOM_MODELS=ContosoCore\n', 'utf-8');
    boot();
    getCustomModels();
    // Freeze the clock: the edit is on disk, but the next read is inside the window.
    vi.mocked(Date.now).mockImplementation(() => clock);
    userEdits(envPath, 'CUSTOM_MODELS=ContosoExt\n');
    expect(getCustomModels()).toEqual(['ContosoCore']);

    clock += 1_000;
    expect(getCustomModels()).toEqual(['ContosoExt']);
  });

  it('refreshes nothing but the list', () => {
    fs.writeFileSync(envPath, 'CUSTOM_MODELS=ContosoCore\nEXTENSION_PREFIX=Contoso\n', 'utf-8');
    boot();

    userEdits(envPath, 'CUSTOM_MODELS=ContosoExt\nEXTENSION_PREFIX=Fabrikam\nD365FO_MODEL_NAME=ContosoOther\n');
    getCustomModels();

    expect(process.env.EXTENSION_PREFIX).toBe('Contoso');
    expect(process.env.D365FO_MODEL_NAME).toBeUndefined();
  });

  it('is a no-op when loadEnv never ran with a file to watch', () => {
    // Unit tests and CLI callers set CUSTOM_MODELS directly and never boot.
    process.env.CUSTOM_MODELS = 'ContosoExt';
    boot();
    expect(() => reloadCustomModels()).not.toThrow();
    expect(getCustomModels()).toEqual(['ContosoExt']);
  });
});

describe('custom-models list from the JSON config file', () => {
  beforeEach(() => {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
  });

  it('follows the config file when the list grows and shrinks', () => {
    fs.writeFileSync(configPath, configJson(['ContosoCore']), 'utf-8');
    boot();
    expect(getCustomModels()).toEqual(['ContosoCore']);

    userEdits(configPath, configJson(['ContosoCore', 'ContosoExt']));
    expect(isCustomModel('ContosoExt')).toBe(true);

    userEdits(configPath, configJson(['ContosoExt']));
    expect(isCustomModel('ContosoCore')).toBe(false);
    expect(isCustomModel('ContosoExt')).toBe(true);
  });

  it('picks up a list added to a config file that had none', () => {
    fs.writeFileSync(configPath, configJson(undefined), 'utf-8');
    boot();
    expect(getCustomModels()).toEqual([]);

    userEdits(configPath, configJson(['ContosoExt']));

    expect(isCustomModel('ContosoExt')).toBe(true);
  });

  it('keeps the current list while the config file does not parse', () => {
    fs.writeFileSync(configPath, configJson(['ContosoCore']), 'utf-8');
    boot();
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    userEdits(configPath, '{ "environment": { "customModels": ["ContosoExt"');
    expect(getCustomModels()).toEqual(['ContosoCore']);
    expect(stderr).toHaveBeenCalled();

    userEdits(configPath, configJson(['ContosoExt']));
    expect(getCustomModels()).toEqual(['ContosoExt']);
  });

  it('lets a .env named through ENV_FILE keep outranking the config file, as at boot', () => {
    fs.writeFileSync(envPath, 'CUSTOM_MODELS=ContosoCore\n', 'utf-8');
    fs.writeFileSync(configPath, configJson(['ContosoOther']), 'utf-8');
    boot();
    expect(getCustomModels()).toEqual(['ContosoCore']);

    userEdits(configPath, configJson(['ContosoOther', 'ContosoExt']));
    expect(getCustomModels()).toEqual(['ContosoCore']);

    userEdits(envPath, 'CUSTOM_MODELS=ContosoCore,ContosoExt\n');
    expect(getCustomModels()).toEqual(['ContosoCore', 'ContosoExt']);
  });

  it('lets the config file keep outranking an ambient .env, as at boot', () => {
    // No ENV_FILE: the .env beside the installation is only a fallback.
    fs.writeFileSync(envPath, 'CUSTOM_MODELS=ContosoOther\n', 'utf-8');
    fs.writeFileSync(configPath, configJson(['ContosoCore']), 'utf-8');
    delete process.env.ENV_FILE;
    loadEnv(`file:///${dir.replace(/\\/g, '/')}/src/bootstrapEnv.ts`);
    expect(getCustomModels()).toEqual(['ContosoCore']);

    userEdits(envPath, 'CUSTOM_MODELS=ContosoOther,ContosoExt\n');
    expect(getCustomModels()).toEqual(['ContosoCore']);

    userEdits(configPath, configJson(['ContosoCore', 'ContosoExt']));
    expect(getCustomModels()).toEqual(['ContosoCore', 'ContosoExt']);
  });
});
