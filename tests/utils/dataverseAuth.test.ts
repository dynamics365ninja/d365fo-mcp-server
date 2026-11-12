import { describe, it, expect, vi, beforeEach } from 'vitest';

const { interactiveMock, silentMock, accountsMock, constructed } = vi.hoisted(() => ({
  interactiveMock: vi.fn(),
  silentMock: vi.fn(),
  accountsMock: vi.fn(),
  constructed: [] as unknown[],
}));
vi.mock('@azure/msal-node', () => ({
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

describe('getDataverseAccessToken', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    constructed.length = 0;
    _resetDataverseAuth();
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
    expect(constructed).toEqual([{ auth: { clientId: 'client-1', authority: 'https://login.microsoftonline.com/organizations' } }]);
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

    const settings = { ...SETTINGS, tokenCachePath: 'C:\cache\dataverse-token-cache.bin' };
    expect(await getDataverseAccessToken(settings, opener)).toBe('from-cache');

    expect(interactiveMock).not.toHaveBeenCalled();
    expect(opener).not.toHaveBeenCalled();
    expect(silentMock).toHaveBeenCalledWith({ account: ACCOUNT, scopes: ['https://contoso-dev.crm.dynamics.com/.default'] });
    expect((constructed[0] as { cache?: { cachePlugin?: unknown } }).cache?.cachePlugin).toBeDefined();
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
});
