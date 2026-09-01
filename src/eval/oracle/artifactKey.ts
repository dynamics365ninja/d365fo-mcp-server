/**
 * Multi-artifact filename → stable logical key, for pairing a committed golden
 * artifact with the actual file that reproduces it.
 *
 * Golden dirs under `eval/goldens/` use TWO filename conventions
 * (the 2026-07-21 eval sweep, finding #2):
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
 *   3. drop a `.<prefix>…Extension` dot-notation extension marker,
 *   4. canonicalise the EXTENSION_PREFIX to `PFX` (see `canonicalizePrefix`),
 *   5. drop a LEADING `PFX` — legacy golden filenames omit the prefix the file
 *      content carries, so prefixed and unprefixed stems must compare equal.
 *
 * Steps 2/3/5 are lossy, so `artifactKeyMap` refuses to apply them where they
 * would make two DIFFERENT filenames on the same side collide (e.g. a dir
 * holding both `CustGroup` and `CustGroup.ConExtension`): a colliding name is
 * qualified by its AOT TYPE where the type is known (`…#AxTable` vs
 * `…#AxTableExtension` — still prefix-agnostic, so both sides of a diff derive
 * the same key), and otherwise keeps its raw filename, degrading to the previous
 * exact-match behaviour instead of silently diffing an extension against its
 * base object.
 *
 * THE TYPE IS INFORMATION, NOT NOISE. Step 2 exists for the legacy convention,
 * but a display menu item named after the form it opens is a standard D365FO
 * shape (a table's `FormRef` takes a MENU ITEM name, so the pairing is forced),
 * and a flat `--actual-dir` cannot hold two files called `Foo.xml` — the
 * `.Ax<Type>` infix is then the ONLY thing telling them apart. So the key is
 * deliberately lossy and every CALLER that must not guess (see
 * `actualArtifactResolution.ts`) disambiguates with `artifactType` on top of it.
 */

import { canonicalizePrefix, PREFIX_PLACEHOLDER, type PrefixSpec } from './prefix.js';

const METADATA_SUFFIX = /\.metadata\.xml$/i;
/** Any AOT/golden xml suffix — `.metadata.xml` or the bare `.xml` the VM writes. */
const ANY_XML_SUFFIX = /(\.metadata)?\.xml$/i;
/** Legacy `<Name>.AxClass` / `.AxTable` / `.AxEnumExtension` … type infix. */
const TYPE_INFIX = /\.(Ax[A-Z][A-Za-z0-9]*)$/;
/**
 * Dot-notation extension marker, once the prefix has been canonicalised.
 * Matches `.PFXExtension` AND `.PFX<Anything>Extension`: the extension object's
 * own suffix is session-chosen, so the same enum extension was captured as
 * `NumberSeqModule.ConDemoExtension` and reproduced as
 * `NumberSeqModule.ConExtension` — byte-identical content, 3 paths reported
 * missing (corpus: 2026-08-31T22__L3-numberseq-module-slice__278eee3, finding 3).
 */
const EXTENSION_MARKER = new RegExp(`\\.${PREFIX_PLACEHOLDER}[A-Za-z0-9_]*Extension$`);

/** Reduce a bare stem (no `.xml` suffix, no type infix) to its prefix-agnostic form. */
function canonicalStem(stem: string, prefix: PrefixSpec): string {
  let out = canonicalizePrefix(stem, prefix).replace(EXTENSION_MARKER, '');
  if (out.startsWith(PREFIX_PLACEHOLDER)) out = out.slice(PREFIX_PLACEHOLDER.length);
  return out;
}

/**
 * Reduce one artifact filename to its logical key. Exported for tests; callers
 * pairing a SET of names should use `artifactKeyMap`, which additionally
 * protects against two names collapsing onto the same key.
 */
export function artifactKey(filename: string, prefix: PrefixSpec = ''): string {
  const hadMetadataSuffix = METADATA_SUFFIX.test(filename);
  const stem = canonicalStem(
    filename.replace(METADATA_SUFFIX, '').replace(TYPE_INFIX, ''),
    prefix,
  );
  return hadMetadataSuffix ? `${stem}.metadata.xml` : stem;
}

/**
 * The `.Ax<Type>` type infix a filename carries, if any
 * (`ConX.AxMenuItemDisplay.metadata.xml` → `AxMenuItemDisplay`). This is the
 * capture convention for "two objects of different types share one name", so it
 * must survive the lossy key.
 */
export function typeInfixOf(filename: string): string | undefined {
  return TYPE_INFIX.exec(filename.replace(ANY_XML_SUFFIX, ''))?.[1];
}

/**
 * One prologue token: a comment, a processing instruction, a doctype, or the
 * start tag whose name is captured. Ordered so the skippable forms win, which is
 * what makes this safe without a sanitising `replace()`.
 *
 * The UNTERMINATED comment and PI branches are load-bearing, not defensive
 * padding. Without them the scanner merely fails to match at the `<!--` and
 * then advances one position and happily matches an element name INSIDE the
 * comment — which is the same class of bug as the single-pass strip this
 * replaced. Consuming to end-of-input instead stops the scan, so a document
 * whose remainder is commented out reports no root element, which is the honest
 * answer.
 */
const PROLOGUE_TOKEN = /<!--[\s\S]*?-->|<!--[\s\S]*$|<\?[\s\S]*?\?>|<\?[\s\S]*$|<!DOCTYPE[^>]*>|<\s*([A-Za-z_][\w.\-]*)[\s>/]/gi;

/**
 * The document's root element — `AxForm`, `AxMenuItemDisplay`, `AxTableExtension`,
 * … — i.e. the artifact's AOT type as the file itself declares it. Ground truth,
 * and available for both goldens and actual files, so it beats any filename
 * convention. Returns undefined for a document with no readable root element.
 */
export function aotRootElement(xml: string | undefined): string | undefined {
  if (!xml) return undefined;
  // Walk the prologue token by token rather than stripping comments/PIs with
  // replace(): a single-pass strip leaves a stray `<!--` behind on malformed
  // input (CodeQL js/incomplete-multi-character-sanitization) and can then read
  // markup out of a comment. Consuming alternatives IN ORDER cannot: an
  // unterminated comment simply never matches the element branch.
  PROLOGUE_TOKEN.lastIndex = 0;
  let token: RegExpExecArray | null;
  while ((token = PROLOGUE_TOKEN.exec(xml)) !== null) {
    if (token[1]) return token[1];
  }
  return undefined;
}

/** The object name the document declares (its first `<Name>`), if readable. */
export function declaredObjectNameOf(xml: string | undefined): string | undefined {
  if (!xml) return undefined;
  return /<Name>([^<]+)<\/Name>/.exec(xml)?.[1]?.trim() || undefined;
}

/**
 * The artifact's AOT type: what the file says it is, else what its filename's
 * `.Ax<Type>` infix says. Content wins — a filename convention is a hint, the
 * root element is the object.
 */
export function artifactType(filename: string, xml?: string): string | undefined {
  return aotRootElement(xml) ?? typeInfixOf(filename);
}

/**
 * The artifact's prefix-agnostic logical identity: `{ stem, type }`.
 *
 * `stem` comes from the object name the document DECLARES when the content is
 * available (the only signal that survives every filename convention in the
 * corpus — legacy `.Ax<Type>` stems, `.menuitem` suffixes, hand-abbreviated
 * stems like `NumberSeqModuleExt`), and from the filename otherwise.
 */
export function artifactIdentity(
  filename: string,
  xml: string | undefined,
  prefix: PrefixSpec,
): { stem: string; type?: string } {
  const declared = declaredObjectNameOf(xml);
  const fromFilename = filename.replace(ANY_XML_SUFFIX, '').replace(TYPE_INFIX, '');
  return {
    stem: canonicalStem(declared ?? fromFilename, prefix),
    type: artifactType(filename, xml),
  };
}

/** Qualify a logical key with an AOT type, keeping the `.metadata.xml` shape readable. */
function qualify(key: string, type: string): string {
  return METADATA_SUFFIX.test(key)
    ? `${key.replace(METADATA_SUFFIX, '')}#${type}.metadata.xml`
    : `${key}#${type}`;
}

/**
 * Key every name in `names` (one side of a diff), keeping a name's RAW filename
 * as its key whenever the reduced key is not unique within that side. Returns a
 * `filename → key` map.
 *
 * `contentOf` (optional) supplies each artifact's XML so a collision can be
 * broken by AOT TYPE first. That fallback is strictly better than the raw
 * filename, because it stays prefix- and convention-agnostic: a golden pair
 * (`ConX.metadata.xml` = AxForm, `ConX.AxMenuItemDisplay.metadata.xml`) and the
 * files reproducing it under a different prefix session
 * (`ContosoX.xml`, `ContosoX.AxMenuItemDisplay.xml`) derive the SAME two keys,
 * where raw-filename degradation made every path of both artifacts
 * missing + extra.
 *
 * KNOWN GAP (measured 2026-08-31, not fixed here). Qualification is applied only
 * to a side that COLLIDES, so it is asymmetric when one side collides and the
 * other does not: a golden pair named `X.metadata.xml` + `X.menuitem.metadata.xml`
 * (the `.menuitem` convention, 6 dirs) does not collide, while the AOT files
 * reproducing it (`X.xml` + `X.AxMenuItemOutput.xml`) do — so the two sides key
 * differently and the diff reports wholesale missing + extra even though
 * `resolveActualFile` paired them correctly. Same for a hand-abbreviated golden
 * stem (`CustGroupFormExt`, `NumberSeqModuleExt`). 9 golden dirs are affected
 * under an AOT-named `--actual-dir`; none under the mirrored filenames captures
 * actually use today, which is why this is latent rather than live. The real fix
 * is to derive the multi-artifact key from the artifact's IDENTITY
 * (`artifactIdentity`) rather than its filename — a change to the `<key>::` path
 * format that also appears in committed corpus records, so it wants its own
 * review rather than a ride-along.
 */
export function artifactKeyMap(
  names: readonly string[],
  prefix: PrefixSpec = '',
  contentOf?: (name: string) => string | undefined,
): Map<string, string> {
  const base = new Map(names.map(n => [n, artifactKey(n, prefix)]));
  const count = (keys: Iterable<string>): Map<string, number> => {
    const c = new Map<string, number>();
    for (const k of keys) c.set(k, (c.get(k) ?? 0) + 1);
    return c;
  };

  // Type-qualify only the names whose plain key collides, so a dir with no
  // collision keeps exactly the keys it has always had.
  const collides = count(base.values());
  const qualified = new Map<string, string>();
  for (const name of names) {
    const key = base.get(name)!;
    if ((collides.get(key) ?? 0) < 2) { qualified.set(name, key); continue; }
    const type = artifactType(name, contentOf?.(name));
    qualified.set(name, type ? qualify(key, type) : key);
  }

  // Whatever still collides (same object name AND same type, or no type at all)
  // keeps its raw filename — exact-match behaviour, never a silent cross-diff.
  const stillCollides = count(qualified.values());
  const out = new Map<string, string>();
  for (const name of names) {
    const key = qualified.get(name)!;
    out.set(name, (stillCollides.get(key) ?? 0) > 1 ? name : key);
  }
  return out;
}
