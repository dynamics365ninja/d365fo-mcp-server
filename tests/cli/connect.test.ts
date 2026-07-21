/**
 * `d365fo-mcp connect` — URL normalisation and config merging.
 *
 * These two functions decide what lands in a team member's editor config, and
 * the merge in particular is the destructive one: the file routinely holds
 * other MCP servers, so losing them would be a real regression rather than a
 * cosmetic one.
 */

import { describe, it, expect } from 'vitest';
import { mergeConfig, normalizeServerUrl } from '../../src/cli/commands/connect';

describe('normalizeServerUrl', () => {
  it('appends the endpoint to a site root pasted from the Azure portal', () => {
    expect(normalizeServerUrl('https://foo.azurewebsites.net')).toEqual({
      url: 'https://foo.azurewebsites.net/mcp/',
      health: 'https://foo.azurewebsites.net/health',
    });
  });

  it('keeps an endpoint that already carries /mcp, with or without the slash', () => {
    const expected = {
      url: 'https://foo.azurewebsites.net/mcp/',
      health: 'https://foo.azurewebsites.net/health',
    };
    expect(normalizeServerUrl('https://foo.azurewebsites.net/mcp')).toEqual(expected);
    expect(normalizeServerUrl('https://foo.azurewebsites.net/mcp/')).toEqual(expected);
  });

  it('assumes https when the scheme is missing', () => {
    expect(normalizeServerUrl('foo.azurewebsites.net')?.url).toBe('https://foo.azurewebsites.net/mcp/');
  });

  it('keeps an explicit http scheme and port for a local server', () => {
    expect(normalizeServerUrl('http://localhost:8080')).toEqual({
      url: 'http://localhost:8080/mcp/',
      health: 'http://localhost:8080/health',
    });
  });

  it('preserves a path prefix, e.g. a reverse-proxied deployment', () => {
    expect(normalizeServerUrl('https://intra.example.com/d365')).toEqual({
      url: 'https://intra.example.com/d365/mcp/',
      health: 'https://intra.example.com/d365/health',
    });
  });

  it('rejects input that is not a usable http(s) URL', () => {
    for (const bad of ['', '   ', 'ftp://foo/mcp', 'http://', 'not a url']) {
      expect(normalizeServerUrl(bad), bad).toBeNull();
    }
  });
});

describe('mergeConfig', () => {
  const entry = { type: 'http', url: 'https://foo/mcp/' };

  it('creates the file structure when nothing exists yet', () => {
    const out = mergeConfig(null, 'servers', 'd365fo-mcp-tools', entry)!;
    expect(JSON.parse(out.json)).toEqual({ servers: { 'd365fo-mcp-tools': entry } });
    expect(out.replaced).toBe(false);
    expect(out.siblings).toEqual([]);
  });

  it('keeps other MCP servers and unrelated top-level keys intact', () => {
    const existing = JSON.stringify({
      inputs: [{ id: 'token' }],
      servers: { github: { url: 'https://api.github.com/mcp' } },
    });
    const out = mergeConfig(existing, 'servers', 'd365fo-mcp-tools', entry)!;
    const doc = JSON.parse(out.json);
    expect(doc.servers.github).toEqual({ url: 'https://api.github.com/mcp' });
    expect(doc.inputs).toEqual([{ id: 'token' }]);
    expect(out.siblings).toEqual(['github']);
  });

  it('reports replacement when the entry is already configured', () => {
    const existing = JSON.stringify({ servers: { 'd365fo-mcp-tools': { url: 'https://old/mcp/' } } });
    const out = mergeConfig(existing, 'servers', 'd365fo-mcp-tools', entry)!;
    expect(out.replaced).toBe(true);
    expect(JSON.parse(out.json).servers['d365fo-mcp-tools']).toEqual(entry);
  });

  it('honours the mcpServers key used by Cursor', () => {
    const existing = JSON.stringify({ mcpServers: { other: { url: 'https://x/mcp' } } });
    const out = mergeConfig(existing, 'mcpServers', 'd365fo-mcp-tools', entry)!;
    const doc = JSON.parse(out.json);
    expect(Object.keys(doc)).toEqual(['mcpServers']);
    expect(doc.mcpServers.other).toBeDefined();
  });

  it('treats an empty file as no configuration rather than as corruption', () => {
    expect(mergeConfig('', 'servers', 'd365fo-mcp-tools', entry)).not.toBeNull();
    expect(mergeConfig('   \n', 'servers', 'd365fo-mcp-tools', entry)).not.toBeNull();
  });

  it('refuses to touch a file it cannot parse, rather than overwriting it', () => {
    // The caller turns null into "fix it by hand" — silently rewriting here
    // would discard whatever servers the user had configured.
    expect(mergeConfig('{ not json', 'servers', 'd365fo-mcp-tools', entry)).toBeNull();
    expect(mergeConfig('[]', 'servers', 'd365fo-mcp-tools', entry)).toBeNull();
    expect(mergeConfig('"a string"', 'servers', 'd365fo-mcp-tools', entry)).toBeNull();
  });

  it('replaces a servers value of the wrong shape instead of crashing', () => {
    const out = mergeConfig(JSON.stringify({ servers: 'nonsense' }), 'servers', 'd365fo-mcp-tools', entry)!;
    expect(JSON.parse(out.json).servers).toEqual({ 'd365fo-mcp-tools': entry });
  });
});
