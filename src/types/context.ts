/**
 * Shared type definitions
 */

import type { XppSymbolIndex, XppMetadataParser } from '../metadata/index.js';
import type { RedisCacheService } from '../cache/redisCache.js';

export interface XppServerContext {
  symbolIndex: XppSymbolIndex;
  parser: XppMetadataParser;
  cache: RedisCacheService;
}
