/**
 * Diagnostic log of the Dataverse sign-in (dataverseAuth.ts) and its token cache (dataverseTokenCache.ts).
 *
 * Lines go to stderr, which the server mirrors to LOG_FILE, prefixed with the time and the process id:
 * several server processes (one per editor or agent session) can share one LOG_FILE and one token cache
 * file, and each numbers its own browser sign-ins. Nothing here may log a token, the cache contents, an
 * account name, an email address or a path under the user's profile.
 */
import { createHash } from 'node:crypto';
import os from 'node:os';
import { type Configuration, LogLevel } from '@azure/msal-node';

/** msal-node doesn't export its LoggerOptions type; this is the same one, from the configuration. */
type LoggerOptions = NonNullable<NonNullable<Configuration['system']>['loggerOptions']>;

/** Lines logged by this process so far; lets a caller tell whether anything happened since it last looked. */
let linesLogged = 0;

/** Writes one diagnostic line about the Dataverse sign-in to stderr. Pass counts, states and codes only. */
export function logDataverseAuth(line: string): void {
  linesLogged++;
  console.error(`[dataverse-auth] ${new Date().toISOString()} pid=${process.pid} ${line}`);
}

/** How many lines this process has logged; compare two readings to see whether anything was logged between. */
export function dataverseAuthLogCount(): number {
  return linesLogged;
}

/** Folders whose names would reveal the Windows user in a logged message, longest first. */
function profilePaths(): string[] {
  // LOCALAPPDATA can be moved off the profile; everything else of the user's is under USERPROFILE.
  const candidates = [process.env.LOCALAPPDATA, process.env.USERPROFILE, safeHomedir()];
  return [...new Set(candidates.filter((p): p is string => typeof p === 'string' && p.trim().length > 3))]
    .sort((a, b) => b.length - a.length);
}

function safeHomedir(): string | undefined {
  try {
    return os.homedir();
  } catch {
    return undefined;
  }
}

/** Replaces profile paths and email-like text, which an AADSTS message or a file error may contain. */
export function redactForLog(text: string): string {
  let result = text;
  for (const folder of profilePaths()) {
    // Case-insensitive, either slash: Windows paths come in both forms.
    const pattern = folder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\\/g, '[\\\\/]');
    result = result.replace(new RegExp(pattern, 'gi'), '<profile>');
  }
  return result.replace(/[^\s'"<>()[\]]+@[^\s'"<>()[\]]+\.[^\s'"<>()[\]]+/g, '<email>');
}

/**
 * An error from msal, DPAPI or the file system in one line, without personal data.
 *
 * - msal: its name, error code, sub-error and AADSTS number, the HTTP status, whether it is a Conditional
 *   Access claims challenge, the first line of its message (without the error code msal puts in front),
 *   and the correlation and trace ids, which are on later lines of the message and are what support asks for.
 * - File system: the code and the system call only; Node puts the full path in the message.
 */
export function describeAuthError(error: unknown): string {
  try {
    const e = (typeof error === 'object' && error !== null ? error : {}) as Record<string, unknown>;
    const str = (key: string) => (typeof e[key] === 'string' && (e[key] as string).length > 0 ? e[key] as string : undefined);
    if (str('code') && str('syscall')) return `[${str('code')}] ${str('syscall')} failed`;

    const errorCode = str('errorCode');
    const tags = [str('name'), errorCode, str('subError'), str('code')];
    const errorNo = e.errorNo ?? undefined;
    if (errorNo !== undefined && errorNo !== '') tags.push(`AADSTS${String(errorNo).replace(/^AADSTS/i, '')}`);
    if (typeof e.status === 'number' || str('status')) tags.push(`HTTP ${String(e.status)}`);
    if (str('claims')) tags.push('claims challenge');
    const uniqueTags = [...new Set(tags.filter((t): t is string => t !== undefined))];

    const message = typeof error === 'object' && error !== null ? str('message') ?? '' : String(error);
    let firstLine = message.split(/\r?\n/)[0].trim();
    if (errorCode && firstLine.toLowerCase().startsWith(`${errorCode.toLowerCase()}:`)) {
      firstLine = firstLine.slice(errorCode.length + 1).trim();
    }
    const ids = [
      str('correlationId') ? `correlation id ${str('correlationId')}` : undefined,
      str('traceId') ? `trace id ${str('traceId')}` : undefined,
    ].filter(Boolean);

    const text = `${uniqueTags.length > 0 ? `[${uniqueTags.join(', ')}] ` : ''}${redactForLog(firstLine).slice(0, 400)}` +
      (ids.length > 0 ? ` (${ids.join(', ')})` : '');
    return text.trim() || 'unknown error';
  } catch {
    return 'unknown error';
  }
}

/** A short, stable fingerprint of an account id: shows whether two log lines name the same account, not which. */
export function accountFingerprint(homeAccountId: string | undefined): string {
  if (!homeAccountId) return 'none';
  return createHash('sha256').update(homeAccountId).digest('hex').slice(0, 8);
}

/**
 * msal's own warnings and errors, e.g. "refreshed tokens will not be stored in the cache", which no error
 * reaches us for. With PII logging off, msal leaves personal data out; lines it marks as PII are dropped anyway.
 */
export const msalLoggerOptions: LoggerOptions = {
  piiLoggingEnabled: false,
  logLevel: LogLevel.Warning,
  loggerCallback: (_level: LogLevel, message: string, containsPii: boolean) => {
    if (containsPii) return;
    logDataverseAuth(`msal: ${redactForLog(String(message)).slice(0, 500)}`);
  },
};
