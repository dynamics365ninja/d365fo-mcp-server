/**
 * get_object_info(include="xml") on an object the index holds but no file backs.
 *
 * A binary ISV model ships compiled only: its objects are indexed under a
 * binary-isv:// marker and have no XML anywhere. The reader used to answer "the index
 * has it in <model> — retry with options.modelName", and the retry then said no model
 * holds the object at all. A binary object now gets its own answer, and a stale row in
 * the very model asked for is no longer reported as "no model holds it".
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';

// A remap onto a configured packages root would make a file "reachable" on a dev box.
vi.mock('../../src/utils/metadataResolver', async (orig) => ({
  ...(await orig<typeof import('../../src/utils/metadataResolver')>()),
  resolveDbPathLocally: async () => null,
  remapDbPathLocally: async () => null,
}));

// The configured model's folder is probed first; keep the test off the developer's config.
vi.mock('../../src/utils/objectFileLookup', async (orig) => ({
  ...(await orig<typeof import('../../src/utils/objectFileLookup')>()),
  findD365FileOnDisk: async () => null,
}));

import { XppSymbolIndex } from '../../src/metadata/symbolIndex';
import { objectXmlNotFound, readObjectXml } from '../../src/tools/readers/objectXml';

const BINARY_MODEL = 'ContosoCore';
const SOURCE_MODEL = 'ContosoExt';
const CLASS_PATH = `binary-isv://${BINARY_MODEL}/AxClass/ContosoRentEquipmentJob`;
const TABLE_PATH = `binary-isv://${BINARY_MODEL}/AxTable/ContosoRentEquipmentTable`;

let root: string;
let realFile: string;
let index: XppSymbolIndex;

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'objxml-binary-'));
  realFile = path.join(root, 'ContosoRentEquipmentHelper.xml');
  await writeFile(realFile, '<?xml version="1.0" encoding="utf-8"?>\n<AxClass>\n\t<Name>ContosoRentEquipmentHelper</Name>\n</AxClass>', 'utf-8');
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

beforeEach(() => {
  index = new XppSymbolIndex(':memory:', ':memory:');
  const add = (name: string, type: string, filePath: string, model: string) =>
    index.addSymbol({ name, type, filePath, model } as any);
  add('ContosoRentEquipmentJob', 'class', CLASS_PATH, BINARY_MODEL);
  add('ContosoRentEquipmentTable', 'table', TABLE_PATH, BINARY_MODEL);
  add('ContosoRentEquipmentHelper', 'class', realFile, SOURCE_MODEL);
  add('ContosoRentEquipmentStale', 'class', path.join(root, 'gone', 'ContosoRentEquipmentStale.xml'), SOURCE_MODEL);
});
afterEach(() => index.close());

const expectBinaryAnswer = (text: string, objectType: string, name: string, filePath: string) => {
  expect(text).toContain(`${objectType} "${name}" is in the binary ISV model "${BINARY_MODEL}"`);
  expect(text).toContain('no XML or X++ source exists');
  expect(text).toContain('get_object_info without include:"xml" gives its signatures');
  expect(text).toContain(filePath);
  // No retry hint, and not the false "no model holds it".
  expect(text).not.toContain('retry with');
  expect(text).not.toContain('No model in the symbol index');
};

describe('include="xml" on a binary ISV object', () => {
  it('a class: says it is compiled only, without and with modelName', async () => {
    for (const modelName of [undefined, BINARY_MODEL]) {
      const res = await readObjectXml('class', 'ContosoRentEquipmentJob', { index, modelName });
      expect(res.isError).toBe(true);
      expectBinaryAnswer(res.text, 'class', 'ContosoRentEquipmentJob', CLASS_PATH);
    }
  });

  it('a table: the same, and modelName matches case-insensitively', async () => {
    for (const modelName of [undefined, BINARY_MODEL, BINARY_MODEL.toLowerCase()]) {
      const res = await readObjectXml('table', 'ContosoRentEquipmentTable', { index, modelName });
      expect(res.isError).toBe(true);
      expectBinaryAnswer(res.text, 'table', 'ContosoRentEquipmentTable', TABLE_PATH);
    }
  });

  it('another modelName still points at the binary model, whose retry then answers', async () => {
    const res = await readObjectXml('class', 'ContosoRentEquipmentJob', { index, modelName: SOURCE_MODEL });
    expect(res.isError).toBe(true);
    expect(res.text).toContain(`options.modelName="${BINARY_MODEL}"`);
    expect(res.text).not.toContain('binary ISV');
  });
});

describe('include="xml" on an object with no file', () => {
  it('a stale row in the model asked for is not "no model holds it"', async () => {
    const res = await readObjectXml('class', 'ContosoRentEquipmentStale', { index, modelName: SOURCE_MODEL });
    expect(res.isError).toBe(true);
    expect(res.text).toContain(`The index lists it in model "${SOURCE_MODEL}", but its file is not on disk`);
    expect(res.text).toContain('stale');
    expect(res.text).not.toContain('No model in the symbol index');
    expect(res.text).not.toContain('retry with options.modelName');
  });

  it('objectXmlNotFound: elsewhere = [modelName] gives the stale-row text', () => {
    const res = objectXmlNotFound('class', 'ContosoRentEquipmentStale', SOURCE_MODEL, [SOURCE_MODEL]);
    expect(res.text).toContain(`The index lists it in model "${SOURCE_MODEL}"`);
    expect(res.text).toContain('database');
    expect(res.text).not.toContain('No model in the symbol index');
  });

  it('objectXmlNotFound: elsewhere = [] keeps the "no model holds it" text', () => {
    const res = objectXmlNotFound('class', 'ContosoNoSuchClass', SOURCE_MODEL, []);
    expect(res.text).toBe(
      `❌ get_object_info(include="xml"): no file on disk for class "ContosoNoSuchClass" in model "${SOURCE_MODEL}".\n` +
      'No model in the symbol index holds a class of that name, so retrying with a different ' +
      'options.modelName will not help — check the spelling and the objectType, or the object ' +
      'does not exist yet.',
    );
  });

  it('an object nobody holds keeps the "no model holds it" text', async () => {
    const res = await readObjectXml('class', 'ContosoNoSuchClass', { index, modelName: SOURCE_MODEL });
    expect(res.isError).toBe(true);
    expect(res.text).toContain('No model in the symbol index holds a class of that name');
  });
});

describe('include="xml" on an object with a file', () => {
  it('is unchanged: renders the file, without and with modelName', async () => {
    for (const modelName of [undefined, SOURCE_MODEL]) {
      const res = await readObjectXml('class', 'ContosoRentEquipmentHelper', { index, modelName });
      expect(res.isError).toBe(false);
      expect(res.text).toContain(`**File:** ${realFile}`);
      expect(res.text).toContain('<Name>ContosoRentEquipmentHelper</Name>');
    }
  });
});
