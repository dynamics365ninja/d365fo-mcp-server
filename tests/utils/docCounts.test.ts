/**
 * Doc-drift gate for the counts that appear as bare numbers in prose.
 *
 * docs/MCP_TOOLS.md advertised "32 AOT object types" and "25 operations" for
 * `d365fo_file` long after the schema had grown to 39 and 31. Nothing pinned
 * them, so the numbers rotted silently every time an enum gained a value —
 * and a user reading the doc concluded a type was unsupported when it was not.
 *
 * The tool COUNT is deliberately not asserted here: tests/utils/toolInventory.test.ts
 * already owns it, and duplicating it would mean two places to update.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { d365foFileTool } from '../../src/server/toolSchemas/d365foFile';

const REPO_ROOT = path.resolve(__dirname, '..', '..');

function readDoc(rel: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, 'docs', rel), 'utf8');
}

function enumOf(prop: string): string[] {
  const schema = d365foFileTool.inputSchema as {
    properties: Record<string, { enum?: string[] }>;
  };
  const values = schema.properties[prop]?.enum;
  if (!values) throw new Error(`d365fo_file schema has no enum for "${prop}"`);
  return values;
}

describe('docs/MCP_TOOLS.md counts match the published schema', () => {
  const doc = readDoc('MCP_TOOLS.md');

  it('states the real number of AOT object types', () => {
    const actual = enumOf('objectType').length;
    expect(
      doc,
      `d365fo_file publishes ${actual} objectType values; update the "N AOT object types" ` +
        `phrase in docs/MCP_TOOLS.md.`,
    ).toContain(`create any of ${actual} AOT object types`);
  });

  it('states the real number of modify operations', () => {
    const actual = enumOf('operation').length;
    expect(
      doc,
      `d365fo_file publishes ${actual} operation values; update the "N operations" ` +
        `phrase in docs/MCP_TOOLS.md.`,
    ).toContain(`${actual} operations:`);
  });

  // GROUNDING_ENFORCE defaults to false (src/config/settings.ts). The doc used to
  // say it was "default on", which reads as "this gate is already protecting you"
  // — the opposite of the truth, and the kind of error that only surfaces after
  // an ungrounded write lands.
  it('does not claim GROUNDING_ENFORCE defaults on', () => {
    expect(doc).not.toMatch(/GROUNDING_ENFORCE`? and `?FORM_PATTERN_ENFORCE`? \(both default on\)/);
  });
});
