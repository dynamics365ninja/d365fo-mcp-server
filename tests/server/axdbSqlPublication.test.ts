import { afterEach, expect, it, vi } from 'vitest';
import { isToolEnabled, LOCAL_TOOLS, CORE_TOOLS } from '../../src/server/serverMode.js';
import { DEDUP_EXCLUDED_TOOLS, MUTATING_TOOLS } from '../../src/utils/callDedup.js';
import { toolSchemas } from '../../src/server/toolSchemas/index.js';
afterEach(() => vi.unstubAllEnvs());
it('publishes SQL only when configured, never in read-only server mode', () => {
  vi.stubEnv('D365FO_SQL_ENABLED', 'false');
  vi.stubEnv('D365FO_SQL_SERVER', 'localhost');
  expect(isToolEnabled('axdb_sql', 'full', 'full')).toBe(false);
  vi.stubEnv('D365FO_SQL_ENABLED', 'true');
  expect(isToolEnabled('axdb_sql', 'full', 'core')).toBe(true);
  expect(isToolEnabled('axdb_sql', 'write-only', 'core')).toBe(true);
  expect(isToolEnabled('axdb_sql', 'read-only', 'full')).toBe(false);
  vi.stubEnv('D365FO_SQL_SERVER', '');
  expect(isToolEnabled('axdb_sql', 'full', 'full')).toBe(false);
});
it('registers one tool, never serves its reads from cache, and is not a write', () => {
  expect(toolSchemas.filter(t => t.name === 'axdb_sql')).toHaveLength(1);
  for (const set of [LOCAL_TOOLS, CORE_TOOLS, DEDUP_EXCLUDED_TOOLS]) expect(set.has('axdb_sql')).toBe(true);
  // Read-only: a query must not bump the write epoch, which clears the dedup and workspace caches.
  expect(MUTATING_TOOLS.has('axdb_sql')).toBe(false);
});
