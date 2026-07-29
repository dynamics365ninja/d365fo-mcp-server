/**
 * ConfigManager Tests
 * Covers: path resolution (one-level and two-level workspacePath),
 *         model name extraction, package name extraction,
 *         UDE path resolution, McpContext merging.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getConfigManager, fallbackPackagePath, extractModelFromFilePath } from '../../src/utils/configManager';
import { resetPackagesRootCache } from '../../src/utils/packagesRoot';

// Prevent real file I/O during unit tests
vi.mock('fs/promises', () => ({
  readFile: vi.fn(async () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); }),
}));
vi.mock('fs', async (orig) => {
  const actual = await orig<typeof import('fs')>();
  return { ...actual, existsSync: vi.fn(() => false), realpathSync: vi.fn((p: string) => p) };
});

// ─── Env-var isolation ───────────────────────────────────────────────────────
// The test setup loads the repo's .env file (via dotenv/config). On developer
// machines .env may contain D365FO_PACKAGE_PATH (and friends) which getContext()
// reads as higher-priority than file config, causing every path assertion to
// receive the real machine path instead of the configured test value.
const D365FO_ENV_KEYS = [
  'D365FO_PACKAGE_PATH',
  'D365FO_WORKSPACE_PATH',
  'D365FO_MODEL_NAME',
  'D365FO_CUSTOM_PACKAGES_PATH',
  'D365FO_MICROSOFT_PACKAGES_PATH',
  'D365FO_PROJECT_PATH',
  'D365FO_SOLUTION_PATH',
  'D365FO_DEV_ENVIRONMENT_TYPE',
  'D365FO_BRIDGE_LOG_FILE',
] as const;

let savedEnv: Partial<Record<string, string>> = {};
beforeEach(() => {
  savedEnv = {};
  for (const key of D365FO_ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});
afterEach(() => {
  for (const key of D365FO_ENV_KEYS) {
    if (savedEnv[key] !== undefined) {
      process.env[key] = savedEnv[key];
    } else {
      delete process.env[key];
    }
  }
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Re-create a fresh ConfigManager for each test (bypasses singleton). */
function makeManager(context: Record<string, string | undefined> = {}) {
  // Get ConfigManager class from the singleton's prototype
  const existing = getConfigManager();
  const ConfigManagerClass = Object.getPrototypeOf(existing).constructor;
  const mgr = new ConfigManagerClass('/nonexistent/.mcp.json');
  // Inject config directly, bypassing file load
  (mgr as any).config = { servers: { context } };
  // Prevent auto-detection and XPP config loading side effects
  (mgr as any).autoDetectionAttempted = true;
  (mgr as any).xppConfigLoaded = true;
  (mgr as any).xppConfig = null;
  return mgr as ReturnType<typeof getConfigManager>;
}

// ─── workspacePath — one-level (legacy) ──────────────────────────────────────

describe('one-level workspacePath (legacy PackagesLocalDirectory\\ModelName)', () => {
  it('extracts packagePath correctly', () => {
    const mgr = makeManager({
      workspacePath: 'K:\\AosService\\PackagesLocalDirectory\\MyModel',
    });
    expect(mgr.getPackagePath()).toBe('K:\\AosService\\PackagesLocalDirectory');
  });

  it('extracts modelName as the last segment', () => {
    const mgr = makeManager({
      workspacePath: 'K:\\AosService\\PackagesLocalDirectory\\MyModel',
    });
    expect(mgr.getModelName()).toBe('MyModel');
  });

  it('returns null for packageName (only one segment after PackagesLocalDirectory)', () => {
    const mgr = makeManager({
      workspacePath: 'K:\\AosService\\PackagesLocalDirectory\\MyModel',
    });
    expect(mgr.getPackageNameFromWorkspacePath()).toBeNull();
  });
});

// ─── workspacePath — two-level (new format) ───────────────────────────────────

describe('two-level workspacePath (PackagesLocalDirectory\\PackageName\\ModelName)', () => {
  it('extracts packagePath correctly (everything up to PackagesLocalDirectory)', () => {
    const mgr = makeManager({
      workspacePath: 'K:\\AosService\\PackagesLocalDirectory\\MyPackage\\MyModel',
    });
    expect(mgr.getPackagePath()).toBe('K:\\AosService\\PackagesLocalDirectory');
  });

  it('extracts modelName as the last segment', () => {
    const mgr = makeManager({
      workspacePath: 'K:\\AosService\\PackagesLocalDirectory\\MyPackage\\MyModel',
    });
    expect(mgr.getModelName()).toBe('MyModel');
  });

  it('extracts packageName as the second-to-last segment', () => {
    const mgr = makeManager({
      workspacePath: 'K:\\AosService\\PackagesLocalDirectory\\MyPackage\\MyModel',
    });
    expect(mgr.getPackageNameFromWorkspacePath()).toBe('MyPackage');
  });

  it('handles trailing backslash gracefully', () => {
    const mgr = makeManager({
      workspacePath: 'K:\\AosService\\PackagesLocalDirectory\\MyPackage\\MyModel\\',
    });
    expect(mgr.getModelName()).toBe('MyModel');
    expect(mgr.getPackageNameFromWorkspacePath()).toBe('MyPackage');
  });

  it('works with forward slashes (cross-platform paths)', () => {
    const mgr = makeManager({
      workspacePath: 'K:/AosService/PackagesLocalDirectory/MyPackage/MyModel',
    });
    expect(mgr.getPackagePath()).toBe('K:\\AosService\\PackagesLocalDirectory');
    expect(mgr.getModelName()).toBe('MyModel');
    expect(mgr.getPackageNameFromWorkspacePath()).toBe('MyPackage');
  });

  it('is case-insensitive for PackagesLocalDirectory', () => {
    const mgr = makeManager({
      workspacePath: 'K:\\aosservice\\packageslocalDIRECTORY\\MyPackage\\MyModel',
    });
    expect(mgr.getPackagePath()).toBe('K:\\aosservice\\packageslocalDIRECTORY');
    expect(mgr.getModelName()).toBe('MyModel');
    expect(mgr.getPackageNameFromWorkspacePath()).toBe('MyPackage');
  });
});

// ─── Explicit overrides ───────────────────────────────────────────────────────

describe('explicit packagePath overrides workspacePath extraction', () => {
  it('returns explicit packagePath even when workspacePath is set', () => {
    const mgr = makeManager({
      workspacePath: 'K:\\AosService\\PackagesLocalDirectory\\MyPackage\\MyModel',
      packagePath: 'D:\\CustomRoot\\PackagesLocalDirectory',
    });
    expect(mgr.getPackagePath()).toBe('D:\\CustomRoot\\PackagesLocalDirectory');
  });
});

describe('explicit modelName overrides workspacePath last-segment extraction', () => {
  it('returns explicit modelName even when workspacePath last segment differs', () => {
    const mgr = makeManager({
      workspacePath: 'K:\\AosService\\PackagesLocalDirectory\\MyPackage\\MyPackage',
      modelName: 'MyActualModel',
    });
    expect(mgr.getModelName()).toBe('MyActualModel');
  });
});

// ─── No configuration ─────────────────────────────────────────────────────────

describe('no workspacePath configured', () => {
  it('getPackagePath returns null when no path and not on Windows', () => {
    // Non-Windows platform → the AosService drive scan is skipped entirely.
    // The scan memoises its result for the process lifetime, so the cache has to
    // be dropped on both sides of the override: once so this test scans as Linux
    // rather than reusing a Windows result, and once afterwards so the empty
    // Linux result does not leak into whatever runs next.
    const origPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    resetPackagesRootCache();

    const mgr = makeManager({});
    expect(mgr.getPackagePath()).toBeNull();

    Object.defineProperty(process, 'platform', { value: origPlatform, configurable: true });
    resetPackagesRootCache();
  });

  it('getModelName falls back to D365FO_MODEL_NAME env var', () => {
    const mgr = makeManager({});
    process.env.D365FO_MODEL_NAME = 'EnvModel';
    expect(mgr.getModelName()).toBe('EnvModel');
    delete process.env.D365FO_MODEL_NAME;
  });

  it('getModelName returns null when no source is configured', () => {
    delete process.env.D365FO_MODEL_NAME;
    const mgr = makeManager({});
    expect(mgr.getModelName()).toBeNull();
  });

  it('getPackageNameFromWorkspacePath returns null', () => {
    const mgr = makeManager({});
    expect(mgr.getPackageNameFromWorkspacePath()).toBeNull();
  });
});

// ─── Runtime context (GitHub Copilot workspace injection) ────────────────────

describe('setRuntimeContext', () => {
  it('runtime workspacePath takes priority over file context', () => {
    const mgr = makeManager({
      workspacePath: 'K:\\PackagesLocalDirectory\\FilePackage\\FileModel',
    });

    mgr.setRuntimeContext({
      workspacePath: 'K:\\AosService\\PackagesLocalDirectory\\RuntimePackage\\RuntimeModel',
    });

    expect(mgr.getModelName()).toBe('RuntimeModel');
    expect(mgr.getPackageNameFromWorkspacePath()).toBe('RuntimePackage');
  });

  it('merges runtime context with file context', () => {
    const mgr = makeManager({
      workspacePath: 'K:\\PackagesLocalDirectory\\MyPackage\\MyModel',
      devEnvironmentType: 'traditional',
    });

    mgr.setRuntimeContext({ projectPath: 'K:\\VSProjects\\Sol\\Proj\\Proj.rnrproj' });

    const ctx = mgr.getContext();
    expect(ctx?.workspacePath).toContain('MyModel');
    expect(ctx?.projectPath).toContain('Proj.rnrproj');
  });

  it('keeps request-scoped workspace isolated from shared runtime context', async () => {
    const mgr = makeManager({
      workspacePath: 'K:\\PackagesLocalDirectory\\FilePackage\\FileModel',
    });

    mgr.setRuntimeContext({
      workspacePath: 'K:\\AosService\\PackagesLocalDirectory\\RuntimePackage\\RuntimeModel',
    });

    expect((mgr as any).hasRequestContext()).toBe(false);
    expect(mgr.getModelName()).toBe('RuntimeModel');

    await (mgr as any).runWithRequestContext(
      { workspacePath: 'K:\\AosService\\PackagesLocalDirectory\\RequestPackage\\RequestModel' },
      async () => {
        expect((mgr as any).hasRequestContext()).toBe(true);
        expect(mgr.getModelName()).toBe('RequestModel');
      },
    );

    expect((mgr as any).hasRequestContext()).toBe(false);
    expect(mgr.getModelName()).toBe('RuntimeModel');
  });
});

// ─── UDE context ─────────────────────────────────────────────────────────────

describe('UDE context (customPackagesPath / microsoftPackagesPath)', () => {
  beforeEach(() => {
    // Clear DEV_ENVIRONMENT_TYPE so the real env var doesn't override test context values.
    vi.stubEnv('DEV_ENVIRONMENT_TYPE', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns customPackagesPath from mcp context', async () => {
    const mgr = makeManager({
      customPackagesPath: 'C:\\CustomXppCode',
      microsoftPackagesPath: 'C:\\Users\\Test\\Dynamics365\\10.0\\PackagesLocalDirectory',
      devEnvironmentType: 'ude',
    });
    // Prevent XPP auto-detection from running
    (mgr as any).xppConfigLoaded = true;
    (mgr as any).xppConfig = null;

    expect(await mgr.getCustomPackagesPath()).toBe('C:\\CustomXppCode');
    expect(await mgr.getMicrosoftPackagesPath()).toBe(
      'C:\\Users\\Test\\Dynamics365\\10.0\\PackagesLocalDirectory',
    );
  });

  it('reports dev environment as ude when devEnvironmentType=ude', async () => {
    const mgr = makeManager({ devEnvironmentType: 'ude' });
    (mgr as any).xppConfigLoaded = true;
    (mgr as any).xppConfig = null;

    expect(await mgr.getDevEnvironmentType()).toBe('ude');
  });

  it('reports dev environment as traditional when devEnvironmentType=traditional', async () => {
    const mgr = makeManager({ devEnvironmentType: 'traditional' });
    (mgr as any).xppConfigLoaded = true;
    (mgr as any).xppConfig = null;

    expect(await mgr.getDevEnvironmentType()).toBe('traditional');
  });
});

// ─── kebab-case names are rejected ───────────────────────────────────────────

describe('kebab-case path rejection', () => {
  it('skips model name from workspacePath when it contains a hyphen (repo name, not D365FO package)', () => {
    const mgr = makeManager({
      workspacePath: 'K:\\AosService\\PackagesLocalDirectory\\d365fo-mcp-server',
    });
    // Hyphen in name → skip, fall back to env or null
    delete process.env.D365FO_MODEL_NAME;
    expect(mgr.getModelName()).toBeNull();
  });
});

// ─── fallbackPackagePath ─────────────────────────────────────────────────────

describe('fallbackPackagePath', () => {
  it('returns a valid C: path string', () => {
    const result = fallbackPackagePath();
    expect(result).toBe('C:\\AosService\\PackagesLocalDirectory');
  });
});

// ─── extractModelFromFilePath (issue #369) ───────────────────────────────────

describe('extractModelFromFilePath', () => {
  it('extracts package name from standard AOT path', () => {
    expect(extractModelFromFilePath(
      'K:\\AosService\\PackagesLocalDirectory\\ApplicationSuite\\Foundation\\AxTable\\CustTable.xml'
    )).toBe('ApplicationSuite');
  });

  it('extracts package name when package == model', () => {
    expect(extractModelFromFilePath(
      'K:\\AosService\\PackagesLocalDirectory\\ContosoExt\\ContosoExt\\AxClass\\MyClass.xml'
    )).toBe('ContosoExt');
  });

  it('handles forward slashes', () => {
    expect(extractModelFromFilePath(
      'K:/AosService/PackagesLocalDirectory/AppSuite/Foundation/AxForm/CustTable.xml'
    )).toBe('AppSuite');
  });

  it('returns null for non-AOT paths', () => {
    expect(extractModelFromFilePath('/home/vsts/work/1/s/foo.xml')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(extractModelFromFilePath('')).toBeNull();
  });
});

// ─── isStaticallyConfigured ───────────────────────────────────────────────────

describe('isStaticallyConfigured', () => {
  it('returns true when modelName + workspacePath provided in file config', async () => {
    const mgr = makeManager({ modelName: 'TestModel', workspacePath: 'K:\\AosService\\PackagesLocalDirectory' });
    expect(await mgr.isStaticallyConfigured()).toBe(true);
  });

  it('returns true when modelName + packagePath provided in file config', async () => {
    const mgr = makeManager({ modelName: 'TestModel', packagePath: 'K:\\AosService\\PackagesLocalDirectory' });
    expect(await mgr.isStaticallyConfigured()).toBe(true);
  });

  it('returns true when modelName + projectPath provided in file config', async () => {
    const mgr = makeManager({ modelName: 'TestModel', projectPath: 'K:\\Projects\\TestModel.rnrproj' });
    expect(await mgr.isStaticallyConfigured()).toBe(true);
  });

  it('returns true when modelName + solutionPath provided in file config', async () => {
    const mgr = makeManager({ modelName: 'TestModel', solutionPath: 'K:\\Projects\\TestModel.sln' });
    expect(await mgr.isStaticallyConfigured()).toBe(true);
  });

  it('returns true when modelName + customPackagesPath provided in file config', async () => {
    const mgr = makeManager({ modelName: 'TestModel', customPackagesPath: 'K:\\AosService\\PackagesLocalDirectory' });
    expect(await mgr.isStaticallyConfigured()).toBe(true);
  });

  it('returns false when modelName is present but no path', async () => {
    const mgr = makeManager({ modelName: 'TestModel' });
    expect(await mgr.isStaticallyConfigured()).toBe(false);
  });

  it('returns false when path is present but no modelName', async () => {
    const mgr = makeManager({ workspacePath: 'K:\\AosService\\PackagesLocalDirectory' });
    expect(await mgr.isStaticallyConfigured()).toBe(false);
  });

  it('returns false when config is empty', async () => {
    const mgr = makeManager({});
    expect(await mgr.isStaticallyConfigured()).toBe(false);
  });

  it('returns true when both provided via env vars', async () => {
    process.env.D365FO_MODEL_NAME = 'TestModel';
    process.env.D365FO_WORKSPACE_PATH = 'K:\\AosService\\PackagesLocalDirectory';
    const mgr = makeManager({});
    expect(await mgr.isStaticallyConfigured()).toBe(true);
    delete process.env.D365FO_MODEL_NAME;
    delete process.env.D365FO_WORKSPACE_PATH;
  });

  it('returns true when modelName from env var, path from file config', async () => {
    process.env.D365FO_MODEL_NAME = 'TestModel';
    const mgr = makeManager({ workspacePath: 'K:\\AosService\\PackagesLocalDirectory' });
    expect(await mgr.isStaticallyConfigured()).toBe(true);
    delete process.env.D365FO_MODEL_NAME;
  });

  it('returns false when only D365FO_MODEL_NAME env var is set', async () => {
    process.env.D365FO_MODEL_NAME = 'TestModel';
    const mgr = makeManager({});
    expect(await mgr.isStaticallyConfigured()).toBe(false);
    delete process.env.D365FO_MODEL_NAME;
  });
});

// ─── getWorkspaceInfoDiagnostics — provenance labels ─────────────────────────

describe('getWorkspaceInfoDiagnostics provenance', () => {
  beforeEach(() => {
    vi.stubEnv('DEV_ENVIRONMENT_TYPE', '');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('labels packageSource as env var when D365FO_PACKAGE_PATH is set', async () => {
    process.env.D365FO_PACKAGE_PATH = 'K:\\AosService\\PackagesLocalDirectory';
    const mgr = makeManager({});
    (mgr as any).xppConfigLoaded = true;
    (mgr as any).xppConfig = null;

    const diag = await mgr.getWorkspaceInfoDiagnostics();
    expect(diag.packageSource).toBe('D365FO_PACKAGE_PATH env var');
    delete process.env.D365FO_PACKAGE_PATH;
  });

  it('labels packageSource as .mcp.json when packagePath comes from file config only', async () => {
    const mgr = makeManager({ packagePath: 'K:\\AosService\\PackagesLocalDirectory' });
    (mgr as any).xppConfigLoaded = true;
    (mgr as any).xppConfig = null;

    const diag = await mgr.getWorkspaceInfoDiagnostics();
    expect(diag.packageSource).toBe('.mcp.json');
  });

  it('returns customPackagesPath and its source from env var', async () => {
    process.env.D365FO_CUSTOM_PACKAGES_PATH = 'C:\\repos\\MyProject\\src\\Metadata';
    const mgr = makeManager({});
    (mgr as any).xppConfigLoaded = true;
    (mgr as any).xppConfig = null;

    const diag = await mgr.getWorkspaceInfoDiagnostics();
    expect(diag.customPackagesPath).toBe('C:\\repos\\MyProject\\src\\Metadata');
    expect(diag.customPackagesSource).toBe('D365FO_CUSTOM_PACKAGES_PATH env var');
    delete process.env.D365FO_CUSTOM_PACKAGES_PATH;
  });

  it('returns customPackagesPath and its source from .mcp.json', async () => {
    const mgr = makeManager({ customPackagesPath: 'C:\\repos\\MyProject\\src\\Metadata' });
    (mgr as any).xppConfigLoaded = true;
    (mgr as any).xppConfig = null;

    const diag = await mgr.getWorkspaceInfoDiagnostics();
    expect(diag.customPackagesPath).toBe('C:\\repos\\MyProject\\src\\Metadata');
    expect(diag.customPackagesSource).toBe('.mcp.json');
  });

  it('returns null customPackagesPath when neither env var nor config is set', async () => {
    const mgr = makeManager({});
    (mgr as any).xppConfigLoaded = true;
    (mgr as any).xppConfig = null;

    const diag = await mgr.getWorkspaceInfoDiagnostics();
    expect(diag.customPackagesPath).toBeNull();
    expect(diag.customPackagesSource).toBe('(not configured)');
  });
});
