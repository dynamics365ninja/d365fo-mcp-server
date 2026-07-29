/**
 * Authentication tests — regression cover for GHSA / CVE (unauthenticated
 * public MCP endpoint).
 *
 * Two layers are pinned here, and they only make sense together:
 *
 *  1. `apiKeyAuth` intentionally passes through when API_KEY is empty, so
 *     local development over localhost needs no ceremony.
 *  2. `authStartupError` makes that pass-through unreachable in production by
 *     refusing to start the HTTP listener without a key.
 *
 * Delete either one and the endpoint serves indexed X++ source anonymously,
 * which is exactly what was reported. Test both, always.
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

describe('authStartupError — production must not serve unauthenticated', () => {
  beforeEach(() => {
    delete process.env.API_KEY;
    delete process.env.ALLOW_UNAUTHENTICATED;
  });

  it('blocks startup in production with no API_KEY (the reported defect)', async () => {
    const { authStartupError } = await loadWithKey(undefined);
    const err = authStartupError({ NODE_ENV: 'production' });
    expect(err).toBeTruthy();
    expect(err).toContain('Refusing to start');
  });

  it('blocks startup when API_KEY is whitespace only', async () => {
    const { authStartupError } = await loadWithKey(undefined);
    expect(authStartupError({ NODE_ENV: 'production', API_KEY: '   ' })).toBeTruthy();
  });

  it('allows startup once API_KEY is set', async () => {
    const { authStartupError } = await loadWithKey(undefined);
    expect(authStartupError({ NODE_ENV: 'production', API_KEY: 'k'.repeat(32) })).toBeNull();
  });

  it('allows the documented opt-out for upstream-authenticated deployments', async () => {
    const { authStartupError } = await loadWithKey(undefined);
    expect(authStartupError({ NODE_ENV: 'production', ALLOW_UNAUTHENTICATED: 'true' })).toBeNull();
  });

  it('only the exact string "true" opts out — not any truthy value', async () => {
    const { authStartupError } = await loadWithKey(undefined);
    for (const v of ['1', 'yes', 'TRUE', 'true ']) {
      expect(authStartupError({ NODE_ENV: 'production', ALLOW_UNAUTHENTICATED: v }), v).toBeTruthy();
    }
  });

  it('leaves local development alone', async () => {
    const { authStartupError } = await loadWithKey(undefined);
    expect(authStartupError({ NODE_ENV: 'development' })).toBeNull();
    expect(authStartupError({})).toBeNull();
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
