/**
 * Capture a golden from the sandbox — the one step of the eval loop that had no
 * script.
 *
 * Every implementer run re-derived this from memory, and the re-derivations
 * disagreed in ways that cost real work: goldens captured from a model that had
 * not been built (a golden then asserts code the compiler rejects), goldens
 * captured with case residue still in the sandbox (objects from a previous case
 * folded into this case's golden), `target_artifact_types` left disagreeing with
 * the folder it describes (`tests/eval/caseCatalog.test.ts` fails afterwards, in
 * CI, on a machine that cannot re-capture), and `golden_pending` left true so the
 * case never counted as proof. Each of those is a gate here.
 *
 * WHAT IT DOES NOT DO. It does not build, and it does not decide correctness.
 * A golden is a REVIEWED artifact (docs/AGENT_EVAL_LOOP.md §6.4) — this script
 * moves bytes and refuses obviously-broken captures; a human still reads the
 * result. It refuses to run at all without evidence that the model built, because
 * the one thing worse than no golden is a golden nobody can compile.
 *
 * Usage (on the VM, after the case built clean):
 *   npx tsx scripts/capture-golden.ts L2-tdd-table-extension-coc \
 *     --from K:/AosService/PackagesLocalDirectory/fm-mcp/fm-mcp \
 *     --objects ConDemoRuleTest,CustTable.ConExtension \
 *     --build-log build.txt
 *
 *   --from <dir>        model root holding the Ax* folders (repeatable)
 *   --objects <a,b,c>   AOT object names to capture, exactly as written on disk
 *   --build-log <file>  output of build_d365fo_project; must show no errors
 *   --build-ok <reason> explicit override when no log survives; recorded in the README
 *   --recapture         allow overwriting a golden that already exists
 *   --dry-run           report what would be captured, write nothing
 *
 * Exit code is 1 on any refusal, so a capture cannot half-succeed.
 */
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { aotRootElement } from '../src/eval/oracle/artifactKey.js';
import { parseArgs } from './oracles/aotSource.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const CASES_DIR = path.join(REPO_ROOT, 'eval', 'cases');

interface CaseSpec {
  id: string;
  title: string;
  target_artifact_types: string[];
  golden_path: string;
  golden_pending?: boolean;
  systest?: string;
  systest_pending?: boolean;
}

/**
 * Lines that mean the build did not succeed.
 *
 * Deliberately narrow, for the reason `copilotChatLog.ts` documents about failure
 * detection: a loose /error/i matches an object called `ErrorHandler` and turns a
 * clean build into a refusal, which trains the operator to pass `--build-ok`.
 */
const BUILD_FAILURE_MARKERS: RegExp[] = [
  /^\s*❌/m,
  /\bCompile Fatal Error\b/,
  /\berror\s+[A-Z]{2,}\d+\b/,
  /\bBuild\s+failed\b/i,
  /"succeeded"\s*:\s*false/,
];

function readCase(id: string): CaseSpec {
  const file = path.join(CASES_DIR, `${id}.json`);
  if (!fs.existsSync(file)) {
    const near = fs.readdirSync(CASES_DIR)
      .filter(f => f.endsWith('.json') && f !== 'schema.json')
      .map(f => f.replace(/\.json$/, ''))
      .filter(c => c.includes(id) || id.includes(c.split('-')[1] ?? '\u0000'))
      .slice(0, 5);
    throw new Error(
      `No case spec: eval/cases/${id}.json` + (near.length ? `\nDid you mean: ${near.join(', ')}` : ''),
    );
  }
  return JSON.parse(fs.readFileSync(file, 'utf8')) as CaseSpec;
}

/** Every `Ax<Type>` folder's `<Name>.xml` under the given model roots, indexed by object name. */
function indexSandbox(roots: string[]): Map<string, { file: string; folder: string }> {
  const found = new Map<string, { file: string; folder: string }>();
  for (const root of roots) {
    let folders: fs.Dirent[];
    try {
      folders = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      throw new Error(`--from is not readable: ${root}`);
    }
    for (const folder of folders) {
      if (!folder.isDirectory() || !/^Ax[A-Za-z]+$/.test(folder.name)) continue;
      const dir = path.join(root, folder.name);
      for (const entry of fs.readdirSync(dir)) {
        if (!entry.toLowerCase().endsWith('.xml')) continue;
        const name = entry.replace(/\.xml$/i, '');
        // A name in two AOT folders is a real thing (CompanyImage is a table and
        // a form). Keep the first and let the residue report show the rest.
        if (!found.has(name.toLowerCase())) {
          found.set(name.toLowerCase(), { file: path.join(dir, entry), folder: folder.name });
        }
      }
    }
  }
  return found;
}

/**
 * The AOT root element a document declares, e.g. `AxTable`.
 *
 * Delegated to the oracle's reader rather than re-implemented. The first version
 * here stripped comments with a single `replace()` pass and then matched the
 * first element - which CodeQL flags as
 * `js/incomplete-multi-character-sanitization`, and rightly: one strip pass
 * leaves a stray comment opener behind on nested or unterminated input, so the
 * very next match can read the root OUT OF A COMMENT.
 *
 * That is not hypothetical here. It is the defect this repo already shipped and
 * fixed once (CHANGELOG 1.16.0), and `aotRootElement` is that fix: it consumes
 * prologue tokens IN ORDER, so an unterminated comment never reaches the element
 * branch. Re-deriving it in a second place was the mistake; there is one reader.
 */
export function rootElementOf(xml: string): string | undefined {
  return aotRootElement(xml);
}

/** Names already pinned by ANOTHER case's golden — a collision the catalog test fails on. */
function namesPinnedElsewhere(exceptCaseId: string): Map<string, string> {
  const pinned = new Map<string, string>();
  for (const file of fs.readdirSync(CASES_DIR)) {
    if (!file.endsWith('.json') || file === 'schema.json') continue;
    const id = file.replace(/\.json$/, '');
    if (id === exceptCaseId) continue;
    const spec = JSON.parse(fs.readFileSync(path.join(CASES_DIR, file), 'utf8')) as CaseSpec;
    const dir = path.join(REPO_ROOT, spec.golden_path.replace(/\/+$/, ''));
    if (!fs.existsSync(dir)) continue;
    for (const artifact of fs.readdirSync(dir)) {
      if (!artifact.endsWith('.metadata.xml')) continue;
      pinned.set(artifact.replace(/\.metadata\.xml$/, '').toLowerCase(), id);
    }
  }
  return pinned;
}

/**
 * The failure marker a build log matches, or `undefined` for a clean log.
 *
 * Exported so the markers can be tested against real logs rather than against
 * what their author imagined: the narrowness is the whole design, and a marker
 * that starts matching clean builds trains operators to reach for `--build-ok`.
 */
export function buildLogFailure(log: string): RegExp | undefined {
  return BUILD_FAILURE_MARKERS.find(re => re.test(log));
}

function checkBuildEvidence(args: Record<string, string | true>): string {
  if (typeof args['build-log'] === 'string') {
    const file = args['build-log'];
    if (!fs.existsSync(file)) throw new Error(`--build-log not found: ${file}`);
    const log = fs.readFileSync(file, 'utf8');
    const hit = buildLogFailure(log);
    if (hit) {
      throw new Error(
        `The build log matches a failure marker (${hit}).\n` +
        'A golden captured from a model that did not build asserts code the compiler rejects. ' +
        'Fix the build, rebuild, then capture.',
      );
    }
    return `build log ${path.basename(file)} (${log.length} chars, no failure marker)`;
  }
  if (typeof args['build-ok'] === 'string') return `asserted by operator: ${args['build-ok']}`;
  throw new Error(
    'No build evidence.\n' +
    'Pass --build-log <file> with the output of build_d365fo_project, or --build-ok "<why the log is gone>".\n' +
    'This gate exists because goldens have been captured from models that never compiled.',
  );
}

function main(): void {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);
  const caseId = argv.find(a => !a.startsWith('--') && !Object.values(args).includes(a));
  if (!caseId) {
    console.error('usage: capture-golden.ts <caseId> --from <modelRoot> --objects <a,b> [--build-log <f>]');
    process.exit(2);
  }

  const spec = readCase(caseId);
  const goldenDir = path.join(REPO_ROOT, spec.golden_path.replace(/\/+$/, ''));
  const dryRun = args['dry-run'] === true;

  const roots = (typeof args.from === 'string' ? args.from.split(',') : [])
    .concat(argv.filter((a, i) => argv[i - 1] === '--from' && a !== args.from))
    .filter((v, i, all) => v && all.indexOf(v) === i);
  if (!roots.length) throw new Error('--from <modelRoot> is required (the folder holding Ax* directories).');

  const objects = typeof args.objects === 'string'
    ? args.objects.split(',').map(s => s.trim()).filter(Boolean)
    : [];
  if (!objects.length) {
    throw new Error(
      '--objects <Name,Name> is required.\n' +
      'Auto-detecting "everything in the sandbox" is what folds a previous case\'s residue into this golden.',
    );
  }

  const buildEvidence = checkBuildEvidence(args);
  const sandbox = indexSandbox(roots);

  // Resolve every requested object BEFORE writing anything: a half-captured
  // golden is worse than none, because the catalog test then reports a count
  // mismatch and the operator cannot tell which half is real.
  const resolved = objects.map(name => {
    const hit = sandbox.get(name.toLowerCase());
    if (!hit) {
      throw new Error(
        `Not in the sandbox: ${name}\n` +
        `Searched ${sandbox.size} objects under ${roots.join(', ')}.\n` +
        'Check the spelling against the AOT folder — the file name is what the writer produced, ' +
        'which may carry the model prefix the session applied.',
      );
    }
    const xml = fs.readFileSync(hit.file, 'utf8');
    const root = rootElementOf(xml);
    if (!root) throw new Error(`${name}: no AOT root element — the file is not metadata.`);
    if (xml.trim().length < 80) throw new Error(`${name}: ${xml.trim().length} bytes — an empty write, not an object.`);
    return { name, root, xml, ...hit };
  });

  // Gate 1: the catalog test requires ONE target_artifact_types entry PER FILE.
  if (spec.target_artifact_types.length !== resolved.length) {
    throw new Error(
      `target_artifact_types has ${spec.target_artifact_types.length} entr(ies) but ${resolved.length} object(s) ` +
      `are being captured.\nFix eval/cases/${caseId}.json first — one entry per file, repeats included ` +
      `(e.g. ["AxClass","AxClass"]).\nCapturing: ${resolved.map(r => `${r.name} (${r.root})`).join(', ')}`,
    );
  }

  // Gate 2: no other case may pin the same AOT name. `prepare(create)` cannot
  // warn about this — it reads the live sandbox, which the previous rollback
  // emptied — so the collision only surfaces in CI without this check.
  const pinned = namesPinnedElsewhere(caseId);
  for (const r of resolved) {
    const owner = pinned.get(r.name.toLowerCase());
    if (owner) {
      throw new Error(
        `${r.name} is already pinned by case ${owner}.\n` +
        'Two cases must not assert the same AOT name (tests/eval/goldenNameCollision.test.ts). Rename this case\'s object.',
      );
    }
  }

  // Gate 3: never silently overwrite a reviewed golden.
  const existing = fs.existsSync(goldenDir)
    ? fs.readdirSync(goldenDir).filter(f => f.endsWith('.metadata.xml'))
    : [];
  if (existing.length && args.recapture !== true) {
    throw new Error(
      `${spec.golden_path} already holds ${existing.length} artifact(s): ${existing.join(', ')}\n` +
      'A committed golden is a reviewed artifact. Pass --recapture to replace it, and say in the PR why the ' +
      'expected output changed.',
    );
  }

  // Advisory: residue in the sandbox is not a refusal (fixtures live there too),
  // but it is the thing that most often makes a capture wrong, so it is named.
  const captured = new Set(resolved.map(r => r.name.toLowerCase()));
  const residue = [...sandbox.entries()].filter(([k]) => !captured.has(k)).map(([, v]) => path.basename(v.file));
  if (residue.length) {
    console.warn(
      `\n! ${residue.length} other object(s) in the sandbox: ${residue.slice(0, 12).join(', ')}` +
      `${residue.length > 12 ? ` …and ${residue.length - 12} more` : ''}\n` +
      '  Fixtures are expected here; anything else is residue from an earlier case and means the ' +
      'rollback did not complete.',
    );
  }

  console.log(`\ncapture ${caseId} → ${spec.golden_path}`);
  for (const r of resolved) {
    console.log(`  ${r.folder}/${path.basename(r.file)}  →  ${r.name}.metadata.xml  [${r.root}, ${r.xml.length} bytes]`);
  }
  if (dryRun) {
    console.log('\n--dry-run: nothing written.');
    return;
  }

  fs.mkdirSync(goldenDir, { recursive: true });
  for (const stale of existing) fs.rmSync(path.join(goldenDir, stale));
  for (const r of resolved) {
    fs.writeFileSync(path.join(goldenDir, `${r.name}.metadata.xml`), r.xml, 'utf8');
  }

  writeReadme(goldenDir, spec, resolved.map(r => ({ name: r.name, root: r.root })), buildEvidence, existing.length > 0);

  // Gate 4: the flag is what makes the case count as proof in COVERAGE.md.
  if (spec.golden_pending) {
    const file = path.join(CASES_DIR, `${caseId}.json`);
    const raw = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(file, raw.replace(/(\n\s*)"golden_pending":\s*true,?/, ''), 'utf8');
    console.log('  golden_pending cleared — re-run `npm run eval:coverage` at the END of the wave, not now.');
  }

  console.log(`\n✅ ${resolved.length} artifact(s) captured. Next: review the diff, then commit the golden WITH its README.`);
}

function writeReadme(
  dir: string,
  spec: CaseSpec,
  artifacts: { name: string; root: string }[],
  buildEvidence: string,
  wasRecapture: boolean,
): void {
  const file = path.join(dir, 'README.md');
  const previous = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  // Keep whatever a reviewer wrote below the marker; only the provenance block is
  // regenerated. A README that loses its human notes on re-capture teaches people
  // not to write them.
  const MARKER = '<!-- capture-golden: provenance above, hand-written notes below -->';
  const notes = previous.includes(MARKER) ? previous.slice(previous.indexOf(MARKER) + MARKER.length) : '';

  const body = `# Golden — ${spec.id}

${spec.title}

Captured by \`scripts/capture-golden.ts\` on ${new Date().toISOString().slice(0, 10)}${wasRecapture ? ' (re-capture)' : ''}.

| artifact | root element |
| --- | --- |
${artifacts.map(a => `| \`${a.name}.metadata.xml\` | \`${a.root}\` |`).join('\n')}

Build evidence: ${buildEvidence}.

This is a **reviewed** artifact, not a snapshot the tools may refresh at will
(docs/AGENT_EVAL_LOOP.md §6.4). Every later run diffs its normalised output
against these files; \`missing\`/\`extra\`/\`changed\` deltas land in the run's
\`golden_diff\`. When a fix legitimately changes the expected output, re-capture
in the same PR and say why here — a golden that quietly follows the code proves
nothing.

## PENDING HUMAN REVIEW

Confirm before relying on this golden: the artifacts compile, are BP-clean, and
say what the case instruction asked for.

${MARKER}${notes || '\n'}`;
  fs.writeFileSync(file, body, 'utf8');
}

// Guarded so the module can be imported by its test without running a capture.
if (process.argv[1] && /capture-golden\.ts$/.test(process.argv[1])) {
  try {
    main();
  } catch (err) {
    console.error(`\n❌ ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
