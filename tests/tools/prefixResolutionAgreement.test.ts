/**
 * get_workspace_info and validate_object_naming must not disagree about the
 * effective prefix (#833).
 *
 * The reported state: get_workspace_info resolved the prefix from the model's
 * own objects and said so, and validate_object_naming then rejected a name built
 * from that very prefix as an ERROR — "the only allowed underscore is as a prefix
 * separator" — because it had checked the CONFIGURED prefix instead. Both tools
 * now read utils/effectivePrefix.ts, and a disagreement between the model and the
 * configuration produces a warning naming both candidates.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import type { XppServerContext } from '../../src/types/context.js';
import { validateObjectNamingTool } from '../../src/tools/analysis/validateObjectNaming.js';
import { buildPrefixDiagnostics } from '../../src/tools/analysis/prefixDiagnostics.js';
import {
  setModelObjectNameSource, clearInferredModelPrefixes,
} from '../../src/utils/modelPrefixInference.js';

const MODEL = 'ContosoFinanceSK';
/** The model's own objects — every one of them prefixed "ConSK_". */
const MODEL_OBJECTS = [
  'ConSK_VendPaymentTable', 'ConSK_CustInvoiceJour',
  'ConSK_LedgerJournalTrans', 'ConSK_TaxReportTable',
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
  delete process.env.EXTENSION_PREFIX_SOURCE;
  delete process.env.EXTENSION_SUFFIX;
  // The configured prefix is the SHORT one — the disagreement under test.
  process.env.EXTENSION_PREFIX = 'Con';
});

afterEach(() => {
  setModelObjectNameSource(null);
  clearInferredModelPrefixes();
  process.env = { ...originalEnv };
});

describe('effective prefix — validate_object_naming vs get_workspace_info', () => {
  it('accepts a name in prefix-separator form under the INFERRED prefix', async () => {
    // The exact call from the report: rejected with a bare ERROR even though the
    // server itself had just reported "ConSK" as the effective prefix.
    const out = await validate({ objectType: 'enum', proposedName: 'ConSK_NewEnum' });

    expect(out).not.toMatch(/ERRORS \(\d/);
    expect(out).toContain('Model Prefix: ConSK');
  });

  it('validates against the same prefix get_workspace_info reports', async () => {
    const reported = buildPrefixDiagnostics(MODEL, MODEL).effectivePrefix;
    const out = await validate({ objectType: 'enum', proposedName: 'ConSK_NewEnum' });

    expect(reported).toBe('ConSK');
    expect(out).toContain(`Model Prefix: ${reported}`);
    // …and its origin, so the two lines can be compared at all.
    expect(out).toContain('inferred from 4/4 objects of model "ContosoFinanceSK"');
  });

  it('names both candidates and how to pin the configured one', async () => {
    const out = await validate({ objectType: 'enum', proposedName: 'ConSK_NewEnum' });

    expect(out).toMatch(/WARNINGS \(\d/);
    expect(out).toContain('"ConSK_"');
    expect(out).toContain('EXTENSION_PREFIX="Con"');
    expect(out).toContain('EXTENSION_PREFIX_SOURCE=config');
  });

  it('warns rather than errors on a name carrying the CONFIGURED prefix', async () => {
    // "Con_NewEnum" is prefix-separator form too — under the token that lost.
    const out = await validate({ objectType: 'enum', proposedName: 'Con_NewEnum' });

    expect(out).not.toMatch(/ERRORS \(\d/);
    expect(out).toContain('the configured EXTENSION_PREFIX');
    expect(out).toContain('ConSK');
  });

  it('still errors on an underscore that is no prefix separator at all', async () => {
    const out = await validate({ objectType: 'enum', proposedName: 'Random_NewEnum' });

    expect(out).toMatch(/ERRORS \(\d/);
    expect(out).toContain('must not contain underscores');
  });

  it('says nothing about a conflict when the two agree', async () => {
    process.env.EXTENSION_PREFIX = 'ConSK';
    const out = await validate({ objectType: 'enum', proposedName: 'ConSK_NewEnum' });

    expect(out).not.toMatch(/ERRORS \(\d/);
    expect(out).not.toContain('EXTENSION_PREFIX_SOURCE=config');
  });

  it('honours EXTENSION_PREFIX_SOURCE=config in both tools at once', async () => {
    // The documented escape hatch: the configured value becomes authoritative,
    // so it is what get_workspace_info reports AND what validation enforces.
    process.env.EXTENSION_PREFIX_SOURCE = 'config';
    clearInferredModelPrefixes();

    expect(buildPrefixDiagnostics(MODEL, MODEL).effectivePrefix).toBe('Con');
    const accepted = await validate({ objectType: 'enum', proposedName: 'Con_NewEnum' });
    expect(accepted).not.toMatch(/ERRORS \(\d/);
    expect(accepted).toContain('Model Prefix: Con');

    const rejected = await validate({ objectType: 'enum', proposedName: 'ConSK_NewEnum' });
    expect(rejected).toMatch(/ERRORS \(\d/);
  });

  it('leaves an explicitly passed modelPrefix as the only candidate', async () => {
    const out = await validate({
      objectType: 'enum', proposedName: 'ConSK_NewEnum', modelPrefix: 'Con',
    });

    expect(out).toContain('Model Prefix: Con');
    expect(out).toMatch(/ERRORS \(\d/);
    // The caller pinned the prefix, so the server's own disagreement is not news.
    expect(out).not.toContain('EXTENSION_PREFIX_SOURCE=config');
  });
});
