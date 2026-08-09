/**
 * An extension name asked about under its base type is a question about the extension.
 *
 * Run f2e7b71a asked validate_object_naming for
 * "AslFinCore_TaxTransReportChangeLog.AslFinSKExtension" with objectType="form". The
 * non-extension underscore rule fired and returned a hard ERROR — "Non-extension
 * objects must not contain underscores" — for a name that is obviously an extension.
 * The agent then re-asked with objectType="form-extension" (T56 → T59): one wasted
 * round trip, and a misleading error in the transcript for the rest of the session.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import type { XppServerContext } from '../../src/types/context.js';
import { validateObjectNamingTool } from '../../src/tools/analysis/validateObjectNaming.js';
import { setModelObjectNameSource, clearInferredModelPrefixes } from '../../src/utils/modelPrefixInference.js';

const MODEL = 'ContosoFinanceSK';
const MODEL_OBJECTS = [
  'ConSK_VendPaymentTable',
  'ConSK_CustInvoiceJour',
  'ConSK_LedgerJournalTrans',
  'ConSK_TaxReportTable',
];

vi.mock('../../src/utils/configManager', () => ({
  getConfigManager: vi.fn(() => ({
    getModelName: () => MODEL,
    getWriteAnchorModel: () => MODEL,
    getAutoDetectedModelName: async () => MODEL,
  })),
}));

const req = (args: Record<string, unknown>): CallToolRequest => ({
  method: 'tools/call',
  params: { name: 'validate_object_naming', arguments: args },
});

const buildContext = (): XppServerContext => {
  const stmt = { all: vi.fn(() => []), get: vi.fn(() => undefined), run: vi.fn() };
  const db = { prepare: vi.fn(() => stmt) };
  return {
    symbolIndex: { db, getReadDb: () => db } as any,
    parser: {} as any,
    cache: {} as any,
    workspaceScanner: {} as any,
    hybridSearch: {} as any,
  };
};

const validate = async (args: Record<string, unknown>): Promise<string> => {
  const result = await validateObjectNamingTool(req(args), buildContext());
  return String(result.content[0].text);
};

const originalEnv = { ...process.env };

beforeEach(() => {
  clearInferredModelPrefixes();
  setModelObjectNameSource(model => (model === MODEL ? MODEL_OBJECTS : []));
});

afterEach(() => {
  process.env = { ...originalEnv };
  clearInferredModelPrefixes();
  setModelObjectNameSource(null as never);
});

describe('extension type inferred from the proposed name', () => {
  it('answers the form-extension question the caller meant', async () => {
    const out = await validate({
      objectType: 'form',
      proposedName: 'ConSK_TaxReportTable.ConSKExtension',
      baseObjectName: 'ConSK_TaxReportTable',
    });

    expect(out).toContain('as form-extension');
    expect(out).toContain('Read as **form-extension**');
    // The false alarm that cost the extra call.
    expect(out).not.toContain('Non-extension objects must not contain underscores');
  });

  it('infers the base object from the dotted name when none was passed', async () => {
    const out = await validate({
      objectType: 'table',
      proposedName: 'ConSK_TaxReportTable.ConSKExtension',
    });

    expect(out).toContain('as table-extension');
    expect(out).toContain('Base Object: ConSK_TaxReportTable');
    expect(out).not.toContain('baseObjectName is required');
  });

  it('reads the class CoC suffix form too', async () => {
    const out = await validate({
      objectType: 'class',
      proposedName: 'ConSK_TaxReportTableConSK_Extension',
      baseObjectName: 'ConSK_TaxReportTable',
    });

    expect(out).toContain('as class-extension');
  });

  it('still rejects a genuinely bad non-extension name', async () => {
    // The underscore rule exists for exactly this: a plain form whose underscore is not
    // the model's prefix separator (the prefix here is "ConSK"), and nothing about the
    // name that says "extension". This is the shape the run's name shared — it began
    // "AslFinCore_" while the prefix was "AslFinSK" — minus the extension suffix.
    const out = await validate({
      objectType: 'form',
      proposedName: 'ConCore_TaxReportDetail',
    });

    expect(out).toContain('as form');
    expect(out).toContain('Non-extension objects must not contain underscores');
  });

  it('leaves an explicit extension type alone', async () => {
    const out = await validate({
      objectType: 'form-extension',
      proposedName: 'ConSK_TaxReportTable.ConSKExtension',
      baseObjectName: 'ConSK_TaxReportTable',
    });

    expect(out).toContain('as form-extension');
    expect(out).not.toContain('Read as **form-extension**');
  });

  it('does not reinterpret a type that has no extension counterpart', async () => {
    const out = await validate({
      objectType: 'query',
      proposedName: 'ConSK_Something.ConSKExtension',
    });

    expect(out).toContain('as query');
  });
});
