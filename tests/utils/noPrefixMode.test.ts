/**
 * naming.prefixSource=none (EXTENSION_PREFIX_SOURCE=none) — issue #1085.
 *
 * A team on a suffix convention (CustomerSettings_ABC) has no prefix to give, and
 * leaving naming.prefix empty did not mean "no prefix": the server inferred one from
 * the model's objects, then fell back to EXTENSION_PREFIX, then to the MODEL NAME.
 * `none` skips all three. New objects, fields and methods keep the name as given;
 * extension elements and classes still need a collision-avoiding token, so they embed
 * the model name, as Visual Studio does.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { asGivenNameProblem, normalizeObjectName } from '../../src/utils/objectNaming.js';
import {
  applyObjectPrefix,
  getExtensionClassNamingStyle,
  getExtensionNamingStyle,
  getObjectSuffix,
  isAsGivenNamingMode,
  isNoPrefixMode,
  registerCustomModel,
  resolveObjectPrefix,
  resolveRegularObjectPrefixToken,
} from '../../src/utils/modelClassifier.js';
import { resolveEffectivePrefix } from '../../src/utils/effectivePrefix.js';
import {
  clearInferredModelPrefixes,
  getInferredModelPrefix,
  setModelObjectNameSource,
} from '../../src/utils/modelPrefixInference.js';

const MODEL = 'ABC';
const ENV_KEYS = [
  'EXTENSION_PREFIX',
  'EXTENSION_SUFFIX',
  'EXTENSION_NAMING_STYLE',
  'EXTENSION_CLASS_NAMING_STYLE',
  'EXTENSION_PREFIX_SOURCE',
];
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.EXTENSION_PREFIX_SOURCE = 'none';
  clearInferredModelPrefixes();
  // The model's own objects share a stem — inference must not bring it back.
  setModelObjectNameSource(m => (m === MODEL ? Array.from({ length: 30 }, (_, i) => `ABCThing${i}`) : []));
  registerCustomModel(MODEL);
});

afterEach(() => {
  setModelObjectNameSource(null);
  clearInferredModelPrefixes();
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('naming.prefixSource=none', () => {
  it('resolves no prefix — not the inferred one, not EXTENSION_PREFIX, not the model name', () => {
    process.env.EXTENSION_PREFIX = 'Xyz';
    expect(isNoPrefixMode()).toBe(true);
    expect(getInferredModelPrefix(MODEL)).toBeNull();
    expect(resolveObjectPrefix(MODEL)).toBe('');
    expect(resolveRegularObjectPrefixToken(MODEL)).toBe('');
    expect(resolveObjectPrefix('')).toBe('');
  });

  it('keeps a new object name as given', () => {
    for (const type of ['table', 'class', 'enum', 'edt', 'form', 'data-entity']) {
      expect(normalizeObjectName('CustomerSettings', type, MODEL), type).toBe('CustomerSettings');
    }
  });

  it('still appends EXTENSION_SUFFIX — the suffix convention the setting exists for', () => {
    process.env.EXTENSION_SUFFIX = '_ABC';
    expect(normalizeObjectName('CustomerSettings', 'table', MODEL)).toBe('CustomerSettings_ABC');
    expect(normalizeObjectName('CustomerSettings_ABC', 'table', MODEL)).toBe('CustomerSettings_ABC');
  });

  it('names an element extension after the model, never with an empty token', () => {
    expect(normalizeObjectName('CustTable', 'table-extension', MODEL)).toBe('CustTable.ABC');
    expect(normalizeObjectName('CustTable.Extension', 'table-extension', MODEL)).toBe('CustTable.ABC');
    expect(normalizeObjectName('CustTable.ABC', 'form-extension', MODEL)).toBe('CustTable.ABC');
  });

  it('names an extension class after the model, never as a bare Base_Extension', () => {
    expect(normalizeObjectName('CustTable', 'class-extension', MODEL)).toBe('CustTable_ABC_Extension');
    expect(normalizeObjectName('CustTable_Extension', 'class-extension', MODEL)).toBe('CustTable_ABC_Extension');
    expect(normalizeObjectName('CustTable_ABC_Extension', 'class-extension', MODEL)).toBe('CustTable_ABC_Extension');
  });

  it('keeps the reporter\'s CoC shape {Base}_{Kind}_{Token}_Extension as given', () => {
    expect(normalizeObjectName('CustTable_Table_ABC_Extension', 'class-extension', MODEL))
      .toBe('CustTable_Table_ABC_Extension');
    expect(normalizeObjectName('InventLocation_Form_ABC_Extension', 'class-extension', MODEL))
      .toBe('InventLocation_Form_ABC_Extension');
  });

  it('overrides the prefix extension styles, which have no prefix to embed', () => {
    process.env.EXTENSION_NAMING_STYLE = 'prefix';
    process.env.EXTENSION_CLASS_NAMING_STYLE = 'prefix-leading';
    expect(getExtensionNamingStyle()).toBe('model-name');
    expect(getExtensionClassNamingStyle()).toBe('model-name');
  });

  it('leaves a name alone when the model is unknown', () => {
    expect(applyObjectPrefix('CustTable.Extension', '', undefined)).toBe('CustTable.Extension');
    expect(applyObjectPrefix('CustomerSettings', '', undefined)).toBe('CustomerSettings');
  });

  it('reports the choice as the source, with no conflict', () => {
    process.env.EXTENSION_PREFIX = 'Xyz';
    const r = resolveEffectivePrefix(MODEL);
    expect(r.prefix).toBe('');
    expect(r.conflict).toBe(false);
    expect(r.source).toMatch(/none/);
  });
});

describe('without it, nothing changes', () => {
  it('an empty naming.prefix still falls back to the model name', () => {
    delete process.env.EXTENSION_PREFIX_SOURCE;
    setModelObjectNameSource(() => []);
    expect(resolveObjectPrefix(MODEL)).toBe('ABC');
    expect(normalizeObjectName('CustomerSettings', 'table', MODEL)).toBe('ABCCustomerSettings');
  });
});

describe('naming.prefixSource=as-given (#1134)', () => {
  beforeEach(() => {
    process.env.EXTENSION_PREFIX_SOURCE = 'as-given';
    process.env.EXTENSION_PREFIX = 'Ctso';
    process.env.EXTENSION_SUFFIX = 'ZZ';
  });

  it('renames nothing — objects, suffix, extension elements and classes', () => {
    expect(isAsGivenNamingMode()).toBe(true);
    expect(isNoPrefixMode()).toBe(true);
    expect(getObjectSuffix()).toBe('');
    expect(resolveObjectPrefix(MODEL)).toBe('');
    // A token that is not the model name ("XY" in model "ABC") is the case `none` broke.
    for (const [name, type] of [
      ['VendSettingsXY', 'table'],
      ['VendTable.XY', 'table-extension'],
      ['VendTableTable_XY_Extension', 'class-extension'],
      ['NumberSeqModule.XY', 'enum-extension'],
    ]) {
      expect(normalizeObjectName(name, type, MODEL), name).toBe(name);
      expect(applyObjectPrefix(name, 'Ctso', MODEL), name).toBe(name);
    }
  });

  it('learns no prefix from the model either', () => {
    expect(getInferredModelPrefix(MODEL)).toBeNull();
  });

  it('asGivenNameProblem checks structure only', () => {
    expect(asGivenNameProblem('VendTable.XY', 'table-extension')).toBeNull();
    expect(asGivenNameProblem('VendTableTable_XY_Extension', 'class-extension')).toBeNull();
    expect(asGivenNameProblem('AnythingGoes_XY', 'table')).toBeNull();

    expect(asGivenNameProblem('VendTable', 'table-extension')).toMatch(/<Base>\.<Token>/);
    expect(asGivenNameProblem('A.B.C', 'form-extension')).toMatch(/<Base>\.<Token>/);
    expect(asGivenNameProblem('VendTable.X-Y', 'table-extension')).toMatch(/not a valid AOT identifier/);
    expect(asGivenNameProblem('VendTableTable_XY', 'class-extension')).toMatch(/_Extension/);
    expect(asGivenNameProblem('Vend Settings', 'table')).toMatch(/not a valid AOT name/);
    expect(asGivenNameProblem(`T${'x'.repeat(81)}`, 'table')).toMatch(/81/);
  });
});
