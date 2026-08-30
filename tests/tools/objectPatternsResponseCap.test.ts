/**
 * object_patterns must deliver a WHOLE recipe.
 *
 * Found on the VM during eval case L3-processguide-flow-slice: the mobile-app
 * `processguide-flow` spec renders 9,328 chars and the generic 5,000-char cap
 * cut 4,406 of them. What was lost was not padding — the addActionControls half
 * of the page-builder skeleton and the entire silent-step skeleton never reached
 * the agent, which then rebuilt both from Microsoft source at several round
 * trips each. A skeleton is a code deliverable: half of one is a wrong answer,
 * not a shorter one, and a cut here costs more context than it saves (a round
 * trip re-bills the whole cached context).
 *
 * This is a ratchet: it fails when a new recipe outgrows the cap, so the cap is
 * raised deliberately with the measurement in hand rather than discovered by an
 * agent silently reconstructing what it did not receive.
 */

import { describe, it, expect } from 'vitest';
import { capToolResponse } from '../../src/tools/responseCaps';
import {
  listMobileAppPatterns,
  renderMobileAppPatternList,
  renderMobileAppPatternSpec,
  resolveMobileAppPattern,
} from '../../src/knowledge/mobileAppPatterns/index';

const capOf = (text: string): string =>
  capToolResponse('object_patterns', { content: [{ type: 'text', text }] }).content[0].text;

const wasCut = (text: string): boolean => capOf(text).includes('Response truncated');

describe('object_patterns response cap', () => {
  it('delivers every mobile-app recipe whole', () => {
    const oversized = listMobileAppPatterns()
      .map(p => ({ id: p.id, spec: renderMobileAppPatternSpec(resolveMobileAppPattern(p.id)!) }))
      .filter(r => wasCut(r.spec))
      .map(r => `${r.id} (${r.spec.length} chars)`);

    expect(oversized, 'recipes cut by the object_patterns cap').toEqual([]);
  });

  it('delivers the domain index whole', () => {
    expect(wasCut(renderMobileAppPatternList())).toBe(false);
  });

  it('still caps a runaway response rather than being uncapped', () => {
    const runaway = 'x'.repeat(200_000);
    const capped = capOf(runaway);
    expect(capped.length).toBeLessThan(runaway.length);
    expect(capped).toContain('Response truncated');
    // The advice must name knobs object_patterns actually has. The generic
    // advice points at methodOffset/fieldsOffset, which this tool does not
    // accept — advice naming a parameter the tool lacks gets followed.
    expect(capped).toContain('pattern');
    expect(capped).not.toContain('fieldsOffset');
  });

  it('keeps the largest recipe comfortably inside the cap', () => {
    const largest = Math.max(
      ...listMobileAppPatterns().map(
        p => renderMobileAppPatternSpec(resolveMobileAppPattern(p.id)!).length,
      ),
    );
    // Headroom, so an edit that grows a recipe by a paragraph does not silently
    // start cutting it between one release and the next.
    expect(largest).toBeLessThan(11_000);
  });
});
