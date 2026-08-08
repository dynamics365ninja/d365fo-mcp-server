/**
 * Bridge lifecycle regressions (audit finding #26).
 *
 * Four separate ways the bridge's life cycle leaked state, all of which end in the same
 * place — a bridge that answers wrongly or not at all, from a server that thinks it is
 * healthy:
 *
 *   (i)   a child crash was classified as a deterministic error, so an in-flight READ was
 *         surfaced as a hard failure instead of being retried against a respawned child;
 *   (ii)  dispose() scheduled its SIGTERM/SIGKILL escalation on unref'd timers and returned
 *         immediately, so a wedged child outlived the server that spawned it;
 *   (iii) RefreshProvider() replaced the DiskProvider without releasing the old one, and
 *         every write triggers a refresh;
 *   (iv)  the write service's model cache survived UpdateProvider(), so a ModelSaveInfo
 *         derived from a descriptor (Id=SequenceId, SequenceId=0 — the shape that makes
 *         IMetadataProvider.Create() throw NullReferenceException) was served forever, and
 *         the refresh that would have fixed it changed nothing.
 *
 * (i) and (ii) are testable here. (iii) and (iv) live in C# that only runs on a D365FO VM,
 * so they are guarded the way the repo already guards C# invariants: by reading the source.
 */

import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { EventEmitter } from 'events';
import { BridgeClient, isTransientError } from '../../src/bridge/bridgeClient';
import { READ_SERVICE_CS, WRITE_SERVICE_CS, readStripped, methodBody } from './csharpSource';

const BRIDGE_CLIENT_TS = path.join(
  path.resolve(__dirname, '..', '..'),
  'src', 'bridge', 'bridgeClient.ts',
);

function makeClient(): BridgeClient {
  const client = new BridgeClient({ packagesPath: 'C:\\NonExistent', maxRetries: 2 });
  (client as any)._isReady = true;
  return client;
}

describe('child crash classification', () => {
  /**
   * Derived from the source rather than hard-coded: the defect was precisely that the
   * message the exit handler produces and the message isTransientError() looks for had
   * drifted apart, and a literal copied into the test would drift the same way.
   */
  function childExitMessage(): string {
    const source = fs.readFileSync(BRIDGE_CLIENT_TS, 'utf8');
    const handler = source.slice(source.indexOf("child.on('exit'"), source.indexOf("child.on('exit'") + 1500);

    const call = handler.match(/rejectAllPending\(\s*([\s\S]*?)\s*\);/);
    expect(call, 'the exit handler no longer rejects in-flight calls via rejectAllPending').toBeTruthy();

    // The message is either inline or held in a local — accept both, so this measures the
    // wording rather than the shape of the statement that carries it.
    const arg = call![1].trim();
    let template = arg.match(/new Error\(`([^`]+)`\)/)?.[1];
    if (!template && /^\w+$/.test(arg)) {
      template = handler.match(new RegExp(`(?:const|let)\\s+${arg}\\s*=\\s*new Error\\(\`([^\`]+)\``))?.[1];
    }
    expect(template, `could not read the message rejectAllPending is given: ${arg}`).toBeTruthy();

    return template!.replace(/\$\{code\}/g, '3221225477').replace(/\$\{signal\}/g, 'null');
  }

  it('treats the message in-flight calls get on a child crash as transient', () => {
    const message = childExitMessage();
    expect(
      isTransientError(new Error(message)),
      `a crash reported as "${message}" is not recognised as transient — an in-flight read ` +
        'is thrown at the caller instead of being retried against a respawned child',
    ).toBe(true);
  });

  it('retries a read whose child died mid-call', async () => {
    const client = makeClient();
    const callOnce = vi.fn()
      .mockRejectedValueOnce(new Error(childExitMessage()))
      .mockResolvedValueOnce({ name: 'CustTable' });
    (client as any).callOnce = callOnce;
    (client as any).ensureHealthy = vi.fn().mockResolvedValue(undefined);

    await expect(client.call('readTable', { tableName: 'CustTable' })).resolves.toEqual({ name: 'CustTable' });
    expect(callOnce).toHaveBeenCalledTimes(2);
  });

  it('still refuses to retry a write whose child died mid-call', async () => {
    const client = makeClient();
    const callOnce = vi.fn().mockRejectedValue(new Error(childExitMessage()));
    (client as any).callOnce = callOnce;
    (client as any).ensureHealthy = vi.fn();

    await expect(client.call('createObject', {})).rejects.toThrow('exited');
    expect(callOnce).toHaveBeenCalledTimes(1);
  });
});

describe('dispose', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** A child that ignores stdin close and every signal — the wedged case dispose exists for. */
  function unresponsiveChild() {
    const child = new EventEmitter() as any;
    child.pid = 4242;
    child.exitCode = null;
    child.signalCode = null;
    child.stdin = { end: vi.fn(), writable: true };
    child.kill = vi.fn();
    return child;
  }

  it('escalates to SIGTERM then SIGKILL and resolves rather than hanging', async () => {
    vi.useFakeTimers();
    const client = makeClient();
    const child = unresponsiveChild();
    (client as any).process = child;

    const pending = client.dispose();
    expect(
      typeof (pending as any)?.then,
      'dispose() must be awaitable — an escalation scheduled by a synchronous dispose never ' +
        'runs, because the process exits before the timers fire',
    ).toBe('function');

    let settled = false;
    void pending.then(() => { settled = true; });

    await vi.advanceTimersByTimeAsync(0);
    expect(child.stdin.end).toHaveBeenCalled();
    expect(child.kill).not.toHaveBeenCalled();
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');

    await vi.advanceTimersByTimeAsync(3_000);
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');

    await vi.advanceTimersByTimeAsync(3_000);
    await pending;
    expect(settled).toBe(true);
  });

  it('resolves as soon as the child exits, without escalating', async () => {
    vi.useFakeTimers();
    const client = makeClient();
    const child = unresponsiveChild();
    child.stdin.end = vi.fn(() => { setTimeout(() => child.emit('exit', 0, null), 10); });
    (client as any).process = child;

    const pending = client.dispose();
    await vi.advanceTimersByTimeAsync(50);
    await pending;
    expect(child.kill).not.toHaveBeenCalled();
  });
});

describe('C# provider lifecycle (source parity)', () => {
  let readService: string;
  let writeService: string;

  beforeAll(() => {
    readService = readStripped(READ_SERVICE_CS);
    writeService = readStripped(WRITE_SERVICE_CS);
  });

  it('RefreshProvider releases the DiskProvider it replaces', () => {
    const body = methodBody(readService, 'public object RefreshProvider()');
    expect(
      body,
      'RefreshProvider builds a new DiskProvider without releasing the old one — and every ' +
        'write auto-refreshes, so an authoring session accumulates providers holding the ' +
        'whole packages directory open until the bridge stops answering',
    ).toMatch(/Dispose/);
  });

  it('UpdateProvider drops the caches read off the previous provider', () => {
    const body = methodBody(writeService, 'public void UpdateProvider(IMetadataProvider newProvider)');
    expect(
      body,
      '_modelCache survives UpdateProvider — a descriptor-derived ModelSaveInfo (SequenceId=0) ' +
        'cached before the model reached the manifest keeps NREing IMetadataProvider.Create() ' +
        'no matter how many times the provider is refreshed',
    ).toContain('_modelCache.Clear()');
    expect(body).toContain('_microsoftModelCache.Clear()');
  });
});
