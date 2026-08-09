/**
 * prepare(mode="create") must predict the name d365fo_file(action="create") writes.
 *
 * prepare re-derived the final name with `applyObjectPrefix(name, prefix)` — two
 * arguments — while the write path goes through `normalizeObjectName(name, type, model)`,
 * which passes the model on to the same helper. Without the model, applyObjectPrefix
 * cannot see the separator the model's own objects use and falls back to
 * EXTENSION_PREFIX, so for a model whose objects are "ConSK_*":
 *
 *   prepare  said : ConSKQualityTier      (no separator)
 *   create   wrote: ConSK_QualityTier     (separator)
 *
 * The caller believed prepare, passed objectName="_QualityTier" to compensate, and got
 * `ConSK__QualityTier.xml` on disk — a create, an undo_last_modification and a second
 * create, ~92 s of one session. The same wrong name also fed prepare's collision check
 * and its grounding token, so a real collision on the name that WOULD be written read
 * back as "✅ No collision".
 *
 * Covers:
 *   - underscore-style inferred prefix survives the prediction
 *   - the collision check probes the name that actually gets written
 *   - extension types get the dot/_Extension form create uses
 *   - EXTENSION_SUFFIX is reflected, since create applies it too
 *
 * Regression guard: prepare's rendered "Final name" MUST equal normalizeObjectName().
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { normalizeObjectName } from '../../src/utils/objectNaming.js';
import {
  setModelObjectNameSource, clearInferredModelPrefixes,
} from '../../src/utils/modelPrefixInference.js';

const MODEL = 'ContosoFinanceSK';
/** The model's own objects — every one of them "ConSK_"-prefixed, separator included. */
const MODEL_OBJECTS = [
  'ConSK_VATCSSection', 'ConSK_VATReportSetup',
  'ConSK_OrigInvoiceNum', 'ConSK_ControlStatement',
];

vi.mock('../../src/utils/configManager', () => ({
  getConfigManager: vi.fn(() => ({
    getModelName: () => MODEL,
    getWriteAnchorModel: () => MODEL,
    getAutoDetectedModelName: async () => MODEL,
  })),
}));

const buildContext = () => {
  const stmt = { all: vi.fn(() => []), get: vi.fn(() => undefined), run: vi.fn() };
  const db = { prepare: vi.fn(() => stmt) };
  return {
    symbolIndex: { db, getReadDb: () => db } as any,
    parser: {} as any,
    cache: {} as any,
    workspaceScanner: {} as any,
    hybridSearch: {} as any,
  } as any;
};

/** Run prepare and return the name it printed on the "Final name" line. */
async function preparedFinalName(objectName: string, objectType: string): Promise<string> {
  const { prepareCreateTool } = await import('../../src/tools/prepare/prepareCreate.js');
  const result = await prepareCreateTool(
    { params: { arguments: { goal: 'test', objectName, objectType } } },
    buildContext(),
  );
  const text = String(result.content[0].text);
  const match = /^Final name\s*:\s*(\S+)/m.exec(text);
  expect(match, `no "Final name" line in:\n${text}`).toBeTruthy();
  return match![1];
}

const originalEnv = { ...process.env };

beforeEach(() => {
  clearInferredModelPrefixes();
  setModelObjectNameSource(model => (model === MODEL ? MODEL_OBJECTS : []));
  delete process.env.EXTENSION_PREFIX_SOURCE;
  delete process.env.EXTENSION_SUFFIX;
  delete process.env.EXTENSION_PREFIX;
});

afterEach(() => {
  setModelObjectNameSource(null);
  clearInferredModelPrefixes();
  process.env = { ...originalEnv };
});

describe('prepare(mode="create") name prediction', () => {
  it('keeps the separator of an underscore-style inferred prefix', async () => {
    // Predicted "ConSKQualityTier" while create wrote "ConSK_QualityTier".
    expect(await preparedFinalName('QualityTier', 'enum')).toBe('ConSK_QualityTier');
  });

  it('agrees with the helper the write path uses', async () => {
    for (const [name, type] of [
      ['QualityTier', 'enum'],
      ['TaxAdjustment', 'class'],
      ['ReportChangeLog', 'table'],
    ] as const) {
      expect(await preparedFinalName(name, type)).toBe(normalizeObjectName(name, type, MODEL));
    }
  });

  it('does not double-prefix an already-prefixed name', async () => {
    expect(await preparedFinalName('ConSK_QualityTier', 'enum')).toBe('ConSK_QualityTier');
  });

  it('reflects EXTENSION_SUFFIX, which create also applies', async () => {
    process.env.EXTENSION_SUFFIX = '_Custom';

    expect(await preparedFinalName('QualityTier', 'enum'))
      .toBe(normalizeObjectName('QualityTier', 'enum', MODEL));
  });

  it('probes the written name in the collision check', async () => {
    const { prepareCreateTool } = await import('../../src/tools/prepare/prepareCreate.js');
    const result = await prepareCreateTool(
      { params: { arguments: { goal: 'test', objectName: 'QualityTier', objectType: 'enum' } } },
      buildContext(),
    );
    const text = String(result.content[0].text);

    // It used to clear "ConSKQualityTier" — a name nothing would ever be written under.
    expect(text).toContain('"ConSK_QualityTier"');
    expect(text).not.toContain('"ConSKQualityTier"');
  });
});
