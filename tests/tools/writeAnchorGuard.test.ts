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
    // The guards resolve the anchor through this now: the sync getter returns
    // null until the background .rnrproj scan lands, and a null anchor makes the
    // guard stand down — a race that decided whether the guard ran at all.
    resolveWriteAnchorModel: vi.fn(async () => mockConfig.getWriteAnchorModel()),
    getToolProjectSwitch: vi.fn(() => null as null | { anchorModel: string; forcedModel: string }),
  } as any,
}));

vi.mock('../../src/utils/configManager', () => ({
  getConfigManager: () => mockConfig,
}));

import { scaffoldWriteRefusal, scaffoldWriteRefusalResult } from '../../src/tools/write/writeAnchorGuard';
import { standDownNotice, activeCrossModelAllowance } from '../../src/utils/crossModelWriteGuard';

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
  delete process.env.D365FO_ALLOW_CROSS_MODEL_WRITE;
});

describe('scaffoldWriteRefusal', () => {
  it('allows a scaffold into the anchored model', async () => {
    expect(await scaffoldWriteRefusal(table('DemoSK'))).toBeNull();
  });

  it('allows it when only the spelling differs', async () => {
    expect(await scaffoldWriteRefusal(table('demosk'))).toBeNull();
  });

  it('refuses a scaffold into the model a project switch made active', async () => {
    // Reads followed the switch, the anchor did not: a scaffold now resolves
    // "DemoCore" as its target while writes still belong to "DemoSK".
    mockConfig.getToolProjectSwitch.mockReturnValue({ anchorModel: 'DemoSK', forcedModel: 'DemoCore' });

    const refusal = await scaffoldWriteRefusal(table('DemoCore'));

    expect(refusal).toContain('Refusing to create');
    expect(refusal).toContain('DemoCore');
    // The switch is named as the bypass it is, not left to read as an unrelated error.
    expect(refusal).toContain('get_workspace_info(projectName="DemoCore")');
  });

  it('refuses a scaffold into any other custom model, switch or not', async () => {
    expect(await scaffoldWriteRefusal(table('DemoCore'))).toContain('Refusing to create');
  });

  it('lets the operator allow it in configuration', async () => {
    process.env.D365FO_CROSS_MODEL_WRITE_MODELS = 'DemoCore';

    expect(await scaffoldWriteRefusal(table('DemoCore'))).toBeNull();
  });

  it('stays silent when there is no anchor to measure against', async () => {
    // Never a refusal on a guess: an unconfigured workspace has no model of its own.
    mockConfig.getWriteAnchorModel.mockReturnValue(null as any);

    expect(await scaffoldWriteRefusal(table('DemoCore'))).toBeNull();
  });

  it('resolves the anchor rather than reading the sync getter', async () => {
    // The whole point of the async path: a workspace whose model arrives with the
    // background scan used to slip past the guard entirely.
    mockConfig.getWriteAnchorModel.mockReturnValue(null as any);
    mockConfig.resolveWriteAnchorModel.mockResolvedValueOnce('DemoSK');

    expect(await scaffoldWriteRefusal(table('DemoCore'))).toContain('Refusing to create');
  });

  it('returns the refusal as an isError tool result', async () => {
    const result = await scaffoldWriteRefusalResult(table('DemoCore'));

    expect(result?.isError).toBe(true);
    expect(result?.content[0].text).toContain('Refusing to create');
    expect(await scaffoldWriteRefusalResult(table('DemoSK'))).toBeNull();
  });
});

/**
 * Refused once, the caller found the host's mcp.json and added the allow-list
 * key to its env block itself; writes into the other model then succeeded with a
 * clean ✅, traced only by a console.error in a log truncated on every restart.
 * The guard cannot tell whose hand wrote its configuration — it can refuse to be
 * quiet.
 */
describe('standing down is never silent', () => {
  it('names the configuration that permitted a foreign-model write', () => {
    process.env.D365FO_CROSS_MODEL_WRITE_MODELS = 'DemoCore';

    const note = standDownNotice({
      objectName: 'DemoSKTaxChangeLog',
      objectType: 'table',
      owningModel: 'DemoCore',
      activeModel: 'DemoSK',
      action: 'create',
    });

    expect(note).toContain('permitted by configuration');
    expect(note).toContain('DemoCore');
    expect(note).toContain('D365FO_CROSS_MODEL_WRITE_MODELS');
  });

  it('says so when there was no anchor to measure against', () => {
    const note = standDownNotice({
      objectName: 'DemoSKTaxChangeLog',
      objectType: 'table',
      owningModel: 'DemoCore',
      activeModel: '',
      action: 'create',
    });

    expect(note).toContain('guard did not run');
    expect(note).toContain('could not be determined');
  });

  it('stays empty for a write that never left the active model', () => {
    expect(standDownNotice({
      objectName: 'X', objectType: 'table', owningModel: 'DemoSK', activeModel: 'DemoSK',
    })).toBe('');
    // …and for a package-name match, which counts as the same model.
    expect(standDownNotice({
      objectName: 'X', objectType: 'table', owningModel: 'DemoSKModel',
      owningPackage: 'DemoSK', activeModel: 'DemoSK',
    })).toBe('');
  });

  it('reports an allowance without needing a write to be attempted', () => {
    expect(activeCrossModelAllowance()).toBeNull();
    process.env.D365FO_CROSS_MODEL_WRITE_MODELS = 'DemoCore';
    expect(activeCrossModelAllowance()).toContain('DemoCore');
    process.env.D365FO_ALLOW_CROSS_MODEL_WRITE = 'true';
    expect(activeCrossModelAllowance()).toContain('ANY model');
  });
});
