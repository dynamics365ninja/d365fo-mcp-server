/**
 * L2-batched-object-reads case contract — VM-free.
 *
 * The case exists to catch the regression in issue #831: an audited session made
 * 13 sequential single-object get_object_info calls and never batched. Its
 * artifacts are ordinary table extensions, so nothing in the golden diff would
 * notice a sequential tool path — the tool-path requirement lives in the
 * instruction, and this test pins it there so it cannot be edited away silently.
 *
 * The behavioural half (3 objects → ONE call → 3 sections) is asserted in
 * tests/tools/getObjectInfoPlural.test.ts; the live run is captured on the VM,
 * hence golden_pending.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { OBJECT_INFO_TYPES } from '../../src/tools/readers/objectInfoRegistry';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const CASE_ID = 'L2-batched-object-reads';

const spec = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, 'eval', 'cases', `${CASE_ID}.json`), 'utf8'),
);

describe(`${CASE_ID} — eval case spec`, () => {
  it('is a well-formed case (id/tier prefix, golden path, pending golden)', () => {
    expect(spec.id).toBe(CASE_ID);
    expect(spec.tier).toBe(2);
    expect(spec.id.startsWith(`L${spec.tier}-`)).toBe(true);
    expect(spec.golden_path).toBe(`eval/goldens/${CASE_ID}/`);
    expect(spec.golden_pending).toBe(true); // captured on the VM (§6.4)
    expect(spec.split).toBe('holdout');
    expect(spec.target_artifact_types).toEqual(['AxTableExtension']);
  });

  it('names 3+ objects, all of a type get_object_info can actually read', () => {
    const objects = [...spec.instruction.matchAll(/objectName:"([A-Za-z0-9_]+)"/g)].map(m => m[1]);
    expect(new Set(objects).size).toBeGreaterThanOrEqual(3);

    const types = [...spec.instruction.matchAll(/objectType:"([a-z-]+)"/g)].map(m => m[1]);
    expect(types).toHaveLength(objects.length);
    for (const t of types) expect(OBJECT_INFO_TYPES).toContain(t as any);
  });

  it('mandates ONE plural get_object_info call rather than N sequential ones', () => {
    expect(spec.instruction).toContain('SINGLE get_object_info call');
    expect(spec.instruction).toContain('get_object_info(objects=[');
    expect(spec.instruction).toMatch(/NOT three sequential single-object get_object_info calls/);
    expect(spec.instruction).toContain('exactly ONE get_object_info call');
    expect(spec.instruction).toContain('#831');
  });

  it('never tells the agent to reach for the retired batch_get_info tool', () => {
    expect(spec.instruction).not.toContain('batch_get_info');
  });
});
