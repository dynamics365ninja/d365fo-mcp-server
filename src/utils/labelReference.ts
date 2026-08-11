/**
 * Label reference formatting + deployability annotation.
 *
 * Defect #33/#41 (reproduced twice on the VM): the labels tool advertised
 * `@SYS:@SYS67433` — it built every reference as `@${labelFileId}:${labelId}`
 * without noticing that the indexed label id already carries its own
 * `@FileId` prefix. xppbp rejects that doubled form:
 *   `BPErrorLabelIsText: '@SYS:@SYS67433' is not a label ID`
 * The form xppbp accepts is `@SYS67433`.
 *
 * Second half of the same finding: the tool happily suggests labels from label
 * files that are not deployed/referenced here (`@EnterpriseAssetManagementAppSuite:*`,
 * `@RevenueRecognition:ItemName` → "Unknown label" / `BPErrorUnknownLabel`).
 * Suggesting a reference the model cannot resolve is a defect, so results carry
 * an explicit provenance warning instead of reading as ready-to-use.
 */

/**
 * Canonical X++/metadata label reference for an indexed label row.
 *
 *   ('SYS', '@SYS67433')       → '@SYS67433'   (id already carries its file id)
 *   ('SYS', 'SYS67433')        → '@SYS67433'   (legacy id-embeds-file-id form)
 *   ('ContosoExt', 'MyLabel')  → '@ContosoExt:MyLabel'
 *   ('ContosoExt', '@ContosoExt:MyLabel') → unchanged
 */
export function formatLabelReference(labelFileId: string | undefined, labelId: string): string {
  const id = (labelId ?? '').trim();
  const fileId = (labelFileId ?? '').trim();

  // Repair an already-doubled reference (`@SYS:@SYS67433` → `@SYS67433`) — the
  // exact shape xppbp rejects, which can also arrive from stored data.
  const doubled = /^@[A-Za-z0-9_]+:(@.+)$/.exec(id);
  if (doubled) return doubled[1];

  // Already a complete reference (either legacy `@SYS123` or `@File:Id`).
  if (id.startsWith('@')) return id;
  if (!fileId) return `@${id}`;

  // Legacy form: the id embeds the label file id (`SYS67433` in file `SYS`).
  // Emitting `@SYS:SYS67433` here is what produced the doubled `@SYS:@SYS67433`
  // once the stored id kept its `@`; the id-embeds-file-id shape must collapse.
  if (id.toLowerCase().startsWith(fileId.toLowerCase()) && id.length > fileId.length) {
    return `@${id}`;
  }

  return `@${fileId}:${id}`;
}

/**
 * Inverse of {@link formatLabelReference}: a reference (or a bare id) → the
 * parts a lookup needs.
 *
 *   '@ContosoExt:EquipmentName' → { labelFileId: 'ContosoExt', labelId: 'EquipmentName' }
 *   '@GLS4170035'               → { labelId: 'GLS4170035' }
 *   'GLS4170035'                → { labelId: 'GLS4170035' }
 *   '@SYS:@SYS67433'            → { labelFileId: 'SYS', labelId: '@SYS67433' }
 *
 * The `@` is dropped from the legacy form on purpose: which spelling the index
 * holds depends on the file, so callers pair this with
 * {@link labelIdSpellings} rather than assuming either one.
 */
export function parseLabelReference(ref: string): { labelFileId?: string; labelId: string } {
  const s = (ref ?? '').trim();
  if (!s) return { labelId: '' };

  // `@File:Id`, including the doubled `@SYS:@SYS67433` the formatter repairs —
  // there the id half keeps its own '@' because that IS the stored id.
  const modern = /^@([A-Za-z][A-Za-z0-9_]*):(.+)$/.exec(s);
  if (modern) return { labelFileId: modern[1], labelId: modern[2] };

  return { labelId: s.startsWith('@') ? s.slice(1) : s };
}

/** A legacy AX-era id: 2-4 letters naming the label file, then digits. */
const LEGACY_LABEL_ID = /^[A-Za-z]{2,4}\d+$/;

/**
 * Every spelling of a label id the index may hold, for one lookup.
 *
 * #888: `labelParser` stores the `Key=` token verbatim, and the 27 legacy AX-era
 * label files (SYS SYP GLS … WAX — 865k of the 1.42M indexed rows on the
 * reference environment) write theirs WITH the sigil: `@GLS4170035=Accountants`.
 * Modern files write `EquipmentName=`. A lookup that matches one spelling
 * therefore misses whichever set it did not guess, which is why
 * `labels(action="info", labelId="GLS4170035")` reported "not found" for a label
 * it had just listed the file of.
 *
 * Uppercasing is applied to the legacy shape only. Every key in the 27 files is
 * all-uppercase (verified across them), so `@sys67433` is recoverable for free;
 * a modern id's casing is the author's and is left alone.
 */
export function labelIdSpellings(labelId: string): string[] {
  const id = (labelId ?? '').trim();
  if (!id) return [];

  const out = [id, `@${id}`];
  if (LEGACY_LABEL_ID.test(id)) {
    const upper = id.toUpperCase();
    if (upper !== id) out.push(upper, `@${upper}`);
  }
  return [...new Set(out)];
}

/**
 * Label files that every model can resolve without adding a package reference.
 * Deliberately small and conservative — anything else gets flagged rather than
 * silently recommended.
 */
const ALWAYS_RESOLVABLE_LABEL_FILES = new Set(
  ['sys', 'syp', 'sysbp', 'applicationplatform', 'applicationfoundation', 'applicationsuite'],
);

/**
 * True when a label reference is safe to hand to the model as-is: it lives in a
 * core label file or in the caller's own model. Anything else may raise
 * `BPErrorUnknownLabel` because its owning package is not referenced.
 */
export function isLabelLikelyResolvable(
  labelFileId: string | undefined,
  labelModel: string | undefined,
  currentModel?: string,
): boolean {
  const fileId = (labelFileId ?? '').toLowerCase();
  if (ALWAYS_RESOLVABLE_LABEL_FILES.has(fileId)) return true;
  if (currentModel && (labelModel ?? '').toLowerCase() === currentModel.toLowerCase()) return true;
  if (currentModel && fileId === currentModel.toLowerCase()) return true;
  return false;
}

/** Short inline warning for a label whose owning package may not be referenced. */
export function labelProvenanceWarning(labelModel: string | undefined): string {
  return `⚠️ owned by model "${labelModel ?? 'unknown'}" — resolves only if your model references ` +
    `that package; otherwise xppbp reports BPErrorUnknownLabel`;
}

/** How many owning models the hoisted warning names before it stops listing them. */
const MAX_NAMED_MODELS = 5;

/**
 * One warning for a whole result set instead of one per row (#832): repeating
 * {@link labelProvenanceWarning} on every hit cost ~2,5 kB per search and said
 * the same sentence up to 30 times. `models` are the distinct owners of the
 * flagged rows, in result order.
 */
export function crossModelLabelWarning(models: string[], flaggedCount: number): string {
  const named = models.slice(0, MAX_NAMED_MODELS).map(m => m || 'unknown');
  const rest = models.length - named.length;
  const list = named.join(', ') + (rest > 0 ? `, +${rest} more` : '');
  return `⚠️ ${flaggedCount} result(s) marked ⚠️ are owned by other models (${list}) — each resolves ` +
    `only if your model references that package; otherwise xppbp reports BPErrorUnknownLabel.`;
}
