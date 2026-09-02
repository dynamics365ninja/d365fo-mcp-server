/**
 * The test-first offer — making the TDD loop discoverable from the calls people
 * already make.
 *
 * The loop exists and is complete: `prepare(mode="test")` resolves a class or a
 * table method, `generate_object(pattern="systest")` emits a red-first scaffold,
 * `run_systest_class` executes it and reports per method. Across 1,603 real MCP
 * calls in 47 sessions it was used **zero times**. `prepare(mode="test")`: 0.
 * `run_systest_class`: 0. Meanwhile `prepare(mode="change")` ran 54 times and
 * `d365fo_file(modify)` 195, and the single most-asked knowledge question — about
 * thirty-five of roughly fifty real asks — was the table `validateWrite` Chain of
 * Command contract, which is precisely the thing the loop was built to test.
 *
 * A feature nobody finds is indistinguishable from one that does not exist. So
 * the offer goes where the developer already is, and it costs nothing to publish:
 * this is response TEXT, not schema, so the ListTools payload (44,951 of 45,000
 * chars) is untouched.
 *
 * ── WHAT IT MUST NOT DO ───────────────────────────────────────────────────────
 * Offer on everything. A suggestion that appears on every call is banner blindness
 * within a session, and it would land on changes a SysTest cannot express: adding
 * a field to a table, adding a control to a form, renaming an enum value. Those
 * are METADATA, and the eval loop already covers them with a golden — a golden is
 * the right oracle for structure, a SysTest for behaviour.
 *
 * So the trigger is behaviour, and structure is not a weaker signal for it — it is
 * no signal at all. `add-field` on a table-extension does not offer a test even
 * though a table-extension is testable; `add-method` on the same object does.
 */

import type { XppServerContext } from '../../types/context.js';
import { lookupSymbolsNocase } from '../../utils/symbolLookup.js';

/**
 * Object families whose behaviour a SysTest can reach.
 *
 * A necessary condition, never a sufficient one — see the header. Menu items,
 * enums, EDTs, security artifacts and forms are absent because what changes about
 * them is their shape, and their oracle is the golden diff.
 */
const TESTABLE_TYPES = new Set([
  'class', 'class-extension',
  'table', 'table-extension',
  'data-entity', 'data-entity-extension',
]);

/**
 * The `d365fo_file(modify)` operations that write X++ rather than metadata.
 *
 * Taken from the operation names the write path actually dispatches
 * (`D365FO_FILE_OP_SPECS`); anything not listed here changes structure.
 */
const XPP_WRITING_OPERATIONS = new Set([
  'add-method', 'replace-code', 'add-display-method', 'add-table-method',
]);

/**
 * Method names whose whole purpose is a rule, i.e. a decision a test can pin.
 *
 * `validate*` leads because it is what sessions ask about. The rest are the
 * shapes that carry business logic on a table or a service: a defaulting method,
 * a calculation, a posting step.
 */
const RULE_METHOD = /^(validate|modified|init|calc|compute|check|post|process|default|can|must|find|exist)/i;

/**
 * Goal wording that describes a rule rather than a shape.
 *
 * Deliberately about OUTCOMES ("reject", "prevent", "must not") rather than about
 * mechanism, because a goal naming the mechanism ("add a field", "add a control")
 * is exactly the structural case that should not be offered a test.
 */
const RULE_GOAL = /\b(validat\w*|reject\w*|prevent\w*|forbid\w*|enforce\w*|disallow\w*|must not|must be|should not|should be|only if|calculat\w*|comput\w*|default\w*|round\w*|derive\w*)\b/i;

export interface TestFirstInput {
  /** Resolved objectType of the change, if known. */
  objectType?: string;
  /** The method being written, if the change names one. */
  methodName?: string;
  /** The caller's stated goal. */
  goal?: string;
  /** Comma-separated or array `operation` argument, as `prepare` receives it. */
  operation?: string | string[];
}

export interface TestFirstOffer {
  /** Why the offer fired — surfaced in the text so the reader can judge it. */
  reason: string;
  /** The method to focus the scaffold on, when the change named one. */
  focusMethod?: string;
}

function operationList(operation: TestFirstInput['operation']): string[] {
  if (!operation) return [];
  const raw = Array.isArray(operation) ? operation : operation.split(',');
  return raw.map(o => o.trim().toLowerCase()).filter(Boolean);
}

/**
 * Should this change be offered a red-first test, and why?
 *
 * Returns `undefined` for "no" rather than a boolean plus a separate reason,
 * so a caller cannot render an offer without the sentence that justifies it.
 */
export function testFirstOffer(input: TestFirstInput): TestFirstOffer | undefined {
  const type = input.objectType?.toLowerCase();
  if (!type || !TESTABLE_TYPES.has(type)) return undefined;

  const operations = operationList(input.operation);
  const writesXpp = operations.some(o => XPP_WRITING_OPERATIONS.has(o));
  // An operation that is present and writes only metadata is a decisive NO: the
  // caller has told us exactly what they are doing, and it is not behaviour.
  if (operations.length > 0 && !writesXpp) return undefined;

  const method = input.methodName?.trim();
  if (method && RULE_METHOD.test(method)) {
    return {
      reason: `\`${method}\` is a rule — it answers yes/no or produces a value, which is what an assertion pins`,
      focusMethod: method,
    };
  }
  if (writesXpp) {
    return {
      reason: 'this write carries X++, and a rule written without a failing test first has never been observed to fail',
      focusMethod: method,
    };
  }
  if (input.goal && RULE_GOAL.test(input.goal)) {
    return {
      reason: 'the goal describes a rule ("' + ruleWordIn(input.goal) + '"), not a shape',
      focusMethod: method,
    };
  }
  return undefined;
}

function ruleWordIn(goal: string): string {
  return RULE_GOAL.exec(goal)?.[0] ?? 'a rule';
}

/**
 * Test classes that already mention the target.
 *
 * Shared with `prepare(mode="test")` rather than re-queried: two copies of this
 * lookup would drift, and the answer decides between "scaffold one" and "extend
 * the one you have", which is the difference between a useful offer and a
 * duplicate test class.
 */
export function findExistingTests(context: XppServerContext, target: string): string[] {
  try {
    const db = context.symbolIndex.getReadDb();
    const rows = db.prepare(
      `SELECT DISTINCT name
         FROM symbols
        WHERE type = 'class'
          AND (name LIKE ? OR name LIKE ?)
        ORDER BY name
        LIMIT 10`,
    ).all(`${target}Test%`, `%Test${target}%`) as Array<{ name: string }>;
    return rows.map(r => r.name);
  } catch {
    return [];
  }
}

/**
 * The object a test should target, given the object being WRITTEN.
 *
 * A CoC wrapper is transparent to a test: you exercise `CustTable`, not
 * `CustTableConExtension_Extension`, and the wrapper is what makes the assertion
 * change. So an extension name has to be reduced to its base — and that cannot be
 * done by string surgery alone, because the infix between base and `_Extension`
 * is a per-model convention (`FMVehicleDataContract` + `Con` + `_Extension`).
 *
 * Candidates are therefore VERIFIED against the index, and `undefined` is
 * returned when none resolves. Printing an unverified name would put a call in
 * front of the caller that resolves to nothing — worse than saying nothing, since
 * it costs a round trip to discover.
 */
export function resolveTestTarget(
  context: XppServerContext,
  objectName: string,
  objectType?: string,
): string | undefined {
  const name = objectName.trim();
  if (!name) return undefined;

  const candidates: string[] = [];
  const dotted = /^([A-Za-z_]\w*)\.[A-Za-z_]\w*$/.exec(name);
  if (dotted) {
    candidates.push(dotted[1]);
  } else if (/_Extension$/i.test(name)) {
    const stem = name.slice(0, -'_Extension'.length).replace(/_+$/, '');
    candidates.push(stem);
    // Then the stem minus successive trailing capitalised tokens, shortest infix
    // first: `FMVehicleDataContractCon` → `FMVehicleDataContract`.
    for (const m of stem.matchAll(/[A-Z][a-z0-9]*/g)) {
      const cut = stem.slice(0, m.index);
      if (cut.length >= 3) candidates.push(cut);
    }
    candidates.sort((a, b) => b.length - a.length);
  } else {
    candidates.push(name);
  }

  const wantTypes = objectType?.startsWith('table') || objectType?.startsWith('data-entity')
    ? (['table', 'class'] as const)
    : (['class', 'table'] as const);
  try {
    const db = context.symbolIndex.getReadDb();
    for (const candidate of candidates) {
      const hit = lookupSymbolsNocase(db, candidate, { types: [...wantTypes], limit: 1 })[0];
      if (hit?.name) return hit.name;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/**
 * One line for a write that just landed: is this behaviour covered by a test?
 *
 * Emitted only when the write SUCCEEDED, carried X++, and the index knows both
 * the target and that nothing tests it. Silence is the default — a note on every
 * write is noise, and this one is competing with the write's own report.
 */
export function testCoverageNote(
  context: XppServerContext,
  input: TestFirstInput & { objectName?: string },
): string | undefined {
  const offer = testFirstOffer(input);
  if (!offer || !input.objectName) return undefined;
  const target = resolveTestTarget(context, input.objectName, input.objectType);
  if (!target) return undefined;
  if (findExistingTests(context, target).length > 0) return undefined;

  const call = offer.focusMethod
    ? `prepare(mode="test", objectName="${target}.${offer.focusMethod}")`
    : `prepare(mode="test", objectName="${target}")`;
  return `\n\n> **Untested.** No SysTest in the index references \`${target}\`. \`${call}\` scaffolds a red-first one.`;
}

/**
 * The offer, as markdown lines. Empty when there is nothing to offer.
 *
 * Three lines at most. This section competes for a capped response with the
 * write contract and the grounding token, and it must never be the reason one of
 * those is cut — callers place it after both.
 */
export function renderTestFirst(
  offer: TestFirstOffer | undefined,
  target: string,
  existingTests: string[],
): string[] {
  if (!offer) return [];
  const call = offer.focusMethod
    ? `prepare(mode="test", objectName="${target}.${offer.focusMethod}")`
    : `prepare(mode="test", objectName="${target}")`;

  const lines = ['### Test first?', ''];
  if (existingTests.length > 0) {
    lines.push(
      `\`${existingTests[0]}\` already covers \`${target}\` — add a failing method to it rather than a ` +
      `second test class. \`${call}\` lists what is untested.`,
    );
  } else {
    lines.push(`No SysTest in the index references \`${target}\`, and ${offer.reason}.`);
    lines.push('');
    lines.push(`\`${call}\` → a red-first scaffold whose every method fails until you write the behaviour.`);
  }
  lines.push('');
  return lines;
}
