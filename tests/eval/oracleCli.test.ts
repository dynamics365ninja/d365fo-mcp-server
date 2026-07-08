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
import { buildActualArtifactsMap } from '../../src/eval/oracle/actualArtifactResolution';

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
