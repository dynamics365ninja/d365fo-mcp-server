/**
 * Committed goldens must be documents the platform can actually read in full.
 *
 * A golden is the oracle: whatever it contains is what a faithful rerun is
 * scored against. So a golden captured from a defective writer does not just sit
 * there — it makes the defect the expected answer, and a later fix reads as a
 * regression.
 *
 * Both checks here were written after that happened. The 2026-09-01 writer fixes
 * (#984) changed form scaffolding in two ways, and eight committed goldens
 * encoded the OLD output:
 *
 *   • 18 raw-text captions across 7 goldens — every one of them a
 *     BPErrorLabelIsText the scaffold used to write.
 *   • L1-form-simplelistdetails carried the #979 defect itself: its `Overview`
 *     group put <DataGroup>/<DataSource> above <Controls>, so the metadata
 *     provider read that form two controls short. The golden was a form the
 *     compiler could not fully see.
 *
 * Nothing failed at the time — the cost would have landed on the next VM capture
 * run, as seven cases scoring golden_match: 0 against their own corrected
 * output. These two tests move that discovery to CI.
 */
import * as fs from 'fs';
import * as path from 'path';
import { describe, it, expect } from 'vitest';
import { findControlElementOrderViolations } from '../../src/validation/formControlElementOrder';
import { CAPTION_LABELS } from '../../src/utils/formPatternTemplates';

const GOLDENS = path.join(process.cwd(), 'eval', 'goldens');

/** Every committed golden artifact that contains form controls. */
function formGoldens(): Array<{ id: string; file: string; xml: string }> {
  const out: Array<{ id: string; file: string; xml: string }> = [];
  for (const caseId of fs.readdirSync(GOLDENS).sort()) {
    const dir = path.join(GOLDENS, caseId);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.metadata.xml'))) {
      const xml = fs.readFileSync(path.join(dir, file), 'utf-8');
      if (!/<(?:AxFormControl|FormControl)[\s>]/.test(xml)) continue;
      out.push({ id: caseId, file, xml });
    }
  }
  return out;
}

describe('golden form artifacts', () => {
  it('is actually looking at the goldens', () => {
    // A broken path would make both checks below pass forever.
    expect(formGoldens().length).toBeGreaterThan(15);
  });

  it('none carries an element the metadata deserializer would drop', () => {
    const broken: string[] = [];
    for (const g of formGoldens()) {
      const dropped = findControlElementOrderViolations(g.xml).filter(v => v.kind === 'order');
      for (const v of dropped) {
        broken.push(
          `${g.id}/${g.file}:${v.line} — ${v.controlType} "${v.controlName}": ` +
          `<${v.element}> before <${v.beforeElement}>`,
        );
      }
    }
    expect(
      broken,
      'A golden with an out-of-order element asserts, as the expected answer, a document the ' +
      'compiler reads differently from the file. Re-capture it, or correct the order — the ' +
      'canonical sequence per control type is in src/validation/formControlElementOrder.generated.ts.',
    ).toEqual([]);
  });

  it('none asserts a raw-text caption the templates no longer write', () => {
    // Only the captions the pattern templates own. A caption a CASE deliberately
    // sets is the case's business and is not policed here.
    const owned = new Set(Object.keys(CAPTION_LABELS).map(k => k));
    const byText: Record<string, string> = {
      General: 'general', Overview: 'overview', Header: 'header', Lines: 'lines',
      'Line details': 'lineDetails', Setup: 'setup', Summary: 'summary',
    };
    const stale: string[] = [];
    for (const g of formGoldens()) {
      for (const m of g.xml.matchAll(/<Caption>([^<@][^<]*)<\/Caption>/g)) {
        const key = byText[m[1]];
        if (key && owned.has(key)) {
          stale.push(`${g.id}/${g.file}: <Caption>${m[1]}</Caption> — expected ${CAPTION_LABELS[key as keyof typeof CAPTION_LABELS]}`);
        }
      }
    }
    expect(
      stale,
      'The pattern templates write platform label ids for these captions (#980). A golden still ' +
      'asserting the raw text scores golden_match: 0 against correct output, and enshrines a ' +
      'BPErrorLabelIsText as the expected answer.',
    ).toEqual([]);
  });
});
