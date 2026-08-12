/**
 * Model names that are not identifiers (issue #892).
 *
 * A model name is free text; an AOT element name is an identifier. Under
 * EXTENSION_NAMING_STYLE=model-name the model name is embedded INTO object names,
 * so a model called "Contoso Robotics" produced `CustTable.Contoso Robotics` and
 * `CustTable_Contoso Robotics_Extension` — names no build accepts.
 *
 * The second, quieter half of the same defect: the idempotency guard compared
 * against the raw model name, which an existing name can never contain, so the
 * already-correct `CustTable_ContosoRobotics_Extension` grew a SECOND token on
 * every pass — and `CustTable.ContosoRobotics` was silently renamed, pointing
 * modify at an object that does not exist.
 *
 * The token is the model name with non-identifier characters removed, which is
 * what the platform itself derives:
 *   <Name>Monitoring and Telemetry</Name> → <ModelModule>MonitoringandTelemetry</ModelModule>
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { applyObjectPrefix, resolveObjectPrefix } from '../../src/utils/modelClassifier';
import { normalizeModelToken } from '../../src/utils/modelToken';
import { normalizeObjectName } from '../../src/utils/objectNaming';
import { primeInferredModelPrefix, clearInferredModelPrefixes } from '../../src/utils/modelPrefixInference';

const MODEL = 'Contoso Robotics';
const TOKEN = 'ContosoRobotics';

/** 152 regular objects, all on the short prefix — the shape the issue reports. */
const MODEL_OBJECTS = Array.from({ length: 152 }, (_, i) => `CRObject${i}`);

const originalPrefix = process.env.EXTENSION_PREFIX;
const originalStyle = process.env.EXTENSION_NAMING_STYLE;

beforeEach(() => {
  clearInferredModelPrefixes();
  process.env.EXTENSION_PREFIX = 'CR';
  process.env.EXTENSION_NAMING_STYLE = 'model-name';
  primeInferredModelPrefix(MODEL, MODEL_OBJECTS);
});

afterEach(() => {
  clearInferredModelPrefixes();
  if (originalPrefix === undefined) delete process.env.EXTENSION_PREFIX;
  else process.env.EXTENSION_PREFIX = originalPrefix;
  if (originalStyle === undefined) delete process.env.EXTENSION_NAMING_STYLE;
  else process.env.EXTENSION_NAMING_STYLE = originalStyle;
});

describe('normalizeModelToken', () => {
  it('removes the space, keeping the platform spelling', () => {
    expect(normalizeModelToken(MODEL)).toBe(TOKEN);
    expect(normalizeModelToken('Monitoring and Telemetry')).toBe('MonitoringandTelemetry');
  });

  it('leaves an already-valid model name untouched', () => {
    expect(normalizeModelToken('ContosoRobotics')).toBe('ContosoRobotics');
    expect(normalizeModelToken('Fleet_Management2')).toBe('Fleet_Management2');
  });
});

describe('#892 — model-name style with a spaced model name', () => {
  it('dot-notation extension carries no space', () => {
    const prefix = resolveObjectPrefix(MODEL);
    expect(applyObjectPrefix('CustTable.Extension', prefix, MODEL)).toBe(`CustTable.${TOKEN}`);
  });

  it('extension class carries no space', () => {
    const prefix = resolveObjectPrefix(MODEL);
    expect(applyObjectPrefix('CustTable_Extension', prefix, MODEL)).toBe(`CustTable_${TOKEN}_Extension`);
  });

  it('regular objects still take the short prefix', () => {
    expect(normalizeObjectName('QualityTier', 'table', MODEL)).toBe('CRQualityTier');
  });

  it('the shared create/modify path agrees on both extension forms', () => {
    expect(normalizeObjectName('CustTable', 'table-extension', MODEL)).toBe(`CustTable.${TOKEN}`);
    expect(normalizeObjectName('CustTable', 'class-extension', MODEL)).toBe(`CustTable_${TOKEN}_Extension`);
  });

  it('REGRESSION: an existing VS-spelled extension class is not given a second token', () => {
    const prefix = resolveObjectPrefix(MODEL);
    expect(applyObjectPrefix(`CustTable_${TOKEN}_Extension`, prefix, MODEL))
      .toBe(`CustTable_${TOKEN}_Extension`);
    expect(normalizeObjectName(`CustTable_${TOKEN}_Extension`, 'class-extension', MODEL))
      .toBe(`CustTable_${TOKEN}_Extension`);
  });

  it('REGRESSION: an existing VS-spelled dot extension is not renamed', () => {
    expect(normalizeObjectName(`CustTable.${TOKEN}`, 'table-extension', MODEL))
      .toBe(`CustTable.${TOKEN}`);
  });

  it('is idempotent across repeated passes', () => {
    const prefix = resolveObjectPrefix(MODEL);
    const once = applyObjectPrefix('CustTable_Extension', prefix, MODEL);
    expect(applyObjectPrefix(once, prefix, MODEL)).toBe(once);
    const dotOnce = applyObjectPrefix('CustTable.Extension', prefix, MODEL);
    expect(applyObjectPrefix(dotOnce, prefix, MODEL)).toBe(dotOnce);
  });
});

describe('#892 — prefix style is unaffected by the spaced model name', () => {
  beforeEach(() => {
    process.env.EXTENSION_NAMING_STYLE = 'prefix';
  });

  it('extensions take the prefix infix, not the model name', () => {
    const prefix = resolveObjectPrefix(MODEL);
    expect(applyObjectPrefix('CustTable.Extension', prefix, MODEL)).toBe('CustTable.CRExtension');
    expect(applyObjectPrefix('CustTable_Extension', prefix, MODEL)).toBe('CustTableCR_Extension');
  });

  it('a model-name token on an incoming name is stripped, not stacked', () => {
    expect(normalizeObjectName(`CustTable.${TOKEN}Extension`, 'table-extension', MODEL))
      .toBe('CustTable.CRExtension');
    expect(normalizeObjectName(`CustTable${TOKEN}_Extension`, 'class-extension', MODEL))
      .toBe('CustTableCR_Extension');
  });
});
