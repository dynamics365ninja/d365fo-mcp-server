/**
 * The "Prefix Configuration" section of get_workspace_info.
 *
 * Two things are pinned here, and both are about the reported value matching
 * what a write would actually do:
 *  - after a project switch the prefix is the WRITE anchor's, not the model
 *    reads now come from
 *  - the value always names its origin (model objects / EXTENSION_PREFIX /
 *    model name), and says so when the model overrules the configuration
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildPrefixDiagnostics } from '../../src/tools/prefixDiagnostics.js';
import {
  setModelObjectNameSource,
  clearInferredModelPrefixes,
} from '../../src/utils/modelPrefixInference.js';

// Workspace model and the shared model an agent switches to in order to read.
const SK_MODEL = [
  'ConSK_VendPaymentTable', 'ConSK_CustInvoiceJour',
  'ConSK_LedgerJournalTrans', 'ConSK_TaxReportTable',
];
const CORE_MODEL = [
  'ConCore_TaxTransReportChangeLog', 'ConCore_LedgerPostingProfile',
  'ConCore_VendSettlement', 'ConCore_CustBalanceList',
];

const originalEnv = { ...process.env };

beforeEach(() => {
  clearInferredModelPrefixes();
  setModelObjectNameSource(model =>
    model === 'ContosoFinanceSK' ? SK_MODEL : model === 'ContosoFinanceCore' ? CORE_MODEL : []);
  delete process.env.EXTENSION_PREFIX;
  delete process.env.EXTENSION_PREFIX_SOURCE;
});

afterEach(() => {
  setModelObjectNameSource(null);
  clearInferredModelPrefixes();
  process.env = { ...originalEnv };
});

const text = (model: string | null, readModel: string | null) =>
  buildPrefixDiagnostics(model, readModel).lines.join('\n');

describe('buildPrefixDiagnostics', () => {
  it('reports the write anchor\'s prefix after a project switch', () => {
    // Reads were switched to Core; writes stay in SK. Reporting Core's prefix
    // would state a token no write can apply — the write would be refused, or
    // land in SK named ConSK_.
    const out = buildPrefixDiagnostics('ContosoFinanceSK', 'ContosoFinanceCore');

    expect(out.effectivePrefix).toBe('ConSK');
    expect(out.lines.join('\n')).toContain('ConSK');
    expect(out.lines.join('\n')).not.toContain('ConCore');
  });

  it('says which model the prefix belongs to while a switch is in effect', () => {
    const out = text('ContosoFinanceSK', 'ContosoFinanceCore');

    expect(out).toContain('prefix for WRITES');
    expect(out).toContain('anchored to "ContosoFinanceSK"');
    expect(out).toContain('Reads currently come from "ContosoFinanceCore"');
  });

  it('adds no switch note when reads and writes agree', () => {
    const out = text('ContosoFinanceSK', 'ContosoFinanceSK');

    expect(out).not.toContain('prefix for WRITES');
    expect(out).toContain('ConSK');
  });

  it('names the origin when the prefix came from the model\'s objects', () => {
    const out = text('ContosoFinanceSK', 'ContosoFinanceSK');

    expect(out).toContain('source: inferred from 4/4 objects of model "ContosoFinanceSK"');
  });

  it('warns when the model\'s own naming overrules EXTENSION_PREFIX', () => {
    process.env.EXTENSION_PREFIX = 'Con';
    const out = text('ContosoFinanceSK', 'ContosoFinanceSK');

    expect(out).toContain('⚠️');
    expect(out).toContain('overrides EXTENSION_PREFIX="Con"');
    expect(out).toContain('EXTENSION_PREFIX_SOURCE=config');
  });

  it('does not warn when the model and the configuration agree', () => {
    // "ConSK_" from the objects and "ConSK" in the env are the same prefix —
    // the underscore belongs to the regular-object form, not to the token.
    process.env.EXTENSION_PREFIX = 'ConSK';
    const out = text('ContosoFinanceSK', 'ContosoFinanceSK');

    expect(out).not.toContain('⚠️');
    expect(out).toContain('✅');
  });

  it('falls back to EXTENSION_PREFIX for a model with nothing to teach', () => {
    process.env.EXTENSION_PREFIX = 'Con';
    const out = text('BrandNewModel', 'BrandNewModel');

    expect(out).toContain('source: EXTENSION_PREFIX');
    expect(out).toContain('✅ EXTENSION_PREFIX is set');
  });

  it('tells the operator to configure a prefix when nothing resolves', () => {
    const out = text('BrandNewModel', 'BrandNewModel');

    expect(out).toContain('source: model name (nothing configured)');
    expect(out).toContain('⚠️  EXTENSION_PREFIX is not set');
  });
});
