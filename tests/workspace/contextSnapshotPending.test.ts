/**
 * The snapshot does not carry the expensive work on the request path
 * (audit 2026-08-25).
 *
 * get_workspace_info averaged 31.5 s over 31 real calls and is neither
 * bridge-gated nor DB-gated, so the cost was inside the tool: `getSymbolCounts()`
 * is a full index scan (30-60 s cold, per the comment on getSymbolCount) and
 * `scanWorkspace` globs every .xml under the workspace root and stats each hit.
 * Both are now computed in the background, reported as pending, and shown by the
 * next call — while diagnostics=true still waits for the full picture.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/utils/configManager', () => ({
  getConfigManager: () => ({
    getWorkspaceInfoDiagnostics: async () => ({ modelName: 'fm-mcp', modelSource: 'env', projectPath: null }),
    getDevEnvironmentType: async () => 'traditional',
    getWorkspacePath: () => 'K:\\ws',
  }),
}));
vi.mock('../../src/utils/stdioSessionInfo', () => ({ getStdioSessionInfo: () => ({ lastRoots: [] }) }));

import { buildContextSnapshot, resetRecentObjectsCache } from '../../src/workspace/contextSnapshot';
import type { XppServerContext } from '../../src/types/context';

/** A scan that never settles — the request must not be waiting on it. */
function buildContext(scan: () => Promise<any[]>, counts: { cached: any } = { cached: null }) {
  const getSymbolCounts = vi.fn(async () => ({ total: 1_170_432, byType: { table: 10 } }));
  const scanWorkspace = vi.fn(scan);
  const context = {
    symbolIndex: {
      getSymbolCounts,
      getCachedSymbolCounts: () => counts.cached,
      getIndexedModels: () => ['Foundation'],
      getLastIndexedAt: () => null,
    },
    workspaceScanner: { scanWorkspace },
  } as unknown as XppServerContext;
  return { context, getSymbolCounts, scanWorkspace };
}

const never = () => new Promise<any[]>(() => {});
const file = (name: string) => ({ name, type: 'table', path: `K:\\ws\\${name}.xml`, lastModified: new Date('2026-08-25T10:00:00Z') });

beforeEach(() => resetRecentObjectsCache());

describe('buildContextSnapshot — default (non-blocking)', () => {
  it('answers without waiting for the symbol counts or the workspace scan', async () => {
    const { context } = buildContext(never);

    const snapshot = await buildContextSnapshot(context);

    expect(snapshot.index.countsPending).toBe(true);
    expect(snapshot.recentPending).toBe(true);
    expect(snapshot.model).toBe('fm-mcp');
  });

  it('kicks both computations off so a later call has them', async () => {
    const { context, getSymbolCounts, scanWorkspace } = buildContext(never);

    await buildContextSnapshot(context);

    expect(getSymbolCounts).toHaveBeenCalledTimes(1);
    expect(scanWorkspace).toHaveBeenCalledTimes(1);
  });

  it('shows the scan result on the next call, without walking again', async () => {
    const { context, scanWorkspace } = buildContext(async () => [file('ConChainTbl')]);

    const first = await buildContextSnapshot(context);
    expect(first.recentPending).toBe(true);
    await new Promise(resolve => setTimeout(resolve, 10));

    const second = await buildContextSnapshot(context);
    expect(second.recentPending).toBe(false);
    expect(second.recentObjects.map(o => o.name)).toEqual(['ConChainTbl']);
    expect(second.activeObject?.name).toBe('ConChainTbl');
    expect(scanWorkspace).toHaveBeenCalledTimes(1);
  });

  it('uses the memoized counts when the index has already computed them', async () => {
    const { context, getSymbolCounts } = buildContext(never, { cached: { total: 42, byType: {} } });

    const snapshot = await buildContextSnapshot(context);

    expect(snapshot.index.countsPending).toBe(false);
    expect(snapshot.index.totalSymbols).toBe(42);
    expect(getSymbolCounts).not.toHaveBeenCalled();
  });
});

describe('buildContextSnapshot — blocking (diagnostics=true)', () => {
  it('waits for both, because the full picture is what diagnostics is for', async () => {
    const { context } = buildContext(async () => [file('ConChainTbl')]);

    const snapshot = await buildContextSnapshot(context, { blocking: true });

    expect(snapshot.index.countsPending).toBe(false);
    expect(snapshot.index.totalSymbols).toBe(1_170_432);
    expect(snapshot.recentPending).toBe(false);
    expect(snapshot.recentObjects).toHaveLength(1);
  });
});
