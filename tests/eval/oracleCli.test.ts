/**
 * src/eval/oracle/cli.ts's multi-artifact (`--actual-dir`) artifact-map
 * building — VM-free, real temp directories (no fs mocking needed).
 *
 * Regression (eval/corpus/runs/2026-07-06T18__L1-form-basic__f2c8bfe.json,
 * finding #3): `actualArtifacts` used to be keyed by the GOLDEN's own
 * filename even when the resolved actual file had a DIFFERENT literal
 * prefix (prefix-agnostic matching is the whole point of resolveActualFile).
 * evaluateMulti/normalizeMultiArtifact then canonicalises each artifact KEY
 * against `actualPrefix` — a key that's still the golden's literal name
 * doesn't contain actualPrefix, so canonicalisation silently no-ops, and the
 * golden side's key (correctly canonicalised) never matches. Every path in
 * the artifact then showed up as wholesale `missing` + `extra` even when the
 * content was byte-identical. Confirmed by the implementer re-running the
 * same two artifacts through the single-file oracle path (no --actual-dir),
 * which produced clean, accurate diffs.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';
import { buildActualArtifactsMap, listActualArtifactFiles } from '../../src/eval/oracle/actualArtifactResolution';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const CLI = path.join(REPO_ROOT, 'src', 'eval', 'oracle', 'cli.ts');

/** Run the oracle CLI (VM-free) as a subprocess; capture exit code + combined output
 *  (the CLI prints its scorecard to stderr, so both streams are merged). */
function runOracleCli(args: string[]): { status: number; out: string } {
  const r = spawnSync('npx', ['tsx', CLI, ...args], {
    cwd: REPO_ROOT, encoding: 'utf8', shell: true,
  });
  return { status: r.status ?? 1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

describe('buildActualArtifactsMap', () => {
  let actualDir: string;

  beforeEach(() => {
    actualDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oracle-cli-test-'));
  });

  afterEach(() => {
    fs.rmSync(actualDir, { recursive: true, force: true });
  });

  it('keys a resolved actual file by ITS OWN basename, not the golden filename, when prefixes differ', () => {
    // Golden expects "ContosoMyContract.metadata.xml"; the actual VM session ran under
    // a DIFFERENT EXTENSION_PREFIX ("Demo") and produced "DemoMyContract.metadata.xml".
    const actualContent = '<AxClass><Name>DemoMyContract</Name></AxClass>';
    fs.writeFileSync(path.join(actualDir, 'DemoMyContract.metadata.xml'), actualContent, 'utf8');

    const { actualArtifacts, matchedActualFiles } = buildActualArtifactsMap(
      actualDir,
      ['ContosoMyContract.metadata.xml'],
      'Contoso',
      'Demo',
    );

    // The regression: this used to be keyed 'ContosoMyContract.metadata.xml' (the golden's
    // name), which desyncs prefix-canonicalisation downstream. Must be the actual
    // file's own basename instead.
    expect(Object.keys(actualArtifacts)).toEqual(['DemoMyContract.metadata.xml']);
    expect(actualArtifacts['DemoMyContract.metadata.xml']).toBe(actualContent);
    expect(actualArtifacts['ContosoMyContract.metadata.xml']).toBeUndefined();
    expect(matchedActualFiles.has('DemoMyContract.metadata.xml')).toBe(true);
  });

  it('keeps the golden filename as the key (empty content) when no actual file resolves at all', () => {
    const { actualArtifacts, matchedActualFiles } = buildActualArtifactsMap(
      actualDir, // empty directory — nothing to match
      ['ContosoMissingArtifact.metadata.xml'],
      'Contoso',
      'Demo',
    );
    expect(actualArtifacts).toEqual({ 'ContosoMissingArtifact.metadata.xml': '' });
    expect(matchedActualFiles.size).toBe(0);
  });

  it('a direct filename match (same prefix session) keys by that same name', () => {
    const content = '<AxClass><Name>ContosoMyContract</Name></AxClass>';
    fs.writeFileSync(path.join(actualDir, 'ContosoMyContract.metadata.xml'), content, 'utf8');

    const { actualArtifacts, matchedActualFiles } = buildActualArtifactsMap(
      actualDir,
      ['ContosoMyContract.metadata.xml'],
      'Contoso',
      'Contoso',
    );
    expect(actualArtifacts).toEqual({ 'ContosoMyContract.metadata.xml': content });
    expect(matchedActualFiles.has('ContosoMyContract.metadata.xml')).toBe(true);
  });

  it('handles multiple golden artifacts independently, some matched under a different prefix, some missing', () => {
    fs.writeFileSync(path.join(actualDir, 'DemoContract.metadata.xml'), 'CONTRACT', 'utf8');
    // No file for "Controller" at all.

    const { actualArtifacts, matchedActualFiles } = buildActualArtifactsMap(
      actualDir,
      ['ContosoContract.metadata.xml', 'ContosoController.metadata.xml'],
      'Contoso',
      'Demo',
    );
    expect(actualArtifacts).toEqual({
      'DemoContract.metadata.xml': 'CONTRACT',
      'ContosoController.metadata.xml': '',
    });
    expect(matchedActualFiles).toEqual(new Set(['DemoContract.metadata.xml']));
  });
});

/**
 * Regression: the scorer used to crash with a raw `ENOENT: scandir eval/goldens/<caseId>`
 * for any case whose golden dir is absent/empty — which blocks scoring EVERY `golden_pending`
 * case, not just one. Corpus evidence:
 *   eval/corpus/runs/2026-07-21T__L3-custom-service-basic__a2a4131.json  (finding (b),
 *   evidence_refs -> "npm run eval:score ... -> ENOENT scandir eval/goldens/L3-custom-service-basic",
 *   "src/eval/oracle/cli.ts:66 listGoldenArtifacts").
 * Class: TOOL_DEFECT (harness/oracle). The scorer must degrade gracefully — score `build`
 * and `bp_clean` normally and report golden_match: null (not 0, not a crash).
 *
 * SYNTHETIC BY CONSTRUCTION. These tests used to run against whichever case in
 * eval/cases/ still carried `golden_pending: true`. That pinned the live catalog's
 * CONTENTS, not the CLI's behaviour, and the premise expired the moment the last
 * golden was captured (2026-08-31: 0 of 120 cases pending) — the suite then failed
 * by design. The behaviour it protects has NOT expired: every newly authored case
 * is golden_pending until its golden is captured on the VM (§6.4). So the case
 * spec, the missing golden and the actual dir are all built here, in a temp dir,
 * and handed to the CLI via `--case-spec`. The suite is now independent of the
 * catalog in BOTH directions — zero pending cases and fifty pending cases behave
 * identically — and it writes nothing into eval/.
 */
describe('oracle CLI degrades gracefully when the golden is unavailable (golden_pending)', () => {
  /** Deliberately un-catalogued: no eval/cases/ spec and no eval/goldens/ dir may exist for it. */
  const SYNTHETIC_CASE_ID = 'L2-synthetic-oracle-cli-probe';

  let tmp: string;
  let actualDir: string;

  /** Write a synthetic case spec (schema-shaped) to the temp dir and return its path. */
  function writeCaseSpec(overrides: Record<string, unknown> = {}): string {
    const spec = {
      id: SYNTHETIC_CASE_ID,
      title: 'Synthetic case spec for the oracle CLI golden-unavailable path',
      tier: 2,
      instruction: 'Not executed — this spec only drives the VM-free scorer.',
      target_artifact_types: ['AxClass'],
      golden_path: `eval/goldens/${SYNTHETIC_CASE_ID}`,
      golden_pending: true,
      ...overrides,
    };
    const file = path.join(tmp, 'case.json');
    fs.writeFileSync(file, JSON.stringify(spec, null, 2), 'utf8');
    return file;
  }

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oracle-pending-'));
    actualDir = path.join(tmp, 'actual');
    fs.mkdirSync(actualDir);
    // The synthetic id must stay un-catalogued, or these tests would silently start
    // scoring a real golden instead of the golden-unavailable path.
    expect(fs.existsSync(path.join(REPO_ROOT, 'eval', 'goldens', SYNTHETIC_CASE_ID))).toBe(false);
    expect(fs.existsSync(path.join(REPO_ROOT, 'eval', 'cases', `${SYNTHETIC_CASE_ID}.json`))).toBe(false);
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('reports golden_match: null and exits 0 (clean build) instead of throwing ENOENT scandir', () => {
    const { status, out } = runOracleCli([
      SYNTHETIC_CASE_ID, '--case-spec', writeCaseSpec(), '--actual-dir', actualDir,
    ]);
    expect(out).not.toMatch(/ENOENT/);
    expect(out).not.toMatch(/scandir/);
    expect(out).toMatch(/"golden_match":null/);
    expect(out).toMatch(/golden_pending/);
    expect(status).toBe(0);
  }, 60_000);

  it('still scores build/bp_clean (golden_match: null) and exits 1 when the build failed', () => {
    const { status, out } = runOracleCli([
      SYNTHETIC_CASE_ID, '--case-spec', writeCaseSpec(), '--actual-dir', actualDir, '--build-failed',
    ]);
    expect(out).not.toMatch(/ENOENT/);
    expect(out).toMatch(/"build":0/);
    expect(out).toMatch(/"golden_match":null/);
    expect(status).toBe(1);
  }, 60_000);

  it('degrades the same way for a NON-pending case whose golden dir is simply absent', () => {
    // The second half of the `goldenUnavailable` condition: the flag is not the only
    // way to reach this branch, and a missing golden dir must not crash the scorer either.
    const { status, out } = runOracleCli([
      SYNTHETIC_CASE_ID, '--case-spec', writeCaseSpec({ golden_pending: false }),
      '--actual-dir', actualDir,
    ]);
    expect(out).not.toMatch(/ENOENT/);
    expect(out).toMatch(/"golden_match":null/);
    expect(out).toMatch(/no \*\.metadata\.xml golden/);
    expect(status).toBe(0);
  }, 60_000);

  /**
   * ORACLE DEFECT (corpus: eval/corpus/runs/2026-08-31T22__L4-headerlines-document-slice__278eee3.json,
   * root_cause_hypothesis -> "ORACLE DEFECT"): the golden-unavailable + `--actual-dir`
   * branch listed `generated_artifacts` with its own `*.metadata.xml`-only filter,
   * while an actual dir idiomatically holds the bare `<Name>.xml` files a VM session
   * wrote (that is what `--actual-dir <Model>/<Model>/AxClass` points at, and what
   * every other consumer of an actual dir already accepts). Every golden-CAPTURE run —
   * i.e. exactly the runs that take this branch — therefore recorded an empty artifact
   * list, and the operator had to reconstruct it by hand.
   */
  it('lists the bare AOT *.xml files a VM session writes as generated_artifacts, not just *.metadata.xml', () => {
    fs.writeFileSync(path.join(actualDir, 'ConDemoProbe.xml'), '<AxClass><Name>ConDemoProbe</Name></AxClass>', 'utf8');
    fs.writeFileSync(path.join(actualDir, 'ConDemoOther.metadata.xml'), '<AxClass><Name>ConDemoOther</Name></AxClass>', 'utf8');
    fs.writeFileSync(path.join(actualDir, 'README.md'), 'not an artifact', 'utf8');

    const { status, out } = runOracleCli([
      SYNTHETIC_CASE_ID, '--case-spec', writeCaseSpec(), '--actual-dir', actualDir,
    ]);
    const line = out.split(/\r?\n/).find(l => l.startsWith('generated_artifacts'));
    expect(line, `no generated_artifacts line in:\n${out}`).toBeDefined();
    expect(line).toContain('ConDemoProbe.xml');       // the bare AOT name — the defect
    expect(line).toContain('ConDemoOther.metadata.xml');
    expect(line).not.toContain('README.md');
    expect(line).toMatch(/\(2\)/);
    expect(status).toBe(0);
  }, 60_000);
});

/**
 * The one filter both consumers of an actual dir share. It used to be duplicated —
 * the resolver accepted `*.xml`, the CLI's capture path accepted only
 * `*.metadata.xml` — which is how the empty-`generated_artifacts` defect above
 * survived: two copies of "what counts as an artifact" that could drift apart.
 */
describe('listActualArtifactFiles', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oracle-list-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('accepts both the bare AOT and the committed-golden shape, sorted, and nothing else', () => {
    for (const f of ['b.xml', 'a.metadata.xml', 'c.XML', 'notes.md', 'ConDemo.en-US.label.txt']) {
      fs.writeFileSync(path.join(dir, f), 'x', 'utf8');
    }
    expect(listActualArtifactFiles(dir)).toEqual(['a.metadata.xml', 'b.xml', 'c.XML']);
  });

  it('returns [] for a directory that does not exist (never throws ENOENT)', () => {
    expect(listActualArtifactFiles(path.join(dir, 'nope'))).toEqual([]);
  });
});
