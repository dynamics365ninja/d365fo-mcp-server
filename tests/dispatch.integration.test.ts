/**
 * Tool-routing integration test — exercises the REAL central dispatcher
 * (`registerToolHandler`) end to end, not the individual tool handlers in
 * isolation. This is the suite `npm run test:integration` runs.
 *
 * Unlike the unit tests (which call each tool function directly with mocked
 * dependencies), this drives a request through the same code path the live
 * MCP server uses: server-mode gating → dbReady wait → dedup/in-flight →
 * progress + logging channels → the `switch (toolName)` router → response
 * capping → metrics. A regression in any of those layers shows up here.
 *
 * `get_knowledge` is used as the probe because it is pure (request-only, no
 * SQLite/bridge/filesystem) and is NOT excluded from dedup, so the dedup
 * layer can be asserted too.
 */

import { describe, it, expect } from 'vitest';
import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { registerToolHandler } from '../src/tools/toolHandler';
import type { XppServerContext } from '../src/types/context';

type CallHandler = (request: any, extra: any) => Promise<any>;

/**
 * Minimal stand-in for the MCP `Server`. registerToolHandler only registers a
 * single request handler (for CallToolRequestSchema) and calls
 * sendLoggingMessage() best-effort, so that is all we need to capture.
 */
function buildFakeServer(): { server: any; getCallHandler: () => CallHandler } {
  let callHandler: CallHandler | undefined;
  const server = {
    setRequestHandler(schema: unknown, handler: CallHandler) {
      if (schema === CallToolRequestSchema) callHandler = handler;
    },
    // best-effort logging channel — handler wraps this in try/catch
    async sendLoggingMessage() {},
  };
  return {
    server,
    getCallHandler: () => {
      if (!callHandler) throw new Error('CallTool handler was not registered');
      return callHandler;
    },
  };
}

const ctx: XppServerContext = { symbolIndex: {} } as unknown as XppServerContext;

// No progressToken → the handler skips the notifications/progress channel.
const extra = { _meta: {} };

function call(handler: CallHandler, name: string, args: Record<string, unknown>) {
  return handler({ method: 'tools/call', params: { name, arguments: args } }, extra);
}

describe('tool routing — central dispatcher (integration)', () => {
  it('routes a real tool through the dispatcher and returns content', async () => {
    const { server, getCallHandler } = buildFakeServer();
    registerToolHandler(server, ctx);

    const res: any = await call(getCallHandler(), 'get_knowledge', { kind: 'knowledge', topic: 'coc' });

    expect(res.isError).toBeFalsy();
    expect(res.content?.[0]?.text).toBeTruthy();
    expect(typeof res.content[0].text).toBe('string');
  });

  it('returns a friendly isError for an unknown tool name', async () => {
    const { server, getCallHandler } = buildFakeServer();
    registerToolHandler(server, ctx);

    const res: any = await call(getCallHandler(), 'no_such_tool', {});

    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('Unknown tool');
  });

  it('serves an identical repeat call from the dedup cache', async () => {
    const { server, getCallHandler } = buildFakeServer();
    registerToolHandler(server, ctx);
    const h = getCallHandler();

    // Unique topic so the dedup key cannot collide with the other cases.
    const args = { kind: 'knowledge', topic: 'integration-dedup-probe' };
    const first: any = await call(h, 'get_knowledge', args);
    const second: any = await call(h, 'get_knowledge', args);

    expect(first.content[0].text).toBeTruthy();
    // The second identical call is short-circuited and annotated by the dispatcher.
    expect(second.content.map((c: any) => c.text).join('\n')).toContain('Duplicate call');
  });
});
