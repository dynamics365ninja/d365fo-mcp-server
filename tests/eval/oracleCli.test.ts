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
import { buildActualArtifactsMap } from '../../src/eval/oracle/actualArtifactResolution';

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
 */
describe('oracle CLI degrades gracefully when the golden is unavailable (golden_pending)', () => {
  // Pick whichever case is still golden_pending rather than pinning one by name: goldens get
  // captured on the VM one at a time (§6.4), so a hardcoded id turns every capture into a
  // spurious test failure. The premise is "some case is pending", not "this case is pending".
  const casesDir = path.join(REPO_ROOT, 'eval', 'cases');
  const PENDING_CASE = fs
    .readdirSync(casesDir)
    .filter((f) => f.endsWith('.json') && f !== 'schema.json')
    .sort()
    .find((f) => JSON.parse(fs.readFileSync(path.join(casesDir, f), 'utf8')).golden_pending === true)
    ?.replace(/\.json$/, '');

  let emptyDir: string;

  beforeEach(() => {
    // Once every golden is captured this path can no longer be exercised against the real
    // catalog. Fail loudly rather than silently passing on a premise that no longer holds.
    expect(
      PENDING_CASE,
      'no case is golden_pending any more — rewrite this suite against a synthetic case spec',
    ).toBeDefined();
    emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oracle-pending-'));
  });

  afterEach(() => {
    fs.rmSync(emptyDir, { recursive: true, force: true });
  });

  it('reports golden_match: null and exits 0 (clean build) instead of throwing ENOENT scandir', () => {
    const { status, out } = runOracleCli([PENDING_CASE, '--actual-dir', emptyDir]);
    expect(out).not.toMatch(/ENOENT/);
    expect(out).not.toMatch(/scandir/);
    expect(out).toMatch(/"golden_match":null/);
    expect(status).toBe(0);
  }, 60_000);

  it('still scores build/bp_clean (golden_match: null) and exits 1 when the build failed', () => {
    const { status, out } = runOracleCli([PENDING_CASE, '--actual-dir', emptyDir, '--build-failed']);
    expect(out).not.toMatch(/ENOENT/);
    expect(out).toMatch(/"build":0/);
    expect(out).toMatch(/"golden_match":null/);
    expect(status).toBe(1);
  }, 60_000);
});
