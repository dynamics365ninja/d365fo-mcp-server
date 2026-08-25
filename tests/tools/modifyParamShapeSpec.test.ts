/**
 * The published d365fo_file schema promises: "A missing/wrong one returns that
 * COMPLETE spec — follow it, do not guess."
 *
 * The missing-parameter path kept that promise. A parameter of the right NAME but
 * the wrong SHAPE did not: it escaped to the generic catch, which renders a
 * ZodError as its raw issue array. Observed live on 2026-08-24 calling add-index
 * with indexFields: ["ProbeId"] instead of [{fieldName:"ProbeId"}]:
 *
 *   ❌ Error modifying D365FO file: [ { "expected": "object", "code":
 *     "invalid_type", "path": [ "indexFields", 0 ], … } ]
 *
 * The caller then either guesses or spends a round trip on get_knowledge to be told
 * the contract it had already asked about.
 */

import { describe, it, expect } from 'vitest';
import { modifyD365FileTool } from '../../src/tools/write/modifyD365File';

const call = (args: Record<string, unknown>) => modifyD365FileTool(
  { method: 'tools/call', params: { name: 'd365fo_file', arguments: args } } as never,
  { symbolIndex: { getReadDb: () => ({ prepare: () => ({ all: () => [], get: () => undefined }) }) } } as never,
);
const text = (r: any) => r.content.map((c: any) => c.text).join('');

describe('a wrong parameter SHAPE answers with the operation contract', () => {
  it('names the offending parameter and returns the add-index spec (autoCorrect=false)', async () => {
    const r: any = await call({
      objectType: 'table', objectName: 'SomeTable', operation: 'add-index',
      // Flat, as d365foFileTool hands them over after merging `params` up.
      // Strict mode: a list of names is refused with the contract, exactly as
      // before. The default now reads it as [{fieldName}] — see the coercion
      // suite in modifyArgNormalization.test.ts.
      indexName: 'Idx', indexFields: ['ProbeId'], autoCorrect: false,
    });

    expect(r.isError).toBe(true);
    const t = text(r);
    // Which parameter, in words rather than a serialized validator object.
    expect(t).toContain('indexFields');
    expect(t).not.toContain('"code": "invalid_type"');
    // And the contract itself, which is what the schema promised.
    expect(t).toContain("Parameter spec for operation 'add-index'");
    expect(t).toContain('fieldName');
  });

  it('does the same for any other operation, not just add-index', async () => {
    const r: any = await call({
      objectType: 'table', objectName: 'SomeTable', operation: 'add-relation',
      relationName: 'Rel', relatedTable: 'CustTable', relationConstraints: ['AccountNum'],
    });
    const t = text(r);
    expect(t).toContain('relationConstraints');
    expect(t).toContain("Parameter spec for operation 'add-relation'");
  });

  it('leaves the generic message in place when no operation was named', async () => {
    // Nothing to render a spec for — the old text is still the best available.
    const r: any = await call({ objectType: 'table', objectName: 'SomeTable' });
    expect(r.isError).toBe(true);
    expect(text(r)).not.toContain('Parameter spec for operation');
  });
});
