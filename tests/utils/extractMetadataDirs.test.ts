/**
 * extract-metadata folder resolution tests (extraction progress percentage over 100%)
 *
 * The extraction progress denominator used to be counted from a hand-written list of
 * 9 folders paired with lowercase twins ('AxClass', 'axclass', …), while the extractors
 * walked ~36 folders. That produced two independent bugs:
 *
 *   1. On a case-insensitive filesystem (Windows) both twins resolved to the same
 *      directory, so every folder was counted twice — the denominator came out 2x.
 *   2. Extension/security/menu-item/service folders were extracted but never counted,
 *      so the numerator counted files the denominator did not.
 *
 * Together these read as e.g. "progress 189.66% (110/58 files)".
 *
 * Covers:
 *   - a folder is counted once whether it is PascalCase (AOT/Windows) or lowercase (Linux)
 *   - the denominator spans the folders the extractors actually read, not just base objects
 *   - EXTRACTED_AOT_DIRS is derived from AOT_EXTRACTORS, so the two cannot drift apart
 *
 * Regression guards:
 *   - counting a model with only AxClass MUST yield the file count, not double it
 *   - AxTableExtension files MUST be counted (missing from the original list)
 *   - EXTRACTED_AOT_DIRS MUST NOT contain duplicates (a duplicate double-counts a folder)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  EXTRACTED_AOT_DIRS,
  mapModelDirs,
  countModelXmlFiles,
} from '../../scripts/extract-metadata';

let tmpRoot: string;

/** Build a throwaway model folder: { AxClass: ['A.xml', 'B.xml'] } → real files on disk. */
async function makeModel(name: string, layout: Record<string, string[]>): Promise<string> {
  const modelPath = path.join(tmpRoot, name);
  for (const [dirName, files] of Object.entries(layout)) {
    const dirPath = path.join(modelPath, dirName);
    await fs.mkdir(dirPath, { recursive: true });
    for (const file of files) {
      await fs.writeFile(path.join(dirPath, file), '<AxClass />');
    }
  }
  await fs.mkdir(modelPath, { recursive: true });
  return modelPath;
}

const countModel = async (modelPath: string) => countModelXmlFiles(await mapModelDirs(modelPath));

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'extract-dirs-'));
});

afterAll(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe('EXTRACTED_AOT_DIRS', () => {
  it('lists each folder exactly once', () => {
    const seen = new Set(EXTRACTED_AOT_DIRS.map(d => d.toLowerCase()));
    expect(seen.size).toBe(EXTRACTED_AOT_DIRS.length);
  });

  it('covers the folders that used to be extracted but not counted', () => {
    // The original list held only these 9 base-object folders.
    expect(EXTRACTED_AOT_DIRS).toEqual(expect.arrayContaining([
      'AxClass', 'AxTable', 'AxForm', 'AxQuery', 'AxView',
      'AxDataEntityView', 'AxEnum', 'AxEdt', 'AxReport',
    ]));
    // Everything below incremented the numerator with no matching denominator.
    expect(EXTRACTED_AOT_DIRS).toEqual(expect.arrayContaining([
      'AxTableExtension', 'AxFormExtension', 'AxMapExtension',
      'AxSecurityPrivilege', 'AxSecurityDuty', 'AxSecurityRole',
      'AxMenuItemDisplay', 'AxMenuItemAction', 'AxMenuItemOutput',
      'AxService', 'AxServiceGroup', 'AxMap',
      'AxConfigurationKey', 'AxLicenseCode', 'AxSecurityPolicy', 'AxMacroDictionary',
    ]));
  });

  it('omits AxClassExtension, which the AOT does not have (#693)', () => {
    expect(EXTRACTED_AOT_DIRS).not.toContain('AxClassExtension');
  });
});

describe('mapModelDirs', () => {
  it('keys folders by lowercase name while keeping the real on-disk path', async () => {
    const modelPath = await makeModel('PascalModel', { AxClass: ['A.xml'] });
    const dirs = await mapModelDirs(modelPath);

    expect(dirs.get('axclass')).toBe(path.join(modelPath, 'AxClass'));
  });

  it('resolves a lowercase folder as shipped on case-sensitive filesystems', async () => {
    const modelPath = await makeModel('LowerModel', { axtable: ['T.xml'] });
    const dirs = await mapModelDirs(modelPath);

    // Windows reports the real name it created; Linux keeps 'axtable'. Either way the
    // canonical 'AxTable' lookup must hit exactly one entry.
    expect(dirs.has('axtable')).toBe(true);
  });

  it('ignores files and returns empty for a missing model path', async () => {
    const modelPath = await makeModel('FileModel', { AxClass: ['A.xml'] });
    await fs.writeFile(path.join(modelPath, 'Descriptor.txt'), 'x');

    const dirs = await mapModelDirs(modelPath);
    expect(dirs.has('descriptor.txt')).toBe(false);

    const missing = await mapModelDirs(path.join(tmpRoot, 'DoesNotExist'));
    expect(missing.size).toBe(0);
  });
});

describe('countModelXmlFiles', () => {
  it('counts a folder once rather than twice (the 2x denominator bug)', async () => {
    const modelPath = await makeModel('CountOnce', { AxClass: ['A.xml', 'B.xml'] });

    // Probing 'AxClass' then an 'axclass' twin returned 4 here on Windows.
    expect(await countModel(modelPath)).toBe(2);
  });

  it('counts folders that only the extractors knew about', async () => {
    const modelPath = await makeModel('Extensions', {
      AxClass: ['A.xml'],
      AxTableExtension: ['T1.xml', 'T2.xml'],
      AxSecurityPrivilege: ['P.xml'],
      AxMenuItemDisplay: ['M.xml'],
      AxMacroDictionary: ['Mac.xml'],
    });

    // Was 1 (AxClass only) while extraction reported 6 files processed.
    expect(await countModel(modelPath)).toBe(6);
  });

  it('counts views and data entities as separate folders', async () => {
    const modelPath = await makeModel('Views', {
      AxView: ['V.xml'],
      AxDataEntityView: ['E.xml'],
    });

    expect(await countModel(modelPath)).toBe(2);
  });

  it('ignores non-xml files and folders outside the extracted set', async () => {
    const modelPath = await makeModel('Mixed', {
      AxClass: ['A.xml', 'A.xml.bak', 'readme.md'],
      AxLabelFile: ['L.xml'],       // labels are indexed by build-database, not here
      AxWorkflowTask: ['W.xml'],    // nothing extracts this
    });

    expect(await countModel(modelPath)).toBe(1);
  });

  it('returns 0 for a directory that is not a model', async () => {
    const modelPath = await makeModel('NotAModel', { bin: ['x.xml'] });

    expect(await countModel(modelPath)).toBe(0);
  });
});
