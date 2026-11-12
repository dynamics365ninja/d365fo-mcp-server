import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  createFileTokenCachePlugin,
  dataverseTokenCachePath,
  type SecretProtector,
} from '../../src/utils/dataverseTokenCache';

/** Reversible stand-in for DPAPI, so the test runs everywhere and shows the file is not plain text. */
const fakeProtector: SecretProtector = {
  protect: async plain => `P:${plain.split('').reverse().join('')}`,
  unprotect: async text => {
    if (!text.startsWith('P:')) throw new Error('foreign');
    return text.slice(2).split('').reverse().join('');
  },
};

function context(serialized: string, changed: boolean) {
  const state = { loaded: undefined as string | undefined };
  return {
    state,
    ctx: {
      cacheHasChanged: changed,
      tokenCache: {
        serialize: () => serialized,
        deserialize: (value: string) => { state.loaded = value; },
      },
    } as never,
  };
}

describe('dataverseTokenCachePath', () => {
  it('defaults under LOCALAPPDATA on Windows', () => {
    expect(dataverseTokenCachePath({ LOCALAPPDATA: 'C:\\Users\\agent\\AppData\\Local' }, 'win32'))
      .toBe(path.join('C:\\Users\\agent\\AppData\\Local', 'd365fo-mcp', 'dataverse-token-cache.bin'));
  });
  it('takes an explicit file, and is off when asked', () => {
    expect(dataverseTokenCachePath({ D365FO_DATAVERSE_TOKEN_CACHE: 'D:\\cache.bin' }, 'win32')).toBe('D:\\cache.bin');
    expect(dataverseTokenCachePath({ D365FO_DATAVERSE_TOKEN_CACHE: 'off', LOCALAPPDATA: 'C:\\x' }, 'win32')).toBeUndefined();
  });
  it('persists nothing off Windows, where DPAPI is not available', () => {
    expect(dataverseTokenCachePath({ LOCALAPPDATA: '/home/x' }, 'linux')).toBeUndefined();
  });
});

describe('createFileTokenCachePlugin', () => {
  it('writes the cache encrypted when it changed, and a new process reads it back', async () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'dvcache-')), 'sub', 'cache.bin');
    const plugin = createFileTokenCachePlugin(file, fakeProtector);

    await plugin.afterCacheAccess(context('{"RefreshToken":{"x":1}}', true).ctx);
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, 'utf8')).not.toContain('RefreshToken');

    const next = context('', false);
    await createFileTokenCachePlugin(file, fakeProtector).beforeCacheAccess(next.ctx);
    expect(next.state.loaded).toBe('{"RefreshToken":{"x":1}}');
  });

  it('does not write when nothing changed', async () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'dvcache-')), 'cache.bin');
    await createFileTokenCachePlugin(file, fakeProtector).afterCacheAccess(context('{}', false).ctx);
    expect(existsSync(file)).toBe(false);
  });

  it('starts empty on a missing or foreign file instead of failing', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'dvcache-'));
    const missing = context('', false);
    await createFileTokenCachePlugin(path.join(dir, 'none.bin'), fakeProtector).beforeCacheAccess(missing.ctx);
    expect(missing.state.loaded).toBeUndefined();

    const foreign = path.join(dir, 'foreign.bin');
    writeFileSync(foreign, 'not ours');
    const read = context('', false);
    await createFileTokenCachePlugin(foreign, fakeProtector).beforeCacheAccess(read.ctx);
    expect(read.state.loaded).toBeUndefined();
  });
});
