/**
 * generate_object(scaffold, table, preview=true) — finding #21.
 *
 * scaffold is generation-only by name but the Windows path writes the file, and
 * undo_last_modification cannot clean that up (PackagesLocalDirectory is not a
 * git repo). preview=true is the no-write route.
 *
 * This file exists separately from code-generation.test.ts because it must run
 * with NO resolvable PackagesLocalDirectory — the dev VM has K:\AosService, so
 * the shared suite silently takes the happy path and only CI would catch a
 * preview that still demands a write location.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { handleGenerateSmartTable } from '../../src/tools/generateSmartTable';

vi.mock('../../src/utils/configManager', () => ({
  getConfigManager: vi.fn(() => ({
    ensureLoaded: vi.fn(async () => {}),
    // The machine has no D365FO installation — every source is exhausted.
    getPackagePath: vi.fn(() => null),
    getCustomPackagesPath: vi.fn(async () => null),
    getProjectPath: vi.fn(async () => null),
    getSolutionPath: vi.fn(async () => null),
    getModelName: vi.fn(() => null),
    getAutoDetectedModelName: vi.fn(async () => null),
    getContext: vi.fn(() => null),
  })),
  fallbackPackagePath: vi.fn(() => 'C:\\AosService\\PackagesLocalDirectory'),
  extractModelFromFilePath: vi.fn(() => null),
}));

const symbolIndex = {
  getReadDb: () => ({
    prepare: () => ({ all: () => [], get: () => undefined, run: () => {} }),
  }),
} as any;

describe('scaffold table preview=true (#21)', () => {
  beforeEach(() => {
    // Force the Windows branch — the one that writes to disk.
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    vi.stubEnv('EXTENSION_PREFIX', '');
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    vi.unstubAllEnvs();
  });

  it('returns the XML without demanding a PackagesLocalDirectory', async () => {
    const result = await handleGenerateSmartTable(
      {
        name: 'ConDemoPreview',
        modelName: 'MyModel',
        preview: true,
        fields: [{ name: 'NoteId', edt: 'Description' }],
      },
      symbolIndex,
    );

    const text = result?.content[0].text as string;
    expect(text).not.toMatch(/Cannot determine PackagesLocalDirectory/);
    expect(text).toContain('nothing was written to disk');
    expect(text).toContain('<AxTable');
    expect(text).toContain('<Name>NoteId</Name>');
  });

  it('still refuses a real (non-preview) scaffold with no write location', async () => {
    await expect(
      handleGenerateSmartTable(
        { name: 'ConDemoReal', modelName: 'MyModel', fields: [{ name: 'NoteId' }] },
        symbolIndex,
      ),
    ).rejects.toThrow(/Cannot determine PackagesLocalDirectory/);
  });
});
