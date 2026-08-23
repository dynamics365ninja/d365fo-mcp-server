/**
 * A write must invalidate the read cache — end to end, through the dispatcher.
 *
 * The unit tests in tests/utils/callDedup.test.ts pin the cache's own behaviour.
 * This file pins the WIRING, which is where the defect actually lived: writes
 * were already excluded from being cached, so the module looked correct in
 * isolation, and the bug was that nothing told the cache a write had happened.
 *
 * Observed in 2 of the 4 eval runs on 2026-08-23
 * (L2-form-control-removal-lifecycle, L2-entity-query-range-roundtrip): a
 * `get_object_info(include:"xml")` on a data entity, three
 * `d365fo_file(action="modify")` writes, then the same read again — answered
 * with the 2399-byte pre-write body while disk held 2738 bytes with both ranges,
 * under a note reading "the result above is identical. Use the data you already
 * have instead of re-querying." An agent verifying its own write is told the
 * write did not happen.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { clearAllInFlight, clearDedupCache } from '../../src/utils/callDedup';

/** What the fake object reader currently "sees on disk". Mutated by the fake writer. */
let diskBody = 'BEFORE: <Ranges />';
const readCalls = { n: 0 };

vi.mock('../../src/tools/readers/getObjectInfo', () => ({
  getObjectInfoTool: vi.fn(async () => {
    readCalls.n++;
    return { content: [{ type: 'text', text: diskBody }] };
  }),
}));

vi.mock('../../src/tools/d365foFile', () => ({
  d365foFileTool: vi.fn(async () => {
    diskBody = 'AFTER: <Ranges><Range>IsActive</Range></Ranges>';
    return { content: [{ type: 'text', text: '✅ written' }] };
  }),
}));

type CallHandler = (request: any, extra: any) => Promise<any>;

async function buildHandler(): Promise<CallHandler> {
  const { registerToolHandler } = await import('../../src/tools/toolHandler');
  let handler: CallHandler | undefined;
  const server: any = {
    setRequestHandler(schema: unknown, h: CallHandler) {
      if (schema === CallToolRequestSchema) handler = h;
    },
    async sendLoggingMessage() {},
  };
  registerToolHandler(server, { symbolIndex: {} } as any);
  if (!handler) throw new Error('CallTool handler was not registered');
  return handler;
}

const READ = {
  params: {
    name: 'get_object_info',
    arguments: { objectType: 'data-entity', name: 'ConDemoRangeSourceEntity', options: { include: 'xml' } },
  },
};
const WRITE = {
  params: {
    name: 'd365fo_file',
    arguments: {
      action: 'modify', objectType: 'data-entity', objectName: 'ConDemoRangeSourceEntity',
      operation: 'add-query-range',
      params: { dataSourceName: 'ConDemoRangeSource', rangeField: 'IsActive', rangeValue: '1' },
    },
  },
};

const textOf = (r: any): string => r?.content?.[0]?.text ?? '';

beforeEach(() => {
  clearAllInFlight();
  clearDedupCache();
  diskBody = 'BEFORE: <Ranges />';
  readCalls.n = 0;
});

describe('dedup cache is invalidated by writes (dispatcher wiring)', () => {
  it('re-reads the object after a d365fo_file write instead of replaying the pre-write body', async () => {
    const handler = await buildHandler();

    const first = await handler(READ, {});
    expect(textOf(first)).toContain('BEFORE');
    expect(readCalls.n).toBe(1);

    await handler(WRITE, {});

    const second = await handler(READ, {});
    expect(textOf(second), 'the read after a write must show the written state').toContain('AFTER');
    expect(readCalls.n, 'the reader must actually run again').toBe(2);
    expect(textOf(second)).not.toContain('Duplicate call');
  });

  it('still dedups a repeated read when NO write intervened', async () => {
    const handler = await buildHandler();

    await handler(READ, {});
    const second = await handler(READ, {});

    // The loop mitigation the cache exists for is untouched: same args, no write.
    expect(readCalls.n).toBe(1);
    expect(textOf(second)).toContain('Duplicate call');
  });

  it('invalidates reads of OTHER objects too', async () => {
    const handler = await buildHandler();
    const otherRead = {
      params: { name: 'get_object_info', arguments: { objectType: 'table', name: 'ConDemoRangeSource' } },
    };

    await handler(otherRead, {});
    expect(readCalls.n).toBe(1);

    await handler(WRITE, {});

    await handler(otherRead, {});
    // Epoch-wide by design: a write to one object changes reads of others
    // (extensions, references, search hits, the symbol index), so scoping the
    // blast radius would be a guess about it.
    expect(readCalls.n).toBe(2);
  });
});
