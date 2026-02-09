import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import type { Request, Response } from 'express';

/**
 * Rate limiter configuration for different endpoint types
 */

/**
 * Custom key generator that handles IP addresses with ports
 * Uses ipKeyGenerator helper for proper IPv6 support
 * Fixes Azure App Service proxy scenarios where IP comes as "IP:PORT"
 */
function generateKey(req: Request): string {
  // Get IP from various sources (trusting proxy headers)
  const rawIp = req.ip || req.socket.remoteAddress || 'unknown';
  
  // Azure App Service sometimes appends port to IP (e.g., "20.73.89.75:1024")
  // Strip port number before normalizing
  const ipWithoutPort = rawIp.replace(/:\d+$/, '');
  
  // Use the official ipKeyGenerator helper for proper IPv4/IPv6 normalization
  const normalizedIp = ipKeyGenerator(ipWithoutPort);
  
  return normalizedIp;
}

/**
 * General API rate limiter
 * Default: 100 requests per 15 minutes per IP
 */
export const apiRateLimiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '900000', 10), // 15 minutes
  max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || '100', 10),
  keyGenerator: generateKey,
  validate: {
    // We safely use ipKeyGenerator in our custom generateKey function
    keyGeneratorIpFallback: false,
  },
  message: {
    error: 'Too many requests from this IP, please try again later.',
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
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '900000', 10), // 15 minutes
  max: parseInt(process.env.RATE_LIMIT_STRICT_MAX_REQUESTS || '20', 10),
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
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '900000', 10), // 15 minutes
  max: parseInt(process.env.RATE_LIMIT_AUTH_MAX_REQUESTS || '5', 10),
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
