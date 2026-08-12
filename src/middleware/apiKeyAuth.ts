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
 * pass-through is safe only because a keyless server never reaches the network:
 * `resolveBindHost()` defaults it to loopback, and `authStartupError()` refuses
 * to start if the operator explicitly binds a public interface anyway. See
 * those two functions for why all three must be read together.
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
 * Is authentication accounted for — either by a key of our own, or by the
 * operator stating that something upstream does it?
 */
function authIsConfigured(env: NodeJS.ProcessEnv): boolean {
  return !!env.API_KEY?.trim() || env.ALLOW_UNAUTHENTICATED === 'true';
}

/**
 * A listener on one of these is reachable only from the machine itself, so an
 * unauthenticated one discloses nothing that local filesystem access does not
 * already give away.
 */
function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  if (h === 'localhost' || h === '::1') return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

/**
 * The address the HTTP transport binds to.
 *
 * An explicit HOST always wins — the operator asked for it. With none set the
 * default depends on whether authentication is accounted for, because the same
 * default cannot be right for both callers: a container or App Service has to
 * bind `0.0.0.0` to be reachable at all, while a developer running
 * `npm start` on a laptop wants the network left alone. Keying the default off
 * the key rather than off NODE_ENV means the safe choice needs no ceremony and
 * the exposed choice is the one that had to be asked for.
 */
export function resolveBindHost(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.HOST?.trim();
  if (explicit) return explicit;
  return authIsConfigured(env) ? '0.0.0.0' : '127.0.0.1';
}

/**
 * Startup guard for HTTP mode: never serve a network-reachable listener
 * without authentication.
 *
 * `apiKeyAuth` degrades to a pass-through when `API_KEY` is empty, so a
 * listener on a non-loopback address without a key exposes every read tool —
 * including the `source_snippet` fields that carry the customer's own X++ — to
 * anonymous callers. Rather than fail open, refuse to start.
 *
 * The condition is what the socket actually does, not what NODE_ENV claims.
 * The earlier NODE_ENV=production form depended on the operator having set a
 * variable that nothing enforces: the Bicep template sets it, but
 * `.azure-pipelines/d365fo-mcp-app-deploy.yml` deploying onto a hand-created
 * App Service does not, and that deployment was exactly as exposed while the
 * guard stayed quiet. Binding a public interface is the thing that carries the
 * risk, so it is the thing that gates.
 *
 * `ALLOW_UNAUTHENTICATED=true` is the documented opt-out for deployments that
 * terminate authentication upstream (App Service Easy Auth, a Private
 * Endpoint, or an authenticating reverse proxy) and genuinely do not need a
 * key of their own.
 *
 * Returns the operator-facing error message, or null when startup may proceed.
 */
export function authStartupError(env: NodeJS.ProcessEnv = process.env): string | null {
  if (authIsConfigured(env)) return null;

  const host = resolveBindHost(env);
  if (isLoopbackHost(host)) return null;

  return [
    `Refusing to start: HTTP mode binding ${host} with no API_KEY.`,
    '',
    'Without a key every request is served unauthenticated, so anyone who',
    'reaches this address can read your indexed X++ source, security roles,',
    'and labels.',
    '',
    'Fix (any one):',
    '  • Set API_KEY to a strong random value:  openssl rand -hex 32',
    '  • Set HOST=127.0.0.1 to keep the server off the network.',
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
