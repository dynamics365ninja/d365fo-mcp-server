/**
 * AI Credits (AIC) — one cost axis for runs made on different hosts.
 *
 * GitHub Copilot bills every plan in AI Credits since June 2026 and computes
 * them from token consumption at each model's listed API rate; its debug log
 * records the figure per request (`copilotUsageNanoAiu`, read by
 * cli/session/copilotChatLog.ts). Claude Code reports USD. To put both on one
 * axis the report needs a conversion, and this module owns it:
 *
 *   1. the host bills in credits           → use its figure as is   (source 'host')
 *   2. the host bills in USD               → × creditsPerUsd         (source 'host-cost')
 *   3. the host records tokens, no cost    → tokens × model rates × creditsPerUsd  (source 'rates')
 *
 * `creditsPerUsd` defaults to 100 — one credit per cent. That is the reading
 * under which the rates fitted from a real Copilot log (20 / 250 / 1000 AIU per
 * Mtok cached / uncached / output, tests/cli/sessionCost.test.ts) line up with
 * Sonnet-class API prices. It is a documented assumption, not a measurement:
 * change it in eval/benchmark/credits.json if the billing page says otherwise.
 * Every derived figure carries its `source` so the report can say "derived".
 */
import * as fs from 'node:fs';
import type { AicSource, CreditsConfig, ModelRates } from './types.js';
import { readJsonLenient } from '../utils/jsonRecords.js';

const TOKENS_PER_MTOK = 1e6;

/**
 * List prices (USD per Mtok) for the models a Claude Code run can name. Cache
 * reads are 10 % of the input price unless the model publishes another figure
 * (Opus 5.5 publishes $0.20). Only consulted when a host records tokens but
 * no cost — Claude Code's own `total_cost_usd` is preferred when present.
 */
export const DEFAULT_CREDITS: CreditsConfig = {
  unit: 'AIC',
  creditUnits: ['AIC', 'AIU'],
  creditsPerUsd: 100,
  modelRates: [
    { match: 'claude-fable-5-1', rates: { cached: 1.0, uncached: 10, output: 50 } },
    { match: 'claude-fable-5', rates: { cached: 1.0, uncached: 10, output: 50 } },
    { match: 'claude-opus-5-5', rates: { cached: 0.2, uncached: 4, output: 20 } },
    { match: 'claude-opus-5', rates: { cached: 0.5, uncached: 5, output: 25 } },
    { match: 'claude-opus-4', rates: { cached: 0.5, uncached: 5, output: 25 } },
    { match: 'claude-sonnet-5', rates: { cached: 0.2, uncached: 2, output: 10 } },
    { match: 'claude-sonnet-4', rates: { cached: 0.3, uncached: 3, output: 15 } },
    { match: 'claude-haiku-4', rates: { cached: 0.1, uncached: 1, output: 5 } },
    // Aliases Claude Code accepts on --model, for a record whose host never resolved them.
    { match: 'fable', rates: { cached: 1.0, uncached: 10, output: 50 } },
    { match: 'opus', rates: { cached: 0.2, uncached: 4, output: 20 } },
    { match: 'sonnet', rates: { cached: 0.2, uncached: 2, output: 10 } },
    { match: 'haiku', rates: { cached: 0.1, uncached: 1, output: 5 } },
  ],
};

function isRates(x: unknown): x is ModelRates {
  if (!x || typeof x !== 'object') return false;
  const r = x as Record<string, unknown>;
  return ['cached', 'uncached', 'output'].every(k => typeof r[k] === 'number' && Number.isFinite(r[k] as number));
}

/**
 * Read eval/benchmark/credits.json over the defaults. A missing file means the
 * defaults; a present file overrides field by field, and its `modelRates` are
 * tried BEFORE the built-in ones so a refitted rate wins without the user having
 * to copy the whole table.
 */
export function loadCreditsConfig(file: string | null): CreditsConfig {
  if (!file || !fs.existsSync(file)) return DEFAULT_CREDITS;
  const raw = readJsonLenient<Record<string, unknown>>(file);
  const userRates = Array.isArray(raw.modelRates)
    ? (raw.modelRates as unknown[]).filter(
        (e): e is { match: string; rates: ModelRates } =>
          !!e && typeof e === 'object' && typeof (e as any).match === 'string' && isRates((e as any).rates),
      )
    : [];
  return {
    unit: typeof raw.unit === 'string' && raw.unit.trim() ? raw.unit.trim() : DEFAULT_CREDITS.unit,
    creditUnits: Array.isArray(raw.creditUnits)
      ? (raw.creditUnits as unknown[]).filter((u): u is string => typeof u === 'string')
      : DEFAULT_CREDITS.creditUnits,
    creditsPerUsd:
      typeof raw.creditsPerUsd === 'number' && raw.creditsPerUsd > 0 ? raw.creditsPerUsd : DEFAULT_CREDITS.creditsPerUsd,
    modelRates: [...userRates, ...DEFAULT_CREDITS.modelRates],
  };
}

export function ratesForModel(cfg: CreditsConfig, model: string): ModelRates | null {
  const needle = model.toLowerCase();
  for (const entry of cfg.modelRates) {
    if (needle.includes(entry.match.toLowerCase())) return entry.rates;
  }
  return null;
}

export interface AicInput {
  model: string;
  hostCost: { value: number; unit: string } | null;
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
}

export function usdFromTokens(rates: ModelRates, tokens: Pick<AicInput, 'inputTokens' | 'cachedTokens' | 'outputTokens'>): number {
  const uncached = Math.max(0, tokens.inputTokens - tokens.cachedTokens);
  return (
    (tokens.cachedTokens / TOKENS_PER_MTOK) * rates.cached +
    (uncached / TOKENS_PER_MTOK) * rates.uncached +
    (tokens.outputTokens / TOKENS_PER_MTOK) * rates.output
  );
}

/** Six decimals: enough for a sub-cent cell, and keeps 0.0734 × 100 from landing in a record as 7.340000000000001. */
function round6(v: number): number {
  return Number(v.toFixed(6));
}

/** The AIC figure for a run, or null when nothing in the record can price it. */
export function computeAic(
  cfg: CreditsConfig,
  input: AicInput,
): { value: number; source: AicSource; rates?: ModelRates } | null {
  const cost = input.hostCost;
  if (cost && Number.isFinite(cost.value)) {
    const unit = cost.unit.toUpperCase();
    if (cfg.creditUnits.some(u => u.toUpperCase() === unit)) return { value: cost.value, source: 'host' };
    if (unit === 'USD') return { value: round6(cost.value * cfg.creditsPerUsd), source: 'host-cost' };
  }
  const rates = ratesForModel(cfg, input.model);
  if (!rates) return null;
  if (input.inputTokens === 0 && input.outputTokens === 0) return null;
  return { value: round6(usdFromTokens(rates, input) * cfg.creditsPerUsd), source: 'rates', rates };
}
