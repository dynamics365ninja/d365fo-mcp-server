/**
 * Harness-level eval fixtures — the INPUT/OUTPUT classifier, fixture loader, and
 * rollback-exclusion partition (VM-free, pure). See eval/ROADMAP.md step 1,
 * docs/AGENT_EVAL_LOOP.md §4a/§11, and eval/fixtures/README.md.
 *
 * Problem this solves. A handful of `ConDemo*` objects (chiefly the table
 * `ConDemoNoteHeader`) are SHARED across cases: one case creates them, ~18 others
 * READ from them. But the implementer protocol rolls back every case after
 * scoring, so a shared object created by a case cannot survive — each rollback
 * re-breaks every dependent case. The fix is to lift such shared INPUTS out of
 * the cases into repo-committed fixtures (eval/fixtures/*.metadata.xml) that are
 * (re)provisioned before each dependent case and EXCLUDED from that case's
 * rollback.
 *
 * The crux is telling INPUTS apart from the ~50 `ConDemo*`/`DemoNote*` names the
 * catalog mentions — MOST of which are case OUTPUTS that must NOT be
 * pre-provisioned. This module derives that split from the catalog itself:
 *   - a base name referenced by exactly ONE case is that case's OUTPUT;
 *   - a base name referenced by MORE THAN ONE case is SHARED and needs an
 *     explicit decision (INPUT fixture / OUTPUT / needs-review) recorded in
 *     SHARED_DECISIONS below.
 * `unresolved` (a shared base with no decision) is what a new case introducing a
 * silent cross-case dependency would surface — the unit test fails on it, so the
 * harness can never drift into an unprovisioned shared object again.
 *
 * VM-free boundary: this module classifies and partitions. Actually WRITING the
 * fixture into the sandbox (`d365fo_file` create) and reindexing
 * (`update_symbol_index`) is the agent/VM step — see the protocol docs.
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, '..', '..', '..');
export const FIXTURES_DIR = path.join(REPO_ROOT, 'eval', 'fixtures');
export const CASES_DIR = path.join(REPO_ROOT, 'eval', 'cases');

/**
 * The demo-object name shape. Matches `DemoXxx` or `ConDemoXxx` where the char
 * after `Demo` is uppercase — i.e. a PascalCase AOT object name. Capturing group
 * 1 is the prefix-stripped BASE name (`DemoNoteHeader`), so `ConDemoNoteHeader`
 * and `DemoNoteHeader` fold to one family. The uppercase-after-`Demo` rule keeps
 * English prose ("demonstrate", "demo") out, and the leading `\b`/case-sensitive
 * `Con` keeps camelCase locals ("conDemoNoteReportTmp") out — those are the same
 * objects referenced inside method bodies, not object declarations.
 */
const DEMO_TOKEN = /\b(?:Con)?(Demo[A-Z][A-Za-z0-9_]*)\b/g;

/** Strip the extension prefix so `ConDemoNoteHeader` and `DemoNoteHeader` unify. */
export function baseName(token: string): string {
  return token.replace(/^Con/, '');
}

export interface CaseLite {
  id: string;
  instruction: string;
  title?: string;
}

/** Extract the set of demo BASE names a single case mentions (title + instruction). */
export function demoBasesInCase(c: CaseLite): Set<string> {
  const bases = new Set<string>();
  const hay = `${c.title ?? ''}\n${c.instruction}`;
  for (const m of hay.matchAll(DEMO_TOKEN)) bases.add(m[1]);
  return bases;
}

/**
 * How a shared base is resolved. Every base the classifier reports as SHARED must
 * appear here or it lands in `unresolved` (and the test fails). This is the
 * human-audited part — the classifier can prove a name is shared, but only a
 * reviewer knows whether a shared name is a real fixture, a coincidental
 * collision, or a latent gap.
 */
export type Decision = 'INPUT' | 'OUTPUT' | 'NEEDS_REVIEW';

export interface SharedDecision {
  decision: Decision;
  /** For an INPUT fixture: the case that authored it (so it is NOT re-provisioned into its own origin). */
  origin?: string;
  note: string;
}

export const SHARED_DECISIONS: Record<string, SharedDecision> = {
  // The keystone. Created as artifact 1 of L1-form-basic; read/bound/selected by
  // ~18 cases. Provisioned as a fixture; committed at eval/fixtures/ConDemoNoteHeader.metadata.xml.
  DemoNoteHeader: {
    decision: 'INPUT',
    origin: 'L1-form-basic',
    note: 'Shared table read by ~18 cases (form datasources, map, query/view, dimension field, business/data event, batch, custom service, data entity, SSRS DPs). The one definite harness fixture.',
  },
  // The SimpleList form is L1-form-basic's OTHER output. L4-entity-security binds a
  // display menu item (DemoNoteHeaderDisplay) at it, so L4 has a latent build-time
  // dependency on the form existing. Left as OUTPUT + flagged: promoting it to a
  // second fixture is only warranted IF VM capture shows L4-entity-security cannot
  // build clean without it (a menu item at a missing form). The definition is
  // recoverable from eval/goldens/L1-form-basic/ConDemoNoteHeaderList.metadata.xml
  // if that promotion is taken.
  DemoNoteHeaderList: {
    decision: 'NEEDS_REVIEW',
    note: 'Primary OUTPUT of L1-form-basic (the SimpleList form). L4-entity-security\'s DemoNoteHeaderDisplay menu item points at it — a latent cross-case dependency. Provision as a 2nd fixture ONLY if VM capture proves L4 cannot build clean without it.',
  },
  // Not a real cross-case dependency: L0-edt-basic creates an EDT named
  // DemoNoteSubject; L2-delegate-basic creates a CLASS named DemoNoteSubject and
  // subscribes to ITS OWN delegate (classStr(ConDemoNoteSubject) resolves within
  // that same case). Two different object types that happen to share a name in two
  // isolated cases — each is its own case's OUTPUT.
  DemoNoteSubject: {
    decision: 'OUTPUT',
    note: 'Name collision, not a dependency: an EDT in L0-edt-basic and a self-referencing delegate class in L2-delegate-basic. Each case creates and consumes its own; neither reads the other.',
  },
};

export interface ClassifiedShared {
  base: string;
  cases: string[];
  decision: Decision;
  note: string;
}

export interface Classification {
  /** base -> the single case that owns it (created and consumed there). */
  outputs: { base: string; case: string }[];
  /** bases referenced by >1 case, with their audited decision. */
  shared: ClassifiedShared[];
  /** shared bases with no SHARED_DECISIONS entry — must be empty (test-enforced). */
  unresolved: string[];
  /** AOT object names to pre-provision before dependent cases (decision === INPUT). */
  provisioned: string[];
}

/**
 * Classify every demo object the catalog mentions as an OUTPUT (single-case) or
 * SHARED (multi-case), and resolve each SHARED base via SHARED_DECISIONS.
 */
export function classifyDemoObjects(cases: CaseLite[]): Classification {
  const casesByBase = new Map<string, Set<string>>();
  for (const c of cases) {
    for (const base of demoBasesInCase(c)) {
      const set = casesByBase.get(base) ?? new Set<string>();
      set.add(c.id);
      casesByBase.set(base, set);
    }
  }

  const outputs: { base: string; case: string }[] = [];
  const shared: ClassifiedShared[] = [];
  const unresolved: string[] = [];
  const provisioned: string[] = [];

  for (const [base, caseSet] of [...casesByBase.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const caseList = [...caseSet].sort();
    if (caseList.length === 1) {
      outputs.push({ base, case: caseList[0] });
      continue;
    }
    const decided = SHARED_DECISIONS[base];
    if (!decided) {
      unresolved.push(base);
      shared.push({ base, cases: caseList, decision: 'NEEDS_REVIEW', note: 'no SHARED_DECISIONS entry' });
      continue;
    }
    shared.push({ base, cases: caseList, decision: decided.decision, note: decided.note });
    if (decided.decision === 'INPUT') provisioned.push(`Con${base}`);
  }

  return { outputs, shared, unresolved, provisioned: provisioned.sort() };
}

export interface FixtureDef {
  /** AOT object name (post-prefix), e.g. ConDemoNoteHeader. */
  name: string;
  /** AOT root element, e.g. AxTable. */
  objectType: string;
  file: string;
  xml: string;
}

/** Load the committed fixture definitions from eval/fixtures/*.metadata.xml. */
export function loadFixtures(dir = FIXTURES_DIR): FixtureDef[] {
  if (!fs.existsSync(dir)) return [];
  const out: FixtureDef[] = [];
  for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.metadata.xml')).sort()) {
    const xml = fs.readFileSync(path.join(dir, file), 'utf8');
    const rootMatch = xml.match(/<(Ax[A-Za-z]+)\b/);
    const nameMatch = xml.match(/<Name>([^<]+)<\/Name>/);
    if (!rootMatch || !nameMatch) {
      throw new Error(`fixture ${file}: could not parse root element / <Name> (found root=${rootMatch?.[1]}, name=${nameMatch?.[1]})`);
    }
    out.push({ name: nameMatch[1].trim(), objectType: rootMatch[1], file, xml });
  }
  return out;
}

/** Fixture object names that have a committed definition on disk. */
export function fixtureNames(dir = FIXTURES_DIR): Set<string> {
  return new Set(loadFixtures(dir).map(f => f.name));
}

/**
 * Fixture names a given case needs pre-provisioned: provisioned fixtures whose
 * base the case references, EXCLUDING the fixture's own origin case (which
 * creates it and whose golden IS the definition). Drives step (b): the agent
 * provisions exactly these before running the case.
 */
export function fixturesForCase(caseId: string, cases: CaseLite[]): string[] {
  const c = cases.find(x => x.id === caseId);
  if (!c) return [];
  const bases = demoBasesInCase(c);
  const needed: string[] = [];
  for (const [base, decided] of Object.entries(SHARED_DECISIONS)) {
    if (decided.decision !== 'INPUT') continue;
    if (decided.origin === caseId) continue; // do not re-provision into the origin case
    if (bases.has(base)) needed.push(`Con${base}`);
  }
  return needed.sort();
}

export interface RollbackPartition {
  /** case-written objects to undo/wipe. */
  undo: string[];
  /** objects to KEEP because they are harness fixtures. */
  keep: string[];
}

/**
 * Split a case's written objects into what rollback may undo vs. what it must
 * KEEP because it is a fixture (step (c): rollback made fixture-aware). Names are
 * final AOT names (ConDemo*), matched against the fixture set directly.
 */
export function partitionForRollback(written: string[], fixtures: Set<string> = fixtureNames()): RollbackPartition {
  const undo: string[] = [];
  const keep: string[] = [];
  for (const obj of written) (fixtures.has(obj) ? keep : undo).push(obj);
  return { undo, keep };
}

/** Load the catalog as CaseLite[] (id/title/instruction), skipping schema.json. */
export function loadCases(dir = CASES_DIR): CaseLite[] {
  return fs
    .readdirSync(dir)
    .filter(f => f.endsWith('.json') && f !== 'schema.json')
    .map(f => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as CaseLite)
    .map(c => ({ id: c.id, title: c.title, instruction: c.instruction }))
    .sort((a, b) => a.id.localeCompare(b.id));
}
