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
import { bridgeStartupState, type BridgeReadinessSource } from '../bridge/bridgeReadiness.js';

export interface IndexedObjectRef {
  /** Canonical name as stored in the index (may differ in casing from the request). */
  name: string;
  model: string;
  /** Path recorded in the symbol index — may point at a build agent. */
  indexedPath: string | null;
  /** Readable path on this machine (indexed or remapped), null when unreachable. */
  localPath: string | null;
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

  return {
    name: hit.name,
    model: modelName || hit.model || 'Unknown',
    indexedPath: hit.file_path,
    localPath: await resolveLocalPath(hit.file_path),
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
 */
export function indexedSourceNote(source: string): string {
  return `_Source: ${source} — the C# bridge returned no data for this object._\n\n`;
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
