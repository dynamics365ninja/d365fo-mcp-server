/**
 * isCustomModel tests — explicitly-configured target model classification.
 *
 * Regression for the false "Microsoft standard model" warning: a model whose
 * ISV prefix is only an abbreviation of its name (e.g. prefix "CR" for model
 * "ContosoRobotics") fails the literal startsWith() heuristic, so before the fix
 * it was misclassified as a standard model until something registered it at runtime.
 *
 * The configured target model (D365FO_MODEL_NAME) is now custom by definition,
 * independent of the prefix — while genuinely unrelated models stay standard.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { isCustomModel, clearAutoDetectedModels } from '../../src/utils/modelClassifier';

const originalPrefix = process.env.EXTENSION_PREFIX;
const originalModelName = process.env.D365FO_MODEL_NAME;
const originalCustomModels = process.env.CUSTOM_MODELS;

function restore(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

beforeEach(() => {
  clearAutoDetectedModels();
});

afterEach(() => {
  restore('EXTENSION_PREFIX', originalPrefix);
  restore('D365FO_MODEL_NAME', originalModelName);
  restore('CUSTOM_MODELS', originalCustomModels);
  clearAutoDetectedModels();
});

describe('isCustomModel — explicitly configured target model', () => {
  it('REGRESSION: configured model with an abbreviation prefix is custom', () => {
    // Prefix "CR" is NOT a literal start of "ContosoRobotics" (2nd char is "o", not "R"),
    // so the startsWith() heuristic fails — the configured-model check must catch it.
    process.env.EXTENSION_PREFIX = 'CR';
    process.env.D365FO_MODEL_NAME = 'ContosoRobotics';
    delete process.env.CUSTOM_MODELS;
    clearAutoDetectedModels();

    expect(isCustomModel('ContosoRobotics')).toBe(true);
  });

  it('configured-model match is case-insensitive', () => {
    process.env.D365FO_MODEL_NAME = 'ContosoRobotics';
    delete process.env.EXTENSION_PREFIX;
    delete process.env.CUSTOM_MODELS;
    clearAutoDetectedModels();

    expect(isCustomModel('contosorobotics')).toBe(true);
  });

  it('is scoped to the configured model — an unrelated model stays standard', () => {
    // Proves the fix does not blanket-classify everything as custom.
    process.env.EXTENSION_PREFIX = 'CR';
    process.env.D365FO_MODEL_NAME = 'ContosoRobotics';
    delete process.env.CUSTOM_MODELS;
    clearAutoDetectedModels();

    expect(isCustomModel('GeneralLedger')).toBe(false);
  });

  it('with no configuration at all, an arbitrary Microsoft model is standard', () => {
    delete process.env.EXTENSION_PREFIX;
    delete process.env.D365FO_MODEL_NAME;
    delete process.env.CUSTOM_MODELS;
    clearAutoDetectedModels();

    expect(isCustomModel('ApplicationSuite')).toBe(false);
  });
});

describe('isCustomModel — existing signals still hold', () => {
  it('CUSTOM_MODELS entry is custom', () => {
    delete process.env.EXTENSION_PREFIX;
    delete process.env.D365FO_MODEL_NAME;
    process.env.CUSTOM_MODELS = 'ContosoRoboticsIsvExt,SomeOtherModel';
    clearAutoDetectedModels();

    expect(isCustomModel('ContosoRoboticsIsvExt')).toBe(true);
  });

  it('CUSTOM_MODELS wildcard pattern is custom', () => {
    delete process.env.EXTENSION_PREFIX;
    delete process.env.D365FO_MODEL_NAME;
    process.env.CUSTOM_MODELS = 'ContosoRobotics*';
    clearAutoDetectedModels();

    expect(isCustomModel('ContosoRoboticsTest')).toBe(true);
  });

  it('literal prefix match still classifies as custom', () => {
    // When the prefix genuinely IS the start of the model name.
    process.env.EXTENSION_PREFIX = 'WHS';
    delete process.env.D365FO_MODEL_NAME;
    delete process.env.CUSTOM_MODELS;
    clearAutoDetectedModels();

    expect(isCustomModel('WHSCustomExtensions')).toBe(true);
  });
});

/**
 * #721: the EXTENSION_PREFIX branch was the one case-SENSITIVE comparison in a file
 * whose every other comparison — and this function's own docstring — is case-insensitive.
 * The misclassification is silent: the write guard (modifyD365File), the contextRanker
 * boost and the property-stats miner all read isCustomModel(), so the user only sees a
 * server behaving as if their model weren't theirs.
 */
describe('isCustomModel — EXTENSION_PREFIX matching (#721)', () => {
  function onlyPrefix(prefix: string): void {
    process.env.EXTENSION_PREFIX = prefix;
    delete process.env.D365FO_MODEL_NAME;
    delete process.env.CUSTOM_MODELS;
    clearAutoDetectedModels();
  }

  it('REGRESSION: lowercase prefix matches a PascalCase model', () => {
    onlyPrefix('contoso');
    expect(isCustomModel('ContosoRobotics')).toBe(true);
  });

  it('REGRESSION: uppercase prefix matches a PascalCase model', () => {
    onlyPrefix('CONTOSO');
    expect(isCustomModel('ContosoRobotics')).toBe(true);
  });

  it('mixed-case prefix matches a differently-cased model', () => {
    onlyPrefix('WhS');
    expect(isCustomModel('WHSCustomExtensions')).toBe(true);
  });

  /**
   * Decision pinned here: getExtensionPrefix() returns EXTENSION_PREFIX raw (underscore
   * included) while resolveObjectPrefix() strips it, so "XY_" matches BOTH the literal
   * underscore form and the bare PascalCase form a model name normally uses.
   */
  it('underscore-style prefix matches the literal underscore form', () => {
    onlyPrefix('XY_');
    expect(isCustomModel('XY_Robotics')).toBe(true);
  });

  it('underscore-style prefix also matches the bare form of the model name', () => {
    onlyPrefix('XY_');
    expect(isCustomModel('XyRobotics')).toBe(true);
  });

  it('an all-underscore prefix does not match every model', () => {
    // Stripping would leave an empty prefix, and ''.startsWith() is true for everything.
    onlyPrefix('_');
    expect(isCustomModel('ApplicationSuite')).toBe(false);
  });

  it('still scoped — an unrelated model stays standard', () => {
    onlyPrefix('contoso');
    expect(isCustomModel('ApplicationSuite')).toBe(false);
  });

  it('an empty/whitespace prefix matches nothing', () => {
    onlyPrefix('   ');
    expect(isCustomModel('ApplicationSuite')).toBe(false);
    expect(isCustomModel('ContosoRobotics')).toBe(false);
  });
});
