/**
 * Re-verify every captured golden by actually compiling it — one case at a
 * time, in isolation, with a real full build.
 *
 *   npx tsx scripts/verify-goldens-build.ts            # all captured cases
 *   npx tsx scripts/verify-goldens-build.ts --baseline # sandbox only, no goldens
 *   npx tsx scripts/verify-goldens-build.ts --limit 5  # smoke test
 *
 * VM-only: needs PackagesLocalDirectory and xppc.exe.
 *
 * WHY THIS EXISTS
 * `build_d365fo_project` used to replay a finished build's result as the
 * result of the NEXT call (fixed 2026-07-28). Any `pass@build` recorded
 * without `force: true` was therefore weaker evidence than it looked, so the
 * captured goldens needed re-checking against the compiler itself.
 *
 * WHY ISOLATION, NOT ONE BULK BUILD
 * A bulk pass (every artifact at once) is only a screen. It hides failures —
 * one case's object can satisfy another case's dangling reference — and it
 * invents them: separate cases legitimately reuse names that never coexist in
 * a real run (AxEdt/ConDemoNoteSubject in L0-edt-basic vs
 * AxClass/ConDemoNoteSubject in L2-delegate-basic collide on sight, and
 * L2-numberseq-basic's class needs ITS OWN NumberSeqModule extension, not the
 * empty-values one from L2-enum-extension-empty-values). Measured: the bulk
 * build reported 12 errors, of which the isolated runs showed 0 were real.
 *
 * NEVER OVERWRITES AN EXISTING FILE
 * ConDemoNoteHeader is a VM fixture. A case's golden copy of it is that
 * case's OUTPUT, and clobbering the fixture with it breaks unrelated forms
 * ("Field group 'Overview' does not exist"). Pre-existing files are left
 * alone and reported as skipped — they are not compile-verified by this run,
 * which is also what a real case run does with a fixture.
 *
 * Calls xppc.exe directly: same compiler the tool wraps, without the state
 * file whose replay bug prompted the sweep.
 */
import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';

const CASES = 'eval/cases';
const GOLDENS = 'eval/goldens';
const PACKAGES = process.env.D365FO_PACKAGE_PATH?.replace(/\\/g, '/')
  ?? 'K:/AosService/PackagesLocalDirectory';
const MODEL = process.env.D365FO_MODEL_NAME ?? 'Contoso';
const MODEL_ROOT = `${PACKAGES}/${MODEL}/${MODEL}`;
const XPPC = `${PACKAGES}/bin/xppc.exe`;
const LOG = path.join(process.cwd(), '.xppc-verify.log');
const OUT = path.join(process.cwd(), 'golden-verify-results.json');

interface Artifact { root: string; name: string; xml: string }
interface CaseResult {
  caseId: string; artifacts: number; skipped: string[]; ok: boolean; errors: string[];
}

function artifactsFor(caseId: string): Artifact[] {
  const dir = path.join(GOLDENS, caseId);
  if (!fs.existsSync(dir)) return [];
  const out: Artifact[] = [];
  for (const file of fs.readdirSync(dir).filter(n => n.endsWith('.xml'))) {
    const xml = fs.readFileSync(path.join(dir, file), 'utf8');
    const root = /<(Ax[A-Za-z]+)[\s>]/.exec(xml)?.[1];
    const name = /<Name>([^<]+)<\/Name>/.exec(xml)?.[1];
    if (root && name) out.push({ root, name, xml });
    else console.log(`!! unparsable golden: ${caseId}/${file}`);
  }
  return out;
}

function capturedCases(): string[] {
  return fs.readdirSync(CASES)
    .filter(f => f.endsWith('.json'))
    .map(f => JSON.parse(fs.readFileSync(path.join(CASES, f), 'utf8')))
    .filter(c => c.id && !c.golden_pending && fs.existsSync(path.join(GOLDENS, c.id)))
    .map(c => c.id as string)
    .sort();
}

/** Full build (no -incremental): metadata validation only runs on a full build. */
function build(): { ok: boolean; errors: string[] } {
  try { fs.unlinkSync(LOG); } catch { /* fresh run */ }
  const proc = spawnSync(XPPC, [
    `-metadata=${PACKAGES}`,
    `-compilermetadata=${PACKAGES}`,
    `-modelmodule=${MODEL}`,
    `-referenceFolder=${PACKAGES}`,
    `-output=${PACKAGES}/${MODEL}/bin`,
    `-log=${LOG}`,
    '-verbose',
  ], { encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024, timeout: 15 * 60 * 1000 });

  let log = '';
  try { log = fs.readFileSync(LOG, 'utf-8'); } catch { log = proc.stdout ?? ''; }
  const errors = log.split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => /^(Compile Error|Compile Fatal Error|Metadata Error|.*Validation Error)/.test(l));
  return { ok: errors.length === 0, errors };
}

function main(): void {
  const argv = process.argv.slice(2);
  if (argv.includes('--baseline')) {
    const b = build();
    console.log(`BASELINE (sandbox as-is, no goldens written): ok=${b.ok}`);
    for (const e of b.errors.slice(0, 10)) console.log(`   ${e}`);
    return;
  }
  const limitIdx = argv.indexOf('--limit');
  const limit = limitIdx >= 0 ? Number(argv[limitIdx + 1]) : 0;

  let ids = capturedCases();
  if (limit > 0) ids = ids.slice(0, limit);
  console.log(`verifying ${ids.length} captured case(s), isolated, full build each\n`);

  const results: CaseResult[] = [];
  for (const [i, caseId] of ids.entries()) {
    const arts = artifactsFor(caseId);
    const written: string[] = [];
    const skipped: string[] = [];

    for (const a of arts) {
      const dir = path.join(MODEL_ROOT, a.root);
      fs.mkdirSync(dir, { recursive: true });
      const target = path.join(dir, `${a.name}.xml`);
      if (fs.existsSync(target)) { skipped.push(`${a.root}/${a.name}`); continue; }
      fs.writeFileSync(target, a.xml, 'utf8');
      written.push(target);
    }

    const { ok, errors } = build();
    for (const w of written) { try { fs.unlinkSync(w); } catch { /* already gone */ } }

    results.push({ caseId, artifacts: arts.length, skipped, ok, errors });
    const note = skipped.length ? `, ${skipped.length} pre-existing skipped` : '';
    console.log(`${String(i + 1).padStart(2)}/${ids.length} ${ok ? '✅' : '❌'} ${caseId}  (${arts.length} artifact(s)${note})`);
    for (const e of errors.slice(0, 4)) console.log(`        ${e.slice(0, 170)}`);
    fs.writeFileSync(OUT, JSON.stringify(results, null, 2), 'utf8');
  }

  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} clean · ${failed.length} with errors`);
  for (const f of failed) console.log(`  ❌ ${f.caseId}`);
}

main();
