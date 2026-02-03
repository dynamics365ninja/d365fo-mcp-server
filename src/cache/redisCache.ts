import { Redis } from 'ioredis';

/**
 * Redis cache service for caching X++ metadata queries
 * Falls back to no-op operations if Redis is not configured
 */
export class RedisCacheService {
  private client: Redis | null = null;
  private enabled: boolean = false;
  private defaultTTL: number = 3600; // 1 hour default

  constructor() {
    const redisUrl = process.env.REDIS_URL;
    const redisEnabled = process.env.REDIS_ENABLED === 'true';

    if (redisEnabled && redisUrl) {
      try {
        this.client = new Redis(redisUrl, {
          retryStrategy: (times: number) => {
            const delay = Math.min(times * 50, 2000);
            return delay;
          },
          maxRetriesPerRequest: 3,
          lazyConnect: true, // Don't auto-connect, we'll connect explicitly
        });

        this.client.on('error', (err: Error) => {
          console.error('Redis connection error:', err);
          this.enabled = false;
        });

        this.client.on('connect', () => {
          console.log('Redis connected successfully');
          this.enabled = true;
        });

        // Attempt to connect
        this.client.connect().catch((err: Error) => {
          console.warn('Failed to connect to Redis, caching disabled:', err.message);
          this.enabled = false;
        });

        // Set default TTL from env or use 1 hour
        const ttl = parseInt(process.env.CACHE_TTL || '3600', 10);
        this.defaultTTL = isNaN(ttl) ? 3600 : ttl;
      } catch (error) {
        console.warn('Redis initialization failed, caching disabled:', error);
        this.enabled = false;
      }
    } else {
      console.log('Redis not configured, caching disabled');
    }
  }

  /**
   * Check if Redis is enabled and connected
   */
  isEnabled(): boolean {
    return this.enabled && this.client !== null;
  }

  /**
   * Get a value from cache
   */
  async get<T>(key: string): Promise<T | null> {
    if (!this.isEnabled() || !this.client) {
      return null;
    }

    try {
      const data = await this.client.get(key);
      if (!data) {
        return null;
      }
      return JSON.parse(data) as T;
    } catch (error) {
      console.error('Redis get error:', error);
      return null;
    }
  }

  /**
   * Set a value in cache with optional TTL
   */
  async set<T>(key: string, value: T, ttl?: number): Promise<void> {
    if (!this.isEnabled() || !this.client) {
      return;
    }

    try {
      const serialized = JSON.stringify(value);
      const expiry = ttl || this.defaultTTL;
      await this.client.setex(key, expiry, serialized);
    } catch (error) {
      console.error('Redis set error:', error);
    }
  }

  /**
   * Delete a key from cache
   */
  async delete(key: string): Promise<void> {
    if (!this.isEnabled() || !this.client) {
      return;
    }

    try {
      await this.client.del(key);
    } catch (error) {
      console.error('Redis delete error:', error);
    }
  }

  /**
   * Delete all keys matching a pattern
   */
  async deletePattern(pattern: string): Promise<void> {
    if (!this.isEnabled() || !this.client) {
      return;
    }

    try {
      const keys = await this.client.keys(pattern);
      if (keys.length > 0) {
        await this.client.del(...keys);
      }
    } catch (error) {
      console.error('Redis deletePattern error:', error);
    }
  }

  /**
   * Clear all cache
   */
  async clear(): Promise<void> {
    if (!this.isEnabled() || !this.client) {
      return;
    }

    try {
      await this.client.flushdb();
    } catch (error) {
      console.error('Redis clear error:', error);
    }
  }

  /**
   * Generate cache key for search queries
   */
  generateSearchKey(query: string, limit?: number, type?: string): string {
    return `xpp:search:${query}:${type || 'all'}:${limit || 10}`;
  }

  /**
   * Generate cache key for extension searches
   */
  generateExtensionSearchKey(query: string, prefix?: string, limit?: number): string {
    return `xpp:ext:${query}:${prefix || 'all'}:${limit || 20}`;
  }

  /**
   * Generate cache key for class info
   */
  generateClassKey(className: string): string {
    return `xpp:class:${className}`;
  }

  /**
   * Generate cache key for table info
   */
  generateTableKey(tableName: string): string {
    return `xpp:table:${tableName}`;
  }

  /**
   * Generate cache key for completions
   */
  generateCompletionKey(className: string, prefix?: string): string {
    return `xpp:complete:${className}:${prefix || ''}`;
  }

  /**
   * Close Redis connection
   */
  async close(): Promise<void> {
    if (this.client) {
      await this.client.quit();
      this.enabled = false;
    }
  }

  /**
   * Get cache statistics
   */
  async getStats(): Promise<{ enabled: boolean; keyCount?: number; memory?: string }> {
    if (!this.isEnabled() || !this.client) {
      return { enabled: false };
    }

    try {
      const dbsize = await this.client.dbsize();
      const info = await this.client.info('memory');
      const memoryMatch = info.match(/used_memory_human:(.+)/);
      const memory = memoryMatch ? memoryMatch[1].trim() : 'unknown';

      return {
        enabled: true,
        keyCount: dbsize,
        memory,
      };
    } catch (error) {
      console.error('Redis getStats error:', error);
      return { enabled: true };
    }
  }
}
