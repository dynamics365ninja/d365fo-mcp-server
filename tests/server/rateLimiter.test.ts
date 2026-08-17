/**
 * Rate-limiter construction-lifecycle tests.
 *
 * apiRateLimiter builds its express-rate-limit instance on the FIRST REQUEST
 * rather than at import time, because this module is evaluated as part of the
 * entry point's import graph — before bootstrapEnv projects .env / config onto
 * process.env — and express-rate-limit freezes windowMs and max at construction.
 * Building eagerly pinned both to their defaults and silently ignored RATE_LIMIT_*.
 *
 * That deferral is only safe because of the `limiter ??=` cache: the instance,
 * and therefore its MemoryStore, is created exactly once and shared by every
 * request. express-rate-limit ships a guard for precisely this mistake
 * (ERR_ERL_CREATED_IN_REQUEST_HANDLER), but we switch it off via
 * validate.creationStack — our construction site is a request handler, yet it
 * runs once, which is not what the check is trying to catch.
 *
 * Muting that guard is what makes these tests load-bearing. If the cache is ever
 * refactored away, every request gets a fresh store, totalHits is always 1, no
 * request is ever limited — and with the validation silenced, nothing says a
 * word. The failure mode is a silently disabled rate limiter, so the invariant
 * the suppression rests on is pinned here instead:
 *
 *   1. configuration set after import is still honoured (why it's built lazily),
 *   2. one store is shared across requests, so the limit is actually enforced
 *      (why the suppression is legitimate),
 *   3. no express-rate-limit validation error reaches the log (that it is in
 *      fact suppressed — the noise this replaced showed up on every startup).
 *
 * Requests are driven through a real express Router with socket-less doubles: no
 * port is bound, but the Layer.handleRequest frame the creationStack check keys
 * off is present, so assertion 3 is not vacuous.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Router } from 'express';
import type { RequestHandler } from 'express';

const TRACKED = ['API_KEY', 'RATE_LIMIT_MAX_REQUESTS', 'RATE_LIMIT_WINDOW_MS'] as const;
let saved: Partial<Record<string, string | undefined>> = {};

beforeEach(() => {
  saved = {};
  for (const key of TRACKED) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  // A fresh module instance per test, so the `limiter` cache — and the request
  // counts inside its store — never leak from one test into the next.
  vi.resetModules();
});

afterEach(() => {
  for (const key of TRACKED) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  vi.restoreAllMocks();
});

/** Minimal express-shaped response double covering what the limiter touches. */
function fakeRes() {
  const headers = new Map<string, string>();
  const captured: { status?: number; body?: unknown } = {};
  const res: Record<string, unknown> = {
    headersSent: false,
    setHeader: (name: string, value: unknown) => { headers.set(name.toLowerCase(), String(value)); },
    getHeader: (name: string) => headers.get(name.toLowerCase()),
    status(code: number) { captured.status = code; return res; },
    json(body: unknown) { captured.body = body; res.headersSent = true; return res; },
  };
  return { res, headers, captured };
}

/**
 * Run one request through the middleware inside a real express Router, and
 * resolve once it either passes the request on or answers it itself.
 */
async function callThroughRouter(handler: RequestHandler, ip = '203.0.113.7') {
  const router = Router();
  router.use(handler);

  const req = { method: 'POST', url: '/', path: '/', ip, socket: { remoteAddress: ip }, headers: {} };
  const { res, headers, captured } = fakeRes();

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = () => { if (!settled) { settled = true; resolve(); } };
    const answer = res.json as (body: unknown) => unknown;
    res.json = (body: unknown) => { const out = answer(body); finish(); return out; };
    (router as unknown as { handle: (...args: unknown[]) => void }).handle(
      req, res, (err?: unknown) => (err ? reject(err) : finish()),
    );
  });

  return {
    status: captured.status,
    limit: headers.get('ratelimit-limit'),
    remaining: headers.get('ratelimit-remaining'),
  };
}

async function importLimiter() {
  const mod = await import('../../src/middleware/rateLimiter.js');
  return mod.apiRateLimiter;
}

describe('apiRateLimiter — construction lifecycle', () => {
  it('honours RATE_LIMIT_* that only reach process.env after the module was imported', async () => {
    // Import first, with nothing configured — the state the module sees when it
    // is evaluated as part of the entry point's import graph.
    const apiRateLimiter = await importLimiter();

    // …then bootstrapEnv projects .env / config/d365fo-mcp.json onto env.
    process.env.RATE_LIMIT_MAX_REQUESTS = '2';
    process.env.RATE_LIMIT_WINDOW_MS = '60000';

    const first = await callThroughRouter(apiRateLimiter);

    // Default is 500. Reading 2 proves the limiter was constructed after the
    // configuration landed, not at import time.
    expect(first.limit).toBe('2');
  });

  it('builds one limiter for the whole process, so the limit is actually enforced', async () => {
    const apiRateLimiter = await importLimiter();
    process.env.RATE_LIMIT_MAX_REQUESTS = '2';
    process.env.RATE_LIMIT_WINDOW_MS = '60000'; // long enough that the window cannot roll mid-test

    const first = await callThroughRouter(apiRateLimiter);
    const second = await callThroughRouter(apiRateLimiter);
    const third = await callThroughRouter(apiRateLimiter);

    // A store rebuilt per request would report remaining=1 forever and never
    // reach 429 — rate limiting silently off. The countdown is the evidence
    // that all three requests hit the same store.
    expect(first.remaining).toBe('1');
    expect(second.remaining).toBe('0');
    expect(third.status).toBe(429);
  });

  it('separates buckets by key, so one caller cannot exhaust another caller', async () => {
    const apiRateLimiter = await importLimiter();
    process.env.RATE_LIMIT_MAX_REQUESTS = '2';
    process.env.RATE_LIMIT_WINDOW_MS = '60000';

    await callThroughRouter(apiRateLimiter, '203.0.113.7');
    await callThroughRouter(apiRateLimiter, '203.0.113.7');
    const otherCaller = await callThroughRouter(apiRateLimiter, '198.51.100.4');

    // Shared store, but not a shared counter: the third request is the first
    // one from its own IP, so it must pass with a full budget behind it.
    expect(otherCaller.status).toBeUndefined();
    expect(otherCaller.remaining).toBe('1');
  });

  it('logs no express-rate-limit validation error when built inside the request handler', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const apiRateLimiter = await importLimiter();

    await callThroughRouter(apiRateLimiter);

    // Without validate.creationStack=false this logs one
    // ERR_ERL_CREATED_IN_REQUEST_HANDLER ValidationError on the first request of
    // every process start — a false alarm, since the limiter is built once.
    const complaints = errors.mock.calls
      .map(args => args.map(String).join(' '))
      .filter(line => line.includes('express-rate-limit'));
    expect(complaints).toEqual([]);
  });
});
