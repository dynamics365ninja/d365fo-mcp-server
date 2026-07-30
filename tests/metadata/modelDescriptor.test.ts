/**
 * Descriptor reader + visibility oracle. Fixtures are real directory trees:
 * both the probe order and packageOf() are path-shaped, and a mocked fs would
 * not exercise either.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  parseModuleReferences,
  readModuleReferences,
  packagesRootFromPath,
  buildModelVisibility,
} from '../../src/metadata/modelDescriptor';

const descriptorXml = (refs: string[]) => `<?xml version="1.0" encoding="utf-8"?>
<AxModelInfo xmlns:d2p1="http://schemas.microsoft.com/2003/10/Serialization/Arrays">
  <ModelReferences i:nil="true" xmlns:i="http://www.w3.org/2001/XMLSchema-instance" />
  <ModuleReferences>
${refs.map(r => `    <d2p1:string>${r}</d2p1:string>`).join('\n')}
  </ModuleReferences>
</AxModelInfo>`;

let root: string;

beforeAll(async () => {
  root = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'descriptor-test-')), 'PackagesLocalDirectory');
  const write = async (pkg: string, model: string, refs: string[]) => {
    const dir = path.join(root, pkg, 'Descriptor');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, `${model}.xml`), descriptorXml(refs), 'utf-8');
  };
  await write('Contoso', 'Contoso', ['ApplicationSuite', 'Ledger']);
  // ISV layout: the model lives inside a differently named package.
  await write('IsvPackage', 'IsvModel', ['ApplicationFoundation']);
  await fs.mkdir(path.join(root, 'Tax'), { recursive: true });
});

afterAll(async () => {
  await fs.rm(path.dirname(root), { recursive: true, force: true });
});

describe('parseModuleReferences', () => {
  it('reads every entry and ignores the nil sibling list', () => {
    expect(parseModuleReferences(descriptorXml(['A', 'B', 'C']))).toEqual(['A', 'B', 'C']);
  });

  it('returns an empty list for a descriptor with no references', () => {
    expect(parseModuleReferences('<AxModelInfo />')).toEqual([]);
  });
});

describe('readModuleReferences', () => {
  it('reads a model whose package shares its name', async () => {
    expect(await readModuleReferences(root, 'Contoso')).toEqual(['ApplicationSuite', 'Ledger']);
  });

  // Null is "unknown", never "references nothing" — callers must not treat a
  // missing descriptor as an empty reference set.
  it('returns null when there is no descriptor', async () => {
    expect(await readModuleReferences(root, 'NoSuchModel')).toBeNull();
  });
});

describe('packagesRootFromPath', () => {
  it('extracts the root from a package or workspace path', () => {
    expect(packagesRootFromPath('K:\\AosService\\PackagesLocalDirectory'))
      .toBe('K:\\AosService\\PackagesLocalDirectory');
    expect(packagesRootFromPath('K:\\AosService\\PackagesLocalDirectory\\Contoso\\Contoso'))
      .toBe('K:\\AosService\\PackagesLocalDirectory');
    expect(packagesRootFromPath('K:/AosService/PackagesLocalDirectory/Contoso'))
      .toBe('K:\\AosService\\PackagesLocalDirectory');
  });

  it('returns null for a path that is not under a packages root', () => {
    expect(packagesRootFromPath('K:\\repos\\d365fo-mcp-server')).toBeNull();
    expect(packagesRootFromPath(undefined)).toBeNull();
  });
});

describe('buildModelVisibility', () => {
  it('includes the model\'s own package plus its direct references', () => {
    const vis = buildModelVisibility(root, 'Contoso')!;
    expect(vis.model).toBe('Contoso');
    expect([...vis.visiblePackages].sort()).toEqual(['applicationsuite', 'contoso', 'ledger']);
  });

  // References are NOT followed transitively: ApplicationSuite references Tax,
  // and closing over that would mark Tax visible and hide the defect the oracle
  // exists to catch.
  it('does not close over the reference graph', () => {
    expect(buildModelVisibility(root, 'Contoso')!.visiblePackages.has('tax')).toBe(false);
  });

  it('finds a model inside a differently named package', () => {
    const vis = buildModelVisibility(root, 'IsvModel')!;
    expect([...vis.visiblePackages].sort()).toEqual(['applicationfoundation', 'isvpackage']);
  });

  it('returns null rather than guessing', () => {
    expect(buildModelVisibility(root, 'NoSuchModel')).toBeNull();
    expect(buildModelVisibility(null, 'Contoso')).toBeNull();
    expect(buildModelVisibility(root, undefined)).toBeNull();
  });

  describe('packageOf', () => {
    // The index records the root as the scanner saw it while config supplies its
    // own casing; both name the same directory.
    it('is case-insensitive about the root and separator-agnostic', () => {
      const vis = buildModelVisibility(root, 'Contoso')!;
      expect(vis.packageOf(path.join(root, 'Tax', 'AxEdt', 'TaxAmountCur.xml'))).toBe('Tax');
      expect(vis.packageOf(path.join(root.toUpperCase(), 'Tax', 'AxEdt', 'X.xml'))).toBe('Tax');
      expect(vis.packageOf(`${root.replace(/\\/g, '/')}/Tax/AxEdt/X.xml`)).toBe('Tax');
    });

    it('returns null for a path outside the packages root', () => {
      const vis = buildModelVisibility(root, 'Contoso')!;
      expect(vis.packageOf('K:\\src\\Elsewhere.xml')).toBeNull();
      expect(vis.packageOf('')).toBeNull();
    });
  });
});
