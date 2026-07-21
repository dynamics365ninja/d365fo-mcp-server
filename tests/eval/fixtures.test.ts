/**
 * Harness-level fixture classifier / loader / rollback-exclusion gate (VM-free).
 *
 * Locks in the INPUT/OUTPUT split of eval/ROADMAP.md step 1: ConDemoNoteHeader is
 * the one provisioned fixture, every other ConDemo / DemoNote name is a case
 * OUTPUT, and any NEW case that quietly introduces a shared (cross-case)
 * dependency without a recorded decision fails the `unresolved` assertion — so
 * the harness can never drift back into an unprovisioned shared object.
 */

import { describe, it, expect } from 'vitest';
import {
  classifyDemoObjects,
  loadCases,
  loadFixtures,
  fixtureNames,
  fixturesForCase,
  partitionForRollback,
  demoBasesInCase,
  baseName,
} from '../../src/eval/fixtures/fixtures';

const cases = loadCases();
const cls = classifyDemoObjects(cases);

describe('fixture loader', () => {
  it('loads ConDemoNoteHeader as an AxTable with non-empty xml', () => {
    const fx = loadFixtures();
    const table = fx.find(f => f.name === 'ConDemoNoteHeader');
    expect(table, 'ConDemoNoteHeader fixture must be committed').toBeTruthy();
    expect(table!.objectType).toBe('AxTable');
    expect(table!.xml).toContain('<Name>ConDemoNoteHeader</Name>');
  });

  it('fixtureNames() == the committed fixture object names', () => {
    expect([...fixtureNames()].sort()).toEqual(['ConDemoNoteHeader']);
  });
});

describe('token extraction', () => {
  it('folds Con-prefixed and bare names to one base, ignoring prose and camelCase locals', () => {
    const bases = demoBasesInCase({
      id: 'x',
      instruction:
        'bind to ConDemoNoteHeader; create DemoNoteHeaderList; this demonstrates a demo; the conDemoNoteReportTmp local var',
    });
    expect(bases.has('DemoNoteHeader')).toBe(true); // ConDemoNoteHeader folds here
    expect(bases.has('DemoNoteHeaderList')).toBe(true);
    expect(bases.has('Demonstrates')).toBe(false); // English prose excluded
    expect([...bases].some(b => /Report/i.test(b))).toBe(false); // camelCase local excluded
  });

  it('baseName strips the Con prefix', () => {
    expect(baseName('ConDemoNoteHeader')).toBe('DemoNoteHeader');
    expect(baseName('DemoNoteHeader')).toBe('DemoNoteHeader');
  });
});

describe('INPUT / OUTPUT classification', () => {
  it('has no unresolved SHARED bases (a new cross-case dep must be decided)', () => {
    expect(cls.unresolved, `unresolved shared bases: ${cls.unresolved.join(', ')}`).toEqual([]);
  });

  it('the SHARED set is exactly the three known cross-case names', () => {
    expect(cls.shared.map(s => s.base).sort()).toEqual([
      'DemoNoteHeader',
      'DemoNoteHeaderList',
      'DemoNoteSubject',
    ]);
  });

  it('ConDemoNoteHeader is the sole provisioned INPUT fixture', () => {
    expect(cls.provisioned).toEqual(['ConDemoNoteHeader']);
    const header = cls.shared.find(s => s.base === 'DemoNoteHeader');
    expect(header!.decision).toBe('INPUT');
    // referenced by many cases — the whole point
    expect(header!.cases.length).toBeGreaterThan(10);
  });

  it('the form is flagged NEEDS_REVIEW (latent L4 dependency, not auto-provisioned)', () => {
    const form = cls.shared.find(s => s.base === 'DemoNoteHeaderList');
    expect(form!.decision).toBe('NEEDS_REVIEW');
    expect(form!.cases).toContain('L1-form-basic');
    expect(form!.cases).toContain('L4-entity-security');
  });

  it('the EDT/class name collision is classified OUTPUT (not a dependency)', () => {
    const sub = cls.shared.find(s => s.base === 'DemoNoteSubject');
    expect(sub!.decision).toBe('OUTPUT');
  });

  it('every provisioned fixture has a committed definition file', () => {
    const files = fixtureNames();
    for (const name of cls.provisioned) expect(files.has(name), `${name} needs a file`).toBe(true);
  });

  it('single-case names are OUTPUTs and are NOT provisioned', () => {
    // spot-check a few known case outputs
    const outBases = new Set(cls.outputs.map(o => o.base));
    expect(outBases.has('DemoNoteReportTmp')).toBe(true); // L4-ssrs-report-basic
    expect(outBases.has('DemoNoteHeaderLine')).toBe(true); // L3-form-detailstransaction
    expect(outBases.has('DemoNoteReindexService')).toBe(true); // L3-batch-retryable-basic
    for (const b of outBases) expect(cls.provisioned).not.toContain(`Con${b}`);
  });
});

describe('per-case provisioning plan (step b)', () => {
  it('a reader case needs the fixture', () => {
    expect(fixturesForCase('L2-dimension-basic', cases)).toEqual(['ConDemoNoteHeader']);
    expect(fixturesForCase('L3-custom-service-basic', cases)).toEqual(['ConDemoNoteHeader']);
  });

  it('the origin case (L1-form-basic) does NOT re-provision its own fixture', () => {
    expect(fixturesForCase('L1-form-basic', cases)).toEqual([]);
  });

  it('a case that never touches the fixture needs nothing', () => {
    expect(fixturesForCase('L0-enum-basic', cases)).toEqual([]);
  });
});

describe('rollback exclusion (step c)', () => {
  it('keeps fixtures and undoes case writes', () => {
    const p = partitionForRollback(
      ['ConDemoNoteHeader', 'ConDemoNoteReportTmp', 'ConDemoNoteReportDP'],
      new Set(['ConDemoNoteHeader']),
    );
    expect(p.keep).toEqual(['ConDemoNoteHeader']);
    expect(p.undo).toEqual(['ConDemoNoteReportTmp', 'ConDemoNoteReportDP']);
  });

  it('defaults to the committed fixture set', () => {
    const p = partitionForRollback(['ConDemoNoteHeader', 'ConDemoNoteReportTmp']);
    expect(p.keep).toEqual(['ConDemoNoteHeader']);
    expect(p.undo).toEqual(['ConDemoNoteReportTmp']);
  });
});
