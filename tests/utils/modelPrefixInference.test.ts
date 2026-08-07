/**
 * Prefix inference from a model's own objects.
 *
 * A single configured EXTENSION_PREFIX cannot be right for a developer who works
 * across several models — Demo names its objects DEMO_* and its sibling
 * DemoCus names them DMC_*, while EXTENSION_PREFIX says "Con". The name
 * samples below reproduce the shapes real solutions use (underscore prefixes,
 * dot-notation extensions, _Extension classes, compound prefixes); only the
 * prefixes and model names are fictional.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  inferPrefixFromObjectNames,
  setModelObjectNameSource,
  getInferredModelPrefix,
  clearInferredModelPrefixes,
} from '../../src/utils/modelPrefixInference.js';
import {
  resolveObjectPrefix,
  resolveRegularObjectPrefixToken,
  deriveExtensionInfix,
  applyObjectPrefix,
} from '../../src/utils/modelClassifier.js';

// …\PackagesLocalDirectory\Demo\Demo — underscore-style prefix, with the
// extension infix spelled differently from it (DEMO_ vs DEMO).
const DEMO_MODEL = [
  'DEMO_ArchiveAccDocErrorLog',
  'DEMO_AssetIPFairValue',
  'DEMO_AssetIPFairValueStaging',
  'DEMO_AssetsDepreciationSimulationTmp',
  'DEMO_BackIntegrationLink',
  'DEMO_BusinessPartnerStaging',
  'DEMO_AccrualDateFrom',
  'DEMO_AllowAutomaticSalesInvoicePosting',
  'AccountingSourceExplorerTmp.DEMOExtension',
  'AssetBookTable.DEMOExtension',
  'AssetDepSuspension_CZ.DEMOExtension',
  'AccountingSourceExplorerDEMO_Extension',
  'AgreementGenerationPurchToSalesStrategyDEMO_Extension',
];

// …\DemoCus\DemoCus — same solution, different model, different prefix (DMC_,
// for Demo Cus). Nothing ties the prefix to the model name it belongs to, which
// is the whole reason it has to be read off the objects.
const DEMO_CUS_MODEL = [
  'DMC_REMLeaseContractLineUGs',
  'DMC_REMLeaseContractLineUGsStaging',
  'DMC_OldDebtsReportController',
  'DMC_OldDebtsReportDP',
  'DMC_SalesInvoiceHeaderEmailHandler',
  'DMC_AssetFirstUseDate',
  'AssetTable.DMCExtension',
  'CustTransFormDMC_Extension',
];

// Model ContosoFinanceSK — three-segment prefix (Contoso|Fin|SK), the shape that
// made the inference report "ContosoFin" while EXTENSION_PREFIX said "Contoso".
const CONTOSO_FIN_SK = [
  'ContosoFinSKVendPaymentTable',
  'ContosoFinSKCustInvoiceJour',
  'ContosoFinSKLedgerJournalTrans',
  'ContosoFinSKTaxReportTable',
  'ContosoFinSKBankStatement',
  'VendTable.ContosoFinSKExtension',
  'CustTableContosoFinSK_Extension',
];

const originalEnv = { ...process.env };

beforeEach(() => {
  clearInferredModelPrefixes();
  setModelObjectNameSource(null);
  delete process.env.EXTENSION_PREFIX;
  delete process.env.EXTENSION_PREFIX_SOURCE;
  delete process.env.EXTENSION_NAMING_STYLE;
});

afterEach(() => {
  setModelObjectNameSource(null);
  clearInferredModelPrefixes();
  process.env = { ...originalEnv };
});

describe('inferPrefixFromObjectNames', () => {
  it('reads the underscore prefix and the extension infix as separate tokens', () => {
    const result = inferPrefixFromObjectNames(DEMO_MODEL);

    // The two are NOT derivable from one another: deriving "DEMO_" per the
    // documented rule yields the infix "Demo", but the model's own extensions
    // spell it "DEMOExtension".
    expect(result?.regular).toBe('DEMO_');
    expect(result?.infix).toBe('DEMO');
  });

  it('distinguishes two models that share a solution', () => {
    expect(inferPrefixFromObjectNames(DEMO_CUS_MODEL)?.regular).toBe('DMC_');
    expect(inferPrefixFromObjectNames(DEMO_CUS_MODEL)?.infix).toBe('DMC');
  });

  it('reads a PascalCase prefix with no underscore', () => {
    const result = inferPrefixFromObjectNames([
      'ConDemoNoteHeader', 'ConDemoModStatus', 'ConRentalAgreement', 'ConRentalLine',
    ]);

    expect(result?.regular).toBe('Con');
    expect(result?.infix).toBe('Con');
  });

  it('prefers the longer compound token when the objects agree on it', () => {
    // The scenario that motivated the change: configuration says "Isv", but this
    // model's objects consistently say "IsvFin".
    const result = inferPrefixFromObjectNames([
      'IsvFinPostingProfile', 'IsvFinLedgerJournal', 'IsvFinVendPayment', 'IsvFinCustBalance',
    ]);

    expect(result?.regular).toBe('IsvFin');
  });

  it('reads a three-segment prefix instead of stopping at two', () => {
    // Model ContosoFinanceSK with EXTENSION_PREFIX="Contoso": the inference reported
    // "ContosoFin" and it looked deliberate, because only the first two segments
    // were ever offered as candidates — "ContosoFinSK" could not compete.
    const result = inferPrefixFromObjectNames([
      'ContosoFinSKVendPaymentTable', 'ContosoFinSKCustInvoiceJour',
      'ContosoFinSKLedgerJournalTrans', 'ContosoFinSKTaxReportTable',
      'ContosoFinSKBankStatement', 'ContosoFinSKPaymentId',
    ]);

    expect(result?.regular).toBe('ContosoFinSK');
    expect(result?.infix).toBe('ContosoFinSK');
  });

  it('keeps the underscore on a three-segment prefix', () => {
    const result = inferPrefixFromObjectNames([
      'ContosoFinSK_VendPaymentTable', 'ContosoFinSK_CustInvoiceJour',
      'ContosoFinSK_LedgerJournalTrans', 'ContosoFinSK_TaxReportTable',
    ]);

    expect(result?.regular).toBe('ContosoFinSK_');
    // Flattening the whole token would give "Contosofinsk"; each segment is lowered
    // on its own, so the boundaries survive.
    expect(result?.infix).toBe('ContosoFinSk');
  });

  it('extends a truncated leading token to the infix its own extensions state', () => {
    // Even with a longer token available, a leading token can come out short —
    // here every regular object is Vend-something. The model's extensions say
    // "ContosoFinSKExtension" outright, and members added inside that extension must
    // not be named ContosoFinFoo.
    const result = inferPrefixFromObjectNames([
      'ContosoFinSKVendPaymentTable', 'ContosoFinSKVendInvoice',
      'ContosoFinSKVendBalance', 'ContosoFinSKVendSettlement',
      'VendTable.ContosoFinSKExtension', 'CustTable.ContosoFinSKExtension',
    ]);

    expect(result?.regular).toBe('ContosoFinSK');
    expect(result?.infix).toBe('ContosoFinSK');
  });

  it('does not extend the leading token when the objects do not carry the infix', () => {
    // A single stray extension from another convention must not rewrite the
    // prefix that four out of four regular objects agree on.
    const result = inferPrefixFromObjectNames([
      'ConDemoNoteHeader', 'ConRentalAgreement', 'ConRentalLine', 'ConPaymentPlan',
      'CustTable.ConDemoExtension',
    ]);

    expect(result?.regular).toBe('Con');
  });

  it('stops at three segments so a domain word cannot become the prefix', () => {
    // Four leading segments in common is a small model about one topic, not a
    // four-part prefix — "ContosoFinSKVend" must not win on length.
    const result = inferPrefixFromObjectNames([
      'ContosoFinSKVendPaymentTable', 'ContosoFinSKVendPaymentLine',
      'ContosoFinSKVendPaymentJour', 'ContosoFinSKVendPaymentTmp',
    ]);

    expect(result?.regular).toBe('ContosoFinSK');
  });

  /**
   * Coverage alone cannot tell a third prefix segment from a domain word: a
   * model whose objects are all ConDemoNote-something offers "ConDemoNote" with
   * the same 100 % the real "ContosoFinSK" has, and longest-wins then takes the
   * domain word. Every generated name would be wrong, and self-reinforcing — the
   * next object is named that way too. So three segments need corroboration from
   * outside the object names.
   */
  describe('three-segment tokens are corroborated, not taken on coverage', () => {
    it('accepts one the model name carries, spelled out', () => {
      // Asl|Fin|SK ⊂ AslFinanceSK: the prefix abbreviates what the name spells.
      const result = inferPrefixFromObjectNames([
        'AslFinSKVendPaymentTable', 'AslFinSKCustInvoiceJour',
        'AslFinSKLedgerJournalTrans', 'AslFinSKTaxReportTable',
      ], 'AslFinanceSK');

      expect(result?.regular).toBe('AslFinSK');
    });

    it('accepts one the model\'s own extensions state', () => {
      const result = inferPrefixFromObjectNames([
        'ContosoFinSKVendPaymentTable', 'ContosoFinSKCustInvoiceJour',
        'ContosoFinSKLedgerJournalTrans', 'ContosoFinSKTaxReportTable',
        'VendTable.ContosoFinSKExtension', 'CustTable.ContosoFinSKExtension',
      ], 'WhateverTheModelIsCalled');

      expect(result?.regular).toBe('ContosoFinSK');
    });

    it('falls back to two segments when the third is only a shared topic', () => {
      // A young model whose objects are all about notes. "Note" is nowhere in
      // the model name and no extension states it.
      const result = inferPrefixFromObjectNames([
        'ConDemoNoteHeader', 'ConDemoNoteLine', 'ConDemoNoteText',
        'ConDemoNoteFooter', 'ConDemoNoteParm',
      ], 'ConDemo');

      expect(result?.regular).toBe('ConDemo');
    });

    it('falls back for an abbreviated-looking topic word too', () => {
      const result = inferPrefixFromObjectNames([
        'IsvFinVendPayment', 'IsvFinVendInvoice', 'IsvFinVendBalance', 'IsvFinVendSettle',
      ], 'IsvFinance');

      expect(result?.regular).toBe('IsvFin');
    });

    it('still takes the long token when there is nothing to check it against', () => {
      // No model name, no stated infix: refusing every long token would be its
      // own guess, and this is the shape a caller with names only passes in.
      const result = inferPrefixFromObjectNames([
        'ContosoFinSKVendPaymentTable', 'ContosoFinSKCustInvoiceJour',
        'ContosoFinSKLedgerJournalTrans', 'ContosoFinSKTaxReportTable',
      ]);

      expect(result?.regular).toBe('ContosoFinSK');
    });

    it('leaves one- and two-segment tokens alone whatever the model is called', () => {
      expect(inferPrefixFromObjectNames([
        'ConDemoNoteHeader', 'ConDemoRental', 'ConDemoPayment', 'ConDemoTax',
      ], 'CompletelyUnrelatedName')?.regular).toBe('ConDemo');
    });
  });

  it('infers nothing from objects that share no prefix', () => {
    expect(inferPrefixFromObjectNames([
      'CustTable', 'VendInvoiceJour', 'SalesLine', 'InventTrans', 'LedgerJournalTable',
    ])).toBeNull();
  });

  it('infers nothing from a model too small to be evidence', () => {
    // A brand-new model with one or two objects proves nothing — the configured
    // prefix must stay in charge rather than be overruled by a coincidence.
    expect(inferPrefixFromObjectNames(['ConDemoNoteHeader', 'ConDemoModStatus'])).toBeNull();
  });

  it('ignores extension classes when measuring the leading token', () => {
    // Extension classes carry the token as a SUFFIX (…DEMO_Extension). Counting
    // them as regular objects would drag the leading-token coverage below the
    // threshold and lose an otherwise obvious prefix.
    const suffixHeavy = [
      'DEMO_ArchiveAccDocErrorLog', 'DEMO_AssetIPFairValue', 'DEMO_BackIntegrationLink', 'DEMO_AccrualDateFrom',
      'AccountingSourceExplorerDEMO_Extension', 'AcsAsset_AssetPreAcquisitionHelperDEMO_Extension',
      'AcsBasic_ACFeatureManagementDEMO_Extension', 'AgreementGenerationSalesToPurchStrategyDEMO_Extension',
      'AccountingSourceExplorerProcessorDEMO_Extension',
    ];

    expect(inferPrefixFromObjectNames(suffixHeavy)?.regular).toBe('DEMO_');
  });
});

describe('prefix resolution order', () => {
  it('lets the active model outrank the configured prefix', () => {
    process.env.EXTENSION_PREFIX = 'Con';
    setModelObjectNameSource(model => (model === 'Demo' ? DEMO_MODEL : []));

    expect(resolveObjectPrefix('Demo')).toBe('DEMO');
    expect(resolveRegularObjectPrefixToken('Demo')).toBe('DEMO_');
  });

  it('gives each model its own prefix within one session', () => {
    process.env.EXTENSION_PREFIX = 'Con';
    setModelObjectNameSource(model =>
      model === 'Demo' ? DEMO_MODEL : model === 'DemoCus' ? DEMO_CUS_MODEL : []);

    expect(resolveRegularObjectPrefixToken('Demo')).toBe('DEMO_');
    expect(resolveRegularObjectPrefixToken('DemoCus')).toBe('DMC_');
  });

  it('falls back to the configured prefix for a model with nothing to teach', () => {
    process.env.EXTENSION_PREFIX = 'Con';
    setModelObjectNameSource(() => []);

    expect(resolveObjectPrefix('BrandNewModel')).toBe('Con');
  });

  it('falls back to the model name when nothing is configured either', () => {
    setModelObjectNameSource(() => []);

    expect(resolveObjectPrefix('BrandNewModel')).toBe('BrandNewModel');
  });

  it('honours EXTENSION_PREFIX_SOURCE=config as an opt-out', () => {
    process.env.EXTENSION_PREFIX = 'Con';
    process.env.EXTENSION_PREFIX_SOURCE = 'config';
    setModelObjectNameSource(() => DEMO_MODEL);

    expect(resolveObjectPrefix('Demo')).toBe('Con');
  });

  it('applies the model prefix to a new object name', () => {
    process.env.EXTENSION_PREFIX = 'Con';
    setModelObjectNameSource(() => DEMO_MODEL);

    expect(applyObjectPrefix('AssetRegister', resolveObjectPrefix('Demo'), 'Demo'))
      .toBe('DEMO_AssetRegister');
  });

  it('uses the model\'s own infix for extension element names', () => {
    process.env.EXTENSION_PREFIX = 'Con';
    setModelObjectNameSource(() => DEMO_MODEL);

    // Deriving from "DEMO_" would give "CustTable.DemoExtension", which does not
    // match the model's dozens of existing …DEMOExtension elements.
    expect(deriveExtensionInfix(resolveObjectPrefix('Demo'), 'Demo')).toBe('DEMO');
    expect(applyObjectPrefix('CustTable.Extension', resolveObjectPrefix('Demo'), 'Demo'))
      .toBe('CustTable.DEMOExtension');
  });

  it('names new objects with the model\'s full three-segment prefix', () => {
    // End to end for the reported case: EXTENSION_PREFIX said "Contoso", the
    // effective prefix came out "ContosoFin", and every generated name was wrong
    // by two characters that nobody would spot in a diff.
    process.env.EXTENSION_PREFIX = 'Contoso';
    setModelObjectNameSource(() => CONTOSO_FIN_SK);

    expect(resolveObjectPrefix('ContosoFinanceSK')).toBe('ContosoFinSK');
    expect(applyObjectPrefix('VendPaymentJournal', resolveObjectPrefix('ContosoFinanceSK'), 'ContosoFinanceSK'))
      .toBe('ContosoFinSKVendPaymentJournal');
    expect(applyObjectPrefix('CustTable.Extension', resolveObjectPrefix('ContosoFinanceSK'), 'ContosoFinanceSK'))
      .toBe('CustTable.ContosoFinSKExtension');
  });

  it('keeps segment boundaries in a configured underscore-style prefix', () => {
    // No model to learn from, so the infix is derived — and deriving used to
    // flatten the whole token to "Contosofinsk".
    process.env.EXTENSION_PREFIX = 'ContosoFinSK_';
    setModelObjectNameSource(() => []);

    expect(resolveObjectPrefix('EmptyModel')).toBe('ContosoFinSK');
    expect(resolveRegularObjectPrefixToken('EmptyModel')).toBe('ContosoFinSK_');
    expect(deriveExtensionInfix('ContosoFinSK', 'EmptyModel')).toBe('ContosoFinSk');
  });

  it('leaves behaviour unchanged when no model prefix can be inferred', () => {
    // The pre-existing contract for EXTENSION_PREFIX="XY_", which many setups
    // rely on: regular objects keep the underscore, the infix does not.
    process.env.EXTENSION_PREFIX = 'XY_';
    setModelObjectNameSource(() => []);

    expect(resolveObjectPrefix('SomeModel')).toBe('XY');
    expect(resolveRegularObjectPrefixToken('SomeModel')).toBe('XY_');
    expect(deriveExtensionInfix('XY', 'SomeModel')).toBe('Xy');
    expect(applyObjectPrefix('CustTable', 'XY', 'SomeModel')).toBe('XY_CustTable');
  });
});

describe('inference caching', () => {
  it('queries the source once per model', () => {
    let calls = 0;
    setModelObjectNameSource(model => { calls++; return model === 'Demo' ? DEMO_MODEL : []; });

    getInferredModelPrefix('Demo');
    getInferredModelPrefix('Demo');
    resolveObjectPrefix('Demo');

    expect(calls).toBe(1);
  });

  it('caches the "nothing to learn" answer too', () => {
    // Otherwise every generated name re-runs the query against the 2 GB DB for
    // exactly the models where it can never succeed.
    let calls = 0;
    setModelObjectNameSource(() => { calls++; return []; });

    getInferredModelPrefix('EmptyModel');
    getInferredModelPrefix('EmptyModel');

    expect(calls).toBe(1);
  });
});
