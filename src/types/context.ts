/**
 * Shared type definitions
 */

import type { XppSymbolIndex } from '../metadata/symbolIndex.js';
import type { XppMetadataParser } from '../metadata/xmlParser.js';
import type { RedisCacheService } from '../cache/redisCache.js';

export interface XppServerContext {
  symbolIndex: XppSymbolIndex;
  parser: XppMetadataParser;
  cache: RedisCacheService;
}
