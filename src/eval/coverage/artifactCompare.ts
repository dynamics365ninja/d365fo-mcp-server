/**
 * Staleness comparison for the generated coverage artifacts.
 *
 * Split out of coverageCli so it can be tested without importing the CLI,
 * which runs `process.exit(main())` at module load.
 */

import type { CoverageReport } from './coverage.js';

export const BADGE_START = '<!-- coverage-badge:start -->';
export const BADGE_END = '<!-- coverage-badge:end -->';

/**
 * CRLF -> LF. Every staleness comparison runs through this.
 *
 * The artifacts are written with `\n`, but git checks them out with `\r\n`
 * wherever `core.autocrlf=true` (the default on Windows), so the old byte
 * comparison called every such checkout stale — while `git diff` showed
 * nothing, because git normalizes back on the way in. `--check` was dead
 * locally on Windows yet green in CI (ubuntu-latest), and the "obvious" fix —
 * regenerate and commit — commits CRLF artifacts and breaks the gate on Linux
 * instead.
 *
 * Line endings are not content here, so normalize rather than pin them: the
 * gate then holds under any core.autocrlf / .gitattributes setting instead of
 * depending on every clone agreeing.
 */
export const normalizeEol = (s: string): string => s.replace(/\r\n/g, '\n');

/** A file's dominant line ending, so a rewrite doesn't leave it mixed. */
export function dominantEol(s: string): string {
  return /\r\n/.test(s) ? '\r\n' : '\n';
}

/**
 * The generation timestamp must not make --check fail on an unchanged run.
 * Normalizes first: with CRLF the `$` anchor sits after a stray `\r`, so the
 * strip silently misses and every run looks stale.
 */
export function stripGeneratedAt(md: string): string {
  return normalizeEol(md).replace(/^_Generated .*_$/m, '');
}

/**
 * Rewrites the README badge block from the report. The badge is the public
 * reliability number — generated, never hand-edited, so it cannot quietly
 * disagree with eval/coverage.json.
 */
export function withBadge(readme: string, report: CoverageReport): string {
  const colour = report.core.percent >= 90 ? 'brightgreen' : report.core.percent >= 70 ? 'yellow' : 'orange';
  const badge =
    `[![Core coverage](https://img.shields.io/badge/core_coverage-${report.core.percent}%25-${colour}.svg)](eval/COVERAGE.md) ` +
    `[![Total coverage](https://img.shields.io/badge/total_coverage-${report.total.percent}%25-lightgrey.svg)](eval/COVERAGE.md)`;
  const start = readme.indexOf(BADGE_START);
  const end = readme.indexOf(BADGE_END);
  if (start < 0 || end < 0) return readme;
  // Match the file's own line ending: splicing `\n` into a CRLF README would
  // leave two mixed lines behind on every run.
  const nl = dominantEol(readme);
  return `${readme.slice(0, start + BADGE_START.length)}${nl}${badge}${nl}${readme.slice(end)}`;
}
