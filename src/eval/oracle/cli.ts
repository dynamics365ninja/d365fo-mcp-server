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
 *     --bp-output <file>  raw run_bp_check output; parsed into the warnings THEMSELVES
 *                         ({code, object, message}) — prefer this over --bp-warnings
 *     --bp-warnings <n>   COUNT of BP warnings xppbp reported, when the output is not to
 *                         hand (OMIT BOTH = BP not checked -> bp_clean: null)
 *     --systest <file>    text file with the `run_systest_class` output (runtime oracle)
 *     --classification <C> rubric class for the record (default: derived)
 *     --case-spec <path>  score against THIS case-spec JSON instead of
 *                         eval/cases/<caseId>.json — for a spec that is not (yet)
 *                         committed to the catalog, e.g. one `eval:mine` just
 *                         drafted, or a synthetic spec in a test.
 *     --golden-prefix <p> EXTENSION_PREFIX the golden was captured under (default: every GOLDEN_CAPTURE_PREFIXES token)
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
  scoreRun, GOLDEN_CAPTURE_PREFIXES, type CaseSpec, type GoldenDiff, type Score,
} from './index.js';
import { resolveRegularObjectPrefixToken } from '../../utils/modelClassifier.js';
import { parseBpFindings } from '../../tools/sdlc/runBpCheck.js';
import {
  aotRelativeArtifactPath, aotRelativeArtifactPaths,
  buildActualArtifactsMap, renderPairingProblems,
} from './actualArtifactResolution.js';

/**
 * One BP finding as the corpus records it. `code` is what `eval:clusters`,
 * `eval:report` and `eval:brief` rank on, so it is required by the schema — a
 * warning with no code is a finding nothing can act on (#982).
 */
interface BpWarningRecord {
  code: string;
  object: string;
  message: string;
}

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

/** *.metadata.xml golden filenames present for a case, or [] if the golden dir is absent/empty.
 *  Never throws ENOENT: a `golden_pending` case (§6.4) legitimately has no golden dir yet. */
function listGoldenArtifacts(caseId: string): string[] {
  const dir = goldenDir(caseId);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => f.endsWith('.metadata.xml')).sort();
}

function findGolden(caseId: string): string {
  const file = listGoldenArtifacts(caseId)[0];
  if (!file) throw new Error(`No *.metadata.xml golden in ${goldenDir(caseId)}`);
  return path.join(goldenDir(caseId), file);
}

function shortSha(): string {
  try { return execSync('git rev-parse --short HEAD', { cwd: REPO_ROOT }).toString().trim(); }
  catch { return 'unknown'; }
}

/** The rubric classes of eval/corpus/schema.json — the record is rejected by any other. */
const CLASSIFICATIONS = ['PASS', 'TOOL_DEFECT', 'KNOWLEDGE_GAP', 'VALIDATOR_GAP', 'MODEL_ERROR', 'ENV_FLAKE'];

/** Flags that consume the following argv element as their value. */
const VALUE_FLAGS = [
  '--golden', '--actual-dir', '--bp-warnings', '--bp-output', '--systest', '--classification',
  '--golden-prefix', '--actual-prefix', '--case-spec',
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
    console.error('usage: tsx src/eval/oracle/cli.ts <caseId> <actualXml> [--golden p] [--build-failed] [--bp-output f | --bp-warnings n] [--write]');
    console.error('   or: tsx src/eval/oracle/cli.ts <caseId> --actual-dir <dir> [options]   (multi-artifact)');
    process.exit(2);
  }

  // `--case-spec` lets the oracle score a spec that isn't in the committed catalog
  // (a freshly mined draft, or a synthetic spec under test), so nothing has to be
  // written into eval/cases/ just to exercise a scoring path.
  const caseSpecPath = arg('--case-spec')
    ? path.resolve(arg('--case-spec')!)
    : path.join(REPO_ROOT, 'eval', 'cases', `${caseId}.json`);
  const caseSpec = JSON.parse(
    fs.readFileSync(caseSpecPath, 'utf8'),
  ) as CaseSpec & { ignore?: string[]; golden_pending?: boolean };

  const buildSucceeded = !flagSet('--build-failed');
  // `--bp-warnings` ABSENT means xppbp was not run for this capture — NOT "ran and
  // found nothing". It used to default to 0, which silently minted `bp_clean: 1`
  // for every run whose operator forgot the flag and made the dimension
  // untrendable (the 2026-07-21 eval sweep, finding #3). Leave bpWarnings
  // undefined so the score records `bp_clean: null` (BP not checked), and say so.
  //
  // `--bp-output <file>` is the preferred input: the raw run_bp_check text, parsed
  // into `{code, object, message}` by the very parser the tool uses. `--bp-warnings <n>`
  // records only how many there were.
  //
  // It used to inflate that count into N EMPTY objects — `[{}, {}, {} …]` — and
  // write them as the warnings themselves. `eval:clusters`, `eval:report` and
  // `eval:brief` all rank by BP code, so a record full of `{}` contributed N
  // findings with no code, no object and no message: every BP defect that run hit
  // was silently under-counted, and the operator had to fill the array in by hand
  // (#982). A count is a count; it is now recorded as one.
  const bpOutputFile = arg('--bp-output');
  const bpArg = arg('--bp-warnings');
  const bpChecked = bpOutputFile !== undefined || bpArg !== undefined;

  let bpWarnings: BpWarningRecord[] | undefined;
  let bpWarningCount: number | undefined;

  if (bpOutputFile !== undefined) {
    const raw = fs.readFileSync(path.resolve(bpOutputFile), 'utf8');
    bpWarnings = parseBpFindings(raw).map(f => ({
      code: f.moniker ?? 'BPUnknown',
      object: f.path ?? f.target,
      message: f.message ?? f.description ?? '',
    }));
    bpWarningCount = bpWarnings.length;
    if (bpArg !== undefined && Number(bpArg) !== bpWarnings.length) {
      console.error(
        `note: --bp-warnings ${bpArg} disagrees with the ${bpWarnings.length} finding(s) parsed from ` +
        `${bpOutputFile}. The parsed findings win — a count cannot be ranked by code.`,
      );
    }
  } else if (bpArg !== undefined) {
    bpWarningCount = Number(bpArg);
    if (!Number.isFinite(bpWarningCount) || bpWarningCount < 0) {
      console.error(`--bp-warnings must be a non-negative number, got "${bpArg}".`);
      process.exit(2);
    }
    if (bpWarningCount > 0) {
      console.error(
        `note: --bp-warnings ${bpWarningCount} records a COUNT only. The improver ranks BP defects by ` +
        `code (eval:clusters / eval:report / eval:brief), and a count carries none — pass ` +
        `\`--bp-output <file>\` with the run_bp_check output to record which warnings they were.`,
      );
    }
  } else {
    console.error(
      'note: neither --bp-output nor --bp-warnings supplied → bp_clean: null (BP NOT CHECKED). ' +
      'Pass `--bp-warnings 0` only if run_bp_check actually ran and reported none.',
    );
  }

  const build = { succeeded: buildSucceeded, bpWarnings, bpWarningCount };

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
  //
  // Both defaults are the WHOLE set of capture prefixes (`GOLDEN_CAPTURE_PREFIXES`,
  // currently ["Contoso","Con"]) rather than the single `GOLDEN_CAPTURE_PREFIX`: the
  // committed corpus is `Con`-prefixed, which "Contoso" can never match, so the old
  // single-token default left the golden side un-canonicalised and forced operators to
  // hand-pass `--golden-prefix Con --actual-prefix Con` (the 2026-07-21 eval sweep, finding #2).
  const goldenPrefix: string | readonly string[] = arg('--golden-prefix') ?? GOLDEN_CAPTURE_PREFIXES;
  const actualPrefix: string | readonly string[] =
    arg('--actual-prefix') ?? (resolveRegularObjectPrefixToken() || GOLDEN_CAPTURE_PREFIXES);

  let goldenDiff: GoldenDiff | null;
  let score: Score;
  let systestOut, generatedArtifacts: string[], debugLabel: string;

  // Golden may legitimately be unavailable: the case is `golden_pending` (authored, golden
  // captured later on the VM — §6.4) or its golden dir has no *.metadata.xml yet. In that case
  // degrade gracefully — score `build` and `bp_clean` normally, report golden_match: null
  // (neither a fabricated pass nor a fail on the golden dimension) — instead of crashing with a
  // raw ENOENT scandir. An explicit `--golden <path>` that exists still forces normal evaluation.
  // (Corpus: eval/corpus/runs/2026-07-21T__L3-custom-service-basic__a2a4131.json, finding (b).)
  const explicitGolden = arg('--golden');
  const explicitGoldenExists = !!explicitGolden && fs.existsSync(path.resolve(explicitGolden));
  const goldenUnavailable =
    !explicitGoldenExists && (caseSpec.golden_pending === true || listGoldenArtifacts(caseId).length === 0);

  if (goldenUnavailable) {
    const reason = caseSpec.golden_pending === true
      ? 'golden_pending'
      : `no *.metadata.xml golden in ${path.relative(REPO_ROOT, goldenDir(caseId))}`;
    goldenDiff = null;
    // Reuse scoreRun for the build/bp/systest logic, then null out the un-evaluated golden dim.
    score = { ...scoreRun({ build, goldenDiff: { matched: false, missing: [], extra: [], changed: [] }, tier: caseSpec.tier, systest }), golden_match: null };
    systestOut = systest && 'ran' in systest ? systest : { ran: false as const, passed: null, failures: [] as [] };
    if (actualDir) {
      // Bare `<Name>.xml` counts. This used to filter for `*.metadata.xml` only,
      // while an actual dir idiomatically holds the AOT files a VM session wrote
      // (`--actual-dir <Model>/<Model>/AxClass`) — so EVERY golden-capture run
      // recorded `generated_artifacts: []` and the operator had to reconstruct the
      // list by hand afterwards. Silent zero, not an error. (Corpus:
      // eval/corpus/runs/2026-08-31T22__L4-headerlines-document-slice__278eee3.json,
      // "ORACLE DEFECT"; the resolver has always accepted both shapes, hence the
      // now-shared `listActualArtifactFiles`, via `aotRelativeArtifactPaths`.)
      generatedArtifacts = aotRelativeArtifactPaths(path.resolve(actualDir));
    } else {
      generatedArtifacts = actualPath ? [aotRelativeArtifactPath(path.resolve(actualPath))] : [];
    }
    // Say what a `--write` would record: with no golden diff this list is the only
    // account of what the run produced, so it must not be silently empty.
    console.error(
      `generated_artifacts (${generatedArtifacts.length}): ${generatedArtifacts.join(', ') || '(none found)'}`,
    );
    debugLabel = `not evaluated — ${reason}`;
  } else if (actualDir) {
    const resolvedActualDir = path.resolve(actualDir);
    const artifactNames = listGoldenArtifacts(caseId);
    if (artifactNames.length === 0) throw new Error(`No *.metadata.xml goldens in ${goldenDir(caseId)}`);
    const goldenArtifacts: Record<string, string> = {};
    for (const name of artifactNames) {
      goldenArtifacts[name] = fs.readFileSync(path.join(goldenDir(caseId), name), 'utf8');
    }
    // Golden contents go in so the resolver can pair on the object each document
    // DECLARES (name + root element), not just on its filename — the only signal
    // that separates two artifacts sharing one object name, e.g. a form and the
    // display menu item a table's `FormRef` requires.
    const { actualArtifacts, matchedActualFiles, pairingProblems } =
      buildActualArtifactsMap(resolvedActualDir, artifactNames, goldenPrefix, actualPrefix, goldenArtifacts);
    if (pairingProblems.length > 0) {
      // Loud, never silent: a refused pairing scores as `missing`, and the
      // operator needs to know it was refused rather than genuinely absent.
      console.error(`\n# Artifact pairing refused for ${pairingProblems.length} golden artifact(s):`);
      console.error(renderPairingProblems(pairingProblems));
    }
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
    // The files the RUN produced, not the golden filenames it was scored against:
    // `Object.keys(actualArtifacts)` is keyed by golden name (`Foo.metadata.xml`),
    // so this field carried two different shapes depending on which branch wrote
    // it, and the record had to be corrected by hand (#982).
    generatedArtifacts = aotRelativeArtifactPaths(resolvedActualDir);
    debugLabel = `${artifactNames.length} artifact(s) in ${actualDir}`;
  } else {
    const goldenPath = arg('--golden') ?? findGolden(caseId);
    const goldenXml = fs.readFileSync(goldenPath, 'utf8');
    const actualXml = fs.readFileSync(path.resolve(actualPath!), 'utf8');
    ({ goldenDiff, score, systest: systestOut } = await evaluate({
      caseSpec, actualXml, goldenXml, build, systest, goldenPrefix, actualPrefix,
    }));
    generatedArtifacts = [aotRelativeArtifactPath(path.resolve(actualPath!))];
    debugLabel = path.basename(goldenPath);
    if (flagSet('--debug')) {
      console.error('\n--- normalized actual ---\n' + renderNormalized(await normalizeAotXml(actualXml, caseSpec.ignore ?? [], actualPrefix)));
    }
  }

  console.error(`# Oracle: ${caseId}  (golden: ${debugLabel})`);
  if (goldenDiff) console.error(renderDiff(goldenDiff));
  else console.error('golden_match: null — golden not evaluated (build and bp_clean scored; golden diff skipped).');
  if (systestFile) console.error(`SysTest: ran=${systestOut.ran} passed=${systestOut.passed} failures=${systestOut.failures.length}`);
  console.error(`\nScore: ${JSON.stringify(score)}`);

  if (flagSet('--write')) {
    // With no golden diff there is no correctness signal, so don't infer a defect from it:
    // fall back to the caller-supplied --classification (the implementer sets one), else a
    // neutral ENV_FLAKE (matches how such inconclusive runs are triaged) rather than a
    // spurious TOOL_DEFECT.
    // The caller-supplied class goes straight into the record, so validate it against the
    // schema enum here — an invented class (CASE_DESIGN, seen in the
    // L2-license-code-configkey run) otherwise produces a record that fails validation
    // only much later, in the corpus reader.
    const suppliedClassification = arg('--classification');
    if (suppliedClassification && !CLASSIFICATIONS.includes(suppliedClassification)) {
      console.error(
        `--classification "${suppliedClassification}" is not one of ${CLASSIFICATIONS.join(', ')} ` +
        `(eval/corpus/schema.json). Pick the closest class and put the nuance in root_cause_hypothesis.`
      );
      process.exit(2);
    }
    const classification = suppliedClassification
      ?? (score.golden_match === null
        ? 'ENV_FLAKE'
        // bp_clean === null means BP was NOT CHECKED — that is an absence of evidence,
        // not evidence of a knowledge gap, so only an explicit 0 downgrades to KNOWLEDGE_GAP.
        : (score.build === 1 && score.golden_match === 1 ? (score.bp_clean === 0 ? 'KNOWLEDGE_GAP' : 'PASS') : 'TOOL_DEFECT'));
    const ts = new Date().toISOString().replace(/[:.]/g, '').slice(0, 13);
    const sha = shortSha();
    const record = {
      run_id: `${ts}__${caseId}__${sha}`,
      case_id: caseId,
      tier: caseSpec.tier,
      timestamp: new Date().toISOString(),
      server_git_sha: sha,
      generated_artifacts: generatedArtifacts,
      build: {
        succeeded: build.succeeded,
        errors: [],
        // `bp_checked` is the provenance flag that makes bp_clean trendable: a record
        // WITHOUT it (every pre-2026-07-22 record) has unknown BP provenance and is
        // reported separately rather than averaged in (#3).
        bp_checked: bpChecked,
        // The findings themselves when --bp-output parsed them; `null` when only a
        // count was supplied. Never a synthetic array of empty objects (#982).
        bpWarnings: build.bpWarnings ?? null,
        bpWarningCount: bpWarningCount ?? null,
      },
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

  // Exit 0 on a real golden match, OR when the golden was not evaluated (goldenDiff === null)
  // and the build passed — a golden_pending case must not fail the scorer's exit code.
  const ok = goldenDiff ? (goldenDiff.matched && score.build === 1) : score.build === 1;
  process.exit(ok ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(2); });
