/**
 * How the server locates the bridge binary.
 *
 * An npm install builds the bridge outside the package — an update replaces
 * the package, and anything inside it with it — so nothing in the
 * package-relative search would ever find it. The configured path is what
 * closes that gap, which makes two properties matter: it has to be honoured,
 * and a wrong one has to say so rather than fall back to a binary built for a
 * different environment. (Bridges are per-environment: every D365FO platform
 * build stamps assembly version 7.0.0.0, so a mismatched one loads fine and
 * dies later at JIT time — issue #703.)
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { BridgeClient } from '../../src/bridge/bridgeClient.js';

let tmp: string;

/** Reach the private resolver without spawning anything. */
function resolveExe(client: BridgeClient): string {
  return (client as unknown as { resolveBridgeExe(): string }).resolveBridgeExe();
}

beforeEach(() => {
  tmp = fs.mkdtempSync(join(os.tmpdir(), 'd365fo-bridge-'));
  delete process.env.D365FO_BRIDGE_EXE_PATH;
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  delete process.env.D365FO_BRIDGE_EXE_PATH;
});

describe('bridge exe resolution', () => {
  it('uses an explicitly configured path', () => {
    const exe = join(tmp, 'D365MetadataBridge.exe');
    fs.writeFileSync(exe, '');
    const client = new BridgeClient({ packagesPath: tmp, bridgeExePath: exe });
    expect(resolveExe(client)).toBe(exe);
  });

  it('reads the path from the environment when no option is passed', () => {
    // This is the live route: the wizard writes bridge.exePath into the
    // config, and loadEnv projects it onto D365FO_BRIDGE_EXE_PATH.
    const exe = join(tmp, 'D365MetadataBridge.exe');
    fs.writeFileSync(exe, '');
    process.env.D365FO_BRIDGE_EXE_PATH = exe;
    const client = new BridgeClient({ packagesPath: tmp });
    expect(resolveExe(client)).toBe(exe);
  });

  it('fails loudly when the configured path is wrong', () => {
    // Never silently fall through to the in-package search: that binary was
    // built for whatever environment happened to build it.
    const missing = join(tmp, 'nope', 'D365MetadataBridge.exe');
    const client = new BridgeClient({ packagesPath: tmp, bridgeExePath: missing });
    expect(() => resolveExe(client)).toThrow(/configured path/i);
  });

  it('ignores an empty setting and falls back to the search', () => {
    // An unset `path` setting serialises as '', which must mean "auto-detect"
    // rather than "look for a file called ''".
    process.env.D365FO_BRIDGE_EXE_PATH = '   ';
    const client = new BridgeClient({ packagesPath: tmp, bridgeExePath: '' });

    // Whether the search then succeeds depends on the machine — a developer
    // VM has the bridge built in-tree, a Linux CI runner never does — so
    // assert on the branch taken rather than the outcome: a blank value must
    // reach the search, not be reported as a configured path that is missing.
    let error: unknown;
    try {
      expect(resolveExe(client)).toMatch(/D365MetadataBridge\.exe$/);
    } catch (err) {
      error = err;
    }
    if (error) expect(String(error)).toMatch(/Bridge executable not found/);
  });
});
