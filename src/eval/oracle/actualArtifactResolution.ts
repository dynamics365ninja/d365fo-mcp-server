/**
 * Multi-artifact (`--actual-dir`) actual-file resolution for src/eval/oracle/cli.ts.
 * Pure logic + fs reads — no CLI argv/process side effects — split out so it can be
 * unit-tested without triggering the CLI script's `main()` (docs/AGENT_EVAL_LOOP.md §6).
 */

import * as fs from 'fs';
import * as path from 'path';
import { artifactKey, artifactIdentity, artifactType } from './artifactKey.js';
import { type PrefixSpec } from './prefix.js';

/**
 * A bare AOT filename in the shape `artifactKey` expects for a golden. Already-
 * committed `.metadata.xml` names pass through untouched — they end in `.xml` too,
 * and a blind replace turns them into `.metadata.metadata.xml`.
 */
function aotToMetadataName(filename: string): string {
  return /\.metadata\.xml$/i.test(filename)
    ? filename
    : filename.replace(/\.xml$/i, '.metadata.xml');
}

/** Bytes read from a candidate to learn its root element / declared name. */
const HEAD_BYTES = 8192;

/**
 * Read just the head of an actual file — enough for the root element and the
 * object's own `<Name>`, both of which sit in the first few hundred bytes of
 * every AOT document. Keeps identity resolution cheap when `--actual-dir` is
 * pointed straight at a package folder.
 */
function readHead(file: string): string | undefined {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(HEAD_BYTES);
    const read = fs.readSync(fd, buf, 0, HEAD_BYTES, 0);
    return buf.subarray(0, read).toString('utf8');
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ }
  }
}

/**
 * Every artifact file an actual dir holds, sorted, or `[]` when the dir is absent.
 *
 * BOTH shapes count: goldens are committed as `*.metadata.xml`, but the AOT
 * files a VM session produces are bare `<Name>.xml`, and `--actual-dir` is
 * routinely pointed straight at `<Model>/<Model>/Ax<Type>`. Every consumer of an
 * actual dir must use THIS filter — the CLI's `golden_pending` branch grew its
 * own `.metadata.xml`-only copy and consequently recorded
 * `generated_artifacts: []` for every capture run (corpus:
 * eval/corpus/runs/2026-08-31T22__L4-headerlines-document-slice__278eee3.json,
 * "ORACLE DEFECT").
 */
export function listActualArtifactFiles(dir: string): string[] {
  return fs.existsSync(dir)
    ? fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith('.xml')).sort()
    : [];
}

/** Lazily-read `.xml` inventory of an actual dir, so one dir is read once per run. */
class ActualDirIndex {
  private readonly heads = new Map<string, string | undefined>();
  readonly files: string[];

  constructor(readonly dir: string) {
    this.files = listActualArtifactFiles(dir);
  }

  /** The on-disk spelling of `name`, matched case-insensitively (NTFS is). */
  find(name: string): string | undefined {
    const wanted = name.toLowerCase();
    return this.files.find(f => f.toLowerCase() === wanted);
  }

  head(file: string): string | undefined {
    if (!this.heads.has(file)) this.heads.set(file, readHead(path.join(this.dir, file)));
    return this.heads.get(file);
  }

  typeOf(file: string): string | undefined {
    return artifactType(file, this.head(file));
  }

  identityOf(file: string, prefix: PrefixSpec): { stem: string; type?: string } {
    return artifactIdentity(file, this.head(file), prefix);
  }
}

export interface ActualFileResolution {
  /** The paired actual file (absolute path), or undefined when none could be pinned. */
  file?: string;
  /**
   * Set when >1 actual file matched and no signal separates them. The pair is
   * NOT guessed: a silently wrong pairing (diffing a form against the menu item
   * that opens it) is worse than a reported miss.
   */
  ambiguous?: string[];
}

/**
 * Resolve the actual-dir file matching a golden artifact filename.
 *
 * Signals, strongest first:
 *
 *   1. the golden's own filename, verbatim or as the bare `.xml` the VM writes —
 *      an operator naming a file exactly like the golden means that file. It is
 *      still TYPE-CHECKED: `--actual-dir` is flat, so the operator has to give
 *      one of two same-named objects (a form and its display menu item) the
 *      undecorated name, and which one gets it is their choice, not a contract.
 *   2. LOGICAL IDENTITY — the object name the document itself declares, plus its
 *      root element. Survives every filename convention in the corpus (legacy
 *      `.Ax<Type>` stems, `.menuitem` suffixes, hand-abbreviated stems, the
 *      session-chosen suffix of a dot-notation extension) and every prefix drift.
 *   3. the LOGICAL ARTIFACT KEY (`artifactKey`), for files whose content is
 *      unreadable or nameless; ties are broken by AOT type.
 *
 * Historic notes kept because each is a regression this function owns:
 *
 * - The key fallback is what lets a legacy golden filename
 *   (`DemoEnumExtProbe.AxClass.metadata.xml` — unprefixed stem, `.Ax<Type>`
 *   infix) pair with the file the VM produced (`ConDemoEnumExtProbe.metadata.xml`).
 *   See artifactKey.ts and the 2026-07-21 eval sweep, finding #2.
 * - A bare `<Name>.xml` counts too. Goldens are committed as `*.metadata.xml`,
 *   but AOT files on the VM are plain `.xml`, so pointing `--actual-dir` straight
 *   at `<Model>/<Model>/AxClass` — the obvious thing to do during a capture —
 *   used to match nothing and score every artifact `missing`: a silent zero, not
 *   an error (L2-attribute-authoring-reflection capture, 2026-08-30). A
 *   `.metadata.xml` neighbour still wins when both are present.
 * - Matching used to be `artifactKey` + `Array.prototype.find` — FIRST MATCH
 *   WINS. `artifactKey` deliberately strips the `.Ax<Type>` infix, so a golden
 *   dir holding `ConX.metadata.xml` (AxForm) and `ConX.AxMenuItemDisplay.metadata.xml`
 *   reduced both to one key and the form's golden was paired with the menu
 *   item's file — two unrelated objects diffed against each other — or both
 *   goldens were paired with the SAME file and one artifact vanished from the
 *   run. (Corpus: 2026-08-31T22__L3-enum-field-form-downgrade-guard__278eee3;
 *   that case needs both objects because a table's `FormRef` takes a MENU ITEM
 *   name.)
 */
export function resolveActualFileDetailed(
  actualDir: string,
  goldenName: string,
  goldenPrefix: PrefixSpec,
  actualPrefix: PrefixSpec,
  goldenXml?: string,
): ActualFileResolution {
  return resolveAgainstIndex(new ActualDirIndex(actualDir), goldenName, goldenPrefix, actualPrefix, goldenXml);
}

/** As `resolveActualFileDetailed`, over an index shared across a whole golden dir. */
function resolveAgainstIndex(
  index: ActualDirIndex,
  goldenName: string,
  goldenPrefix: PrefixSpec,
  actualPrefix: PrefixSpec,
  goldenXml?: string,
): ActualFileResolution {
  const goldenTypeIsKnown = artifactType(goldenName, goldenXml);
  const abs = (f: string): string => path.join(index.dir, f);

  /** A candidate is usable unless BOTH types are known and they disagree. */
  const typeFits = (file: string): boolean => {
    const actualType = index.typeOf(file);
    return !goldenTypeIsKnown || !actualType || actualType === goldenTypeIsKnown;
  };

  // 1. The golden's own name, verbatim then as a bare AOT `.xml`.
  for (const literal of [goldenName, goldenName.replace(/\.metadata\.xml$/i, '.xml')]) {
    const onDisk = index.find(literal);
    if (onDisk && typeFits(onDisk)) return { file: abs(onDisk) };
  }

  // 2. Logical identity — declared object name + root element.
  const goldenIdentity = artifactIdentity(goldenName, goldenXml, goldenPrefix);
  if (goldenIdentity.type) {
    const byIdentity = index.files.filter(f => {
      const id = index.identityOf(f, actualPrefix);
      return id.stem === goldenIdentity.stem && id.type === goldenIdentity.type;
    });
    const picked = preferMetadataShape(byIdentity);
    if (picked.length === 1) return { file: abs(picked[0]) };
    if (picked.length > 1) return { ambiguous: picked };
  }

  // 3. Logical artifact key, ties broken by type.
  const canonGolden = artifactKey(goldenName, goldenPrefix);
  const byKey = index.files.filter(
    f => artifactKey(aotToMetadataName(f), actualPrefix) === canonGolden,
  );
  const typed = goldenTypeIsKnown ? byKey.filter(f => index.typeOf(f) === goldenTypeIsKnown) : [];
  const candidates = preferMetadataShape(typed.length > 0 ? typed : byKey.filter(typeFits));
  if (candidates.length === 1) return { file: abs(candidates[0]) };
  if (candidates.length > 1) return { ambiguous: candidates };
  return {};
}

/**
 * When a dir holds both shapes of the same object, the committed-golden
 * (`.metadata.xml`) shape is the one the caller meant.
 */
function preferMetadataShape(files: string[]): string[] {
  const metadata = files.filter(f => /\.metadata\.xml$/i.test(f));
  return metadata.length > 0 ? metadata : files;
}

/**
 * Back-compatible wrapper: the paired file, or undefined when there is none OR
 * when the pairing is ambiguous. Callers that must report ambiguity rather than
 * swallow it use `resolveActualFileDetailed`.
 */
export function resolveActualFile(
  actualDir: string,
  goldenName: string,
  goldenPrefix: PrefixSpec,
  actualPrefix: PrefixSpec,
  goldenXml?: string,
): string | undefined {
  return resolveActualFileDetailed(actualDir, goldenName, goldenPrefix, actualPrefix, goldenXml).file;
}

/** A golden artifact that could not be pinned to exactly one actual file. */
export interface ArtifactPairingProblem {
  golden: string;
  /** The actual files that matched equally well (empty when nothing matched). */
  candidates: string[];
  reason: 'ambiguous' | 'claimed-by-another-golden';
  /** For a conflict: the golden artifact that claimed the file first. */
  claimedBy?: string;
}

export interface ActualArtifactsMap {
  actualArtifacts: Record<string, string>;
  matchedActualFiles: Set<string>;
  /** Non-empty when a pairing was refused rather than guessed — the caller must say so. */
  pairingProblems: ArtifactPairingProblem[];
}

/**
 * Build the `actualArtifacts` map for a multi-artifact (`--actual-dir`) run,
 * one entry per golden artifact name.
 *
 * Regression: this used to key every entry by the GOLDEN's own filename
 * (`actualArtifacts[name] = ...` inside a `for (const name of
 * artifactNames)` loop) even when the resolved actual file had a DIFFERENT
 * literal prefix (e.g. golden "ContosoMyContract.metadata.xml" resolved to actual
 * file "DemoMyContract.metadata.xml" under prefix-agnostic matching —
 * `resolveActualFile`'s whole point). `evaluateMulti`/`normalizeMultiArtifact`
 * then canonicalises each artifact KEY with `actualPrefix` — but a key that's
 * still the GOLDEN's literal name doesn't contain `actualPrefix` at all, so
 * `canonicalizePrefix` is a no-op on it, and the golden side's key (correctly
 * canonicalised from ITS OWN prefix) never matches. Every path in the
 * artifact then shows up as wholesale `missing` (under the golden's canonical
 * key) AND `extra` (under the actual's un-canonicalised key), even when the
 * content is byte-identical. Keying by the RESOLVED actual file's own
 * basename (which DOES contain `actualPrefix`) fixes the canonicalisation on
 * both sides consistently — matching the documented multi-artifact contract
 * (src/eval/oracle/normalize.ts's `normalizeMultiArtifact` doc comment).
 *
 * A golden artifact with NO resolvable actual file (genuinely missing, not a
 * prefix-matching miss) keeps the golden's own name as the key with empty
 * content — unchanged from before; there is no real actual basename to key it
 * by, and the empty content correctly registers every one of that artifact's
 * paths as `missing`.
 *
 * `goldenContents` (optional, filename → golden XML) lets the resolver use the
 * golden's own declared name and root element, which is what separates two
 * artifacts of the SAME object name and different types. Two goldens are never
 * allowed to claim the same actual file: the second claim is refused and
 * reported, because one of the two pairings is necessarily wrong and the
 * shared key would silently drop one golden from the run.
 */
export function buildActualArtifactsMap(
  actualDir: string,
  artifactNames: string[],
  goldenPrefix: PrefixSpec,
  actualPrefix: PrefixSpec,
  goldenContents?: Record<string, string>,
): ActualArtifactsMap {
  const actualArtifacts: Record<string, string> = {};
  const matchedActualFiles = new Set<string>();
  const pairingProblems: ArtifactPairingProblem[] = [];
  const claimedBy = new Map<string, string>();
  // One inventory (and one head-read per file) for the whole golden dir, however
  // large the directory `--actual-dir` points at.
  const index = new ActualDirIndex(actualDir);

  for (const name of artifactNames) {
    const res = resolveAgainstIndex(
      index, name, goldenPrefix, actualPrefix, goldenContents?.[name],
    );
    const basename = res.file ? path.basename(res.file) : undefined;

    if (res.ambiguous) {
      pairingProblems.push({ golden: name, candidates: res.ambiguous, reason: 'ambiguous' });
    } else if (basename && claimedBy.has(basename)) {
      pairingProblems.push({
        golden: name, candidates: [basename], reason: 'claimed-by-another-golden',
        claimedBy: claimedBy.get(basename),
      });
    } else if (res.file && basename) {
      claimedBy.set(basename, name);
      // Key in the committed-golden filename shape. A bare AOT `.xml` keys to
      // `.xml`, which never equals the golden side's `.metadata.xml` key, so the
      // pair diffed as missing + extra even though resolveActualFile had matched
      // them. The key still carries actualPrefix, which is all canonicalisation
      // needs; matchedActualFiles keeps the real on-disk name for the caller.
      actualArtifacts[aotToMetadataName(basename)] = fs.readFileSync(res.file, 'utf8');
      matchedActualFiles.add(basename);
      continue;
    }
    // Unresolved, ambiguous or double-claimed: the golden keeps its own key with
    // empty content, so every one of its paths is reported `missing`.
    actualArtifacts[name] = '';
  }
  return { actualArtifacts, matchedActualFiles, pairingProblems };
}

/** One line per refused pairing, for the CLI to print. Empty when all pairings are clean. */
export function renderPairingProblems(problems: readonly ArtifactPairingProblem[]): string {
  return problems.map(p => p.reason === 'ambiguous'
    ? `AMBIGUOUS: golden ${p.golden} matches ${p.candidates.length} actual files ` +
      `(${p.candidates.join(', ')}) and no type/name signal separates them — ` +
      'scored as missing rather than paired by guess.'
    : `CONFLICT: golden ${p.golden} resolved to ${p.candidates[0]}, which golden ` +
      `${p.claimedBy} already claimed — scored as missing rather than double-counted.`,
  ).join('\n');
}
