import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import * as os from 'os';

// We'll test the provider after creating it
import { XppConfigProvider } from '../../src/utils/xppConfigProvider.js';

describe('XppConfigProvider', () => {
  let testConfigDir: string;

  beforeEach(async () => {
    testConfigDir = path.join(os.tmpdir(), `xpp-config-test-${Date.now()}`);
    await fs.mkdir(testConfigDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(testConfigDir, { recursive: true, force: true });
  });

  function writeConfig(name: string, config: Record<string, any>) {
    fsSync.writeFileSync(
      path.join(testConfigDir, `${name}.json`),
      JSON.stringify(config),
    );
  }

  describe('listConfigs', () => {
    it('should list available XPP configs sorted by modification time', async () => {
      writeConfig('env-a___10.0.1000.1', {
        ModelStoreFolder: 'C:\\Custom1',
        FrameworkDirectory: 'C:\\Framework1',
      });
      // Small delay so mtime differs
      await new Promise(r => setTimeout(r, 50));
      writeConfig('env-b___10.0.2000.1', {
        ModelStoreFolder: 'C:\\Custom2',
        FrameworkDirectory: 'C:\\Framework2',
      });

      const provider = new XppConfigProvider(testConfigDir);
      const configs = await provider.listConfigs();

      expect(configs.length).toBe(2);
      // Newest first
      expect(configs[0].configName).toBe('env-b');
      expect(configs[0].version).toBe('10.0.2000.1');
      expect(configs[1].configName).toBe('env-a');
    });

    it('should skip non-json files and directories', async () => {
      writeConfig('valid___10.0.1.1', {
        ModelStoreFolder: 'C:\\Custom',
        FrameworkDirectory: 'C:\\Framework',
      });
      // Create a directory with the same naming pattern
      await fs.mkdir(path.join(testConfigDir, 'dir___10.0.1.1'), { recursive: true });

      const provider = new XppConfigProvider(testConfigDir);
      const configs = await provider.listConfigs();

      expect(configs.length).toBe(1);
      expect(configs[0].configName).toBe('valid');
    });
  });

  describe('getActiveConfig', () => {
    it('should auto-select newest config when no name specified', async () => {
      writeConfig('old___10.0.1.1', {
        ModelStoreFolder: 'C:\\OldCustom',
        FrameworkDirectory: 'C:\\OldFramework',
      });
      await new Promise(r => setTimeout(r, 50));
      writeConfig('new___10.0.2.1', {
        ModelStoreFolder: 'C:\\NewCustom',
        FrameworkDirectory: 'C:\\NewFramework',
      });

      const provider = new XppConfigProvider(testConfigDir);
      const config = await provider.getActiveConfig();

      expect(config).not.toBeNull();
      expect(config!.customPackagesPath).toBe('C:\\NewCustom');
      expect(config!.microsoftPackagesPath).toBe('C:\\NewFramework');
    });

    it('should select config by name', async () => {
      writeConfig('env-a___10.0.1.1', {
        ModelStoreFolder: 'C:\\CustomA',
        FrameworkDirectory: 'C:\\FrameworkA',
      });
      writeConfig('env-b___10.0.2.1', {
        ModelStoreFolder: 'C:\\CustomB',
        FrameworkDirectory: 'C:\\FrameworkB',
      });

      const provider = new XppConfigProvider(testConfigDir);
      const config = await provider.getActiveConfig('env-a___10.0.1.1');

      expect(config).not.toBeNull();
      expect(config!.customPackagesPath).toBe('C:\\CustomA');
    });

    it('should return null when no configs exist', async () => {
      const provider = new XppConfigProvider(testConfigDir);
      const config = await provider.getActiveConfig();

      expect(config).toBeNull();
    });

    it('should extract xref database info', async () => {
      writeConfig('env___10.0.1.1', {
        ModelStoreFolder: 'C:\\Custom',
        FrameworkDirectory: 'C:\\Framework',
        CrossReferencesDatabaseName: 'XRef_test',
        CrossReferencesDbServerName: '(LocalDB)\\MSSQLLocalDB',
      });

      const provider = new XppConfigProvider(testConfigDir);
      const config = await provider.getActiveConfig();

      expect(config!.xrefDbName).toBe('XRef_test');
      expect(config!.xrefDbServer).toBe('(LocalDB)\\MSSQLLocalDB');
    });
  });

  describe('parseConfigFilename', () => {
    it('should parse name___version.json pattern', () => {
      const provider = new XppConfigProvider(testConfigDir);
      const result = provider.parseConfigFilename('contoso-dev-env1___10.0.2428.63.json');

      expect(result).not.toBeNull();
      expect(result!.configName).toBe('contoso-dev-env1');
      expect(result!.version).toBe('10.0.2428.63');
    });

    it('should return null for invalid filenames', () => {
      const provider = new XppConfigProvider(testConfigDir);
      expect(provider.parseConfigFilename('invalid.json')).toBeNull();
      expect(provider.parseConfigFilename('no-version.txt')).toBeNull();
    });
  });
});
