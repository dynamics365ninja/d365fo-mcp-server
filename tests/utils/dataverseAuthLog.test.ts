import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  accountFingerprint,
  describeAuthError,
  msalLoggerOptions,
  redactForLog,
} from '../../src/utils/dataverseAuthLog';

describe('describeAuthError', () => {
  it('names an msal error by its fields, drops the code msal puts in front, and adds the ids support asks for', () => {
    const msal = Object.assign(
      new Error('invalid_grant: AADSTS50173: The grant has expired.\r\nTrace ID: t\r\nCorrelation ID: c\r\nTimestamp: x'),
      {
        name: 'InteractionRequiredAuthError', errorCode: 'invalid_grant', subError: 'bad_token', errorNo: '50173',
        status: 400, claims: '{"access_token":{}}', correlationId: 'c-1', traceId: 't-1',
      },
    );
    expect(describeAuthError(msal)).toBe(
      '[InteractionRequiredAuthError, invalid_grant, bad_token, AADSTS50173, HTTP 400, claims challenge] ' +
        'AADSTS50173: The grant has expired. (correlation id c-1, trace id t-1)',
    );
  });

  it('gives only the code and system call of a file error, whose message holds the path', () => {
    const error = Object.assign(new Error("EPERM: operation not permitted, rename 'C:\\Users\\someone\\x.tmp'"), {
      code: 'EPERM', syscall: 'rename',
    });
    expect(describeAuthError(error)).toBe('[EPERM] rename failed');
  });

  it('handles plain values and objects that cannot be turned into text', () => {
    expect(describeAuthError('plain text')).toBe('plain text');
    expect(describeAuthError(Object.create(null))).toBe('unknown error');
    expect(describeAuthError({ toString() { throw new Error('no'); } })).toBe('unknown error');
    expect(describeAuthError(undefined)).toBe('undefined');
  });

  it('hides email addresses in the message', () => {
    const error = Object.assign(new Error('AADSTS50020: User account dev@contoso.com does not exist in tenant.'), {
      name: 'ServerError', errorCode: 'access_denied',
    });
    expect(describeAuthError(error)).toBe('[ServerError, access_denied] AADSTS50020: User account <email> does not exist in tenant.');
  });
});

describe('redactForLog', () => {
  const saved = process.env.LOCALAPPDATA;
  afterEach(() => {
    process.env.LOCALAPPDATA = saved;
  });

  it('replaces the profile folders, whichever slash and case', () => {
    process.env.LOCALAPPDATA = 'C:\\Users\\someone\\AppData\\Local';
    expect(redactForLog('at c:/users/someone/appdata/local/d365fo-mcp/cache.bin')).toBe('at <profile>/d365fo-mcp/cache.bin');
    expect(redactForLog('at C:\\Users\\someone\\AppData\\Local\\x')).toBe('at <profile>\\x');
  });
});

describe('accountFingerprint', () => {
  it('is short, stable and not the id itself', () => {
    const id = 'uid.tid';
    expect(accountFingerprint(id)).toMatch(/^[0-9a-f]{8}$/);
    expect(accountFingerprint(id)).toBe(accountFingerprint(id));
    expect(accountFingerprint('other.tid')).not.toBe(accountFingerprint(id));
    expect(accountFingerprint(undefined)).toBe('none');
  });
});

describe('msalLoggerOptions', () => {
  it('passes msal warnings to the log and drops lines msal marks as containing personal data', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(msalLoggerOptions.piiLoggingEnabled).toBe(false);
      msalLoggerOptions.loggerCallback?.(1, 'Account used to refresh tokens not in persistence', false);
      msalLoggerOptions.loggerCallback?.(1, 'user dev@contoso.com', true);
      expect(log.mock.calls.map(c => String(c[0]))).toEqual([
        expect.stringMatching(/^\[dataverse-auth\] \S+ pid=\d+ msal: Account used to refresh tokens not in persistence$/),
      ]);
    } finally {
      log.mockRestore();
    }
  });
});
