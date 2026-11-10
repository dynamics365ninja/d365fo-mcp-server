/**
 * Model descriptor reader — `<PackagesLocalDirectory>/<Package>/Descriptor/<Model>.xml`.
 *
 * `<ModuleReferences>` is the only statement of what a model may see: xppc
 * resolves types against the referenced packages, not against everything
 * installed, so an indexed type can still be invisible to the model being
 * compiled. The visible set is the model's own package plus its DIRECT
 * references — walking the closure would mark such a type visible again and
 * hide the defect this exists to catch.
 *
 * Not a compiler: a table in a referenced package can still need a further
 * reference because a third package contributes a table extension to it.
 */

import { existsSync, readFileSync, readdirSync } from 'fs';
import * as path from 'path';

/**
 * Extract every `<d2p1:string>` entry of a descriptor's `<ModuleReferences>`.
 *
 * Scoped to that ELEMENT, not scanned flat over the document. The flat scan this
 * replaces reasoned only about `<ModelReferences>` — `i:nil` in every descriptor
 * observed on a real box, so it contributes nothing — and missed the OTHER
 * `<d2p1:string>` arrays a descriptor carries: `<InternalsVisibleTo>` and
 * `<AppliedUpdates>`. Both are ordinary string lists, and `<InternalsVisibleTo>`
 * sorts BEFORE `<ModuleReferences>` in the serialized document, so its entries
 * came back as module references.
 *
 * Measured on a 10.0.2527 PackagesLocalDirectory plus the custom roots beside
 * it: 112 of 176 descriptors over-reported, 606 phantom references in total.
 * `Foundation.xml` answered 157 for a model that references 46;
 * `ApplicationPlatform.xml` answered 19 for a model that references NONE.
 *
 * That is not cosmetic. Its reader treats the result as the set of packages a
 * model may see: getModelVisibility turns it into `visiblePackages`, the oracle
 * resolve_references uses to decide an indexed type is invisible to the model
 * being compiled. Every phantom entry made that oracle MORE permissive, so the
 * missing-reference defect it exists to catch was silently waved through —
 * which is the exact compile-time `classStr`/type failure this module's own
 * header describes.
 *
 * Returns [] for a nil or absent element: a model that references nothing. An
 * unreadable descriptor is the caller's to report (getModelVisibility answers
 * null), never an empty list.
 */
export function parseModuleReferences(descriptorXml: string): string[] {
  const element = findModuleReferencesElement(descriptorXml);
  if (!element || element.selfClosing) return [];
  return Array.from(element.inner.matchAll(/<d2p1:string>\s*([^<\s]+)\s*<\/d2p1:string>/g))
    .map(m => m[1].trim())
    .filter(Boolean);
}

/**
 * Every `<d2p1:string>` entry of a descriptor's `<InternalsVisibleTo>` — the models
 * allowed to see this model's internal members, which is how a model names its
 * test model. Scoped to the element for the same reason as parseModuleReferences.
 */
export function parseInternalsVisibleTo(descriptorXml: string): string[] {
  const element = /<InternalsVisibleTo\b[^>]*?(?:\/>|>([\s\S]*?)<\/InternalsVisibleTo>)/.exec(descriptorXml);
  if (!element?.[1]) return [];
  return Array.from(element[1].matchAll(/<d2p1:string>\s*([^<\s]+)\s*<\/d2p1:string>/g))
    .map(m => m[1].trim())
    .filter(Boolean);
}

/** How one model stands to another, as their descriptors declare it. */
export interface ModelDependency {
  /** `model` lists the base model's package in its `<ModuleReferences>`: it is built ON the base. */
  buildsOnBase: boolean;
  /** The base model lists `model` in `<InternalsVisibleTo>`: `model` is its test model. */
  testModelOfBase: boolean;
}

/**
 * Read from the descriptors under the first root that holds `model`'s; null when no
 * root does, so a caller never acts on a guess.
 *
 * A dependent model sees the base model, never the other way round, so the base
 * cannot extend an object of a model built on it — the cross-model guard needs this
 * to stop advising exactly that.
 */
export function modelDependency(
  packagesRoots: Array<string | null | undefined>,
  model: string,
  baseModel: string,
): ModelDependency | null {
  const eqi = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  for (const root of packagesRoots) {
    if (!root) continue;
    const own = findDescriptor(root, model);
    if (!own) continue;
    try {
      const refs = parseModuleReferences(readFileSync(own.file, 'utf-8'));
      const base = findDescriptor(root, baseModel);
      const basePkg = base?.pkg ?? baseModel;
      const internals = base ? parseInternalsVisibleTo(readFileSync(base.file, 'utf-8')) : [];
      return {
        buildsOnBase: refs.some(r => eqi(r, basePkg) || eqi(r, baseModel)),
        testModelOfBase: internals.some(m => eqi(m, model)),
      };
    } catch {
      return null;
    }
  }
  return null;
}

/** The PackagesLocalDirectory root contained in a package or workspace path. */
export function packagesRootFromPath(candidate: string | undefined | null): string | null {
  if (!candidate) return null;
  const m = /^(.+[\\/]PackagesLocalDirectory)(?:[\\/]|$)/i.exec(candidate.replace(/\//g, '\\'));
  return m ? m[1] : null;
}

export interface ModelVisibility {
  /** Target model, for diagnostics. */
  model: string;
  /** PackagesLocalDirectory root the indexed file paths are relative to. */
  packagesRoot: string;
  /** Lower-cased package folder names the model may reference (incl. its own). */
  visiblePackages: ReadonlySet<string>;
  /**
   * Package folder owning an indexed file, or null when the path is not under
   * this packages root. Null means "cannot tell" and must silence the check.
   */
  packageOf(filePath: string): string | null;
}

/**
 * Locate `<Model>.xml`. `<root>/<Model>/Descriptor/<Model>.xml` is the common
 * layout and costs one stat; ISV models inside a differently-named package fall
 * back to a single bounded sweep of the root's package folders.
 *
 * Model names are case-insensitive in D365FO, and the guard compares them that
 * way. On Windows the stat already ignores case; on a case-sensitive file system
 * the sweep compares each package's descriptor file names case-insensitively, so
 * `contosotests` finds `ContosoTests/Descriptor/ContosoTests.xml` there too.
 */
function findDescriptor(packagesRoot: string, modelName: string): { file: string; pkg: string } | null {
  const direct = path.join(packagesRoot, modelName, 'Descriptor', `${modelName}.xml`);
  if (existsSync(direct)) return { file: direct, pkg: modelName };
  let entries: string[];
  try {
    entries = readdirSync(packagesRoot);
  } catch {
    return null;
  }
  const wanted = `${modelName}.xml`.toLowerCase();
  // The package named like the model first, then the rest, as the stat above does.
  const ordered = [
    ...entries.filter(e => e.toLowerCase() === modelName.toLowerCase()),
    ...entries.filter(e => e.toLowerCase() !== modelName.toLowerCase()),
  ];
  for (const pkg of ordered) {
    const dir = path.join(packagesRoot, pkg, 'Descriptor');
    const exact = path.join(dir, `${modelName}.xml`);
    if (existsSync(exact)) return { file: exact, pkg };
    let files: string[];
    try {
      files = readdirSync(dir);
    } catch {
      continue;
    }
    const match = files.find(f => f.toLowerCase() === wanted);
    if (match) return { file: path.join(dir, match), pkg };
  }
  return null;
}

/** Cache key → resolved visibility (or null when it could not be resolved). */
const visibilityCache = new Map<string, ModelVisibility | null>();

/**
 * Build (and memoise) the visibility oracle for `modelName`; null whenever the
 * answer would be a guess. Callers must then skip the check — a missing
 * descriptor turning into a wall of errors is worse than the gap it closes.
 */
export function getModelVisibility(
  packagesRoot: string | null | undefined,
  modelName: string | null | undefined,
): ModelVisibility | null {
  if (!packagesRoot || !modelName) return null;
  const key = `${packagesRoot.toLowerCase()}|${modelName.toLowerCase()}`;
  const cached = visibilityCache.get(key);
  if (cached !== undefined) return cached;

  const built = buildModelVisibility(packagesRoot, modelName);
  visibilityCache.set(key, built);
  return built;
}

/**
 * Drop the memoised visibility of `modelName` under every root.
 *
 * The descriptor writers call this after every successful write. Without it the
 * oracle keeps the reference set the model had when it was first asked, so
 * resolve_references goes on reporting `not-visible-from-model` — and telling
 * the agent to add the very reference it has just added — until the server
 * restarts; a remove leaves it too permissive the same way.
 */
export function invalidateModelVisibility(modelName: string): void {
  const suffix = `|${modelName.toLowerCase()}`;
  for (const key of visibilityCache.keys()) {
    if (key.endsWith(suffix)) visibilityCache.delete(key);
  }
}

/** Uncached form — exported for tests, which need a fresh fixture each time. */
export function buildModelVisibility(
  packagesRoot: string | null | undefined,
  modelName: string | null | undefined,
): ModelVisibility | null {
  if (!packagesRoot || !modelName) return null;
  const found = findDescriptor(packagesRoot, modelName);
  if (!found) return null;

  let refs: string[];
  try {
    refs = parseModuleReferences(readFileSync(found.file, 'utf-8'));
  } catch {
    return null;
  }

  const visiblePackages = new Set<string>([found.pkg.toLowerCase()]);
  for (const ref of refs) visiblePackages.add(ref.toLowerCase());

  const rootPrefix = packagesRoot.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase() + '\\';
  return {
    model: modelName,
    packagesRoot,
    visiblePackages,
    packageOf(filePath: string): string | null {
      if (!filePath) return null;
      const norm = filePath.replace(/\//g, '\\');
      // Case-insensitive: index and config disagree on the root's casing
      // (`K:\AOSService\…` vs `K:\AosService\…`) for the same directory.
      if (!norm.toLowerCase().startsWith(rootPrefix)) return null;
      const segment = norm.slice(rootPrefix.length).split('\\')[0];
      return segment || null;
    },
  };
}

// ── Write side ──────────────────────────────────────────────────────────────
//
// A descriptor is not an AOT object — MetadataWriteService has no concept of
// one, the same structural reason AxIgnoreDiagnosticList is XML-only — so these
// are pure string transforms over the file, applied by
// directXmlAdd/RemoveModuleReference in src/tools/write/directXmlWriters.ts.
//
// Nothing here CREATES structure. A descriptor with no <ModuleReferences>
// element is reported as such rather than having one invented: the element's
// entries are `<d2p1:string>`, whose prefix is declared by an `xmlns:d2p1`
// attribute that in shipped descriptors sits on the root or on the element
// itself, and a tool that guesses where to put a namespace declaration is a
// tool that writes a descriptor Visual Studio rewrites on the next save.

/** `<ModuleReferences>` as it appears in the file, with its byte range. */
interface ModuleReferencesElement {
  /** Full matched text, including the open and close tags. */
  text: string;
  /** Inner text between the tags ('' for the self-closing spelling). */
  inner: string;
  from: number;
  to: number;
  /** True for `<ModuleReferences />` — an empty list, not a missing one. */
  selfClosing: boolean;
  /** The element's attributes, verbatim (leading space included), or ''. */
  attrs: string;
}

/**
 * Strip `i:nil="true"` from an element's attributes.
 *
 * `<ModuleReferences … i:nil="true" />` does not mean "empty list", it means
 * "no list": the serializer reads the element as null and DISCARDS any children
 * it carries. ApplicationPlatform ships exactly that. Materialising such an
 * element without removing the attribute writes
 * `<ModuleReferences i:nil="true"><d2p1:string>Ledger</d2p1:string></…>` — a
 * file that loads clean, reports no reference, and fails at compile time with
 * the very error the reference was added to fix. Visual Studio drops the
 * attribute when it adds a first reference; so does this.
 */
function withoutNil(attrs: string): string {
  return attrs.replace(/\s+i:nil\s*=\s*"(?:true|false)"/i, '');
}

/**
 * Locate the descriptor's `<ModuleReferences>`, or null when it has none.
 *
 * Both spellings occur: a model that references nothing carries
 * `<ModuleReferences />` (optionally with the namespace attribute), and one that
 * references something carries the open/close pair. The sibling
 * `<ModelReferences>` is deliberately NOT matched — it is `i:nil` in every
 * descriptor observed on a real box and means something else.
 */
function findModuleReferencesElement(xml: string): ModuleReferencesElement | null {
  const paired = /<ModuleReferences((?:\s[^>]*?)?)>([\s\S]*?)<\/ModuleReferences>/.exec(xml);
  if (paired) {
    return {
      text: paired[0], inner: paired[2], attrs: paired[1], from: paired.index,
      to: paired.index + paired[0].length, selfClosing: false,
    };
  }
  const empty = /<ModuleReferences((?:\s[^>]*?)?)\s*\/>/.exec(xml);
  if (empty) {
    return {
      text: empty[0], inner: '', attrs: empty[1], from: empty.index,
      to: empty.index + empty[0].length, selfClosing: true,
    };
  }
  return null;
}

export type AddModuleReferenceResult =
  /** Added. `xml` is the updated document. */
  | { kind: 'added'; xml: string }
  /** Already referenced — refuse rather than write a second `<d2p1:string>`. */
  | { kind: 'duplicate'; existing: string }
  /** No `<ModuleReferences>` element at all; the caller declines rather than inventing one. */
  | { kind: 'no-element' }
  /** Not a package folder name — see isValidModuleReferenceName. */
  | { kind: 'invalid-name' };

export type RemoveModuleReferenceResult =
  /** Removed. `xml` is the updated document, `removed` the entry as it was spelled. */
  | { kind: 'removed'; xml: string; removed: string }
  /** Not referenced. `present` is what IS referenced, for the message. */
  | { kind: 'not-found'; present: string[] }
  /** No `<ModuleReferences>` element at all. */
  | { kind: 'no-element' };

/**
 * Could `name` be a package folder name?
 *
 * Checked before anything is written, because the entry is interpolated into
 * `<d2p1:string>…</d2p1:string>` verbatim: whitespace inside the name writes an
 * entry parseModuleReferences cannot read back (so it is neither a detected
 * duplicate nor removable), an all-blank name writes an empty entry, and `&`/`<`
 * write a malformed descriptor. Package folders on a real install use letters,
 * digits and `_`, plus `-` in custom ones (`fm-mcp`); `.` is admitted for
 * dotted ISV names, but never leading, so the name cannot step out of a
 * packages root when probed as a folder.
 */
export function isValidModuleReferenceName(name: string): boolean {
  return /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(name);
}

/** Escape a literal for embedding in a RegExp. */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Is this reference list in ascending case-insensitive order?
 *
 * Decides whether an addition is INSERTED in place or appended — see
 * addModuleReference for the measurement behind that. Compared lower-cased
 * because that is the order the sorted files are actually in: an ISV package
 * spelled in caps ("ISVCore") sits AFTER "Inventory" there, while ordinal `<`
 * on the raw strings puts it before ('S' < 'n' — uppercase letters sort ahead
 * of lowercase ones).
 */
function isAscending(refs: readonly string[]): boolean {
  for (let i = 1; i < refs.length; i++) {
    if (refs[i - 1].toLowerCase() > refs[i].toLowerCase()) return false;
  }
  return true;
}

/**
 * The indentation one `<d2p1:string>` entry sits at, and the one its closing
 * tag sits at — measured from the file rather than assumed.
 *
 * Descriptors ship with both tab and two-space indentation, and a descriptor is
 * a file a human reads in a diff before every release: an entry indented
 * unlike its siblings is exactly the noise this preserves against. Falls back
 * to one level deeper than the `<ModuleReferences>` tag itself.
 */
function entryIndent(xml: string, element: ModuleReferencesElement): { entry: string; close: string } {
  const close =
    (!element.selfClosing ? /\n([\t ]*)<\/ModuleReferences>/.exec(element.text)?.[1] : undefined)
    ?? /\n([\t ]*)<ModuleReferences/.exec(xml.slice(0, element.to + 1))?.[1]
    ?? '  ';
  const existing = /\n([\t ]*)<d2p1:string>/.exec(element.inner);
  if (existing) return { entry: existing[1], close };
  const unit = close.includes('\t') ? '\t' : '  ';
  return { entry: close + unit, close };
}

/**
 * Add one `<d2p1:string>` entry to `<ModuleReferences>`.
 *
 * Idempotent by refusal, matching add-diagnostic-suppression: a duplicate comes
 * back as 'duplicate' rather than as a silent no-op, because a caller who does
 * not know the reference is already there learns more from being told than from
 * a ✅ over an unchanged file. Comparison is case-insensitive — a package folder
 * name is, and two entries differing only in case are one reference to xppc and
 * two lines to a reviewer.
 *
 * Placement follows the file's OWN convention, the same way the indentation
 * does. A descriptor that is already sorted gets the entry in sorted position;
 * one that is not gets it appended.
 *
 * An earlier version of this docblock asserted that no shipped descriptor is
 * sorted and always appended. That was wrong, and measurably so: across the 176
 * descriptors of a 10.0.2527 PackagesLocalDirectory plus the custom and ISV
 * roots beside it, 137 of the 173 with two or more references are in ascending
 * case-insensitive order, and every custom model on the box was among them —
 * i.e. the sorted convention is the one the files a write actually targets keep.
 * Appending to a sorted list puts the new entry out of order, which is a line a
 * reviewer stops at and which the next Visual Studio save silently re-sorts,
 * turning one intended change into two diffs.
 *
 * The 36 unsorted ones (Foundation, SCMControls, several *Integration models)
 * are left alone rather than tidied: re-sorting a file to add one line to it is
 * the larger diff, not the smaller one.
 */
export function addModuleReference(xml: string, moduleName: string): AddModuleReferenceResult {
  const element = findModuleReferencesElement(xml);
  if (!element) return { kind: 'no-element' };

  const name = moduleName.trim();
  if (!isValidModuleReferenceName(name)) return { kind: 'invalid-name' };
  const present = parseModuleReferences(element.text);
  const existing = present.find(r => r.toLowerCase() === name.toLowerCase());
  if (existing) return { kind: 'duplicate', existing };

  const { entry, close } = entryIndent(xml, element);
  const line = `${entry}<d2p1:string>${name}</d2p1:string>`;

  let replacement: string;
  if (element.selfClosing || element.inner.trim() === '') {
    // An EMPTY (or nil) list becomes the open/close pair around the first entry.
    // The d2p1 namespace declaration is carried across verbatim — dropping it
    // would unbind the prefix the entry being added uses — while i:nil is
    // removed, because it would otherwise null out the list we just filled.
    replacement =
      `<ModuleReferences${withoutNil(element.attrs)}>\n${line}\n${close}</ModuleReferences>`;
  } else {
    // Sorted file → sorted position. `successor` is the first entry that should
    // come AFTER the new one; inserting before its line keeps the run ordered.
    const successor = isAscending(present)
      ? present.find(r => r.toLowerCase() > name.toLowerCase())
      : undefined;
    replacement = successor
      ? element.text.replace(
          new RegExp(String.raw`([\t ]*<d2p1:string>\s*${escapeRe(successor)}\s*</d2p1:string>)`),
          `${line}\n$1`,
        )
      : element.text.replace(
          /[\t ]*<\/ModuleReferences>$/,
          `${line}\n${close}</ModuleReferences>`,
        );
  }

  return { kind: 'added', xml: xml.slice(0, element.from) + replacement + xml.slice(element.to) };
}

/**
 * Remove one `<d2p1:string>` entry from `<ModuleReferences>`, matched
 * case-insensitively on its text.
 *
 * Removing the LAST entry collapses the element to `<ModuleReferences … />`,
 * keeping its attributes — the shape a shipped descriptor with no references
 * actually has, and the one that makes add-then-remove a byte-identical round
 * trip on a file that started empty. (The one nuance: a list that started
 * `i:nil="true"` comes back as the self-closing form WITHOUT the nil, because
 * adding a reference is what dropped it. "No list" and "empty list" both mean
 * the model references nothing, so nothing is lost.)
 */
export function removeModuleReference(xml: string, moduleName: string): RemoveModuleReferenceResult {
  const element = findModuleReferencesElement(xml);
  if (!element) return { kind: 'no-element' };

  const present = parseModuleReferences(element.text);
  const name = moduleName.trim().toLowerCase();
  const hit = present.find(r => r.toLowerCase() === name);
  if (!hit) return { kind: 'not-found', present };

  // The whole LINE goes, so removing an entry does not leave a blank one behind.
  const entryRe = new RegExp(
    String.raw`[\t ]*<d2p1:string>\s*${escapeRe(hit)}\s*</d2p1:string>[\t ]*\n?`,
  );
  const replacement = present.length === 1
    ? `<ModuleReferences${element.attrs} />`
    : element.text.replace(entryRe, '');

  return {
    kind: 'removed',
    removed: hit,
    xml: xml.slice(0, element.from) + replacement + xml.slice(element.to),
  };
}

/**
 * Where a model's descriptor actually is under `packagesRoot`, or null when it
 * is not there — the write side's equivalent of buildModelVisibility, which
 * collapses "no such file" into the same null as "unreadable".
 *
 * Reuses findDescriptor's probe order (package == model first, then a bounded
 * sweep for an ISV model inside a differently-named package) so a write lands on
 * the file the readers read.
 */
export function findDescriptorPath(
  packagesRoot: string,
  modelName: string,
): { filePath: string; packageName: string } | null {
  const found = findDescriptor(packagesRoot, modelName);
  return found ? { filePath: found.file, packageName: found.pkg } : null;
}
