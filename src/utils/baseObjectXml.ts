/**
 * Locate a base (non-extension) AOT object's XML on disk.
 *
 * Lived inside modifyD365File.ts, which meant `tools/smart/generateSmartForm.ts`
 * imported a 5,600-line WRITE TOOL to read a form's XML — a generator reaching
 * into a writer, and one of the edges keeping that file growing. Nothing here
 * needs the modify tool: it is the config manager plus two helpers that already
 * live in this folder.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { getConfigManager, fallbackPackagePath } from './configManager.js';
import { resolveDbPathLocally } from './metadataResolver.js';
import { findAotFilesInAllPackages, findD365FileOnDisk } from './objectFileLookup.js';
import { readIndexedXml, symbolTypesFor } from './indexedXmlLookup.js';

/**
 * Locate the base form XML on disk, trying DB path → remapped path → filesystem scan.
 * Returns raw XML content, or null if not accessible.
 */
export async function findBaseFormXml(baseFormName: string, symbolIndex: any): Promise<string | null> {
  return findBaseObjectXml('form', baseFormName, symbolIndex);
}

/**
 * Locate the XML of a base (non-extension) object on disk, trying DB path →
 * remapped path → filesystem scan. `objectType` is both the symbols-table type
 * and the findD365FileOnDisk key ('form', 'table', …).
 * Returns raw XML content, or null if not accessible.
 */
export async function findBaseObjectXml(
  objectType: string,
  objectName: string,
  symbolIndex: any,
): Promise<string | null> {
  // Helper: read a file, transparently following JSON metadata proxies.
  async function tryRead(p: string): Promise<string | null> {
    try {
      const raw = await fs.readFile(p, 'utf-8');
      if (raw.trimStart().startsWith('{')) {
        const data = JSON.parse(raw);
        if (data.sourcePath) {
          try { return await fs.readFile(data.sourcePath, 'utf-8'); } catch { return null; }
        }
        return null;
      }
      return raw;
    } catch { return null; }
  }

  // 1. Symbol DB lookup
  let dbFilePath: string | null = null;
  try {
    const rdb = symbolIndex.getReadDb();
    const row = rdb.prepare(
      `SELECT file_path FROM symbols WHERE type = ? AND name = ? LIMIT 1`
    ).get(objectType, objectName) as any;
    if (row?.file_path) dbFilePath = row.file_path;
  } catch { /* ignore */ }

  if (dbFilePath) {
    // Try absolute DB path as-is
    const direct = await tryRead(dbFilePath);
    if (direct) return direct;

    // DB stored a relative path — join with configured packagePath
    if (!path.isAbsolute(dbFilePath)) {
      const cm = getConfigManager();
      await cm.ensureLoaded();
      const pkgPath = cm.getPackagePath() || fallbackPackagePath();
      const abs = await tryRead(path.join(pkgPath, dbFilePath));
      if (abs) return abs;
    }

    // Build-agent path remapping (e.g. /home/vsts/... → local PackagesLocalDirectory)
    const remapped = await resolveDbPathLocally(dbFilePath);
    if (remapped) {
      const content = await tryRead(remapped);
      if (content) return content;
    }
  }

  // 2. Filesystem scan using model from config
  const diskPath = await findD365FileOnDisk(objectType, objectName);
  if (diskPath) {
    const content = await tryRead(diskPath);
    if (content) return content;
  }

  // 2b. A type the index build never extracts has no symbols row, so steps 1 and 3
  //     cannot find it, and step 2 looks in the configured model only — a STANDARD
  //     object of that type would never be read. Look in every model of every
  //     package root instead (~3,000 probes, ~200 ms on a full PackagesLocalDirectory).
  const unindexedFolder = UNINDEXED_AOT_FOLDERS[objectType];
  if (unindexedFolder) {
    const fileName = `${objectName.toLowerCase()}.xml`;
    const [found] = await findAotFilesInAllPackages(unindexedFolder, n => n.toLowerCase() === fileName);
    if (found) {
      const content = await tryRead(found);
      if (content) return content;
    }
  }

  // 3. The copy the index stored (database-only hosts), after every file probe so a
  //    local edit since indexing wins. Never for a file this host knows is deleted.
  try {
    const found = await readIndexedXml(symbolIndex.getReadDb(), objectName, symbolTypesFor(objectType));
    if (found) return found.xml;
  } catch { /* ignore */ }

  return null;
}

/**
 * Object types scripts/extract-metadata.ts does not extract, so the symbol index
 * has no row for a shipped one: an AxMenu (OrganizationAdministration, …) is
 * reachable only on disk.
 */
const UNINDEXED_AOT_FOLDERS: Record<string, string> = { menu: 'AxMenu' };
