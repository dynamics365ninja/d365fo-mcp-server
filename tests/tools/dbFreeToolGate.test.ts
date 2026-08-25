/**
 * Static tools do not wait on the symbol database (audit 2026-08-25).
 *
 * VERIFIED LIVE through the Claude Code host: at server start, five parallel
 * first calls all exceeded 120 s and were pushed to the background — among them
 * `get_knowledge(kind="op-spec")`, a lookup that takes 2 ms warm and has no
 * database in its path at all. It waited only because the dispatcher's gate was
 * "not in LOCAL_TOOLS → await dbReady (55 s timeout)".
 *
 * The exemption list is deliberately tiny (see DB_FREE_TOOLS in toolHandler.ts).
 * This suite pins both halves: the static tool answers while the DB is still
 * loading, and an index-backed tool still waits, because answering it early
 * means answering it wrong.
 */

import { describe, it, expect } from 'vitest';
import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { registerToolHandler } from '../../src/tools/toolHandler';
import type { XppServerContext } from '../../src/types/context';

type CallHandler = (request: any, extra: any) => Promise<any>;

function buildFakeServer(): { server: any; getCallHandler: () => CallHandler } {
  let callHandler: CallHandler | undefined;
  const server = {
    setRequestHandler(schema: unknown, handler: CallHandler) {
      if (schema === CallToolRequestSchema) callHandler = handler;
    },
    async sendLoggingMessage() {},
  };
  return { server, getCallHandler: () => callHandler! };
}

/** A server whose symbol database never finishes loading. */
function buildHandler(): CallHandler {
  const { server, getCallHandler } = buildFakeServer();
  const ctx = {
    symbolIndex: {
      getReadDb: () => ({ prepare: () => ({ all: () => [], get: () => undefined }) }),
      searchSymbols: () => [],
      searchCustomModelSymbols: () => [],
      getAllSymbolNames: () => [],
      getSymbolsByTerm: () => new Map(),
    },
    dbReady: new Promise<void>(() => { /* never resolves */ }),
  } as unknown as XppServerContext;
  registerToolHandler(server, ctx);
  return getCallHandler();
}

function call(handler: CallHandler, name: string, args: Record<string, unknown>) {
  return handler({ method: 'tools/call', params: { name, arguments: args } }, { _meta: {} });
}

/** Resolves to 'pending' if the call has not answered within `ms`. */
function within(promise: Promise<any>, ms: number) {
  return Promise.race([
    promise.then(() => 'answered' as const),
    new Promise<'pending'>(resolve => setTimeout(() => resolve('pending'), ms)),
  ]);
}

describe('dbReady gate', () => {
  it('answers get_knowledge while the database is still loading', async () => {
    const handler = buildHandler();
    const result = await call(handler, 'get_knowledge', { kind: 'op-spec', topic: 'add-index' });

    expect(result.content[0].text).toBeTruthy();
    expect(result.content[0].text).not.toContain('still loading the X++ symbol database');
  });

  it('still makes an index-backed tool wait — an early answer there is a wrong one', async () => {
    const handler = buildHandler();
    // Unique query so the dedup cache cannot answer it from an earlier test.
    const pending = call(handler, 'search', { query: 'DbGateProbeXyz', type: 'table' });

    expect(await within(pending, 150)).toBe('pending');
  });
});
