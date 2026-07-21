/**
 * "Is this copy current?" — a release check against the npm registry.
 *
 * An installation that sits on an old release is the most common cause of a
 * bug report that was already fixed, and nothing in the CLI used to say so:
 * `d365fo-mcp update` happily reported success after pulling a branch that had
 * long since been superseded. `doctor`, `setup` and `update` now all ask the
 * registry what the latest published version is and compare it with VERSION.
 *
 * The check is advisory in every caller — D365FO VMs are frequently offline or
 * behind a proxy, and a failed lookup must never block a setup or an update.
 * Every failure path therefore returns null rather than throwing, and the
 * request is time-boxed so an unreachable registry costs seconds, not minutes.
 */
import { VERSION } from '../version.js';

export const PACKAGE_NAME = 'd365fo-mcp';

/** Default registry, overridable the same way npm itself allows. */
function registryBase(): string {
  const configured = process.env.npm_config_registry?.trim();
  const base = configured && configured.length > 0 ? configured : 'https://registry.npmjs.org';
  return base.replace(/\/+$/, '');
}

/**
 * The version published under the `latest` dist-tag, or null when the registry
 * cannot be reached, answers with an error, or returns something unexpected.
 *
 * The dist-tags endpoint is used rather than the package document: it answers
 * with a few dozen bytes instead of several megabytes of release metadata.
 */
export async function fetchLatestVersion(timeoutMs = 4000): Promise<string | null> {
  try {
    const res = await fetch(`${registryBase()}/-/package/${PACKAGE_NAME}/dist-tags`, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: 'application/json' },
    });
    if (!res.ok) return null;
    const tags = (await res.json()) as Record<string, unknown>;
    const latest = tags.latest;
    return typeof latest === 'string' && latest.length > 0 ? latest : null;
  } catch {
    return null;
  }
}

/** Numeric part of a semver string, ignoring any prerelease/build suffix. */
function core(version: string): number[] {
  return version
    .replace(/^v/, '')
    .split(/[-+]/)[0]
    .split('.')
    .map(part => Number.parseInt(part, 10))
    .map(n => (Number.isFinite(n) ? n : 0));
}

/**
 * True when `current` is strictly behind `latest`.
 *
 * Only the major.minor.patch triple is compared. A prerelease is treated as
 * its release version, so 1.2.0-rc.1 does not report itself as behind 1.2.0 —
 * whoever installed a prerelease did it deliberately and does not need to be
 * nagged onto the release they were testing against.
 */
export function isBehind(current: string, latest: string): boolean {
  const a = core(current);
  const b = core(latest);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const left = a[i] ?? 0;
    const right = b[i] ?? 0;
    if (left !== right) return left < right;
  }
  return false;
}

export interface ReleaseStatus {
  current: string;
  /** null when the registry could not be reached. */
  latest: string | null;
  behind: boolean;
}

/** Compare the running version against the registry. Never throws. */
export async function checkRelease(timeoutMs?: number): Promise<ReleaseStatus> {
  const latest = await fetchLatestVersion(timeoutMs);
  return {
    current: VERSION,
    latest,
    behind: latest !== null && isBehind(VERSION, latest),
  };
}
