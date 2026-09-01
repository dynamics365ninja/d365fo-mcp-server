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
 * captured 2026-08-31 (three AxTableExtension artifacts).
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
    expect(spec.golden_pending).toBe(false); // golden captured on the VM 2026-08-31 (§6.4)
    expect(spec.split).toBe('holdout');
    // one entry per FILE: the case produces three sibling table extensions
    expect(spec.target_artifact_types).toEqual(['AxTableExtension', 'AxTableExtension', 'AxTableExtension']);
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

/**
 * Captured-golden contract. The three artifacts are ordinary table extensions, so
 * nothing else in the suite would notice if the field lost its EDT again: the
 * historical table-extension defect wrote the field with NO <ExtendedDataType> (the
 * bridge reads {type, edt}, the caller sent {fieldType, extendedDataType}) and still
 * built clean, which is why the sibling case L2-table-extension has to ignore that
 * very path. These assertions pin what the live 2026-08-31 capture proved.
 */
describe(`${CASE_ID} — captured golden`, () => {
  const goldenDir = path.join(REPO_ROOT, 'eval', 'goldens', CASE_ID);
  const files = fs.existsSync(goldenDir)
    ? fs.readdirSync(goldenDir).filter(f => f.endsWith('.metadata.xml')).sort()
    : [];

  it('holds one AxTableExtension artifact per base table', () => {
    expect(files).toEqual([
      'InventItemGroup.ConDemoExtension.metadata.xml',
      'PaymTerm.ConDemoExtension.metadata.xml',
      'VendGroup.ConDemoExtension.metadata.xml',
    ]);
  });

  it.each(files)('%s adds EvalNoteText backed by the standard Notes EDT, in a field group, without touching a base field', (file) => {
    const xml = fs.readFileSync(path.join(goldenDir, file), 'utf8');
    expect(xml).toContain('<AxTableExtension');
    expect(xml).toContain('<Name>EvalNoteText</Name>');
    // The EDT is the load-bearing part: it is what silently vanished before.
    expect(xml).toContain('<ExtendedDataType>Notes</ExtendedDataType>');
    expect(xml).toMatch(/i:type="AxTableFieldString"/);
    // Surfaces on forms by extending the BASE table group, not by inventing a new
    // group that no container names in <DataGroup> (which renders nothing).
    expect(xml).toContain('<AxTableFieldGroupExtension>');
    expect(xml).toContain('<DataField>EvalNoteText</DataField>');
    // No base-table field may be modified.
    expect(xml).toContain('<FieldModifications />');
  });
});
