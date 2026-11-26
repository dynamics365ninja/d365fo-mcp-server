import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PublicClientApplication } from '@azure/msal-node';
import {
  createFileTokenCachePlugin,
  dataverseTokenCachePath,
  dpapiProtector,
  type SecretProtector,
  windowsPowerShellPath,
} from '../../src/utils/dataverseTokenCache';

// The plugin logs its reads and writes; kept out of the test output, and readable by the tests.
let log: MockInstance;
beforeEach(() => {
  log = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  log.mockRestore();
});

/** The `[dataverse-auth]` lines logged so far, without the time and pid prefix. */
function loggedLines(): string[] {
  return log.mock.calls.map(c => String(c[0]).replace(/^\[dataverse-auth\] \S+ pid=\d+ /, ''));
}

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

    // Token requests that change nothing: neither PowerShell call, the file is still the one written. msal
    // still gets the cache each time, from memory.
    for (let i = 0; i < 5; i++) {
      const access = context('{"v":1}', false);
      await plugin.beforeCacheAccess(access.ctx);
      await plugin.afterCacheAccess(access.ctx);
      expect(access.state.loaded).toBe('{"v":1}');
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

  it('logs the writes and a reload by another process, with what the cache held before and after, never its contents', async () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'dvcache-')), 'cache.bin');
    const plugin = createFileTokenCachePlugin(file, fakeProtector);
    let held = '{"Account":{"a":{}},"AccessToken":{"t1":{"secret":"token-in-memory"}},"RefreshToken":{"r":{}}}';
    const live = {
      cacheHasChanged: true,
      tokenCache: { serialize: () => held, deserialize: (value: string) => { held = value; } },
    } as never;
    await plugin.afterCacheAccess(live);

    // Another process writes a cache without the access token; this one's next access loads it.
    await createFileTokenCachePlugin(file, fakeProtector)
      .afterCacheAccess(context('{"Account":{"a":{}},"RefreshToken":{"r":{}}}', true).ctx);
    await plugin.beforeCacheAccess(live);

    const lines = loggedLines();
    expect(lines).toEqual([
      'token cache written: 1 account(s), 1 access token(s), 1 refresh token(s)',
      'token cache written: 1 account(s), 0 access token(s), 1 refresh token(s)',
      'token cache changed by another process, reloaded from the file; this process had: ' +
        '1 account(s), 1 access token(s), 1 refresh token(s), the file has: 1 account(s), 0 access token(s), 1 refresh token(s)',
    ]);
    expect(lines.join('\n')).not.toContain('token-in-memory');
  });

  it('logs the first load in a process, and an unreadable file', async () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'dvcache-')), 'cache.bin');
    await createFileTokenCachePlugin(file, fakeProtector).afterCacheAccess(context('{"Account":{"a":{}}}', true).ctx);
    await createFileTokenCachePlugin(file, fakeProtector).beforeCacheAccess(context('{}', false).ctx);
    writeFileSync(file, 'not ours');
    await createFileTokenCachePlugin(file, fakeProtector).beforeCacheAccess(context('{}', false).ctx);

    expect(loggedLines().slice(1)).toEqual([
      'token cache loaded from the file; this process had: nothing, ' +
        'the file has: 1 account(s), 0 access token(s), 0 refresh token(s)',
      'token cache file could not be read, this process keeps its own: [Error] foreign',
    ]);
  });

  it('keeps a renewed token across msal\'s overwriteCache, which rebuilds the cache from the text last deserialized', async () => {
    // msal-node's TokenCache, as far as the plugin sees it: before every silent request, overwriteCache()
    // clears the in-memory cache, calls beforeCacheAccess, and rebuilds the cache from the text last passed to
    // deserialize(). A token request that renews a token changes the in-memory cache without deserialize().
    const cache = {
      memory: '' as string,
      snapshot: undefined as string | undefined,
      serialize() { return this.memory; },
      deserialize(text: string) { this.snapshot = text; this.memory = text; },
    };
    const contextOf = (changed: boolean) => ({ cacheHasChanged: changed, tokenCache: cache }) as never;
    const overwriteCache = async () => {
      cache.memory = '';
      await plugin.beforeCacheAccess(contextOf(false));
      cache.memory = cache.snapshot ?? '';
      await plugin.afterCacheAccess(contextOf(false));
    };
    const renew = async (text: string) => {
      await plugin.beforeCacheAccess(contextOf(true));
      cache.memory = text;
      await plugin.afterCacheAccess(contextOf(true));
    };

    const file = path.join(mkdtempSync(path.join(tmpdir(), 'dvcache-')), 'cache.bin');
    await createFileTokenCachePlugin(file, fakeProtector).afterCacheAccess(context('{"AccessToken":{"old":{}}}', true).ctx);
    const unprotect = vi.fn(fakeProtector.unprotect);
    const plugin = createFileTokenCachePlugin(file, { ...fakeProtector, unprotect });

    await overwriteCache();
    expect(cache.memory).toBe('{"AccessToken":{"old":{}}}');

    await renew('{"AccessToken":{"renewed":{}}}');
    await overwriteCache();
    await overwriteCache();
    expect(cache.memory).toBe('{"AccessToken":{"renewed":{}}}');
    // Still one decryption: the renewed cache comes from memory, not from the file.
    expect(unprotect).toHaveBeenCalledTimes(1);
  });

  it('survives a file that is JSON but not a cache msal accepts, with the real msal TokenCache', async () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'dvcache-')), 'cache.bin');
    writeFileSync(file, await fakeProtector.protect(Buffer.from('null').toString('base64')));
    const app = new PublicClientApplication({
      auth: { clientId: '00000000-0000-0000-0000-000000000001' },
      cache: { cachePlugin: createFileTokenCachePlugin(file, fakeProtector) },
    });
    const cache = app.getTokenCache() as unknown as { overwriteCache(): Promise<void>; serialize(): string };

    // Without the guard, msal keeps `null` as the text it rebuilds from, and every access after it throws.
    await expect(app.getTokenCache().getAllAccounts()).resolves.toEqual([]);
    await expect(cache.overwriteCache()).resolves.toBeUndefined();
    await expect(app.getTokenCache().getAllAccounts()).resolves.toEqual([]);
    expect(() => cache.serialize()).not.toThrow();
    expect(loggedLines()).toContain('token cache file is not a cache msal accepts, this process keeps its own');
  });

  it('keeps its own cache when another process writes one msal rejects', async () => {
    const cache = {
      memory: '',
      deserialize(text: string) {
        if (JSON.parse(text) === null) throw new TypeError("Cannot read properties of null (reading 'Account')");
        this.memory = text;
      },
      serialize() { return this.memory; },
    };
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'dvcache-')), 'cache.bin');
    const plugin = createFileTokenCachePlugin(file, fakeProtector);
    cache.memory = '{"AccessToken":{"own":{}}}';
    await plugin.afterCacheAccess({ cacheHasChanged: true, tokenCache: cache } as never);

    writeFileSync(file, await fakeProtector.protect(Buffer.from('null').toString('base64')));
    cache.memory = '';
    await plugin.beforeCacheAccess({ cacheHasChanged: false, tokenCache: cache } as never);
    expect(cache.memory).toBe('{"AccessToken":{"own":{}}}');
  });

  it('never logs the text of a file that decrypts to something that is not JSON', async () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'dvcache-')), 'cache.bin');
    writeFileSync(file, await fakeProtector.protect(Buffer.from('secret-token-abcdefghij').toString('base64')));
    const ctx = {
      cacheHasChanged: false,
      tokenCache: { serialize: () => '{}', deserialize: (value: string) => JSON.parse(value) },
    } as never;
    await createFileTokenCachePlugin(file, fakeProtector).beforeCacheAccess(ctx);
    expect(loggedLines()).toEqual(['token cache file is not a cache msal accepts, this process keeps its own']);
    expect(loggedLines().join('\n')).not.toContain('secret');
  });

  it('keeps a renewed token in the process when the cache file cannot be written', async () => {
    const cache = {
      memory: '{"AccessToken":{"renewed":{}}}',
      deserialize(text: string) { this.memory = text; },
      serialize() { return this.memory; },
    };
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'dvcache-')), 'cache.bin');
    const failing: SecretProtector = { ...fakeProtector, protect: async () => { throw new Error('DPAPI call failed'); } };
    const plugin = createFileTokenCachePlugin(file, failing);

    await plugin.afterCacheAccess({ cacheHasChanged: true, tokenCache: cache } as never);
    cache.memory = '';
    await plugin.beforeCacheAccess({ cacheHasChanged: false, tokenCache: cache } as never);
    expect(cache.memory).toBe('{"AccessToken":{"renewed":{}}}');
  });

  it('logs why the cache was not written', async () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'dvcache-')), 'cache.bin');
    const failing: SecretProtector = { ...fakeProtector, protect: async () => { throw new Error('DPAPI call failed'); } };
    await createFileTokenCachePlugin(file, failing).afterCacheAccess(context('{}', true).ctx);
    expect(loggedLines()).toEqual(['token cache not written: [Error] DPAPI call failed']);
  });
});

describe('createFileTokenCachePlugin with the real msal-node client', () => {
  // No emulation of msal here: real acquireTokenSilent calls, whose overwriteCache() runs before each one.
  // Only the network is fake: it answers instance discovery, the OpenID configuration and the token
  // endpoint, and counts the token requests. The cache starts with an expired access token and a refresh token.
  const clientId = '00000000-0000-0000-0000-000000000001';
  const tid = '11111111-1111-1111-1111-111111111111';
  const oid = '22222222-2222-2222-2222-222222222222';
  const home = `${oid}.${tid}`;
  const env = 'login.microsoftonline.com';
  const scope = 'https://contoso.crm.dynamics.com/.default';

  function seedCache(): string {
    const now = Math.floor(Date.now() / 1000);
    return JSON.stringify({
      Account: {
        [`${home}-${env}-${tid}`]: {
          home_account_id: home, environment: env, realm: tid, local_account_id: oid,
          username: 'user@contoso.com', authority_type: 'MSSTS',
        },
      },
      AccessToken: {
        [`${home}-${env}-accesstoken-${clientId}-${tid}-${scope}`.toLowerCase()]: {
          home_account_id: home, environment: env, credential_type: 'AccessToken', client_id: clientId,
          secret: 'AT-start', realm: tid, target: scope, token_type: 'Bearer',
          cached_at: String(now - 7200), expires_on: String(now - 3600), extended_expires_on: String(now - 3600),
        },
      },
      RefreshToken: {
        [`${home}-${env}-refreshtoken-${clientId}--`]: {
          home_account_id: home, environment: env, credential_type: 'RefreshToken', client_id: clientId, secret: 'RT-1',
        },
      },
      IdToken: {},
      AppMetadata: {},
    });
  }

  function fakeNetwork() {
    const counter = { tokenRequests: 0 };
    const tenantUrl = `https://${env}/${tid}`;
    const networkClient = {
      async sendGetRequestAsync(url: string) {
        if (url.includes('discovery/instance')) {
          return {
            status: 200, headers: {}, body: {
              tenant_discovery_endpoint: `${tenantUrl}/v2.0/.well-known/openid-configuration`,
              metadata: [{ preferred_network: env, preferred_cache: env, aliases: [env] }],
            },
          };
        }
        return {
          status: 200, headers: {}, body: {
            token_endpoint: `${tenantUrl}/oauth2/v2.0/token`, issuer: `${tenantUrl}/v2.0`,
            authorization_endpoint: `${tenantUrl}/oauth2/v2.0/authorize`,
            end_session_endpoint: `${tenantUrl}/oauth2/v2.0/logout`, jwks_uri: `${tenantUrl}/discovery/v2.0/keys`,
          },
        };
      },
      async sendPostRequestAsync() {
        counter.tokenRequests++;
        return {
          status: 200, headers: {}, body: {
            token_type: 'Bearer', scope, expires_in: 3600, ext_expires_in: 3600,
            access_token: `AT-renewed-${counter.tokenRequests}`, refresh_token: `RT-${counter.tokenRequests + 1}`,
            client_info: Buffer.from(JSON.stringify({ uid: oid, utid: tid })).toString('base64url'),
          },
        };
      },
    };
    return { counter, networkClient: networkClient as never };
  }

  function app(file: string, networkClient: never): PublicClientApplication {
    return new PublicClientApplication({
      auth: { clientId, authority: `https://${env}/${tid}` },
      system: { networkClient },
      cache: { cachePlugin: createFileTokenCachePlugin(file, fakeProtector) },
    });
  }

  async function silentTokens(client: PublicClientApplication, count: number): Promise<string[]> {
    const [account] = await client.getTokenCache().getAllAccounts();
    const tokens: string[] = [];
    for (let i = 0; i < count; i++) {
      const result = await client.acquireTokenSilent({ account, scopes: [scope] });
      tokens.push(`${result.accessToken}${result.fromCache ? ' from cache' : ' over the network'}`);
    }
    return tokens;
  }

  it('renews an expired token once, then serves the renewed one from the cache', async () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'dvcache-')), 'cache.bin');
    await createFileTokenCachePlugin(file, fakeProtector).afterCacheAccess(context(seedCache(), true).ctx);
    const { counter, networkClient } = fakeNetwork();

    // Before the fix every request went back to the cache of process start and renewed again:
    // AT-renewed-1..4, all over the network, 4 token requests.
    expect(await silentTokens(app(file, networkClient), 4)).toEqual([
      'AT-renewed-1 over the network',
      'AT-renewed-1 from cache',
      'AT-renewed-1 from cache',
      'AT-renewed-1 from cache',
    ]);
    expect(counter.tokenRequests).toBe(1);

    // Another server process sharing the cache file starts with the renewed token.
    const other = fakeNetwork();
    expect(await silentTokens(app(file, other.networkClient), 2)).toEqual(['AT-renewed-1 from cache', 'AT-renewed-1 from cache']);
    expect(other.counter.tokenRequests).toBe(0);
  });

  it('keeps the renewed token in the process when the cache file cannot be written', async () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'dvcache-')), 'cache.bin');
    await createFileTokenCachePlugin(file, fakeProtector).afterCacheAccess(context(seedCache(), true).ctx);
    const { counter, networkClient } = fakeNetwork();
    const client = new PublicClientApplication({
      auth: { clientId, authority: `https://${env}/${tid}` },
      system: { networkClient },
      cache: {
        cachePlugin: createFileTokenCachePlugin(file, {
          ...fakeProtector,
          protect: async () => { throw new Error('DPAPI call failed'); },
        }),
      },
    });

    expect(await silentTokens(client, 3)).toEqual([
      'AT-renewed-1 over the network',
      'AT-renewed-1 from cache',
      'AT-renewed-1 from cache',
    ]);
    expect(counter.tokenRequests).toBe(1);
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
