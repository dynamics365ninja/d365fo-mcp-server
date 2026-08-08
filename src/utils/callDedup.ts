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
  return entry.result;
}

export function storeDedupResult(key: string, result: any): void {
  if (result?.isError) return; // never cache failures — retries must re-execute
  if (dedupCache.size >= DEDUP_MAX_ENTRIES) {
    // Drop the oldest entry (Map preserves insertion order)
    const oldest = dedupCache.keys().next().value;
    if (oldest !== undefined) dedupCache.delete(oldest);
  }
  dedupCache.set(key, { result, at: Date.now() });
}

/** Test/maintenance helper. */
export function clearDedupCache(): void {
  dedupCache.clear();
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
