/**
 * Prefix inference from a model's own objects.
 *
 * A single configured EXTENSION_PREFIX cannot be right for a developer who works
 * across several models — on the reference VM, HBReavis names its objects HBR_*
 * and HBReavisCus names them HBC_*, while EXTENSION_PREFIX says "Con". The name
 * samples below are taken verbatim from that machine's PackagesLocalDirectory,
 * so these tests pin the inference against real AOT naming rather than invented
 * examples.
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

// Real object names from K:\AosService\PackagesLocalDirectory\HBReavis\HBReavis
const HB_REAVIS = [
  'HBR_ArchiveAccDocErrorLog',
  'HBR_AssetIPFairValue',
  'HBR_AssetIPFairValueStaging',
  'HBR_AssetsDepreciationSimulationTmp',
  'HBR_BackIntegrationLink',
  'HBR_BusinessPartnerStaging',
  'HBR_AccrualDateFrom',
  'HBR_AllowAutomaticSalesInvoicePosting',
  'AccountingSourceExplorerTmp.HBRExtension',
  'AssetBookTable.HBRExtension',
  'AssetDepSuspension_CZ.HBRExtension',
  'AccountingSourceExplorerHBR_Extension',
  'AgreementGenerationPurchToSalesStrategyHBR_Extension',
];

// …\HBReavisCus\HBReavisCus — same solution, different model, different prefix.
const HB_REAVIS_CUS = [
  'HBC_REMLeaseContractLineUGs',
  'HBC_REMLeaseContractLineUGsStaging',
  'HBC_OldDebtsReportController',
  'HBC_OldDebtsReportDP',
  'HBC_SalesInvoiceHeaderEmailHandler',
  'HBC_AssetFirstUseDate',
  'AssetTable.HBCExtension',
  'CustTransFormHBC_Extension',
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
    const result = inferPrefixFromObjectNames(HB_REAVIS);

    // The two are NOT derivable from one another: deriving "HBR_" per the
    // documented rule yields the infix "Hbr", but the model's own extensions
    // spell it "HBRExtension".
    expect(result?.regular).toBe('HBR_');
    expect(result?.infix).toBe('HBR');
  });

  it('distinguishes two models that share a solution', () => {
    expect(inferPrefixFromObjectNames(HB_REAVIS_CUS)?.regular).toBe('HBC_');
    expect(inferPrefixFromObjectNames(HB_REAVIS_CUS)?.infix).toBe('HBC');
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
    // Extension classes carry the token as a SUFFIX (…HBR_Extension). Counting
    // them as regular objects would drag the leading-token coverage below the
    // threshold and lose an otherwise obvious prefix.
    const suffixHeavy = [
      'HBR_ArchiveAccDocErrorLog', 'HBR_AssetIPFairValue', 'HBR_BackIntegrationLink', 'HBR_AccrualDateFrom',
      'AccountingSourceExplorerHBR_Extension', 'AcsAsset_AssetPreAcquisitionHelperHBR_Extension',
      'AcsBasic_ACFeatureManagementHBR_Extension', 'AgreementGenerationSalesToPurchStrategyHBR_Extension',
      'AccountingSourceExplorerProcessorHBR_Extension',
    ];

    expect(inferPrefixFromObjectNames(suffixHeavy)?.regular).toBe('HBR_');
  });
});

describe('prefix resolution order', () => {
  it('lets the active model outrank the configured prefix', () => {
    process.env.EXTENSION_PREFIX = 'Con';
    setModelObjectNameSource(model => (model === 'HBReavis' ? HB_REAVIS : []));

    expect(resolveObjectPrefix('HBReavis')).toBe('HBR');
    expect(resolveRegularObjectPrefixToken('HBReavis')).toBe('HBR_');
  });

  it('gives each model its own prefix within one session', () => {
    process.env.EXTENSION_PREFIX = 'Con';
    setModelObjectNameSource(model =>
      model === 'HBReavis' ? HB_REAVIS : model === 'HBReavisCus' ? HB_REAVIS_CUS : []);

    expect(resolveRegularObjectPrefixToken('HBReavis')).toBe('HBR_');
    expect(resolveRegularObjectPrefixToken('HBReavisCus')).toBe('HBC_');
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
    setModelObjectNameSource(() => HB_REAVIS);

    expect(resolveObjectPrefix('HBReavis')).toBe('Con');
  });

  it('applies the model prefix to a new object name', () => {
    process.env.EXTENSION_PREFIX = 'Con';
    setModelObjectNameSource(() => HB_REAVIS);

    expect(applyObjectPrefix('AssetRegister', resolveObjectPrefix('HBReavis'), 'HBReavis'))
      .toBe('HBR_AssetRegister');
  });

  it('uses the model\'s own infix for extension element names', () => {
    process.env.EXTENSION_PREFIX = 'Con';
    setModelObjectNameSource(() => HB_REAVIS);

    // Deriving from "HBR_" would give "CustTable.HbrExtension", which does not
    // match the model's dozens of existing …HBRExtension elements.
    expect(deriveExtensionInfix(resolveObjectPrefix('HBReavis'), 'HBReavis')).toBe('HBR');
    expect(applyObjectPrefix('CustTable.Extension', resolveObjectPrefix('HBReavis'), 'HBReavis'))
      .toBe('CustTable.HBRExtension');
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
    setModelObjectNameSource(model => { calls++; return model === 'HBReavis' ? HB_REAVIS : []; });

    getInferredModelPrefix('HBReavis');
    getInferredModelPrefix('HBReavis');
    resolveObjectPrefix('HBReavis');

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
