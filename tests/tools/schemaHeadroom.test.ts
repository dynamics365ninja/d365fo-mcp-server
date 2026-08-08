/**
 * Phase 1.5 — schema headroom.
 *
 * The ListTools payload had 50 chars of headroom in a 53,500 budget and its
 * largest tool sat 3 chars under the per-tool cap, so no round-trip improvement
 * could be paid for. Three trims freed ~3,850 chars. These tests pin the parts
 * that are behaviour rather than size (the size itself is ratcheted in
 * tests/utils/toolSchemaBudget.test.ts):
 *
 *   • get_method / suggest_edt are unpublished but still ROUTABLE — an agent
 *     holding the old name from an earlier session must get an answer, not an
 *     unrecoverable "unknown tool".
 *   • get_object_info absorbs get_method via options.method.
 *   • labels still accepts every plumbing parameter that left its wire schema,
 *     flat or nested in `params`, and the op-spec lookup answers for it.
 */

import { describe, it, expect } from 'vitest';
import { toolSchemas } from '../../src/server/toolSchemas/index';
import { lookupOpSpec } from '../../src/tools/specs/opSpecs';
import { LABELS_OVERRIDE_PARAMS } from '../../src/tools/specs/labelsOpSpecs';

const published = new Set(toolSchemas.map(t => t.name));

describe('unpublished-but-routable tools', () => {
  it('no longer publishes get_method or suggest_edt', () => {
    expect(published.has('get_method')).toBe(false);
    expect(published.has('suggest_edt')).toBe(false);
  });

  it('still routes both names in the dispatcher', async () => {
    // Source-level check: the dispatcher is a switch, and a missing case is the
    // exact regression this guards (an agent mid-session gets "unknown tool").
    const { readFileSync } = await import('fs');
    const src = readFileSync('src/tools/toolHandler.ts', 'utf8');
    expect(src).toContain("case 'get_method':");
    expect(src).toContain("case 'suggest_edt':");
  });
});

describe('get_object_info absorbs get_method', () => {
  const tool = toolSchemas.find(t => t.name === 'get_object_info')!;

  it('advertises options.method in the options description', () => {
    const desc = (tool.inputSchema as any).properties.options.description as string;
    expect(desc).toMatch(/"method"/);
    expect(desc).toMatch(/signature \| source \| both/);
  });
});

describe('labels op-spec', () => {
  const tool = toolSchemas.find(t => t.name === 'labels')!;
  const props = (tool.inputSchema as any).properties as Record<string, unknown>;

  it('publishes a loose params object and points at the op-spec', () => {
    expect(props.params).toMatchObject({ type: 'object', additionalProperties: true });
    expect(tool.description).toContain('kind="op-spec"');
  });

  it('every plumbing parameter left the wire schema', () => {
    for (const name of Object.keys(LABELS_OVERRIDE_PARAMS)) {
      expect(props[name], `'${name}' is still inlined in the labels schema`).toBeUndefined();
    }
  });

  it('keeps the parameters a normal call needs in the schema', () => {
    for (const name of ['action', 'labelId', 'labelFileId', 'model', 'translations', 'labels',
                        'query', 'language', 'oldLabelId', 'newLabelId', 'dryRun']) {
      expect(props[name], `'${name}' must stay published`).toBeDefined();
    }
  });

  it('answers the op-spec lookup with every parameter it removed', () => {
    const spec = lookupOpSpec('labels');
    for (const name of Object.keys(LABELS_OVERRIDE_PARAMS)) {
      expect(spec, `op-spec omits '${name}'`).toContain(name);
    }
  });

  it('lists labels in the op-spec index so it is discoverable', () => {
    expect(lookupOpSpec()).toContain('labels write plumbing');
  });
});

describe('search type enum is inlined once, not three times', () => {
  const tool = toolSchemas.find(t => t.name === 'search')!;
  const props = (tool.inputSchema as any).properties;

  it('keeps the closed enum on the top-level type', () => {
    expect(props.type.enum).toContain('table-extension');
    expect(props.type.enum).toContain('all');
  });

  it('drops the two duplicate copies and points at the authoritative one', () => {
    expect(props.queries.items.properties.type.enum).toBeUndefined();
    expect(props.queries.items.properties.type.description).toContain('top-level `type`');
    expect(props.globalTypeFilter.items.enum).toBeUndefined();
    expect(props.globalTypeFilter.description).toContain('top-level `type`');
  });
});
