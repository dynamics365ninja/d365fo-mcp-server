/**
 * Azure AD sign-in for calls to a Dataverse environment's Web API.
 *
 * Used on UDE, where the D365FO runtime is hosted in the cloud and reached through the
 * Dataverse environment it belongs to (run_systest_class sends tests there). It signs in as
 * the developer, interactively, through a public client — the same kind of sign-in Visual
 * Studio's Power Platform Tools and `pac` do — so the calls run with the developer's own
 * Dataverse permissions and need no secret in the configuration.
 *
 * A server process asks for one sign-in and renews it silently after that. At most one browser
 * sign-in per client is in progress at a time. Tokens are never logged or returned to the
 * caller's transcript. What the sign-in does (silent requests that fail and why, browser
 * sign-ins, token cache reloads) goes to stderr as `[dataverse-auth]` lines, which LOG_FILE keeps.
 *
 * On Windows the token cache is also kept in a file encrypted for the current user (DPAPI, as
 * az CLI and `pac` do, see dataverseTokenCache.ts), so a new server process renews silently from
 * the stored refresh token and the browser opens only for the very first sign-in, or when the
 * refresh token has expired. This is what lets an unattended agent run tests: it has nobody to
 * complete a browser page. D365FO_DATAVERSE_TOKEN_CACHE=off keeps the cache in memory only.
 */
import { spawn } from 'node:child_process';
import { type AccountInfo, type AuthenticationResult, PublicClientApplication } from '@azure/msal-node';
import {
  accountFingerprint,
  dataverseAuthLogCount,
  describeAuthError,
  logDataverseAuth,
  msalLoggerOptions,
} from './dataverseAuthLog.js';
import { createFileTokenCachePlugin, dataverseTokenCachePath } from './dataverseTokenCache.js';

/**
 * Microsoft's sample public client id for Dataverse, the one the Dataverse SDK samples use for
 * development and testing. Power Platform Tools for Visual Studio signs in with the same id and
 * the http://localhost redirect, which is what the interactive sign-in here needs. A tenant
 * that blocks it can register its own public client (redirect http://localhost) and set
 * environment.dataverseClientId.
 */
export const DEFAULT_DATAVERSE_CLIENT_ID = '51f81489-12ee-4a9e-aaae-a2591f45987d';
export const DEFAULT_DATAVERSE_TENANT = 'organizations';

/** How long a sign-in in the browser may take before the tool gives up on it. */
const INTERACTIVE_TIMEOUT_MS = 5 * 60_000;

export interface DataverseAuthSettings {
  /** Environment URL, e.g. https://contoso-dev.crm.dynamics.com (no trailing path). */
  url: string;
  clientId: string;
  tenant: string;
  /** File for the persistent token cache. Undefined: memory only. */
  tokenCachePath?: string;
}

/** Normalise a Dataverse URL to its origin; undefined when it is not an https URL. */
export function normalizeDataverseUrl(value: string | undefined): string | undefined {
  const raw = value?.trim();
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:') return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

/** The Dataverse connection settings, from the environment (config is mapped onto it at startup). */
export function readDataverseSettings(env: NodeJS.ProcessEnv = process.env): DataverseAuthSettings | undefined {
  const url = normalizeDataverseUrl(env.D365FO_DATAVERSE_URL);
  if (!url) return undefined;
  return {
    url,
    clientId: env.D365FO_DATAVERSE_CLIENT_ID?.trim() || DEFAULT_DATAVERSE_CLIENT_ID,
    tenant: env.D365FO_DATAVERSE_TENANT?.trim() || DEFAULT_DATAVERSE_TENANT,
    tokenCachePath: dataverseTokenCachePath(env),
  };
}

/** Open a URL in the default browser without going through a shell (the URL is full of `&`). */
function openInBrowser(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = process.platform === 'win32'
      ? spawn('rundll32', ['url.dll,FileProtocolHandler', url], { detached: true, stdio: 'ignore', windowsHide: true })
      : spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { detached: true, stdio: 'ignore' });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

export type BrowserOpener = (url: string) => Promise<void>;

/** A browser sign-in that has not finished: its result, and the sign-in page it opened. */
interface PendingSignIn {
  result: Promise<AuthenticationResult>;
  url?: string;
  /** Callers waiting on it now. Its page is shown again only to a caller that finds none. */
  waiters: number;
  /** Its number among the browser sign-ins of this process, for the log. */
  number: number;
}

/**
 * One cached client per (tenant, client id): its in-memory token cache is what makes the
 * second call in a process silent. `pending` is the sign-in in progress, shared by every caller:
 * msal's loopback listener has no timeout of its own and stays open until the sign-in settles,
 * so starting a second one would open a second tab and leave a second listener behind.
 */
const clients = new Map<string, {
  app: PublicClientApplication;
  account?: AccountInfo;
  /** Where `account` came from, for the log. */
  accountSource?: string;
  pending?: PendingSignIn;
  ready?: Promise<void>;
  /** Browser sign-ins this process started, numbered in the log. */
  signIns?: number;
  /** dataverseAuthLogCount() after the last logged silent success; a success is logged again once anything else was. */
  quietSince?: number;
}>();

/** Whether the account belongs to the configured tenant, without naming either. */
function tenantRelation(account: AccountInfo, tenant: string): string {
  if (['organizations', 'common', 'consumers'].includes(tenant.toLowerCase())) return `any (${tenant.toLowerCase()})`;
  return account.tenantId?.toLowerCase() === tenant.toLowerCase() ? 'matches' : 'differs';
}

/** Test-only: forget every cached client and its tokens. */
export function _resetDataverseAuth(): void {
  clients.clear();
}

/**
 * An access token for the Dataverse Web API at `settings.url`: silently when this process
 * signed in before, otherwise by opening the sign-in page in the browser and waiting for it.
 *
 * `forceRefresh` redeems the refresh token for a new access token instead of returning a cached
 * one, which may have only minutes left. For a caller that hands the token to a process that
 * cannot renew it (the UDE deployment), so the token lasts its full lifetime from now.
 */
export async function getDataverseAccessToken(
  settings: DataverseAuthSettings,
  openBrowser: BrowserOpener = openInBrowser,
  options: { forceRefresh?: boolean; silentOnly?: boolean } = {},
): Promise<string> {
  const key = `${settings.tenant.toLowerCase()}|${settings.clientId.toLowerCase()}`;
  let entry = clients.get(key);
  if (!entry) {
    entry = {
      app: new PublicClientApplication({
        auth: {
          clientId: settings.clientId,
          authority: `https://login.microsoftonline.com/${settings.tenant}`,
        },
        system: { loggerOptions: msalLoggerOptions },
        ...(settings.tokenCachePath
          ? { cache: { cachePlugin: createFileTokenCachePlugin(settings.tokenCachePath) } }
          : {}),
      }),
    };
    clients.set(key, entry);
    if (settings.tokenCachePath) {
      // A new process starts with the account a previous one stored, so the silent path below can renew it.
      // Kept as a promise that every call awaits: a second call arriving while the cache is still being
      // read (it decrypts through PowerShell, up to ~2 s) must not see "no account" and open the browser.
      const loading = entry;
      loading.ready = (async () => {
        try {
          const accounts = await loading.app.getTokenCache().getAllAccounts();
          const inTenant = accounts.find(a => a.tenantId?.toLowerCase() === settings.tenant.toLowerCase());
          loading.account = inTenant ?? accounts[0];
          if (loading.account) loading.accountSource = inTenant ? 'cache file (tenant match)' : 'cache file (first account)';
          logDataverseAuth(
            `process start: ${accounts.length} account(s) in the token cache file` +
            (loading.account ? `, using account ${accountFingerprint(loading.account.homeAccountId)} (${loading.accountSource})` : ''),
          );
        } catch (error) {
          /* unreadable cache: sign in as without it */
          logDataverseAuth(`process start: the token cache could not be read: ${describeAuthError(error)}`);
        }
      })();
    }
  }
  await entry.ready;
  const scopes = [`${settings.url}/.default`];

  // A status read (silentOnly) is told apart, so its "not signed in" isn't mistaken for a failed renewal.
  const request = `${options.silentOnly ? 'status read' : 'silent token request'}${options.forceRefresh ? ' (forceRefresh)' : ''}`;
  if (entry.account) {
    const account = entry.account;
    try {
      const silent = await entry.app.acquireTokenSilent({
        account,
        scopes,
        ...(options.forceRefresh ? { forceRefresh: true } : {}),
      });
      if (silent?.accessToken) {
        // Logged when it went to the network (a renewal, about hourly) or when anything else was logged since the
        // last one, e.g. a cache reload or a failure: shows whether the request after it worked. Cache hits stay quiet.
        if (!silent.fromCache || entry.quietSince !== dataverseAuthLogCount()) {
          const minutes = silent.expiresOn ? Math.round((silent.expiresOn.getTime() - Date.now()) / 60_000) : undefined;
          logDataverseAuth(
            `${request} succeeded ${silent.fromCache ? 'from the cache' : 'over the network'}` +
            `${minutes === undefined ? '' : `, token expires in ${minutes} min`}, account ${accountFingerprint(account.homeAccountId)}`,
          );
          entry.quietSince = dataverseAuthLogCount();
        }
        return silent.accessToken;
      }
      logDataverseAuth(`${request} returned no access token`);
    } catch (error) {
      /* expired refresh token, or a scope for a different environment: sign in again */
      logDataverseAuth(`${request} failed: ${describeAuthError(error)}; ${await describeAccountState(entry.app, account, entry.accountSource, settings.tenant)}`);
    }
  } else {
    logDataverseAuth(`${request}: no signed-in account in this process or the token cache`);
  }

  if (options.silentOnly) {
    // For a status read that must never open a browser tab: no usable sign-in is "nothing known".
    throw new Error('Not signed in to Dataverse yet.');
  }

  let signIn: PendingSignIn;
  if (entry.pending) {
    // A sign-in from an earlier call has not finished. While another call is waiting on it, its
    // tab is open: just wait too. When the call that started it gave up, show its page again
    // rather than start a second sign-in; a tab the user closed is thereby replaced, and the
    // same listener receives the answer. Taken before the await: a sign-in that settles while the
    // page opens clears entry.pending.
    signIn = entry.pending;
    if (signIn.waiters === 0 && signIn.url) {
      logDataverseAuth(`browser sign-in #${signIn.number} is unfinished and nobody waits on it: showing its page again`);
      await openBrowser(signIn.url).catch(() => {});
    } else {
      logDataverseAuth(`waiting for browser sign-in #${signIn.number}, started by another call`);
    }
  } else {
    const current = entry;
    current.signIns = (current.signIns ?? 0) + 1;
    const pending: PendingSignIn = { waiters: 0, number: current.signIns } as PendingSignIn;
    logDataverseAuth(`starting browser sign-in #${pending.number} in this process`);
    pending.result = current.app.acquireTokenInteractive({
      scopes,
      openBrowser: async url => {
        pending.url = url;
        await openBrowser(url);
      },
      // No errorTemplate: msal sends it verbatim, and its own page names the error.
      successTemplate: 'Signed in. You can close this tab and return to your editor.',
    }).then(
      result => {
        // Kept even when the caller that started it has timed out: the next call is then silent.
        if (result?.account) {
          current.account = result.account;
          current.accountSource = `browser sign-in #${pending.number}`;
        }
        logDataverseAuth(
          `browser sign-in #${pending.number} completed` +
          (result?.account ? `, account ${accountFingerprint(result.account.homeAccountId)}` : ' without an account') +
          (result?.accessToken ? '' : ' without an access token'),
        );
        return result;
      },
      error => {
        logDataverseAuth(`browser sign-in #${pending.number} failed: ${describeAuthError(error)}`);
        throw error;
      },
    ).finally(() => {
      if (current.pending === pending) current.pending = undefined;
    });
    // A sign-in nobody is waiting for any more must not surface as an unhandled rejection.
    pending.result.catch(() => {});
    current.pending = pending;
    signIn = pending;
  }

  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => {
        logDataverseAuth(`gave up waiting for browser sign-in #${signIn.number} after ${INTERACTIVE_TIMEOUT_MS / 60_000} minutes`);
        reject(new Error(`Sign-in was not completed within ${INTERACTIVE_TIMEOUT_MS / 60_000} minutes.`));
      },
      INTERACTIVE_TIMEOUT_MS,
    );
  });
  signIn.waiters++;
  try {
    const result = await Promise.race([signIn.result, timeout]);
    if (!result?.accessToken) throw new Error('Sign-in returned no access token.');
    return result.accessToken;
  } finally {
    signIn.waiters--;
    clearTimeout(timer);
  }
}

/**
 * For the log of a failed silent request: which account was used (a fingerprint), where it came from,
 * whether it belongs to the configured tenant, and whether the token cache still holds it.
 */
async function describeAccountState(
  app: PublicClientApplication,
  account: AccountInfo,
  source: string | undefined,
  tenant: string,
): Promise<string> {
  let inCache: string;
  try {
    const accounts = await app.getTokenCache().getAllAccounts();
    const found = accounts.some(a => a.homeAccountId === account.homeAccountId);
    inCache = `${found ? 'still' : 'no longer'} in the token cache (${accounts.length} account(s))`;
  } catch {
    inCache = 'token cache unreadable';
  }
  return `account ${accountFingerprint(account.homeAccountId)} from ${source ?? 'unknown'}, tenant ${tenantRelation(account, tenant)}, ${inCache}`;
}
