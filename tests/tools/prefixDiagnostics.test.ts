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
import { buildPrefixDiagnostics, modelWritesLandIn } from '../../src/tools/analysis/prefixDiagnostics.js';
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
  delete process.env.D365FO_CROSS_MODEL_WRITE_MODELS;
  delete process.env.D365FO_ALLOW_CROSS_MODEL_WRITE;
});

afterEach(() => {
  setModelObjectNameSource(null);
  clearInferredModelPrefixes();
  process.env = { ...originalEnv };
});

/** Compact default — what get_workspace_info emits on every call. */
const text = (model: string | null, readModel: string | null) =>
  buildPrefixDiagnostics(model, readModel).lines.join('\n');

/** Full section — diagnostics=true only. */
const verbose = (model: string | null, readModel: string | null) =>
  buildPrefixDiagnostics(model, readModel).verboseLines.join('\n');

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
    expect(out).toContain('"ContosoFinanceCore" is merely the active project');
  });

  it('adds no switch note when reads and writes agree', () => {
    const out = text('ContosoFinanceSK', 'ContosoFinanceSK');

    expect(out).not.toContain('prefix for WRITES');
    expect(out).toContain('ConSK');
  });

  it('names the origin when the prefix came from the model\'s objects', () => {
    const out = text('ContosoFinanceSK', 'ContosoFinanceSK');

    expect(out).toContain('inferred from 4/4 objects of model "ContosoFinanceSK"');
    expect(verbose('ContosoFinanceSK', 'ContosoFinanceSK'))
      .toContain('source: inferred from 4/4 objects of model "ContosoFinanceSK"');
  });

  it('is a single line when nothing is off', () => {
    // Every session pays for this section. A healthy prefix is one line — the
    // "✅ …comes from the objects…" restatement belongs to diagnostics.
    process.env.EXTENSION_PREFIX = 'ConSK';
    const out = text('ContosoFinanceSK', 'ContosoFinanceSK');

    expect(out.split('\n')).toHaveLength(1);
    expect(out).toBe('Prefix      : ConSK  (inferred from 4/4 objects of model "ContosoFinanceSK")');
  });

  it('warns when the model\'s own naming overrules EXTENSION_PREFIX', () => {
    process.env.EXTENSION_PREFIX = 'Con';
    const out = text('ContosoFinanceSK', 'ContosoFinanceSK');

    expect(out).toContain('⚠️');
    expect(out).toContain('overriding EXTENSION_PREFIX="Con"');
    expect(out).toContain('EXTENSION_PREFIX_SOURCE=config');
    expect(verbose('ContosoFinanceSK', 'ContosoFinanceSK')).toContain('overrides EXTENSION_PREFIX="Con"');
  });

  it('does not warn when the model and the configuration agree', () => {
    // "ConSK_" from the objects and "ConSK" in the env are the same prefix —
    // the underscore belongs to the regular-object form, not to the token.
    process.env.EXTENSION_PREFIX = 'ConSK';

    expect(text('ContosoFinanceSK', 'ContosoFinanceSK')).not.toContain('⚠️');
    expect(verbose('ContosoFinanceSK', 'ContosoFinanceSK')).toContain('✅');
  });

  it('falls back to EXTENSION_PREFIX for a model with nothing to teach', () => {
    process.env.EXTENSION_PREFIX = 'Con';

    expect(text('BrandNewModel', 'BrandNewModel')).toBe('Prefix      : Con  (EXTENSION_PREFIX)');
    expect(verbose('BrandNewModel', 'BrandNewModel')).toContain('source: EXTENSION_PREFIX');
    expect(verbose('BrandNewModel', 'BrandNewModel')).toContain('✅ EXTENSION_PREFIX is set');
  });

  it('follows the write into the active model when configuration allows it', () => {
    // With D365FO_CROSS_MODEL_WRITE_MODELS the guard lets the write through and
    // it lands in the ACTIVE model — so the anchor's prefix would be wrong in
    // exactly the way the active model's prefix was wrong one state over.
    process.env.D365FO_CROSS_MODEL_WRITE_MODELS = 'ContosoFinanceCore';

    expect(modelWritesLandIn('ContosoFinanceSK', 'ContosoFinanceCore')).toBe('ContosoFinanceCore');
    expect(buildPrefixDiagnostics(
      modelWritesLandIn('ContosoFinanceSK', 'ContosoFinanceCore'), 'ContosoFinanceCore',
    ).effectivePrefix).toBe('ConCore');
  });

  it('keeps writes on the anchor when configuration allows some OTHER model', () => {
    process.env.D365FO_CROSS_MODEL_WRITE_MODELS = 'SomeUnrelatedModel';

    expect(modelWritesLandIn('ContosoFinanceSK', 'ContosoFinanceCore')).toBe('ContosoFinanceSK');
  });

  it('keeps writes on the anchor when nothing was switched', () => {
    expect(modelWritesLandIn('ContosoFinanceSK', 'ContosoFinanceSK')).toBe('ContosoFinanceSK');
  });

  it('treats two spellings of one model as the same model', () => {
    // Model names compare case-insensitively everywhere else. Comparing them
    // exactly here reported a switch — and a whole "writes are NOT switched"
    // section — for a workspace that never switched anything.
    expect(modelWritesLandIn('ContosoFinanceSK', 'contosofinancesk')).toBe('ContosoFinanceSK');
    expect(text('ContosoFinanceSK', 'contosofinancesk')).not.toContain('This is the prefix for WRITES');
  });

  it('does not claim "0/N objects" when the token came from extension elements', () => {
    // coverage counts the REGULAR objects that agree; a model whose prefix is
    // only stated by its extensions has none, and the line used to read
    // "inferred from 0/4 objects" — a self-contradiction in the one section
    // whose job is to make the prefix checkable.
    setModelObjectNameSource(() => [
      'SalesOrderHelper', 'VendPaymentFix', 'CustBalanceReport', 'TaxReportRunner',
      'VendTable.ConSKExtension', 'CustTable.ConSKExtension', 'SalesTable.ConSKExtension',
    ]);
    clearInferredModelPrefixes();

    const out = text('MixedModel', 'MixedModel');

    expect(out).not.toContain('0/');
    expect(out).toContain('inferred from the extension elements of model "MixedModel"');
  });

  it('tells the operator to configure a prefix when nothing resolves', () => {
    const out = text('BrandNewModel', 'BrandNewModel');

    expect(out).toContain('model name (nothing configured)');
    expect(out).toContain('⚠️  EXTENSION_PREFIX is not set');
  });
});
