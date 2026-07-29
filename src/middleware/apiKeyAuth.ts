import type { Request, Response, NextFunction } from 'express';
import { timingSafeEqual } from 'node:crypto';

/**
 * API Key authentication middleware for HTTP mode.
 *
 * When the `API_KEY` environment variable is set, every request (except
 * unauthenticated paths like `/health`) must include a matching key in
 * one of these locations (checked in order):
 *
 *   1. `X-Api-Key` header          — preferred for MCP clients
 *   2. `Authorization: Bearer <key>` header — works with tools that only support Bearer
 *
 * If `API_KEY` is NOT set, the middleware is a pass-through (no-op) so local
 * development over stdio/localhost keeps working without ceremony. That
 * pass-through is safe only because `authStartupError()` refuses to bind the
 * HTTP listener in production without either a key or an explicit opt-out —
 * see that function for why the two must be read together.
 *
 * Timing-safe comparison is used to prevent timing side-channel attacks.
 *
 * The key is read per request rather than snapshotted at module load. ESM
 * evaluates this module as part of the entry point's import graph, which under
 * the old ordering happened before the configuration was loaded onto
 * process.env — so a key set in .env or config/secrets.json read as "no key
 * configured" and authentication silently disabled itself. src/bootstrapEnv.ts
 * fixes that ordering; reading late means this file no longer depends on it.
 */

function configuredApiKey(): string | undefined {
  const key = process.env.API_KEY?.trim();
  return key ? key : undefined;
}

/** Paths that never require authentication */
const PUBLIC_PATHS = new Set(['/', '/health']);

/**
 * Constant-time string comparison.
 * Returns false immediately only when lengths differ (which is already
 * observable via response time in any string comparison).
 */
function safeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

function extractApiKey(req: Request): string | null {
  // 1. X-Api-Key header (preferred)
  const xApiKey = req.headers['x-api-key'];
  if (typeof xApiKey === 'string' && xApiKey.length > 0) {
    return xApiKey;
  }

  // 2. Authorization: Bearer <key>
  const authHeader = req.headers['authorization'];
  if (typeof authHeader === 'string' && authHeader.toLowerCase().startsWith('bearer ')) {
    const token = authHeader.slice(7).trim();
    if (token.length > 0) return token;
  }

  return null;
}

/**
 * Startup guard for HTTP mode: production must not serve unauthenticated.
 *
 * `apiKeyAuth` degrades to a pass-through when `API_KEY` is empty, and the
 * server binds `0.0.0.0` by default, so an App Service deployed without a key
 * exposes every read tool — including the `source_snippet` fields that carry
 * the customer's own X++ — to anonymous callers. Rather than fail open, refuse
 * to start.
 *
 * Deliberately scoped to `NODE_ENV=production` so local development and tests
 * are unaffected. `ALLOW_UNAUTHENTICATED=true` is the documented opt-out for
 * deployments that terminate authentication upstream (App Service Easy Auth,
 * a Private Endpoint, or an authenticating reverse proxy) and genuinely do not
 * need a key of their own.
 *
 * Returns the operator-facing error message, or null when startup may proceed.
 */
export function authStartupError(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.NODE_ENV !== 'production') return null;
  if (env.ALLOW_UNAUTHENTICATED === 'true') return null;
  if (env.API_KEY?.trim()) return null;

  return [
    'Refusing to start: HTTP mode in production with no API_KEY.',
    '',
    'Without a key every request is served unauthenticated, and this server',
    'binds 0.0.0.0 — anyone who reaches the URL can read your indexed X++',
    'source, security roles, and labels.',
    '',
    'Fix (either one):',
    '  • Set API_KEY to a strong random value:  openssl rand -hex 32',
    '  • Set ALLOW_UNAUTHENTICATED=true if authentication is already enforced',
    '    upstream (Easy Auth, Private Endpoint, authenticating proxy).',
  ].join('\n');
}

/**
 * Express middleware that enforces API key authentication.
 * Mount BEFORE any route handlers.
 */
export function apiKeyAuth(req: Request, res: Response, next: NextFunction): void {
  const apiKey = configuredApiKey();

  // No API_KEY configured → auth disabled, pass through
  if (!apiKey) {
    next();
    return;
  }

  // Public endpoints are always accessible (Azure health probes, etc.)
  if (PUBLIC_PATHS.has(req.path)) {
    next();
    return;
  }

  const provided = extractApiKey(req);

  if (!provided || !safeCompare(provided, apiKey)) {
    res.status(401).json({
      error: 'Unauthorized',
      message: 'Missing or invalid API key. Provide it via X-Api-Key header or Authorization: Bearer <key>.',
    });
    return;
  }

  next();
}
