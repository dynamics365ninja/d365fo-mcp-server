/**
 * Duplicate-call dedup cache (agentic-loop mitigation).
 *
 * A model stuck in a loop re-issues the same read call with identical
 * arguments. Read tools are served from a short-TTL cache on repeat — the
 * model gets the identical answer instantly (with a note) instead of
 * re-running DB/bridge queries. Stateful tools are excluded: repeated
 * identical calls are legitimate there (build polling, write retries after
 * fixes, git state checks).
 */

export const DEDUP_TTL_MS = 60_000;
const DEDUP_MAX_ENTRIES = 200;

/**
 * Tools that CHANGE what a subsequent read would return.
 *
 * Excluding a write from the cache is not enough — the danger is the READ that
 * follows it. `get_object_info(include:"xml")` on an entity, three
 * `d365fo_file(action="modify")` writes, then the same read again: the second
 * read matched the cached key and served the 2399-byte pre-write body while
 * disk held 2738 bytes with both ranges, under a note telling the agent to trust
 * it. An agent verifying its own write is told the write did not happen. Seen in
 * 2 of the 4 eval runs on 2026-08-23 (L2-form-control-removal-lifecycle,
 * L2-entity-query-range-roundtrip).
 *
 * This is deliberately an EPOCH, not per-object invalidation: a write to one
 * object changes reads of others (extensions, references, search hits, the
 * symbol index), so scoping the blast radius would be a guess. Bumping a
 * counter costs nothing and is provably right. The loop it exists to break —
 * the same read re-issued seconds apart with no write between — is unaffected.
 */
export const MUTATING_TOOLS = new Set([
  'd365fo_file',            // create / modify / delete / generate
  'generate_object',        // mode="scaffold" writes to disk
  'undo_last_modification', // reverts a write
  'update_symbol_index',    // changes what every index-backed read resolves
  'trigger_db_sync',
  'labels',                 // action create / update / rename
]);

/**
 * Monotonic counter bumped by every mutating tool. A cache entry stored under an
 * older epoch is dead — see MUTATING_TOOLS.
 */
let writeEpoch = 0;

export function currentWriteEpoch(): number {
  return writeEpoch;
}

export function bumpWriteEpoch(): number {
  return ++writeEpoch;
}

/** Tools whose repeated identical calls are legitimate — never dedup, never loop-hint. */
export const DEDUP_EXCLUDED_TOOLS = new Set([
  'd365fo_file', // create/modify/generate — never dedup writes
  'labels', 'undo_last_modification',
  'update_symbol_index', 'build_d365fo_project', 'trigger_db_sync',
  'run_bp_check', 'run_systest_class', 'review_workspace_changes',
  'verify_d365fo_project', 'get_workspace_info',
  'prepare', // issues fresh grounding tokens
  // generate_object(mode="scaffold") writes directly to disk (like d365fo_file) and
  // reads live, mutable index state via cloneFrom/tableMapping/fieldsHint, so caching
  // by input args alone is unsound: a retry after update_symbol_index() must re-read
  // the now-current index rather than replay a stale cached result.
  'generate_object',
]);

interface DedupEntry {
  result: unknown;
  at: number;
  /** The write epoch the answer was COMPUTED under, not the one it was stored under. */
  epoch: number;
}

const dedupCache = new Map<string, DedupEntry>();

export function dedupKey(toolName: string, args: unknown): string {
  try {
    return `${toolName}|${JSON.stringify(args ?? {})}`;
  } catch {
    return `${toolName}|<unserializable>`;
  }
}

export function getDedupedResult(key: string): any | undefined {
  const entry = dedupCache.get(key);
  if (!entry) return undefined;
  if (Date.now() - entry.at > DEDUP_TTL_MS) {
    dedupCache.delete(key);
    return undefined;
  }
  // Something has been written since this answer was computed, so it may no
  // longer describe the disk. Drop it and let the read re-execute.
  if (entry.epoch !== writeEpoch) {
    dedupCache.delete(key);
    return undefined;
  }
  return entry.result;
}

/**
 * `epoch` is the write epoch captured when the call STARTED. A read that began
 * before a write and finished after it computed a pre-write answer, so storing
 * it under the current (bumped) epoch would re-introduce the very staleness this
 * guards against — which is why the caller passes it rather than letting it
 * default. The default (the epoch as of now) only holds when the caller knows no
 * write can have raced, i.e. tests and synchronous callers.
 */
export function storeDedupResult(key: string, result: any, epoch: number = writeEpoch): void {
  if (result?.isError) return; // never cache failures — retries must re-execute
  if (epoch !== writeEpoch) return; // raced a write — the answer is already stale
  if (dedupCache.size >= DEDUP_MAX_ENTRIES) {
    // Drop the oldest entry (Map preserves insertion order)
    const oldest = dedupCache.keys().next().value;
    if (oldest !== undefined) dedupCache.delete(oldest);
  }
  dedupCache.set(key, { result, at: Date.now(), epoch });
}

/** Test/maintenance helper. Resets the epoch too, so a cleared cache is a clean slate. */
export function clearDedupCache(): void {
  dedupCache.clear();
  writeEpoch = 0;
}

// ── In-flight dedup ──────────────────────────────────────────────────────────
// When two identical calls arrive before the first one completes the cache has
// nothing to serve yet. Track each in-progress call as a Promise so the second
// call can coalesce onto the first rather than executing a redundant copy.

interface InFlightEntry {
  promise: Promise<any>;
  resolve: (r: any) => void;
  reject: (e: any) => void;
}

const inFlightCalls = new Map<string, InFlightEntry>();

export function getInFlight(key: string): Promise<any> | undefined {
  return inFlightCalls.get(key)?.promise;
}

export function registerInFlight(key: string): { resolve: (r: any) => void; reject: (e: any) => void } {
  let resolve!: (r: any) => void;
  let reject!: (e: any) => void;
  const promise = new Promise<any>((res, rej) => { resolve = res; reject = rej; });
  inFlightCalls.set(key, { promise, resolve, reject });
  return { resolve, reject };
}

export function clearInFlight(key: string): void {
  inFlightCalls.delete(key);
}

export function clearAllInFlight(): void {
  inFlightCalls.clear();
}

/** Append a note to the first text item of a result (shallow clone). */
export function appendNote(result: any, note: string): any {
  if (!result?.content?.length) return result;
  const content = result.content.map((item: any, i: number) =>
    i === 0 && item.type === 'text' && typeof item.text === 'string'
      ? { ...item, text: `${item.text}\n\n${note}` }
      : item,
  );
  return { ...result, content };
}
