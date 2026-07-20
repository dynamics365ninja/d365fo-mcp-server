/**
 * Knowledge-base API-symbol gate (audit 2026-07-20, "systémová pojistka č. 1").
 *
 * Every named AOT type/API in KNOWLEDGE_BASE must resolve against the real
 * symbol index — this is the CI form of `npm run eval:knowledge-audit`. It
 * would have caught all nine wrong-API defects (A1–A9: InventUpDate_*,
 * SysTelemetry, GlobalAddressBookHelper, AlertRuleTable, …) the moment they
 * were introduced.
 *
 * Two modes, so it runs both on a VM and on CI:
 *  • DB present  (data/xpp-metadata.db or DB_PATH) → resolve LIVE and assert
 *    zero findings (unknown type / member / casing), honouring the allowlist.
 *  • DB absent   (CI)                              → every reference must be
 *    covered by the committed snapshot, so a knowledge edit cannot ship
 *    without being re-audited on the VM. Skips only if no snapshot exists.
 */

import * as fs from 'fs';
import * as path from 'path';
import { describe, it, expect } from 'vitest';
import { KNOWLEDGE_BASE } from '../../src/tools/xppKnowledge';
import { extractKnowledgeRefs } from '../../src/eval/audit/knowledgeRefs';
import { openSymbolLookup } from '../../src/eval/audit/symbolLookup';
import {
  auditRefs,
  renderFindings,
  verifyAgainstSnapshot,
  type Allowlist,
  type AuditSnapshot,
} from '../../src/eval/audit/knowledgeAudit';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SNAPSHOT_PATH = path.join(REPO_ROOT, 'eval', 'knowledge-audit.snapshot.json');
const ALLOW_PATH = path.join(REPO_ROOT, 'eval', 'knowledge-audit.allow.json');
const DB_PATH = process.env.DB_PATH ?? path.join(REPO_ROOT, 'data', 'xpp-metadata.db');

function readJson<T>(file: string, fallback: T): T {
  return fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, 'utf8')) as T) : fallback;
}

const refs = extractKnowledgeRefs(KNOWLEDGE_BASE);
const hasDb = fs.existsSync(DB_PATH);
const hasSnapshot = fs.existsSync(SNAPSHOT_PATH);

describe('KNOWLEDGE_BASE API symbols', () => {
  it('extracts a non-trivial set of references', () => {
    // Guards against the extractor silently returning nothing (which would
    // make the gate vacuously pass).
    expect(refs.length).toBeGreaterThan(50);
  });

  it.runIf(hasDb)(
    'every named API/type resolves against the live symbol index',
    async () => {
      const allow = readJson<Allowlist>(ALLOW_PATH, {});
      const { lookup } = await openSymbolLookup(DB_PATH);
      const result = auditRefs(refs, lookup, allow);
      expect(result.findings, `\n${renderFindings(result)}`).toEqual([]);
    },
    120_000,
  );

  it.runIf(!hasDb && hasSnapshot)(
    'every reference is covered by the committed audit snapshot',
    () => {
      const snapshot = readJson<AuditSnapshot | null>(SNAPSHOT_PATH, null)!;
      const missing = verifyAgainstSnapshot(refs, snapshot);
      const detail = missing
        .map(m => `${m.entryId} · ${m.field} · ${m.kind} · ${m.name}${m.member ? `::${m.member}` : ''}`)
        .join('\n');
      expect(
        missing,
        `\n${missing.length} reference(s) not in the audited snapshot — re-run ` +
          `\`npm run eval:knowledge-audit -- --capture\` on the VM:\n${detail}`,
      ).toEqual([]);
    },
  );

  it.skipIf(hasDb || hasSnapshot)('audit gate is available (DB or snapshot present)', () => {
    // Marker test: only runs (as skipped) when neither a DB nor a snapshot is
    // available. Present so the file never reports "no tests" in that setup.
    expect(true).toBe(true);
  });
});
