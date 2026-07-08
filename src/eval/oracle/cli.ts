/**
 * Eval oracle CLI — score a produced artifact against its golden and (optionally)
 * write a corpus record. VM-free: run after capturing the build result.
 *
 *   tsx src/eval/oracle/cli.ts <caseId> <actualXml> [options]
 *     --golden <path>     explicit golden file (default: first *.metadata.xml in eval/goldens/<caseId>/)
 *     --actual-dir <dir>  MULTI-ARTIFACT mode: score every *.metadata.xml golden in
 *                         eval/goldens/<caseId>/ against a same-named file in <dir>
 *                         (L3/L4 cases that produce several objects). Mutually
 *                         exclusive with the single <actualXml> positional/--golden.
 *     --build-failed      mark build as failed (default: succeeded)
 *     --bp-warnings <n>   number of BP warnings (default: 0)
 *     --systest <file>    text file with the `run_systest_class` output (runtime oracle)
 *     --classification <C> rubric class for the record (default: derived)
 *     --golden-prefix <p> EXTENSION_PREFIX the golden was captured under (default: GOLDEN_CAPTURE_PREFIX, "Asl")
 *     --actual-prefix <p> EXTENSION_PREFIX the actual was produced under (default: read from THIS
 *                         process's EXTENSION_PREFIX env var — the session that ran the case)
 *     --write             append a corpus record to eval/corpus/runs/
 *
 * `<actualXml>` may itself be a golden path to self-check the oracle (expect match).
 *
 * Root-object-name (and other prefixed-identifier) comparisons are
 * prefix-agnostic by default: an actual object built under a DIFFERENT
 * EXTENSION_PREFIX session than the one the golden was captured under still
 * scores golden_match=1 as long as the object is otherwise identical (see
 * docs/AGENT_EVAL_LOOP.md §6.2 and the corpus record that surfaced this —
 * eval/corpus/runs/2026-07-06T10__L0-edt-basic__4fafcd8.json).
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import {
  evaluate, evaluateMulti, renderDiff, renderNormalized, normalizeAotXml, parseSysTestResult,
  GOLDEN_CAPTURE_PREFIX, type CaseSpec,
} from './index.js';
import { resolveRegularObjectPrefixToken } from '../../utils/modelClassifier.js';
import { buildActualArtifactsMap } from './actualArtifactResolution.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..');

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function flagSet(flag: string): boolean {
  return process.argv.includes(flag);
}

function goldenDir(caseId: string): string {
  return path.join(REPO_ROOT, 'eval', 'goldens', caseId);
}

function findGolden(caseId: string): string {
  const dir = goldenDir(caseId);
  const file = fs.readdirSync(dir).find(f => f.endsWith('.metadata.xml'));
  if (!file) throw new Error(`No *.metadata.xml golden in ${dir}`);
  return path.join(dir, file);
}

/** All *.metadata.xml golden filenames for a case, e.g. for a multi-artifact L3/L4 case. */
function listGoldenArtifacts(caseId: string): string[] {
  const dir = goldenDir(caseId);
  return fs.readdirSync(dir).filter(f => f.endsWith('.metadata.xml')).sort();
}

function shortSha(): string {
  try { return execSync('git rev-parse --short HEAD', { cwd: REPO_ROOT }).toString().trim(); }
  catch { return 'unknown'; }
}

/** Flags that consume the following argv element as their value. */
const VALUE_FLAGS = [
  '--golden', '--actual-dir', '--bp-warnings', '--systest', '--classification',
  '--golden-prefix', '--actual-prefix',
];

function positionalArgs(argv: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      if (VALUE_FLAGS.includes(argv[i])) i++; // skip its value
      continue;
    }
    out.push(argv[i]);
  }
  return out;
}

async function main(): Promise<void> {
  const positionals = positionalArgs(process.argv.slice(2));
  const caseId = positionals[0];
  const actualDir = arg('--actual-dir');
  const actualPath = actualDir ? undefined : positionals[1];

  if (!caseId || (!actualDir && !actualPath)) {
    console.error('usage: tsx src/eval/oracle/cli.ts <caseId> <actualXml> [--golden p] [--build-failed] [--bp-warnings n] [--write]');
    console.error('   or: tsx src/eval/oracle/cli.ts <caseId> --actual-dir <dir> [options]   (multi-artifact)');
    process.exit(2);
  }

  const caseSpec = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, 'eval', 'cases', `${caseId}.json`), 'utf8'),
  ) as CaseSpec & { ignore?: string[] };

  const buildSucceeded = !flagSet('--build-failed');
  const bpCount = Number(arg('--bp-warnings') ?? '0');
  const build = { succeeded: buildSucceeded, bpWarnings: Array.from({ length: bpCount }, () => ({})) };

  const systestFile = arg('--systest');
  const systest = systestFile
    ? parseSysTestResult(fs.readFileSync(path.resolve(systestFile), 'utf8'))
    : undefined;

  // The golden corpus was captured under a fixed prefix (docs/AGENT_EVAL_LOOP.md §6.4); the
  // actual defaults to THIS process's own EXTENSION_PREFIX — i.e. whatever session ran the
  // case (the eval-implementer's VM env), not a guess. When EXTENSION_PREFIX isn't set at all
  // (e.g. a local self-check comparing a golden against itself/another golden-shaped fixture,
  // no VM session involved) fall back to the golden's own prefix so that unprefixed-env usage
  // keeps matching exactly as before. Either is overridable for edge cases.
  const goldenPrefix = arg('--golden-prefix') ?? GOLDEN_CAPTURE_PREFIX;
  const actualPrefix = arg('--actual-prefix') ?? (resolveRegularObjectPrefixToken() || GOLDEN_CAPTURE_PREFIX);

  let goldenDiff, score, systestOut, generatedArtifacts: string[], debugLabel: string;

  if (actualDir) {
    const resolvedActualDir = path.resolve(actualDir);
    const artifactNames = listGoldenArtifacts(caseId);
    if (artifactNames.length === 0) throw new Error(`No *.metadata.xml goldens in ${goldenDir(caseId)}`);
    const goldenArtifacts: Record<string, string> = {};
    for (const name of artifactNames) {
      goldenArtifacts[name] = fs.readFileSync(path.join(goldenDir(caseId), name), 'utf8');
    }
    const { actualArtifacts, matchedActualFiles } =
      buildActualArtifactsMap(resolvedActualDir, artifactNames, goldenPrefix, actualPrefix);
    // Surface extra actual files (produced but not golden-expected, and not already
    // matched to a golden artifact above under prefix-canonicalised filename matching) too.
    for (const f of fs.readdirSync(resolvedActualDir).filter(f => f.endsWith('.metadata.xml'))) {
      if (!matchedActualFiles.has(f) && !(f in actualArtifacts)) {
        actualArtifacts[f] = fs.readFileSync(path.join(resolvedActualDir, f), 'utf8');
      }
    }
    ({ goldenDiff, score, systest: systestOut } = await evaluateMulti({
      caseSpec, actualArtifacts, goldenArtifacts, build, systest, goldenPrefix, actualPrefix,
    }));
    generatedArtifacts = Object.keys(actualArtifacts);
    debugLabel = `${artifactNames.length} artifact(s) in ${actualDir}`;
  } else {
    const goldenPath = arg('--golden') ?? findGolden(caseId);
    const goldenXml = fs.readFileSync(goldenPath, 'utf8');
    const actualXml = fs.readFileSync(path.resolve(actualPath!), 'utf8');
    ({ goldenDiff, score, systest: systestOut } = await evaluate({
      caseSpec, actualXml, goldenXml, build, systest, goldenPrefix, actualPrefix,
    }));
    generatedArtifacts = [path.basename(actualPath!)];
    debugLabel = path.basename(goldenPath);
    if (flagSet('--debug')) {
      console.error('\n--- normalized actual ---\n' + renderNormalized(await normalizeAotXml(actualXml, caseSpec.ignore ?? [], actualPrefix)));
    }
  }

  console.error(`# Oracle: ${caseId}  (golden: ${debugLabel})`);
  console.error(renderDiff(goldenDiff));
  if (systestFile) console.error(`SysTest: ran=${systestOut.ran} passed=${systestOut.passed} failures=${systestOut.failures.length}`);
  console.error(`\nScore: ${JSON.stringify(score)}`);

  if (flagSet('--write')) {
    const classification = arg('--classification')
      ?? (score.build === 1 && score.golden_match === 1 ? (score.bp_clean === 1 ? 'PASS' : 'KNOWLEDGE_GAP') : 'TOOL_DEFECT');
    const ts = new Date().toISOString().replace(/[:.]/g, '').slice(0, 13);
    const sha = shortSha();
    const record = {
      run_id: `${ts}__${caseId}__${sha}`,
      case_id: caseId,
      tier: caseSpec.tier,
      timestamp: new Date().toISOString(),
      server_git_sha: sha,
      generated_artifacts: generatedArtifacts,
      build: { succeeded: build.succeeded, errors: [], bpWarnings: build.bpWarnings },
      golden_diff: goldenDiff,
      systest: systestOut,
      score,
      classification,
    };
    const outDir = path.join(REPO_ROOT, 'eval', 'corpus', 'runs');
    const outFile = path.join(outDir, `${record.run_id}.json`);
    fs.writeFileSync(outFile, JSON.stringify(record, null, 2) + '\n');
    console.error(`\nWrote corpus record: ${path.relative(REPO_ROOT, outFile)}`);
  }

  process.exit(goldenDiff.matched && score.build === 1 ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(2); });
