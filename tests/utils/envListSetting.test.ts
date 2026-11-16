/**
 * The .env edit behind a model create / delete.
 *
 * The file is the user's: one entry of one key changes, and every other byte —
 * comments, order, line ends, other keys — stays.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { editEnvList, updateListSetting } from '../../src/utils/envListSetting';

describe('editEnvList', () => {
  const text = '# models\r\nCUSTOM_MODELS=ContosoCore,ContosoExt\r\nPORT=3000\r\n';

  it('adds an entry in place and keeps everything else, CRLF included', () => {
    const out = editEnvList(text, 'CUSTOM_MODELS', { add: 'ContosoScripts' });
    expect(out.text).toBe('# models\r\nCUSTOM_MODELS=ContosoCore,ContosoExt,ContosoScripts\r\nPORT=3000\r\n');
    expect(out.changed).toBe(true);
  });

  it('is a no-op for an entry already present, case-insensitively', () => {
    const out = editEnvList(text, 'CUSTOM_MODELS', { add: 'contosoext' });
    expect(out.changed).toBe(false);
    expect(out.text).toBe(text);
  });

  it('removes an entry, and leaves an absent key absent', () => {
    expect(editEnvList(text, 'CUSTOM_MODELS', { remove: 'ContosoCore' }).text).toContain('CUSTOM_MODELS=ContosoExt\r\n');
    const missing = editEnvList(text, 'D365FO_CROSS_MODEL_WRITE_MODELS', { remove: 'ContosoCore' });
    expect(missing).toEqual({ text, changed: false, value: null });
  });

  it('appends a key the file does not carry, and ignores a commented-out one', () => {
    const commented = '# CUSTOM_MODELS=Old\nPORT=3000';
    const out = editEnvList(commented, 'CUSTOM_MODELS', { add: 'ContosoExt' });
    expect(out.text).toBe('# CUSTOM_MODELS=Old\nPORT=3000\nCUSTOM_MODELS=ContosoExt\n');
  });

  it('keeps quotes around the value', () => {
    expect(editEnvList('CUSTOM_MODELS="A,B"\n', 'CUSTOM_MODELS', { add: 'C' }).text).toBe('CUSTOM_MODELS="A,B,C"\n');
  });
});

describe('updateListSetting', () => {
  let dir: string;
  let envPath: string;
  const KEY = 'D365FO_TEST_LIST_SETTING';
  const file = (owned = false) => ({ envPath, ownedByRealEnv: () => owned });

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'env-list-'));
    envPath = path.join(dir, '.env');
    delete process.env[KEY];
  });
  afterEach(async () => {
    delete process.env[KEY];
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('writes the file and process.env together', async () => {
    await fs.writeFile(envPath, `${KEY}=ContosoCore\n`, 'utf-8');
    process.env[KEY] = 'ContosoCore';
    const out = await updateListSetting(file(), KEY, { add: 'ContosoExt' });
    expect(out).toMatchObject({ persisted: true, appliedToProcess: true, value: 'ContosoCore,ContosoExt' });
    expect(await fs.readFile(envPath, 'utf-8')).toBe(`${KEY}=ContosoCore,ContosoExt\n`);
    expect(process.env[KEY]).toBe('ContosoCore,ContosoExt');
  });

  it('seeds a key the file lacks with the WHOLE current list, not only the new entry', async () => {
    // The list came from elsewhere (the JSON config). A line holding just the new
    // model would replace it at the next start when this .env outranks that config.
    await fs.writeFile(envPath, 'PORT=3000\n', 'utf-8');
    process.env[KEY] = 'ContosoCore';
    await updateListSetting(file(), KEY, { add: 'ContosoExt' });
    expect(await fs.readFile(envPath, 'utf-8')).toBe(`PORT=3000\n${KEY}=ContosoCore,ContosoExt\n`);
  });

  it('does not write a key the real environment owns, and says so', async () => {
    await fs.writeFile(envPath, 'PORT=3000\n', 'utf-8');
    const out = await updateListSetting(file(true), KEY, { add: 'ContosoExt' });
    expect(out.persisted).toBe(false);
    expect(out.appliedToProcess).toBe(true);
    expect(out.note).toMatch(/real environment/);
    expect(await fs.readFile(envPath, 'utf-8')).toBe('PORT=3000\n');
  });

  it('edits process.env only when no .env is loaded', async () => {
    const out = await updateListSetting(null, KEY, { add: 'ContosoExt' });
    expect(out).toMatchObject({ persisted: false, appliedToProcess: true });
    expect(process.env[KEY]).toBe('ContosoExt');
  });

  it('removes from both and drops an emptied variable', async () => {
    await fs.writeFile(envPath, `${KEY}=ContosoExt\n`, 'utf-8');
    process.env[KEY] = 'ContosoExt';
    const out = await updateListSetting(file(), KEY, { remove: 'contosoext' });
    expect(out.persisted).toBe(true);
    expect(process.env[KEY]).toBeUndefined();
    expect(await fs.readFile(envPath, 'utf-8')).toBe(`${KEY}=\n`);
  });
});
