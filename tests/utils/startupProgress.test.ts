/**
 * The "still loading" answer says what the server is loading.
 *
 * A first start with an empty database indexes the whole packages directory
 * before dbReady resolves — tens of minutes — and every symbol-backed tool in
 * that window gets the same refusal. Until this existed the refusal was
 * byte-identical on the first attempt and the twentieth, so nothing told a user
 * whether the build was progressing or the server had died.
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
  startupIndexBegan,
  setStartupIndexProgress,
  clearStartupIndexProgress,
  getStartupIndexProgress,
  describeStartupIndex,
} from '../../src/utils/startupProgress';

afterEach(() => clearStartupIndexProgress());

describe('describeStartupIndex', () => {
  it('says nothing when no build is running — the generic wait keeps its wording', () => {
    expect(describeStartupIndex()).toBeNull();
  });

  it('names the model and its position once a build is under way', () => {
    setStartupIndexProgress(
      { phase: 'indexing', model: 'ApplicationSuite', modelIndex: 3, modelCount: 32 },
      1_000,
    );
    const text = describeStartupIndex(61_000)!;
    expect(text).toContain('ApplicationSuite');
    expect(text).toContain('model 3 of 32');
    expect(text).toContain('60 s in');
  });

  it('keeps elapsed time across a phase change, so it never restarts at zero', () => {
    startupIndexBegan(0);
    setStartupIndexProgress({ phase: 'indexing', model: 'Foundation', modelIndex: 1, modelCount: 4 }, 30_000);
    setStartupIndexProgress({ phase: 'fts', modelCount: 4 }, 600_000);
    // 10 minutes since the build began, not since the FTS phase started.
    expect(describeStartupIndex(600_000)).toContain('10 min in');
  });

  it('describes the phases that are not per-model', () => {
    setStartupIndexProgress({ phase: 'scanning', modelCount: 32 }, 0);
    expect(describeStartupIndex(5_000)).toContain('sizing 32 models');

    setStartupIndexProgress({ phase: 'fts', modelCount: 32 }, 0);
    expect(describeStartupIndex(5_000)).toMatch(/last step, rebuilding full-text search/);
  });

  it('reports elapsed rather than a percentage', () => {
    // Models are indexed largest-first and differ by two orders of magnitude in
    // size, so "3 of 32" is nothing like 9 % of the work — any percentage drawn
    // from the count would be a confident lie.
    setStartupIndexProgress({ phase: 'indexing', model: 'Foundation', modelIndex: 3, modelCount: 32 }, 0);
    expect(describeStartupIndex(60_000)).not.toMatch(/\d+\s*%/);
  });

  it('forgets the build when it ends, so a stale phase cannot outlive it', () => {
    setStartupIndexProgress({ phase: 'indexing', model: 'Foundation', modelIndex: 1, modelCount: 4 });
    expect(getStartupIndexProgress()).not.toBeNull();
    clearStartupIndexProgress();
    expect(describeStartupIndex()).toBeNull();
  });
});
