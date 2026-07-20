/**
 * Knowledge-audit CLI (ROADMAP P1).
 *
 *   npm run eval:knowledge-audit            # verify against the committed snapshot (CI, VM-free)
 *   npm run eval:knowledge-audit -- --capture   # re-audit against the real symbol index (VM only)
 *   npm run eval:knowledge-audit -- --json
 *
 * --capture opens data/xpp-metadata.db (override with DB_PATH), resolves every
 * reference, prints the defect list and rewrites eval/knowledge-audit.snapshot.json.
 * The default (verify) mode needs no DB: it recomputes the reference set from
 * KNOWLEDGE_BASE and fails when any reference is missing from the snapshot —
 * so a knowledge edit cannot ship without being re-audited on the VM.
 *
 * Exit code 1 on any defect, so it drops straight into the eval-gate workflow.
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { KNOWLEDGE_BASE } from '../../tools/xppKnowledge.js';
import { extractKnowledgeRefs } from './knowledgeRefs.js';
import { openSymbolLookup } from './symbolLookup.js';
import {
  auditRefs, renderFindings, buildSnapshot, verifyAgainstSnapshot,
  type Allowlist, type AuditSnapshot,
} from './knowledgeAudit.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..');
const SNAPSHOT_PATH = path.join(REPO_ROOT, 'eval', 'knowledge-audit.snapshot.json');
const ALLOW_PATH = path.join(REPO_ROOT, 'eval', 'knowledge-audit.allow.json');

function readJson<T>(file: string, fallback: T): T {
  if (!fs.existsSync(file)) return fallback;
  return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
}

function resolveDbPath(): string {
  return process.env.DB_PATH ?? path.join(REPO_ROOT, 'data', 'xpp-metadata.db');
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const capture = argv.includes('--capture');
  const asJson = argv.includes('--json');
  const refs = extractKnowledgeRefs(KNOWLEDGE_BASE);
  const allow = readJson<Allowlist>(ALLOW_PATH, {});

  if (!capture) {
    const snapshot = readJson<AuditSnapshot | null>(SNAPSHOT_PATH, null);
    if (!snapshot) {
      console.error(`❌ no snapshot at ${SNAPSHOT_PATH}. Run with --capture on the VM first.`);
      return 1;
    }
    const missing = verifyAgainstSnapshot(refs, snapshot);
    if (asJson) {
      console.log(JSON.stringify({ mode: 'verify', checked: refs.length, missing }, null, 2));
    } else {
      console.log(
        `Knowledge audit (verify) — ${refs.length} reference(s) vs snapshot captured ` +
        `${snapshot.capturedAt} against index ${snapshot.indexedAt}.`,
      );
      if (missing.length === 0) {
        console.log('✅ every reference in KNOWLEDGE_BASE is covered by an audited snapshot entry.');
      } else {
        console.log(`❌ ${missing.length} reference(s) not audited — re-run with --capture on the VM:`);
        for (const m of missing) console.log(`   ${m.entryId} · ${m.field} · ${m.kind} · ${m.name}${m.member ? `::${m.member}` : ''}`);
      }
    }
    return missing.length === 0 ? 0 : 1;
  }

  const { lookup, indexedAt } = await openSymbolLookup(resolveDbPath());
  const result = auditRefs(refs, lookup, allow);
  if (asJson) {
    console.log(JSON.stringify({ mode: 'capture', indexedAt, ...result }, null, 2));
  } else {
    console.log(renderFindings(result));
  }
  const snapshot = buildSnapshot(refs, result, indexedAt);
  fs.writeFileSync(SNAPSHOT_PATH, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
  if (!asJson) console.log(`\nSnapshot written: ${path.relative(REPO_ROOT, SNAPSHOT_PATH)} (${snapshot.ok.length} clean reference(s)).`);
  return result.findings.length === 0 ? 0 : 1;
}

main().then(
  code => process.exit(code),
  err => {
    console.error(`❌ knowledge audit failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  },
);
