/**
 * Menus and menu extensions by name, wherever they are: the index, the configured
 * model, or any package folder.
 *
 * The index build extracts no menus, a write-only companion has no index at all, a
 * standard menu lies outside the configured model, and menus have no bridge read —
 * so without the package-folder step a standard menu, and on the companion the
 * extensions of it, are not seen at all. Two callers need the same answers: the
 * menu-extension writers' parent and name checks (directXmlWriters.ts) and
 * get_object_info's menu readers.
 */
import * as fs from 'fs/promises';
import path from 'path';
import { findBaseObjectXml } from './baseObjectXml.js';
import { findAotFilesInAllPackages } from './objectFileLookup.js';

/** The menu's XML: findBaseObjectXml looks in every package folder for a menu. */
export async function readMenuXml(menuName: string, symbolIndex: unknown): Promise<string | null> {
  return findBaseObjectXml('menu', menuName, symbolIndex).catch(() => null);
}

/**
 * The extensions of `baseMenu` (all but `exclude`), name and XML. From the index,
 * or — when it has none (a write-only companion) — from the package folders.
 */
export async function readMenuExtensions(
  baseMenu: string,
  symbolIndex: any,
  exclude?: string,
): Promise<Array<{ name: string; xml: string }>> {
  const prefix = `${baseMenu.toLowerCase()}.`;
  const skip = exclude?.toLowerCase();
  let names: string[] = [];
  try {
    const rows = symbolIndex.getReadDb()
      .prepare(`SELECT DISTINCT name FROM symbols WHERE type = 'menu-extension' AND name LIKE ?`)
      .all(`${baseMenu}.%`) as { name: string }[];
    // LIKE reads `_` as a wildcard, so the prefix is confirmed here.
    names = rows.map(r => r.name).filter(n => n.toLowerCase().startsWith(prefix) && n.toLowerCase() !== skip);
  } catch { /* no index */ }
  if (names.length > 0) {
    const xmls = await Promise.all(names.map(n => findBaseObjectXml('menu-extension', n, symbolIndex).catch(() => null)));
    return names.flatMap((name, i) => (xmls[i] ? [{ name, xml: xmls[i]! }] : []));
  }
  // `.xml` at the end: a modify outside git leaves `<file>.xml.backup-<time>` next to it.
  const files = await findAotFilesInAllPackages('AxMenuExtension', f => {
    const lower = f.toLowerCase();
    return lower.startsWith(prefix) && lower.endsWith('.xml') && lower !== `${skip}.xml`;
  }).catch(() => []);
  const xmls = await Promise.all(files.map(f => fs.readFile(f, 'utf-8').catch(() => null)));
  return files.flatMap((f, i) => (xmls[i] ? [{ name: path.basename(f, '.xml'), xml: xmls[i]! }] : []));
}

/**
 * The extensions of `baseMenu` the index knows — name and model — without reading a
 * file. A read-only server has the index rows but the files of some models only, so
 * for the rest this is all it can say; empty when there is no index.
 */
export function indexedMenuExtensions(baseMenu: string, symbolIndex: any): Array<{ name: string; model: string }> {
  try {
    const rows = symbolIndex.getReadDb()
      .prepare(`SELECT DISTINCT name, model FROM symbols WHERE type = 'menu-extension' AND name LIKE ? ORDER BY name`)
      .all(`${baseMenu}.%`) as Array<{ name: string; model: string }>;
    const prefix = `${baseMenu.toLowerCase()}.`;
    return rows.filter(r => r.name.toLowerCase().startsWith(prefix));
  } catch {
    return [];
  }
}
