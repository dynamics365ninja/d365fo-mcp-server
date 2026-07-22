/**
 * Structured configuration: the JSON written by `npm run setup` must project
 * onto exactly the environment variables the runtime already reads, resolve
 * relative paths from its own directory, and keep secrets in a separate file.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  configBaseDir,
  getAtPath,
  resolveConfigFiles,
  setAtPath,
  toEnvRecord,
  writeConfigFile,
  writeSecretsFile,
} from '../../src/config/configFile.js';
import { SETTINGS, parseValue, serializeValue, settingByPath } from '../../src/config/settings.js';
import {
  conflictingLegacyValues,
  migrateLegacyEnv,
  openInstanceStore,
  openStore,
  readSetting,
  saveStore,
  writeSetting,
} from '../../src/cli/settingsStore.js';

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(join(os.tmpdir(), 'd365fo-config-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  delete process.env.D365FO_CONFIG;
});

describe('setting registry', () => {
  it('has unique config paths and env vars', () => {
    const paths = SETTINGS.map(s => s.path);
    const envs = SETTINGS.map(s => s.env);
    expect(new Set(paths).size).toBe(paths.length);
    expect(new Set(envs).size).toBe(envs.length);
  });

  it('documents every setting — the wizard prints these', () => {
    for (const setting of SETTINGS) {
      expect(setting.label.length, setting.path).toBeGreaterThan(0);
      expect(setting.description.length, setting.path).toBeGreaterThan(20);
    }
  });

  it('gives every enum a default that is one of its choices', () => {
    for (const setting of SETTINGS.filter(s => s.type === 'enum')) {
      expect(setting.choices?.length, setting.path).toBeGreaterThan(1);
      if (setting.default !== undefined) {
        expect(setting.choices!.map(c => c.value), setting.path).toContain(setting.default);
      }
    }
  });

  it('round-trips values through serialize/parse', () => {
    const list = settingByPath('index.labelLanguages')!;
    expect(serializeValue(list, ['en-US', 'cs'])).toBe('en-US,cs');
    expect(parseValue(list, ' en-US , cs ')).toEqual(['en-US', 'cs']);

    const bool = settingByPath('index.includeLabels')!;
    expect(serializeValue(bool, false)).toBe('false');
    expect(parseValue(bool, 'TRUE')).toBe(true);

    const int = settingByPath('server.port')!;
    expect(serializeValue(int, 3001)).toBe('3001');
    expect(parseValue(int, '3001')).toBe(3001);
  });
});

describe('config file', () => {
  it('sets and reads nested paths, deleting on empty', () => {
    const obj = {};
    setAtPath(obj, 'a.b.c', 1);
    expect(getAtPath(obj, 'a.b.c')).toBe(1);
    setAtPath(obj, 'a.b.c', '');
    expect(getAtPath(obj, 'a.b.c')).toBeUndefined();
  });

  it('projects the config onto the environment variables the runtime reads', () => {
    const configPath = join(tmp, 'config', 'd365fo-mcp.json');
    writeConfigFile(configPath, {
      naming: { prefix: 'CTSO' },
      index: { includeLabels: false, labelLanguages: ['en-US', 'cs'] },
      server: { port: 3001 },
    });

    const files = resolveConfigFiles(tmp, { allowEnvOverride: false });
    const env = toEnvRecord(files);
    expect(env.EXTENSION_PREFIX).toBe('CTSO');
    expect(env.INCLUDE_LABELS).toBe('false');
    expect(env.LABEL_LANGUAGES).toBe('en-US,cs');
    expect(env.PORT).toBe('3001');
  });

  it('resolves relative path settings from the project directory, not config/', () => {
    writeConfigFile(join(tmp, 'config', 'd365fo-mcp.json'), { index: { dbPath: './data/xpp-metadata.db' } });
    const env = toEnvRecord(resolveConfigFiles(tmp, { allowEnvOverride: false }));
    expect(env.DB_PATH).toBe(resolve(tmp, 'data', 'xpp-metadata.db'));
  });

  it('resolves an instance config against its own folder', () => {
    const instanceDir = join(tmp, 'instances', 'alpha');
    writeConfigFile(join(instanceDir, 'd365fo-mcp.json'), { index: { dbPath: './data/xpp-metadata.db' } });
    expect(configBaseDir(join(instanceDir, 'd365fo-mcp.json'))).toBe(instanceDir);
    const env = toEnvRecord(resolveConfigFiles(instanceDir, { allowEnvOverride: false }));
    expect(env.DB_PATH).toBe(resolve(instanceDir, 'data', 'xpp-metadata.db'));
  });

  it('keeps secrets out of the main config file', () => {
    const dir = join(tmp, 'config');
    writeConfigFile(join(dir, 'd365fo-mcp.json'), {
      naming: { prefix: 'CTSO' },
      behavior: { groundingSecret: 'should-not-land-here' },
    });
    writeSecretsFile(join(dir, 'secrets.json'), { behavior: { groundingSecret: 's3cret' } });

    const raw = fs.readFileSync(join(dir, 'd365fo-mcp.json'), 'utf8');
    expect(raw).not.toContain('should-not-land-here');

    const env = toEnvRecord(resolveConfigFiles(tmp, { allowEnvOverride: false }));
    expect(env.GROUNDING_SECRET).toBe('s3cret');
  });

  it('defaults a not-yet-created config to the repo layout (config/)', () => {
    const files = resolveConfigFiles(tmp, { allowEnvOverride: false });
    expect(files.configPath).toBe(join(tmp, 'config', 'd365fo-mcp.json'));
  });

  it('writes a not-yet-created config to the supplied fallback path', () => {
    const files = resolveConfigFiles(tmp, { allowEnvOverride: false, fallbackConfigPath: join(tmp, 'd365fo-mcp.json') });
    expect(files.configPath).toBe(join(tmp, 'd365fo-mcp.json'));
  });

  it('honours D365FO_CONFIG only when the caller allows it', () => {
    const explicit = join(tmp, 'elsewhere', 'custom.json');
    writeConfigFile(explicit, { naming: { prefix: 'FROM_ENV' } });
    writeConfigFile(join(tmp, 'config', 'd365fo-mcp.json'), { naming: { prefix: 'FROM_DIR' } });
    process.env.D365FO_CONFIG = explicit;

    expect(toEnvRecord(resolveConfigFiles(tmp)).EXTENSION_PREFIX).toBe('FROM_ENV');
    expect(toEnvRecord(resolveConfigFiles(tmp, { allowEnvOverride: false })).EXTENSION_PREFIX).toBe('FROM_DIR');
  });
});

describe('settings store', () => {
  const writeEnv = (content: string): string => {
    const file = join(tmp, '.env');
    fs.writeFileSync(file, content);
    return file;
  };

  it('creates a fresh instance config at the top level, not under config/', () => {
    // Regression: the wizard used to write instances/<name>/config/d365fo-mcp.json,
    // which listInstances() (top-level d365fo-mcp.json | .env) could not discover.
    const instanceDir = join(tmp, 'instances', 'gamma');
    fs.mkdirSync(instanceDir, { recursive: true });
    const store = openInstanceStore(instanceDir);
    expect(store.configPath).toBe(join(instanceDir, 'd365fo-mcp.json'));

    writeSetting(store, settingByPath('server.port')!, 3007);
    saveStore(store);
    expect(fs.existsSync(join(instanceDir, 'd365fo-mcp.json'))).toBe(true);
    expect(fs.existsSync(join(instanceDir, 'config', 'd365fo-mcp.json'))).toBe(false);
  });

  it('still finds an existing instance config written under config/ by an older build', () => {
    const instanceDir = join(tmp, 'instances', 'delta');
    writeConfigFile(join(instanceDir, 'config', 'd365fo-mcp.json'), { naming: { prefix: 'OLDBUILD' } });
    const store = openInstanceStore(instanceDir);
    expect(readSetting(store, settingByPath('naming.prefix')!)).toBe('OLDBUILD');
  });

  it('falls back to a legacy .env when the JSON does not define a value', () => {
    const envFile = writeEnv('EXTENSION_PREFIX=OLD\nPORT=3005\n');
    const store = openStore(tmp, envFile);
    expect(readSetting(store, settingByPath('naming.prefix')!)).toBe('OLD');
    expect(readSetting(store, settingByPath('server.port')!)).toBe(3005);
  });

  it('imports a legacy .env, stripping inline comments and quotes', () => {
    const envFile = writeEnv([
      'EXTENSION_PREFIX=ISV_          # ISV prefix',
      'INCLUDE_LABELS=true',
      'LABEL_LANGUAGES="en-US,cs"',
      'CUSTOM_MODELS=',
      'AZURE_STORAGE_CONNECTION_STRING=AccountKey=abc',
    ].join('\n'));

    const store = openStore(tmp, envFile);
    const migrated = migrateLegacyEnv(store).map(s => s.env);

    expect(migrated).toContain('EXTENSION_PREFIX');
    expect(getAtPath(store.config, 'naming.prefix')).toBe('ISV_');
    expect(getAtPath(store.config, 'index.includeLabels')).toBe(true);
    expect(getAtPath(store.config, 'index.labelLanguages')).toEqual(['en-US', 'cs']);
    // Empty values carry nothing over, and secrets are never auto-migrated.
    expect(migrated).not.toContain('CUSTOM_MODELS');
    expect(migrated).not.toContain('AZURE_STORAGE_CONNECTION_STRING');
  });

  it('leaves behind an enum value the registry no longer offers', () => {
    // D365FO_DEV_ENVIRONMENT_TYPE=auto was retired; the server still falls back
    // to detection when the setting is absent, so dropping it is lossless.
    const envFile = writeEnv('D365FO_DEV_ENVIRONMENT_TYPE=auto\nEXTENSION_PREFIX=ISV_\n');
    const store = openStore(tmp, envFile);
    const migrated = migrateLegacyEnv(store).map(s => s.env);

    expect(migrated).toEqual(['EXTENSION_PREFIX']);
    expect(getAtPath(store.config, 'environment.type')).toBeUndefined();
  });

  it('reports keys where a legacy .env disagrees with the config', () => {
    const envFile = writeEnv('EXTENSION_PREFIX=OLD\nPORT=3005\n');
    const store = openStore(tmp, envFile);
    writeSetting(store, settingByPath('naming.prefix')!, 'NEW');
    writeSetting(store, settingByPath('server.port')!, 3005);

    const conflicts = conflictingLegacyValues(store);
    expect(conflicts.map(c => c.setting.env)).toEqual(['EXTENSION_PREFIX']);
    expect(conflicts[0]).toMatchObject({ envValue: 'OLD', configValue: 'NEW' });
  });
});
