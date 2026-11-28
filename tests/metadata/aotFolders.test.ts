/**
 * One objectType → Ax* folder map for the create tool, the project registration
 * and the on-disk lookup.
 *
 * The lookup used to keep its own, shorter copy. A security policy, configuration
 * key, license code, macro, tile, KPI, service or service group that create had
 * just written was then "no such file on disk" for `project add-object`.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AOT_FOLDER_BY_OBJECT_TYPE, aotFolderFor } from '../../src/metadata/aotFolders';
import { d365foFileTool } from '../../src/server/toolSchemas/d365foFile';
import { findD365FileOnDisk, expectedD365FilePath } from '../../src/utils/objectFileLookup';
import { axFolderForObjectType, hasAxFolder } from '../../src/workspace/projectMembership';

/** Types create accepts that do not live in an Ax* folder inside the model folder. */
const NO_AX_FOLDER = new Set(['model-descriptor']);

const createObjectTypes: string[] =
  (d365foFileTool.inputSchema.properties.objectType as { enum: string[] }).enum;

describe('AOT_FOLDER_BY_OBJECT_TYPE', () => {
  it('has a folder for every objectType d365fo_file(create) accepts', () => {
    const missing = createObjectTypes.filter(t => !NO_AX_FOLDER.has(t) && !aotFolderFor(t));
    expect(missing).toEqual([]);
  });

  it('has no entry create cannot produce', () => {
    const extra = Object.keys(AOT_FOLDER_BY_OBJECT_TYPE).filter(t => !createObjectTypes.includes(t));
    expect(extra).toEqual([]);
  });

  it('answers undefined, not a prototype member, for an unknown type', () => {
    expect(aotFolderFor('toString')).toBeUndefined();
    expect(aotFolderFor('model-descriptor')).toBeUndefined();
  });

  it('is the map the project registration uses', () => {
    for (const [type, folder] of Object.entries(AOT_FOLDER_BY_OBJECT_TYPE)) {
      expect(axFolderForObjectType(type)).toBe(folder);
      expect(hasAxFolder(type)).toBe(true);
    }
    expect(hasAxFolder('model-descriptor')).toBe(false);
  });
});

describe('findD365FileOnDisk for the types the lookup used to miss', () => {
  const cases: Array<[string, string, string]> = [
    ['security-policy', 'AxSecurityPolicy', 'ContosoRentalPolicy'],
    ['configuration-key', 'AxConfigurationKey', 'ContosoRental'],
    ['license-code', 'AxLicenseCode', 'ContosoRentalLicense'],
    ['aggregate-measurement', 'AxAggregateMeasurement', 'ContosoRentalMeasure'],
    ['macro', 'AxMacroDictionary', 'ContosoRentalMacros'],
    ['service', 'AxService', 'ContosoRentalService'],
    ['service-group', 'AxServiceGroup', 'ContosoRentalServices'],
    ['tile', 'AxTile', 'ContosoRentalTile'],
    ['kpi', 'AxKPI', 'ContosoRentalKpi'],
  ];

  it.each(cases)('finds a %s in %s', async (objectType, folder, name) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aot-folders-'));
    try {
      const dir = path.join(root, 'ContosoExt', 'ContosoExt', folder);
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${name}.xml`);
      fs.writeFileSync(file, '<?xml version="1.0" encoding="utf-8"?><Ax/>');

      await expect(findD365FileOnDisk(objectType, name, 'ContosoExt', root)).resolves.toBe(file);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('builds the expected path with the same folder', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aot-folders-'));
    try {
      const expected = await expectedD365FilePath('security-policy', 'ContosoRentalPolicy', 'ContosoExt', root);
      expect(expected).toContain(`${path.sep}AxSecurityPolicy${path.sep}ContosoRentalPolicy.xml`);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
