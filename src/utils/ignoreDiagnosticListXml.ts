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
  | { kind: 'unsupported' }
  /** A suppression list, but with no <Items> collection to insert into — there is
   *  nowhere to put the entry, and reporting success would write the file back
   *  byte-identical under a ✅. */
  | { kind: 'no-items' };

/**
 * Re-indent a <Diagnostic> block to the file's own indentation style.
 *
 * buildSuppressionXml renders two spaces per level; a real suppression file is
 * indented with tabs (or with two spaces — both occur in a shipped
 * PackagesLocalDirectory). Prefixing the rendered block with the file's indent
 * without touching its own leading whitespace produced "\t\t  <Path>" — tabs and
 * spaces on one line, in a file that uses neither mix anywhere else. So each
 * line's own depth is measured in the block's units and re-emitted in the
 * file's: purely cosmetic, but it is the difference between a diff a reviewer
 * skims and one they stop at.
 */
function indentBlock(block: string, baseIndent: string): string {
  const unit = baseIndent.includes('\t') ? '\t' : '  ';
  return block
    .split('\n')
    .map(line => {
      if (!line.trim()) return '';
      const depth = Math.floor((/^ */.exec(line)?.[0].length ?? 0) / 2);
      return `${baseIndent}${unit.repeat(depth)}${line.trimStart()}`;
    })
    .join('\n');
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
 *
 * An empty <Items> is spelled BOTH ways in a shipped PackagesLocalDirectory —
 * `<Items />` (EntAssetManufacturingExecutionBackoffice_BPSuppressions.xml) and
 * `<Items></Items>` (BusinessIntelligence_BPSuppressions.xml) — so both are
 * expanded here. The second used to fall through to the generic "insert before
 * </Items>" branch, which placed the block on the same line as the opening tag.
 *
 * A document with NO <Items> at all comes back as 'no-items' rather than as a
 * successful insert: both replaces below are no-ops there, and returning
 * 'added' with an unchanged document is a ✅ over a file that gained nothing.
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

  // `<Items />` and `<Items></Items>` are the same empty collection; both get
  // expanded around the new block rather than appended to.
  const emptyItems = /<Items\s*\/>|<Items>\s*<\/Items>/;
  let updated: string;
  if (emptyItems.test(xml)) {
    const closingIndent = existingIndent.slice(0, -1) || '\t';
    updated = xml.replace(emptyItems, `<Items>\n${block}\n${closingIndent}</Items>`);
  } else {
    // Last child, right before </Items> — preserves that tag's own indentation.
    updated = xml.replace(/([\t ]*)<\/Items>/, `${block}\n$1</Items>`);
  }

  if (updated === xml) return { kind: 'no-items' };

  return { kind: 'added', xml: updated };
}

/**
 * A fresh suppression list with no suppressions — used only when
 * add-diagnostic-suppression targets a model that has never suppressed
 * anything before, so {Model}_BPSuppressions.xml does not exist yet.
 *
 * Every part of this is measured against the 339 AxIgnoreDiagnosticList files
 * of a shipped 10.0 PackagesLocalDirectory — including, contrary to what an
 * earlier version of this docblock claimed was unknowable, the empty case:
 *
 *   • Root is <IgnoreDiagnostics> directly. There is no wrapping
 *     <AxIgnoreDiagnosticList> element — that name is only the metadata FOLDER.
 *   • The root carries xmlns:i in 264 of those 339 files, so it is what
 *     Microsoft's current serializer emits (the bare root in the remaining 75
 *     also loads — both spellings ship — but matching the majority keeps a
 *     tool-written file indistinguishable from a VS-written one).
 *   • <Name> is the file's own base name, not the model's:
 *     ER_App_Suite_Int_BPSuppressions.xml in model "Electronic Reporting
 *     Application Suite Integration" carries <Name>ER_App_Suite_Int_BPSuppressions</Name>.
 *   • An EMPTY list is a real, shipped shape — no disclosure needed, and none
 *     is made any more:
 *       EntAssetManufacturingExecutionBackoffice_BPSuppressions.xml → <Items />
 *       BusinessIntelligence_BPSuppressions.xml                    → <Items></Items>
 */
export function emptySuppressionListXml(name: string): string {
  return (
    `<?xml version="1.0" encoding="utf-8"?>\n` +
    `<IgnoreDiagnostics xmlns:i="http://www.w3.org/2001/XMLSchema-instance">\n` +
    `\t<Name>${name}</Name>\n` +
    `\t<Items />\n` +
    `</IgnoreDiagnostics>`
  );
}

/**
 * dynamics:// path segments an object of `objectType` can be addressed by.
 *
 * The segment is the AOT element type without its 'Ax' prefix — the rule
 * pathSegmentFor (bpMonikers/index.ts) applies on the ADD side, verified there
 * against every real entry carrying both <Path> and <ElementType>. Deriving it
 * from the metadata FOLDER instead, as this cleanup first did, agrees for most
 * types but is measurably wrong for two, and a wrong segment matches nothing:
 *
 *   • edt   → folder AxEdt gives 'Edt', which appears in ZERO real paths. Real
 *     ones name the concrete EDT type: EdtString (62 entries), EdtInt (7),
 *     EdtEnum (4), EdtInt64 (3), EdtDate (2), EdtReal (1), EdtGuid (1).
 *   • query → folder AxQuery gives 'Query'; real paths say QuerySimple (9).
 *
 * Deleting an EDT or a query therefore left every one of its suppressions
 * behind while reporting a clean delete — the exact stale-suppression state
 * this cleanup exists to prevent. Returning SEVERAL candidate segments is what
 * covers the EDT family; a prefix is anchored on the object's own name, so an
 * extra candidate that never occurs simply matches nothing.
 */
export function suppressionPathSegmentsForObjectType(
  objectType: string,
  axFolder: string,
): string[] {
  const overrides: Record<string, string[]> = {
    edt: ['EdtString', 'EdtInt', 'EdtInt64', 'EdtEnum', 'EdtReal', 'EdtDate', 'EdtGuid', 'Edt'],
    query: ['QuerySimple', 'Query'],
  };
  return overrides[objectType] ?? [axFolder.replace(/^Ax/, '')];
}

/**
 * Bulk-remove every <Diagnostic> whose <Path> is exactly one of `prefixes` or
 * addresses a sub-element of one (`{prefix}/…` or `{prefix}?…` — both separators
 * occur in real files: `dynamics://Form/X/FormDesign/…` and
 * `dynamics://EdtString/X?StringSize`). Used to clean up suppressions left
 * behind when the object they targeted is deleted outright — see
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
  prefix: string | string[],
): { xml: string; removed: DiagnosticSuppressionEntry[] } {
  if (!/<IgnoreDiagnostics\b/.test(xml)) return { xml, removed: [] };

  const entries = scanDiagnostics(xml);
  const needles = (Array.isArray(prefix) ? prefix : [prefix]).map(p => p.trim().toLowerCase());
  const matches = entries.filter(e => {
    const p = e.path.trim().toLowerCase();
    return needles.some(n => p === n || p.startsWith(`${n}/`) || p.startsWith(`${n}?`));
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
