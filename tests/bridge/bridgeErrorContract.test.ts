/**
 * The bridge error contract — a bridge that THROWS must never look like an empty
 * metadata model.
 *
 * `bridgeAdapter` answered every thrown call with `null`, the same value it returns
 * for "no such object". The tool then served the SQLite index and reported it as the
 * answer, so an outage and a genuine absence were byte-identical to the caller —
 * the shape behind the "could not resolve" reports, the security-artifact empty
 * write and the table-extension field drop.
 *
 * Asserted here:
 *  1. a swallowed catch still records the failure on the current call;
 *  2. `null` keeps meaning "not found", so an unconverted wrapper is still correct;
 *  3. the wrappers that changed contract (create/resolve) hand back the failure;
 *  4. the acceptance criterion — driven through the REAL dispatcher, a fake bridge
 *     whose calls throw produces a response that says the bridge errored.
 */

import { describe, it, expect, vi } from 'vitest';
import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import {
  isBridgeFailure,
  recordBridgeFailure,
  runWithBridgeFailureScope,
  describeBridgeFailure,
  BRIDGE_FAILURE_MARKER,
  type BridgeFailure,
} from '../../src/bridge/bridgeFailure';
import {
  tryBridgeTable,
  bridgeResolveObject,
  bridgeCreateObject,
  bridgeCreateSmartTable,
} from '../../src/bridge/bridgeAdapter';

const boom = () => { throw new Error('Bridge call timed out after 60000ms'); };

/** A bridge that is up and healthy as far as any caller can tell — until it is called. */
function throwingBridge(): any {
  return {
    isReady: true,
    metadataAvailable: true,
    xrefAvailable: true,
    readTable: boom,
    resolveObjectInfo: boom,
    createObject: boom,
    createSmartTable: boom,
  };
}

/** A bridge that is up and answers honestly that the object is not there. */
function emptyBridge(): any {
  return {
    isReady: true,
    metadataAvailable: true,
    readTable: async () => null,
    resolveObjectInfo: async () => ({ exists: false, objectType: 'table', objectName: 'Nope' }),
  };
}

async function collect<T>(fn: () => Promise<T>): Promise<{ value: T; failures: BridgeFailure[] }> {
  const failures: BridgeFailure[] = [];
  const value = await runWithBridgeFailureScope(failures, fn);
  return { value, failures };
}

describe('failure recording', () => {
  it('records a swallowed read failure while still returning null', async () => {
    const { value, failures } = await collect(() => tryBridgeTable(throwingBridge(), 'CustTable'));

    expect(value).toBeNull();
    expect(failures).toHaveLength(1);
    expect(failures[0].operation).toBe('readTable(CustTable)');
    expect(failures[0].reason).toContain('timed out');
  });

  it('records nothing when the bridge answers that the object is absent', async () => {
    const { value, failures } = await collect(() => tryBridgeTable(emptyBridge(), 'Nope'));

    expect(value).toBeNull();
    expect(failures).toEqual([]);
  });

  it('records nothing when there is no bridge at all', async () => {
    const { value, failures } = await collect(() => tryBridgeTable(undefined, 'CustTable'));

    expect(value).toBeNull();
    expect(failures).toEqual([]);
  });

  it('is a no-op outside a scope, so non-dispatcher callers still work', () => {
    expect(() => recordBridgeFailure('readTable(X)', new Error('nope'))).not.toThrow();
  });
});

describe('discriminated wrappers', () => {
  it('bridgeResolveObject returns a failure, not a "does not exist" answer', async () => {
    const { value } = await collect(() => bridgeResolveObject(throwingBridge(), 'table', 'CustTable'));

    expect(isBridgeFailure(value)).toBe(true);
    expect(describeBridgeFailure(value as BridgeFailure)).toContain(BRIDGE_FAILURE_MARKER);
    // The trap this replaces: `value?.exists` on a null was indistinguishable
    // from a bridge that resolved the object and said it is not there.
    expect(value).not.toBeNull();
  });

  it('bridgeResolveObject still returns the resolution when the bridge answers', async () => {
    const { value } = await collect(() => bridgeResolveObject(emptyBridge(), 'table', 'Nope'));

    expect(isBridgeFailure(value)).toBe(false);
    expect(value).toMatchObject({ exists: false });
  });

  it('bridgeCreateObject returns a failure so the XML fallback can say why it ran', async () => {
    const { value } = await collect(() => bridgeCreateObject(throwingBridge(), {
      objectType: 'table', objectName: 'ConTestTable', modelName: 'ConModel',
    }));

    expect(isBridgeFailure(value)).toBe(true);
  });

  it('bridgeCreateObject keeps null for an objectType the bridge does not create', async () => {
    const { value } = await collect(() => bridgeCreateObject(throwingBridge(), {
      objectType: 'security-privilege', objectName: 'ConPriv', modelName: 'ConModel',
    }));

    expect(value).toBeNull();
  });

  it('bridgeCreateSmartTable returns a failure rather than a silent null', async () => {
    const { value } = await collect(() => bridgeCreateSmartTable(throwingBridge(), {
      objectName: 'ConTestTable', modelName: 'ConModel',
    }));

    expect(isBridgeFailure(value)).toBe(true);
  });
});

// ── Acceptance criterion: the dispatcher, end to end ─────────────────────────

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

/** Symbol index that knows nothing — the stale/empty fallback the tool drops to. */
function emptyIndex(): any {
  const stmt = { all: vi.fn(() => []), get: vi.fn(() => undefined), run: vi.fn() };
  return {
    searchSymbols: vi.fn(() => []),
    getSymbolByName: vi.fn(() => undefined),
    getCustomModels: vi.fn(() => []),
    getLastIndexedAt: vi.fn(() => null),
    db: { prepare: vi.fn(() => stmt) },
    getReadDb: vi.fn(function (this: any) { return this.db; }),
  };
}

describe('dispatcher response for a throwing bridge', () => {
  it('says the bridge errored instead of reporting the object as absent', async () => {
    const { registerToolHandler } = await import('../../src/tools/toolHandler');
    const { server, getCallHandler } = buildFakeServer();
    registerToolHandler(server, { symbolIndex: emptyIndex(), bridge: throwingBridge() } as any);

    const res: any = await call(getCallHandler(), 'get_object_info', {
      objectType: 'table', name: 'ConBridgeErrorProbe',
    });

    const text = res.content.map((c: any) => c.text).join('\n');
    expect(text).toContain(BRIDGE_FAILURE_MARKER);
    expect(text).toContain('readTable(ConBridgeErrorProbe)');
    expect(text).toContain('timed out');
  });

  it('leaves a healthy call unannotated', async () => {
    const { registerToolHandler } = await import('../../src/tools/toolHandler');
    const { server, getCallHandler } = buildFakeServer();
    registerToolHandler(server, { symbolIndex: emptyIndex(), bridge: emptyBridge() } as any);

    const res: any = await call(getCallHandler(), 'get_object_info', {
      objectType: 'table', name: 'ConHealthyProbe',
    });

    const text = res.content.map((c: any) => c.text).join('\n');
    expect(text).not.toContain(BRIDGE_FAILURE_MARKER);
  });
});
