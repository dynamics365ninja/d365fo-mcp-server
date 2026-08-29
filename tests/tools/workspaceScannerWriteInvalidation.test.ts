/**
 * A write must invalidate the WORKSPACE SCAN cache too — through the dispatcher.
 *
 * Sibling of dedupWriteInvalidation.test.ts, which pins the same wiring for the
 * per-call dedup cache. This one pins the second cache in that path:
 * WorkspaceScanner keeps a 15s TTL map of the .xml files found on disk, and its
 * own doc comment claimed writes invalidated it. Nothing did — `invalidate()`
 * had no production caller at all, only tests and its own `clearCache()` alias.
 *
 * The consequence was a stale window of up to 15s after any write, during which
 * the workspace-backed readers (hybridSearch, includeWorkspace lookups) and the
 * workspace://files / workspace://active resources could not see a file this
 * same server had just created.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { clearAllInFlight, clearDedupCache } from '../../src/utils/callDedup';

vi.mock('../../src/tools/readers/getObjectInfo', () => ({
  getObjectInfoTool: vi.fn(async () => ({ content: [{ type: 'text', text: 'read' }] })),
}));

vi.mock('../../src/tools/d365foFile', () => ({
  d365foFileTool: vi.fn(async () => ({ content: [{ type: 'text', text: '✅ written' }] })),
}));

type CallHandler = (request: any, extra: any) => Promise<any>;

/** Records invalidate() calls so the test can assert the dispatcher wiring, not the scanner. */
function fakeScanner() {
  return { invalidated: [] as Array<string | undefined>, invalidate(p?: string) { this.invalidated.push(p); } };
}

async function buildHandler(scanner: unknown): Promise<CallHandler> {
  const { registerToolHandler } = await import('../../src/tools/toolHandler');
  let handler: CallHandler | undefined;
  const server: any = {
    setRequestHandler(schema: unknown, h: CallHandler) {
      if (schema === CallToolRequestSchema) handler = h;
    },
    async sendLoggingMessage() {},
  };
  registerToolHandler(server, { symbolIndex: {}, workspaceScanner: scanner } as any);
  if (!handler) throw new Error('CallTool handler was not registered');
  return handler;
}

const READ = {
  params: { name: 'get_object_info', arguments: { objectType: 'table', name: 'ConDemoRangeSource' } },
};
const WRITE = {
  params: {
    name: 'd365fo_file',
    arguments: {
      action: 'create', objectType: 'table', objectName: 'ConDemoNewTable',
    },
  },
};

beforeEach(() => {
  clearAllInFlight();
  clearDedupCache();
});

describe('workspace scan cache is invalidated by writes (dispatcher wiring)', () => {
  it('invalidates the scan cache after a mutating tool call', async () => {
    const scanner = fakeScanner();
    const handler = await buildHandler(scanner);

    await handler(WRITE, {});

    // Full clear, not per-path: the write's workspace is not reliably known at
    // this point, so scoping the blast radius would be a guess.
    expect(scanner.invalidated, 'a write must clear the workspace scan cache').toEqual([undefined]);
  });

  it('leaves the scan cache alone for a read', async () => {
    const scanner = fakeScanner();
    const handler = await buildHandler(scanner);

    await handler(READ, {});

    // Re-globbing the workspace on every read would undo the cache entirely.
    expect(scanner.invalidated).toEqual([]);
  });

  it('survives a context with no scanner (stub/HTTP paths construct one late)', async () => {
    const { registerToolHandler } = await import('../../src/tools/toolHandler');
    let handler: CallHandler | undefined;
    const server: any = {
      setRequestHandler(schema: unknown, h: CallHandler) {
        if (schema === CallToolRequestSchema) handler = h;
      },
      async sendLoggingMessage() {},
    };
    registerToolHandler(server, { symbolIndex: {} } as any);

    await expect(handler!(WRITE, {})).resolves.toBeDefined();
  });
});
