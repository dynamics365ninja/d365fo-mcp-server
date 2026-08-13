/**
 * BP-rule moniker lookup, search, and _BPSuppressions.xml generation.
 *
 * Backed by BP_MONIKER_CATALOG (catalog.generated.ts) — real data extracted
 * from a local D365FO install (see scripts/extract-bp-catalog.ps1), not a
 * hand-typed list. That distinction matters: a moniker typed from memory has
 * been wrong before (issue: proposed a moniker that turned out not to exist,
 * caught only by reading the xppc log by hand). Every lookup here either
 * confirms a real moniker or says plainly that it does not recognise one. It
 * may offer candidates alongside a miss, but never silently resolves a typo
 * into one of them — `found` stays false and the caller must confirm.
 *
 * Two things the catalog does NOT prove, both of which callers used to get
 * wrong: an entry with `canonical: false` came only from a rule DLL's resource
 * strings, a source that also contains non-BP messages; and the suppression
 * shape below follows what real AxIgnoreDiagnosticList files contain, measured
 * across all 299 of them, not what one sampled entry happened to look like.
 *
 * The compiled-in catalog above is one snapshot from one D365FO box, shared by
 * the whole npm install. An instance that has regenerated its OWN catalog
 * (`d365fo-mcp instance rebuild/upgrade` — see ensureBpCatalogFresh in
 * src/cli/commands/indexCmd.ts) points BP_CATALOG_PATH at that JSON file
 * instead, so validate/search reflects its actual pinned version rather than
 * whichever box the shipped snapshot happened to come from. Same fallback
 * shape as METADATA_PATH (src/utils/metadataResolver.ts): env var unset, or
 * the file missing/unparsable, silently keeps the compiled default — no
 * instance is worse off for never having regenerated one.
 */

import { readFileSync } from 'node:fs';
import { BP_MONIKER_CATALOG as COMPILED_CATALOG, type BpMonikerEntry } from './catalog.generated.js';

interface BpCatalogFile {
  entries?: unknown;
}

function loadCatalog(): BpMonikerEntry[] {
  const overridePath = process.env.BP_CATALOG_PATH;
  if (!overridePath) return COMPILED_CATALOG;
  try {
    const parsed = JSON.parse(readFileSync(overridePath, 'utf-8')) as BpCatalogFile;
    if (!Array.isArray(parsed.entries)) {
      console.warn(`BP_CATALOG_PATH (${overridePath}) has no 'entries' array — using the compiled-in catalog instead.`);
      return COMPILED_CATALOG;
    }
    return parsed.entries as BpMonikerEntry[];
  } catch (err) {
    // Missing file (never regenerated for this instance yet) or malformed JSON
    // are both routine, not errors — the compiled default is always a valid
    // fallback, so a bad override must never make bp_moniker unusable.
    console.warn(`BP_CATALOG_PATH (${overridePath}) could not be read (${(err as Error).message}) — using the compiled-in catalog instead.`);
    return COMPILED_CATALOG;
  }
}

const BP_MONIKER_CATALOG: BpMonikerEntry[] = loadCatalog();

const BY_MONIKER: ReadonlyMap<string, BpMonikerEntry> = new Map(
  BP_MONIKER_CATALOG.map(e => [e.moniker.toLowerCase(), e]),
);

export interface MonikerValidation {
  moniker: string;
  /** True if the exact name (case-insensitive) is in the catalog at all. */
  found: boolean;
  /** True if it also appears in at least one model's AxRuleSet/BPRules.xml — the strongest confirmation. */
  canonical: boolean;
  entry: BpMonikerEntry | null;
  /**
   * Catalog names sharing words with the input, when the exact lookup missed.
   * Suggestions only: `found` stays false and the caller must present these as
   * candidates to confirm, never as a correction. Populated by splitting the
   * input's PascalCase into words and reusing the same token search the
   * `search` action uses — so a near-miss typo lands on the real name instead
   * of dead-ending into another round trip.
   */
  suggestions: string[];
}

/**
 * Look up an exact moniker (case-insensitive). Does not fuzzy-match — a typo
 * comes back as "not found" with suggestions attached, never silently resolved
 * to something else.
 */
export function validateMoniker(moniker: string): MonikerValidation {
  const trimmed = moniker.trim();
  const entry = BY_MONIKER.get(trimmed.toLowerCase()) ?? null;
  // A case-only difference cannot reach here — BY_MONIKER is keyed lowercase,
  // so it would already have hit above. Suggestions are word-overlap instead,
  // which is the miss that actually happens.
  const suggestions = entry ? [] : searchMonikers(splitPascalCase(trimmed), 5).map(r => r.entry.moniker);
  return {
    moniker: trimmed,
    found: entry !== null,
    canonical: entry?.canonical ?? false,
    entry,
    suggestions,
  };
}

export interface MonikerSearchResult {
  entry: BpMonikerEntry;
  /** Number of distinct query tokens matched, in moniker name + message + description. */
  score: number;
  matchedIn: Array<'moniker' | 'message' | 'description'>;
}

/**
 * Search the catalog by free text against real rule text — the moniker name
 * (PascalCase words split apart), message template, and description.
 *
 * This is keyword/token overlap, not embeddings — it is only as good as the
 * words shared between the query and the real rule text. Text coverage is
 * high, not sparse: 545 of 577 entries carry a real message (94%), and 221
 * also carry a description. Only 32 entries are name-only, and a miss is
 * therefore reasonably informative — do not tell callers to discount it.
 * What the search cannot do is match a paraphrase sharing no words with the
 * rule text. Callers should show `matchedIn` and the real description so a
 * human/agent can judge the fit — never present the top hit as certain.
 */
export function searchMonikers(query: string, limit = 10): MonikerSearchResult[] {
  const tokens = tokenize(query);
  if (tokens.length === 0) return [];

  const results: MonikerSearchResult[] = [];
  for (const entry of BP_MONIKER_CATALOG) {
    const monikerTokens = tokenize(splitPascalCase(entry.moniker));
    const messageTokens = entry.message ? tokenize(entry.message) : [];
    const descriptionTokens = entry.description ? tokenize(entry.description) : [];

    const matchedIn = new Set<'moniker' | 'message' | 'description'>();
    let score = 0;
    for (const token of new Set(tokens)) {
      let matchedThisToken = false;
      if (monikerTokens.includes(token)) { matchedIn.add('moniker'); matchedThisToken = true; }
      if (messageTokens.includes(token)) { matchedIn.add('message'); matchedThisToken = true; }
      if (descriptionTokens.includes(token)) { matchedIn.add('description'); matchedThisToken = true; }
      if (matchedThisToken) score++;
    }
    if (score > 0) {
      results.push({ entry, score, matchedIn: [...matchedIn] });
    }
  }

  results.sort((a, b) => b.score - a.score || (a.entry.canonical === b.entry.canonical ? 0 : a.entry.canonical ? -1 : 1));
  return results.slice(0, limit);
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(t => t.length > 2 && !STOP_WORDS.has(t));
}

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'has', 'have', 'not', 'are', 'was',
  'should', 'must', 'any', 'all', 'from', 'into', 'when', 'does', 'can',
]);

/** 'BPErrorPrivilegeNotCoveredByDuty' → 'BP Error Privilege Not Covered By Duty' */
function splitPascalCase(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
}

// ─── Suppression XML ────────────────────────────────────────────────────────

/**
 * Top-level AOT element types observed in real AxIgnoreDiagnosticList files.
 *
 * Measured, not assumed: every <Diagnostic> in all 299 *_BPSuppressions.xml /
 * AxIgnoreDiagnosticList files of a 10.0 PackagesLocalDirectory was parsed
 * (19,619 blocks carrying both <Path> and <ElementType>; 10,915 of them
 * DiagnosticType=BestPractices). This list is the set of types whose element
 * name alone determines the whole path — see PATH_SEGMENT below for the rule
 * and for why sub-element types are deliberately absent.
 */
export type SuppressionElementType =
  | 'AxClass' | 'AxTable' | 'AxForm' | 'AxView' | 'AxMap' | 'AxEnum' | 'AxQuerySimple'
  | 'AxDataEntityView' | 'AxAggregateMeasurement' | 'AxAggregateDimension'
  | 'AxSecurityPrivilege' | 'AxSecurityDuty' | 'AxSecurityRole'
  | 'AxTableExtension' | 'AxFormExtension' | 'AxMenuExtension'
  | 'AxMenu' | 'AxMenuItemDisplay' | 'AxMenuItemAction' | 'AxMenuItemOutput'
  | 'AxEdtString' | 'AxEdtInt' | 'AxEdtInt64' | 'AxEdtEnum' | 'AxEdtReal'
  | 'AxEdtDate' | 'AxEdtGuid'
  | 'AxConfigurationKey' | 'AxLicenseCode';

/**
 * dynamics:// path segment for a top-level element type: the type name with
 * its 'Ax' prefix removed, singular.
 *
 * Verified against every real entry that carries both fields — 1,447 of them
 * under DiagnosticType=BestPractices, with zero exceptions ('AxClass' →
 * 'Class', 'AxTableExtension' → 'TableExtension', 'AxEdtString' →
 * 'EdtString'). The plural forms an earlier version of this file used
 * ('Classes', 'Tables', 'ExtendedDataTypes') appear nowhere in any real file:
 * a suppression carrying one silently matches no element and suppresses
 * nothing, which is worse than emitting no suppression at all.
 *
 * The rule holds only for TOP-LEVEL types. Sub-element types — 'AxEnumValue',
 * 'AxFormStringControl', 'AxTableFieldString', 'Class Method' and friends —
 * take their CONTAINING element's segment and then drill in ('Enum' for
 * AxEnumValue: dynamics://Enum/{Enum}/EnumValue/{Value}?Property), with real
 * paths running to 22 segments. There is no way to derive those from a type
 * and a name, so they are not in the union above; for them the caller passes
 * `path` verbatim from the finding, which is what Microsoft's own template
 * comment tells a human to do ("path given in warning message").
 */
function pathSegmentFor(elementType: SuppressionElementType): string {
  return elementType.replace(/^Ax/, '');
}

export interface BuildSuppressionInput {
  moniker: string;
  /**
   * The exact dynamics:// path from the BP finding. Preferred over
   * elementType+elementName: it is the only way to address a sub-element
   * (a control, a field, a method, an enum value) and it is what the finding
   * hands you anyway. Given this, elementType/elementName are not needed.
   */
  path?: string;
  /** Top-level element type, used only to derive `path` when `path` is absent. */
  elementType?: SuppressionElementType;
  /** The object the warning was raised against, e.g. a privilege or table name. */
  elementName?: string;
  /** Why this warning is being ignored. Real files carry one on 95% of entries; without it the block is incomplete. */
  justification?: string;
  /** The real message text from the finding. Omitted from the output when absent rather than invented. */
  message?: string;
  severity?: 'Error' | 'Warning';
  /**
   * Emit the <ItemSpecific> block. Off by default — only 999 of 10,915 real
   * BestPractices entries carry it, and always for element-specific rules
   * (BPErrorUnknownLabel, BPXmlDoc*, BPErrorPrivilegeNotCoveredByDuty …).
   * Requires elementName.
   */
  itemSpecific?: boolean;
}

export interface BuildSuppressionResult {
  xml: string;
  /** Blocking problems — the XML is still returned, but it should not be pasted as-is. */
  errors: string[];
  /** Non-blocking notes the caller must surface (unknown moniker, missing justification, …). */
  warnings: string[];
}

/**
 * Render one <Diagnostic> block for
 * {Model}/{Model}/AxIgnoreDiagnosticList/{Model}_BPSuppressions.xml.
 *
 * Element order and optionality follow what real files actually contain, not
 * what one sampled entry happened to show. Across 10,915 real BestPractices
 * blocks: <Justification> 95%, <Message> 43%, <ElementType> 13%,
 * <ItemSpecific> 9%. Microsoft's own template comment at the top of those
 * files lists exactly DiagnosticType, Severity, Path, Moniker, Justification
 * — so that is what is always emitted, and the three rarer elements only when
 * the caller supplies the data for them.
 *
 * Nothing here is invented: no message is fabricated when none is known, and
 * no justification is written on the caller's behalf — a missing one is
 * reported as a warning and marked with an obvious TODO, because a
 * suppression whose reason is blank is what a reviewer rejects.
 */
export function buildSuppressionXml(input: BuildSuppressionInput): BuildSuppressionResult {
  const validation = validateMoniker(input.moniker);
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!validation.found) {
    warnings.push(
      `'${input.moniker}' is not in the extracted catalog (${BP_MONIKER_CATALOG.length} known monikers). ` +
      `It may be real but uncovered by the extraction, or a typo — verify against an actual BP check finding before suppressing.` +
      (validation.suggestions.length ? ` Closest catalog names: ${validation.suggestions.join(', ')}.` : ''),
    );
  } else if (!validation.canonical) {
    warnings.push(
      `'${validation.entry!.moniker}' appears only in rule-DLL resource text, not in any model's AxRuleSet/BPRules.xml. ` +
      `Some strings in that source are not BP rules at all (upgrade-tool messages, for example) — confirm it against a real BP finding.`,
    );
  }

  // Path: prefer the caller's verbatim one. Deriving it from a type and a name
  // only ever addresses a top-level element.
  let path: string;
  if (input.path) {
    path = input.path.trim();
    if (!path.startsWith('dynamics://')) {
      errors.push(`path must start with 'dynamics://' — got '${path}'. Copy it verbatim from the finding.`);
    }
  } else if (input.elementType && input.elementName) {
    path = `dynamics://${pathSegmentFor(input.elementType)}/${input.elementName.trim()}`;
  } else {
    errors.push('Need either `path` (preferred, verbatim from the finding) or both `elementType` and `elementName`.');
    path = 'dynamics://UNKNOWN/UNKNOWN';
  }

  if (input.itemSpecific && !input.elementName) {
    errors.push('itemSpecific requires `elementName` — the <Fields><ElementName> it wraps has nothing to hold otherwise.');
  }

  let justification = input.justification?.trim();
  if (!justification) {
    justification = 'TODO: state why this warning is being ignored before committing this file.';
    warnings.push(
      'No justification given. 95% of real suppression entries carry one and a blank reason is what a reviewer rejects — ' +
      'replace the TODO before committing.',
    );
  }

  // The catalog template is real text but is written for ONE placeholder set;
  // filling {0},{1},{2} all with the same name produces a sentence that reads
  // as nonsense ("greater than MyClass within class MyClass"). Use it only
  // when it takes exactly one placeholder, otherwise emit no <Message> at all
  // — <Message> is absent from 57% of real entries, so omitting is normal.
  const template = validation.entry?.message ?? null;
  const placeholders = template ? new Set(template.match(/\{\d+\}/g) ?? []) : new Set<string>();
  const message =
    input.message?.trim() ||
    (template && input.elementName && placeholders.size <= 1
      ? template.replace(/\{\d+\}/g, input.elementName.trim())
      : null);

  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const lines = [
    '<Diagnostic>',
    '  <DiagnosticType>BestPractices</DiagnosticType>',
    `  <Severity>${input.severity ?? 'Warning'}</Severity>`,
    `  <Path>${esc(path)}</Path>`,
  ];
  if (input.elementType) lines.push(`  <ElementType>${input.elementType}</ElementType>`);
  lines.push(`  <Moniker>${esc(validation.entry?.moniker ?? validation.moniker)}</Moniker>`);
  if (message) lines.push(`  <Message>${esc(message)}</Message>`);
  if (input.itemSpecific && input.elementName) {
    lines.push(
      '  <ItemSpecific>',
      `    <OriginatorType alias="0">${esc(validation.entry?.moniker ?? validation.moniker)}</OriginatorType>`,
      '    <Fields>',
      `      <ElementName>${esc(input.elementName.trim())}</ElementName>`,
      '    </Fields>',
      '  </ItemSpecific>',
    );
  }
  lines.push(`  <Justification>${esc(justification)}</Justification>`, '</Diagnostic>');

  return { xml: lines.join('\n'), errors, warnings };
}

export { BP_MONIKER_CATALOG, type BpMonikerEntry };
