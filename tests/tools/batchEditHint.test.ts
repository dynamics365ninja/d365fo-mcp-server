/**
 * The line that turns the dominant waste pattern into one call.
 *
 * 45 of 273 sampled tool calls were consecutive single-op modifies, and 40 of 49
 * modifies were single-op even though operations[] already existed — so the hint
 * has to name the concrete call, with the name the object ACTUALLY carries.
 */

import { describe, it, expect } from 'vitest';
import { renderBatchEditHint } from '../../src/tools/write/inlineWriteVerification';

describe('renderBatchEditHint', () => {
  it('names the batched modify call after a create', () => {
    const out = renderBatchEditHint('table', 'CtsoMyTable', { afterCreate: true });
    expect(out).toContain('d365fo_file(action="modify"');
    expect(out).toContain('objectType="table"');
    expect(out).toContain('objectName="CtsoMyTable"');
    expect(out).toContain('operations:[');
  });

  it('uses the name the object actually got, never the one that was requested', () => {
    // A create that applied the model prefix must not hand back a follow-up call
    // aimed at an object that does not exist.
    const out = renderBatchEditHint('table', 'CtsoMyTable', { afterCreate: true });
    expect(out).toContain('CtsoMyTable');
    expect(out).not.toContain('"MyTable"');
  });

  it('points a single modify at operations[] for the rest of the edits', () => {
    const out = renderBatchEditHint('table', 'CustTable');
    expect(out).toContain('CustTable');
    expect(out).toContain('operations:[');
    expect(out).toContain('ONE modify call');
    // Not the create wording — this one is a follow-up, not a first step.
    expect(out).not.toContain('d365fo_file(action="modify"');
  });

  it('says nothing when there is no object to name', () => {
    expect(renderBatchEditHint('table', '')).toBe('');
    expect(renderBatchEditHint('table', '', { afterCreate: true })).toBe('');
  });
});
