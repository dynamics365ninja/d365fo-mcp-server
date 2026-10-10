/**
 * An extension class whose name already carries the model's token right after the
 * base it extends — SalesTable|Mcp|CreditHold_Extension — is written as asked.
 *
 * Found by the model × MCP benchmark (ref-credit-hold-extension, 2026-10-10): the
 * prompt requires `SalesTableMcpCreditHold_Extension`; d365fo_file(action="create")
 * wrote `SalesTableMcpCreditHoldMcp_Extension`, because the token was only looked
 * for at either END of the stem. The agent deleted it and created it again — and got
 * the same rename. Three with-MCP cells lost the CoC check to it; the cells without
 * MCP, writing the file directly, never did.
 *
 * The [ExtensionOf] attribute names the base, which is what makes the name
 * unambiguous: without a base, "SalesTaxTrans" under prefix "Tax" cannot be told
 * from an already-prefixed name, so nothing changes for callers that do not give one.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { normalizeObjectName } from '../../src/utils/objectNaming.js';
import { registerCustomModel, tokenFollowsBase } from '../../src/utils/modelClassifier.js';

const ENV_KEYS = [
  'EXTENSION_PREFIX',
  'EXTENSION_SUFFIX',
  'EXTENSION_NAMING_STYLE',
  'EXTENSION_CLASS_NAMING_STYLE',
  'EXTENSION_PREFIX_SOURCE',
];
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.EXTENSION_PREFIX = 'Mcp';
  process.env.EXTENSION_PREFIX_SOURCE = 'config';
  registerCustomModel('BenchmarkTestMcp');
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('extension class named {Base}{Token}{Feature}_Extension', () => {
  it('keeps the name when [ExtensionOf] names the base the token follows', () => {
    expect(normalizeObjectName('SalesTableMcpCreditHold_Extension', 'class', 'BenchmarkTestMcp', undefined, { extendedBase: 'SalesTable' }))
      .toBe('SalesTableMcpCreditHold_Extension');
  });

  it('is what the benchmark run got without the base — the old behaviour, still the fallback', () => {
    expect(normalizeObjectName('SalesTableMcpCreditHold_Extension', 'class', 'BenchmarkTestMcp'))
      .toBe('SalesTableMcpCreditHoldMcp_Extension');
  });

  it('still adds the token when the name carries none', () => {
    expect(normalizeObjectName('SalesTableCreditHold_Extension', 'class', 'BenchmarkTestMcp', undefined, { extendedBase: 'SalesTable' }))
      .toBe('SalesTableCreditHoldMcp_Extension');
  });

  it('still adds the token when the base merely continues with the same letters', () => {
    // SalesTable|Mcpx… is not the token as a word.
    expect(normalizeObjectName('SalesTableMcpxHold_Extension', 'class', 'BenchmarkTestMcp', undefined, { extendedBase: 'SalesTable' }))
      .toBe('SalesTableMcpxHoldMcp_Extension');
  });

  it('is unchanged for the census shape {Base}{Token}_Extension', () => {
    expect(normalizeObjectName('SalesTableMcp_Extension', 'class', 'BenchmarkTestMcp', undefined, { extendedBase: 'SalesTable' }))
      .toBe('SalesTableMcp_Extension');
  });

  it('keeps the name under the prefix-leading style too', () => {
    process.env.EXTENSION_CLASS_NAMING_STYLE = 'prefix-leading';
    expect(normalizeObjectName('SalesTableMcpCreditHold_Extension', 'class', 'BenchmarkTestMcp', undefined, { extendedBase: 'SalesTable' }))
      .toBe('SalesTableMcpCreditHold_Extension');
  });

  it('is idempotent', () => {
    const once = normalizeObjectName('SalesTableMcpCreditHold_Extension', 'class', 'BenchmarkTestMcp', undefined, { extendedBase: 'SalesTable' });
    expect(normalizeObjectName(once, 'class', 'BenchmarkTestMcp', undefined, { extendedBase: 'SalesTable' })).toBe(once);
  });
});

describe('tokenFollowsBase', () => {
  it.each([
    ['SalesTableMcpCreditHold', 'SalesTable', true],
    ['SalesTable_McpCreditHold', 'SalesTable', true],
    ['salestableMcpCreditHold', 'SalesTable', true],
    ['SalesTableMcp', 'SalesTable', true],
    ['SalesTableMcp_Hold', 'SalesTable', true],
    ['SalesTableMcpxHold', 'SalesTable', false],
    ['SalesTableCreditHoldMcp', 'SalesTable', false],
    ['SalesLineMcpHold', 'SalesTable', false],
    ['SalesTable', 'SalesTable', false],
  ])('%s after %s → %s', (stem, base, expected) => {
    expect(tokenFollowsBase(stem, base, ['Mcp'])).toBe(expected);
  });
});
