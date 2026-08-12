/**
 * Authentication tests — regression cover for GHSA / CVE (unauthenticated
 * public MCP endpoint).
 *
 * Three layers are pinned here, and they only make sense together:
 *
 *  1. `apiKeyAuth` intentionally passes through when API_KEY is empty, so
 *     local development over localhost needs no ceremony.
 *  2. `resolveBindHost` keeps that pass-through off the network by defaulting
 *     a keyless server to loopback.
 *  3. `authStartupError` refuses to start if an explicit HOST asks for a public
 *     interface anyway.
 *
 * Delete any one of them and the endpoint serves indexed X++ source
 * anonymously, which is exactly what was reported. Test all three, always.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Request, Response, NextFunction } from 'express';

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.resetModules();
});

/**
 * Sets API_KEY for the duration of one case. The middleware reads the variable
 * per request (see the note in apiKeyAuth.ts about bootstrapEnv ordering), so
 * mutating process.env is enough; the module registry is reset anyway to keep
 * each case independent of whatever a previous import cached.
 */
async function loadWithKey(apiKey: string | undefined) {
  vi.resetModules();
  if (apiKey === undefined) delete process.env.API_KEY;
  else process.env.API_KEY = apiKey;
  return import('../../src/middleware/apiKeyAuth');
}

function fakeReq(path: string, headers: Record<string, string> = {}): Request {
  return { path, headers } as unknown as Request;
}

function fakeRes() {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) { res.statusCode = code; return res; },
    json(payload: unknown) { res.body = payload; return res; },
  };
  return res as unknown as Response & { statusCode: number; body: any };
}

describe('resolveBindHost — a keyless server stays off the network', () => {
  beforeEach(() => {
    delete process.env.API_KEY;
    delete process.env.ALLOW_UNAUTHENTICATED;
    delete process.env.HOST;
  });

  it('defaults to loopback when nothing authenticates the listener', async () => {
    const { resolveBindHost } = await loadWithKey(undefined);
    expect(resolveBindHost({})).toBe('127.0.0.1');
  });

  it('defaults to 0.0.0.0 once a key is configured — App Service needs that', async () => {
    const { resolveBindHost } = await loadWithKey(undefined);
    expect(resolveBindHost({ API_KEY: 'k'.repeat(32) })).toBe('0.0.0.0');
    expect(resolveBindHost({ ALLOW_UNAUTHENTICATED: 'true' })).toBe('0.0.0.0');
  });

  it('an explicit HOST always wins — the operator asked for it', async () => {
    const { resolveBindHost } = await loadWithKey(undefined);
    expect(resolveBindHost({ HOST: '10.0.0.5', API_KEY: 'k'.repeat(32) })).toBe('10.0.0.5');
    expect(resolveBindHost({ HOST: '127.0.0.1', API_KEY: 'k'.repeat(32) })).toBe('127.0.0.1');
  });

  it('ignores a blank HOST rather than binding an empty string', async () => {
    const { resolveBindHost } = await loadWithKey(undefined);
    expect(resolveBindHost({ HOST: '   ' })).toBe('127.0.0.1');
  });
});

describe('authStartupError — no unauthenticated listener on a public interface', () => {
  beforeEach(() => {
    delete process.env.API_KEY;
    delete process.env.ALLOW_UNAUTHENTICATED;
    delete process.env.HOST;
  });

  it('blocks a keyless public bind (the reported defect)', async () => {
    const { authStartupError } = await loadWithKey(undefined);
    const err = authStartupError({ HOST: '0.0.0.0' });
    expect(err).toBeTruthy();
    expect(err).toContain('Refusing to start');
  });

  it('does not depend on NODE_ENV — that was the gap this closed', async () => {
    const { authStartupError } = await loadWithKey(undefined);
    // The earlier guard only fired on NODE_ENV=production, so a deployment that
    // never set it (the DevOps pipeline onto a hand-created App Service) bound
    // 0.0.0.0 unauthenticated with the guard staying quiet.
    expect(authStartupError({ HOST: '0.0.0.0' })).toBeTruthy();
    expect(authStartupError({ HOST: '0.0.0.0', NODE_ENV: 'development' })).toBeTruthy();
    // ...and production alone no longer blocks anything: with no key the bind
    // has already fallen back to loopback, which is safe.
    expect(authStartupError({ NODE_ENV: 'production' })).toBeNull();
  });

  it('blocks startup when API_KEY is whitespace only', async () => {
    const { authStartupError } = await loadWithKey(undefined);
    expect(authStartupError({ HOST: '0.0.0.0', API_KEY: '   ' })).toBeTruthy();
  });

  it('allows startup once API_KEY is set', async () => {
    const { authStartupError } = await loadWithKey(undefined);
    expect(authStartupError({ HOST: '0.0.0.0', API_KEY: 'k'.repeat(32) })).toBeNull();
  });

  it('allows the documented opt-out for upstream-authenticated deployments', async () => {
    const { authStartupError } = await loadWithKey(undefined);
    expect(authStartupError({ HOST: '0.0.0.0', ALLOW_UNAUTHENTICATED: 'true' })).toBeNull();
  });

  it('only the exact string "true" opts out — not any truthy value', async () => {
    const { authStartupError } = await loadWithKey(undefined);
    for (const v of ['1', 'yes', 'TRUE', 'true ']) {
      expect(authStartupError({ HOST: '0.0.0.0', ALLOW_UNAUTHENTICATED: v }), v).toBeTruthy();
    }
  });

  it('treats every loopback spelling as safe', async () => {
    const { authStartupError } = await loadWithKey(undefined);
    for (const host of ['127.0.0.1', '127.0.0.53', 'localhost', 'LOCALHOST', '::1', '[::1]', ' 127.0.0.1 ']) {
      expect(authStartupError({ HOST: host }), host).toBeNull();
    }
  });

  it('treats anything else as reachable, including IPv6 any and a LAN address', async () => {
    const { authStartupError } = await loadWithKey(undefined);
    for (const host of ['0.0.0.0', '::', '[::]', '10.0.0.5', '192.168.1.20', 'mcp.internal', '128.0.0.1']) {
      expect(authStartupError({ HOST: host }), host).toBeTruthy();
    }
  });

  it('names the offending address and every way out', async () => {
    const { authStartupError } = await loadWithKey(undefined);
    const err = authStartupError({ HOST: '0.0.0.0' })!;
    expect(err).toContain('0.0.0.0');
    expect(err).toContain('API_KEY');
    expect(err).toContain('HOST=127.0.0.1');
    expect(err).toContain('ALLOW_UNAUTHENTICATED=true');
  });

  it('leaves the default local development server alone', async () => {
    const { authStartupError } = await loadWithKey(undefined);
    expect(authStartupError({})).toBeNull();
    expect(authStartupError({ NODE_ENV: 'development' })).toBeNull();
  });
});

describe('apiKeyAuth — request enforcement', () => {
  const KEY = 'a'.repeat(32);

  it('rejects an unauthenticated /mcp call with 401', async () => {
    const { apiKeyAuth } = await loadWithKey(KEY);
    const res = fakeRes();
    const next = vi.fn();
    apiKeyAuth(fakeReq('/mcp'), res, next as unknown as NextFunction);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });

  it('rejects a wrong key of identical length (timing-safe path)', async () => {
    const { apiKeyAuth } = await loadWithKey(KEY);
    const res = fakeRes();
    const next = vi.fn();
    apiKeyAuth(fakeReq('/mcp', { 'x-api-key': 'b'.repeat(32) }), res, next as unknown as NextFunction);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });

  it('rejects a wrong key of different length without throwing', async () => {
    const { apiKeyAuth } = await loadWithKey(KEY);
    const res = fakeRes();
    const next = vi.fn();
    expect(() =>
      apiKeyAuth(fakeReq('/mcp', { 'x-api-key': 'short' }), res, next as unknown as NextFunction),
    ).not.toThrow();
    expect(res.statusCode).toBe(401);
  });

  it('accepts the key via X-Api-Key and via Authorization: Bearer', async () => {
    const { apiKeyAuth } = await loadWithKey(KEY);

    for (const headers of [{ 'x-api-key': KEY }, { authorization: `Bearer ${KEY}` }]) {
      const next = vi.fn();
      apiKeyAuth(fakeReq('/mcp', headers), fakeRes(), next as unknown as NextFunction);
      expect(next, JSON.stringify(headers)).toHaveBeenCalledOnce();
    }
  });

  it('keeps /health and / reachable for Azure probes', async () => {
    const { apiKeyAuth } = await loadWithKey(KEY);

    for (const path of ['/health', '/']) {
      const next = vi.fn();
      apiKeyAuth(fakeReq(path), fakeRes(), next as unknown as NextFunction);
      expect(next, path).toHaveBeenCalledOnce();
    }
  });

  it('passes through when no key is configured (guarded by authStartupError)', async () => {
    const { apiKeyAuth } = await loadWithKey(undefined);
    const next = vi.fn();
    apiKeyAuth(fakeReq('/mcp'), fakeRes(), next as unknown as NextFunction);
    expect(next).toHaveBeenCalledOnce();
  });
});
