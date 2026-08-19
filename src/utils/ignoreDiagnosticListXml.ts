/**
 * Removal of <Diagnostic> suppression entries from a model's suppression list
 * ({Model}_BPSuppressions.xml, in the AxIgnoreDiagnosticList metadata FOLDER).
 *
 * The file's own ROOT ELEMENT is <IgnoreDiagnostics> — confirmed against a real
 * production suppression file — not
 * <AxIgnoreDiagnosticList><IgnoreDiagnostics>...</IgnoreDiagnostics></...> as an
 * earlier version of this module assumed by analogy with every other Ax* type's
 * folder-name-matches-root-element convention. <Name> and <Items> are direct
 * children of that root; <Diagnostic> blocks are direct children of <Items>, one
 * level shallower than first assumed. That first guess was flagged UNVERIFIED in
 * this module's own docs at the time and was wrong — this is the corrected,
 * measured shape.
 *
 * <Items> is a flat list of <Diagnostic> blocks — no nesting, same shape as
 * AxSecurityPrivilege's <EntryPoints> — so this mirrors removeSecurityEntryPoint
 * in securityPrivilegeXml.ts: regex-scan the flat blocks, match by <Path> (the
 * field BP-check itself uses to key a suppression, so it is the only identifier
 * guaranteed unique-per-rule-and-target), refuse rather than guess when a path
 * carries more than one diagnostic, and splice by byte offset.
 *
 * <Path> alone is not always unique: the same dynamics:// target can be ignored
 * by more than one moniker (an unresolved-label warning AND a doc-comment warning
 * on the same field, say) — `moniker` narrows that case the same way
 * entryPointObjectType narrows a duplicate objectName on a security privilege.
 */

/** One suppression entry as written into <Items>. */
export interface DiagnosticSuppressionEntry {
  /** <Path> — the dynamics:// target the finding was raised against. */
  path: string;
  /** <Moniker> — the BP rule this entry silences. */
  moniker: string;
}

export type RemoveDiagnosticSuppressionResult =
  /** Removed. `removed` is the entry that went, `xml` the updated document. */
  | { kind: 'removed'; xml: string; removed: DiagnosticSuppressionEntry }
  /** No diagnostic matched `path` (+ `moniker`). `present` lists the ones there are. */
  | { kind: 'not-found'; present: DiagnosticSuppressionEntry[] }
  /** More than one diagnostic matches — refuse rather than pick. */
  | { kind: 'ambiguous'; matches: DiagnosticSuppressionEntry[] }
  /** Not a suppression list (no <IgnoreDiagnostics> root); the caller declines. */
  | { kind: 'unsupported' };

/** Text of the first `<tag>…</tag>` inside `block`, or '' when absent. */
function childText(block: string, tag: string): string {
  const m = new RegExp(String.raw`<${tag}>([\s\S]*?)</${tag}>`).exec(block);
  return m ? m[1].trim() : '';
}

/** Every <Diagnostic> in the file, with its byte range. */
function scanDiagnostics(xml: string): Array<DiagnosticSuppressionEntry & { from: number; to: number }> {
  const found: Array<DiagnosticSuppressionEntry & { from: number; to: number }> = [];
  const re = /[\t ]*<Diagnostic>[\s\S]*?<\/Diagnostic>\n?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const block = m[0];
    found.push({
      path: childText(block, 'Path'),
      moniker: childText(block, 'Moniker'),
      from: m.index,
      to: m.index + block.length,
    });
  }
  return found;
}

/** Collapse an emptied <Items> to the self-closing spelling every other empty collection in this codebase's builders uses (<Fields />, <Methods />, …). */
function collapseIfEmpty(xml: string): string {
  return xml.replace(/<Items>\s*<\/Items>/, '<Items />');
}

/**
 * Remove one <Diagnostic> from a suppression list by exact <Path> match,
 * optionally narrowed by <Moniker> when the same path carries more than one
 * suppression.
 *
 * Two matches are refused rather than resolved: deleting the wrong one leaves a
 * live BP finding suppressed and silences the one that should have surfaced.
 *
 * When the last diagnostic goes, <Items> is collapsed to the self-closing spelling.
 */
export function removeDiagnosticSuppression(
  xml: string,
  criteria: { path: string; moniker?: string },
): RemoveDiagnosticSuppressionResult {
  if (!/<IgnoreDiagnostics\b/.test(xml)) return { kind: 'unsupported' };

  const entries = scanDiagnostics(xml);
  const present = entries.map(({ path, moniker }) => ({ path, moniker }));

  const eq = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

  const matches = entries.filter(e => {
    if (!eq(e.path, criteria.path)) return false;
    return criteria.moniker === undefined || eq(e.moniker, criteria.moniker);
  });

  if (matches.length === 0) return { kind: 'not-found', present };
  if (matches.length > 1) {
    return {
      kind: 'ambiguous',
      matches: matches.map(({ path, moniker }) => ({ path, moniker })),
    };
  }

  const hit = matches[0];
  let updated = xml.slice(0, hit.from) + xml.slice(hit.to);
  if (entries.length === 1) updated = collapseIfEmpty(updated);

  return {
    kind: 'removed',
    xml: updated,
    removed: { path: hit.path, moniker: hit.moniker },
  };
}

export type AddDiagnosticSuppressionResult =
  /** Inserted. `xml` is the updated document. */
  | { kind: 'added'; xml: string }
  /** An entry with the SAME <Path> and <Moniker> is already there — refuse a
   *  second copy of a suppression that already silences this exact finding. */
  | { kind: 'duplicate'; existing: DiagnosticSuppressionEntry }
  /** Not a suppression list (no <IgnoreDiagnostics> root); the caller declines. */
  | { kind: 'unsupported' };

/** Prefix every non-empty line of `block` with `indent`. */
function indentBlock(block: string, indent: string): string {
  return block.split('\n').map(line => (line.length ? `${indent}${line}` : line)).join('\n');
}

/**
 * Insert one <Diagnostic> block (as rendered by buildSuppressionXml in
 * bpMonikers/index.ts — the caller builds it, this only places it) into a
 * suppression list's <Items>.
 *
 * Refuses a duplicate — same <Path> AND <Moniker> — rather than writing a
 * second copy: xppbp does not need two identical suppressions, and a caller
 * who does not know one already exists benefits far more from being told than
 * from a file that silently grows a redundant entry every time they re-run
 * the same suppress call.
 *
 * Whitespace here is cosmetic, unlike buildAxSecurityPrivilegeXml's element
 * ORDER: <Items> is an unordered bag of sibling <Diagnostic> blocks, so this
 * matches an existing entry's indentation when there is one, and falls back to
 * a plausible default (two levels deep — <Diagnostic> is a direct child of
 * <Items>, itself a direct child of the root <IgnoreDiagnostics>, confirmed
 * against a real production file) for the first entry in a file — it does not
 * have to byte-match Microsoft's serializer the way an element order would,
 * because whitespace between elements does not change what deserializes.
 */
export function addDiagnosticSuppression(
  xml: string,
  diagnosticXml: string,
): AddDiagnosticSuppressionResult {
  if (!/<IgnoreDiagnostics\b/.test(xml)) return { kind: 'unsupported' };

  const newPath = childText(diagnosticXml, 'Path');
  const newMoniker = childText(diagnosticXml, 'Moniker');
  const dup = scanDiagnostics(xml).find(e =>
    e.path.trim().toLowerCase() === newPath.trim().toLowerCase() &&
    e.moniker.trim().toLowerCase() === newMoniker.trim().toLowerCase());
  if (dup) return { kind: 'duplicate', existing: { path: dup.path, moniker: dup.moniker } };

  const existingIndent = /\n([\t ]*)<Diagnostic>/.exec(xml)?.[1] ?? '\t\t';
  const block = indentBlock(diagnosticXml.trim(), existingIndent);

  let updated: string;
  if (/<Items\s*\/>/.test(xml)) {
    const closingIndent = existingIndent.slice(0, -1) || '\t';
    updated = xml.replace(/<Items\s*\/>/, `<Items>\n${block}\n${closingIndent}</Items>`);
  } else {
    // Last child, right before </Items> — preserves that tag's own indentation.
    updated = xml.replace(/([\t ]*)<\/Items>/, `${block}\n$1</Items>`);
  }

  return { kind: 'added', xml: updated };
}

/**
 * A fresh suppression list with no suppressions — used only when
 * add-diagnostic-suppression targets a model that has never suppressed
 * anything before, so {Model}_BPSuppressions.xml does not exist yet.
 *
 * Root/child shape confirmed against a real production suppression file:
 * root is <IgnoreDiagnostics> directly (no xmlns:i, no wrapping
 * AxIgnoreDiagnosticList element — that name is only the metadata FOLDER),
 * with <Name> and <Items> as its direct children. What
 * remains unverified is only that Visual Studio accepts an <Items /> with zero
 * children — every real file measured already had at least one <Diagnostic>,
 * because VS's own "Suppress in file" action is what normally creates this
 * file, so nothing has actually seen what VS itself writes for a brand new,
 * otherwise-empty one. The caller must disclose when this path is taken, so a
 * human can open the file in Visual Studio once and confirm it loads.
 */
export function emptySuppressionListXml(name: string): string {
  return (
    `<?xml version="1.0" encoding="utf-8"?>\n` +
    `<IgnoreDiagnostics>\n` +
    `\t<Name>${name}</Name>\n` +
    `\t<Items />\n` +
    `</IgnoreDiagnostics>`
  );
}

/**
 * Bulk-remove every <Diagnostic> whose <Path> is exactly `prefix` or addresses a
 * sub-element of it (`{prefix}/…` or `{prefix}?…`). Used to clean up suppressions
 * left behind when the object they targeted is deleted outright — see
 * deleteD365File.ts. Unlike removeDiagnosticSuppression this never refuses: a
 * deleted object can legitimately have accumulated several suppressions (a
 * control, a field, the object itself), and all of them are equally stale once
 * the object is gone.
 *
 * Returns an empty `removed` array (never `null`/throws) when nothing matches or
 * the file is not a suppression list, so callers can treat this as a
 * best-effort step that never blocks the delete it follows.
 */
export function removeDiagnosticSuppressionsByPathPrefix(
  xml: string,
  prefix: string,
): { xml: string; removed: DiagnosticSuppressionEntry[] } {
  if (!/<IgnoreDiagnostics\b/.test(xml)) return { xml, removed: [] };

  const entries = scanDiagnostics(xml);
  const needle = prefix.trim().toLowerCase();
  const matches = entries.filter(e => {
    const p = e.path.trim().toLowerCase();
    return p === needle || p.startsWith(`${needle}/`) || p.startsWith(`${needle}?`);
  });
  if (matches.length === 0) return { xml, removed: [] };

  // Delete widest offsets first so earlier splices don't shift later ones.
  let updated = xml;
  for (const m of [...matches].sort((a, b) => b.from - a.from)) {
    updated = updated.slice(0, m.from) + updated.slice(m.to);
  }
  if (matches.length === entries.length) updated = collapseIfEmpty(updated);

  return {
    xml: updated,
    removed: matches.map(({ path, moniker }) => ({ path, moniker })),
  };
}
