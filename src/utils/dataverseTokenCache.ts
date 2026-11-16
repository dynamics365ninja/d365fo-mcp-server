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
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ICachePlugin, TokenCacheContext } from '@azure/msal-node';

/** Encrypts and decrypts base64 text for the current user. Injectable for tests. */
export interface SecretProtector {
  protect(plainBase64: string): Promise<string>;
  unprotect(protectedBase64: string): Promise<string>;
}

function dpapiScript(operation: 'Protect' | 'Unprotect'): string {
  // Any failure (bad base64, data protected for another user) exits non-zero, so it reaches the caller as an error.
  return "$ErrorActionPreference = 'Stop'; try { Add-Type -AssemblyName System.Security; "
    + '$data = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()); '
    + `[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::${operation}($data, $null, 'CurrentUser')) `
    + '} catch { exit 1 }';
}

/**
 * Windows PowerShell by its full path under %SystemRoot%, so a `powershell.exe` earlier on PATH (or in the
 * working folder) is never the one handed the cache. Falls back to the bare name only without SystemRoot.
 */
export function windowsPowerShellPath(env: NodeJS.ProcessEnv = process.env): string {
  const root = env.SystemRoot?.trim() || env.SYSTEMROOT?.trim() || env.windir?.trim();
  return root ? path.win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : 'powershell.exe';
}

/**
 * Runs a Windows PowerShell script with `input` on stdin (never on the command line) and returns stdout.
 * Each call starts a process, about 0.6 s warm and up to 2 s cold, which is why the plugin below calls it
 * only when the file or the cache has changed.
 */
function runPowerShell(script: string, input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      windowsPowerShellPath(),
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

const RENAME_RETRIES = 5;

/**
 * Writes `text` to `file` atomically: a temporary file next to it, then a rename over it. Another server
 * process reading at the same moment sees the old cache or the new one, never half of one. On Windows the
 * rename fails while another process holds the target open without delete sharing, so it is retried briefly.
 */
async function writeFileAtomic(file: string, text: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    await fs.writeFile(temp, text, 'utf8');
    for (let attempt = 1; ; attempt++) {
      try {
        await fs.rename(temp, file);
        return;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (attempt >= RENAME_RETRIES || !['EPERM', 'EACCES', 'EBUSY'].includes(code ?? '')) throw error;
        await new Promise(resolve => setTimeout(resolve, 20 * attempt));
      }
    }
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

/**
 * An msal cache plugin that keeps the cache in `file`. msal calls it around every cache access, that is on
 * every token request, so it remembers the encrypted text it last read or wrote: before an access it reads
 * the file (a few hundred bytes) and decrypts it only when another process has replaced it since, and after
 * an access it encrypts and writes only when the cache changed (a sign-in or a renewed token). In a steady
 * session that is one decryption at start and one encryption per renewal, not a PowerShell per request.
 *
 * A missing, empty, corrupt or foreign file (another user's, or not ours at all) starts an empty cache: the
 * user then signs in once in the browser, as without the plugin, and the next write replaces the file. A
 * failed write is not an error either: only the next process asks again. Nothing here logs or throws the
 * cache contents.
 */
export function createFileTokenCachePlugin(file: string, protector: SecretProtector = dpapiProtector): ICachePlugin {
  /** The encrypted text the in-memory cache currently matches, read from or written to `file`. */
  let lastSeen: string | undefined;
  return {
    async beforeCacheAccess(context: TokenCacheContext): Promise<void> {
      let stored: string;
      try {
        stored = (await fs.readFile(file, 'utf8')).trim();
      } catch {
        return; // no cache yet: start empty
      }
      if (!stored || stored === lastSeen) return;
      try {
        const plain = await protector.unprotect(stored);
        context.tokenCache.deserialize(Buffer.from(plain, 'base64').toString('utf8'));
      } catch {
        /* corrupt, or not readable for this user: keep what is in memory */
      }
      // Remembered either way, so an unreadable file is tried once, not on every request.
      lastSeen = stored;
    },
    async afterCacheAccess(context: TokenCacheContext): Promise<void> {
      if (!context.cacheHasChanged) return;
      try {
        const plain = Buffer.from(context.tokenCache.serialize(), 'utf8').toString('base64');
        const protectedText = (await protector.protect(plain)).trim();
        if (!protectedText) return;
        await writeFileAtomic(file, protectedText);
        lastSeen = protectedText;
      } catch {
        /* not persisted: the next server process signs in again, as before */
      }
    },
  };
}
