import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { PackageResolver } from '../../src/utils/packageResolver.js';

describe('PackageResolver', () => {
  let testRoot: string;

  beforeEach(async () => {
    testRoot = path.join(os.tmpdir(), `pkg-resolver-test-${Date.now()}`);
    await fs.mkdir(testRoot, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(testRoot, { recursive: true, force: true });
  });

  async function createModel(
    packageName: string,
    modelName: string,
    options?: { createAxClass?: boolean },
  ) {
    const modelDir = path.join(testRoot, packageName, modelName);
    const descriptorDir = path.join(testRoot, packageName, 'Descriptor');

    await fs.mkdir(modelDir, { recursive: true });
    await fs.mkdir(descriptorDir, { recursive: true });

    if (options?.createAxClass !== false) {
      await fs.mkdir(path.join(modelDir, 'AxClass'), { recursive: true });
    }

    // Write descriptor XML
    const descriptorXml = `<?xml version="1.0" encoding="utf-8"?>
<AxModelInfo xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
  <ModelModule>${packageName}</ModelModule>
  <Name>${modelName}</Name>
  <DisplayName>${modelName}</DisplayName>
</AxModelInfo>`;

    await fs.writeFile(
      path.join(descriptorDir, `${modelName}.xml`),
      descriptorXml,
    );
  }

  describe('resolve', () => {
    it('should resolve model name to package name via descriptor', async () => {
      await createModel('CustomExtensions', 'Contoso Utilities');
      await createModel('CustomExtensions', 'Contoso Reporting');

      const resolver = new PackageResolver([testRoot]);
      const result = await resolver.resolve('Contoso Utilities');

      expect(result).not.toBeNull();
      expect(result!.packageName).toBe('CustomExtensions');
      expect(result!.rootPath).toBe(testRoot);
    });

    it('should resolve when package name equals model name', async () => {
      await createModel('ContosoRetail', 'ContosoRetail');

      const resolver = new PackageResolver([testRoot]);
      const result = await resolver.resolve('ContosoRetail');

      expect(result).not.toBeNull();
      expect(result!.packageName).toBe('ContosoRetail');
    });

    it('should return null for unknown model', async () => {
      const resolver = new PackageResolver([testRoot]);
      const result = await resolver.resolve('NonExistent');

      expect(result).toBeNull();
    });

    it('should search multiple roots', async () => {
      const secondRoot = path.join(os.tmpdir(), `pkg-resolver-test2-${Date.now()}`);
      await fs.mkdir(secondRoot, { recursive: true });

      await createModel('CustomExtensions', 'Contoso Utilities');

      // Create model in second root
      const msModelDir = path.join(secondRoot, 'ApplicationSuite', 'Foundation');
      const msDescDir = path.join(secondRoot, 'ApplicationSuite', 'Descriptor');
      await fs.mkdir(msModelDir, { recursive: true });
      await fs.mkdir(path.join(msModelDir, 'AxClass'), { recursive: true });
      await fs.mkdir(msDescDir, { recursive: true });
      await fs.writeFile(
        path.join(msDescDir, 'Foundation.xml'),
        `<AxModelInfo><ModelModule>ApplicationSuite</ModelModule><Name>Foundation</Name></AxModelInfo>`,
      );

      const resolver = new PackageResolver([testRoot, secondRoot]);

      const custom = await resolver.resolve('Contoso Utilities');
      expect(custom!.packageName).toBe('CustomExtensions');
      expect(custom!.rootPath).toBe(testRoot);

      const ms = await resolver.resolve('Foundation');
      expect(ms!.packageName).toBe('ApplicationSuite');
      expect(ms!.rootPath).toBe(secondRoot);

      await fs.rm(secondRoot, { recursive: true, force: true });
    });

    it('should use explicit packageName when provided', async () => {
      const resolver = new PackageResolver([testRoot]);
      const result = await resolver.resolveWithPackage('MyModel', 'MyPackage');

      expect(result.packageName).toBe('MyPackage');
    });

    it('should cache results after first scan', async () => {
      await createModel('Pkg', 'Model1');

      const resolver = new PackageResolver([testRoot]);
      const r1 = await resolver.resolve('Model1');
      const r2 = await resolver.resolve('Model1');

      expect(r1).toEqual(r2);
    });
  });

  describe('filesystem fallback', () => {
    it('should find model by scanning directories when no descriptor exists', async () => {
      // Create model directory without descriptor
      const modelDir = path.join(testRoot, 'MyPackage', 'MyModel', 'AxClass');
      await fs.mkdir(modelDir, { recursive: true });

      const resolver = new PackageResolver([testRoot]);
      const result = await resolver.resolve('MyModel');

      expect(result).not.toBeNull();
      expect(result!.packageName).toBe('MyPackage');
    });
  });
});
