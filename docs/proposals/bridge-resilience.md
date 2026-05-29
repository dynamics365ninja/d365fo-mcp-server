# Proposal: Bridge resilience (retry + health-check)

> Status: **Draft — needs validation on a Windows D365FO VM.**
> The C# bridge (`D365MetadataBridge.exe`) only runs on Windows, so the changes below
> cannot be verified in the Linux CI/dev container. This document specifies the design and
> a test plan so it can be implemented and validated against a real bridge.

## Why

`src/bridge/bridgeClient.ts` spawns the bridge as a child process and talks to it over a
**single, sequential** stdin/stdout JSON-RPC pipe. Today:

- A single call timeout (`BRIDGE_CALL_TIMEOUT_MS`, now configurable) rejects the promise,
  but there is **no retry** — a transient hiccup (GC pause, slow first metadata load) fails
  the whole tool call.
- There is **no health-check**: if the child process dies or wedges, subsequent calls keep
  timing out one by one until something restarts it.
- There is **no detection of a stale pipe** (e.g. process alive but not responding).

This is the main remaining robustness gap from the audit. It is intentionally *not* shipped
blind because incorrect retry logic on a stateful, sequential pipe can duplicate **write**
operations (create/modify) — which must never happen.

## Design

### 1. Classify operations: retryable vs. non-retryable

Retries are safe **only for idempotent reads**. Writes (create/modify/label/index) must
**never** be auto-retried on timeout, because the operation may have already applied on the
bridge side before the timeout fired.

```ts
// bridgeAdapter already separates tryBridge* (reads) from bridge* (writes).
// Add an explicit allow-list of retryable methods (reads only).
const RETRYABLE_METHODS = new Set([
  'getClass', 'getTable', 'getForm', 'getEnum', 'getEdt', 'getQuery', 'getView',
  'getReport', 'getDataEntity', 'getMethodSource', 'getMethodSignature', 'getMenuItem',
  'completion', 'findExtensionClasses', 'findEventSubscribers', 'apiUsageCallers',
]);
```

### 2. Bounded retry with backoff (reads only)

In the `call()` path, when a read method times out or the pipe errors:

- retry up to `BRIDGE_MAX_RETRIES` (default 2) with exponential backoff (250ms, 500ms),
  jittered;
- before each retry, run the health-check (below) and restart the child if it is dead;
- never retry a method not in `RETRYABLE_METHODS`.

```ts
const BRIDGE_MAX_RETRIES = envInt('BRIDGE_MAX_RETRIES', 2);
```

### 3. Health-check / liveness

Add a lightweight `ping` method to the C# bridge (`RequestDispatcher.cs`) that returns
`{ ok: true }` without touching `IMetadataProvider`. The client:

- pings before a retry and on a configurable idle interval (`BRIDGE_HEALTHCHECK_MS`,
  default 0 = disabled);
- if the child has exited (`child.exitCode !== null`) or ping times out, tears down the
  pipe and respawns via the existing spawn path, then replays only the **current read**.

### 4. Restart safety

- Serialize restart behind the existing sequential-call lock so a restart cannot interleave
  with an in-flight write.
- Cap restarts (e.g. 3 within 60s) to avoid crash loops; after the cap, surface a clear
  `isError` result telling the user to check the bridge log (`D365FO_BRIDGE_LOG_FILE`).

## New env vars (document in `.env.example`)

| Var | Default | Meaning |
|-----|---------|---------|
| `BRIDGE_MAX_RETRIES` | `2` | Max retries for **read** calls on timeout/pipe error |
| `BRIDGE_HEALTHCHECK_MS` | `0` | Idle ping interval (0 = disabled) |
| `BRIDGE_MAX_RESTARTS` | `3` | Max child respawns per 60s before giving up |

## Test plan (on Windows VM)

1. **Read retry:** kill the bridge mid-`getTable`; expect one transparent restart + retry,
   correct result, single log line.
2. **Write never retried:** force a timeout during `create`/`modify`; expect immediate
   `isError` with a message, **no second write** (verify the AOT object was created exactly
   once / the modification applied once).
3. **Crash loop guard:** make the bridge exit on startup; expect ≤3 respawns then a clear
   `isError`.
4. **Health-check idle:** set `BRIDGE_HEALTHCHECK_MS=5000`, idle 30s, then call — expect the
   pipe still healthy (or transparently restarted) with no user-visible failure.
5. **Regression:** existing `tests/bridge/*` and `bridge-e2e.ts` stay green.

## Out of scope

- A true `dryRun` preview for `modify_d365fo_file` (would need a preview mode in the C#
  `IMetadataProvider` write path). Tracked separately.
