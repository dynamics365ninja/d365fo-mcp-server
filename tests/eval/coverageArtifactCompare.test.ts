/**
 * `eval:coverage --check` must not depend on how git checked the artifacts out.
 *
 * Regression, found 2026-07-28 right after merging to main: the gate reported
 *
 *     ❌ stale coverage artifact(s): eval/coverage.json, eval/COVERAGE.md,
 *        README.md (coverage badge) — run `npm run eval:coverage` and commit.
 *
 * while `git diff` was EMPTY. The artifacts are written with `\n`, but
 * `core.autocrlf=true` (git's default on Windows, and what this repo's dev VM
 * uses — measured: 1231 CRLF, 0 bare LF in a freshly checked-out
 * eval/coverage.json) converts them to `\r\n` on checkout. The byte comparison
 * then called every such checkout stale, and git normalized back on the way
 * in, so nothing showed in the diff.
 *
 * Why it mattered rather than being cosmetic: the gate passed in CI
 * (ubuntu-latest, LF) and failed for every Windows developer, so locally it
 * proved nothing — and the natural "fix", regenerating and committing, would
 * have committed CRLF artifacts and broken the gate on Linux instead.
 */

import { describe, it, expect } from 'vitest';
import {
  normalizeEol,
  dominantEol,
  stripGeneratedAt,
  withBadge,
  BADGE_START,
  BADGE_END,
} from '../../src/eval/coverage/artifactCompare';
import type { CoverageReport } from '../../src/eval/coverage/coverage';

const report = (corePct: number, totalPct: number) => ({
  core: { tier: 'core', total: 44, covered: 44, percent: corePct },
  total: { tier: 'all', total: 78, covered: 67, percent: totalPct },
  leaves: [],
  orphans: { knowledge: [], cases: [] },
  queue: [],
} as unknown as CoverageReport);

const MD = [
  '# Coverage — what "100%" means',
  '',
  '_Generated 2026-07-28_',
  '',
  '| leaf | K | E | T |',
].join('\n');

const README = [
  '# d365fo-mcp-server',
  '',
  BADGE_START,
  '[![Core coverage](https://img.shields.io/badge/core_coverage-97.7%25-brightgreen.svg)](eval/COVERAGE.md) [![Total coverage](https://img.shields.io/badge/total_coverage-84.6%25-lightgrey.svg)](eval/COVERAGE.md)',
  BADGE_END,
  '',
  'Body text.',
].join('\n');

const toCrlf = (s: string) => s.replace(/\n/g, '\r\n');

describe('coverage artifact staleness ignores line endings', () => {
  it('the same markdown compares equal whether checked out LF or CRLF', () => {
    expect(stripGeneratedAt(toCrlf(MD))).toBe(stripGeneratedAt(MD));
  });

  it('strips the generated-at line even with CRLF (the `$` anchor sat after a stray \\r)', () => {
    expect(stripGeneratedAt(toCrlf(MD))).not.toContain('_Generated');
    expect(stripGeneratedAt(MD)).not.toContain('_Generated');
  });

  it('still detects REAL markdown drift, so the gate is not merely disarmed', () => {
    const changed = MD.replace('| leaf | K | E | T |', '| leaf | K | E |');
    expect(stripGeneratedAt(toCrlf(changed))).not.toBe(stripGeneratedAt(MD));
  });

  it('the same JSON compares equal across line endings, but differing JSON does not', () => {
    const json = '{\n  "core": 44\n}\n';
    expect(normalizeEol(toCrlf(json))).toBe(normalizeEol(json));
    expect(normalizeEol('{\n  "core": 43\n}\n')).not.toBe(normalizeEol(json));
  });
});

describe('withBadge keeps the README consistent', () => {
  it('is idempotent on an unchanged report — the badge block does not churn', () => {
    const current = withBadge(README, report(97.7, 84.6));
    expect(normalizeEol(current)).toBe(normalizeEol(README));
  });

  it('is idempotent on a CRLF README too (this was the third false "stale")', () => {
    const crlf = toCrlf(README);
    expect(normalizeEol(withBadge(crlf, report(97.7, 84.6)))).toBe(normalizeEol(crlf));
  });

  it('preserves CRLF instead of splicing in mixed endings', () => {
    const out = withBadge(toCrlf(README), report(100, 85.9));
    expect(out).not.toMatch(/[^\r]\n/);      // no bare LF left behind
    expect(dominantEol(out)).toBe('\r\n');
  });

  it('preserves LF on an LF README', () => {
    const out = withBadge(README, report(100, 85.9));
    expect(out).not.toContain('\r');
  });

  it('still rewrites the badge when the numbers actually change', () => {
    const out = withBadge(README, report(100, 85.9));
    expect(out).toContain('core_coverage-100%25-brightgreen');
    expect(out).toContain('total_coverage-85.9%25-lightgrey');
    expect(out).not.toContain('core_coverage-97.7');
  });

  it('leaves a README without the badge markers untouched', () => {
    const plain = '# no badge here\n';
    expect(withBadge(plain, report(100, 85.9))).toBe(plain);
  });
});
