/**
 * Golden integrity / oracle regression gate (Phase 3, VM-free).
 *
 * Loads every committed golden under eval/goldens/, normalizes it with its case's
 * ignore list, and asserts it is non-empty and self-diffs to a clean match. This
 * locks the goldens in as regression anchors: a malformed golden commit OR a
 * change to normalize.ts that destabilizes diffing will fail here in CI — no VM
 * needed. (Re-generation regression still requires the VM; that runs separately.)
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { normalizeAotXml, diffNormalized } from '../../src/eval/oracle/index';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const GOLDENS_DIR = path.join(REPO_ROOT, 'eval', 'goldens');
const CASES_DIR = path.join(REPO_ROOT, 'eval', 'cases');

interface GoldenFixture {
  caseId: string;
  file: string;
  xml: string;
  ignore: string[];
}

function loadGoldens(): GoldenFixture[] {
  if (!fs.existsSync(GOLDENS_DIR)) return [];
  const out: GoldenFixture[] = [];
  for (const caseId of fs.readdirSync(GOLDENS_DIR)) {
    const dir = path.join(GOLDENS_DIR, caseId);
    if (!fs.statSync(dir).isDirectory()) continue;
    // Multi-artifact cases (L3/L4) commit several *.metadata.xml files in the
    // same golden dir — one fixture per artifact so each self-diffs cleanly.
    const xmlFiles = fs.readdirSync(dir).filter(f => f.endsWith('.metadata.xml'));
    if (xmlFiles.length === 0) continue;
    let ignore: string[] = [];
    const caseFile = path.join(CASES_DIR, `${caseId}.json`);
    if (fs.existsSync(caseFile)) {
      ignore = (JSON.parse(fs.readFileSync(caseFile, 'utf8')).ignore as string[]) ?? [];
    }
    for (const xmlFile of xmlFiles) {
      out.push({ caseId, file: xmlFile, xml: fs.readFileSync(path.join(dir, xmlFile), 'utf8'), ignore });
    }
  }
  return out;
}

const goldens = loadGoldens();

describe('committed goldens — integrity / oracle regression gate', () => {
  it('there is at least one committed golden', () => {
    expect(goldens.length).toBeGreaterThan(0);
  });

  it.each(goldens.map(g => [`${g.caseId}/${g.file}`, g] as const))(
    '%s golden normalizes to a non-empty, self-consistent map',
    async (_label, g) => {
      const a = await normalizeAotXml(g.xml, g.ignore);
      expect(a.size).toBeGreaterThan(0);
      const b = await normalizeAotXml(g.xml, g.ignore);
      expect(diffNormalized(a, b).matched).toBe(true);
    },
  );

  it('every case that declares a golden_path has a golden file on disk', () => {
    const orphans: string[] = [];
    for (const f of fs.readdirSync(CASES_DIR)) {
      if (!f.endsWith('.json')) continue;
      const spec = JSON.parse(fs.readFileSync(path.join(CASES_DIR, f), 'utf8'));
      if (!spec.golden_path) continue;
      // A golden_pending case is authored but its golden is captured later on the
      // VM (§6.4) — exempt until the golden lands.
      if (spec.golden_pending) continue;
      const dir = path.join(GOLDENS_DIR, spec.id);
      const hasGolden = fs.existsSync(dir)
        && fs.readdirSync(dir).some(x => x.endsWith('.metadata.xml'));
      if (!hasGolden) orphans.push(spec.id);
    }
    expect(orphans, `cases missing a golden: ${orphans.join(', ')}`).toEqual([]);
  });
});
