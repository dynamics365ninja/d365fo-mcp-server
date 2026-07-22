/**
 * Oracle / scoring-integrity regressions from the 2026-07-21 golden-capture sweep
 * (docs/eval-sweep-findings-2026-07-21.md #24, #2, #3).
 *
 * All three are measurement defects: the oracle either failed a faithful
 * reproduction for a cosmetic reason, or reported a number that was never
 * measured. Every test here fails on the pre-fix code and is VM-free.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  evaluate, evaluateMulti, scoreRun, canonicalizePrefix, normalizeAotXml,
  artifactKey, artifactKeyMap, GOLDEN_CAPTURE_PREFIXES,
} from '../../src/eval/oracle/index';
import { resolveActualFile, buildActualArtifactsMap } from '../../src/eval/oracle/actualArtifactResolution';
import { buildReport, bpState, renderReport, type RunForReport } from '../../src/eval/improver/report';

const CASE = { id: 'L2-x', tier: 2 };
const BUILD_OK = { succeeded: true, bpWarnings: [] };
const MATCHED = { matched: true, missing: [] as string[], extra: [] as string[], changed: [] as never[] };

/** An AxClass whose method body is fixed and whose `///` prose is a parameter. */
function classXml(opts: { name: string; classDoc: string | null; methodDoc: string | null; body?: string }): string {
  const decl = [
    ...(opts.classDoc ? [`/// <summary>`, `/// ${opts.classDoc}`, `/// </summary>`] : []),
    `public class ${opts.name}`,
    '{',
    '}',
  ].join('\n');
  const src = [
    ...(opts.methodDoc ? [`    /// <summary>`, `    /// ${opts.methodDoc}`, `    /// </summary>`] : []),
    `    public static str greet()`,
    '    {',
    `        return '${opts.body ?? 'hello'}';`,
    '    }',
  ].join('\n');
  return `<?xml version="1.0" encoding="utf-8"?>
<AxClass xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
  <Name>${opts.name}</Name>
  <SourceCode>
    <Declaration><![CDATA[
${decl}
]]></Declaration>
    <Methods>
      <Method>
        <Name>greet</Name>
        <Source><![CDATA[
${src}
]]></Source>
      </Method>
    </Methods>
  </SourceCode>
</AxClass>`;
}

// ---------------------------------------------------------------------------
// #24 — `///` doc comments were load-bearing in class goldens
// ---------------------------------------------------------------------------
describe('#24 — XmlDoc prose is not load-bearing, but its PRESENCE still is', () => {
  it('two artifacts differing ONLY in `///` wording score golden_match: 1', async () => {
    const golden = classXml({
      name: 'ConDemoCompanyReader',
      classDoc: 'Provides con demo company reader functionality.',
      methodDoc: 'Reads the subject of a note from another legal entity.',
    });
    const actual = classXml({
      name: 'ConDemoCompanyReader',
      classDoc: 'Reads note subjects across legal entities.',
      methodDoc: 'Returns the subject for the given note in the given company.',
    });
    const res = await evaluate({ caseSpec: CASE, goldenXml: golden, actualXml: actual, build: BUILD_OK });
    expect(res.goldenDiff.changed).toEqual([]);
    expect(res.score.golden_match).toBe(1);
  });

  it('a doc comment run of a DIFFERENT LENGTH still matches (param/returns tags are prose too)', async () => {
    const golden = classXml({ name: 'C', classDoc: 'One line.', methodDoc: 'A' });
    const actualXml = classXml({ name: 'C', classDoc: 'One line.', methodDoc: 'A' })
      .replace('    /// A\n', '    /// A\n    /// <param name = "_x">More prose.</param>\n    /// <returns>Even more.</returns>\n');
    const res = await evaluate({ caseSpec: CASE, goldenXml: golden, actualXml, build: BUILD_OK });
    expect(res.score.golden_match).toBe(1);
  });

  it('ANTI-MASKING: a MISSING doc comment is still a diff (BPXmlDocNoDocumentationComments)', async () => {
    // Stripping `///` lines outright — the direction the finding suggested — would
    // make these two compare equal, hiding exactly the difference the BP rule
    // measures. Collapsing keeps presence load-bearing.
    const golden = classXml({ name: 'C', classDoc: 'Documented.', methodDoc: 'Documented.' });
    const actual = classXml({ name: 'C', classDoc: null, methodDoc: null });
    const res = await evaluate({ caseSpec: CASE, goldenXml: golden, actualXml: actual, build: BUILD_OK });
    expect(res.score.golden_match).toBe(0);
  });

  it('ANTI-MASKING: real code differences are untouched by the doc-comment collapse', async () => {
    const golden = classXml({ name: 'C', classDoc: 'Same.', methodDoc: 'Same.', body: 'hello' });
    const actual = classXml({ name: 'C', classDoc: 'Same.', methodDoc: 'Same.', body: 'goodbye' });
    const res = await evaluate({ caseSpec: CASE, goldenXml: golden, actualXml: actual, build: BUILD_OK });
    expect(res.score.golden_match).toBe(0);
  });

  it('a `//` (non-XmlDoc) comment is left alone — only `///` runs collapse', async () => {
    const base = classXml({ name: 'C', classDoc: null, methodDoc: null });
    const withComment = base.replace("        return 'hello';", "        // explain\n        return 'hello';");
    const res = await evaluate({ caseSpec: CASE, goldenXml: base, actualXml: withComment, build: BUILD_OK });
    expect(res.score.golden_match).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// #2 — golden filename / capture-prefix drift
// ---------------------------------------------------------------------------
describe('#2 — prefix resolution is tolerant of both capture prefixes', () => {
  it('GOLDEN_CAPTURE_PREFIXES canonicalises the `Con`-captured corpus (a single "Contoso" never could)', () => {
    // `Con` + `t` is lowercase, so "Contoso" cannot match a Con-prefixed identifier:
    // the golden side of every diff was left literal.
    expect(canonicalizePrefix('ConDemoEnumExtProbe', 'Contoso')).toBe('ConDemoEnumExtProbe');
    expect(canonicalizePrefix('ConDemoEnumExtProbe', GOLDEN_CAPTURE_PREFIXES)).toBe('PFXDemoEnumExtProbe');
    expect(canonicalizePrefix('CustGroup.ConExtension', GOLDEN_CAPTURE_PREFIXES)).toBe('CustGroup.PFXExtension');
  });

  it('longest-first: "Contoso" is consumed before "Con" can split it', () => {
    expect(canonicalizePrefix('ContosoDemoNote', GOLDEN_CAPTURE_PREFIXES)).toBe('PFXDemoNote');
    expect(canonicalizePrefix('ContosoDemoNote ConDemoNote', GOLDEN_CAPTURE_PREFIXES))
      .toBe('PFXDemoNote PFXDemoNote');
  });

  it('does not touch an incidental word that merely starts with the token', () => {
    // "Contract"/"Consume" continue in lowercase; "Convert" does not either.
    expect(canonicalizePrefix('DataContract Consume Convert', GOLDEN_CAPTURE_PREFIXES))
      .toBe('DataContract Consume Convert');
  });

  it('a Con-captured golden matches a Con-produced actual under the DEFAULT prefixes', async () => {
    const xml = classXml({ name: 'ConDemoEnumExtProbe', classDoc: 'x', methodDoc: 'y' });
    const res = await evaluate({
      caseSpec: CASE, goldenXml: xml, actualXml: xml, build: BUILD_OK,
      goldenPrefix: GOLDEN_CAPTURE_PREFIXES, actualPrefix: GOLDEN_CAPTURE_PREFIXES,
    });
    expect(res.score.golden_match).toBe(1);
  });

  it('a Con-captured golden matches the SAME object produced under a Demo session', async () => {
    // Same logical object "NoteReader": captured as ConNoteReader, reproduced by a
    // session configured with EXTENSION_PREFIX=Demo as DemoNoteReader.
    const golden = classXml({ name: 'ConNoteReader', classDoc: 'x', methodDoc: 'y' });
    const actual = classXml({ name: 'DemoNoteReader', classDoc: 'x', methodDoc: 'y' });
    const res = await evaluate({
      caseSpec: CASE, goldenXml: golden, actualXml: actual, build: BUILD_OK,
      goldenPrefix: GOLDEN_CAPTURE_PREFIXES, actualPrefix: 'Demo',
    });
    expect(res.score.golden_match).toBe(1);
  });

  it('the mismatch the sweep hit — one side canonicalised, the other not — is gone by default', async () => {
    const xml = classXml({ name: 'ConDemoEnumExtProbe', classDoc: 'x', methodDoc: 'y' });
    const skewed = await evaluate({
      caseSpec: CASE, goldenXml: xml, actualXml: xml, build: BUILD_OK,
      goldenPrefix: 'Con', actualPrefix: 'Contoso',
    });
    // The documented symptom: golden="PFXDemoEnumExtProbe" actual="ConDemoEnumExtProbe".
    expect(skewed.goldenDiff.changed.some(c =>
      c.expected === 'PFXDemoEnumExtProbe' && c.actual === 'ConDemoEnumExtProbe')).toBe(true);
    const defaults = await evaluate({
      caseSpec: CASE, goldenXml: xml, actualXml: xml, build: BUILD_OK,
      goldenPrefix: GOLDEN_CAPTURE_PREFIXES, actualPrefix: GOLDEN_CAPTURE_PREFIXES,
    });
    expect(defaults.score.golden_match).toBe(1);
  });
});

describe('#2 — legacy golden FILENAMES pair with the actual files the VM produced', () => {
  it('artifactKey reduces both filename conventions to the same logical key', () => {
    const k = (n: string) => artifactKey(n, GOLDEN_CAPTURE_PREFIXES);
    expect(k('DemoEnumExtProbe.AxClass.metadata.xml')).toBe(k('ConDemoEnumExtProbe.metadata.xml'));
    expect(k('DemoNoteFormatter.AxClass.metadata.xml')).toBe(k('ConDemoNoteFormatter.metadata.xml'));
    expect(k('NumberSeqModule.AxEnumExtension.metadata.xml')).toBe(k('NumberSeqModule.ConExtension.metadata.xml'));
    // …and keeps genuinely different artifacts apart.
    expect(k('ConDemoNoteReportAdv.metadata.xml')).not.toBe(k('ConDemoNoteReportAdv.menuitem.metadata.xml'));
    expect(k('CustGroupFormExt.ConExtension.metadata.xml')).not.toBe(k('CustGroupTableExt.ConExtension.metadata.xml'));
  });

  it('artifactKeyMap refuses a lossy key that would collide inside one side', () => {
    const names = ['CustGroup.metadata.xml', 'CustGroup.ConExtension.metadata.xml'];
    const keys = artifactKeyMap(names, GOLDEN_CAPTURE_PREFIXES);
    // Both would reduce to "CustGroup.metadata.xml" — so both keep their raw name
    // instead of an extension silently diffing against its base object.
    expect(keys.get('CustGroup.metadata.xml')).toBe('CustGroup.metadata.xml');
    expect(keys.get('CustGroup.ConExtension.metadata.xml')).toBe('CustGroup.ConExtension.metadata.xml');
  });

  it('resolveActualFile pairs a legacy golden name with the on-disk actual', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oracle-artifact-'));
    try {
      fs.writeFileSync(path.join(dir, 'ConDemoEnumExtProbe.metadata.xml'), '<AxClass/>');
      const hit = resolveActualFile(dir, 'DemoEnumExtProbe.AxClass.metadata.xml', GOLDEN_CAPTURE_PREFIXES, GOLDEN_CAPTURE_PREFIXES);
      expect(hit && path.basename(hit)).toBe('ConDemoEnumExtProbe.metadata.xml');
      const miss = resolveActualFile(dir, 'SomethingElse.AxClass.metadata.xml', GOLDEN_CAPTURE_PREFIXES, GOLDEN_CAPTURE_PREFIXES);
      expect(miss).toBeUndefined();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('end-to-end: a legacy-named multi-artifact golden dir scores golden_match: 1', async () => {
    const probe = classXml({ name: 'ConDemoEnumExtProbe', classDoc: 'a', methodDoc: 'b' });
    const res = await evaluateMulti({
      caseSpec: CASE,
      goldenArtifacts: { 'DemoEnumExtProbe.AxClass.metadata.xml': probe },
      actualArtifacts: { 'ConDemoEnumExtProbe.metadata.xml': probe },
      build: BUILD_OK,
      goldenPrefix: GOLDEN_CAPTURE_PREFIXES,
      actualPrefix: GOLDEN_CAPTURE_PREFIXES,
    });
    expect(res.goldenDiff.missing).toEqual([]);
    expect(res.goldenDiff.extra).toEqual([]);
    expect(res.score.golden_match).toBe(1);
  });

  it('buildActualArtifactsMap keeps a genuinely absent artifact absent (no false pairing)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oracle-artifact-'));
    try {
      fs.writeFileSync(path.join(dir, 'ConDemoOther.metadata.xml'), '<AxClass/>');
      const { actualArtifacts } = buildActualArtifactsMap(
        dir, ['DemoEnumExtProbe.AxClass.metadata.xml'], GOLDEN_CAPTURE_PREFIXES, GOLDEN_CAPTURE_PREFIXES,
      );
      expect(actualArtifacts['DemoEnumExtProbe.AxClass.metadata.xml']).toBe('');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// #3 — bp_clean must distinguish "clean" from "never checked"
// ---------------------------------------------------------------------------
describe('#3 — bp_clean has three states, not two', () => {
  it('no BP evidence scores null, NOT 1', () => {
    expect(scoreRun({ build: { succeeded: true }, goldenDiff: MATCHED, tier: 2 }).bp_clean).toBeNull();
  });

  it('an empty warning LIST still means "ran and found nothing" → 1', () => {
    expect(scoreRun({ build: { succeeded: true, bpWarnings: [] }, goldenDiff: MATCHED, tier: 2 }).bp_clean).toBe(1);
    expect(scoreRun({ build: { succeeded: true, bpWarnings: [{}] }, goldenDiff: MATCHED, tier: 2 }).bp_clean).toBe(0);
  });

  it('an unchecked run does not silently become a golden-matching PASS on the BP dimension', () => {
    const s = scoreRun({ build: { succeeded: true }, goldenDiff: MATCHED, tier: 2 });
    expect(s).toEqual({ build: 1, bp_clean: null, golden_match: 1, systest: null, tier_weight: 2 });
  });
});

describe('#3 — the scoreboard refuses to average incomparable BP records', () => {
  const run = (over: Partial<RunForReport>): RunForReport =>
    ({ case_id: 'c', tier: 2, classification: 'PASS', score: { build: 1, golden_match: 1 }, ...over });

  it('classifies the three provenance states', () => {
    expect(bpState(run({ build: { bp_checked: true }, score: { bp_clean: 1 } }))).toBe('clean');
    expect(bpState(run({ build: { bp_checked: true }, score: { bp_clean: 0 } }))).toBe('dirty');
    // Legacy record, no provenance flag: a 0 proves xppbp ran; a 1 proves nothing.
    expect(bpState(run({ score: { bp_clean: 0 } }))).toBe('dirty');
    expect(bpState(run({ score: { bp_clean: 1 } }))).toBe('unverified');
    expect(bpState(run({ score: { bp_clean: null } }))).toBe('unverified');
    expect(bpState(run({}))).toBe('unverified');
  });

  it('the BP pass-rate is taken over verified runs only, and the rest are counted', () => {
    const r = buildReport([
      run({ case_id: 'a', build: { bp_checked: true }, score: { bp_clean: 1, build: 1, golden_match: 1 } }),
      run({ case_id: 'b', build: { bp_checked: true }, score: { bp_clean: 0, build: 1, golden_match: 1 } }),
      run({ case_id: 'c', score: { bp_clean: 1, build: 1, golden_match: 1 } }),   // legacy, unverifiable
      run({ case_id: 'd', score: { bp_clean: null, build: 1, golden_match: 1 } }), // BP not run
    ]);
    expect(r.bp_verified).toBe(2);
    expect(r.bp_unverified).toBe(2);
    // 1 of 2 VERIFIED runs was clean. The legacy 1 is NOT counted as a pass —
    // pre-fix this reported 2/4.
    expect(r.pass_at_bp_clean).toBe(0.5);
  });

  it('reports n/a rather than 0% when nothing carries BP evidence', () => {
    const r = buildReport([run({ case_id: 'a', score: { bp_clean: 1, build: 1, golden_match: 1 } })]);
    expect(r.pass_at_bp_clean).toBeNull();
    const text = renderReport(r);
    expect(text).toContain('bp=n/a');
    expect(text).toContain('unverified');
  });
});

// ---------------------------------------------------------------------------
// Guard: the committed corpus still normalises under the new default prefixes.
// ---------------------------------------------------------------------------
describe('committed goldens under the tolerant default prefixes', () => {
  const GOLDENS = path.resolve(__dirname, '..', '..', 'eval', 'goldens');
  const files = fs.existsSync(GOLDENS)
    ? fs.readdirSync(GOLDENS).flatMap(d => {
      const dir = path.join(GOLDENS, d);
      if (!fs.statSync(dir).isDirectory()) return [];
      return fs.readdirSync(dir).filter(f => f.endsWith('.metadata.xml')).map(f => path.join(dir, f));
    })
    : [];

  it('every golden still self-diffs clean with GOLDEN_CAPTURE_PREFIXES applied', async () => {
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const xml = fs.readFileSync(f, 'utf8');
      const m = await normalizeAotXml(xml, [], GOLDEN_CAPTURE_PREFIXES);
      expect(m.size, path.basename(f)).toBeGreaterThan(0);
    }
  });

  it('no golden DIR contains two artifacts whose logical keys collide', () => {
    const dirs = fs.existsSync(GOLDENS) ? fs.readdirSync(GOLDENS) : [];
    for (const d of dirs) {
      const dir = path.join(GOLDENS, d);
      if (!fs.statSync(dir).isDirectory()) continue;
      const names = fs.readdirSync(dir).filter(f => f.endsWith('.metadata.xml'));
      const keys = new Set(names.map(n => artifactKey(n, GOLDEN_CAPTURE_PREFIXES)));
      expect(keys.size, `${d}: ${names.join(', ')}`).toBe(names.length);
    }
  });
});
