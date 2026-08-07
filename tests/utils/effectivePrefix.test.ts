/**
 * The single resolution point for the effective prefix (#833).
 *
 * Everything downstream — the get_workspace_info prefix section, the underscore
 * rule in validate_object_naming, the doctor check — reads this, so what counts
 * as a conflict and which tokens stay legitimate candidates is decided once.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  matchPrefixCandidate, prefixCandidates, prefixConflictWarning, resolveEffectivePrefix,
} from '../../src/utils/effectivePrefix.js';
import {
  setModelObjectNameSource, clearInferredModelPrefixes,
} from '../../src/utils/modelPrefixInference.js';

const MODEL = 'ContosoFinanceSK';
const MODEL_OBJECTS = [
  'ConSK_VendPaymentTable', 'ConSK_CustInvoiceJour',
  'ConSK_LedgerJournalTrans', 'ConSK_TaxReportTable',
];

const originalEnv = { ...process.env };

beforeEach(() => {
  clearInferredModelPrefixes();
  setModelObjectNameSource(model => (model === MODEL ? MODEL_OBJECTS : []));
  delete process.env.EXTENSION_PREFIX;
  delete process.env.EXTENSION_PREFIX_SOURCE;
});

afterEach(() => {
  setModelObjectNameSource(null);
  clearInferredModelPrefixes();
  process.env = { ...originalEnv };
});

describe('resolveEffectivePrefix', () => {
  it('prefers the model\'s own naming and says where it came from', () => {
    process.env.EXTENSION_PREFIX = 'Con';
    const resolution = resolveEffectivePrefix(MODEL);

    expect(resolution.prefix).toBe('ConSK');
    expect(resolution.source).toBe('inferred from 4/4 objects of model "ContosoFinanceSK"');
    expect(resolution.configured).toBe('Con');
    expect(resolution.conflict).toBe(true);
  });

  it('treats "ConSK_" and "ConSK" as the same prefix', () => {
    // The underscore belongs to the regular-object form, not to the token.
    process.env.EXTENSION_PREFIX = 'ConSK';

    expect(resolveEffectivePrefix(MODEL).conflict).toBe(false);
    expect(prefixConflictWarning(resolveEffectivePrefix(MODEL))).toBeNull();
  });

  it('falls back to EXTENSION_PREFIX for a model with nothing to teach', () => {
    process.env.EXTENSION_PREFIX = 'Con';
    const resolution = resolveEffectivePrefix('BrandNewModel');

    expect(resolution.prefix).toBe('Con');
    expect(resolution.source).toBe('EXTENSION_PREFIX');
    expect(resolution.conflict).toBe(false);
  });

  it('lets EXTENSION_PREFIX_SOURCE=config win, leaving nothing to conflict with', () => {
    process.env.EXTENSION_PREFIX = 'Con';
    process.env.EXTENSION_PREFIX_SOURCE = 'config';
    const resolution = resolveEffectivePrefix(MODEL);

    expect(resolution.prefix).toBe('Con');
    expect(resolution.inferred).toBeNull();
    expect(resolution.conflict).toBe(false);
  });
});

describe('prefixCandidates', () => {
  it('keeps the losing token as a candidate while the two disagree', () => {
    process.env.EXTENSION_PREFIX = 'Con';
    const candidates = prefixCandidates(resolveEffectivePrefix(MODEL));

    expect(candidates.map(c => c.token)).toEqual(['ConSK', 'Con']);
    expect(candidates[0].effective).toBe(true);
    expect(candidates[1].effective).toBe(false);
    expect(candidates[1].label).toContain('EXTENSION_PREFIX');
  });

  it('offers exactly one candidate when the two agree', () => {
    process.env.EXTENSION_PREFIX = 'ConSK_';

    expect(prefixCandidates(resolveEffectivePrefix(MODEL))).toHaveLength(1);
  });

  it('matches a candidate case-insensitively and ignores the separator', () => {
    process.env.EXTENSION_PREFIX = 'Con';
    const candidates = prefixCandidates(resolveEffectivePrefix(MODEL));

    expect(matchPrefixCandidate('consk', candidates)?.effective).toBe(true);
    expect(matchPrefixCandidate('Con_', candidates)?.effective).toBe(false);
    expect(matchPrefixCandidate('Random', candidates)).toBeNull();
    expect(matchPrefixCandidate('', candidates)).toBeNull();
  });
});

describe('prefixConflictWarning', () => {
  it('names both candidates and how to pin the configured one', () => {
    process.env.EXTENSION_PREFIX = 'Con';
    const warning = prefixConflictWarning(resolveEffectivePrefix(MODEL))!;

    expect(warning).toContain('"ConSK_"');
    expect(warning).toContain('EXTENSION_PREFIX="Con"');
    expect(warning).toContain('EXTENSION_PREFIX_SOURCE=config');
  });
});
