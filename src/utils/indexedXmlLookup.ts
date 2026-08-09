/**
 * Indexed-object XML lookup.
 *
 * Shared fallback path for the get_object_info readers: when the C# bridge returns
 * no data (bridge not connected, running without metadata access, or its DiskProvider
 * simply does not cover that package), the symbol index usually still knows the object
 * — `search` finds it. Reporting "not found" in that situation is wrong and has burned
 * agents repeatedly (see eval corpus: EDT "Bridge returned no data" while the same EDTs
 * resolved through search / validate_code).
 *
 * This module resolves an indexed object to a readable local XML string:
 *   1. symbol index row (case-insensitive, index-safe via lookupSymbolNocase)
 *   2. the indexed file path if it exists on this machine
 *   3. the same path remapped onto the configured packages root (the DB may store
 *      Azure DevOps build-agent paths)
 *   4. extracted-metadata JSON files, which wrap the XML in a `raw` property
 */

import * as fs from 'fs';
import { promises as fsp } from 'fs';
import { lookupSymbolNocase } from './symbolLookup.js';
import { resolveDbPathLocally } from './metadataResolver.js';
import { getConfigManager, fallbackPackagePath } from './configManager.js';
import { bridgeStartupState, type BridgeReadinessSource } from '../bridge/bridgeReadiness.js';

export interface IndexedObjectRef {
  /** Canonical name as stored in the index (may differ in casing from the request). */
  name: string;
  model: string;
  /** Path recorded in the symbol index — may point at a build agent. */
  indexedPath: string | null;
  /** Readable path on this machine (indexed or remapped), null when unreachable. */
  localPath: string | null;
  /**
   * The index records a PackagesLocalDirectory path whose file is gone from BOTH
   * the recorded location and the local remap — the row outlived the object.
   *
   * Only set for PackagesLocalDirectory paths: a foreign build-agent path that
   * simply does not remap here is unreachable, not deleted, and must not be
   * reported as stale.
   */
  sourceFileMissing: boolean;
}

/** Look up a top-level object in the symbol index and resolve a readable local path. */
export async function resolveIndexedObject(
  db: unknown,
  name: string,
  types: readonly string[],
  modelName?: string,
): Promise<IndexedObjectRef | null> {
  let hit;
  try {
    hit = lookupSymbolNocase(db as any, name, types);
  } catch {
    return null; // DB unavailable
  }
  if (!hit) return null;
  // lookupSymbolNocase matches on name already; re-assert it so a loose caller/DB
  // stub can never make a reader render an unrelated object under the asked name.
  if (hit.name?.toLowerCase() !== name.toLowerCase()) return null;

  const localPath = await resolveLocalPath(hit.file_path);
  return {
    name: hit.name,
    model: modelName || hit.model || 'Unknown',
    indexedPath: hit.file_path,
    localPath,
    sourceFileMissing: await isStaleIndexedPath(hit.file_path, localPath),
  };
}

/** Resolve an indexed file path to something readable here, or null. */
async function resolveLocalPath(indexedPath: string | null): Promise<string | null> {
  if (!indexedPath) return null;
  try {
    if (fs.existsSync(indexedPath)) return indexedPath;
  } catch { /* ignore */ }
  return resolveDbPathLocally(indexedPath);
}

/**
 * Can this machine observe the absence of a PackagesLocalDirectory file at all?
 *
 * "No file at either location" means the object was deleted only if the packages
 * root is actually there to be looked at. An unconfigured, mistyped or
 * momentarily unreachable root (an offline share, a drive not yet mapped) makes
 * EVERY object's file unreadable — and the stale-row note that follows tells the
 * agent to treat the object as not existing and create it, without re-checking.
 * That is a duplicate of something like CustTable on a bad config day, so the
 * root has to be verified before the row is called a ghost.
 */
async function packagesRootReachable(): Promise<boolean> {
  try {
    const configManager = getConfigManager();
    await configManager.ensureLoaded();
    const root = configManager.getPackagePath() || fallbackPackagePath();
    if (!root) return false;
    await fsp.access(root);
    return true;
  } catch {
    return false;
  }
}

/**
 * The one rule for "this index row outlived its file", shared by the ref-carrying
 * readers and the raw-path ones so the two can never drift apart.
 *
 * Only a PackagesLocalDirectory path can be judged: a foreign build-agent path
 * that does not remap here is unreachable, not deleted.
 */
async function isStaleIndexedPath(
  indexedPath: string | null | undefined,
  localPath: string | null,
): Promise<boolean> {
  if (localPath !== null) return false;
  if (!indexedPath || !/PackagesLocalDirectory/i.test(indexedPath)) return false;
  return packagesRootReachable();
}

/**
 * Read XML from a local file. Extracted-metadata JSON files wrap the original XML
 * in a `raw` property — unwrap those transparently. Returns null when unreadable.
 */
export async function readXmlFile(filePath: string): Promise<string | null> {
  let content: string;
  try {
    content = await fsp.readFile(filePath, 'utf-8');
  } catch {
    return null;
  }
  if (content.trimStart().startsWith('{')) {
    try {
      const data = JSON.parse(content);
      return typeof data.raw === 'string' ? data.raw : null;
    } catch {
      return null;
    }
  }
  return content;
}

/** Symbol-index lookup + XML read in one step. Returns null when either step fails. */
export async function readIndexedXml(
  db: unknown,
  name: string,
  types: readonly string[],
  modelName?: string,
): Promise<{ ref: IndexedObjectRef; xml: string } | null> {
  const ref = await resolveIndexedObject(db, name, types, modelName);
  if (!ref?.localPath) return null;
  const xml = await readXmlFile(ref.localPath);
  return xml ? { ref, xml } : null;
}

/**
 * Standard footer for a reader that answered from the index instead of the bridge —
 * makes the provenance (and its limits) explicit to the agent.
 *
 * Pass `ref` whenever one is available so a row that outlived its file is called
 * out rather than rendered as fact — see `staleIndexNote`.
 */
export function indexedSourceNote(source: string, ref?: IndexedObjectRef | null): string {
  return `_Source: ${source} — the C# bridge returned no data for this object._\n\n` +
    (ref ? staleIndexNote(ref) : '');
}

/**
 * Warn when the answer came from a cache whose object is no longer on disk.
 *
 * The extracted-metadata JSON is written at index time and is NOT removed when the
 * AOT XML is deleted, so a reset workspace kept answering `get_object_info` with a
 * complete, confident enum — name, four values, four labels — for a file that did
 * not exist. The agent believed it (the bridge being quiet is normal for
 * not-yet-indexed objects), spent about a quarter of its run proving the object was
 * a ghost, and only then started the real work.
 *
 * The bridge disagreeing with the cache is the tell, and it is available right here:
 * bridge silent + PackagesLocalDirectory path + no file at either the recorded or
 * the remapped location means the row outlived the object.
 */
export function staleIndexNote(ref: IndexedObjectRef): string {
  if (!ref.sourceFileMissing) return '';
  return renderStaleIndexNote(ref.name, ref.indexedPath ?? '(unknown)');
}

/**
 * Is this indexed path a row that outlived its file?
 *
 * For readers that hold a raw `file_path` from a symbol row rather than an
 * `IndexedObjectRef`. Literally the same rule — both go through
 * `isStaleIndexedPath`, so the two can never answer differently about one row.
 */
export async function indexedPathIsMissing(indexedPath: string | null | undefined): Promise<boolean> {
  if (!indexedPath || !/PackagesLocalDirectory/i.test(indexedPath)) return false;
  return isStaleIndexedPath(indexedPath, await resolveLocalPath(indexedPath));
}

/**
 * The same fact, told to a LIST rather than to a reader of one object.
 *
 * `renderStaleIndexNote` answers "you asked for this object and the cache answered
 * for it", so it can end in "treat it as NOT EXISTING and create it". A search
 * result set cannot say that. `indexedPathIsMissing` fires for any
 * PackagesLocalDirectory path with no file here, and the shipped symbol index covers
 * every standard package while a given machine installs a subset — so on a partial
 * install these rows are mostly "that package is not installed", not "deleted". Both
 * causes matter to the caller and neither justifies hiding the row (that would answer
 * "no such object" for most of D365FO, in the tool every other workflow starts from),
 * so name them and let the caller decide.
 */
export function renderStaleSearchRowsNote(count: number): string {
  return `\n⚠️ ${count} result${count === 1 ? '' : 's'} marked STALE: the symbol index records a ` +
    `PackagesLocalDirectory path with no file there or at its local remap, so ${count === 1 ? 'it is' : 'they are'} ` +
    `an index row without an object on this machine — either deleted without the index being rebuilt ` +
    `(a workspace reset, a rolled-back run), or belonging to a package this machine does not have ` +
    `installed. ${count === 1 ? 'It is' : 'They are'} listed last and ${count === 1 ? 'is' : 'are'} NOT ` +
    `evidence the object is usable: read it with get_object_info before building on it, and run ` +
    `update_symbol_index if this workspace was reset.\n`;
}

/** The per-row marker for a stale search hit — see renderStaleSearchRowsNote. */
export const STALE_ROW_MARKER = '⚠️ STALE index row — no file on this machine';

/** The warning text both stale-row paths render. */
export function renderStaleIndexNote(name: string, indexedPath: string): string {
  return `⚠️ STALE INDEX ENTRY — everything above is a cache read, not a live object. ` +
    `The symbol index records \`${indexedPath}\`, and there is no file there or at ` +
    `the local remap of that path. The object was almost certainly deleted (a workspace ` +
    `reset, a rolled-back run) without the index being rebuilt.\n` +
    `➡️  Treat \`${name}\` as NOT EXISTING and create it. Do not spend calls proving ` +
    `this — the file has already been checked on disk. Run \`update_symbol_index\` to ` +
    `drop rows like this one.\n\n`;
}

/**
 * Explain why the bridge produced nothing, so "not found" is never mistaken for
 * "does not exist" when the bridge is simply unavailable.
 *
 * Takes the server context (not just `context.bridge`) so a bridge that is still
 * starting is reported as a cold-start race rather than as a broken config — the
 * conflation behind issue #826.
 */
export function bridgeUnavailableNote(context: BridgeReadinessSource | undefined): string {
  const bridge = context?.bridge;
  if (bridge?.isReady && bridge?.metadataAvailable) return '';
  if (context && bridgeStartupState(context) === 'starting') {
    return `\n⏳ The C# metadata bridge is still starting, so only the symbol index and disk were ` +
      `checked. This is a cold-start race, not a configuration problem — retry in a few seconds ` +
      `before concluding the object does not exist.\n`;
  }
  return `\n⚠️ The C# metadata bridge is ${bridge?.isReady ? 'running without metadata access' : 'not connected'}, ` +
    `so only the symbol index and disk were checked.\n`;
}
