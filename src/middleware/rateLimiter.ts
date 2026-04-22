import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import type { Request, Response } from 'express';
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
 * Rate-limit key generator: prefer Bearer token identity over IP address.
 *
 * Why: Behind corporate VPN / NAT all developers share a single egress IP.
 * Using the IP as the key means 10 devs share the same bucket and each gets
 * only 1/10 of the allowed requests. The Authorization header carries a
 * per-user token (GitHub Copilot OAuth token), so it identifies individual
 * users even when they all come from the same IP.
 *
 * Security: we SHA-256 the full Authorization header and use the hash as the
 * key. Slicing the raw token (old behaviour) let an attacker vary the leading
 * bytes of a forged header to create unlimited buckets and bypass the limit.
 * Hashing anchors the key to the ENTIRE header so any change — forged or not —
 * produces a fresh limit, and the full secret never reaches logs or memory
 * for longer than the sync hash computation.
 *
 * Falls back to IP when no Authorization header is present (curl, healthz).
 */
function generateKey(req: Request): string {
  const authHeader = req.headers['authorization'];
  if (typeof authHeader === 'string' && authHeader.length > 8) {
    // Hash the full header; truncate the digest for a compact in-memory key.
    const digest = createHash('sha256').update(authHeader).digest('hex');
    return 'tok:' + digest.slice(0, 32);
  }

  // Fallback: IP-based key (same logic as before)
  const rawIp = req.ip || req.socket.remoteAddress || 'unknown';
  const ipWithoutPort = rawIp.replace(/:\d+$/, '');
  return 'ip:' + ipKeyGenerator(ipWithoutPort);
}

/**
 * General API rate limiter
 * Default: 500 requests per 15 minutes per user token (or IP as fallback).
 * GitHub Copilot is chatty: a single interaction (e.g. get_class_info + search
 * + batch_search) can easily consume 10–20 requests. With 10 developers the old
 * default of 100 / 15 min was hit within 1–2 minutes per user.
 * Override via RATE_LIMIT_MAX_REQUESTS env var.
 */
export const apiRateLimiter = rateLimit({
  windowMs: parseEnvInt('RATE_LIMIT_WINDOW_MS', 900000, 10000, 86400000), // 10s–24h
  max: parseEnvInt('RATE_LIMIT_MAX_REQUESTS', 500, 1, 100000),
  keyGenerator: generateKey,
  validate: {
    // We safely use ipKeyGenerator in our custom generateKey function
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

/**
 * Strict rate limiter for expensive operations
 * Default: 20 requests per 15 minutes per IP
 */
export const strictRateLimiter = rateLimit({
  windowMs: parseEnvInt('RATE_LIMIT_WINDOW_MS', 900000, 10000, 86400000),
  max: parseEnvInt('RATE_LIMIT_STRICT_MAX_REQUESTS', 20, 1, 1000),
  keyGenerator: generateKey,
  validate: {
    // We safely use ipKeyGenerator in our custom generateKey function
    keyGeneratorIpFallback: false,
  },
  message: {
    error: 'Too many requests for this endpoint, please try again later.',
    retryAfter: 'Please check the Retry-After header.',
  },
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req: Request, res: Response) => {
    res.status(429).json({
      error: 'Rate limit exceeded',
      message: 'This endpoint has stricter rate limits. Please try again later.',
      retryAfter: res.getHeader('Retry-After'),
    });
  },
});

/**
 * Authentication rate limiter
 * Default: 5 requests per 15 minutes per IP
 */
export const authRateLimiter = rateLimit({
  windowMs: parseEnvInt('RATE_LIMIT_WINDOW_MS', 900000, 10000, 86400000),
  max: parseEnvInt('RATE_LIMIT_AUTH_MAX_REQUESTS', 5, 1, 100),
  keyGenerator: generateKey,
  validate: {
    // We safely use ipKeyGenerator in our custom generateKey function
    keyGeneratorIpFallback: false,
  },
  message: {
    error: 'Too many authentication attempts, please try again later.',
    retryAfter: 'Please check the Retry-After header.',
  },
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true, // Don't count successful auth requests
  handler: (_req: Request, res: Response) => {
    res.status(429).json({
      error: 'Too many authentication attempts',
      message: 'Please wait before trying to authenticate again.',
      retryAfter: res.getHeader('Retry-After'),
    });
  },
});

/**
 * Create a custom rate limiter with specific settings
 */
export function createCustomRateLimiter(windowMs: number, maxRequests: number) {
  return rateLimit({
    windowMs,
    max: maxRequests,
    keyGenerator: generateKey,
    validate: {
      // We safely use ipKeyGenerator in our custom generateKey function
      keyGeneratorIpFallback: false,
    },
    message: {
      error: 'Rate limit exceeded',
      retryAfter: 'Please check the Retry-After header.',
    },
    standardHeaders: true,
    legacyHeaders: false,
  });
}
