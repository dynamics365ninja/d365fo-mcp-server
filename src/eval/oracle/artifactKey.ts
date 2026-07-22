/**
 * Multi-artifact filename → stable logical key, for pairing a committed golden
 * artifact with the actual file that reproduces it.
 *
 * Golden dirs under `eval/goldens/` use TWO filename conventions
 * (docs/eval-sweep-findings-2026-07-21.md #2):
 *
 *   legacy   `DemoEnumExtProbe.AxClass.metadata.xml`   — UNPREFIXED stem plus an
 *            `.Ax<Type>` infix, although the file CONTENT is `Con`-prefixed
 *            (`<Name>ConDemoEnumExtProbe</Name>`)
 *   current  `ConDemoEnumExtProbe.metadata.xml`        — prefixed stem, no infix
 *
 * while the actual artifact copied off the VM is always named after the object
 * as it exists on disk (`ConDemoEnumExtProbe.metadata.xml`). Comparing raw
 * filenames — or prefix-canonicalised filenames — therefore paired NOTHING for a
 * legacy dir, and the whole artifact scored as missing + extra even when its
 * content was byte-identical.
 *
 * Rather than renaming committed goldens (a golden's bytes are the regression
 * anchor), both sides are reduced to the same logical key:
 *
 *   1. drop the `.metadata.xml` suffix,
 *   2. drop a legacy `.Ax<Type>` type infix,
 *   3. drop a `.<prefix>Extension` dot-notation extension marker,
 *   4. canonicalise the EXTENSION_PREFIX to `PFX` (see `canonicalizePrefix`),
 *   5. drop a LEADING `PFX` — legacy golden filenames omit the prefix the file
 *      content carries, so prefixed and unprefixed stems must compare equal.
 *
 * Steps 2/3/5 are lossy, so `artifactKeyMap` refuses to apply them where they
 * would make two DIFFERENT filenames on the same side collide (e.g. a dir
 * holding both `CustGroup` and `CustGroup.ConExtension`): a colliding name keeps
 * its raw filename as its key, degrading to the previous exact-match behaviour
 * instead of silently diffing an extension against its base object.
 */

import { canonicalizePrefix, PREFIX_PLACEHOLDER, type PrefixSpec } from './prefix.js';

const METADATA_SUFFIX = /\.metadata\.xml$/i;
/** Legacy `<Name>.AxClass` / `.AxTable` / `.AxEnumExtension` … type infix. */
const TYPE_INFIX = /\.Ax[A-Z][A-Za-z]*$/;
/** Dot-notation extension marker, once the prefix has been canonicalised. */
const EXTENSION_MARKER = new RegExp(`\\.${PREFIX_PLACEHOLDER}Extension$`);

/**
 * Reduce one artifact filename to its logical key. Exported for tests; callers
 * pairing a SET of names should use `artifactKeyMap`, which additionally
 * protects against two names collapsing onto the same key.
 */
export function artifactKey(filename: string, prefix: PrefixSpec = ''): string {
  const hadMetadataSuffix = METADATA_SUFFIX.test(filename);
  let stem = filename.replace(METADATA_SUFFIX, '').replace(TYPE_INFIX, '');
  stem = canonicalizePrefix(stem, prefix).replace(EXTENSION_MARKER, '');
  if (stem.startsWith(PREFIX_PLACEHOLDER)) stem = stem.slice(PREFIX_PLACEHOLDER.length);
  return hadMetadataSuffix ? `${stem}.metadata.xml` : stem;
}

/**
 * Key every name in `names` (one side of a diff), keeping a name's RAW filename
 * as its key whenever the reduced key is not unique within that side. Returns a
 * `filename → key` map.
 */
export function artifactKeyMap(names: readonly string[], prefix: PrefixSpec = ''): Map<string, string> {
  const counts = new Map<string, number>();
  for (const name of names) {
    const key = artifactKey(name, prefix);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const out = new Map<string, string>();
  for (const name of names) {
    const key = artifactKey(name, prefix);
    out.set(name, (counts.get(key) ?? 0) > 1 ? name : key);
  }
  return out;
}
