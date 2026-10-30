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
 *   5. for a form, the gzipped copy the index build stored (form_source)
 */

import * as fs from 'fs';
import { promises as fsp } from 'fs';
import { lookupSymbolNocase } from './symbolLookup.js';
import * as path from 'path';
import { resolveDbPathLocally, remapDbPathLocally } from './metadataResolver.js';
import { getConfigManager, fallbackPackagePath } from './configManager.js';
import { isAotSourcePath } from './packagesRoot.js';
import { bridgeStartupState, type BridgeReadinessSource } from '../bridge/bridgeReadiness.js';
import { gunzipSync } from 'node:zlib';

export interface IndexedObjectRef {
  /** Canonical name as stored in the index (may differ in casing from the request). */
  name: string;
  model: string;
  /**
   * The model of the symbol row itself. `model` above is the caller's `modelName` when
   * one was given, so it cannot key a lookup of the stored copy (form_source).
   */
  indexedModel: string;
  /** Path recorded in the symbol index — may point at a build agent. */
  indexedPath: string | null;
  /** Readable path on this machine (indexed or remapped), null when unreachable. */
  localPath: string | null;
  /**
   * The indexed file is gone from BOTH the recorded location and the local remap,
   * and this machine can tell that means deleted — see isStaleIndexedPath. A
   * foreign build-agent path that simply is not here is unreachable, not deleted,
   * and must not be reported as stale.
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
    indexedModel: hit.model || '',
    indexedPath: hit.file_path,
    localPath,
    sourceFileMissing: await isStaleIndexedPath(hit.file_path, localPath),
  };
}

/** Resolve an indexed file path to something readable here, or null. */
async function resolveLocalPath(indexedPath: string | null): Promise<string | null> {
  if (!indexedPath) return null;
  if (!isAbsoluteAnyHost(slashed(indexedPath))) {
    // Package-relative row (`Pkg/Model/AxTable/X.xml`): it names no root, so try the
    // local metadata roots — never the process cwd, which is the user's home.
    for (const root of await localMetadataRoots()) {
      const candidate = path.join(root, ...slashed(indexedPath).split('/'));
      if (fs.existsSync(candidate)) return candidate;
    }
    return null;
  }
  try {
    if (fs.existsSync(indexedPath)) return indexedPath;
  } catch { /* ignore */ }
  return resolveDbPathLocally(indexedPath);
}

/** Forward-slash form of an indexed path, whichever host wrote it. */
function slashed(p: string): string {
  return p.trim().replace(/\\/g, '/');
}

/**
 * Absolute on ANY host. `path.isAbsolute` on Linux calls `K:\AosService\…` relative,
 * and the hosted (Linux) server reads indexes built on Windows.
 */
function isAbsoluteAnyHost(slashedPath: string): boolean {
  return slashedPath.startsWith('/') || /^[a-zA-Z]:\//.test(slashedPath);
}

/** Parent of a slashed path, or '' at the top. Host-independent, unlike path.dirname. */
function parentOf(slashedPath: string): string {
  const i = slashedPath.lastIndexOf('/');
  return i > 0 ? slashedPath.slice(0, i) : '';
}

/**
 * `<root>/<Package>/<Model>/Ax<Type>/<Name>.xml` → `<root>`, or null when the path
 * does not have the AOT shape (or the root would be a bare drive / filesystem root,
 * which says nothing about where the index was built).
 */
function metadataRootOf(slashedPath: string): string | null {
  const segs = slashedPath.split('/');
  if (segs.length < 5 || !/^Ax\w+$/i.test(segs[segs.length - 2])) return null;
  const root = segs.slice(0, -4).join('/');
  if (!root || /^[a-zA-Z]:$/.test(root)) return null;
  return root;
}

/** Package-relative AOT shape: exactly `<Package>/<Model>/Ax<Type>/<Name>.xml`. */
function isPackageRelativeAotPath(slashedPath: string): boolean {
  const segs = slashedPath.split('/');
  return segs.length === 4 && segs.every(Boolean) && /^Ax\w+$/i.test(segs[2]);
}

/**
 * The metadata roots configured or detected on this machine: the packages root and,
 * on UDE, the custom and Microsoft roots. Only ones that exist are returned.
 */
async function localMetadataRoots(): Promise<string[]> {
  const roots: string[] = [];
  try {
    const cm = getConfigManager() as ReturnType<typeof getConfigManager> & {
      getCustomPackagesPath?: () => Promise<string | null>;
      getMicrosoftPackagesPath?: () => Promise<string | null>;
    };
    await cm.ensureLoaded();
    const candidates = [
      cm.getPackagePath() || fallbackPackagePath(),
      await cm.getCustomPackagesPath?.().catch(() => null),
      await cm.getMicrosoftPackagesPath?.().catch(() => null),
    ];
    for (const r of candidates) {
      if (r && !roots.includes(r) && fs.existsSync(r)) roots.push(r);
    }
  } catch { /* config unavailable — no roots */ }
  return roots;
}

/**
 * Was the index built from THIS root? A root that is here and holds packages is
 * where the indexer read the file from, so a file missing under it was deleted.
 *
 * "Holds packages", not just "exists": UDE boxes routinely carry an EMPTY
 * C:\AosService\PackagesLocalDirectory stub, and an index built on a C: VM must not
 * be judged against it. Cached briefly — search judges a page of rows at once.
 */
const ROOT_VERDICT_TTL_MS = 30_000;
const rootVerdicts = new Map<string, { at: number; populated: boolean }>();
function rootIsPopulatedHere(root: string): boolean {
  const now = Date.now();
  const cached = rootVerdicts.get(root);
  if (cached && now - cached.at < ROOT_VERDICT_TTL_MS) return cached.populated;
  let populated = false;
  try {
    populated = fs.readdirSync(root).length > 0;
  } catch { /* not here */ }
  rootVerdicts.set(root, { at: now, populated });
  return populated;
}

/** Test seam — forget cached root verdicts. */
export function resetStaleRootCache(): void {
  rootVerdicts.clear();
}

/**
 * The lenient test for a path whose root is NOT here: the object's own folder
 * (Ax<Type>) or its model folder exists, yet the file does not. A missing model
 * folder under a foreign root is indistinguishable from "package not installed".
 */
function objectFolderPresent(slashedPath: string): boolean {
  const typeFolder = parentOf(slashedPath);
  const modelFolder = parentOf(typeFolder);
  return (!!typeFolder && fs.existsSync(typeFolder)) || (!!modelFolder && fs.existsSync(modelFolder));
}

/**
 * The one rule for "this index row outlived its file", shared by the ref-carrying
 * readers, the raw-path ones, search row marking and the bridge-less table reader,
 * so none of them can answer differently about one row.
 *
 * Called only once no file was found at the recorded path or its local remap.
 * Whether that absence means "deleted" depends on where the index was built:
 *
 * - BUILT HERE — the recorded path's metadata root (the folder holding the package
 *   folders: a PackagesLocalDirectory, a UDE custom root, a repo) exists on this
 *   machine and holds packages. The indexer read the file from there, so it was
 *   deleted: a rolled-back object, a removed model, a whole package dropped by a
 *   branch switch, a dangling model symlink.
 * - BUILT ELSEWHERE — a CI agent (`/home/vsts/...`, `C:\home\vsts\...`) or an old
 *   UDE version folder. The shipped index records those for every standard object,
 *   so absence proves nothing by itself; only the object's own (Ax<Type>) or model
 *   folder being present at the recorded path or the local remap does. A missing
 *   package there is "not installed" as often as "deleted", and calling every such
 *   row a ghost made the bridge-less reader answer "not found" for CustTable.
 * - Package-relative rows (`Pkg/Model/AxTable/X.xml`) name no root; they get the
 *   lenient test against each local metadata root.
 * - An unreachable or unconfigured packages root makes no folder visible, so it
 *   can never turn every row into a ghost on a bad config day.
 * - A path to the extracted-metadata JSON cache is not the AOT source and proves
 *   nothing either way (see isAotSourcePath).
 */
async function isStaleIndexedPath(
  indexedPath: string | null | undefined,
  localPath: string | null,
): Promise<boolean> {
  if (localPath !== null) return false;
  if (!isAotSourcePath(indexedPath)) return false;
  const recorded = slashed(indexedPath);

  if (!isAbsoluteAnyHost(recorded)) {
    if (!isPackageRelativeAotPath(recorded)) return false;
    const roots = await localMetadataRoots();
    return roots.some(r => objectFolderPresent(`${slashed(r).replace(/\/+$/, '')}/${recorded}`));
  }

  const root = metadataRootOf(recorded);
  if (root && rootIsPopulatedHere(root)) return true;

  if (objectFolderPresent(recorded)) return true;
  const remapped = await remapDbPathLocally(indexedPath);
  return !!remapped && objectFolderPresent(slashed(remapped));
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

/**
 * The gzipped AxForm XML the index build stored for a form (form_source), or null.
 *
 * Keyed by the symbol row's own model, case-insensitively (the build's model directory
 * and the model parsed from a path can differ in case). Never falls back to another
 * model's row: that would render a different form's XML under this one's name. Any
 * failure — an old database without the table, a stub DB, a corrupt blob — is a miss (null).
 */
export function readStoredFormXml(
  db: unknown,
  formName: string,
  model: string,
): { xml: string; storedAt: string } | null {
  try {
    const row = (db as any)
      .prepare('SELECT xml_gz, indexed_at FROM form_source WHERE form_name = ? AND model = ? COLLATE NOCASE ORDER BY indexed_at DESC LIMIT 1')
      .get(formName, model) as { xml_gz?: unknown; indexed_at?: unknown } | undefined;
    if (!row || !(row.xml_gz instanceof Uint8Array)) return null;
    const xml = gunzipSync(row.xml_gz).toString('utf-8');
    if (!xml) return null;
    return { xml, storedAt: typeof row.indexed_at === 'string' ? row.indexed_at : '' };
  } catch {
    return null;
  }
}

/**
 * Symbol-index lookup + XML read in one step. Returns null when either step fails.
 *
 * For a form with no readable file, the copy stored in the index (form_source) answers
 * instead — except when this machine can tell the file was deleted (`sourceFileMissing`):
 * a leftover row would then present a deleted form as fact. `source` says which one
 * answered so the reader can label a stored copy.
 */
export async function readIndexedXml(
  db: unknown,
  name: string,
  types: readonly string[],
  modelName?: string,
): Promise<{ ref: IndexedObjectRef; xml: string; source: 'file' | 'stored'; storedAt?: string } | null> {
  const ref = await resolveIndexedObject(db, name, types, modelName);
  if (!ref) return null;
  if (ref.localPath) {
    const xml = await readXmlFile(ref.localPath);
    if (xml) return { ref, xml, source: 'file' };
  }
  if (!types.includes('form') || ref.sourceFileMissing) return null;
  const stored = readStoredFormXml(db, ref.name, ref.indexedModel);
  return stored ? { ref, xml: stored.xml, source: 'stored', storedAt: stored.storedAt } : null;
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
 * bridge silent + no file at either the recorded or the remapped location + a
 * place where its absence is observable (see isStaleIndexedPath) means the row
 * outlived the object.
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
  if (!indexedPath) return false;
  return isStaleIndexedPath(indexedPath, await resolveLocalPath(indexedPath));
}

/**
 * The same fact, told to a LIST rather than to a reader of one object.
 *
 * `renderStaleIndexNote` answers "you asked for this object and the cache answered
 * for it", so it can end in "treat it as NOT EXISTING and create it". A search
 * result set cannot say that. `indexedPathIsMissing` fires when the root the index
 * was built from is here without the file, or when the object's folder is here
 * without it — and a package uninstalled since the index was built looks exactly
 * like one deleted. Both
 * causes matter to the caller and neither justifies hiding the row (that would answer
 * "no such object" for most of D365FO, in the tool every other workflow starts from),
 * so name them and let the caller decide.
 */
export function renderStaleSearchRowsNote(count: number): string {
  return `\n⚠️ ${count} result${count === 1 ? '' : 's'} marked STALE: the symbol index records a ` +
    `path with no file there or at its local remap, so ${count === 1 ? 'it is' : 'they are'} ` +
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
