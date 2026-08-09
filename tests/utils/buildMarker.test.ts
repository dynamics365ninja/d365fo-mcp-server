/**
 * The caveat that run_bp_check and verify_d365fo_project were missing.
 *
 * Both answer confidently without compiling anything. Run f2e7b71a never called
 * build_d365fo_project, was told "✅ BP Check passed — 0 with findings" and given a
 * fully green verification table, and shipped a CoC method that violates SYS10028.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { recordBuild, readBuildRecord, describeBuildFreshness } from '../../src/utils/buildMarker';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'd365fo-buildmarker-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const touch = (name: string): string => {
  const p = path.join(dir, name);
  fs.writeFileSync(p, 'x');
  return p;
};

describe('describeBuildFreshness', () => {
  it('says nothing has compiled the model when no build was ever recorded', () => {
    const note = describeBuildFreshness(dir, 'AslFinanceSK');

    expect(note).toContain('Not compiled');
    expect(note).toContain('SYS10028');
    expect(note).toContain('fullBuild: true');
  });

  it('treats a failed build as no build', () => {
    recordBuild(dir, 'AslFinanceSK', {
      builtAt: new Date().toISOString(),
      fullBuild: true,
      succeeded: false,
    });

    expect(describeBuildFreshness(dir, 'AslFinanceSK')).toContain('Not compiled');
  });

  it('flags a green build that predates the objects it is being credited for', () => {
    recordBuild(dir, 'AslFinanceSK', {
      builtAt: new Date(Date.now() - 60_000).toISOString(),
      fullBuild: true,
      succeeded: true,
    });
    const written = touch('AslFinSK_QualityTier.xml');

    expect(describeBuildFreshness(dir, 'AslFinanceSK', [written])).toContain('Stale');
  });

  it('confirms a full build that came after the last write', () => {
    const written = touch('AslFinSK_QualityTier.xml');
    recordBuild(dir, 'AslFinanceSK', {
      builtAt: new Date(Date.now() + 60_000).toISOString(),
      fullBuild: true,
      succeeded: true,
    });

    expect(describeBuildFreshness(dir, 'AslFinanceSK', [written])).toContain('✅ Compiled');
  });

  it('keeps the incremental caveat — a green incremental is not proof the model compiles', () => {
    const written = touch('AslFinSK_QualityTier.xml');
    recordBuild(dir, 'AslFinanceSK', {
      builtAt: new Date(Date.now() + 60_000).toISOString(),
      fullBuild: false,
      succeeded: true,
    });

    expect(describeBuildFreshness(dir, 'AslFinanceSK', [written])).toContain('INCREMENTAL');
  });

  it('keeps models apart', () => {
    recordBuild(dir, 'AslFinanceSK', {
      builtAt: new Date().toISOString(),
      fullBuild: true,
      succeeded: true,
    });

    expect(describeBuildFreshness(dir, 'AslFinanceCZ')).toContain('Not compiled');
    expect(readBuildRecord(dir, 'AslFinanceSK')?.fullBuild).toBe(true);
  });

  it('survives an unreadable marker rather than throwing into the caller', () => {
    fs.writeFileSync(path.join(dir, '.last-build.json'), '{ this is not json');

    expect(() => describeBuildFreshness(dir, 'AslFinanceSK')).not.toThrow();
    expect(readBuildRecord(dir, 'AslFinanceSK')).toBeUndefined();
  });
});
