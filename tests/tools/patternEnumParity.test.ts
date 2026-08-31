/**
 * Pattern-enum parity: what `generate_object` can BUILD versus what it ADVERTISES.
 *
 * `CODE_GEN_PATTERNS` (the dispatcher's accepted values) and the `pattern` enum in
 * the published tool schema drifted apart silently — six templates were
 * implemented, validated and reachable, but absent from the only list a model ever
 * sees, so nobody could discover them. Two of the six are named by an eval case's
 * own instructions, which is how a case can tell an implementer to call something
 * the tool does not offer.
 *
 * This test does not demand that the two lists be equal. Publishing costs bytes
 * out of a hard ListTools budget, and for a tool called 5 times in 1,593 real MCP
 * calls those bytes are better spent elsewhere. What it demands is that every
 * difference be a DECISION someone wrote down: an unpublished pattern must appear
 * in DELIBERATELY_UNPUBLISHED with a reason, and a published one must exist.
 */
import { describe, expect, it } from 'vitest';
import { CODE_GEN_PATTERNS } from '../../src/tools/smart/codeGen.js';
import { generateObjectTool } from '../../src/server/toolSchemas/generateObject.js';

/**
 * Patterns the dispatcher accepts and the schema deliberately does not advertise.
 *
 * Each entry is a decision, not an oversight. Re-decide one by publishing it —
 * which means paying for its bytes with a measured trim in the same change, the
 * rule tests/utils/toolSchemaBudget.test.ts enforces.
 */
const DELIBERATELY_UNPUBLISHED: Record<string, string> = {
  'business-event': 'Named by L2-business-event-basic, which passes the value explicitly. ' +
    'Publishing it costs ~18 schema chars against ~64 of headroom; the case proves the path works ' +
    'without discovery. Revisit if a real session tries to guess the pattern name and fails.',
  'custom-service': 'Named by L3-custom-service-basic. Same trade as business-event; the overlapping ' +
    'published pattern service-class-ais already covers the AIS shape a model is likely to want.',
  'custom-telemetry': 'No eval case and no knowledge entry points at it — an unproven template. ' +
    'Publishing an undiscovered, unproven pattern spends bytes on a path nothing exercises.',
  'feature-class': 'Feature management is taught through the feature-management topic and proven by ' +
    'L2-feature-management-flight, which does not use this pattern.',
  'composite-entity': 'Composite data entities are covered by the data-entities topic; no case ' +
    'exercises this template.',
  'er-custom-function': 'Electronic Reporting is proven by L3-electronic-reporting-integration, which ' +
    'does not route through this template.',
};

function publishedPatterns(): string[] {
  const properties = generateObjectTool.inputSchema.properties as Record<string, { enum?: string[] }>;
  const values = properties.pattern?.enum;
  if (!values) throw new Error('generate_object no longer publishes a pattern enum');
  return values;
}

describe('generate_object pattern enum parity', () => {
  it('publishes nothing the dispatcher cannot build', () => {
    const buildable = new Set<string>(CODE_GEN_PATTERNS);
    const orphans = publishedPatterns().filter(p => !buildable.has(p));
    expect(
      orphans,
      `advertised but not implemented: ${orphans.join(', ')} — a model that calls one gets "Unknown pattern"`,
    ).toEqual([]);
  });

  it('accounts for every buildable pattern it does not publish', () => {
    const published = new Set(publishedPatterns());
    const hidden = CODE_GEN_PATTERNS.filter(p => !published.has(p));
    const undocumented = hidden.filter(p => !(p in DELIBERATELY_UNPUBLISHED));
    expect(
      undocumented,
      `implemented but neither published nor recorded as a decision: ${undocumented.join(', ')}. ` +
      'Either publish it (and pay for the bytes with a trim in the same change) or add it to ' +
      'DELIBERATELY_UNPUBLISHED with the reason.',
    ).toEqual([]);
  });

  it('keeps the unpublished list honest — no entry for a pattern that no longer exists', () => {
    const buildable = new Set<string>(CODE_GEN_PATTERNS);
    const stale = Object.keys(DELIBERATELY_UNPUBLISHED).filter(p => !buildable.has(p));
    expect(stale, `recorded as unpublished but no longer implemented: ${stale.join(', ')}`).toEqual([]);
  });

  it('keeps the unpublished list honest — no entry for a pattern that IS published', () => {
    const published = new Set(publishedPatterns());
    const contradictory = Object.keys(DELIBERATELY_UNPUBLISHED).filter(p => published.has(p));
    expect(
      contradictory,
      `recorded as deliberately unpublished, but the schema publishes it: ${contradictory.join(', ')}`,
    ).toEqual([]);
  });
});
