/**
 * Concurrent callers of the XPP config (UDE) all wait for the same load.
 *
 * ensureXppConfig() used to set a "loaded" flag before the load finished. A call
 * that arrived while the load was running (a tool call during the bridge setup at
 * startup) returned at once and read the config as missing: getCustomPackagesPath()
 * gave null, so the class lookup searched without the custom metadata folder, and
 * getDevEnvironmentType() said 'traditional' on a UDE machine.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getConfigManager } from '../../src/utils/configManager.js';
import { XppConfigProvider, type XppEnvironmentConfig } from '../../src/utils/xppConfigProvider.js';

const ENV = [
  'DEV_ENVIRONMENT_TYPE',
  'XPP_CONFIG_NAME',
  'D365FO_CUSTOM_PACKAGES_PATH',
  'D365FO_MICROSOFT_PACKAGES_PATH',
  'D365FO_DEV_ENVIRONMENT_TYPE',
];
let saved: Record<string, string | undefined>;

const UDE: XppEnvironmentConfig = {
  configName: 'ContosoUde',
  version: '10.0.2428.63',
  customPackagesPath: 'C:\\Repos\\ContosoExt\\Metadata',
  microsoftPackagesPath: 'C:\\Ude\\ContosoUde\\PackagesLocalDirectory',
  referencePackagesPaths: [],
  fullFilename: 'ContosoUde___10.0.2428.63',
};

/** A fresh ConfigManager whose XPP config has not been loaded yet. */
function makeManager() {
  const ConfigManagerClass = Object.getPrototypeOf(getConfigManager()).constructor;
  const mgr = new ConfigManagerClass('/nonexistent/.mcp.json');
  (mgr as any).config = { servers: { context: {} } };
  (mgr as any).autoDetectionAttempted = true;
  return mgr as ReturnType<typeof getConfigManager>;
}

/** Make getActiveConfig() resolve only when the test says so. */
function deferActiveConfig() {
  let release!: (config: XppEnvironmentConfig | null) => void;
  const pending = new Promise<XppEnvironmentConfig | null>(r => { release = r; });
  const spy = vi.spyOn(XppConfigProvider.prototype, 'getActiveConfig').mockReturnValue(pending);
  return { spy, release };
}

beforeEach(() => {
  saved = Object.fromEntries(ENV.map(k => [k, process.env[k]]));
  for (const k of ENV) delete process.env[k];
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.restoreAllMocks();
});

describe('XPP config load with concurrent callers', () => {
  it('gives every concurrent getCustomPackagesPath() call the path', async () => {
    const { spy, release } = deferActiveConfig();
    const mgr = makeManager();

    const first = mgr.getCustomPackagesPath();
    const second = mgr.getCustomPackagesPath();
    release(UDE);

    expect(await Promise.all([first, second])).toEqual([UDE.customPackagesPath, UDE.customPackagesPath]);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('reports UDE to a getDevEnvironmentType() call made during the load', async () => {
    const { release } = deferActiveConfig();
    const mgr = makeManager();

    // The bridge setup at startup starts the load, then a tool call arrives.
    const bridgeSetup = mgr.getDevEnvironmentType();
    const toolCall = mgr.getDevEnvironmentType();
    const toolPath = mgr.getMicrosoftPackagesPath();
    release(UDE);

    expect(await bridgeSetup).toBe('ude');
    expect(await toolCall).toBe('ude');
    expect(await toolPath).toBe(UDE.microsoftPackagesPath);
  });

  it('loads the config only once', async () => {
    const spy = vi.spyOn(XppConfigProvider.prototype, 'getActiveConfig').mockResolvedValue(UDE);
    const mgr = makeManager();

    await mgr.getActiveXppConfig();
    await mgr.getCustomPackagesPath();
    await mgr.getXrefDbName();

    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('treats a config that cannot be read as missing, for every caller', async () => {
    vi.spyOn(XppConfigProvider.prototype, 'getActiveConfig').mockRejectedValue(new Error('EACCES'));
    const mgr = makeManager();

    const results = await Promise.all([mgr.getCustomPackagesPath(), mgr.getDevEnvironmentType()]);
    expect(results).toEqual([null, 'traditional']);
    expect(await mgr.getActiveXppConfig()).toBeNull();
  });
});
