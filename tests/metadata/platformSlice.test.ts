/**
 * Cutting the referenced part out of a PackagesLocalDirectory, on a synthetic one (Contoso names).
 */
import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { collectTokens, indexPld, slicePld } from '../../src/metadata/platformSlice';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'platform-slice-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

const pld = path.join(tmp, 'PLD');
const ax = (pkg: string, model: string, folder: string, name: string, body = ''): void =>
  write(path.join(pld, pkg, model, folder, `${name}.xml`), `<${folder}><Name>${name}</Name>${body}</${folder}>`);

// A base class chain, a table with an EDT and an enum field, and objects nobody refers to.
ax(
  'ContosoFoundation',
  'ContosoFoundation',
  'AxClass',
  'ContosoBase',
  '<SourceCode><Declaration><![CDATA[class ContosoBase extends ContosoRoot {}]]></Declaration></SourceCode>',
);
ax('ContosoFoundation', 'ContosoFoundation', 'AxClass', 'ContosoRoot');
ax('ContosoFoundation', 'ContosoFoundation', 'AxClass', 'ContosoUnrelated');
ax(
  'ContosoSuite',
  'ContosoSuite',
  'AxTable',
  'ContosoTable',
  '<Fields><AxTableField><ExtendedDataType>ContosoCode</ExtendedDataType></AxTableField><AxTableField><EnumType>ContosoMode</EnumType></AxTableField></Fields>',
);
ax('ContosoSuite', 'ContosoSuite', 'AxEdt', 'ContosoCode', '<Extends>ContosoBaseCode</Extends>');
ax('ContosoSuite', 'ContosoSuite', 'AxEdt', 'ContosoBaseCode');
ax('ContosoSuite', 'ContosoSuite', 'AxEnum', 'ContosoMode');
ax('ContosoSuite', 'ContosoSuite', 'AxEnum', 'ContosoOtherEnum');
// Our own model sits in the PLD of a dev box too; it must never be cut out as a "dependency".
ax('ContosoApp', 'ContosoApp', 'AxClass', 'ContosoOurs');

const oursDir = path.join(tmp, 'ours');
write(
  path.join(oursDir, 'ContosoApp', 'classes', 'ContosoOurs.json'),
  JSON.stringify({
    name: 'ContosoOurs',
    extends: 'ContosoBase',
    methods: [{ source: 'ContosoTable t; ContosoOurs x;' }],
  }),
);

describe('indexPld', () => {
  it('maps object names to their model, without the models asked to skip', () => {
    const index = indexPld(pld, new Set(['contosoapp']));
    expect(index.get('contosobase')).toMatchObject({ model: 'ContosoFoundation', folder: 'AxClass' });
    expect(index.get('contosocode')).toMatchObject({ model: 'ContosoSuite', folder: 'AxEdt' });
    expect(index.has('contosoours')).toBe(false);
  });
});

describe('collectTokens', () => {
  it('collects the identifiers of our extracted JSON, lower case', () => {
    const t = collectTokens(oursDir, ['ContosoApp']);
    expect(t.has('contosotable')).toBe(true);
    expect(t.has('contosobase')).toBe(true);
    expect(t.has('contosounrelated')).toBe(false);
  });
});

describe('slicePld', () => {
  it('copies what our code names and what those inherit from or are typed with, nothing else', () => {
    const out = path.join(tmp, 'slice');
    const r = slicePld(pld, collectTokens(oursDir, ['ContosoApp']), out, new Set(['contosoapp']));
    const copied = (pkg: string, folder: string): string[] =>
      fs.existsSync(path.join(out, pkg, pkg, folder)) ? fs.readdirSync(path.join(out, pkg, pkg, folder)).sort() : [];
    // named directly: ContosoBase, ContosoTable. Followed: ContosoRoot (extends), ContosoCode and ContosoMode (field types), ContosoBaseCode (EDT extends).
    expect(copied('ContosoFoundation', 'AxClass')).toEqual(['ContosoBase.xml', 'ContosoRoot.xml']);
    expect(copied('ContosoSuite', 'AxTable')).toEqual(['ContosoTable.xml']);
    expect(copied('ContosoSuite', 'AxEdt')).toEqual(['ContosoBaseCode.xml', 'ContosoCode.xml']);
    expect(copied('ContosoSuite', 'AxEnum')).toEqual(['ContosoMode.xml']);
    expect(r.models).toEqual(['ContosoFoundation', 'ContosoSuite']);
    expect(r.files).toBe(6);
    expect(r.matched).toBe(2);
    expect(fs.existsSync(path.join(out, 'ContosoApp'))).toBe(false);
  });
});
