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
