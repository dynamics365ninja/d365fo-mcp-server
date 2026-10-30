/**
 * Enum value names for resolve_references' `Enum::Value` check.
 *
 * The index stores an enum and each of its extensions as one symbol row with the
 * AOT file path, but not the values themselves — so `PurchStatus::NoSuchStatus`
 * used to pass as verified once `PurchStatus` existed, and a wrong value only
 * showed up at build time (#1164).
 *
 * The values are read from the files the index already points at: the AxEnum XML
 * plus every AxEnumExtension XML whose base is that enum. Anything the reader
 * cannot see makes the answer "unknown" (null), never "missing": the resolver's
 * rule is that a false block is worse than a miss.
 *
 * One source has no XML at all: a package shipped compiled only can still add
 * values to an extensible enum. Its only trace is the compiled metadata in
 * `<Package>\bin\<Package>_AxEnumExtension.md`, which names the extension
 * (`LedgerPostingType.Extension`) and its values as plain strings. Before a
 * value is reported missing, those files are searched for it.
 */

import fs from 'fs';
import path from 'path';
import { lookupSymbolsNocase, type DbLike } from '../../utils/symbolLookup.js';

export interface EnumValueSet {
  /** Lower-cased value names from the enum and every indexed extension of it. */
  names: ReadonlySet<string>;
  /** The enum's own spelling, as indexed. */
  enumName: string;
  /** PackagesLocalDirectory roots the files came from — where compiled-only extensions live. */
  packagesRoots: readonly string[];
}

/** Each `<AxEnumValue>` block; value blocks do not nest. */
const VALUE_BLOCK_RE = /<AxEnumValue\b[^>]*>([\s\S]*?)<\/AxEnumValue>/g;

export function enumValueNamesFromXml(xml: string): string[] {
  const names: string[] = [];
  for (const block of xml.matchAll(VALUE_BLOCK_RE)) {
    const name = /<Name>\s*([^<\s]+)\s*<\/Name>/.exec(block[1]);
    if (name) names.push(name[1]);
  }
  return names;
}

function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Every value name an enum has across the index, or null when that cannot be
 * proven: the enum is not indexed, or one of its files cannot be read (a DB built
 * on another machine, a file deleted since the index was built).
 */
export function indexedEnumValueNames(db: DbLike, enumName: string): EnumValueSet | null {
  let enumRows: Array<{ name: string; file_path: string | null }>;
  let extRows: Array<{ file_path: string | null }>;
  try {
    enumRows = lookupSymbolsNocase(db, enumName, { types: ['enum'], limit: 5 });
    if (enumRows.length === 0) return null;
    const canonical = enumRows[0].name;
    // Bounded by the enum-extension type range (~300 rows in a full index), so
    // the NOCASE comparison and the LIKE stay cheap. The name probe catches an
    // extension whose base object was not recorded in parent_name.
    extRows = db.prepare(
      `SELECT file_path FROM symbols
       WHERE type = 'enum-extension'
         AND (parent_name = ? COLLATE NOCASE OR name LIKE ? ESCAPE '\\')`,
    ).all(canonical, `${canonical.replace(/[\\%_]/g, c => `\\${c}`)}.%`) as Array<{ file_path: string | null }>;
  } catch {
    return null;
  }

  const names = new Set<string>();
  const roots = new Set<string>();
  const files = new Set([...enumRows, ...extRows].map(r => r.file_path ?? ''));
  for (const file of files) {
    if (!file || !/\.xml$/i.test(file)) return null;
    const xml = readText(file);
    if (xml === null) return null;
    for (const name of enumValueNamesFromXml(xml)) names.add(name.toLowerCase());
    const root = packagesRootOf(file);
    if (root) roots.add(root);
  }
  return { names, enumName: enumRows[0].name, packagesRoots: [...roots] };
}

/**
 * The PackagesLocalDirectory a file lives under, in the file's OWN spelling.
 * modelDescriptor's packagesRootFromPath rewrites the separators to `\`, which is
 * right for comparing paths and wrong for opening one on a machine whose separator
 * is `/`.
 */
function packagesRootOf(file: string): string | null {
  const m = /^(.*[\\/]PackagesLocalDirectory)(?=[\\/]|$)/i.exec(file);
  return m ? m[1] : null;
}

/** Lower-cased contents of every `bin/*_AxEnumExtension.md` under a root, read once. */
const compiledExtensionCache = new Map<string, string[]>();

function compiledEnumExtensions(packagesRoot: string): string[] {
  const cached = compiledExtensionCache.get(packagesRoot.toLowerCase());
  if (cached) return cached;
  const contents: string[] = [];
  let packages: string[] = [];
  try {
    packages = fs.readdirSync(packagesRoot);
  } catch { /* unreadable root — nothing to add */ }
  for (const pkg of packages) {
    // latin1 keeps every byte as one char, so the ASCII names inside the binary
    // stay intact whatever the length prefixes around them decode to.
    const file = path.join(packagesRoot, pkg, 'bin', `${pkg}_AxEnumExtension.md`);
    try {
      contents.push(fs.readFileSync(file, 'latin1').toLowerCase());
    } catch { /* package without compiled enum extensions */ }
  }
  compiledExtensionCache.set(packagesRoot.toLowerCase(), contents);
  return contents;
}

/**
 * True when compiled metadata may add `value` to `enumName`: some package's
 * compiled enum extensions name an extension of that enum and contain the value.
 * Deliberately loose — it only ever suppresses an error.
 */
export function compiledExtensionMayAddValue(set: EnumValueSet, value: string): boolean {
  const ext = `${set.enumName.toLowerCase()}.`;
  const wanted = value.toLowerCase();
  return set.packagesRoots.some(root =>
    compiledEnumExtensions(root).some(text => text.includes(ext) && text.includes(wanted)),
  );
}

/** Test seam: forget the compiled-extension cache. */
export function resetCompiledEnumExtensionCache(): void {
  compiledExtensionCache.clear();
}
