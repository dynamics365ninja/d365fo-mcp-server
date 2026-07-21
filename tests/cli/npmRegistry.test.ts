/**
 * Release-freshness comparison.
 *
 * `isBehind` decides whether the CLI nags the user to update, so both of its
 * failure modes are user-visible: a false positive tells someone on the latest
 * release to reinstall, and a false negative leaves a stale VM believing it is
 * current — the state that produces bug reports for already-fixed defects.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchLatestVersion, isBehind } from '../../src/cli/npmRegistry.js';

describe('isBehind', () => {
  it('detects a newer release at every level of the triple', () => {
    expect(isBehind('1.1.0', '2.0.0')).toBe(true);
    expect(isBehind('1.1.0', '1.2.0')).toBe(true);
    expect(isBehind('1.1.0', '1.1.1')).toBe(true);
  });

  it('is false for the same version and for a copy ahead of the registry', () => {
    expect(isBehind('1.1.0', '1.1.0')).toBe(false);
    expect(isBehind('1.2.0', '1.1.0')).toBe(false);
    expect(isBehind('2.0.0', '1.9.9')).toBe(false);
  });

  it('compares numerically, not lexically', () => {
    // The bug a string compare would produce: '10' < '9' as text.
    expect(isBehind('1.10.0', '1.9.0')).toBe(false);
    expect(isBehind('1.9.0', '1.10.0')).toBe(true);
  });

  it('treats a prerelease as its release version', () => {
    // Whoever installed 1.2.0-rc.1 did it deliberately; do not nag them onto
    // the release they are testing against.
    expect(isBehind('1.2.0-rc.1', '1.2.0')).toBe(false);
    expect(isBehind('1.2.0-rc.1', '1.3.0')).toBe(true);
  });

  it('tolerates a missing patch component and a v prefix', () => {
    expect(isBehind('1.1', '1.1.0')).toBe(false);
    expect(isBehind('v1.1.0', 'v1.2.0')).toBe(true);
  });
});

describe('fetchLatestVersion', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('returns the latest dist-tag', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ latest: '3.4.5', next: '4.0.0-rc.1' }),
    }));
    await expect(fetchLatestVersion()).resolves.toBe('3.4.5');
  });

  it('honours npm_config_registry so a private mirror is used', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ latest: '1.0.0' }) });
    vi.stubGlobal('fetch', fetchMock);
    vi.stubEnv('npm_config_registry', 'https://npm.internal.example/');
    await fetchLatestVersion();
    expect(fetchMock.mock.calls[0][0]).toBe('https://npm.internal.example/-/package/d365fo-mcp/dist-tags');
  });

  // The offline case is the common one on a D365FO VM: it must degrade to
  // "unknown", never throw into a setup or an update that would otherwise work.
  it('returns null when the registry is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ENOTFOUND')));
    await expect(fetchLatestVersion()).resolves.toBeNull();
  });

  it('returns null on an error response and on a malformed body', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) }));
    await expect(fetchLatestVersion()).resolves.toBeNull();

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ latest: 42 }) }));
    await expect(fetchLatestVersion()).resolves.toBeNull();
  });
});
