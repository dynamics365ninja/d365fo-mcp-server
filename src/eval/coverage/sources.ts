/**
 * Live inputs for the coverage matrix.
 *
 * Kept apart from the CLI so tests can build the same report without the CLI's
 * process.exit, and apart from coverage.ts so that module stays pure.
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { KNOWLEDGE_BASE } from '../../tools/xppKnowledge.js';
import { d365foFileTool } from '../../server/toolSchemas/d365foFile.js';
import { TAXONOMY } from './taxonomy.js';
import { computeCoverage, type EvalCaseSummary, type CoverageReport } from './coverage.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, '..', '..', '..');
export const CASES_DIR = path.join(REPO_ROOT, 'eval', 'cases');
export const MD_PATH = path.join(REPO_ROOT, 'eval', 'COVERAGE.md');
export const JSON_PATH = path.join(REPO_ROOT, 'eval', 'coverage.json');
export const README_PATH = path.join(REPO_ROOT, 'README.md');

export function loadCases(dir = CASES_DIR): EvalCaseSummary[] {
  return fs
    .readdirSync(dir)
    .filter(f => f.endsWith('.json') && f !== 'schema.json')
    .map(f => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as
      { id: string; tags?: string[]; golden_pending?: boolean })
    .map(c => ({ id: c.id, tags: c.tags ?? [], goldenPending: c.golden_pending === true }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Object types the MCP surface can actually create — the T flag's source. */
export function toolObjectTypes(): Set<string> {
  const props = (d365foFileTool as { inputSchema?: { properties?: Record<string, { enum?: string[] }> } }).inputSchema?.properties ?? {};
  return new Set<string>(props.objectType?.enum ?? []);
}

export function buildReport(): CoverageReport {
  return computeCoverage(TAXONOMY, {
    knowledgeIds: new Set(KNOWLEDGE_BASE.map(e => e.id)),
    cases: loadCases(),
    toolTypes: toolObjectTypes(),
  });
}
