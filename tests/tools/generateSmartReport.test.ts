/**
 * Regression (eval scenario 5 — inventory aging analytics): generate_object(mode="scaffold",
 * objectType="report") emitted `SysOperationMandatoryAttribute(true)` on a Contract parm method
 * for any contractParams entry with mandatory:true. No such class exists in D365FO — the build
 * failed with "Class 'SysOperationMandatoryAttribute' was not found. Are you missing a module
 * reference?" on every report with a mandatory dialog field (e.g. InventLocationId mandatory=true).
 * Mandatory enforcement for a SysOperation/report contract is already correctly done via the
 * generated validate() method's checkFailed() call — no per-parameter attribute is needed.
 *
 * The tool has two output paths depending on process.platform: Windows writes files to disk via
 * fs.writeFileSync, non-Windows (Azure/Linux — this is how the CI runner sees it) returns every
 * generated object's XML embedded as text instead. The test forces the platform-independent
 * non-Windows path so it behaves identically in CI and locally, without needing to mock fs/
 * ProjectFileManager (neither is reached on that path).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../src/utils/configManager', () => ({
  getConfigManager: vi.fn(() => ({
    ensureLoaded: vi.fn(async () => {}),
    getPackagePath: vi.fn(() => 'K:\\PackagesLocalDirectory'),
    getModelName: vi.fn(() => 'MyModel'),
    getProjectPath: vi.fn(async () => null),
    getSolutionPath: vi.fn(async () => null),
    getAutoDetectedModelName: vi.fn(async () => 'MyModel'),
  })),
}));

vi.mock('../../src/utils/modelClassifier', () => ({
  resolveObjectPrefix: vi.fn(() => ''),
  applyObjectPrefix: vi.fn((name: string) => name),
  getObjectSuffix: vi.fn(() => ''),
  applyObjectSuffix: vi.fn((name: string) => name),
}));

import { handleGenerateSmartReport } from '../../src/tools/generateSmartReport';

function createSymbolIndexStub() {
  const stmt = { all: vi.fn(() => []), get: vi.fn(() => undefined) };
  return {
    getReadDb: vi.fn(() => ({ prepare: vi.fn(() => stmt) })),
  } as any;
}

describe('generate_object(scaffold, report) contract mandatory param', () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    vi.clearAllMocks();
    // Force the non-Windows (Azure/Linux) code path, which returns every generated
    // object's XML as text instead of writing to disk — deterministic regardless of
    // which OS actually runs the test (local Windows VM vs. the Linux CI runner).
    Object.defineProperty(process, 'platform', { value: 'linux' });
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
  });

  it('never emits the non-existent SysOperationMandatoryAttribute for a mandatory contractParam', async () => {
    const symbolIndex = createSymbolIndexStub();

    const result = await handleGenerateSmartReport(
      {
        name: 'InventAgingReport',
        fieldsHint: 'ItemId, InventLocationId',
        contractParams: [
          { name: 'InventLocationId', type: 'InventLocationId', mandatory: true, label: 'Warehouse' },
          { name: 'AsOfDate', type: 'TransDate', mandatory: false, label: 'As of date' },
        ],
        modelName: 'MyModel',
      } as any,
      symbolIndex
    );

    const text = result.content[0].text as string;

    // Sanity: the Contract class was actually generated and embedded in the output.
    expect(text).toContain('InventAgingReportContract');
    expect(text).toContain('DataMemberAttribute');
    // Mandatory enforcement still happens, just via validate()/checkFailed, not a
    // per-parameter attribute — the class this was hallucinated for does not exist.
    expect(text).not.toContain('SysOperationMandatoryAttribute');
    expect(text).toContain('public boolean validate()');
    expect(text).toContain('checkFailed');
  });
});
