/**
 * ConfigManager Tests
 * Covers: path resolution (one-level and two-level workspacePath),
 *         model name extraction, package name extraction,
 *         UDE path resolution, McpContext merging.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getConfigManager } from '../../src/utils/configManager';

// Prevent real file I/O during unit tests
vi.mock('fs/promises', () => ({
  readFile: vi.fn(async () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); }),
}));
vi.mock('fs', async (orig) => {
  const actual = await orig<typeof import('fs')>();
  return { ...actual, existsSync: vi.fn(() => false), realpathSync: vi.fn((p: string) => p) };
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
    // Non-Windows platform → well-known probe is skipped
    const origPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });

    const mgr = makeManager({});
    expect(mgr.getPackagePath()).toBeNull();

    Object.defineProperty(process, 'platform', { value: origPlatform, configurable: true });
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
