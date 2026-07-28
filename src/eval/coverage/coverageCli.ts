/**
 * Coverage CLI (ROADMAP P3/P4) — VM-free.
 *
 *   npm run eval:coverage            # regenerate eval/COVERAGE.md + eval/coverage.json
 *   npm run eval:coverage -- --check # CI gate: fail if the artifacts are stale or a leaf points at something that no longer exists
 *   npm run eval:coverage -- --json  # print the report, write nothing
 *
 * The T flag comes from the real `d365fo_file` objectType enum, so a new tool
 * capability moves the number without anyone editing a table by hand; adding a
 * new AOT type or topic to the taxonomy without K/E/T visibly drops it.
 */

import * as fs from 'fs';
import { renderMarkdown, danglingReferences, type CoverageReport } from './coverage.js';
import { buildReport, JSON_PATH, MD_PATH, README_PATH } from './sources.js';
import { normalizeEol, stripGeneratedAt, withBadge } from './artifactCompare.js';

/** Machine-readable artifact — the shape the README badge and CI read. */
function toJson(report: CoverageReport) {
  return {
    core: report.core,
    total: report.total,
    leaves: report.leaves.map(l => ({
      id: l.leaf.id,
      label: l.leaf.label,
      domain: l.leaf.domain,
      tier: l.leaf.tier,
      weight: l.leaf.weight,
      k: l.k,
      e: l.e,
      t: l.t,
      covered: l.covered,
      cases: l.matchedCases,
    })),
    orphans: report.orphans,
  };
}

function main(): number {
  const argv = process.argv.slice(2);
  const check = argv.includes('--check');
  const asJson = argv.includes('--json');
  const report = buildReport();

  const dangling = danglingReferences(report);
  if (dangling.length > 0) {
    console.error('❌ taxonomy references things that no longer exist:');
    for (const d of dangling) console.error(`   ${d}`);
    return 1;
  }

  const json = `${JSON.stringify(toJson(report), null, 2)}\n`;
  const markdown = renderMarkdown(report, new Date().toISOString().slice(0, 10));

  if (asJson) {
    console.log(json);
    return 0;
  }

  const readme = fs.readFileSync(README_PATH, 'utf8');
  const readmeNext = withBadge(readme, report);

  if (check) {
    const stale: string[] = [];
    if (!fs.existsSync(JSON_PATH) || normalizeEol(fs.readFileSync(JSON_PATH, 'utf8')) !== normalizeEol(json)) {
      stale.push('eval/coverage.json');
    }
    if (!fs.existsSync(MD_PATH) || stripGeneratedAt(fs.readFileSync(MD_PATH, 'utf8')) !== stripGeneratedAt(markdown)) {
      stale.push('eval/COVERAGE.md');
    }
    if (normalizeEol(readme) !== normalizeEol(readmeNext)) stale.push('README.md (coverage badge)');
    if (stale.length > 0) {
      console.error(`❌ stale coverage artifact(s): ${stale.join(', ')} — run \`npm run eval:coverage\` and commit.`);
      return 1;
    }
    console.log(
      `✅ coverage up to date — core ${report.core.covered}/${report.core.total} (${report.core.percent}%), ` +
      `total ${report.total.covered}/${report.total.total} (${report.total.percent}%).`,
    );
    return 0;
  }

  fs.writeFileSync(JSON_PATH, json, 'utf8');
  fs.writeFileSync(MD_PATH, markdown, 'utf8');
  if (readme !== readmeNext) fs.writeFileSync(README_PATH, readmeNext, 'utf8');
  console.log(
    `core ${report.core.covered}/${report.core.total} (${report.core.percent}%) · ` +
    `total ${report.total.covered}/${report.total.total} (${report.total.percent}%)`,
  );
  console.log(`Wrote eval/COVERAGE.md + eval/coverage.json. Closure queue: ${report.queue.length} leaf/leaves.`);
  for (const r of report.queue.slice(0, 5)) {
    console.log(`   w${r.leaf.weight} ${r.leaf.label}`);
  }
  return 0;
}

process.exit(main());
