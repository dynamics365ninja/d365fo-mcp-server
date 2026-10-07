import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DEFAULT_CREDITS, computeAic, loadCreditsConfig, ratesForModel, usdFromTokens } from '../../src/benchmark/credits.js';

describe('credits — AIC from whatever the record carries', () => {
  it('takes a host figure already in credits as is', () => {
    expect(computeAic(DEFAULT_CREDITS, { model: 'gpt-x', hostCost: { value: 305.18, unit: 'AIU' }, inputTokens: 1, cachedTokens: 0, outputTokens: 1 }))
      .toEqual({ value: 305.18, source: 'host' });
  });

  it('converts a USD host cost with creditsPerUsd', () => {
    expect(computeAic(DEFAULT_CREDITS, { model: 'claude-opus-5-5', hostCost: { value: 1.25, unit: 'USD' }, inputTokens: 0, cachedTokens: 0, outputTokens: 0 }))
      .toEqual({ value: 125, source: 'host-cost' });
  });

  it('falls back to the model rate table when there is no cost', () => {
    const r = computeAic(DEFAULT_CREDITS, { model: 'claude-sonnet-5-5', hostCost: null, inputTokens: 1_100_000, cachedTokens: 1_000_000, outputTokens: 100_000 });
    // 1M cached × 0.20 + 100k uncached × 2 + 100k output × 10 = 0.2 + 0.2 + 1.0 USD = 1.4 USD → 140 AIC
    expect(r?.source).toBe('rates');
    expect(r?.value).toBeCloseTo(140, 6);
    expect(r?.rates).toEqual({ cached: 0.2, uncached: 2, output: 10 });
  });

  it('matches the most specific rate first and aliases last', () => {
    expect(ratesForModel(DEFAULT_CREDITS, 'claude-opus-5-5')?.uncached).toBe(4);
    expect(ratesForModel(DEFAULT_CREDITS, 'claude-opus-5')?.uncached).toBe(5);
    expect(ratesForModel(DEFAULT_CREDITS, 'opus')?.uncached).toBe(4);
    expect(ratesForModel(DEFAULT_CREDITS, 'gpt-5')).toBeNull();
  });

  it('refuses to price a run it knows nothing about', () => {
    expect(computeAic(DEFAULT_CREDITS, { model: 'gpt-5', hostCost: null, inputTokens: 10, cachedTokens: 0, outputTokens: 10 })).toBeNull();
    expect(computeAic(DEFAULT_CREDITS, { model: 'sonnet', hostCost: null, inputTokens: 0, cachedTokens: 0, outputTokens: 0 })).toBeNull();
  });

  it('never prices cached tokens twice', () => {
    const rates = { cached: 1, uncached: 10, output: 100 };
    // inputTokens includes the cached ones: 50 cached + 50 uncached.
    expect(usdFromTokens(rates, { inputTokens: 100, cachedTokens: 50, outputTokens: 0 })).toBeCloseTo((50 * 1 + 50 * 10) / 1e6, 12);
  });

  it('merges a user credits.json over the defaults, user rates first', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-credits-'));
    try {
      const file = path.join(dir, 'credits.json');
      fs.writeFileSync(file, '﻿' + JSON.stringify({ creditsPerUsd: 80, modelRates: [{ match: 'claude-sonnet', rates: { cached: 0.2, uncached: 2.5, output: 10 } }] }));
      const cfg = loadCreditsConfig(file);
      expect(cfg.unit).toBe('AIC');
      expect(cfg.creditsPerUsd).toBe(80);
      expect(ratesForModel(cfg, 'claude-sonnet-5-5')?.uncached).toBe(2.5);
      expect(ratesForModel(cfg, 'claude-haiku-4-5')?.uncached).toBe(1);
      expect(loadCreditsConfig(path.join(dir, 'missing.json'))).toBe(DEFAULT_CREDITS);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
