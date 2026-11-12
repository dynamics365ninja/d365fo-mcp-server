/**
 * A token cache on disk for the Dataverse sign-in (see dataverseAuth.ts), so a new server process
 * renews silently from the stored refresh token instead of opening the browser again.
 *
 * Needed by every client that starts a new server per session, and above all by an unattended agent:
 * it runs with nobody at the screen, so a browser sign-in in each new process can never complete.
 *
 * The cache is encrypted for the current Windows user with DPAPI, the protection `az` and `pac` use
 * for their caches, through Windows PowerShell's ProtectedData (present on every Windows and every
 * UDE), so the server needs no native add-on. Another user on the machine cannot read it. Off
 * Windows nothing is persisted and the in-memory behaviour stays as it was.
 *
 * D365FO_DATAVERSE_TOKEN_CACHE sets the file, or turns persistence off with `off`. Default:
 * %LOCALAPPDATA%\d365fo-mcp\dataverse-token-cache.bin. The tokens are never logged.
 */
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ICachePlugin, TokenCacheContext } from '@azure/msal-node';

/** Encrypts and decrypts base64 text for the current user. Injectable for tests. */
export interface SecretProtector {
  protect(plainBase64: string): Promise<string>;
  unprotect(protectedBase64: string): Promise<string>;
}

function dpapiScript(operation: 'Protect' | 'Unprotect'): string {
  return 'Add-Type -AssemblyName System.Security; '
    + '$data = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()); '
    + `[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::${operation}($data, $null, 'CurrentUser'))`;
}

/** Runs a Windows PowerShell script with `input` on stdin (never on the command line) and returns stdout. */
function runPowerShell(script: string, input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout) => (error ? reject(new Error('DPAPI call failed')) : resolve(String(stdout).trim())),
    );
    child.stdin?.end(input);
  });
}

export const dpapiProtector: SecretProtector = {
  protect: plain => runPowerShell(dpapiScript('Protect'), plain),
  unprotect: protectedText => runPowerShell(dpapiScript('Unprotect'), protectedText),
};

/** The cache file, or undefined when nothing is to be persisted. */
export function dataverseTokenCachePath(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (platform !== 'win32') return undefined;
  const setting = env.D365FO_DATAVERSE_TOKEN_CACHE?.trim();
  if (setting && /^(off|false|0|none|no)$/i.test(setting)) return undefined;
  if (setting) return setting;
  const localAppData = env.LOCALAPPDATA?.trim();
  return localAppData ? path.join(localAppData, 'd365fo-mcp', 'dataverse-token-cache.bin') : undefined;
}

/**
 * An msal cache plugin that loads the cache from `file` before each access and writes it back when it
 * changed. A missing, foreign or unreadable file starts an empty cache: the user then signs in once in
 * the browser, as without the plugin. A failed write is not an error either: only the next process asks again.
 */
export function createFileTokenCachePlugin(file: string, protector: SecretProtector = dpapiProtector): ICachePlugin {
  return {
    async beforeCacheAccess(context: TokenCacheContext): Promise<void> {
      try {
        const stored = (await fs.readFile(file, 'utf8')).trim();
        if (!stored) return;
        const plain = await protector.unprotect(stored);
        context.tokenCache.deserialize(Buffer.from(plain, 'base64').toString('utf8'));
      } catch {
        /* no cache yet, or not readable for this user: start empty */
      }
    },
    async afterCacheAccess(context: TokenCacheContext): Promise<void> {
      if (!context.cacheHasChanged) return;
      try {
        const plain = Buffer.from(context.tokenCache.serialize(), 'utf8').toString('base64');
        const protectedText = await protector.protect(plain);
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, protectedText, 'utf8');
      } catch {
        /* not persisted: the next server process signs in again, as before */
      }
    },
  };
}
