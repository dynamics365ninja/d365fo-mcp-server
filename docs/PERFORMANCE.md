# Performance Features Guide

This document describes the rate limiting and caching features implemented in the X++ MCP Code Completion Server.

## Table of Contents

1. [Rate Limiting](#rate-limiting)
2. [Redis Caching](#redis-caching)
3. [Configuration](#configuration)
4. [Monitoring](#monitoring)
5. [Best Practices](#best-practices)

## Rate Limiting

The server implements rate limiting to protect against API abuse and ensure fair resource allocation.

### Configuration

Rate limiting is configured via environment variables:

```env
# Rate Limiting Configuration
RATE_LIMIT_WINDOW_MS=900000          # 15 minutes in milliseconds
RATE_LIMIT_MAX_REQUESTS=100          # Max requests per window
RATE_LIMIT_STRICT_MAX_REQUESTS=20    # Strict limit for expensive operations
RATE_LIMIT_AUTH_MAX_REQUESTS=5       # Limit for authentication attempts
```

### Limits

Three types of rate limits are applied:

#### 1. General API Limit (Default)
- **Default**: 100 requests per 15 minutes per IP
- **Applies to**: All `/mcp` endpoints
- **Response on limit**: HTTP 429 with retry information

#### 2. Strict Limit
- **Default**: 20 requests per 15 minutes per IP
- **Applies to**: Expensive operations (future use)
- **Use case**: Resource-intensive queries, bulk operations

#### 3. Authentication Limit
- **Default**: 5 requests per 15 minutes per IP
- **Applies to**: Authentication endpoints (future use)
- **Special behavior**: Only counts failed attempts

### Response Headers

When rate limiting is active, responses include:

```
RateLimit-Limit: 100
RateLimit-Remaining: 95
RateLimit-Reset: 1640995200
```

When rate limited (HTTP 429):

```json
{
  "error": "Too many requests",
  "message": "You have exceeded the rate limit. Please try again later.",
  "retryAfter": 900
}
```

### Exemptions

- `/health` endpoint is exempt from rate limiting
- Successful authentication attempts don't count toward auth limits

## Redis Caching

Optional Redis integration provides significant performance improvements for frequently accessed data.

### Benefits

- **Faster Response Times**: Cached queries return in <5ms vs 20-100ms for database queries
- **Reduced Database Load**: Popular queries served from cache
- **Scalability**: Multiple server instances can share the same cache
- **Cost Efficiency**: Reduces compute time on expensive operations

### What Gets Cached

| Operation | Cache Key Pattern | Default TTL |
|-----------|-------------------|-------------|
| Symbol search | `xpp:search:{query}:{limit}` | 1 hour |
| Extension search | `xpp:ext:{query}:{prefix}:{limit}` | 1 hour |
| Class info | `xpp:class:{className}` | 1 hour |
| Table info | `xpp:table:{tableName}` | 1 hour |
| Completions | `xpp:complete:{className}:{prefix}` | 1 hour |

### Configuration

#### Local Development (Docker)

```bash
# Start Redis with Docker
docker run -d -p 6379:6379 --name redis-cache redis:7-alpine

# Configure .env
REDIS_ENABLED=true
REDIS_URL=redis://localhost:6379
CACHE_TTL=3600
```

#### Azure Cache for Redis

```bash
# Create Basic C0 instance (~$16/month)
az redis create \
  --name xpp-mcp-cache \
  --resource-group rg-xpp-mcp \
  --location eastus \
  --sku Basic \
  --vm-size c0

# Get connection string with SSL
az redis list-keys \
  --name xpp-mcp-cache \
  --resource-group rg-xpp-mcp \
  --query primaryKey -o tsv

# Configure .env
REDIS_ENABLED=true
REDIS_URL=redis://:YOUR_KEY@xpp-mcp-cache.redis.cache.windows.net:6380?ssl=true
CACHE_TTL=3600
```

#### Azure Cache for Redis (Production)

For production workloads, consider:

```bash
# Standard C1 instance (~$54/month) - Better performance, replication
az redis create \
  --name xpp-mcp-cache-prod \
  --resource-group rg-xpp-mcp-prod \
  --location eastus \
  --sku Standard \
  --vm-size c1
```

### Cache Behavior

#### Cache Hit
```typescript
// Cached results include "(cached)" indicator
{
  "content": [{
    "type": "text",
    "text": "Found 25 matches (cached):\n\n..."
  }]
}
```

#### Cache Miss
```typescript
// Query database, cache results, return
// No "(cached)" indicator on first request
{
  "content": [{
    "type": "text",
    "text": "Found 25 matches:\n\n..."
  }]
}
```

#### Fallback Behavior

If Redis is unavailable:
- Server continues to work without caching
- All queries go directly to database
- Warning logged: "Redis cache disabled - running without cache"
- No errors returned to clients

### Cache Management

#### Clear All Cache

```bash
# Connect to Redis
redis-cli -h your-cache-name.redis.cache.windows.net -p 6380 -a YOUR_KEY --tls

# Clear all X++ cache keys
KEYS xpp:*
DEL xpp:*

# Or flush entire database (careful!)
FLUSHDB
```

#### Monitor Cache Usage

```bash
# Get cache statistics via API
curl http://localhost:8080/cache/stats

# Redis CLI
INFO memory
DBSIZE
```

#### Invalidate Specific Cache

```typescript
// Future: Admin endpoint for cache invalidation
POST /admin/cache/invalidate
{
  "pattern": "xpp:class:*"  // Invalidate all class cache
}
```

## Configuration

### Minimal Setup (No Redis)

```env
# Server runs without caching
PORT=8080
DB_PATH=/tmp/xpp-metadata.db
RATE_LIMIT_WINDOW_MS=900000
RATE_LIMIT_MAX_REQUESTS=100
```

### Recommended Setup (With Redis)

```env
# Production configuration
PORT=8080
DB_PATH=/tmp/xpp-metadata.db

# Redis
REDIS_ENABLED=true
REDIS_URL=redis://:key@cache.redis.cache.windows.net:6380?ssl=true
CACHE_TTL=3600

# Rate Limiting
RATE_LIMIT_WINDOW_MS=900000
RATE_LIMIT_MAX_REQUESTS=100
RATE_LIMIT_STRICT_MAX_REQUESTS=20
RATE_LIMIT_AUTH_MAX_REQUESTS=5
```

### High-Traffic Setup

```env
# Increased limits for high-volume scenarios
RATE_LIMIT_WINDOW_MS=900000
RATE_LIMIT_MAX_REQUESTS=500
RATE_LIMIT_STRICT_MAX_REQUESTS=100

# Longer cache TTL
CACHE_TTL=7200  # 2 hours
```

## Monitoring

### Health Check

```bash
# Basic health check
curl http://localhost:8080/health

# Response includes session count
{
  "status": "healthy",
  "sessions": 3,
  "timestamp": "2024-01-20T10:30:00.000Z"
}
```

### Cache Statistics

Check startup logs:

```
💾 Initializing cache service...
✅ Redis cache enabled (127 keys, 2.5M memory)
```

Or query programmatically:

```typescript
const stats = await cache.getStats();
console.log(stats);
// { enabled: true, keyCount: 127, memory: '2.5M' }
```

### Rate Limit Monitoring

Monitor rate limit headers in responses:

```bash
curl -v http://localhost:8080/mcp \
  -H "Content-Type: application/json" \
  -d '{"method":"tools/list"}'

# Check headers
< RateLimit-Limit: 100
< RateLimit-Remaining: 95
< RateLimit-Reset: 1640995200
```

## Best Practices

### Development

1. **Use Docker for Redis**: Easy setup, no installation needed
2. **Disable rate limiting**: Set high limits for development
3. **Monitor cache hits**: Check logs for "(cached)" indicators
4. **Test without cache**: Ensure fallback works

```env
# Development .env
REDIS_ENABLED=true
REDIS_URL=redis://localhost:6379
RATE_LIMIT_MAX_REQUESTS=10000  # Effectively unlimited
```

### Production

1. **Enable Redis**: Use Azure Cache for Redis Standard tier
2. **Configure appropriate limits**: Based on expected traffic
3. **Monitor cache hit ratio**: Aim for >80% hit rate
4. **Set up alerts**: For rate limit violations and cache failures
5. **Use SSL/TLS**: Always encrypt Redis connections in production

```env
# Production .env
REDIS_ENABLED=true
REDIS_URL=redis://:key@cache.redis.cache.windows.net:6380?ssl=true
CACHE_TTL=3600
RATE_LIMIT_MAX_REQUESTS=100
```

### Cost Optimization

1. **Start with Basic C0**: ~$16/month, upgrade if needed
2. **Monitor memory usage**: Ensure cache fits in tier
3. **Adjust TTL**: Longer TTL = better hit rate but stale data
4. **Consider cache eviction**: LRU policy handles overflow

### Security

1. **Protect Redis**: Use firewall rules, VNet integration
2. **Rotate keys regularly**: Update Redis passwords
3. **Use TLS**: Enable SSL for Redis connections
4. **Rate limit by API key**: Future enhancement for per-user limits

## Troubleshooting

### Cache Not Working

**Symptom**: No "(cached)" indicators in responses

**Checks**:
1. Verify `REDIS_ENABLED=true` in `.env`
2. Check Redis connection: `redis-cli ping`
3. Review startup logs for Redis errors
4. Verify `REDIS_URL` format is correct

### High Rate of 429 Errors

**Symptom**: Clients receiving "Too many requests" errors

**Solutions**:
1. Increase rate limits in `.env`
2. Implement client-side rate limiting
3. Use exponential backoff on 429 responses
4. Consider per-user limits (future feature)

### Redis Connection Failures

**Symptom**: "Failed to connect to Redis" in logs

**Solutions**:
1. Verify Redis is running: `redis-cli ping`
2. Check firewall rules
3. Verify connection string includes SSL for Azure
4. Review Redis logs for errors

**Fallback**: Server continues without caching

### Cache Memory Issues

**Symptom**: Redis evicting keys unexpectedly

**Solutions**:
1. Upgrade Redis tier (C0 → C1 → C2)
2. Reduce `CACHE_TTL`
3. Review cache key patterns
4. Monitor with `INFO memory`

## Future Enhancements

Planned features:

- [ ] Per-user rate limiting (API keys)
- [ ] Cache warming on startup
- [ ] Cache invalidation API
- [ ] Prometheus metrics export
- [ ] Circuit breaker for Redis failures
- [ ] Distributed rate limiting (Redis-based)
- [ ] Cache compression for large objects
- [ ] Multi-region cache replication
