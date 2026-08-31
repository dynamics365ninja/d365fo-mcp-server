/**
 * A golden must contain every attribute its own case instruction names.
 *
 * The write path silently dropped multi-line method attribute blocks: the class
 * still compiled (attributes are syntactically optional), the build was green,
 * and the golden was captured and committed as proof. It took an eval run
 * comparing intent against output to notice — for
 * L3-sysoperation-dialog-attributes, a case whose entire subject is "the dialog
 * is produced only by attributes on the contract", whose golden contained none
 * of the five method-level attributes its README describes.
 *
 * The bug is fixed (tests/tools/multiLineAttributeSplit.test.ts). This is the
 * cheap standing check that the EVIDENCE stays honest, because the failure mode
 * is silence: a golden that quietly lost the thing it exists to demonstrate
 * still passes every other gate, and goes on being counted as proof.
 *
 * Deliberately crude — it matches `[SomeAttribute` in the instruction against
 * the golden text as a whole, without caring whether the attribute belongs on
 * the class or a method. A cleverer check would need to model X++ placement
 * rules; this one is unambiguous about what it means, and it would have caught
 * the real defect.
 */
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

const CASES = path.join(process.cwd(), 'eval', 'cases');
const GOLDENS = path.join(process.cwd(), 'eval', 'goldens');

interface Finding { caseId: string; missing: string[] }

function auditGoldens(): { checked: number; findings: Finding[] } {
  const findings: Finding[] = [];
  let checked = 0;

  for (const file of fs.readdirSync(CASES)) {
    if (!file.endsWith('.json') || file === 'schema.json') continue;
    const spec = JSON.parse(fs.readFileSync(path.join(CASES, file), 'utf8'));

    const demanded = [
      ...new Set(
        [...String(spec.instruction ?? '').matchAll(/\[([A-Za-z]+Attribute)\b/g)].map(m => m[1]),
      ),
    ];
    if (demanded.length === 0) continue;

    const dir = path.join(GOLDENS, spec.id);
    if (!fs.existsSync(dir)) continue;

    let golden = '';
    for (const f of fs.readdirSync(dir)) {
      if (f.toLowerCase().endsWith('.xml')) golden += fs.readFileSync(path.join(dir, f), 'utf8');
    }
    if (!golden) continue;

    checked++;
    // `Attribute` is optional in X++ usage ([DataMember] === [DataMemberAttribute]),
    // so accept either spelling.
    const missing = demanded.filter(
      a => !golden.includes(a) && !golden.includes(a.replace(/Attribute$/, '')),
    );
    if (missing.length) findings.push({ caseId: spec.id, missing });
  }

  return { checked, findings };
}

describe('golden artifacts keep the attributes their case asks for', () => {
  it('no captured golden is missing an attribute its instruction names', () => {
    const { findings } = auditGoldens();
    const report = findings.map(f => `${f.caseId}: ${f.missing.join(', ')}`);
    expect(
      report,
      'A golden lost an attribute its own instruction demands. Attributes are syntactically ' +
      'optional, so the build stays green and nothing else notices — check the write path ' +
      'before re-capturing, or the re-capture will lose them again.',
    ).toEqual([]);
  });

  it('actually examined a meaningful number of goldens', () => {
    // Without this, a broken path expression would make the check pass forever.
    expect(auditGoldens().checked).toBeGreaterThan(5);
  });
});
