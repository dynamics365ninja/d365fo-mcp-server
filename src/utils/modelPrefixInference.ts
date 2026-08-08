/**
 * Infer a model's object prefix from the objects that model already contains.
 *
 * Why this exists: `EXTENSION_PREFIX` is a single value chosen once, during
 * `setup`. Real development spans several models — a developer works in Demo
 * today and DemoCus tomorrow — and each of those carries its own prefix (DEMO_
 * and DMC_ respectively). A single configured value cannot be right for all of
 * them, and nobody is going to re-run setup on every context switch.
 * The information is already on disk: the model's existing objects state its
 * prefix far more reliably than any configuration does.
 *
 * So the active model's own naming wins, and the configured `EXTENSION_PREFIX`
 * becomes the fallback for models that have nothing to learn from (a brand-new,
 * empty model) — see resolveObjectPrefix() in modelClassifier.ts for the order.
 *
 * Two tokens are inferred, because D365FO uses two different forms and they are
 * NOT derivable from one another (DEMO_ / DEMO, but Con / Con):
 *   - `regular` — prepended to new objects and to members added inside an
 *     extension:  DEMO_MandatoryReasonCode, DEMO_ArchiveAccDocErrorLog
 *   - `infix`   — embedded in extension element/class names:
 *     AssetBookTable.DEMOExtension, AccountingSourceExplorerDEMO_Extension
 *
 * Inference is deliberately conservative: a model whose objects show no
 * consistent prefix yields null, and the configured value is used unchanged.
 */

/** The two prefix tokens a model's own objects reveal. */
export interface InferredModelPrefix {
  /** Token prepended to new objects and to members added inside extensions. */
  regular: string;
  /** Token embedded in extension element and extension class names. */
  infix: string;
  /** How many sampled names carried `regular` (diagnostics only). */
  coverage: number;
  /** How many names the inference looked at (diagnostics only). */
  sampleSize: number;
}

/** Minimum non-extension objects needed before a prefix is trusted. */
const MIN_SAMPLE = 4;
/** Share of sampled names that must carry the token. */
const MIN_COVERAGE = 0.6;
/** Longest prefix token considered; beyond this it is a domain word, not a prefix. */
const MAX_TOKEN_LEN = 12;
/**
 * Most PascalCase segments a prefix may span. Real prefixes are compound but
 * short — "Isv" / "IsvFin" / "ConFinSK" (Con|Fin|SK) / "ACStdSK" (AC|Std|SK).
 * The cap is what keeps a domain word out: with four segments allowed, a model
 * whose objects all happen to start "ConFinSKVend…" would offer "ConFinSKVend"
 * as a fully-covering candidate and it would win on length.
 */
const MAX_TOKEN_SEGMENTS = 3;

/**
 * Split a PascalCase / SCREAMING_CASE name into its leading segments.
 * "ConDemoNoteHeader" → [Con, Demo, Note, Header]
 * "DEMOArchiveAccDoc"  → [DEMO, Archive, Acc, Doc]   (a run of capitals is one segment)
 */
function segments(name: string): string[] {
  return name.match(/[A-Z]+(?![a-z])|[A-Z][a-z0-9]*|[a-z0-9]+/g) ?? [];
}

/**
 * Candidate leading tokens for one object name — the substrings that could
 * plausibly be "the prefix" of the model this name belongs to.
 */
function leadingTokenCandidates(name: string): string[] {
  const out: string[] = [];

  // Underscore style (DEMO_Foo, ISV_Bar): everything up to and including the
  // first underscore, which is the whole token — the underscore is part of it.
  const us = name.indexOf('_');
  if (us >= 1 && us <= MAX_TOKEN_LEN) out.push(name.slice(0, us + 1));

  // PascalCase style (ConDemoNoteHeader): every leading run of segments up to
  // MAX_TOKEN_SEGMENTS, because a prefix is often compound — "IsvFin" over
  // "Isv", "ConFinSK" over "ConFin". Offering only the first two segments does
  // not merely make the third unlikely, it makes it unreachable: "ConFinSK"
  // never enters the contest and the longest candidate present, "ConFin", wins
  // by default and reads like a considered choice.
  const segs = segments(name);
  let acc = '';
  for (let i = 0; i < Math.min(MAX_TOKEN_SEGMENTS, segs.length); i++) {
    acc += segs[i];
    if (acc.length >= 2 && acc.length <= MAX_TOKEN_LEN) out.push(acc);
  }

  return out;
}

/**
 * May this candidate compete?
 *
 * Coverage cannot tell a real third segment from a domain word: a model whose
 * objects are all ConDemoNoteHeader / …Line / …Text offers "ConDemoNote" with
 * exactly the same 100 % coverage that makes "AslFinSK" right for AslFinanceSK,
 * and the longest-wins tie-break then takes the domain word. Both shapes are
 * indistinguishable from the names alone, so a candidate spanning three segments
 * has to be corroborated from OUTSIDE the object names:
 *
 *   - the model's own extensions state it ("VendTable.AslFinSKExtension"), or
 *   - the model NAME contains its segments in order ("Asl|Fin|SK" ⊂ AslFinanceSK,
 *     while "Note" is nowhere in "ConDemo").
 *
 * Uncorroborated, the candidate is dropped and the two-segment token — the
 * pre-1.8.5 answer, and the conservative one — wins instead. Nothing is dropped
 * when no model name was supplied and no infix is stated: there is then nothing
 * to check against, and refusing every long token would be its own guess.
 */
function tokenAllowed(
  token: string,
  modelName: string | undefined,
  statedInfix: string | null,
): boolean {
  const bare = token.replace(/_+$/, '');
  const segs = segments(bare);
  if (segs.length < 3) return true;
  if (!modelName && !statedInfix) return true;

  if (statedInfix && statedInfix.toLowerCase().startsWith(bare.toLowerCase())) return true;
  return !!modelName && modelNameCarries(modelName, segs);
}

/**
 * Do the token's segments appear in the model name, in order, starting at its
 * first character? Gaps between them are allowed, which is what makes
 * "Asl|Fin|SK" match "AslFinanceSK" — the model spells a segment out where the
 * prefix abbreviates it.
 */
function modelNameCarries(modelName: string, segs: string[]): boolean {
  const model = modelName.toLowerCase().replace(/[^a-z0-9]/g, '');
  let pos = 0;
  for (let i = 0; i < segs.length; i++) {
    const needle = segs[i].toLowerCase();
    const at = model.indexOf(needle, pos);
    if (at < 0) return false;
    if (i === 0 && at !== 0) return false;   // the prefix starts where the name does
    pos = at + needle.length;
  }
  return true;
}

/**
 * Pick the candidate to trust: the LONGEST token that still clears
 * MIN_COVERAGE, not the one with the highest raw coverage count.
 *
 * A shorter candidate is always a prefix of every longer one, so it always
 * covers at least as many names — one stray object off-convention (a typo, a
 * differently-cased legacy name, an old object from before the prefix went
 * compound) drops the three-segment count below the two-segment count and,
 * under a raw-coverage race, the two-segment token wins EVERY time real data
 * has any exception at all. That is exactly how "AslFinSK" (26/28 objects, a
 * couple of others spelled "AslFinSk_") lost to "AslFin" (28/28) despite being
 * the model's actual, corroborated convention.
 * Once a token clears the coverage bar it is trusted; among those, the longest
 * is the most specific answer and wins outright, not merely on a tie.
 */
function bestCovering(names: string[], candidates: Iterable<string>): { token: string; coverage: number } | null {
  let best: { token: string; coverage: number } | null = null;
  for (const token of new Set(candidates)) {
    const coverage = names.filter(n => n.startsWith(token)).length;
    if (coverage / names.length < MIN_COVERAGE) continue;
    if (
      !best ||
      token.length > best.token.length ||
      (token.length === best.token.length && coverage > best.coverage)
    ) {
      best = { token, coverage };
    }
  }
  return best;
}

/**
 * The infix carried by dot-notation extension elements, which state it outright:
 * "AssetBookTable.DEMOExtension" → "DEMO". The most frequent one wins; a single
 * stray element is not enough to overrule the rest.
 */
function inferInfixFromDotExtensions(dotNames: string[]): string | null {
  const counts = new Map<string, number>();
  for (const name of dotNames) {
    const suffix = name.slice(name.lastIndexOf('.') + 1);
    if (!/extension$/i.test(suffix)) continue;
    const token = suffix.slice(0, -'Extension'.length);
    if (token.length < 2 || token.length > MAX_TOKEN_LEN) continue;
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  let winner: { token: string; n: number } | null = null;
  let total = 0;
  for (const [token, n] of counts) {
    total += n;
    if (!winner || n > winner.n) winner = { token, n };
  }
  if (!winner || total === 0) return null;
  return winner.n / total >= MIN_COVERAGE ? winner.token : null;
}

/**
 * The PascalCase form of an underscore-style prefix, applied PER SEGMENT:
 * "DEMO" → "Demo", "WHS" → "Whs", "ConFinSK" → "ConFinSk".
 *
 * The documented EXTENSION_PREFIX rule is "XY_" → "Xy" — first upper, rest
 * lower — which is right for the single all-caps acronym it was written for and
 * destroys every later boundary in a compound token: "ConFinSK" flattens to
 * "Confinsk". Lowering each segment on its own keeps the rule for acronyms and
 * keeps the boundaries for the rest.
 */
export function toExtensionInfixCase(bare: string): string {
  if (!bare) return '';
  const segs = segments(bare);
  if (segs.length === 0) return bare.charAt(0).toUpperCase() + bare.slice(1).toLowerCase();
  return segs.map(s => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase()).join('');
}

/**
 * Derive the extension infix from a regular token when no extension element
 * exists to read it off. Mirrors the documented EXTENSION_PREFIX rule:
 * underscore style "XY_" → "Xy", PascalCase "Contoso" → "Contoso".
 */
function deriveInfixFrom(regular: string): string {
  const bare = regular.replace(/_+$/, '');
  if (!bare) return '';
  return regular.endsWith('_')
    ? toExtensionInfixCase(bare)
    : bare.charAt(0).toUpperCase() + bare.slice(1);
}

/**
 * Infer a model's prefix from the names of the objects it contains.
 * Returns null when the names show no consistent prefix.
 *
 * `names` are object names as stored in the AOT — regular objects
 * ("DEMO_AssetIPFairValue"), dot-notation extensions ("AssetBookTable.DEMOExtension")
 * and extension classes ("AccountingSourceExplorerDEMO_Extension") mixed together.
 *
 * `modelName` is what a three-segment candidate is corroborated against — see
 * corroboratesToken(). Omit it and long candidates are accepted on coverage
 * alone, which is right for a caller that has names and nothing else.
 */
export function inferPrefixFromObjectNames(
  names: string[],
  modelName?: string,
): InferredModelPrefix | null {
  const clean = names.map(n => n.trim()).filter(Boolean);

  const dotNames = clean.filter(n => n.includes('.'));
  // Extension classes carry the token as a SUFFIX, so they say nothing about the
  // leading token and would only dilute its coverage.
  const regulars = clean.filter(n => !n.includes('.') && !n.endsWith('_Extension'));

  const infixFromElements = inferInfixFromDotExtensions(dotNames);

  const candidates = regulars
    .flatMap(leadingTokenCandidates)
    .filter(token => tokenAllowed(token, modelName, infixFromElements));
  const best = regulars.length >= MIN_SAMPLE ? bestCovering(regulars, candidates) : null;
  const regularOk = best && best.coverage / regulars.length >= MIN_COVERAGE;

  if (!regularOk && !infixFromElements) return null;

  // Each token is preferred from direct evidence and derived from the other only
  // when its own evidence is missing.
  let regular = regularOk ? best!.token : infixFromElements!;
  const infix = infixFromElements ?? deriveInfixFrom(regular);

  // Cross-check the two, because a truncated leading token is invisible on its
  // own: "ConFin" looks like a perfectly good prefix until the model's own
  // extensions spell "…ConFinSKExtension". When the learned regular token is a
  // strict prefix of the stated infix AND the regular objects carry the longer
  // form too, the short one is a truncation rather than a second convention.
  // Without this, new members land as ConFinFoo inside ConFinSKExtension.
  if (regularOk && infixFromElements) {
    const bare = regular.replace(/_+$/, '');
    const underscore = regular.slice(bare.length);
    const longer = infixFromElements;
    const isTruncation =
      longer.length > bare.length && longer.toLowerCase().startsWith(bare.toLowerCase());
    const carriedByObjects =
      regulars.filter(n => n.toLowerCase().startsWith(longer.toLowerCase())).length / regulars.length;
    if (isTruncation && carriedByObjects >= MIN_COVERAGE) {
      regular = longer + underscore;
    }
  }

  return {
    regular,
    infix,
    coverage: regularOk ? best!.coverage : 0,
    sampleSize: regulars.length,
  };
}

// ── Registry ────────────────────────────────────────────────────────────────
// resolveObjectPrefix() is synchronous and called from dozens of places that
// have no database handle, so the lookup is a cached registry fed by a source
// installed once at startup (see setModelObjectNameSource).

/** Supplies the object names of one model. Returns [] when it cannot answer. */
export type ModelObjectNameSource = (modelName: string) => string[];

let nameSource: ModelObjectNameSource | null = null;
// null value = "looked, found nothing usable" — cached so a model without a
// learnable prefix is not re-queried on every name that gets generated.
const inferred = new Map<string, InferredModelPrefix | null>();

/**
 * Install the source of model object names (the symbol index, in the server).
 * Called once during startup; passing null disables inference.
 */
export function setModelObjectNameSource(source: ModelObjectNameSource | null): void {
  nameSource = source;
  inferred.clear();
}

/** Seed a model's inferred prefix directly, bypassing the source (tests, CLI). */
export function primeInferredModelPrefix(modelName: string, names: string[]): void {
  inferred.set(modelName.toLowerCase(), inferPrefixFromObjectNames(names, modelName));
}

/** Drop every cached inference (test isolation, workspace switch). */
export function clearInferredModelPrefixes(): void {
  inferred.clear();
}

/**
 * True when the operator has opted out of learning prefixes from the model and
 * wants the configured EXTENSION_PREFIX to be authoritative, as it was before.
 */
function inferenceDisabled(): boolean {
  return process.env.EXTENSION_PREFIX_SOURCE?.trim().toLowerCase() === 'config';
}

/**
 * The prefix this model's own objects use, or null when it has none to teach us
 * (empty model, no source installed, or inference switched off).
 */
export function getInferredModelPrefix(modelName: string): InferredModelPrefix | null {
  if (!modelName || inferenceDisabled()) return null;

  const key = modelName.toLowerCase();
  const cached = inferred.get(key);
  if (cached !== undefined) return cached;

  let result: InferredModelPrefix | null = null;
  try {
    const names = nameSource?.(modelName) ?? [];
    result = names.length > 0 ? inferPrefixFromObjectNames(names, modelName) : null;
    if (result) {
      console.error(
        `[ModelPrefix] Model "${modelName}" uses prefix "${result.regular}" ` +
        `(extension infix "${result.infix}") — inferred from ${result.coverage}/${result.sampleSize} of its objects`
      );
    }
  } catch (e) {
    console.error(`[ModelPrefix] Inference failed for "${modelName}": ${e}`);
    result = null;
  }

  inferred.set(key, result);
  return result;
}
