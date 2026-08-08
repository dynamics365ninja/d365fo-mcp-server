/**
 * Regression tests for issue #826 — bridge-backed tools were advertised before
 * the C# bridge was ready.
 *
 * The MCP tool list goes live as soon as the handshake completes, but the bridge
 * is spawned out-of-band and only lands on `context.bridge` once it is up. A
 * bridge-backed tool called in that window fell through every read path and
 * answered `Table "X" not found via bridge, symbol index, or on disk` /
 * `The C# bridge is not connected. … check .mcp.json`. Both are diagnostic dead
 * ends: nothing is wrong, and the identical call succeeded 19 s later in the
 * audited session.
 *
 * What is asserted here:
 *  1. the dispatcher waits for an in-flight startup, so a cold call returns the
 *     same answer as a warm one (the acceptance criterion in the issue);
 *  2. only a genuine timeout / genuine absence produces an error message, and
 *     the two are worded differently ("still starting" vs "not connected");
 *  3. BRIDGE_BACKED_TOOLS does not drift away from the tools that actually
 *     reach `context.bridge`.
 */

import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import {
  trackBridgeStartup,
  bridgeStartupState,
  awaitBridgeReady,
  describeBridgeStartup,
  BRIDGE_BACKED_TOOLS,
  type BridgeReadinessSource,
} from '../../src/bridge/bridgeReadiness';
import { bridgeUnavailableNote } from '../../src/utils/indexedXmlLookup';

const READY_BRIDGE = { isReady: true, metadataAvailable: true };

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}

describe('bridge startup tracking', () => {
  it('reports settled only after the attempt resolves', async () => {
    const d = deferred();
    const startup = trackBridgeStartup(d.promise);

    expect(startup.settled).toBe(false);
    d.resolve();
    await startup.done;
    expect(startup.settled).toBe(true);
  });

  it('treats a failed startup as settled rather than propagating the rejection', async () => {
    const startup = trackBridgeStartup(Promise.reject(new Error('spawn ENOENT')));

    await expect(startup.done).resolves.toBeUndefined();
    expect(startup.settled).toBe(true);
  });
});

describe('bridgeStartupState', () => {
  it('is "starting" only while an attempt is in flight', async () => {
    const d = deferred();
    const ctx: BridgeReadinessSource = { bridgeStartup: trackBridgeStartup(d.promise) };

    expect(bridgeStartupState(ctx)).toBe('starting');

    d.resolve();
    await ctx.bridgeStartup!.done;
    // Settled with no bridge attached — a real absence, not a race.
    expect(bridgeStartupState(ctx)).toBe('unavailable');
  });

  it('is "unavailable" when nothing ever tried to start a bridge', () => {
    expect(bridgeStartupState({})).toBe('unavailable');
  });

  it('is "ready" once the bridge is attached', () => {
    expect(bridgeStartupState({ bridge: READY_BRIDGE })).toBe('ready');
  });
});

describe('awaitBridgeReady', () => {
  it('returns immediately when the bridge is already up', async () => {
    const t0 = Date.now();
    await expect(awaitBridgeReady({ bridge: READY_BRIDGE })).resolves.toBe('ready');
    expect(Date.now() - t0).toBeLessThan(50);
  });

  it('does not wait when no startup attempt is tracked', async () => {
    const t0 = Date.now();
    await expect(awaitBridgeReady({})).resolves.toBe('not-tracked');
    expect(Date.now() - t0).toBeLessThan(50);
  });

  it('waits for an in-flight startup and reports the bridge that arrived', async () => {
    const ctx: BridgeReadinessSource = {};
    ctx.bridgeStartup = trackBridgeStartup(
      new Promise<void>(r => setTimeout(() => { ctx.bridge = READY_BRIDGE; r(); }, 60)),
    );

    await expect(awaitBridgeReady(ctx, 5_000)).resolves.toBe('ready');
    expect(ctx.bridge).toBe(READY_BRIDGE);
  });

  it('reports "unavailable" when the attempt settles without a bridge', async () => {
    const ctx: BridgeReadinessSource = {
      bridgeStartup: trackBridgeStartup(new Promise<void>(r => setTimeout(r, 20))),
    };
    await expect(awaitBridgeReady(ctx, 5_000)).resolves.toBe('unavailable');
  });

  it('reports "timeout" — and only "timeout" — for a startup that never finishes', async () => {
    const ctx: BridgeReadinessSource = { bridgeStartup: trackBridgeStartup(deferred().promise) };
    await expect(awaitBridgeReady(ctx, 30)).resolves.toBe('timeout');
  });
});

describe('startup-aware not-found wording', () => {
  it('tells the agent to retry — not to fix its config — while the bridge is starting', () => {
    const ctx: BridgeReadinessSource = { bridgeStartup: trackBridgeStartup(deferred().promise) };

    const note = describeBridgeStartup(ctx)!;
    expect(note).toContain('still starting');
    expect(note).not.toContain('.mcp.json');
    expect(note).not.toContain('not connected');

    const indexNote = bridgeUnavailableNote(ctx);
    expect(indexNote).toContain('still starting');
    expect(indexNote).not.toContain('not connected');
  });

  it('keeps the "check your config" text for a bridge that genuinely failed to start', () => {
    const note = describeBridgeStartup({})!;
    expect(note).toContain('not connected');
    expect(note).toContain('.mcp.json');

    expect(bridgeUnavailableNote({})).toContain('not connected');
  });

  it('says nothing about the bridge when it is up and healthy', () => {
    expect(describeBridgeStartup({ bridge: READY_BRIDGE })).toBeNull();
    expect(bridgeUnavailableNote({ bridge: READY_BRIDGE })).toBe('');
  });
});

// The dispatcher path — this is the acceptance criterion: a get_object_info
// issued milliseconds after the handshake must match a warm call.

const BRIDGE_TABLE_TEXT = '# Table: CustTable\n\n(served by the C# bridge)';

vi.mock('../../src/bridge/bridgeAdapter', async (orig) => {
  const actual = await orig<typeof import('../../src/bridge/bridgeAdapter')>();
  return {
    ...actual,
    // Name-independent so a cold call and a warm call (different names, to dodge
    // the dispatcher's dedup cache) are comparable byte for byte.
    tryBridgeTable: async (bridge: any) =>
      bridge?.isReady ? { content: [{ type: 'text', text: BRIDGE_TABLE_TEXT }] } : null,
  };
});

type CallHandler = (request: any, extra: any) => Promise<any>;

function buildFakeServer(): { server: any; getCallHandler: () => CallHandler } {
  let callHandler: CallHandler | undefined;
  const server = {
    setRequestHandler(schema: unknown, handler: CallHandler) {
      if (schema === CallToolRequestSchema) callHandler = handler;
    },
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

function call(handler: CallHandler, name: string, args: Record<string, unknown>) {
  return handler({ method: 'tools/call', params: { name, arguments: args } }, { _meta: {} });
}

describe('dispatcher gate — cold start (issue #826)', () => {
  it('a call issued right after the handshake matches a warm call', async () => {
    const { registerToolHandler } = await import('../../src/tools/toolHandler');
    const BRIDGE_SPAWN_MS = 120;

    const context: any = { symbolIndex: {} };
    context.bridgeStartup = trackBridgeStartup(
      new Promise<void>(r => setTimeout(() => { context.bridge = READY_BRIDGE; r(); }, BRIDGE_SPAWN_MS)),
    );

    const { server, getCallHandler } = buildFakeServer();
    registerToolHandler(server, context);

    // Cold: the bridge has not landed on the context yet.
    expect(context.bridge).toBeUndefined();
    const t0 = Date.now();
    const cold: any = await call(getCallHandler(), 'get_object_info', {
      objectType: 'table', name: 'ColdRaceTable',
    });
    const elapsed = Date.now() - t0;

    // Warm: same tool, different name so the dedup cache cannot answer it.
    const warm: any = await call(getCallHandler(), 'get_object_info', {
      objectType: 'table', name: 'WarmTable',
    });

    expect(cold.isError).toBeFalsy();
    expect(cold.content[0].text).toContain(BRIDGE_TABLE_TEXT);
    expect(cold.content[0].text).not.toContain('not connected');
    expect(cold.content[0].text).not.toContain('not found');
    expect(cold).toEqual(warm);
    // The answer came from the wait, not from luck.
    expect(elapsed).toBeGreaterThanOrEqual(BRIDGE_SPAWN_MS - 20);
  });

  it('does not wait for tools that never touch the bridge', async () => {
    const { registerToolHandler } = await import('../../src/tools/toolHandler');

    const context: any = { symbolIndex: {} };
    // A startup that never settles — a gated tool would block on it.
    context.bridgeStartup = trackBridgeStartup(deferred().promise);

    const { server, getCallHandler } = buildFakeServer();
    registerToolHandler(server, context);

    const t0 = Date.now();
    const res: any = await call(getCallHandler(), 'get_knowledge', {
      kind: 'knowledge', topic: 'bridge-readiness-probe',
    });

    expect(res.isError).toBeFalsy();
    expect(Date.now() - t0).toBeLessThan(1_000);
  });
});

// Drift guard — the gate is only correct if the set names every bridge user.

describe('BRIDGE_BACKED_TOOLS coverage', () => {
  const HERE = path.dirname(fileURLToPath(import.meta.url));
  const SRC = path.resolve(HERE, '..', '..', 'src');

  /** Entry module per tool, mirroring the `switch (toolName)` in toolHandler.ts. */
  const TOOL_ENTRY: Record<string, string> = {
    search: 'tools/searchUnified.ts',
    batch_get_info: 'tools/batchGetInfo.ts',
    get_object_info: 'tools/getObjectInfo.ts',
    generate_object: 'tools/generateObject.ts',
    analyze_code: 'tools/analyzeCode.ts',
    d365fo_file: 'tools/d365foFile.ts',
    find_references: 'tools/findReferences.ts',
    get_method: 'tools/getMethod.ts',
    labels: 'tools/labels.ts',
    object_patterns: 'tools/objectPatterns.ts',
    suggest_edt: 'tools/suggestEdt.ts',
    security_info: 'tools/securityInfo.ts',
    extension_info: 'tools/extensionInfo.ts',
    validate_object_naming: 'tools/validateObjectNaming.ts',
    verify_d365fo_project: 'tools/verifyD365Project.ts',
    update_symbol_index: 'tools/updateSymbolIndex.ts',
    build_d365fo_project: 'tools/buildProject.ts',
    trigger_db_sync: 'tools/dbSync.ts',
    run_bp_check: 'tools/runBpCheck.ts',
    run_systest_class: 'tools/sysTestRunner.ts',
    review_workspace_changes: 'tools/reviewWorkspaceChanges.ts',
    undo_last_modification: 'tools/undoLastModification.ts',
    get_knowledge: 'tools/getKnowledge.ts',
    validate_code: 'tools/validateCode.ts',
    prepare: 'tools/prepare.ts',
  };

  /** `context.bridge` / `ctx.bridge` / `bridge?.isReady` — how a module reaches the bridge. */
  const USES_BRIDGE = /(context|ctx)\s*\.\s*bridge\b|\bbridge\s*\?\.\s*isReady\b/;

  function reachesBridge(entry: string): boolean {
    const seen = new Set<string>();
    const stack = [path.resolve(SRC, entry)];
    while (stack.length > 0) {
      const file = stack.pop()!;
      if (seen.has(file)) continue;
      seen.add(file);
      let text: string;
      try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
      // bridgeReadiness itself inspects context.bridge — it is the gate, not a user.
      if (!file.endsWith('bridgeReadiness.ts') && USES_BRIDGE.test(text)) return true;
      const specs = [
        ...text.matchAll(/from\s+'(\.[^']+)'/g),
        ...text.matchAll(/import\(\s*'(\.[^']+)'\s*\)/g),
      ].map(m => m[1]);
      for (const spec of specs) {
        const resolved = path.resolve(path.dirname(file), spec).replace(/\.js$/, '.ts');
        if (fs.existsSync(resolved)) stack.push(resolved);
      }
    }
    return false;
  }

  it('gates every tool whose implementation reaches context.bridge', () => {
    const missing = Object.entries(TOOL_ENTRY)
      .filter(([tool, entry]) => reachesBridge(entry) && !BRIDGE_BACKED_TOOLS.has(tool))
      .map(([tool]) => tool);

    expect(missing, `tools using the bridge but not gated on its readiness: ${missing.join(', ')}`)
      .toEqual([]);
  });

  it('lists only real tool names', () => {
    for (const tool of BRIDGE_BACKED_TOOLS) {
      expect(Object.keys(TOOL_ENTRY)).toContain(tool);
    }
  });
});
