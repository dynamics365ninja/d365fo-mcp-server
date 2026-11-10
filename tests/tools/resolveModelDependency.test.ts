/**
 * resolveModelDependency — the async step every d365fo_file writer runs before the
 * cross-model guard, so the refusal can tell a test model from a shared model.
 *
 * Covers what the pure guard tests cannot: the packages root taken from the target
 * file's own path, and no descriptor read at all for an ordinary same-model write.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

vi.mock('../../src/utils/configManager.js', () => ({
  getConfigManager: () => ({ getCustomPackagesPath: async () => null, getPackagePath: () => null }),
}));

import { resolveModelDependency } from '../../src/tools/write/modelDependencyResolver';

const descriptorXml = (refs: string[], internals: string[] = []) => `<?xml version="1.0" encoding="utf-8"?>
<AxModelInfo xmlns:d2p1="http://schemas.microsoft.com/2003/10/Serialization/Arrays">
  <InternalsVisibleTo>${internals.map(m => `<d2p1:string>${m}</d2p1:string>`).join('')}</InternalsVisibleTo>
  <ModuleReferences>${refs.map(r => `<d2p1:string>${r}</d2p1:string>`).join('')}</ModuleReferences>
</AxModelInfo>`;

let root: string;

beforeAll(async () => {
  root = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'resolve-dependency-')), 'Metadata');
  for (const [model, refs, internals] of [
    ['Contoso', ['ApplicationSuite'], ['ContosoTests']],
    ['ContosoTests', ['Contoso'], []],
  ] as Array<[string, string[], string[]]>) {
    await fs.mkdir(path.join(root, model, 'Descriptor'), { recursive: true });
    await fs.writeFile(path.join(root, model, 'Descriptor', `${model}.xml`), descriptorXml(refs, internals));
  }
});

afterAll(async () => {
  await fs.rm(path.dirname(root), { recursive: true, force: true });
});

describe('resolveModelDependency', () => {
  it('finds the descriptors through the root in the target file path', async () => {
    const file = path.join(root, 'ContosoTests', 'ContosoTests', 'AxClass', 'ContosoVatReportTest.xml');

    expect(await resolveModelDependency('ContosoTests', 'Contoso', file))
      .toEqual({ buildsOnBase: true, testModelOfBase: true });
  });

  it('reads nothing for a write into the workspace model itself', async () => {
    const file = path.join(root, 'Contoso', 'Contoso', 'AxClass', 'ContosoVatReport.xml');

    expect(await resolveModelDependency('Contoso', 'contoso', file)).toBeNull();
  });

  it('answers null when no root is known, so the guard keeps its usual wording', async () => {
    expect(await resolveModelDependency('ContosoTests', 'Contoso')).toBeNull();
    expect(await resolveModelDependency(null, 'Contoso')).toBeNull();
  });
});
