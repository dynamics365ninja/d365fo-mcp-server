import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  createFileTokenCachePlugin,
  dataverseTokenCachePath,
  dpapiProtector,
  type SecretProtector,
  windowsPowerShellPath,
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

  it('starts empty when the file decrypts to something that is not a cache', async () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'dvcache-')), 'cache.bin');
    writeFileSync(file, await fakeProtector.protect(Buffer.from('not json').toString('base64')));
    const ctx = {
      cacheHasChanged: false,
      tokenCache: { serialize: () => '', deserialize: (value: string) => JSON.parse(value) },
    } as never;
    await expect(createFileTokenCachePlugin(file, fakeProtector).beforeCacheAccess(ctx)).resolves.toBeUndefined();
  });

  it('decrypts only when the file changed, and encrypts only when the cache changed', async () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'dvcache-')), 'cache.bin');
    const protect = vi.fn(fakeProtector.protect);
    const unprotect = vi.fn(fakeProtector.unprotect);
    const counting: SecretProtector = { protect, unprotect };
    const plugin = createFileTokenCachePlugin(file, counting);

    // Sign-in: the cache changed, so it is written once.
    await plugin.afterCacheAccess(context('{"v":1}', true).ctx);
    expect(protect).toHaveBeenCalledTimes(1);

    // Token requests that change nothing: neither PowerShell call, the file is still the one written.
    for (let i = 0; i < 5; i++) {
      const access = context('{"v":1}', false);
      await plugin.beforeCacheAccess(access.ctx);
      await plugin.afterCacheAccess(access.ctx);
      expect(access.state.loaded).toBeUndefined();
    }
    expect(unprotect).not.toHaveBeenCalled();
    expect(protect).toHaveBeenCalledTimes(1);

    // Another process replaces the file: the next access decrypts it once.
    await createFileTokenCachePlugin(file, fakeProtector).afterCacheAccess(context('{"v":2}', true).ctx);
    const after = context('', false);
    await plugin.beforeCacheAccess(after.ctx);
    expect(after.state.loaded).toBe('{"v":2}');
    await plugin.beforeCacheAccess(context('', false).ctx);
    expect(unprotect).toHaveBeenCalledTimes(1);
  });

  it('tries an unreadable file once, not on every request', async () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'dvcache-')), 'cache.bin');
    writeFileSync(file, 'not ours');
    const unprotect = vi.fn(fakeProtector.unprotect);
    const plugin = createFileTokenCachePlugin(file, { ...fakeProtector, unprotect });
    await plugin.beforeCacheAccess(context('', false).ctx);
    await plugin.beforeCacheAccess(context('', false).ctx);
    expect(unprotect).toHaveBeenCalledTimes(1);
  });

  it('replaces the file in one step and leaves no temporary file behind', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'dvcache-'));
    const file = path.join(dir, 'cache.bin');
    writeFileSync(file, 'old');
    const writers = Array.from({ length: 8 }, (_, i) => createFileTokenCachePlugin(file, fakeProtector)
      .afterCacheAccess(context(`{"writer":${i}}`, true).ctx));
    await Promise.all(writers);

    expect(readdirSync(dir)).toEqual(['cache.bin']);
    const read = context('', false);
    await createFileTokenCachePlugin(file, fakeProtector).beforeCacheAccess(read.ctx);
    expect(read.state.loaded).toMatch(/^\{"writer":\d\}$/);
  });

  it('does not write, and does not throw, when encryption fails', async () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'dvcache-')), 'cache.bin');
    const failing: SecretProtector = { ...fakeProtector, protect: async () => { throw new Error('DPAPI call failed'); } };
    await expect(createFileTokenCachePlugin(file, failing).afterCacheAccess(context('{}', true).ctx)).resolves.toBeUndefined();
    expect(existsSync(file)).toBe(false);
  });
});

describe('windowsPowerShellPath', () => {
  it('runs Windows PowerShell from SystemRoot, not whatever powershell.exe is first on PATH', () => {
    expect(windowsPowerShellPath({ SystemRoot: 'C:\\Windows' }))
      .toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    expect(windowsPowerShellPath({})).toBe('powershell.exe');
  });
});

describe.runIf(process.platform === 'win32')('dpapiProtector (Windows)', () => {
  it('round-trips for the current user, stores no plain text, and rejects data that is not its own', async () => {
    const plain = Buffer.from('{"RefreshToken":{}}').toString('base64');
    const protectedText = await dpapiProtector.protect(plain);
    expect(protectedText).not.toContain(plain);
    expect(await dpapiProtector.unprotect(protectedText)).toBe(plain);
    await expect(dpapiProtector.unprotect(Buffer.from('not ours').toString('base64'))).rejects.toThrow('DPAPI call failed');
  }, 30_000);
});
