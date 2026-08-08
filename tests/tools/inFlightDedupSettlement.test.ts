/**
 * A failure in response post-processing must not strand the in-flight dedup entry
 * (audit 2.4 #24).
 *
 * The dispatcher registers each call in the in-flight map so a concurrent identical
 * call can coalesce onto it, and settled that promise only on the happy path —
 * after capToolResponse. capToolResponse walks `result.content`, so a tool returning
 * a shape it does not expect throws there, past the handler's own try/catch, and
 * the entry stayed in the map with a promise nothing would ever settle. From that
 * point every identical call awaited it and hung, for the life of the process — the
 * failure is permanent, not per-call, which is why it deserves a pin.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { clearAllInFlight, clearDedupCache } from '../../src/utils/callDedup';

// `search` is a capped tool (capToolResponse actually walks its content) and is not
// in DEDUP_EXCLUDED_TOOLS, so it goes through the in-flight registration.
// The malformed content is what makes the cap step throw.
vi.mock('../../src/tools/analysis/searchUnified', () => ({
  searchUnifiedTool: vi.fn(async () => ({ content: { notAnArray: 'boom' } })),
}));

type CallHandler = (request: any, extra: any) => Promise<any>;

/** Registers the dispatcher against a fake MCP server and hands back its CallTool handler. */
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

const TIMED_OUT = Symbol('timed out');
function withDeadline<T>(p: Promise<T>, ms = 1500): Promise<T | typeof TIMED_OUT> {
  return Promise.race([p, new Promise<typeof TIMED_OUT>(r => setTimeout(() => r(TIMED_OUT), ms))]);
}

beforeEach(() => {
  clearAllInFlight();
  clearDedupCache();
});

describe('in-flight dedup settlement', () => {
  it('does not deadlock later identical calls when post-processing throws', async () => {
    const handler = await buildHandler();

    const args = { query: 'ConDemoTable' };
    const request = { method: 'tools/call', params: { name: 'search', arguments: args } };

    // The first call is the one that trips capToolResponse. Whatever it does with
    // the error, it must leave the map clean.
    const first = await withDeadline(handler(request, { _meta: {} }).catch((e: any) => e));
    expect(first).not.toBe(TIMED_OUT);

    // Identical arguments — this is the call that hung forever before the fix.
    const second = await withDeadline(handler(request, { _meta: {} }).catch((e: any) => e));
    expect(second).not.toBe(TIMED_OUT);
  });

  it('still returns the tool result rather than converting it into an error', async () => {
    const handler = await buildHandler();

    const result: any = await withDeadline(
      handler({ method: 'tools/call', params: { name: 'search', arguments: { query: 'X' } } }, { _meta: {} }),
    );

    expect(result).not.toBe(TIMED_OUT);
    // The tool itself succeeded; only the capping failed, so its answer survives.
    expect(result.content).toEqual({ notAnArray: 'boom' });
  });
});
