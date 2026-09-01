/**
 * prepare(mode="create") and an EXTENSION name (issue #983).
 *
 * The 2026-09-01 L4 verification run grounded an enum-extension write with
 *
 *   prepare(mode="create", objectType="enum", objectName="NumberSeqModule.ConDemoRent")
 *
 * and got back
 *
 *   ❌ Name may contain only letters, digits and underscores
 *      suggestion: ConNumberSeqModule.ConDemoRent
 *
 * Both halves wrong. An AxEnumExtension is named `<BaseEnum>.<Suffix>` — the dot
 * is mandatory, not a typo — and the suggestion prefixed the BASE, naming an
 * object that does not exist. The write it was grounding then SUCCEEDED through
 * d365fo_file(action="create", objectType="enum-extension"), so the tool refused
 * and misdirected on the way to an operation the server fully supports, with the
 * two tools disagreeing about which objectTypes exist.
 *
 * Microsoft's own AxEnumExtensions settle the name shape: `AppCopilotAgentType.Foundation`,
 * `ModuleAxapta.ApplicationCommon` — the suffix need not spell "Extension".
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { clearInferredModelPrefixes, setModelObjectNameSource } from '../../src/utils/modelPrefixInference.js';

const MODEL = 'ConDemo';

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

async function prepareCreate(objectName: string, objectType: string): Promise<string> {
  const { prepareCreateTool } = await import('../../src/tools/prepare/prepareCreate.js');
  const result = await prepareCreateTool(
    { params: { arguments: { goal: 'test', objectName, objectType } } },
    buildContext(),
  );
  return String(result.content[0].text);
}

const originalEnv = { ...process.env };

beforeEach(() => {
  clearInferredModelPrefixes();
  setModelObjectNameSource(() => []);
  delete process.env.EXTENSION_PREFIX_SOURCE;
  delete process.env.EXTENSION_SUFFIX;
  delete process.env.EXTENSION_PREFIX;
});

afterEach(() => {
  setModelObjectNameSource(null);
  clearInferredModelPrefixes();
  process.env = { ...originalEnv };
});

describe('prepare(mode="create") accepts extension names', () => {
  it('publishes enum-extension as an objectType', async () => {
    const { prepareCreateArgsSchema } = await import('../../src/tools/prepare/prepareCreate.js');
    const shape = prepareCreateArgsSchema.shape.objectType;
    const values = (shape as any)._def?.values ?? (shape as any).options;
    for (const t of ['enum-extension', 'table-extension', 'form-extension', 'edt-extension', 'class-extension']) {
      expect(values, `${t} missing`).toContain(t);
    }
  });

  it('does not refuse a dotted name as an illegal character set', async () => {
    const text = await prepareCreate('NumberSeqModule.ConDemoRent', 'enum-extension');
    expect(text).not.toContain('Name may contain only letters, digits and underscores');
  });

  it('never suggests prefixing the BASE half of an extension name', async () => {
    const text = await prepareCreate('NumberSeqModule.ConDemoRent', 'enum-extension');
    // The base enum is Microsoft's; prefixing it names nothing.
    expect(text).not.toMatch(/\bConNumberSeqModule\./);
  });

  it('reads a dotted name under the BASE type as the extension it is', async () => {
    // The corpus call passed objectType="enum" because that was the only choice.
    // It still has to be understood.
    const text = await prepareCreate('NumberSeqModule.ConDemoRent', 'enum');
    expect(text).not.toContain('Name may contain only letters, digits and underscores');
    expect(text).not.toMatch(/\bConNumberSeqModule\./);
  });

  it('still refuses a name that is not two identifiers around one dot', async () => {
    for (const bad of ['A.B.C', 'NumberSeqModule.', '.ConDemoRent', 'NumberSeqModule.9Rent']) {
      const text = await prepareCreate(bad, 'enum-extension');
      expect(text, bad).toMatch(/❌/);
    }
  });
});
