/**
 * generate_object(scaffold) writes table and form files itself on Windows, so it
 * must record them in the created-artifact ledger the way d365fo_file create does.
 *
 * undo deletes an untracked file only when this session created it (the ledger
 * says so). A scaffold that wrote straight to disk without recording left undo
 * with nothing to go on: "not tracked by git, and this session did not create it".
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import path from 'path';

const { paths } = vi.hoisted(() => ({ paths: { root: '' } }));

vi.mock('../../src/utils/configManager', () => ({
  getConfigManager: vi.fn(() => ({
    ensureLoaded: vi.fn(async () => {}),
    getPackagePath: vi.fn(() => paths.root),
    getCustomPackagesPath: vi.fn(async () => null),
    getModelName: vi.fn(() => 'MyModel'),
    getWriteAnchorModel: vi.fn(() => 'MyModel'),
    getProjectPath: vi.fn(async () => null),
    getSolutionPath: vi.fn(async () => null),
    getAutoDetectedModelName: vi.fn(async () => 'MyModel'),
    getDevEnvironmentType: vi.fn(async () => 'traditional'),
  })),
}));

vi.mock('../../src/utils/modelClassifier', async orig => ({
  ...(await orig<typeof import('../../src/utils/modelClassifier')>()),
  resolveObjectPrefix: vi.fn(() => ''),
  applyObjectPrefix: vi.fn((name: string) => name),
  getObjectSuffix: vi.fn(() => ''),
  applyObjectSuffix: vi.fn((name: string) => name),
}));

import { handleGenerateSmartTable } from '../../src/tools/smart/generateSmartTable';
import { handleGenerateSmartForm } from '../../src/tools/smart/generateSmartForm';
import { lookupCreatedArtifact, _clearCreatedArtifactLedger } from '../../src/workspace/createdArtifactLedger';

const symbolIndex = () => ({
  searchSymbols: vi.fn(() => []),
  getSymbolByName: vi.fn(() => undefined),
  getTableFields: vi.fn(() => []),
  getCustomModels: vi.fn(() => ['MyModel']),
  db: { prepare: vi.fn(() => ({ all: vi.fn(() => []), get: vi.fn(() => undefined), run: vi.fn() })) },
  getReadDb: vi.fn(function (this: any) { return this.db; }),
}) as any;

const originalPlatform = process.platform;

beforeEach(() => {
  paths.root = fs.mkdtempSync(path.join(os.tmpdir(), 'scaffold-ledger-'));
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  _clearCreatedArtifactLedger();
});

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
  fs.rmSync(paths.root, { recursive: true, force: true });
  _clearCreatedArtifactLedger();
});

// The generators write only on Windows and build their target path with '\'
// separators, so on Linux a POSIX temp root never receives the file.
describe.skipIf(originalPlatform !== 'win32')('generate_object(scaffold) records what it creates, so undo can delete it', () => {
  it('records a table written by the XML fallback', async () => {
    await handleGenerateSmartTable(
      { name: 'ConLedgerTable', modelName: 'MyModel', packagePath: paths.root, fields: [{ name: 'NoteId', edt: 'Description' }] },
      symbolIndex(),
    );
    const file = path.join(paths.root, 'MyModel', 'MyModel', 'AxTable', 'ConLedgerTable.xml');
    expect(fs.existsSync(file)).toBe(true);
    expect(lookupCreatedArtifact(file)).toMatchObject({ objectType: 'table', objectName: 'ConLedgerTable' });
  });

  it('records a new form, but not one it overwrote', async () => {
    const file = path.join(paths.root, 'MyModel', 'MyModel', 'AxForm', 'ConLedgerForm.xml');
    await handleGenerateSmartForm({ name: 'ConLedgerForm', modelName: 'MyModel' }, symbolIndex());
    expect(fs.existsSync(file)).toBe(true);
    expect(lookupCreatedArtifact(file)).toMatchObject({ objectType: 'form', objectName: 'ConLedgerForm' });

    _clearCreatedArtifactLedger();
    await handleGenerateSmartForm({ name: 'ConLedgerForm', modelName: 'MyModel' }, symbolIndex());
    expect(lookupCreatedArtifact(file)).toBeUndefined();
  });
});
