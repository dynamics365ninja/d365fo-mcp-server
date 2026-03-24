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
 * If `API_KEY` is NOT set, the middleware is a pass-through (no-op) so
 * existing deployments keep working without changes.
 *
 * Timing-safe comparison is used to prevent timing side-channel attacks.
 */

const API_KEY = process.env.API_KEY?.trim();

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
 * Express middleware that enforces API key authentication.
 * Mount BEFORE any route handlers.
 */
export function apiKeyAuth(req: Request, res: Response, next: NextFunction): void {
  // No API_KEY configured → auth disabled, pass through
  if (!API_KEY) {
    next();
    return;
  }

  // Public endpoints are always accessible (Azure health probes, etc.)
  if (PUBLIC_PATHS.has(req.path)) {
    next();
    return;
  }

  const provided = extractApiKey(req);

  if (!provided || !safeCompare(provided, API_KEY)) {
    res.status(401).json({
      error: 'Unauthorized',
      message: 'Missing or invalid API key. Provide it via X-Api-Key header or Authorization: Bearer <key>.',
    });
    return;
  }

  next();
}
