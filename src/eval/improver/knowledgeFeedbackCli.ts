/**
 * Knowledge-base feedback CLI — print MODEL_ERROR clusters + suggested
 * xppKnowledge.ts edit targets (docs/AGENT_EVAL_LOOP.md §9). VM-free.
 *
 *   tsx src/eval/improver/knowledgeFeedbackCli.ts [--json]
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { KNOWLEDGE_BASE } from '../../tools/xppKnowledge.js';
import { buildKnowledgeProposals, renderKnowledgeProposals } from './knowledgeFeedback.js';
import type { CorpusRun } from './cluster.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..');

function loadRuns(): CorpusRun[] {
  const dir = path.join(REPO_ROOT, 'eval', 'corpus', 'runs');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as CorpusRun; }
      catch { return null; }
    })
    .filter((r): r is CorpusRun => r != null && typeof r.classification === 'string');
}

const asJson = process.argv.includes('--json');
const runs = loadRuns();
const proposals = buildKnowledgeProposals(runs, KNOWLEDGE_BASE);

if (asJson) {
  console.log(JSON.stringify(proposals, null, 2));
} else {
  console.log(`Loaded ${runs.length} corpus run(s).\n`);
  console.log(renderKnowledgeProposals(proposals));
}
