/**
 * resolveRegularObjectPrefixToken tests.
 *
 * Factored out of applyObjectPrefix's "regular objects" branch so the eval
 * oracle's prefix-agnostic golden comparison (src/eval/oracle/normalize.ts,
 * cli.ts) can compute the literal token the CURRENT session's EXTENSION_PREFIX
 * resolves to for a NEW regular object name — without duplicating the
 * underscore-style-vs-PascalCase branching logic. See
 * docs/AGENT_EVAL_LOOP.md §6.2 and the corpus record that motivated this:
 * eval/corpus/runs/2026-07-06T10__L0-edt-basic__4fafcd8.json.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { resolveRegularObjectPrefixToken, resolveObjectPrefix, applyObjectPrefix } from '../../src/utils/modelClassifier';

const originalPrefix = process.env.EXTENSION_PREFIX;

afterEach(() => {
  if (originalPrefix === undefined) delete process.env.EXTENSION_PREFIX;
  else process.env.EXTENSION_PREFIX = originalPrefix;
});

describe('resolveRegularObjectPrefixToken', () => {
  it('returns "" when EXTENSION_PREFIX is not configured', () => {
    delete process.env.EXTENSION_PREFIX;
    expect(resolveRegularObjectPrefixToken()).toBe('');
  });

  it('returns the PascalCase prefix as-is for a normal prefix', () => {
    process.env.EXTENSION_PREFIX = 'ContosoDemo';
    expect(resolveRegularObjectPrefixToken()).toBe('ContosoDemo');
  });

  it('capitalizes a lowercase-first prefix (matches applyObjectPrefix\'s own capitalisation)', () => {
    process.env.EXTENSION_PREFIX = 'contosoDemo';
    expect(resolveRegularObjectPrefixToken()).toBe('ContosoDemo');
  });

  it('keeps the trailing underscore for underscore-style prefixes', () => {
    process.env.EXTENSION_PREFIX = 'XY_';
    expect(resolveRegularObjectPrefixToken()).toBe('XY_');
  });

  it('matches the literal token applyObjectPrefix actually prepends to a regular object name', () => {
    for (const prefix of ['ContosoDemo', 'Demo', 'XY_', 'Contoso']) {
      process.env.EXTENSION_PREFIX = prefix;
      const token = resolveRegularObjectPrefixToken();
      const named = applyObjectPrefix('MyTable', resolveObjectPrefix(''));
      expect(named.startsWith(token)).toBe(true);
    }
  });
});
