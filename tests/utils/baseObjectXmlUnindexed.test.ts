/**
 * findBaseObjectXml for a type the index build never extracts. scripts/extract-metadata.ts
 * has no AxMenu step, so a shipped menu (OrganizationAdministration lives in
 * ApplicationSuite\Foundation) has no symbols row, and the configured-model disk probe
 * cannot see it either. Without the package scan, the parent check of
 * add-menu-item-to-menu on a menu-extension fell back to "NOT checked" for every
 * standard menu — the very case it exists for.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const state = vi.hoisted(() => ({ root: '' }));

vi.mock('../../src/utils/configManager.js', () => ({
  getConfigManager: () => ({
    ensureLoaded: async () => undefined,
    getPackagePath: () => state.root,
    getCustomPackagesPath: async () => null,
    getDevEnvironmentType: async () => 'traditional',
    getMicrosoftPackagesPath: async () => null,
  }),
  fallbackPackagePath: () => state.root,
}));
vi.mock('../../src/utils/objectFileLookup.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/utils/objectFileLookup.js')>()),
  findD365FileOnDisk: async () => null,
}));

import { findBaseObjectXml } from '../../src/utils/baseObjectXml.js';

const noIndex = { getReadDb: () => { throw new Error('no index'); } };
const MENU = '<?xml version="1.0" encoding="utf-8"?>\r\n<AxMenu><Name>ContosoMain</Name></AxMenu>';

describe('findBaseObjectXml — types the index never extracts', () => {
  beforeAll(() => {
    state.root = fs.mkdtempSync(path.join(os.tmpdir(), 'baseobj-unindexed-'));
    // package != model, as for ApplicationSuite\Foundation
    for (const [pkg, model, folder, name] of [
      ['ContosoCore', 'ContosoCore', 'AxClass', 'ContosoHelper'],
      ['ContosoCore', 'ContosoFoundation', 'AxMenu', 'ContosoMain'],
      ['ContosoCore', 'ContosoFoundation', 'AxForm', 'ContosoForm'],
    ]) {
      fs.mkdirSync(path.join(state.root, pkg, model, folder), { recursive: true });
      fs.writeFileSync(path.join(state.root, pkg, model, folder, `${name}.xml`), name === 'ContosoMain' ? MENU : `<${folder}/>`);
    }
  });
  afterAll(() => {
    // Only the directory this suite created — never os.tmpdir() itself.
    if (state.root.includes('baseobj-unindexed-')) fs.rmSync(state.root, { recursive: true, force: true });
  });

  it('finds an AxMenu in any model of any package', async () => {
    expect(await findBaseObjectXml('menu', 'ContosoMain', noIndex)).toBe(MENU);
  });

  it('returns null for a menu that is nowhere', async () => {
    expect(await findBaseObjectXml('menu', 'ContosoMissing', noIndex)).toBeNull();
  });

  it('does not scan for an indexed type', async () => {
    // A form is in the index; a miss there stays a miss rather than a disk crawl.
    expect(await findBaseObjectXml('form', 'ContosoForm', noIndex)).toBeNull();
  });
});
