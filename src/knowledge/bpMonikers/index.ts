/**
 * BP-rule moniker lookup, search, and _BPSuppressions.xml generation.
 *
 * Backed by BP_MONIKER_CATALOG (catalog.generated.ts) — real data extracted
 * from a local D365FO install (see scripts/extract-bp-catalog.ps1), not a
 * hand-typed list. That distinction matters: a moniker typed from memory has
 * been wrong before (issue: proposed a moniker that turned out not to exist,
 * caught only by reading the xppc log by hand). Every lookup here either
 * confirms a real moniker or says plainly that it does not recognise one —
 * it never guesses a corrected spelling.
 */

import { BP_MONIKER_CATALOG, type BpMonikerEntry } from './catalog.generated.js';

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
  /** Names in the catalog that differ only by case, when the exact-case lookup missed — a common typo shape. */
  nearMisses: string[];
}

/**
 * Look up an exact moniker (case-insensitive). Does not fuzzy-match — a typo
 * should come back as "not found", not silently resolve to something else.
 */
export function validateMoniker(moniker: string): MonikerValidation {
  const trimmed = moniker.trim();
  const entry = BY_MONIKER.get(trimmed.toLowerCase()) ?? null;
  const nearMisses = entry
    ? []
    : BP_MONIKER_CATALOG
        .filter(e => e.moniker.toLowerCase() === trimmed.toLowerCase() && e.moniker !== trimmed)
        .map(e => e.moniker);
  return {
    moniker: trimmed,
    found: entry !== null,
    canonical: entry?.canonical ?? false,
    entry,
    nearMisses,
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
 * words shared between the query and the real rule text. Coverage is uneven:
 * only entries with a non-null message/description (545 of 577 at last
 * extraction) can match on that text at all; the rest match on the moniker
 * name alone. Callers should show `matchedIn` and the real description text
 * so a human/agent can judge the fit — never present the top hit as certain.
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

/** AOT element-type token used in the <Path>/<ElementType> of a real suppression entry (see ApplicationPlatform_BPSuppressions.xml). */
export type SuppressionElementType =
  | 'AxClass' | 'AxTable' | 'AxForm' | 'AxEnum' | 'AxEdt' | 'AxQuery' | 'AxView'
  | 'AxSecurityPrivilege' | 'AxSecurityDuty' | 'AxSecurityRole'
  | 'AxTableExtension' | 'AxFormExtension' | 'AxEnumExtension' | 'AxEdtExtension'
  | 'AxDataEntityView' | 'AxReport' | 'AxMenuItemDisplay' | 'AxMenuItemAction' | 'AxMenuItemOutput';

/** dynamics:// path prefix per element type, taken from real suppression files — e.g. SecurityPrivilege, Tables, Forms. */
const PATH_SEGMENT: Record<SuppressionElementType, string> = {
  AxClass: 'Classes',
  AxTable: 'Tables',
  AxForm: 'Forms',
  AxEnum: 'Enums',
  AxEdt: 'ExtendedDataTypes',
  AxQuery: 'Queries',
  AxView: 'Views',
  AxSecurityPrivilege: 'SecurityPrivilege',
  AxSecurityDuty: 'SecurityDuty',
  AxSecurityRole: 'SecurityRole',
  AxTableExtension: 'Tables',
  AxFormExtension: 'Forms',
  AxEnumExtension: 'Enums',
  AxEdtExtension: 'ExtendedDataTypes',
  AxDataEntityView: 'DataEntityViews',
  AxReport: 'Reports',
  AxMenuItemDisplay: 'MenuItemsDisplay',
  AxMenuItemAction: 'MenuItemsAction',
  AxMenuItemOutput: 'MenuItemsOutput',
};

export interface BuildSuppressionInput {
  moniker: string;
  elementType: SuppressionElementType;
  /** The object the warning was raised against, e.g. a privilege or table name. */
  elementName: string;
  /** Shown in the generated <Message> in place of the real xppbp text — pass the real message if you have it (from a run_bp_check finding) for an accurate suppression record. */
  message?: string;
  severity?: 'Error' | 'Warning';
}

export interface BuildSuppressionResult {
  xml: string;
  /** Set when the moniker is not in the catalog at all — the caller should surface this instead of silently emitting XML for a name that may not exist. */
  warning: string | null;
}

/**
 * Render one <Diagnostic> block in the real Microsoft AxIgnoreDiagnosticList
 * shape (matched against ApplicationPlatform_BPSuppressions.xml, not the
 * shorter template comment those files also carry) — ready to paste into
 * src/Metadata/{Model}/{Model}/AxIgnoreDiagnosticList/{Model}_BPSuppressions.xml.
 *
 * Does not fabricate a message: if the caller has the real one from a
 * run_bp_check finding, pass it; otherwise this falls back to the catalog's
 * message template (still real text) or, lacking that, a plain
 * "<Moniker>: <ElementName>" placeholder — never an invented sentence.
 */
export function buildSuppressionXml(input: BuildSuppressionInput): BuildSuppressionResult {
  const validation = validateMoniker(input.moniker);
  const warning = validation.found
    ? (validation.canonical ? null : `'${input.moniker}' was found only in rule-DLL resource text, not in any model's AxRuleSet/BPRules.xml — double-check the spelling before relying on it.`)
    : `'${input.moniker}' is not in the extracted catalog (${BP_MONIKER_CATALOG.length} known monikers). It may be real but uncovered by the extraction, or a typo — verify against an actual BP check finding before suppressing.`;

  const message = input.message
    ?? validation.entry?.message?.replace(/\{\d+\}/g, input.elementName)
    ?? `${input.moniker}: ${input.elementName}`;

  const severity = input.severity ?? 'Warning';
  const pathSegment = PATH_SEGMENT[input.elementType];
  const escapeXml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const xml = [
    '<Diagnostic>',
    '  <DiagnosticType>BestPractices</DiagnosticType>',
    `  <Severity>${severity}</Severity>`,
    `  <Path>dynamics://${pathSegment}/${escapeXml(input.elementName)}</Path>`,
    `  <ElementType>${input.elementType}</ElementType>`,
    `  <Moniker>${escapeXml(validation.moniker)}</Moniker>`,
    `  <Message>${escapeXml(message)}</Message>`,
    '  <ItemSpecific>',
    `    <OriginatorType alias="0">${escapeXml(validation.moniker)}</OriginatorType>`,
    '    <Fields>',
    `      <ElementName>${escapeXml(input.elementName)}</ElementName>`,
    '    </Fields>',
    '  </ItemSpecific>',
    '</Diagnostic>',
  ].join('\n');

  return { xml, warning };
}

export { BP_MONIKER_CATALOG, type BpMonikerEntry };
