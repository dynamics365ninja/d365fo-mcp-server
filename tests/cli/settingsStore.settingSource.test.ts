/**
 * settingSource — distinguishes "explicitly set in the JSON config" from
 * "inherited from a legacy .env fallback" for a given setting.
 *
 * This is the piece doctor needs to tell apart a genuine config mistake from
 * a stale .env override silently outranking live UDE auto-detection (see
 * checkUdeOverridePath in ../commands/doctor.ts) — readSetting alone only
 * returns the effective value, not where it came from.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { settingByPath } from '../../src/config/settings.js';
import { openStore, settingSource, writeSetting, saveStore } from '../../src/cli/settingsStore.js';

const packagePath = settingByPath('environment.packagePath')!;

function tempDir(): string {
  return fs.mkdtempSync(join(os.tmpdir(), 'd365fo-settingsource-'));
}

describe('settingSource', () => {
  it('reports "none" when neither the config nor a .env sets the value', () => {
    const store = openStore(tempDir(), null);
    expect(settingSource(store, packagePath)).toBe('none');
  });

  it('reports "config" once the JSON config carries the value', () => {
    const store = openStore(tempDir(), null);
    writeSetting(store, packagePath, 'K:\\AosService\\PackagesLocalDirectory');
    saveStore(store);
    expect(settingSource(store, packagePath)).toBe('config');
  });

  it('reports "env" when only a legacy .env carries the value', () => {
    const dir = tempDir();
    const envFile = join(dir, '.env');
    fs.writeFileSync(envFile, `${packagePath.env}=K:\\AosService\\PackagesLocalDirectory\n`);
    const store = openStore(dir, envFile);
    expect(settingSource(store, packagePath)).toBe('env');
  });

  it('prefers "config" over a .env that also sets the same key', () => {
    const dir = tempDir();
    const envFile = join(dir, '.env');
    fs.writeFileSync(envFile, `${packagePath.env}=K:\\stale\\path\n`);
    const store = openStore(dir, envFile);
    writeSetting(store, packagePath, 'K:\\current\\path');
    saveStore(store);
    expect(settingSource(store, packagePath)).toBe('config');
  });
});
