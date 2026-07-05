/**
 * Regression (eval scenario 5 — inventory aging analytics): generate_object(mode="scaffold",
 * objectType="report") emitted `SysOperationMandatoryAttribute(true)` on a Contract parm method
 * for any contractParams entry with mandatory:true. No such class exists in D365FO — the build
 * failed with "Class 'SysOperationMandatoryAttribute' was not found. Are you missing a module
 * reference?" on every report with a mandatory dialog field (e.g. InventLocationId mandatory=true).
 * Mandatory enforcement for a SysOperation/report contract is already correctly done via the
 * generated validate() method's checkFailed() call — no per-parameter attribute is needed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('fs', () => ({
  default: {
    existsSync: vi.fn(() => true),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
  },
}));

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

vi.mock('../../src/tools/createD365File', async (orig) => {
  const actual = await orig<typeof import('../../src/tools/createD365File')>();
  return {
    ...actual,
    ProjectFileManager: vi.fn().mockImplementation(() => ({
      addToProject: vi.fn(async () => true),
    })),
  };
});

import fs from 'fs';
import { handleGenerateSmartReport } from '../../src/tools/generateSmartReport';

function createSymbolIndexStub() {
  const stmt = { all: vi.fn(() => []), get: vi.fn(() => undefined) };
  return {
    getReadDb: vi.fn(() => ({ prepare: vi.fn(() => stmt) })),
  } as any;
}

describe('generate_object(scaffold, report) contract mandatory param', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (fs.existsSync as any).mockReturnValue(true);
  });

  it('never emits the non-existent SysOperationMandatoryAttribute for a mandatory contractParam', async () => {
    const symbolIndex = createSymbolIndexStub();

    await handleGenerateSmartReport(
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

    const writeCalls = (fs.writeFileSync as any).mock.calls as Array<[string, string, string]>;
    const contractWrite = writeCalls.find(([targetPath]) => targetPath.includes('Contract.xml'));
    expect(contractWrite).toBeDefined();

    const contractXml = contractWrite![1];
    expect(contractXml).not.toContain('SysOperationMandatoryAttribute');
    expect(contractXml).toContain('DataMemberAttribute');
    // Mandatory enforcement still happens, just via validate()/checkFailed, not an attribute.
    expect(contractXml).toContain('public boolean validate()');
    expect(contractXml).toContain('checkFailed');
    expect(contractXml).toContain('InventLocationId');
  });
});
