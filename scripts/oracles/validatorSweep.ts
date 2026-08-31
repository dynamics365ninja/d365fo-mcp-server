/**
 * The validator sweep — run every `validate_code` rule over Microsoft's shipped
 * X++ and fail on anything we call an ERROR.
 *
 * The bar, and the reason it is a bar: **zero error-severity findings**. Every
 * file scanned here compiles inside the product, so an error we raise on it is
 * ours, not Microsoft's. That single measurement is what killed five rules'
 * worth of false positives in the compiler-verified wave (FN001 counting a comma
 * inside `','`, CS001 on a GUID mask, SEL007 on an SQL string, COC001 on a new
 * method with default parameters, COC002/003 reading a doc comment) and it is
 * what must keep them dead.
 *
 * Warnings are counted, never gated: they are advice, and advice may disagree
 * with shipped code. The report prints the top warning rules so noise stays
 * visible instead of accumulating silently.
 *
 * Usage:
 *   npm run oracle:sweep                     # VM: the full shipped corpus (~2 min)
 *   npm run oracle:sweep -- --dry            # CI: tests/fixtures/oracles (instant)
 *   npm run oracle:sweep -- --limit 500 --types AxClass
 *   npm run oracle:sweep -- --json sweep.json
 *
 * Exit code is 1 when an error-severity finding exists, so it can gate a PR.
 */
import * as fs from 'fs';
import { runRules } from '../../src/tools/analysis/validateXpp.js';
import { lintXppSelect } from '../../src/utils/xppSelectLint.js';
import { parseArgs, walkAot, walkOptionsFromArgs, xppOf } from './aotSource.js';

interface Finding {
  rule: string;
  severity: 'error' | 'warning';
  file: string;
  packageName: string;
  excerpt: string;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const walkOptions = walkOptionsFromArgs(args);
  const started = Date.now();

  const errors: Finding[] = [];
  const warningCounts = new Map<string, number>();
  const selectLintFiles: { file: string; warnings: string[] }[] = [];
  let files = 0;
  let bytes = 0;

  for (const file of walkAot(walkOptions)) {
    const xpp = xppOf(file);
    if (!xpp.trim()) continue;
    files++;
    bytes += xpp.length;

    for (const v of runRules(xpp, 'xpp')) {
      if (v.severity === 'error') {
        errors.push({
          rule: v.rule,
          severity: 'error',
          file: file.file,
          packageName: file.packageName,
          excerpt: v.excerpt.slice(0, 160),
        });
      } else {
        warningCounts.set(v.rule, (warningCounts.get(v.rule) ?? 0) + 1);
      }
    }

    // The modify path runs this one separately, so the sweep must too — it had
    // its own false positive (a `where` after `join`, which is standard X++).
    const selectWarnings = lintXppSelect(xpp);
    if (selectWarnings.length) selectLintFiles.push({ file: file.file, warnings: selectWarnings });

    if (files % 1000 === 0) process.stderr.write(`  …${files} files\n`);
  }

  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  console.log(
    `swept ${files} files (${(bytes / 1024 / 1024).toFixed(1)} MB of X++) in ${seconds}s` +
    `${walkOptions.dry ? ' [dry: fixture corpus]' : ''}`,
  );

  const byRule = new Map<string, Finding[]>();
  for (const e of errors) {
    const list = byRule.get(e.rule) ?? [];
    list.push(e);
    byRule.set(e.rule, list);
  }

  console.log('\nERROR-severity findings (the bar is zero):');
  if (!byRule.size) {
    console.log('  none');
  } else {
    for (const [rule, list] of [...byRule.entries()].sort((a, b) => b[1].length - a[1].length)) {
      console.log(`  ${rule}: ${list.length}`);
      for (const f of list.slice(0, 3)) {
        console.log(`    ${f.packageName} ${f.file.split(/[\\/]/).pop()} — ${f.excerpt.replace(/\s+/g, ' ')}`);
      }
      if (list.length > 3) console.log(`    …and ${list.length - 3} more`);
    }
  }

  console.log('\nWarning-severity counts (advisory, not gated):');
  const warnings = [...warningCounts.entries()].sort((a, b) => b[1] - a[1]);
  if (!warnings.length) console.log('  none');
  for (const [rule, count] of warnings.slice(0, 15)) console.log(`  ${rule}: ${count}`);
  console.log(`  lintXppSelect: ${selectLintFiles.length} files`);

  if (typeof args.json === 'string') {
    fs.writeFileSync(args.json, `${JSON.stringify({
      sweptAt: new Date().toISOString(),
      dry: Boolean(walkOptions.dry),
      files,
      bytes,
      seconds: Number(seconds),
      errors,
      warningCounts: Object.fromEntries(warnings),
      selectLintFiles: selectLintFiles.slice(0, 200),
    }, null, 2)}\n`, 'utf8');
    console.log(`\n→ ${args.json}`);
  }

  if (errors.length) {
    console.error(
      `\nFAIL: ${errors.length} error-severity finding(s) on code that compiles in the product. ` +
      'Fix the rule, not the code.',
    );
    process.exit(1);
  }
}

main();
