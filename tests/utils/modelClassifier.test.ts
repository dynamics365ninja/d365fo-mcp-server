/**
 * Model Classifier Tests
 * Tests for resolveObjectPrefix, applyObjectPrefix, and related helpers.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  resolveObjectPrefix,
  applyObjectPrefix,
  deriveExtensionInfix,
  buildExtensionElementName,
  buildExtensionClassName,
  getExtensionNamingStyle,
  getObjectSuffix,
  applyObjectSuffix,
  clearAutoDetectedModels,
} from '../../src/utils/modelClassifier';

// Force the default (prefix) style for every test in this file unless the test
// explicitly sets EXTENSION_NAMING_STYLE. This is required because .env loads
// at process start and pollutes the env with whatever style the dev configured.
beforeEach(() => {
  delete process.env.EXTENSION_NAMING_STYLE;
});

describe('resolveObjectPrefix', () => {
  const originalEnv = process.env.EXTENSION_PREFIX;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.EXTENSION_PREFIX;
    } else {
      process.env.EXTENSION_PREFIX = originalEnv;
    }
    clearAutoDetectedModels();
  });

  it('returns empty string when EXTENSION_PREFIX is explicitly empty', () => {
    process.env.EXTENSION_PREFIX = '';
    expect(resolveObjectPrefix('MyModel')).toBe('');
  });

  it('returns empty string when EXTENSION_PREFIX is whitespace-only', () => {
    process.env.EXTENSION_PREFIX = '   ';
    expect(resolveObjectPrefix('MyModel')).toBe('');
  });

  it('strips trailing underscores from env prefix', () => {
    process.env.EXTENSION_PREFIX = 'ISV_';
    expect(resolveObjectPrefix('MyModel')).toBe('ISV');
  });

  it('returns env prefix when set and non-empty', () => {
    process.env.EXTENSION_PREFIX = 'Contoso';
    expect(resolveObjectPrefix('MyModel')).toBe('Contoso');
  });

  it('falls back to modelName when EXTENSION_PREFIX env key is absent', () => {
    delete process.env.EXTENSION_PREFIX;
    expect(resolveObjectPrefix('MyModel')).toBe('MyModel');
  });

  it('falls back to empty string when both env and modelName are absent', () => {
    delete process.env.EXTENSION_PREFIX;
    expect(resolveObjectPrefix('')).toBe('');
  });
});

describe('applyObjectPrefix', () => {
  const originalPrefix = process.env.EXTENSION_PREFIX;
  const originalStyle = process.env.EXTENSION_NAMING_STYLE;

  afterEach(() => {
    if (originalPrefix === undefined) delete process.env.EXTENSION_PREFIX;
    else process.env.EXTENSION_PREFIX = originalPrefix;
    if (originalStyle === undefined) delete process.env.EXTENSION_NAMING_STYLE;
    else process.env.EXTENSION_NAMING_STYLE = originalStyle;
  });

  it('returns objectName unchanged when prefix is empty', () => {
    process.env.EXTENSION_PREFIX = '';
    delete process.env.EXTENSION_NAMING_STYLE;
    expect(applyObjectPrefix('MyTable', '')).toBe('MyTable');
  });

  it('prefixes regular objects with underscore-style prefix', () => {
    process.env.EXTENSION_PREFIX = 'XY_';
    delete process.env.EXTENSION_NAMING_STYLE;
    expect(applyObjectPrefix('MyTable', 'XY')).toBe('XY_MyTable');
  });

  it('prefixes regular objects with normal prefix', () => {
    process.env.EXTENSION_PREFIX = 'Contoso';
    delete process.env.EXTENSION_NAMING_STYLE;
    expect(applyObjectPrefix('MyTable', 'Contoso')).toBe('ContosoMyTable');
  });

  it('does not double-prefix', () => {
    process.env.EXTENSION_PREFIX = 'Contoso';
    delete process.env.EXTENSION_NAMING_STYLE;
    expect(applyObjectPrefix('ContosoMyTable', 'Contoso')).toBe('ContosoMyTable');
  });

  it('handles dot-notation extension elements', () => {
    process.env.EXTENSION_PREFIX = 'XY_';
    delete process.env.EXTENSION_NAMING_STYLE;
    expect(applyObjectPrefix('CustTable.XyExtension', 'XY')).toBe('CustTable.XyExtension');
  });

  it('handles extension classes', () => {
    process.env.EXTENSION_PREFIX = 'Contoso';
    delete process.env.EXTENSION_NAMING_STYLE;
    expect(applyObjectPrefix('SalesFormLetter_Extension', 'Contoso')).toBe('SalesFormLetterContoso_Extension');
  });

  // ─── verbatim style ─────────────────────────────────────────────────────
  it('verbatim: keeps regular object name unchanged (no leading prefix)', () => {
    process.env.EXTENSION_PREFIX = 'XYZ';
    process.env.EXTENSION_NAMING_STYLE = 'verbatim';
    expect(applyObjectPrefix('MyTable', 'XYZ')).toBe('MyTable');
  });

  it('verbatim: dot-notation extension element uses underscore separator', () => {
    process.env.EXTENSION_PREFIX = 'XYZ';
    process.env.EXTENSION_NAMING_STYLE = 'verbatim';
    expect(applyObjectPrefix('SalesTable.XYZ_Extension', 'XYZ')).toBe('SalesTable.XYZ_Extension');
  });

  it('verbatim: extension class uses underscore separator', () => {
    process.env.EXTENSION_PREFIX = 'XYZ';
    process.env.EXTENSION_NAMING_STYLE = 'verbatim';
    expect(applyObjectPrefix('SalesTableTable_XYZ_Extension', 'XYZ')).toBe('SalesTableTable_XYZ_Extension');
  });

  it('verbatim: idempotent re-run on already-named class', () => {
    process.env.EXTENSION_PREFIX = 'XYZ';
    process.env.EXTENSION_NAMING_STYLE = 'verbatim';
    expect(applyObjectPrefix('ReqTransPOMarkFirm_XYZ_Extension', 'XYZ')).toBe('ReqTransPOMarkFirm_XYZ_Extension');
  });
});

describe('deriveExtensionInfix', () => {
  const originalEnv = process.env.EXTENSION_PREFIX;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.EXTENSION_PREFIX;
    } else {
      process.env.EXTENSION_PREFIX = originalEnv;
    }
  });

  it('returns empty string for empty prefix', () => {
    expect(deriveExtensionInfix('')).toBe('');
  });

  it('PascalCases underscore-style prefix', () => {
    process.env.EXTENSION_PREFIX = 'XY_';
    expect(deriveExtensionInfix('XY')).toBe('Xy');
  });

  it('capitalizes first letter for normal prefix', () => {
    process.env.EXTENSION_PREFIX = 'contoso';
    expect(deriveExtensionInfix('contoso')).toBe('Contoso');
  });
});

describe('buildExtensionElementName', () => {
  const originalPrefix = process.env.EXTENSION_PREFIX;
  const originalStyle = process.env.EXTENSION_NAMING_STYLE;

  afterEach(() => {
    if (originalPrefix === undefined) delete process.env.EXTENSION_PREFIX;
    else process.env.EXTENSION_PREFIX = originalPrefix;
    if (originalStyle === undefined) delete process.env.EXTENSION_NAMING_STYLE;
    else process.env.EXTENSION_NAMING_STYLE = originalStyle;
  });

  it('throws when prefix is empty', () => {
    delete process.env.EXTENSION_NAMING_STYLE;
    expect(() => buildExtensionElementName('CustTable', '')).toThrow(/requires a prefix/);
  });

  it('builds correct dot-notation name (default prefix style)', () => {
    process.env.EXTENSION_PREFIX = 'XY_';
    delete process.env.EXTENSION_NAMING_STYLE;
    expect(buildExtensionElementName('CustTable', 'XY')).toBe('CustTable.XyExtension');
  });

  it('verbatim: builds Base.PREFIX_Extension with underscore separator', () => {
    process.env.EXTENSION_NAMING_STYLE = 'verbatim';
    expect(buildExtensionElementName('SalesTable', 'XYZ')).toBe('SalesTable.XYZ_Extension');
  });
});

describe('buildExtensionClassName', () => {
  const originalPrefix = process.env.EXTENSION_PREFIX;
  const originalStyle = process.env.EXTENSION_NAMING_STYLE;

  afterEach(() => {
    if (originalPrefix === undefined) delete process.env.EXTENSION_PREFIX;
    else process.env.EXTENSION_PREFIX = originalPrefix;
    if (originalStyle === undefined) delete process.env.EXTENSION_NAMING_STYLE;
    else process.env.EXTENSION_NAMING_STYLE = originalStyle;
  });

  it('throws when prefix is empty', () => {
    delete process.env.EXTENSION_NAMING_STYLE;
    expect(() => buildExtensionClassName('SalesFormLetter', '')).toThrow(/requires a prefix/);
  });

  it('builds correct extension class name (default prefix style)', () => {
    process.env.EXTENSION_PREFIX = 'XY_';
    delete process.env.EXTENSION_NAMING_STYLE;
    expect(buildExtensionClassName('SalesFormLetter', 'XY')).toBe('SalesFormLetterXy_Extension');
  });

  it('avoids double infix when base already contains it (default prefix style)', () => {
    process.env.EXTENSION_PREFIX = 'XY_';
    delete process.env.EXTENSION_NAMING_STYLE;
    expect(buildExtensionClassName('SalesFormLetterXy', 'XY')).toBe('SalesFormLetterXy_Extension');
  });

  it('verbatim: builds Base_PREFIX_Extension with underscore separator', () => {
    process.env.EXTENSION_NAMING_STYLE = 'verbatim';
    expect(buildExtensionClassName('SalesTableTable', 'XYZ')).toBe('SalesTableTable_XYZ_Extension');
  });

  it('verbatim: builds CoC for form (SalesTableForm_XYZ_Extension)', () => {
    process.env.EXTENSION_NAMING_STYLE = 'verbatim';
    expect(buildExtensionClassName('SalesTableForm', 'XYZ')).toBe('SalesTableForm_XYZ_Extension');
  });
});

describe('getExtensionNamingStyle', () => {
  const originalStyle = process.env.EXTENSION_NAMING_STYLE;

  afterEach(() => {
    if (originalStyle === undefined) delete process.env.EXTENSION_NAMING_STYLE;
    else process.env.EXTENSION_NAMING_STYLE = originalStyle;
  });

  it('returns "prefix" by default', () => {
    delete process.env.EXTENSION_NAMING_STYLE;
    expect(getExtensionNamingStyle()).toBe('prefix');
  });

  it('returns "prefix" for unknown values', () => {
    process.env.EXTENSION_NAMING_STYLE = 'something-else';
    expect(getExtensionNamingStyle()).toBe('prefix');
  });

  it('returns "model-name" when set', () => {
    process.env.EXTENSION_NAMING_STYLE = 'model-name';
    expect(getExtensionNamingStyle()).toBe('model-name');
  });

  it('returns "verbatim" when set', () => {
    process.env.EXTENSION_NAMING_STYLE = 'verbatim';
    expect(getExtensionNamingStyle()).toBe('verbatim');
  });
});

describe('getObjectSuffix', () => {
  const originalEnv = process.env.EXTENSION_SUFFIX;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.EXTENSION_SUFFIX;
    } else {
      process.env.EXTENSION_SUFFIX = originalEnv;
    }
  });

  it('returns empty string when EXTENSION_SUFFIX is not set', () => {
    delete process.env.EXTENSION_SUFFIX;
    expect(getObjectSuffix()).toBe('');
  });

  it('returns the configured suffix', () => {
    process.env.EXTENSION_SUFFIX = '_XYZ';
    expect(getObjectSuffix()).toBe('_XYZ');
  });

  it('strips trailing underscores', () => {
    process.env.EXTENSION_SUFFIX = '_XYZ_';
    expect(getObjectSuffix()).toBe('_XYZ');
  });
});

describe('applyObjectSuffix', () => {
  it('appends suffix to regular object name', () => {
    expect(applyObjectSuffix('MyTable', '_XYZ')).toBe('MyTable_XYZ');
  });

  it('does not double-suffix (case-insensitive)', () => {
    expect(applyObjectSuffix('MyTable_XYZ', '_XYZ')).toBe('MyTable_XYZ');
    expect(applyObjectSuffix('MyTable_xyz', '_XYZ')).toBe('MyTable_xyz');
  });

  it('returns unchanged name when suffix is empty', () => {
    expect(applyObjectSuffix('MyTable', '')).toBe('MyTable');
  });

  it('skips dot-notation extension elements', () => {
    expect(applyObjectSuffix('CustTable.ContosoExtension', '_XYZ')).toBe('CustTable.ContosoExtension');
  });

  it('skips _Extension class names', () => {
    expect(applyObjectSuffix('CustTableContoso_Extension', '_XYZ')).toBe('CustTableContoso_Extension');
  });
});
