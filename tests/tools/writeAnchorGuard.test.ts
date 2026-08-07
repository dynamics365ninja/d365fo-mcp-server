/**
 * The write anchor on the scaffold path.
 *
 * `create`, `modify` and `labels(create)` each consult the anchor; the scaffold
 * generators (`generate_object(mode="scaffold")`) did not. They resolve a model
 * from the ACTIVE project and then fs.writeFileSync a whole table / form /
 * report into it, so a get_workspace_info project switch moved the biggest
 * writes the server makes into the switched-to model with nothing in the way —
 * which is exactly what the 2026-08-07 demo produced.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockConfig } = vi.hoisted(() => ({
  mockConfig: {
    getModelName: vi.fn(() => 'DemoSK'),
    getWriteAnchorModel: vi.fn(() => 'DemoSK'),
    getToolProjectSwitch: vi.fn(() => null as null | { anchorModel: string; forcedModel: string }),
  },
}));

vi.mock('../../src/utils/configManager', () => ({
  getConfigManager: () => mockConfig,
}));

import { scaffoldWriteRefusal, scaffoldWriteRefusalResult } from '../../src/tools/writeAnchorGuard';

const table = (targetModel: string | null) => ({
  objectName: 'DemoSKTaxChangeLog',
  objectType: 'table',
  targetModel,
});

beforeEach(() => {
  delete process.env.D365FO_ALLOW_CROSS_MODEL_WRITE;
  delete process.env.D365FO_CROSS_MODEL_WRITE_MODELS;
  mockConfig.getWriteAnchorModel.mockReturnValue('DemoSK');
  mockConfig.getToolProjectSwitch.mockReturnValue(null);
});

afterEach(() => {
  delete process.env.D365FO_CROSS_MODEL_WRITE_MODELS;
});

describe('scaffoldWriteRefusal', () => {
  it('allows a scaffold into the anchored model', () => {
    expect(scaffoldWriteRefusal(table('DemoSK'))).toBeNull();
  });

  it('allows it when only the spelling differs', () => {
    expect(scaffoldWriteRefusal(table('demosk'))).toBeNull();
  });

  it('refuses a scaffold into the model a project switch made active', () => {
    // Reads followed the switch, the anchor did not: a scaffold now resolves
    // "DemoCore" as its target while writes still belong to "DemoSK".
    mockConfig.getToolProjectSwitch.mockReturnValue({ anchorModel: 'DemoSK', forcedModel: 'DemoCore' });

    const refusal = scaffoldWriteRefusal(table('DemoCore'));

    expect(refusal).toContain('Refusing to create');
    expect(refusal).toContain('DemoCore');
    // The switch is named as the bypass it is, not left to read as an unrelated error.
    expect(refusal).toContain('get_workspace_info(projectName="DemoCore")');
  });

  it('refuses a scaffold into any other custom model, switch or not', () => {
    expect(scaffoldWriteRefusal(table('DemoCore'))).toContain('Refusing to create');
  });

  it('lets the operator allow it in configuration', () => {
    process.env.D365FO_CROSS_MODEL_WRITE_MODELS = 'DemoCore';

    expect(scaffoldWriteRefusal(table('DemoCore'))).toBeNull();
  });

  it('stays silent when there is no anchor to measure against', () => {
    // Never a refusal on a guess: an unconfigured workspace has no model of its own.
    mockConfig.getWriteAnchorModel.mockReturnValue(null as any);

    expect(scaffoldWriteRefusal(table('DemoCore'))).toBeNull();
  });

  it('returns the refusal as an isError tool result', () => {
    const result = scaffoldWriteRefusalResult(table('DemoCore'));

    expect(result?.isError).toBe(true);
    expect(result?.content[0].text).toContain('Refusing to create');
    expect(scaffoldWriteRefusalResult(table('DemoSK'))).toBeNull();
  });
});
