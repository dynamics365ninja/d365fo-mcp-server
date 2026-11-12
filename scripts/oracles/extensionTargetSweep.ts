/**
 * The extension-target sweep — run the `coc-target`, `handler-target` and
 * `obsolete-method` checks over Microsoft's shipped X++ and fail on any ERROR.
 *
 * Same bar as the validator sweep: every file here compiles inside the product,
 * so an error these checks raise on it is a false positive of ours. Warnings are
 * counted and sampled, never gated.
 *
 * Two passes, because the obsolete check needs to know the targets first:
 *  1. collect every method declared `[SysObsolete(…, true)]`, and run the
 *     wrapper/handler checks on every file that declares a wrapper or handler;
 *  2. run the full resolver on the files that mention one of those method names,
 *     keeping only the `obsolete-method` findings.
 *
 * Needs the symbol index (the checks read declarations from it), so it runs on a
 * machine with a built index, never in CI:
 *
 *   npm run oracle:extension-targets -- [--db data/xpp-metadata.db]
 *     [--packages ApplicationSuite] [--limit 500] [--json sweep.json] [--skip-obsolete]
 *
 * Exit code is 1 when an error-severity finding exists.
 */
import * as fs from 'fs';
import { DatabaseSync } from 'node:sqlite';
import { checkExtensionTargets } from '../../src/tools/write/extensionTargets.js';
import {
  OBJECT_BUILTIN_METHODS,
  resolveXppReferences,
  TABLE_BUILTIN_METHODS,
  type ReferenceViolation,
} from '../../src/tools/write/resolveReferences.js';
import { parseArgs, walkAot, walkOptionsFromArgs, xppOf } from './aotSource.js';

interface Finding extends ReferenceViolation {
  file: string;
  packageName: string;
}

const NEW_KINDS = new Set(['coc-target', 'handler-target', 'obsolete-method']);
const XPP_TYPES = ['AxClass', 'AxTable', 'AxForm', 'AxView', 'AxMap', 'AxDataEntityView', 'AxTableExtension', 'AxFormExtension'];

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const fromArgs = walkOptionsFromArgs(args);
  const walkOptions = { ...fromArgs, types: fromArgs.types ?? XPP_TYPES };
  const dbPath = typeof args.db === 'string' ? args.db : 'data/xpp-metadata.db';
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const kernel = { table: TABLE_BUILTIN_METHODS, object: OBJECT_BUILTIN_METHODS };
  const started = Date.now();

  const findings: Finding[] = [];
  const obsoleteNames = new Set<string>();
  let scanned = 0;
  let extensionFiles = 0;

  // Pass 1
  for (const file of walkAot(walkOptions)) {
    scanned++;
    if (scanned % 20000 === 0) process.stderr.write(`  pass 1: ${scanned} files…\n`);
    const code = xppOf(file);
    for (const m of code.matchAll(/\bSysObsolete(?:Attribute)?\s*\([^)]*?,\s*true\b[^)]*\)\s*\]\s*(?:\[[^\]]*\]\s*)*[^(\n{]*?\b(\w+)\s*\(/gi)) {
      obsoleteNames.add(m[1]);
    }
    if (!/\bExtensionOf\b|\bSubscribesTo\b|HandlerFor\b/.test(code)) continue;
    extensionFiles++;
    for (const v of checkExtensionTargets(code, db, kernel)) {
      findings.push({ ...v, file: file.file, packageName: file.packageName });
    }
  }

  const pass1Seconds = (Date.now() - started) / 1000;
  process.stderr.write(`  pass 1 done in ${pass1Seconds.toFixed(0)} s\n`);

  // Pass 2
  const names = [...obsoleteNames];
  const mention = names.length
    ? new RegExp(`(?:::|\\.)\\s*(?:${names.map(n => n.replace(/\W/g, '')).join('|')})\\s*\\(`)
    : null;
  let obsoleteFiles = 0;
  // Pass 2 resolves every call in ~40k files (~40 min); --skip-obsolete re-checks wrappers/handlers alone.
  if (mention && args['skip-obsolete'] !== true) {
    const deps = { db, getLabelById: () => [], getLabelFileIds: () => [] };
    for (const file of walkAot(walkOptions)) {
      const code = xppOf(file);
      if (!mention.test(code)) continue;
      obsoleteFiles++;
      for (const v of resolveXppReferences(code, deps).violations) {
        if (v.kind === 'obsolete-method') findings.push({ ...v, file: file.file, packageName: file.packageName });
      }
    }
  }

  const relevant = findings.filter(f => NEW_KINDS.has(f.kind));
  const errors = relevant.filter(f => f.severity === 'error');
  const warnings = relevant.filter(f => f.severity === 'warning');
  const byKind = new Map<string, number>();
  for (const f of relevant) byKind.set(`${f.kind}/${f.severity}`, (byKind.get(`${f.kind}/${f.severity}`) ?? 0) + 1);

  console.log(`\nScanned ${scanned} files: ${extensionFiles} with wrappers/handlers, ` +
    `${obsoleteNames.size} error-obsolete method names, ${obsoleteFiles} files calling one of them.`);
  console.log(`Findings: ${errors.length} error(s), ${warnings.length} warning(s) in ${((Date.now() - started) / 1000).toFixed(0)} s.`);
  for (const [k, n] of [...byKind].sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(28)} ${n}`);
  for (const f of errors.slice(0, 40)) {
    console.log(`\n❌ ${f.kind} ${f.identifier} — ${f.file}:${f.line}\n   ${f.detail.slice(0, 300)}`);
  }
  if (typeof args.json === 'string') {
    fs.writeFileSync(args.json, `${JSON.stringify({ errors, warnings: warnings.slice(0, 500) }, null, 2)}\n`, 'utf8');
    console.log(`→ ${args.json}`);
  }
  process.exitCode = errors.length > 0 ? 1 : 0;
}

main();
