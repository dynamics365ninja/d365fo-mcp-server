/**
 * The form pattern sweep — run the form pattern validator over every AxForm
 * Microsoft ships and fail on anything we call an ERROR.
 *
 * The bar: **zero error-severity findings**. Every shipped form compiles, and the
 * compiler validates each one against the same platform pattern definitions this
 * validator is generated from, so an error raised here is our bug. (Measured
 * 2026-11-10 with scripts/oracles/patternAnalyzer.ts: the platform's own
 * PatternAnalyzer accepts every patterned node of every shipped form.)
 *
 * Warnings are counted, never gated.
 *
 * Usage (VM or UDE box):
 *   npx tsx scripts/oracles/formPatternSweep.ts
 *   npx tsx scripts/oracles/formPatternSweep.ts --limit 2000 --json sweep.json
 *   PACKAGES_ROOT=K:/AosService/PackagesLocalDirectory npx tsx scripts/oracles/formPatternSweep.ts
 *
 * Exit code is 1 when an error-severity finding exists.
 */
import * as fs from 'fs';
import * as path from 'path';
import { validateFormPatternXml } from '../../src/validation/formPatternValidator.js';
import { packagesRoot } from './patternAnalyzer.js';

function formFiles(root: string): string[] {
  const files: string[] = [];
  for (const pkg of fs.readdirSync(root).sort()) {
    const pkgPath = path.join(root, pkg);
    let models: string[];
    try {
      if (!fs.statSync(pkgPath).isDirectory()) continue;
      models = fs.readdirSync(pkgPath);
    } catch {
      continue;
    }
    for (const model of models) {
      const dir = path.join(pkgPath, model, 'AxForm');
      let names: string[];
      try {
        names = fs.readdirSync(dir);
      } catch {
        continue;
      }
      for (const n of names) if (n.endsWith('.xml')) files.push(path.join(dir, n));
    }
  }
  return files;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const limitIdx = args.indexOf('--limit');
  const limit = limitIdx >= 0 ? Number(args[limitIdx + 1]) : Infinity;
  const jsonIdx = args.indexOf('--json');
  const jsonOut = jsonIdx >= 0 ? args[jsonIdx + 1] : undefined;

  const root = packagesRoot();
  const files = formFiles(root).slice(0, limit);
  const started = Date.now();
  const errors: Array<{ file: string; rule: string; path: string; excerpt: string }> = [];
  const errorCounts = new Map<string, number>();
  const warningCounts = new Map<string, number>();
  let patterned = 0;

  for (const file of files) {
    const xml = fs.readFileSync(file, 'utf8');
    const report = await validateFormPatternXml(xml);
    if (report.pattern) patterned++;
    for (const v of report.violations) {
      if (v.severity === 'error') {
        errors.push({ file: path.relative(root, file), rule: v.rule, path: v.path, excerpt: v.excerpt });
        errorCounts.set(v.rule, (errorCounts.get(v.rule) ?? 0) + 1);
      } else {
        warningCounts.set(v.rule, (warningCounts.get(v.rule) ?? 0) + 1);
      }
    }
  }

  const secs = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`Swept ${files.length} forms (${patterned} with a Design pattern) under ${root} in ${secs}s`);
  console.log(`Errors: ${errors.length}  ${[...errorCounts].map(([r, c]) => `${r}=${c}`).join(' ')}`);
  console.log(`Warnings: ${[...warningCounts].sort((a, b) => b[1] - a[1]).map(([r, c]) => `${r}=${c}`).join(' ')}`);
  for (const e of errors.slice(0, 40)) console.log(`  ${e.rule} ${e.file} ${e.path}: ${e.excerpt}`);
  if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify({ root, forms: files.length, errors }, null, 2));
  process.exit(errors.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
