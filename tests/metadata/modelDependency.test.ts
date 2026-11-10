/**
 * modelDependency — how one model stands to another, from their descriptors.
 *
 * The cross-model guard used to advise "extend it from <workspace model>" for every
 * refused write, including writes into the workspace's own test model. A test model
 * references the workspace model, never the reverse, so that extension cannot
 * compile. This is what lets the guard tell the two cases apart.
 *
 * Fixtures are real directory trees, like modelDescriptor.test.ts.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { modelDependency, parseInternalsVisibleTo } from '../../src/metadata/modelDescriptor';

/** Shipped element order: InternalsVisibleTo sorts before ModuleReferences. */
const descriptorXml = (refs: string[], internals: string[] = []) => `<?xml version="1.0" encoding="utf-8"?>
<AxModelInfo xmlns:i="http://www.w3.org/2001/XMLSchema-instance" xmlns:d2p1="http://schemas.microsoft.com/2003/10/Serialization/Arrays">
${internals.length
    ? `  <InternalsVisibleTo>\n${internals.map(m => `    <d2p1:string>${m}</d2p1:string>`).join('\n')}\n  </InternalsVisibleTo>`
    : '  <InternalsVisibleTo />'}
  <ModuleReferences>
${refs.map(r => `    <d2p1:string>${r}</d2p1:string>`).join('\n')}
  </ModuleReferences>
</AxModelInfo>`;

let root: string;
let emptyRoot: string;

beforeAll(async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'model-dependency-'));
  root = path.join(base, 'Metadata');
  emptyRoot = path.join(base, 'Empty');
  await fs.mkdir(emptyRoot, { recursive: true });
  const write = async (pkg: string, model: string, refs: string[], internals: string[] = []) => {
    const dir = path.join(root, pkg, 'Descriptor');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, `${model}.xml`), descriptorXml(refs, internals), 'utf-8');
  };
  // The workspace model names its test model; the test model builds on it.
  await write('Contoso', 'Contoso', ['ApplicationSuite'], ['ContosoTests']);
  await write('ContosoTests', 'ContosoTests', ['ApplicationSuite', 'Contoso', 'TestEssentials']);
  // A shared core model the workspace model builds on (the guard's original case).
  await write('ContosoCore', 'ContosoCore', ['ApplicationSuite']);
  await write('ContosoSK', 'ContosoSK', ['ApplicationSuite', 'ContosoCore']);
  // A sibling that builds on the workspace model without being its test model.
  await write('ContosoAddOn', 'ContosoAddOn', ['Contoso']);
});

afterAll(async () => {
  await fs.rm(path.dirname(root), { recursive: true, force: true });
});

describe('parseInternalsVisibleTo', () => {
  it('reads the entries of the element and nothing from ModuleReferences', () => {
    expect(parseInternalsVisibleTo(descriptorXml(['ApplicationSuite'], ['ContosoTests', 'ContosoPerf'])))
      .toEqual(['ContosoTests', 'ContosoPerf']);
  });

  it('returns an empty list for a self-closing or absent element', () => {
    expect(parseInternalsVisibleTo(descriptorXml(['ApplicationSuite']))).toEqual([]);
    expect(parseInternalsVisibleTo('<AxModelInfo />')).toEqual([]);
  });
});

describe('modelDependency', () => {
  it('recognises a test model: it builds on the base, and the base names it', () => {
    expect(modelDependency([root], 'ContosoTests', 'Contoso'))
      .toEqual({ buildsOnBase: true, testModelOfBase: true });
  });

  it('recognises a model built on the base that is not its test model', () => {
    expect(modelDependency([root], 'ContosoAddOn', 'Contoso'))
      .toEqual({ buildsOnBase: true, testModelOfBase: false });
  });

  it('says no for a shared model the base builds on, the case extension advice is right for', () => {
    expect(modelDependency([root], 'ContosoCore', 'ContosoSK'))
      .toEqual({ buildsOnBase: false, testModelOfBase: false });
  });

  it('matches model names case-insensitively, as the guard does', () => {
    expect(modelDependency([root], 'contosotests', 'CONTOSO')?.buildsOnBase).toBe(true);
  });

  it('tries the roots in order and skips empty ones', () => {
    expect(modelDependency([null, emptyRoot, root], 'ContosoTests', 'Contoso')?.testModelOfBase).toBe(true);
  });

  it('answers null when no root holds the descriptor, never a guess', () => {
    expect(modelDependency([emptyRoot], 'ContosoTests', 'Contoso')).toBeNull();
    expect(modelDependency([root], 'Fabrikam', 'Contoso')).toBeNull();
  });
});
