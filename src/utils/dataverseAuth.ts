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
 * caller's transcript.
 *
 * On Windows the token cache is also kept in a file encrypted for the current user (DPAPI, as
 * az CLI and `pac` do, see dataverseTokenCache.ts), so a new server process renews silently from
 * the stored refresh token and the browser opens only for the very first sign-in, or when the
 * refresh token has expired. This is what lets an unattended agent run tests: it has nobody to
 * complete a browser page. D365FO_DATAVERSE_TOKEN_CACHE=off keeps the cache in memory only.
 */
import { spawn } from 'node:child_process';
import { type AccountInfo, type AuthenticationResult, PublicClientApplication } from '@azure/msal-node';
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
}

/**
 * One cached client per (tenant, client id): its in-memory token cache is what makes the
 * second call in a process silent. `pending` is the sign-in in progress, shared by every caller:
 * msal's loopback listener has no timeout of its own and stays open until the sign-in settles,
 * so starting a second one would open a second tab and leave a second listener behind.
 */
const clients = new Map<string, { app: PublicClientApplication; account?: AccountInfo; pending?: PendingSignIn }>();

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
  options: { forceRefresh?: boolean } = {},
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
        ...(settings.tokenCachePath
          ? { cache: { cachePlugin: createFileTokenCachePlugin(settings.tokenCachePath) } }
          : {}),
      }),
    };
    clients.set(key, entry);
    if (settings.tokenCachePath) {
      // A new process starts with the account a previous one stored, so the silent path below can renew it.
      try {
        const accounts = await entry.app.getTokenCache().getAllAccounts();
        entry.account = accounts[0];
      } catch {
        /* unreadable cache: sign in as without it */
      }
    }
  }
  const scopes = [`${settings.url}/.default`];

  if (entry.account) {
    try {
      const silent = await entry.app.acquireTokenSilent({
        account: entry.account,
        scopes,
        ...(options.forceRefresh ? { forceRefresh: true } : {}),
      });
      if (silent?.accessToken) return silent.accessToken;
    } catch {
      /* expired refresh token, or a scope for a different environment: sign in again */
    }
  }

  if (entry.pending) {
    // A sign-in from an earlier call has not finished. While another call is waiting on it, its
    // tab is open: just wait too. When the call that started it gave up, show its page again
    // rather than start a second sign-in; a tab the user closed is thereby replaced, and the
    // same listener receives the answer.
    if (entry.pending.waiters === 0 && entry.pending.url) await openBrowser(entry.pending.url).catch(() => {});
  } else {
    const current = entry;
    const pending: PendingSignIn = { waiters: 0 } as PendingSignIn;
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
        if (result?.account) current.account = result.account;
        return result;
      },
    ).finally(() => {
      if (current.pending === pending) current.pending = undefined;
    });
    // A sign-in nobody is waiting for any more must not surface as an unhandled rejection.
    pending.result.catch(() => {});
    current.pending = pending;
  }

  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Sign-in was not completed within ${INTERACTIVE_TIMEOUT_MS / 60_000} minutes.`)),
      INTERACTIVE_TIMEOUT_MS,
    );
  });
  const signIn = entry.pending!;
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
