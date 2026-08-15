/**
 * resolvePinnedXppConfig (src/cli/xppConfig.ts) — which XPP config a UDE target
 * actually resolves to.
 *
 * The case worth pinning down is the pin that no longer resolves. That is not a
 * hypothetical: a UDE upgrade replaces contoso___10.0.2428.63 with
 * contoso___10.0.2500.x, and until `instance upgrade` runs, the instance config
 * still names the old one — exactly what isXppConfigStale() reports. Answering
 * that with "the newest config" would have callers read a version this target
 * is not on and present the result as current, while its index and server still
 * reference the stale pin. Null is the honest answer, and it is also what
 * XppConfigProvider.getActiveConfig has always returned for a named-but-absent
 * config.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolvePinnedXppConfig } from '../../src/cli/xppConfig.js';
import { openStore } from '../../src/cli/settingsStore.js';
import { writeConfigFile } from '../../src/config/configFile.js';
import type { ConfigObject } from '../../src/config/configFile.js';

const ORIGINAL_LOCALAPPDATA = process.env.LOCALAPPDATA;
let root: string;
let configDir: string;

beforeEach(() => {
  root = fs.mkdtempSync(join(os.tmpdir(), 'xpp-config-pin-'));
  // xppConfigDir() reads LOCALAPPDATA at call time, so the fixture works on
  // Linux CI too — listXppConfigs() itself has no Windows-only calls.
  process.env.LOCALAPPDATA = join(root, 'LocalAppData');
  configDir = join(process.env.LOCALAPPDATA, 'Microsoft', 'Dynamics365', 'XPPConfig');
  fs.mkdirSync(configDir, { recursive: true });
});

afterEach(() => {
  if (ORIGINAL_LOCALAPPDATA === undefined) delete process.env.LOCALAPPDATA;
  else process.env.LOCALAPPDATA = ORIGINAL_LOCALAPPDATA;
  fs.rmSync(root, { recursive: true, force: true });
});

/** Write an XPP config fixture; `ageMs` back-dates it so "newest" is decidable. */
function writeXppConfig(fullName: string, frameworkDirectory: string | null, ageMs = 0): void {
  const file = join(configDir, `${fullName}.json`);
  fs.writeFileSync(file, JSON.stringify({ FrameworkDirectory: frameworkDirectory ?? undefined }), 'utf-8');
  if (ageMs) {
    const when = new Date(Date.now() - ageMs);
    fs.utimesSync(file, when, when);
  }
}

function makeStore(environment: ConfigObject) {
  const dir = join(root, 'instance');
  fs.mkdirSync(dir, { recursive: true });
  writeConfigFile(join(dir, 'd365fo-mcp.json'), { environment });
  return openStore(dir, null);
}

describe('resolvePinnedXppConfig', () => {
  it('returns the pinned config when it still exists', () => {
    writeXppConfig('contoso___10.0.2500.7', 'K:\\pkg\\2500', 60_000);
    writeXppConfig('other___10.0.2428.63', 'K:\\pkg\\2428');
    const store = makeStore({ type: 'ude', xppConfigName: 'contoso___10.0.2500.7' });

    expect(resolvePinnedXppConfig(store)?.fullName).toBe('contoso___10.0.2500.7');
  });

  it('accepts the short config name too, as getActiveConfig does', () => {
    writeXppConfig('contoso___10.0.2500.7', 'K:\\pkg\\2500');
    const store = makeStore({ type: 'ude', xppConfigName: 'contoso' });

    expect(resolvePinnedXppConfig(store)?.fullName).toBe('contoso___10.0.2500.7');
  });

  it('returns null — not the newest — when the pin no longer resolves', () => {
    // The post-upgrade state: the pinned 10.0.2428.63 config is gone and only a
    // newer one is left. Substituting it would silently move the target onto a
    // version it is not pinned to.
    writeXppConfig('contoso___10.0.2500.7', 'K:\\pkg\\2500');
    const store = makeStore({ type: 'ude', xppConfigName: 'contoso___10.0.2428.63' });

    expect(resolvePinnedXppConfig(store)).toBeNull();
  });

  it('auto-selects the newest config when nothing is pinned', () => {
    writeXppConfig('old___10.0.2428.63', 'K:\\pkg\\2428', 60_000);
    writeXppConfig('new___10.0.2500.7', 'K:\\pkg\\2500');
    const store = makeStore({ type: 'ude' });

    expect(resolvePinnedXppConfig(store)?.fullName).toBe('new___10.0.2500.7');
  });

  it('returns null for a traditional target regardless of what configs exist', () => {
    writeXppConfig('contoso___10.0.2500.7', 'K:\\pkg\\2500');
    const store = makeStore({ type: 'traditional' });

    expect(resolvePinnedXppConfig(store)).toBeNull();
  });
});
