/**
 * Configuration-timing regression tests.
 *
 * ESM evaluates every `import` declaration before the first statement of the
 * importing module's body. Entry points were written as
 *
 *     import { loadEnv } from './utils/loadEnv.js';
 *     loadEnv(import.meta.url);          // <- looks first, runs last
 *     import { apiKeyAuth } from './middleware/apiKeyAuth.js';
 *
 * which reads as "configuration is loaded before anything else" but is not:
 * every imported module — including the ones that snapshot `process.env` into a
 * module-level const — was already fully evaluated by the time loadEnv() ran.
 *
 * The consequence for apiKeyAuth was a silent auth bypass: an API_KEY supplied
 * through .env / config/secrets.json (as `npm run setup` writes it) was invisible
 * to the middleware, so it treated authentication as disabled and passed every
 * request through.
 *
 * Two guards, both needed:
 *  1. Modules on the security path resolve their settings per request, so they
 *     cannot be defeated by import ordering at all.
 *  2. Entry points import the env bootstrap first, so modules that legitimately
 *     snapshot configuration at load time see the real values.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const REPO_ROOT = resolve(__dirname, '../..');

const TRACKED = ['API_KEY', 'RATE_LIMIT_MAX_REQUESTS', 'RATE_LIMIT_WINDOW_MS'] as const;
let saved: Partial<Record<string, string | undefined>> = {};

beforeEach(() => {
  saved = {};
  for (const key of TRACKED) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  vi.resetModules();
});

afterEach(() => {
  for (const key of TRACKED) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

/** Minimal Express-shaped request/response doubles. */
function fakeReq(path: string, headers: Record<string, string> = {}) {
  return { path, headers } as any;
}

function fakeRes() {
  const captured: { status?: number; body?: unknown } = {};
  const res = {
    status(code: number) {
      captured.status = code;
      return { json: (body: unknown) => { captured.body = body; } };
    },
  } as any;
  return { res, captured };
}

describe('apiKeyAuth — configuration resolved per request, not at import time', () => {
  it('enforces an API_KEY that appears in process.env after the module was imported', async () => {
    // Import first, with no API_KEY set — this is exactly the state the module
    // sees when it is evaluated as part of the entry point's import graph.
    const { apiKeyAuth } = await import('../../src/middleware/apiKeyAuth.js');

    // …then loadEnv() runs and projects .env / config/secrets.json onto env.
    process.env.API_KEY = 'supersecret123';

    const { res, captured } = fakeRes();
    let nexted = false;
    apiKeyAuth(fakeReq('/mcp'), res, () => { nexted = true; });

    expect(nexted).toBe(false);
    expect(captured.status).toBe(401);
  });

  it('accepts the matching key via X-Api-Key and Authorization: Bearer', async () => {
    const { apiKeyAuth } = await import('../../src/middleware/apiKeyAuth.js');
    process.env.API_KEY = 'supersecret123';

    for (const headers of [
      { 'x-api-key': 'supersecret123' },
      { authorization: 'Bearer supersecret123' },
    ]) {
      const { res, captured } = fakeRes();
      let nexted = false;
      apiKeyAuth(fakeReq('/mcp', headers), res, () => { nexted = true; });
      expect(nexted).toBe(true);
      expect(captured.status).toBeUndefined();
    }
  });

  it('rejects a wrong key of a different length without throwing', async () => {
    const { apiKeyAuth } = await import('../../src/middleware/apiKeyAuth.js');
    process.env.API_KEY = 'supersecret123';

    const { res, captured } = fakeRes();
    let nexted = false;
    apiKeyAuth(fakeReq('/mcp', { 'x-api-key': 'short' }), res, () => { nexted = true; });

    expect(nexted).toBe(false);
    expect(captured.status).toBe(401);
  });

  it('stays a pass-through when no API_KEY is configured at all', async () => {
    const { apiKeyAuth } = await import('../../src/middleware/apiKeyAuth.js');

    const { res, captured } = fakeRes();
    let nexted = false;
    apiKeyAuth(fakeReq('/mcp'), res, () => { nexted = true; });

    expect(nexted).toBe(true);
    expect(captured.status).toBeUndefined();
  });

  it('keeps /health reachable without a key so platform probes still work', async () => {
    const { apiKeyAuth } = await import('../../src/middleware/apiKeyAuth.js');
    process.env.API_KEY = 'supersecret123';

    const { res, captured } = fakeRes();
    let nexted = false;
    apiKeyAuth(fakeReq('/health'), res, () => { nexted = true; });

    expect(nexted).toBe(true);
    expect(captured.status).toBeUndefined();
  });
});

describe('rate limiter — key strategy follows the live API_KEY setting', () => {
  it('switches to pure IP keying when API_KEY is set after import', async () => {
    const mod = await import('../../src/middleware/rateLimiter.js');
    process.env.API_KEY = 'supersecret123';

    const req = {
      ip: '203.0.113.9',
      socket: { remoteAddress: '203.0.113.9' },
      headers: { authorization: 'Bearer a-user-token-value' },
    } as any;

    // With auth on, the per-user token must not widen the bucket space:
    // every authenticated caller from one IP shares one bucket.
    expect(mod.generateRateLimitKey(req)).not.toContain('tok:');
  });

  it('separates users behind a shared IP by token when API_KEY is unset', async () => {
    const mod = await import('../../src/middleware/rateLimiter.js');

    const base = { ip: '203.0.113.9', socket: { remoteAddress: '203.0.113.9' } };
    const a = mod.generateRateLimitKey({ ...base, headers: { authorization: 'Bearer token-aaaa' } } as any);
    const b = mod.generateRateLimitKey({ ...base, headers: { authorization: 'Bearer token-bbbb' } } as any);

    expect(a).toContain('tok:');
    expect(a).not.toBe(b);
    // The raw token must never leak into the key (keys reach logs and stores).
    expect(a).not.toContain('token-aaaa');
  });
});

describe('entry points load configuration before their other imports', () => {
  const ENTRY_POINTS = [
    'src/index.ts',
    'scripts/build-database.ts',
    'scripts/build-fts.ts',
    'scripts/extract-metadata.ts',
    'scripts/azure-blob-manager.ts',
    'scripts/purge-property-stats.ts',
  ];

  for (const entry of ENTRY_POINTS) {
    it(`${entry} imports the env bootstrap as its first import`, () => {
      const source = readFileSync(resolve(REPO_ROOT, entry), 'utf8');
      const firstImport = source
        .split('\n')
        .map(l => l.trim())
        .find(l => l.startsWith('import ') || l.startsWith('import('));

      expect(firstImport, `${entry} has no imports at all`).toBeDefined();
      expect(firstImport, `${entry} must import bootstrapEnv first — any import placed above it is evaluated before configuration is loaded`)
        .toMatch(/bootstrapEnv\.js'/);
    });

    it(`${entry} does not call loadEnv() from its module body`, () => {
      const source = readFileSync(resolve(REPO_ROOT, entry), 'utf8');
      // A body-level loadEnv() call is the pattern this whole file exists to
      // prevent: it runs after every import has already been evaluated.
      const bodyCall = source
        .split('\n')
        .some(l => /^\s*loadEnv\(/.test(l));
      expect(bodyCall, `${entry} still calls loadEnv() from its body; import bootstrapEnv instead`).toBe(false);
    });
  }
});
