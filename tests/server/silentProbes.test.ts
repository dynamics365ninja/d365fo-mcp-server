/**
 * The HTTP transport's SILENT_PROBES list must only ever hold methods this
 * server does NOT serve.
 *
 * The defect this pins: four of the list's five entries were served, not probed.
 * `resources/list`, `resources/templates/list` and `prompts/list` sat there under
 * a comment reading "capability-probe methods that always return Method not
 * found" long after they got real handlers, and `logging/setLevel` is registered
 * by the SDK itself off the declared `logging: {}` capability — so no grep for a
 * request schema in this repo turns it up. Nothing was broken for the client,
 * which is why it survived; what it cost was visibility.
 * A client that reads workspace://active and one that ignores our resources
 * entirely produced byte-identical logs, and that difference is the trigger two
 * docs/BACKLOG.md entries are explicitly waiting on.
 *
 * Asserted against the server's real handler registry rather than a hand-copied
 * list, so registering a handler for a silenced method fails here.
 */

import { describe, it, expect } from 'vitest';
import { SILENT_PROBES } from '../../src/server/transport';
import { createXppMcpServer } from '../../src/server/mcpServer';

function registeredMethods(): Set<string> {
  const server: any = createXppMcpServer({ symbolIndex: {}, parser: {} } as any);
  const handlers: Map<string, unknown> | undefined = server._requestHandlers;
  if (!handlers) throw new Error('_requestHandlers is not exposed by the MCP SDK Server');
  return new Set(handlers.keys());
}

describe('SILENT_PROBES', () => {
  it('contains no method this server actually serves', () => {
    const served = registeredMethods();
    const wronglySilenced = [...SILENT_PROBES].filter((m) => served.has(m));
    expect(
      wronglySilenced,
      `these methods have a handler but are logged silently, hiding real client traffic: ${wronglySilenced.join(', ')}`,
    ).toEqual([]);
  });

  it('still silences the one genuine no-handler probe', () => {
    // Not merely "the set is non-empty": this is the reason it exists. Clients
    // probe completion/complete on connect and get -32601 every time.
    const served = registeredMethods();
    expect(served.has('completion/complete'), 'completion/complete unexpectedly has a handler now').toBe(false);
    expect(SILENT_PROBES.has('completion/complete')).toBe(true);
  });

  it('serves the four methods that used to be silenced', () => {
    const served = registeredMethods();
    // logging/setLevel is in this list precisely because it is the non-obvious
    // one: no request schema for it appears anywhere in src/ — the SDK registers
    // the handler itself off the `logging: {}` capability in mcpServer.ts.
    for (const method of ['resources/list', 'resources/templates/list', 'prompts/list', 'logging/setLevel']) {
      expect(served.has(method), `${method} must stay served — the capabilities block advertises it`).toBe(true);
    }
  });
});
