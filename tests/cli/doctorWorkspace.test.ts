/**
 * `d365fo-mcp doctor` reports WHICH detection source won, and whether the
 * configured prefix disagrees with the one the model's own objects use (#833).
 *
 * Both were previously only inferable — the detection source from a tool error,
 * the prefix conflict from reading get_workspace_info and noticing that the
 * effective value was not the configured one.
 */

import { describe, it, expect } from 'vitest';
import { checkPrefixResolution } from '../../src/cli/commands/doctor.js';

/** Four objects, all carrying "ConSK_" — enough for the inference to trust it. */
const MODEL_OBJECTS = [
  'ConSK_VendPaymentTable', 'ConSK_CustInvoiceJour',
  'ConSK_LedgerJournalTrans', 'ConSK_TaxReportTable',
];

describe('doctor — prefix resolution', () => {
  it('names both candidates when the model and the configuration disagree', () => {
    const [result] = checkPrefixResolution('Con', 'ContosoFinanceSK', MODEL_OBJECTS, 'Naming');

    expect(result.severity).toBe('warn');
    expect(result.message).toContain('ConSK_');
    expect(result.message).toContain('"Con"');
    expect(result.message).toContain('The model\'s own naming wins');
    expect(result.fix).toContain('EXTENSION_PREFIX_SOURCE=config');
  });

  it('is quiet when the two agree, underscore or not', () => {
    const [result] = checkPrefixResolution('ConSK', 'ContosoFinanceSK', MODEL_OBJECTS, 'Naming');

    expect(result.severity).toBe('ok');
    expect(result.message).toContain('agree');
  });

  it('reports the configured prefix when the model has nothing to teach', () => {
    const [result] = checkPrefixResolution('Con', 'BrandNewModel', [], 'Naming');

    expect(result.severity).toBe('ok');
    expect(result.message).toContain('naming.prefix');
  });

  it('warns when neither source has a prefix to offer', () => {
    const [result] = checkPrefixResolution('', 'BrandNewModel', [], 'Naming');

    expect(result.severity).toBe('warn');
    expect(result.message).toContain('no prefix configured');
  });

  // #893: the check called the inference directly, below the layer that honours
  // the pin, so it reported a conflict that the server does not have and told
  // the user to apply the setting they had already applied.
  it('reports no conflict once the configured prefix is pinned', () => {
    const [result] = checkPrefixResolution('Con', 'ContosoFinanceSK', MODEL_OBJECTS, 'Naming', true);

    expect(result.severity).toBe('ok');
    expect(result.message).toContain('"Con"');
    expect(result.message).toContain('pinned by naming.prefixSource=config');
    // The learned value is still stated — it is why the two disagree — but as
    // something being ignored, not as the one that wins.
    expect(result.message).toContain('ignored while the prefix is pinned');
    expect(result.message).not.toContain('wins');
    expect(result.fix).toBeUndefined();
  });

  it('says nothing about the model when the pinned prefix is what it uses anyway', () => {
    const [result] = checkPrefixResolution('ConSK', 'ContosoFinanceSK', MODEL_OBJECTS, 'Naming', true);

    expect(result.severity).toBe('ok');
    expect(result.message).not.toContain('ignored');
  });

  it('warns when the pin has nothing to pin — an empty naming.prefix', () => {
    const [result] = checkPrefixResolution('', 'ContosoFinanceSK', MODEL_OBJECTS, 'Naming', true);

    expect(result.severity).toBe('warn');
    expect(result.message).toContain('naming.prefix is empty');
    expect(result.fix).toContain('naming.prefix');
  });
});
