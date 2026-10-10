import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { settingByPath } from '../../src/config/settings.js';
import { resolveAxDbConfig } from '../../src/config/axdbSql.js';
import { loadEnv } from '../../src/utils/loadEnv.js';

afterEach(() => vi.unstubAllEnvs());
describe('optional AxDB configuration', () => {
  it('does not assume localhost when SQL was skipped', () => {
    expect(resolveAxDbConfig({})).toBeUndefined();
    expect(resolveAxDbConfig({ D365FO_SQL_ENABLED: 'true', D365FO_SQL_SERVER: ' ' })).toBeUndefined();
    expect(resolveAxDbConfig({ D365FO_SQL_ENABLED: 'false', D365FO_SQL_SERVER: 'localhost' })).toBeUndefined();
    expect(settingByPath('sql.server')?.default).toBeUndefined();
  });
  it('uses Windows auth and explicit instance with bounded defaults', () => {
    expect(resolveAxDbConfig({ D365FO_SQL_ENABLED: 'true', D365FO_SQL_SERVER: 'localhost\\DEV' })).toEqual({
      server: 'localhost\\DEV', database: 'AxDB', trustServerCertificate: false,
      commandTimeoutSeconds: 30, maxRows: 100,
    });
    expect(() => resolveAxDbConfig({ D365FO_SQL_ENABLED: 'true', D365FO_SQL_SERVER: 'localhost', D365FO_SQL_MAX_ROWS: '0' })).toThrow();
  });
  it('does not import another installation SQL target', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sql-isolation-'));
    const original = { ...process.env };
    try {
      const instance = join(dir, 'instances', 'other');
      mkdirSync(instance, { recursive: true });
      writeFileSync(join(instance, 'd365fo-mcp.json'), '{}');
      writeFileSync(join(dir, '.env'), 'D365FO_SQL_ENABLED=true\nD365FO_SQL_SERVER=wrong\nD365FO_SQL_TIMEOUT=5\n');
      for (const key of Object.keys(process.env)) if (key.startsWith('D365FO_SQL_') || key === 'ENV_FILE') delete process.env[key];
      process.env.D365FO_CONFIG = join(instance, 'd365fo-mcp.json');
      loadEnv(pathToFileURL(join(dir, 'src', 'index.ts')).href);
      expect(resolveAxDbConfig()).toBeUndefined();
      expect(process.env.D365FO_SQL_TIMEOUT).toBeUndefined();
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
      Object.assign(process.env, original);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
