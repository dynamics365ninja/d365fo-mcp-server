/**
 * Warehouse-app (mobile device) pattern catalog types.
 *
 * A "pattern" here is an implementation RECIPE for one screen-level task —
 * create a flow, add a control to an existing screen, replace a screen, give a
 * screen its identity in the app — in the same spirit as
 * src/knowledge/reportPatterns/. Served through
 * object_patterns(domain="mobile-app").
 *
 * The catalog exists because the platform carries TWO frameworks for the same
 * screens and picking the wrong one is a rewrite, not a refactor:
 *   • process-guide — the current framework (ProcessGuideController / Step /
 *     PageBuilder / DataProcessor / NavigationAgent / Action). Deliberately has
 *     no WHS prefix: production and inventory processes use it too.
 *   • legacy — the original WHSWorkExecuteDisplay hierarchy, where one
 *     displayForm() processes input, runs business logic, increments the step
 *     and builds the next screen.
 * Every pattern therefore declares which framework it belongs to, and the list
 * view leads with the decision rather than the recipes.
 */

/** Which framework a recipe is written against. */
export type MobileAppFramework =
  | 'process-guide'   // ProcessGuide — current, extensible by design
  | 'legacy'          // WHSWorkExecuteDisplay — original, still shipping
  | 'app-metadata'    // WHSMobileAppStep* — the app's step identity (icon/title)
  | 'configuration';  // setup data — no AOT object at all

/** One object in a pattern's roster. */
export interface MobileAppObjectSpec {
  /** Role in the pattern (e.g. "Controller", "Page builder"). */
  role: string;
  /** Naming convention relative to the process name. */
  naming: string;
  /** AOT kind plus the base class / attribute it must carry. */
  baseOrType: string;
  /** Role-specific guidance. */
  notes?: string;
}

/** A copy-ready X++ skeleton shipped with a pattern. */
export interface MobileAppSkeleton {
  label: string;
  /** X++ source. Gated by the offline BP validator in tests. */
  code: string;
}

export interface MobileAppPatternSpec {
  /** Stable id, matched case-insensitively and separator-insensitively. */
  id: string;
  displayName: string;
  aliases?: string[];
  framework: MobileAppFramework;
  purpose: string;
  whenToUse: string[];
  whenNotToUse?: string[];
  /** Objects the recipe produces (empty for pure configuration). */
  objects: MobileAppObjectSpec[];
  /** Copy-ready X++ for the recipe. */
  skeletons?: MobileAppSkeleton[];
  /** Ordered implementation notes — the method overrides that carry the work. */
  methodNotes: string[];
  /** What to verify afterwards. */
  crossChecks: string[];
  /** Standard AOT elements demonstrating the pattern (confirm with get_object_info). */
  referenceElements?: string[];
  /** KNOWLEDGE_BASE topic ids with the surrounding rules. */
  relatedTopics?: string[];
}
