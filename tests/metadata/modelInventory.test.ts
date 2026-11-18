/**
 * Descriptor authoring and the questions asked across descriptors.
 *
 * The properties here are the ones a wrong answer hides: an Id that collides is
 * accepted by every tool until two models meet in one environment, a reference
 * cycle is a build that cannot start, and a descriptor Visual Studio would
 * rewrite on the next save turns one intended change into two diffs.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  buildDescriptorXml, parseDescriptor, scanDescriptors, findModel, dependentsOfPackage,
  findReferenceCycles, unresolvedReferences, allocateModelId, layerNumber, describeLayer,
  parseVersion, modelNameProblem, setDescriptorProperty, packageMates,
  MODEL_ID_MIN, MODEL_ID_MAX,
} from '../../src/metadata/modelInventory';
import { addModuleReference, parseModuleReferences } from '../../src/metadata/modelDescriptor';

const spec = {
  name: 'ContosoExt', displayName: 'Contoso extensions', description: 'R&D <demo>', id: 895000123, layer: 12,
  publisher: 'Contoso', modelModule: 'ContosoExt', version: { major: 1, minor: 2, build: 3, revision: 4 },
  moduleReferences: ['Ledger', 'ApplicationPlatform', 'ApplicationSuite'],
};

describe('buildDescriptorXml', () => {
  const xml = buildDescriptorXml(spec);

  it('round-trips through the reader', () => {
    expect(parseDescriptor(xml)).toEqual({
      name: 'ContosoExt', displayName: 'Contoso extensions', description: 'R&D <demo>', id: 895000123, layer: 12,
      publisher: 'Contoso', modelModule: 'ContosoExt', customization: 'Allow',
      version: { major: 1, minor: 2, build: 3, revision: 4 },
      moduleReferences: ['ApplicationPlatform', 'ApplicationSuite', 'Ledger'],
    });
  });

  it('writes elements in the serializer\'s alphabetical order', () => {
    const tags = Array.from(xml.matchAll(/\n {2}<([A-Za-z]+)/g)).map(m => m[1]);
    expect(tags).toEqual([...tags].sort());
    expect(tags).toContain('ModelModule');
  });

  it('escapes text and declares the arrays namespace where the entries use it', () => {
    expect(xml).toContain('<Description>R&amp;D &lt;demo&gt;</Description>');
    expect(xml).toMatch(/<ModuleReferences xmlns:d2p1="[^"]+">\n {4}<d2p1:string>ApplicationPlatform</);
  });

  it('writes an empty reference list the way a model that references nothing ships it', () => {
    const empty = buildDescriptorXml({ ...spec, moduleReferences: [] });
    expect(empty).toMatch(/<ModuleReferences xmlns:d2p1="[^"]+" \/>/);
    expect(parseModuleReferences(empty)).toEqual([]);
    // ...and the existing writer can add to it, so a created model is editable.
    const added = addModuleReference(empty, 'Ledger');
    expect(added.kind).toBe('added');
  });
});

describe('layers, versions and names', () => {
  it('maps layer names and numbers both ways', () => {
    expect(layerNumber('usr')).toBe(14);
    expect(layerNumber('CUS')).toBe(12);
    expect(layerNumber(8)).toBe(8);
    expect(layerNumber('10')).toBe(10);
    expect(layerNumber('custom')).toBeNull();
    expect(layerNumber(16)).toBeNull();
    expect(describeLayer(8)).toBe('isv (8)');
  });

  it('parses dotted versions and rejects anything else', () => {
    expect(parseVersion('2.1')).toEqual({ major: 2, minor: 1, build: 0, revision: 0 });
    expect(parseVersion('1.0.0.0.0')).toBeNull();
    expect(parseVersion('v1')).toBeNull();
  });

  it('holds a model name to what a folder, a file and an assembly name accept', () => {
    expect(modelNameProblem('ContosoExt')).toBeNull();
    expect(modelNameProblem('Contoso_Ext2')).toBeNull();
    for (const bad of ['', '2Contoso', 'Contoso Ext', 'Contoso-Ext', '..\\Contoso', 'Contoso.Ext']) {
      expect(modelNameProblem(bad), bad).not.toBeNull();
    }
  });
});

describe('allocateModelId', () => {
  it('stays in the custom band and never returns a used Id', () => {
    const used = [MODEL_ID_MIN, MODEL_ID_MIN + 1];
    // A source that keeps proposing the first (used) Id forces the fallback scan.
    expect(allocateModelId(used, () => 0)).toBe(MODEL_ID_MIN + 2);
    const id = allocateModelId([], () => 0.5);
    expect(id).toBeGreaterThanOrEqual(MODEL_ID_MIN);
    expect(id).toBeLessThanOrEqual(MODEL_ID_MAX);
  });
});

describe('setDescriptorProperty', () => {
  const xml = buildDescriptorXml(spec);

  it('changes one scalar and leaves the rest of the document alone', () => {
    const out = setDescriptorProperty(xml, 'description', 'New text');
    expect(out.kind).toBe('changed');
    if (out.kind !== 'changed') return;
    expect(out.changes).toEqual([{ element: 'Description', from: 'R&D <demo>', to: 'New text' }]);
    expect(out.xml.replace('<Description>New text</Description>', '<Description>R&amp;D &lt;demo&gt;</Description>')).toBe(xml);
  });

  it('takes a dotted Version and a layer by name', () => {
    const v = setDescriptorProperty(xml, 'Version', '2.0.1');
    expect(v.kind === 'changed' && parseDescriptor(v.xml)!.version).toEqual({ major: 2, minor: 0, build: 1, revision: 0 });
    const l = setDescriptorProperty(xml, 'Layer', 'usr');
    expect(l.kind === 'changed' && parseDescriptor(l.xml)!.layer).toBe(14);
  });

  it('reports an unchanged value instead of rewriting the file', () => {
    expect(setDescriptorProperty(xml, 'Publisher', 'Contoso').kind).toBe('unchanged');
  });

  it('refuses the identity of a model, and unknown properties', () => {
    for (const p of ['Name', 'ModelModule', 'Id', 'ModuleReferences', 'Nonsense']) {
      expect(setDescriptorProperty(xml, p, 'x').kind, p).toBe('refused');
    }
    expect(setDescriptorProperty(xml, 'Layer', 'nope').kind).toBe('refused');
    expect(setDescriptorProperty(xml, 'VersionMajor', '-1').kind).toBe('refused');
  });

  it('inserts an element a sparse descriptor lacks, in alphabetical position', () => {
    const sparse =
      `<?xml version="1.0" encoding="utf-8"?>\n<AxModelInfo xmlns:i="x">\n  <DisplayName>C</DisplayName>\n` +
      `  <Id>7</Id>\n  <Layer>12</Layer>\n  <Name>ContosoExt</Name>\n  <Publisher>Contoso</Publisher>\n</AxModelInfo>`;
    const out = setDescriptorProperty(sparse, 'Description', 'Added');
    expect(out.kind).toBe('changed');
    if (out.kind !== 'changed') return;
    expect(out.xml).toContain('<AxModelInfo xmlns:i="x">\n  <Description>Added</Description>\n  <DisplayName>');
  });
});

describe('scanDescriptors and the graph questions', () => {
  let root: string;
  let msRoot: string;

  async function model(base: string, pkg: string, name: string, refs: string[], id: number, extra: Partial<typeof spec> = {}) {
    const dir = path.join(base, pkg, 'Descriptor');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, `${name}.xml`),
      '﻿' + buildDescriptorXml({ ...spec, ...extra, name, modelModule: pkg, id, moduleReferences: refs }).replace(/\n/g, '\r\n'),
      'utf-8',
    );
  }

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'model-inventory-'));
    msRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'model-inventory-ms-'));
    await model(msRoot, 'ApplicationPlatform', 'ApplicationPlatform', [], 400, { layer: 0, publisher: 'Microsoft Corporation' });
    await model(root, 'ContosoCore', 'ContosoCore', ['ApplicationPlatform'], 895000001);
    await model(root, 'ContosoCore', 'ContosoCoreTests', ['ApplicationPlatform'], 895000002);
    await model(root, 'ContosoExt', 'ContosoExt', ['ApplicationPlatform', 'ContosoCore', 'Missing'], 895000003);
    // A binary-only package: a folder with no Descriptor is still a reference target.
    await fs.mkdir(path.join(root, 'BinaryOnly', 'bin'), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(msRoot, { recursive: true, force: true });
  });

  it('reads every descriptor once, across roots, BOM and CRLF included', () => {
    const inv = scanDescriptors([root, msRoot, root]);
    expect(inv.models.map(m => m.name).sort()).toEqual(['ApplicationPlatform', 'ContosoCore', 'ContosoCoreTests', 'ContosoExt']);
    expect(inv.roots).toHaveLength(2);
    const ext = findModel(inv, 'contosoext')!;
    expect(ext.packageName).toBe('ContosoExt');
    expect(ext.modelFolder).toBe(path.join(root, 'ContosoExt', 'ContosoExt'));
    expect(inv.packages.get('binaryonly')).toBe('BinaryOnly');
  });

  it('answers who references a package, and who shares it', () => {
    const inv = scanDescriptors([root, msRoot]);
    expect(dependentsOfPackage(inv, 'ContosoCore').map(m => m.name)).toEqual(['ContosoExt']);
    expect(dependentsOfPackage(inv, 'ContosoExt')).toEqual([]);
    expect(packageMates(inv, findModel(inv, 'ContosoCore')!).map(m => m.name)).toEqual(['ContosoCoreTests']);
  });

  it('reports references that resolve to no package folder', () => {
    const inv = scanDescriptors([root, msRoot]);
    expect(unresolvedReferences(inv, findModel(inv, 'ContosoExt')!.moduleReferences)).toEqual(['Missing']);
    expect(unresolvedReferences(inv, ['BinaryOnly', 'applicationplatform'])).toEqual([]);
  });

  it('finds a reference cycle, including one a pending write would close', async () => {
    const inv = scanDescriptors([root, msRoot]);
    expect(findReferenceCycles(inv)).toEqual([]);
    const closing = findReferenceCycles(inv, { packageName: 'ContosoCore', references: ['ContosoExt'] });
    expect(closing).toHaveLength(1);
    expect(closing[0][0]).toBe(closing[0][closing[0].length - 1]);
    expect(new Set(closing[0])).toEqual(new Set(['ContosoCore', 'ContosoExt']));
  });
});
