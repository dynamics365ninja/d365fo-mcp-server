/**
 * AOT XML normalizer for the eval golden oracle.
 *
 * Flattens an AOT metadata XML document into a stable `path → value` map so two
 * documents can be diffed structurally (not textually). Key properties:
 *
 *  - Collection members (AxTableField, AxEnumValue, AxTableFieldGroup, …) are
 *    keyed by their `<Name>`/`<DataField>` rather than position, so reordering an
 *    unordered collection does not register as a diff.
 *  - Volatile nodes (`ModelSaveInfo`, `@Id`) and any per-case `ignore` globs are
 *    stripped before the map is built.
 *  - Attributes are included (notably `i:type`, which carries a field's base type
 *    e.g. AxTableFieldInt vs AxTableFieldString) under `@type` etc.
 *
 * See docs/AGENT_EVAL_LOOP.md §6.2.
 */

import { parseStringPromise } from 'xml2js';
import { reindentXppSource } from '../../utils/xppFormat.js';
import { canonicalizePrefix, type PrefixSpec } from './prefix.js';
import { artifactKeyMap } from './artifactKey.js';

/**
 * Built-in ignores applied to every document (in addition to per-case globs).
 * The volatile object id appears as either an `@Id` attribute or an `<Id>`
 * element depending on the serializer — strip both.
 */
const DEFAULT_IGNORES = ['**/ModelSaveInfo', '**/ModelSaveInfo/**', '**/@Id', '**/Id'];

/**
 * The EXTENSION_PREFIX in effect when the committed `eval/goldens/` corpus was
 * authored (docs/AGENT_EVAL_LOOP.md §6.4). A golden's root object Name (and any
 * other prefixed identifier baked into it, e.g. an extension's added field
 * DataField, or a dot-notation extension suffix) is a literal string captured
 * under THIS prefix — it is not re-derived per run.
 *
 * A later eval run is free to configure ANY EXTENSION_PREFIX for its sandbox
 * session (e.g. "Demo") — `d365fo_file`/`generate_object` correctly apply the
 * CURRENT session's prefix to every new object per their documented contract
 * (src/utils/modelClassifier.ts). An object named "DemoXyzNoteSubject" and a
 * golden named "ContosoXyzNoteSubject" describe the SAME object under two
 * different prefix sessions — that is not a semantic difference, and must not
 * fail `golden_match` (see the corpus record that surfaced this:
 * eval/corpus/runs/2026-07-06T10__L0-edt-basic__4fafcd8.json).
 */
export const GOLDEN_CAPTURE_PREFIX = 'Contoso';

/**
 * EVERY EXTENSION_PREFIX the committed `eval/goldens/` corpus was captured
 * under. The corpus was NOT captured under a single prefix: the bulk of it uses
 * the short token `Con` (`ConDemoNoteSubject`, `CustGroup.ConExtension`, …)
 * while `GOLDEN_CAPTURE_PREFIX` — the single-prefix default every caller
 * inherited — is `Contoso`. Because `canonicalizePrefix` requires the prefix to
 * be followed by an uppercase letter, "Contoso" never matches a `Con`-captured
 * identifier (`Con` + `t` is lowercase), so the golden side of a diff was in
 * practice NEVER canonicalised. Scoring then only worked when the operator
 * hand-passed `--golden-prefix Con --actual-prefix Con`, and passing just one of
 * the two produced a false mismatch (`golden="PFXDemoEnumExtProbe"` vs
 * `actual="ConDemoEnumExtProbe"`).
 *
 * Canonicalising against the whole set (longest-first, so `Contoso` is consumed
 * before `Con` can bite into it) makes prefix resolution tolerant instead of
 * requiring the goldens to be renamed — see docs/eval-sweep-findings-2026-07-21.md #2.
 */
export const GOLDEN_CAPTURE_PREFIXES: readonly string[] = ['Contoso', 'Con'];

export { canonicalizePrefix, PREFIX_PLACEHOLDER, type PrefixSpec } from './prefix.js';

/** Compile a path glob (`**`, `*`, literal) to an anchored RegExp. */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        // `**/` → any number of leading segments; `**` → anything
        if (glob[i + 2] === '/') { re += '(?:.*/)?'; i += 2; }
        else { re += '.*'; i += 1; }
      } else {
        re += '[^/]*';
      }
    } else if (/[.+^${}()|[\]\\]/.test(c)) {
      re += '\\' + c;
    } else {
      re += c;
    }
  }
  return new RegExp('^' + re + '$');
}

/** Strip `[discriminator]` suffixes so globs written against the element shape match. */
function shapeOf(path: string): string {
  return path.replace(/\[[^\]]*\]/g, '');
}

function isIgnored(path: string, matchers: RegExp[]): boolean {
  const shape = shapeOf(path);
  return matchers.some(m => m.test(shape) || m.test(path));
}

/**
 * Is this path an X++ source-code element (`.../Source` or `.../Declaration`)?
 * These hold CDATA method bodies / class declarations — X++ is whitespace-
 * insensitive for indentation, so two builds that differ only in indent depth
 * are semantically identical and must not register as a `golden_match` diff
 * (see `canonicalizeXppSourceText` below).
 */
function isXppSourcePath(pathPrefix: string): boolean {
  return /\/(Source|Declaration)$/.test(pathPrefix);
}

/**
 * Re-derive indentation from brace depth alone (baseDepth 0), discarding
 * whatever indentation convention the text actually used. Applied identically
 * to both the golden and the actual side of a diff, so — per §6.2 of
 * docs/AGENT_EVAL_LOOP.md ("canonicalise element ordering and whitespace") —
 * two method bodies with identical tokens but different indentation compare
 * equal. Reuses the same brace-depth algorithm the generators use to emit
 * X++ source (src/utils/xppFormat.ts), so this is a comparison-time-only
 * canonicalisation — it never rewrites a stored artifact.
 */
function canonicalizeXppSourceText(s: string): string {
  return canonicalizeXppDocComments(reindentXppSource(s, 0));
}

/**
 * Placeholder a contiguous run of `///` XmlDoc lines collapses to.
 * Deliberately still a `///` line: PRESENCE of a doc comment survives the
 * canonicalisation, only its PROSE is discarded (see below).
 */
export const XMLDOC_PLACEHOLDER = '/// <xmldoc/>';

/**
 * Collapse every contiguous run of `///` XmlDoc lines to a single placeholder
 * line, keeping the run's own (already re-derived) indentation.
 *
 * Why: `///` doc-comment WORDING is not pinned by any case instruction, and
 * `d365fo_file` auto-injects a class-level doc comment whose text is generated
 * from the object name. A faithful rerun by an agent that writes different
 * prose therefore scored `golden_match: 0` for a purely cosmetic reason —
 * corpus-wide oracle fragility, docs/eval-sweep-findings-2026-07-21.md #24.
 *
 * Why COLLAPSE rather than STRIP (the direction the finding suggested):
 * deleting `///` lines outright would also make a golden that HAS a doc comment
 * compare equal to an actual that has NONE — and the presence of a doc header is
 * exactly what the `BPXmlDocNoDocumentationComments` best-practice rule (and
 * therefore the `bp_clean` dimension) measures. Stripping would mask a real,
 * BP-visible content difference. Collapsing keeps "a doc comment exists here,
 * attached to this declaration" load-bearing while making its wording free.
 *
 * `///` inside a string literal is not special-cased: X++ string literals use
 * single quotes and a `///` run is only recognised at the START of a line, so
 * the only way to hit that is a multi-line literal whose continuation line
 * begins with `///` — not expressible in X++.
 */
function canonicalizeXppDocComments(s: string): string {
  const out: string[] = [];
  let inRun = false;
  for (const line of s.split('\n')) {
    const m = /^(\s*)\/\/\//.exec(line);
    if (m) {
      if (!inRun) out.push(`${m[1]}${XMLDOC_PLACEHOLDER}`);
      inRun = true;
      continue;
    }
    inRun = false;
    out.push(line);
  }
  return out.join('\n');
}

/**
 * Normalize text content: CRLF -> LF (the C# bridge writes CRLF into <Source>
 * CDATA; a golden authored or diffed on a different platform may use LF — that
 * is a whitespace-style difference, not a semantic one) then trim. X++ source
 * elements (`Source`/`Declaration`) additionally get indentation canonicalised
 * (see `canonicalizeXppSourceText`) since X++ doesn't care about indent depth.
 */
function normalizeText(s: string, pathPrefix?: string): string {
  const crlfNormalized = s.replace(/\r\n/g, '\n').trim();
  return pathPrefix && isXppSourcePath(pathPrefix)
    ? canonicalizeXppSourceText(crlfNormalized)
    : crlfNormalized;
}

/** A node's OWN Name/DataField, if any (no recursion). */
function ownName(node: Record<string, unknown>): string | undefined {
  for (const key of ['Name', 'DataField']) {
    const v = node[key];
    if (Array.isArray(v) && typeof v[0] === 'string') return v[0].trim();
    if (typeof v === 'string') return (v as string).trim();
  }
  return undefined;
}

/**
 * Is `name` an auto-generated wrapper id for element `tag`? The D365FO bridge
 * builds internal wrapper identifiers (e.g. AxFormExtensionControl's own
 * <Name>) as `<tag without "Ax"><random lowercase/digit suffix>` — e.g. tag
 * "AxFormExtensionControl" → "FormExtensionControlfse38xiwz". These exist only
 * to satisfy the wrapper element's own required Name property; they carry no
 * author intent and differ on every independent regeneration of the same
 * logical object, unlike a real X++ identifier (which uses PascalCase/
 * underscores, never an all-lowercase random tail).
 */
function looksAutoGenerated(name: string, tag: string): boolean {
  const unprefixed = tag.replace(/^Ax/, '');
  if (unprefixed.length === 0 || !name.startsWith(unprefixed)) return false;
  const suffix = name.slice(unprefixed.length);
  return suffix.length >= 4 && /^[a-z0-9]+$/.test(suffix);
}

/**
 * Look one level into `node`'s child ELEMENTS (skipping attrs/text and the
 * own Name/DataField already tried) for a nested object carrying its own
 * non-auto-generated Name/DataField — e.g. AxFormExtensionControl/FormControl
 * /Name. Returns the first candidate found, in document order.
 */
function nestedName(node: Record<string, unknown>): string | undefined {
  for (const [key, value] of Object.entries(node)) {
    if (key === '$' || key === '_' || key === 'Name' || key === 'DataField') continue;
    const candidates = Array.isArray(value) ? value : [value];
    for (const child of candidates) {
      if (child && typeof child === 'object' && !Array.isArray(child)) {
        const childName = ownName(child as Record<string, unknown>);
        if (childName !== undefined && !looksAutoGenerated(childName, key)) return childName;
      }
    }
  }
  return undefined;
}

/**
 * A child's stable key within a collection. Prefers its own Name/DataField,
 * UNLESS that value looks like an auto-generated wrapper id for `tag` (its own
 * element name) — in which case a nested stable name is used instead so two
 * independently-generated artifacts naming the same logical object (same
 * nested name, different random wrapper id) align under the same key rather
 * than false-mismatching on the whole subtree.
 */
function discriminator(node: Record<string, unknown>, tag: string | undefined, prefix: PrefixSpec): string | undefined {
  const own = ownName(node);
  if (own !== undefined && tag && looksAutoGenerated(own, tag)) {
    const nested = nestedName(node);
    if (nested !== undefined) return canonicalizePrefix(nested, prefix);
  }
  return own !== undefined ? canonicalizePrefix(own, prefix) : undefined;
}

function emitAttrs(
  attrs: Record<string, unknown> | undefined,
  pathPrefix: string,
  out: Map<string, string>,
  matchers: RegExp[],
  prefix: PrefixSpec,
): void {
  if (!attrs) return;
  for (const [name, value] of Object.entries(attrs)) {
    if (name === 'xmlns' || name.startsWith('xmlns:')) continue;
    // Normalise the namespaced type attribute (`i:type`) to `@type`.
    const attrName = name === 'i:type' ? '@type' : `@${name.replace(/^[a-z]+:/, '')}`;
    const path = `${pathPrefix}/${attrName}`;
    if (!isIgnored(path, matchers)) out.set(path, canonicalizePrefix(String(value).trim(), prefix));
  }
}

function walk(
  node: unknown,
  pathPrefix: string,
  out: Map<string, string>,
  matchers: RegExp[],
  prefix: PrefixSpec,
): void {
  if (node == null) return;

  // Leaf: a plain string is element text.
  if (typeof node === 'string') {
    const v = normalizeText(node, pathPrefix);
    if (v !== '' && !isIgnored(pathPrefix, matchers)) out.set(pathPrefix, canonicalizePrefix(v, prefix));
    return;
  }

  if (typeof node !== 'object') return;
  const obj = node as Record<string, unknown>;

  // Element with attributes and/or text: { _: 'text', $: {...} }
  if ('_' in obj || '$' in obj) {
    emitAttrs(obj.$ as Record<string, unknown> | undefined, pathPrefix, out, matchers, prefix);
    if (typeof obj._ === 'string') {
      const v = normalizeText(obj._, pathPrefix);
      if (v !== '' && !isIgnored(pathPrefix, matchers)) out.set(pathPrefix, canonicalizePrefix(v, prefix));
    }
  }

  for (const [key, value] of Object.entries(obj)) {
    if (key === '$' || key === '_') continue;
    const children = Array.isArray(value) ? value : [value];
    const isCollection = children.length > 1;
    for (const child of children) {
      let segment = key;
      if (child && typeof child === 'object' && !Array.isArray(child)) {
        const disc = discriminator(child as Record<string, unknown>, key, prefix);
        if (disc != null && (isCollection || disc !== '')) segment = `${key}[${disc}]`;
      }
      walk(child, `${pathPrefix}/${segment}`, out, matchers, prefix);
    }
  }
}

/**
 * Normalise an AOT XML document into a sorted `path → value` map. `ignore` is the
 * per-case glob list from the case spec; built-in ignores are always applied.
 *
 * `prefix` is the EXTENSION_PREFIX in effect for THIS document — pass
 * `GOLDEN_CAPTURE_PREFIX` when normalising a committed golden, and the
 * CURRENT session's configured prefix (e.g. via
 * `resolveRegularObjectPrefixToken()` from src/utils/modelClassifier.ts) when
 * normalising an actual produced artifact — so a prefixed identifier
 * canonicalises to the same placeholder on both sides regardless of which
 * EXTENSION_PREFIX session produced it (see `canonicalizePrefix` above).
 * Defaults to '' (no canonicalisation — legacy literal-string comparison)
 * for callers that don't pass one.
 */
export async function normalizeAotXml(
  xml: string,
  ignore: string[] = [],
  prefix: PrefixSpec = '',
): Promise<Map<string, string>> {
  const parsed = await parseStringPromise(xml, {
    explicitArray: true,
    attrkey: '$',
    charkey: '_',
    trim: true,
  });
  const matchers = [...DEFAULT_IGNORES, ...ignore].map(globToRegExp);
  const out = new Map<string, string>();

  // An empty / whitespace-only document parses to `null` (xml2js). This is exactly
  // what buildActualArtifactsMap produces for a golden artifact with NO resolvable
  // actual file (`actualArtifacts[name] = ''`) — a genuinely missing artifact. The
  // contract there (and in normalizeMultiArtifact) is that such an artifact registers
  // every one of its paths as `missing`, i.e. contributes an EMPTY map — not that it
  // crashes scoring. Guard the null before `Object.entries` so a missing artifact is
  // reported as a mismatch instead of aborting the whole score run with
  // `TypeError: Cannot convert undefined or null to object`.
  if (parsed == null || typeof parsed !== 'object') return out;

  // Root has a single top-level element (AxEnum / AxTable / AxTableExtension / …).
  for (const [rootTag, rootVal] of Object.entries(parsed as Record<string, unknown>)) {
    const children = Array.isArray(rootVal) ? rootVal : [rootVal];
    for (const child of children) walk(child, rootTag, out, matchers, prefix);
  }

  // Key-sorted for stable diffing.
  return new Map([...out.entries()].sort((a, b) => a[0].localeCompare(b[0])));
}

/** Render a normalized map as a stable, human-readable string (for snapshots/logs). */
export function renderNormalized(map: Map<string, string>): string {
  return [...map.entries()].map(([k, v]) => `${k} = ${v}`).join('\n');
}

/**
 * Normalise a SET of artifacts (L3/L4 cases that produce several objects, e.g.
 * a SysOperation's Contract + DP + Controller) into ONE combined `path → value`
 * map, each artifact's paths prefixed with `<filename>::`. This lets the
 * existing single-document diff/score machinery (diffNormalized, scoreRun)
 * handle multi-artifact cases unchanged: an entirely missing/extra artifact
 * just shows up as every one of its paths being missing/extra, prefixed.
 *
 * `artifacts` keys are filenames (e.g. "MyContract.metadata.xml") — stable,
 * case-author-chosen identifiers, not full paths. The filename itself is
 * typically the prefixed object name (e.g. "ContosoMyContract.metadata.xml"), so
 * it is reduced to a LOGICAL ARTIFACT KEY (`artifactKeyMap`) that also absorbs
 * the corpus's second, legacy filename convention (unprefixed stem +
 * `.Ax<Type>` infix) — otherwise a golden captured under one prefix/convention
 * and an actual produced under another would combine under different
 * `<filename>::` keys and false-mismatch wholesale.
 */
export async function normalizeMultiArtifact(
  artifacts: Record<string, string>,
  ignore: string[] = [],
  prefix: PrefixSpec = '',
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const names = Object.keys(artifacts).sort();
  const keys = artifactKeyMap(names, prefix);
  for (const name of names) {
    const single = await normalizeAotXml(artifacts[name], ignore, prefix);
    const canonName = keys.get(name) ?? canonicalizePrefix(name, prefix);
    for (const [path, value] of single) out.set(`${canonName}::${path}`, value);
  }
  return out;
}
