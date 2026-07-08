/**
 * Case-specific golden-diff tolerances (docs/AGENT_EVAL_LOOP.md §6.2 —
 * "optional per-case ignore-list / tolerances for legitimately variable
 * nodes"). VM-free.
 *
 * Regression: eval/corpus/runs/2026-07-07T10__L2-table-extension__cb1b73d.json
 * was classified TOOL_DEFECT for a single golden_diff.changed entry —
 * NotePriority's ExtendedDataType was "Priority" (actual) vs "Counter"
 * (golden). The case instruction only says "use suggest_edt / the index to
 * pick an APPROPRIATE integer or string EDT — do NOT invent a new EDT"; it
 * never mandates a specific EDT. Both "Priority" and "Counter" are real,
 * standard D365FO EDTs (confirmed via data/xpp-metadata.db — 23,942 real EDT
 * symbols indexed, both present) — "Priority" is arguably the more
 * semantically correct pick for a field literally named "NotePriority"
 * (Counter is normally used for auto-incrementing line/sequence numbers).
 * The build was clean (0 BP warnings, not just thin evidence — a real empty
 * array) and every other field of the golden matched byte-for-byte.
 *
 * This was not a tool defect — the golden pinned one arbitrary EDT choice
 * for an instruction that deliberately leaves the EDT choice up to the
 * agent's own grounded judgement (suggest_edt), so the oracle needs a
 * tolerance for it, not the generator a fix. Root cause: an under-specified
 * case pinned by an over-specified golden. Fixed by adding
 * "AxTableExtension/Fields/AxTableField/ExtendedDataType" to the case's own
 * `ignore` list — the documented mechanism for exactly this situation.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { evaluate } from '../../src/eval/oracle/index';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');

function readCase(caseId: string) {
  return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'eval', 'cases', `${caseId}.json`), 'utf8'));
}

function readGolden(caseId: string, file: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, 'eval', 'goldens', caseId, file), 'utf8');
}

describe('L2-table-extension: NotePriority EDT choice is a legitimate tolerance, not a defect', () => {
  const caseSpec = readCase('L2-table-extension');
  const goldenXml = readGolden('L2-table-extension', 'CustGroup.ConExtension.metadata.xml');

  it('the case ignore list includes the ExtendedDataType tolerance', () => {
    expect(caseSpec.ignore).toContain('AxTableExtension/Fields/AxTableField/ExtendedDataType');
  });

  it('golden_match=1 when the actual uses a DIFFERENT (but equally valid) EDT than the golden (regression: L2-table-extension, Priority vs Counter)', async () => {
    const actualXml = goldenXml.replace('<ExtendedDataType>Counter</ExtendedDataType>', '<ExtendedDataType>Priority</ExtendedDataType>');
    expect(actualXml).not.toBe(goldenXml); // sanity: the substitution actually happened

    const res = await evaluate({
      caseSpec: { id: caseSpec.id, tier: caseSpec.tier, ignore: caseSpec.ignore },
      actualXml,
      goldenXml,
      build: { succeeded: true, bpWarnings: [] },
    });
    expect(res.goldenDiff.changed).toEqual([]);
    expect(res.score.golden_match).toBe(1);
  });

  it('a genuinely wrong field NAME (not just EDT) still correctly mismatches — the tolerance is narrowly scoped', async () => {
    const actualXml = goldenXml.replace(/NotePriority/g, 'NoteUrgency');
    const res = await evaluate({
      caseSpec: { id: caseSpec.id, tier: caseSpec.tier, ignore: caseSpec.ignore },
      actualXml,
      goldenXml,
      build: { succeeded: true, bpWarnings: [] },
    });
    expect(res.score.golden_match).toBe(0);
  });

  it('a genuinely wrong field TYPE (i:type, not ExtendedDataType) still correctly mismatches', async () => {
    const actualXml = goldenXml.replace('i:type="AxTableFieldInt"', 'i:type="AxTableFieldString"');
    const res = await evaluate({
      caseSpec: { id: caseSpec.id, tier: caseSpec.tier, ignore: caseSpec.ignore },
      actualXml,
      goldenXml,
      build: { succeeded: true, bpWarnings: [] },
    });
    expect(res.score.golden_match).toBe(0);
  });
});
