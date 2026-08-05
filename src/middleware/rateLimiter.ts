import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import type { Request, RequestHandler, Response } from 'express';
import { createHash } from 'crypto';

/**
 * Rate limiter configuration for different endpoint types
 */

/**
 * Safely parse an integer environment variable.
 * Returns defaultVal when the value is missing, non-numeric, or outside [min, max].
 */
function parseEnvInt(key: string, defaultVal: number, min: number, max: number): number {
  const raw = process.env[key];
  if (raw === undefined) return defaultVal;
  const parsed = parseInt(raw, 10);
  if (isNaN(parsed) || parsed < min || parsed > max) {
    console.warn(`[rateLimiter] Invalid ${key}="${raw}" (expected ${min}–${max}), using default ${defaultVal}`);
    return defaultVal;
  }
  return parsed;
}

/**
 * Rate-limit key generator. When API_KEY is set, every request shares the same
 * auth header, so that's useless as a per-user key — key by IP instead (pure
 * per-source DoS protection; apiKeyAuth already rejects unauthenticated
 * requests). When API_KEY is unset, the Authorization header carries a
 * per-user token (e.g. GitHub Copilot OAuth) that separates users behind a
 * shared IP; it's SHA-256 hashed (never logged) and still scoped to the
 * client IP since a forged/rotated header could otherwise mint new buckets.
 *
 * Read per request, not snapshotted at import: this module is evaluated as part
 * of the entry point's import graph, which happens before the configuration is
 * projected onto process.env (see src/bootstrapEnv.ts).
 */
function authEnabled(): boolean {
  return !!process.env.API_KEY?.trim();
}

function ipKey(req: Request): string {
  const rawIp = req.ip || req.socket.remoteAddress || 'unknown';
  const ipWithoutPort = rawIp.replace(/:\d+$/, '');
  return ipKeyGenerator(ipWithoutPort);
}

export function generateRateLimitKey(req: Request): string {
  if (authEnabled()) {
    return 'ip:' + ipKey(req);
  }

  const authHeader = req.headers['authorization'];
  if (typeof authHeader === 'string' && authHeader.length > 8) {
    const digest = createHash('sha256').update(authHeader).digest('hex');
    return `ip:${ipKey(req)}|tok:${digest.slice(0, 32)}`;
  }

  return 'ip:' + ipKey(req);
}

/**
 * General API rate limiter. Default 500 requests per 15 minutes per user
 * token (or IP as fallback) — a single chat interaction can consume 10-20
 * requests, so this stays generous. Override via RATE_LIMIT_MAX_REQUESTS.
 *
 * Built on first use rather than at import. express-rate-limit freezes windowMs
 * and max when the limiter is constructed, and this module is evaluated before
 * the configuration reaches process.env, so constructing it eagerly pinned both
 * to their defaults and silently ignored RATE_LIMIT_* from .env / config.
 */
let limiter: RequestHandler | null = null;

function buildLimiter(): RequestHandler {
  return rateLimit({
    windowMs: parseEnvInt('RATE_LIMIT_WINDOW_MS', 900000, 10000, 86400000), // 10s–24h
    max: parseEnvInt('RATE_LIMIT_MAX_REQUESTS', 500, 1, 100000),
    keyGenerator: generateRateLimitKey,
    validate: {
      // We safely use ipKeyGenerator in our custom generateRateLimitKey function
      keyGeneratorIpFallback: false,
    },
    message: {
      error: 'Too many requests for this user or IP, please try again later.',
      retryAfter: 'Please check the Retry-After header.',
    },
    standardHeaders: true, // Return rate limit info in `RateLimit-*` headers
    legacyHeaders: false, // Disable `X-RateLimit-*` headers
    handler: (_req: Request, res: Response) => {
      res.status(429).json({
        error: 'Too many requests',
        message: 'You have exceeded the rate limit. Please try again later.',
        retryAfter: res.getHeader('Retry-After'),
      });
    },
    skip: (req: Request) => {
      // Skip rate limiting for health check endpoint
      return req.path === '/health';
    },
  });
}

/**
 * Express middleware entry point. Delegates to the limiter, constructing it on
 * the first request so it picks up the fully loaded configuration.
 */
export const apiRateLimiter: RequestHandler = (req, res, next) => {
  limiter ??= buildLimiter();
  limiter(req, res, next);
};
