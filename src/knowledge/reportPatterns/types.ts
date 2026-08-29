/**
 * Report-pattern catalog types.
 *
 * Unlike form patterns — which are metadata patterns validated against AxForm
 * XML — a report "pattern" is an implementation RECIPE: which objects to
 * create, what each extends, which scaffold call produces the whole set, and
 * what to verify afterwards. The catalog is the report-side counterpart of
 * src/knowledge/formPatterns/, served through object_patterns(domain="report").
 */

/** One object in a pattern's roster. */
export interface ReportObjectSpec {
  /** Role in the pattern (e.g. "TmpTable", "Data provider"). */
  role: string;
  /** Naming convention relative to the report name (e.g. "{Name}DP"). */
  naming: string;
  /** AOT kind plus the base class / table type it must carry. */
  baseOrType: string;
  /** Role-specific guidance. */
  notes?: string;
}

export interface ReportPatternSpec {
  /** Stable id, matched case-insensitively (also without hyphens). */
  id: string;
  displayName: string;
  /** Alternative names agents reach for. */
  aliases?: string[];
  purpose: string;
  whenToUse: string[];
  whenNotToUse?: string[];
  /** Object roster the pattern produces. */
  objects: ReportObjectSpec[];
  /** The generate_object call that scaffolds the full roster in one step. */
  scaffold: string;
  /** Key method overrides / stubs, in build order. */
  methodNotes: string[];
  /** What to verify after generation (validators, design name, build). */
  crossChecks: string[];
  /** Standard AOT reports demonstrating the pattern. */
  referenceReports?: string[];
  /** Knowledge topic ids with the deeper rules. */
  relatedTopics?: string[];
}
