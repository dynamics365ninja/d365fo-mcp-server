/**
 * extract-metadata custom classification (`classifyCustom`)
 *
 * On UDE the ModelStoreFolder (custom root) holds our own model AND third-party ISV
 * models that ship X++ source. Two rules have to hold at once, and they pull in opposite
 * directions — this file pins both.
 *
 *   1. #711: with no CUSTOM_MODELS configured, "custom" on UDE means "lives under the
 *      custom root". Name-based isCustomModel() matches only D365FO_MODEL_NAME (and a
 *      case-sensitive EXTENSION_PREFIX), so using it here dropped every source ISV before
 *      it reached the extract manifest, and a `custom` build then reindexed exactly one
 *      model while the rest of the custom root went stale.
 *
 *   2. An explicit CUSTOM_MODELS list must still NARROW that set. The root-level package
 *      scan ignores CUSTOM_MODELS once customRoot is set, so the model-level check is the
 *      only place a wildcard can take effect. Making the classification purely path-based
 *      silently killed `CUSTOM_MODELS="Contoso*"` — the refresh would re-extract every ISV
 *      under the root with no way to scope it.
 *
 * Together: the path rule decides what CAN be custom, an explicit list decides how much of
 * it to extract. Traditional environments (no custom root) keep name-based behaviour.
 *
 * Regression guards:
 *   - a source ISV under the custom root MUST classify custom when CUSTOM_MODELS is empty
 *   - CUSTOM_MODELS="Contoso*" MUST keep narrowing that same ISV out of a custom-only run
 *   - the narrowing MUST NOT leak into traditional environments
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { classifyCustom } from '../../scripts/extract-metadata';

const CUSTOM_ROOT = 'C:\\UDE\\ModelStoreFolder';
const MS_ROOT = 'C:\\UDE\\PackagesLocalDirectory';
const TRADITIONAL_ROOT = 'C:\\AOSService\\PackagesLocalDirectory';

/** Env keys isCustomModel() reads — cleared per test so a developer .env cannot leak in. */
const ENV_KEYS = ['CUSTOM_MODELS', 'EXTENSION_PREFIX', 'D365FO_MODEL_NAME'] as const;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

describe('classifyCustom on UDE with no CUSTOM_MODELS (#711)', () => {
  beforeEach(() => {
    process.env.D365FO_MODEL_NAME = 'MyModel';
  });

  it('classifies a source ISV under the custom root as custom', () => {
    // The regression #711 fixed: Docentric matches neither D365FO_MODEL_NAME nor any
    // prefix, so name-based classification dropped it and the manifest listed 1 model.
    expect(classifyCustom(CUSTOM_ROOT, CUSTOM_ROOT, 'DocentricAXCore', [])).toEqual({
      isCustom: true,
      narrowedByConfig: false,
    });
  });

  it('classifies the configured model under the custom root as custom', () => {
    expect(classifyCustom(CUSTOM_ROOT, CUSTOM_ROOT, 'MyModel', []).isCustom).toBe(true);
  });

  it('classifies Microsoft packages outside the custom root as standard', () => {
    expect(classifyCustom(MS_ROOT, CUSTOM_ROOT, 'ApplicationSuite', [])).toEqual({
      isCustom: false,
      narrowedByConfig: false,
    });
  });

  it('does not rescue a model by name when it sits outside the custom root', () => {
    // Path wins over name on UDE — otherwise the two phases disagree about "custom".
    expect(classifyCustom(MS_ROOT, CUSTOM_ROOT, 'MyModel', []).isCustom).toBe(false);
  });
});

describe('classifyCustom on UDE with CUSTOM_MODELS patterns', () => {
  beforeEach(() => {
    process.env.CUSTOM_MODELS = 'Contoso*';
  });

  const classify = (root: string, model: string) =>
    classifyCustom(root, CUSTOM_ROOT, model, ['Contoso*']);

  it('keeps a matching model in a custom-only run', () => {
    expect(classify(CUSTOM_ROOT, 'ContosoRobotics')).toEqual({
      isCustom: true,
      narrowedByConfig: false,
    });
  });

  it('matches the pattern case-insensitively', () => {
    expect(classify(CUSTOM_ROOT, 'contosoDemo').narrowedByConfig).toBe(false);
    expect(classify(CUSTOM_ROOT, 'CONTOSOX').narrowedByConfig).toBe(false);
  });

  it('narrows out a non-matching ISV under the same custom root', () => {
    // The guard that matters: without narrowedByConfig, CUSTOM_MODELS="Contoso*" has no
    // effect anywhere on UDE and this ISV gets re-extracted on every custom refresh.
    expect(classify(CUSTOM_ROOT, 'DocentricAXCore')).toEqual({
      isCustom: true,
      narrowedByConfig: true,
    });
  });

  it('leaves the manifest classification path-based while narrowing extraction', () => {
    // isCustom stays true for the narrowed model: narrowing is about what this RUN
    // extracts, not about relabelling an ISV as a Microsoft model.
    expect(classify(CUSTOM_ROOT, 'DocentricAXCore').isCustom).toBe(true);
  });

  it('does not narrow when CUSTOM_MODELS is empty', () => {
    delete process.env.CUSTOM_MODELS;
    expect(classifyCustom(CUSTOM_ROOT, CUSTOM_ROOT, 'DocentricAXCore', []).narrowedByConfig)
      .toBe(false);
  });
});

describe('classifyCustom on traditional environments (no custom root)', () => {
  it('falls back to name-based classification via CUSTOM_MODELS', () => {
    process.env.CUSTOM_MODELS = 'Contoso*';
    expect(classifyCustom(TRADITIONAL_ROOT, null, 'ContosoRobotics', ['Contoso*'])).toEqual({
      isCustom: true,
      narrowedByConfig: false,
    });
    expect(classifyCustom(TRADITIONAL_ROOT, null, 'ApplicationSuite', ['Contoso*'])).toEqual({
      isCustom: false,
      narrowedByConfig: false,
    });
  });

  it('honours D365FO_MODEL_NAME', () => {
    process.env.D365FO_MODEL_NAME = 'MyModel';
    expect(classifyCustom(TRADITIONAL_ROOT, null, 'MyModel', []).isCustom).toBe(true);
  });

  it('never sets narrowedByConfig — the name check already decided isCustom', () => {
    // Applying the narrowing here would double-filter and drop nothing extra, but it
    // would make the flag mean two different things depending on environment.
    process.env.CUSTOM_MODELS = 'Contoso*';
    expect(classifyCustom(TRADITIONAL_ROOT, null, 'DocentricAXCore', ['Contoso*']))
      .toEqual({ isCustom: false, narrowedByConfig: false });
  });
});
