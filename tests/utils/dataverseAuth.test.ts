import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';

const { interactiveMock, silentMock, accountsMock, constructed } = vi.hoisted(() => ({
  interactiveMock: vi.fn(),
  silentMock: vi.fn(),
  accountsMock: vi.fn(),
  constructed: [] as unknown[],
}));
vi.mock('@azure/msal-node', () => ({
  LogLevel: { Error: 0, Warning: 1, Info: 2, Verbose: 3, Trace: 4 },
  PublicClientApplication: class {
    constructor(config: unknown) { constructed.push(config); }
    acquireTokenInteractive = interactiveMock;
    acquireTokenSilent = silentMock;
    getTokenCache = () => ({ getAllAccounts: accountsMock });
  },
}));

import {
  DEFAULT_DATAVERSE_CLIENT_ID,
  _resetDataverseAuth,
  getDataverseAccessToken,
  normalizeDataverseUrl,
  readDataverseSettings,
} from '../../src/utils/dataverseAuth';

const SETTINGS = { url: 'https://contoso-dev.crm.dynamics.com', clientId: 'client-1', tenant: 'organizations' };
const ACCOUNT = { username: 'dev@contoso.com', homeAccountId: 'h' };

describe('Dataverse settings', () => {
  it('keeps only the origin of an https URL', () => {
    expect(normalizeDataverseUrl(' https://contoso-dev.crm.dynamics.com/ ')).toBe('https://contoso-dev.crm.dynamics.com');
    expect(normalizeDataverseUrl('https://contoso-dev.crm.dynamics.com/main.aspx?app=x')).toBe('https://contoso-dev.crm.dynamics.com');
    expect(normalizeDataverseUrl('http://contoso-dev.crm.dynamics.com')).toBeUndefined();
    expect(normalizeDataverseUrl('contoso-dev')).toBeUndefined();
    expect(normalizeDataverseUrl('')).toBeUndefined();
  });

  it('is undefined without a URL, and defaults the client and tenant', () => {
    expect(readDataverseSettings({})).toBeUndefined();
    expect(readDataverseSettings({ D365FO_DATAVERSE_URL: 'https://contoso-dev.crm.dynamics.com' })).toEqual({
      url: 'https://contoso-dev.crm.dynamics.com',
      clientId: DEFAULT_DATAVERSE_CLIENT_ID,
      tenant: 'organizations',
    });
    expect(readDataverseSettings({
      D365FO_DATAVERSE_URL: 'https://contoso-dev.crm.dynamics.com',
      D365FO_DATAVERSE_CLIENT_ID: 'own-client',
      D365FO_DATAVERSE_TENANT: 'contoso.onmicrosoft.com',
    })).toMatchObject({ clientId: 'own-client', tenant: 'contoso.onmicrosoft.com' });
  });
});

/** The `[dataverse-auth]` lines logged so far, without the time and pid prefix. */
function loggedLines(log: MockInstance): string[] {
  return log.mock.calls.map(c => String(c[0]).replace(/^\[dataverse-auth\] \S+ pid=\d+ /, ''));
}

describe('getDataverseAccessToken', () => {
  let log: MockInstance;
  beforeEach(() => {
    vi.resetAllMocks();
    constructed.length = 0;
    _resetDataverseAuth();
    log = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    log.mockRestore();
  });

  it('signs in through the browser once, then renews silently', async () => {
    interactiveMock.mockResolvedValue({ accessToken: 'first', account: ACCOUNT });
    silentMock.mockResolvedValue({ accessToken: 'second' });
    const opener = vi.fn();

    expect(await getDataverseAccessToken(SETTINGS, opener)).toBe('first');
    expect(await getDataverseAccessToken(SETTINGS, opener)).toBe('second');

    expect(interactiveMock).toHaveBeenCalledTimes(1);
    expect(interactiveMock.mock.calls[0][0]).toMatchObject({ scopes: ['https://contoso-dev.crm.dynamics.com/.default'] });
    // msal sends errorTemplate verbatim, so none is set: its own page names the error.
    expect(interactiveMock.mock.calls[0][0].errorTemplate).toBeUndefined();
    expect(silentMock).toHaveBeenCalledWith({ account: ACCOUNT, scopes: ['https://contoso-dev.crm.dynamics.com/.default'] });
    expect(constructed).toEqual([{
      auth: { clientId: 'client-1', authority: 'https://login.microsoftonline.com/organizations' },
      // msal's own warnings reach the log, with its PII logging off.
      system: { loggerOptions: expect.objectContaining({ piiLoggingEnabled: false, logLevel: 1 }) },
    }]);
  });

  it('redeems the refresh token on forceRefresh, for a token handed to a process that cannot renew it', async () => {
    interactiveMock.mockResolvedValue({ accessToken: 'first', account: ACCOUNT });
    silentMock.mockResolvedValue({ accessToken: 'fresh' });

    await getDataverseAccessToken(SETTINGS, vi.fn());
    expect(await getDataverseAccessToken(SETTINGS, vi.fn(), { forceRefresh: true })).toBe('fresh');
    expect(silentMock).toHaveBeenCalledWith({
      account: ACCOUNT, scopes: ['https://contoso-dev.crm.dynamics.com/.default'], forceRefresh: true,
    });
  });

  it('signs in again when silent renewal fails', async () => {
    interactiveMock.mockResolvedValueOnce({ accessToken: 'first', account: ACCOUNT })
      .mockResolvedValueOnce({ accessToken: 'again', account: ACCOUNT });
    silentMock.mockRejectedValue(new Error('interaction_required'));

    await getDataverseAccessToken(SETTINGS, vi.fn());
    expect(await getDataverseAccessToken(SETTINGS, vi.fn())).toBe('again');
    expect(interactiveMock).toHaveBeenCalledTimes(2);
  });

  it('renews silently in a new process from the account a stored cache holds, without a browser', async () => {
    accountsMock.mockResolvedValue([ACCOUNT]);
    silentMock.mockResolvedValue({ accessToken: 'from-cache' });
    const opener = vi.fn();

    const settings = { ...SETTINGS, tokenCachePath: 'C:\\cache\\dataverse-token-cache.bin' };
    expect(await getDataverseAccessToken(settings, opener)).toBe('from-cache');

    expect(interactiveMock).not.toHaveBeenCalled();
    expect(opener).not.toHaveBeenCalled();
    expect(silentMock).toHaveBeenCalledWith({ account: ACCOUNT, scopes: ['https://contoso-dev.crm.dynamics.com/.default'] });
    expect((constructed[0] as { cache?: { cachePlugin?: unknown } }).cache?.cachePlugin).toBeDefined();
  });

  it('a second call during the cache read waits for it instead of opening the browser', async () => {
    let release!: (accounts: unknown[]) => void;
    accountsMock.mockReturnValue(new Promise(resolve => { release = resolve; }));
    silentMock.mockResolvedValue({ accessToken: 'from-cache' });
    const opener = vi.fn();

    const settings = { ...SETTINGS, tokenCachePath: 'C:\cache\dataverse-token-cache.bin' };
    const first = getDataverseAccessToken(settings, opener);
    const second = getDataverseAccessToken(settings, opener);
    release([ACCOUNT]);

    expect(await Promise.all([first, second])).toEqual(['from-cache', 'from-cache']);
    expect(interactiveMock).not.toHaveBeenCalled();
    expect(opener).not.toHaveBeenCalled();
  });

  it('starts a new sign-in after one that failed', async () => {
    interactiveMock.mockRejectedValueOnce(new Error('user_cancelled'))
      .mockResolvedValueOnce({ accessToken: 'ok', account: ACCOUNT });

    await expect(getDataverseAccessToken(SETTINGS, vi.fn())).rejects.toThrow('user_cancelled');
    expect(await getDataverseAccessToken(SETTINGS, vi.fn())).toBe('ok');
    expect(interactiveMock).toHaveBeenCalledTimes(2);
  });

  /** An interactive sign-in that "opens" its page and settles only when told to. */
  function heldSignIn() {
    let finish!: (r: unknown) => void;
    interactiveMock.mockImplementation(async (request: { openBrowser: (url: string) => Promise<void> }) => {
      const held = new Promise(resolve => { finish = resolve; });
      await request.openBrowser('https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize?x=1');
      return held;
    });
    return (result: unknown) => finish(result);
  }

  it('shares one sign-in between concurrent calls: one tab, one listener', async () => {
    const finish = heldSignIn();
    const opener = vi.fn().mockResolvedValue(undefined);

    const first = getDataverseAccessToken(SETTINGS, opener);
    const second = getDataverseAccessToken(SETTINGS, opener);
    await vi.waitFor(() => expect(opener).toHaveBeenCalled());
    finish({ accessToken: 'shared', account: ACCOUNT });

    expect(await Promise.all([first, second])).toEqual(['shared', 'shared']);
    expect(interactiveMock).toHaveBeenCalledTimes(1);
    expect(opener).toHaveBeenCalledTimes(1);
  });

  it('gives up on a sign-in nobody completes, then shows the same page again instead of a new sign-in', async () => {
    vi.useFakeTimers();
    try {
      const finish = heldSignIn();
      const opener = vi.fn().mockResolvedValue(undefined);

      const first = getDataverseAccessToken(SETTINGS, opener);
      const timedOut = expect(first).rejects.toThrow(/not completed within 5 minutes/);
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      await timedOut;

      const retry = getDataverseAccessToken(SETTINGS, opener);
      await vi.advanceTimersByTimeAsync(0);
      expect(interactiveMock).toHaveBeenCalledTimes(1);
      expect(opener).toHaveBeenCalledTimes(2);
      expect(opener.mock.calls[1][0]).toBe(opener.mock.calls[0][0]);

      finish({ accessToken: 'late', account: ACCOUNT });
      expect(await retry).toBe('late');
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a sign-in completed after its caller gave up, so the next call is silent', async () => {
    vi.useFakeTimers();
    try {
      const finish = heldSignIn();
      silentMock.mockResolvedValue({ accessToken: 'silent' });

      const first = getDataverseAccessToken(SETTINGS, vi.fn().mockResolvedValue(undefined));
      const timedOut = expect(first).rejects.toThrow(/not completed/);
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      await timedOut;
      finish({ accessToken: 'late', account: ACCOUNT });
      await vi.advanceTimersByTimeAsync(0);

      expect(await getDataverseAccessToken(SETTINGS, vi.fn())).toBe('silent');
      expect(interactiveMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('logs why silent renewal failed, with the account state, and numbers the browser sign-ins', async () => {
    interactiveMock.mockResolvedValueOnce({ accessToken: 'token-one', account: ACCOUNT })
      .mockResolvedValueOnce({ accessToken: 'token-two', account: ACCOUNT });
    silentMock.mockRejectedValue(Object.assign(
      new Error('invalid_grant: AADSTS700082: The refresh token has expired.\nTrace ID: t\nCorrelation ID: c'),
      { name: 'InteractionRequiredAuthError', errorCode: 'invalid_grant', errorNo: '700082', correlationId: 'c-1' },
    ));
    accountsMock.mockResolvedValue([]);

    await getDataverseAccessToken(SETTINGS, vi.fn());
    await getDataverseAccessToken(SETTINGS, vi.fn());

    const lines = loggedLines(log);
    expect(lines).toEqual([
      'silent token request: no signed-in account in this process or the token cache',
      'starting browser sign-in #1 in this process',
      expect.stringMatching(/^browser sign-in #1 completed, account [0-9a-f]{8}$/),
      expect.stringMatching(
        /^silent token request failed: \[InteractionRequiredAuthError, invalid_grant, AADSTS700082\] AADSTS700082: The refresh token has expired\. \(correlation id c-1\); account [0-9a-f]{8} from browser sign-in #1, tenant any \(organizations\), no longer in the token cache \(0 account\(s\)\)$/,
      ),
      'starting browser sign-in #2 in this process',
      expect.stringMatching(/^browser sign-in #2 completed/),
    ]);
    expect(String(log.mock.calls[0][0])).toMatch(/^\[dataverse-auth\] \d{4}-\d\d-\d\dT\S+Z pid=\d+ /);
    expect(lines.join('\n')).not.toMatch(/token-one|token-two|dev@contoso\.com/);
  });

  it('logs the first silent success and the next one after anything else was logged, but not every cache hit', async () => {
    interactiveMock.mockResolvedValue({ accessToken: 'first', account: ACCOUNT });
    const expiresOn = new Date(Date.now() + 30 * 60_000);
    silentMock.mockResolvedValue({ accessToken: 'hit', fromCache: true, expiresOn });

    await getDataverseAccessToken(SETTINGS, vi.fn());
    await getDataverseAccessToken(SETTINGS, vi.fn());
    await getDataverseAccessToken(SETTINGS, vi.fn());
    silentMock.mockResolvedValueOnce({ accessToken: 'renewed', fromCache: false, expiresOn });
    await getDataverseAccessToken(SETTINGS, vi.fn());

    const successes = loggedLines(log).filter(l => l.includes('succeeded'));
    expect(successes).toEqual([
      expect.stringMatching(/^silent token request succeeded from the cache, token expires in (29|30) min, account [0-9a-f]{8}$/),
      expect.stringMatching(/^silent token request succeeded over the network, /),
    ]);
  });

  it('tells a status read apart from a failed renewal', async () => {
    await expect(getDataverseAccessToken(SETTINGS, vi.fn(), { silentOnly: true })).rejects.toThrow(/Not signed in/);
    expect(loggedLines(log)).toEqual(['status read: no signed-in account in this process or the token cache']);
  });

  it('names the account a new process takes from the cache file, and where it came from', async () => {
    accountsMock.mockResolvedValue([{ ...ACCOUNT, tenantId: 'other' }]);
    silentMock.mockResolvedValue({ accessToken: 'from-cache', fromCache: true });

    await getDataverseAccessToken({ ...SETTINGS, tokenCachePath: 'C:\\cache\\dataverse-token-cache.bin' }, vi.fn());

    expect(loggedLines(log)[0]).toMatch(
      /^process start: 1 account\(s\) in the token cache file, using account [0-9a-f]{8} \(cache file \(first account\)\)$/,
    );
  });

  it('shows the page again and logs it when the caller that started a sign-in gave up', async () => {
    vi.useFakeTimers();
    try {
      const finish = heldSignIn();
      const opener = vi.fn().mockResolvedValue(undefined);
      const first = getDataverseAccessToken(SETTINGS, opener);
      const timedOut = expect(first).rejects.toThrow(/not completed/);
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      await timedOut;

      const retry = getDataverseAccessToken(SETTINGS, opener);
      await vi.advanceTimersByTimeAsync(0);
      finish({ accessToken: 'late', account: ACCOUNT });
      expect(await retry).toBe('late');

      expect(loggedLines(log)).toEqual(expect.arrayContaining([
        'gave up waiting for browser sign-in #1 after 5 minutes',
        'browser sign-in #1 is unfinished and nobody waits on it: showing its page again',
      ]));
    } finally {
      vi.useRealTimers();
    }
  });

  it('still returns the token when the sign-in completes while its page is shown again', async () => {
    vi.useFakeTimers();
    try {
      const finish = heldSignIn();
      const first = getDataverseAccessToken(SETTINGS, vi.fn().mockResolvedValue(undefined));
      const timedOut = expect(first).rejects.toThrow(/not completed/);
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      await timedOut;

      // The sign-in settles while the browser is being opened again, which clears entry.pending.
      const opener = vi.fn(async () => {
        finish({ accessToken: 'settled', account: ACCOUNT });
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(await getDataverseAccessToken(SETTINGS, opener)).toBe('settled');
    } finally {
      vi.useRealTimers();
    }
  });
});
