/**
 * applyObjectPrefix tests (PR #483 — dot-notation model-name suffix fix)
 *
 * Covers:
 *   - SPECIAL CASE A (dot-notation):
 *       • suffix ends with "extension" → always normalize to correctly-cased {infix}Extension
 *       • suffix has NO "extension" word (bare model name as VS generates) → return as-is
 *   - SPECIAL CASE B: extension class (_Extension) → inject infix
 *   - NORMAL CASE: regular objects → prefix prepended
 *
 * Regression guards:
 *   - "CTSOExtension" MUST be normalized to "CtsoExtension" (casing invariant from original code)
 *   - "ContosoExtension" with infix "Con" MUST be normalized to "ConExtension"
 *   - VS-generated bare model-name suffix must NOT receive a prepended prefix (original bug)
 */

import { describe, it, expect, afterEach } from 'vitest';
import { applyObjectPrefix } from '../../src/utils/modelClassifier';

const originalPrefix = process.env.EXTENSION_PREFIX;
const originalStyle = process.env.EXTENSION_NAMING_STYLE;

afterEach(() => {
  if (originalPrefix === undefined) {
    delete process.env.EXTENSION_PREFIX;
  } else {
    process.env.EXTENSION_PREFIX = originalPrefix;
  }
  if (originalStyle === undefined) {
    delete process.env.EXTENSION_NAMING_STYLE;
  } else {
    process.env.EXTENSION_NAMING_STYLE = originalStyle;
  }
});

// ---------------------------------------------------------------------------
// SPECIAL CASE A — dot-notation, suffix ends with "extension" → normalize
// ---------------------------------------------------------------------------
describe('applyObjectPrefix — SPECIAL CASE A, suffix ends with "extension"', () => {
  it('already-correct form returns as-is (ConExtension → ConExtension)', () => {
    delete process.env.EXTENSION_PREFIX;
    expect(applyObjectPrefix('CustTable.ConExtension', 'Con')).toBe('CustTable.ConExtension');
  });

  it('REGRESSION: CTSOExtension with EXTENSION_PREFIX=CTSO_ → CtsoExtension (casing normalized)', () => {
    // startsWith-based A1 in original PR would have returned "CTSOExtension" unchanged.
    // Correct behavior: always normalize casing.
    process.env.EXTENSION_PREFIX = 'CTSO_';
    expect(applyObjectPrefix('VendTrans.CTSOExtension', 'CTSO')).toBe('VendTrans.CtsoExtension');
  });

  it('REGRESSION: ContosoExtension with infix Con → ConExtension (A1 startsWith must NOT fire)', () => {
    // startsWith("con") would have matched "ContosoExtension", preventing normalization.
    delete process.env.EXTENSION_PREFIX;
    expect(applyObjectPrefix('CustTable.ContosoExtension', 'Con')).toBe('CustTable.ConExtension');
  });

  it('foreign infix is replaced: OtherExtension → ConExtension', () => {
    delete process.env.EXTENSION_PREFIX;
    expect(applyObjectPrefix('CustTable.OtherExtension', 'Con')).toBe('CustTable.ConExtension');
  });

  it('all-lowercase suffix is normalized', () => {
    delete process.env.EXTENSION_PREFIX;
    expect(applyObjectPrefix('HCMWorker.adextension', 'AdventureWorks')).toBe('HCMWorker.AdventureWorksExtension');
  });

  it('bare .Extension becomes {infix}Extension', () => {
    delete process.env.EXTENSION_PREFIX;
    expect(applyObjectPrefix('PurchTable.Extension', 'Con')).toBe('PurchTable.ConExtension');
  });

  it('uses lastIndexOf — multi-dot base name is handled correctly', () => {
    delete process.env.EXTENSION_PREFIX;
    expect(applyObjectPrefix('My.Nested.OtherExtension', 'Con')).toBe('My.Nested.ConExtension');
  });

  it('underscore-style prefix: XY_ → infix Xy', () => {
    process.env.EXTENSION_PREFIX = 'XY_';
    expect(applyObjectPrefix('VendTable.OtherExtension', 'XY')).toBe('VendTable.XyExtension');
  });
});

// ---------------------------------------------------------------------------
// SPECIAL CASE A — dot-notation, suffix has NO "extension" word → return as-is
// ---------------------------------------------------------------------------
describe('applyObjectPrefix — SPECIAL CASE A, bare model-name suffix (no "extension")', () => {
  it('ORIGINAL BUG FIX: SalesOrderHeaderV4Entity.Contoso is NOT prepended with Con', () => {
    // Before fix: fell through to NORMAL CASE → "ContosoSalesOrderHeaderV4Entity.Contoso"
    delete process.env.EXTENSION_PREFIX;
    expect(applyObjectPrefix('SalesOrderHeaderV4Entity.Contoso', 'Contoso'))
      .toBe('SalesOrderHeaderV4Entity.Contoso');
  });

  it('bare suffix with non-matching infix also returns as-is', () => {
    delete process.env.EXTENSION_PREFIX;
    expect(applyObjectPrefix('SalesOrderHeaderV4Entity.AdventureWorks', 'Con'))
      .toBe('SalesOrderHeaderV4Entity.AdventureWorks');
  });

  it('bare model-name suffix with underscore-style prefix returns as-is', () => {
    process.env.EXTENSION_PREFIX = 'CTSO_';
    expect(applyObjectPrefix('PurchTable.Contoso', 'CTSO'))
      .toBe('PurchTable.Contoso');
  });
});

// ---------------------------------------------------------------------------
// SPECIAL CASE B — extension classes (_Extension)
// ---------------------------------------------------------------------------
describe('applyObjectPrefix — SPECIAL CASE B (_Extension class)', () => {
  it('injects infix before _Extension', () => {
    delete process.env.EXTENSION_PREFIX;
    expect(applyObjectPrefix('SalesFormLetter_Extension', 'Contoso'))
      .toBe('SalesFormLetterContoso_Extension');
  });

  it('returns as-is when infix already present', () => {
    delete process.env.EXTENSION_PREFIX;
    expect(applyObjectPrefix('SalesFormLetterContoso_Extension', 'Contoso'))
      .toBe('SalesFormLetterContoso_Extension');
  });

  it('injects PascalCase infix for underscore-style prefix (XY_ → Xy)', () => {
    process.env.EXTENSION_PREFIX = 'XY_';
    expect(applyObjectPrefix('SalesFormLetter_Extension', 'XY'))
      .toBe('SalesFormLetterXy_Extension');
  });
});

// ---------------------------------------------------------------------------
// NORMAL CASE — regular objects
// ---------------------------------------------------------------------------
describe('applyObjectPrefix — NORMAL CASE (regular objects)', () => {
  it('prepends PascalCase prefix', () => {
    delete process.env.EXTENSION_PREFIX;
    expect(applyObjectPrefix('MyTable', 'Contoso')).toBe('ContosoMyTable');
  });

  it('does not double-prefix (case-insensitive)', () => {
    delete process.env.EXTENSION_PREFIX;
    expect(applyObjectPrefix('ContosoMyTable', 'Contoso')).toBe('ContosoMyTable');
    expect(applyObjectPrefix('contosoMyTable', 'Contoso')).toBe('contosoMyTable');
  });

  it('prepends underscore-style prefix', () => {
    process.env.EXTENSION_PREFIX = 'XY_';
    expect(applyObjectPrefix('MyTable', 'XY')).toBe('XY_MyTable');
  });

  it('does not double-prefix underscore-style', () => {
    process.env.EXTENSION_PREFIX = 'XY_';
    expect(applyObjectPrefix('XY_MyTable', 'XY')).toBe('XY_MyTable');
  });

  it('returns unchanged when prefix is empty', () => {
    delete process.env.EXTENSION_PREFIX;
    expect(applyObjectPrefix('MyTable', '')).toBe('MyTable');
  });
});

// ---------------------------------------------------------------------------
// EXTENSION_NAMING_STYLE=model-name — extension token is the MODEL NAME (VS default)
// ---------------------------------------------------------------------------
describe('applyObjectPrefix — model-name style (EXTENSION_NAMING_STYLE=model-name)', () => {
  // Short prefix that differs from the long model name — the scenario this style exists for.
  const setup = () => {
    process.env.EXTENSION_PREFIX = 'CR';
    process.env.EXTENSION_NAMING_STYLE = 'model-name';
  };

  it('class extension uses model name: Base_Extension → Base_ModelName_Extension', () => {
    setup();
    expect(applyObjectPrefix('CustTable_Extension', 'CR', 'ContosoRobotics'))
      .toBe('CustTable_ContosoRobotics_Extension');
  });

  it('class extension is idempotent (no double model name)', () => {
    setup();
    expect(applyObjectPrefix('CustTable_ContosoRobotics_Extension', 'CR', 'ContosoRobotics'))
      .toBe('CustTable_ContosoRobotics_Extension');
  });

  it('class extension strips a stray prefix infix and uses the model name', () => {
    setup();
    // double underscore left by upstream model-name stripping must collapse cleanly
    expect(applyObjectPrefix('CustTable__Extension', 'CR', 'ContosoRobotics'))
      .toBe('CustTable_ContosoRobotics_Extension');
  });

  it('element extension uses model name with no "Extension" word: Base.Extension → Base.ModelName', () => {
    setup();
    expect(applyObjectPrefix('CustTable.Extension', 'CR', 'ContosoRobotics'))
      .toBe('CustTable.ContosoRobotics');
  });

  it('element extension is idempotent (Base.ModelName → Base.ModelName)', () => {
    setup();
    expect(applyObjectPrefix('CustTable.ContosoRobotics', 'CR', 'ContosoRobotics'))
      .toBe('CustTable.ContosoRobotics');
  });

  it('element extension replaces a foreign/prefix token with the model name', () => {
    setup();
    expect(applyObjectPrefix('CustTable.CrExtension', 'CR', 'ContosoRobotics'))
      .toBe('CustTable.ContosoRobotics');
  });

  it('NEW objects still use the short prefix (model name is ignored for non-extensions)', () => {
    setup();
    expect(applyObjectPrefix('MyTable', 'CR', 'ContosoRobotics')).toBe('CRMyTable');
  });

  it('falls back to prefix-infix behavior when no model name is passed', () => {
    setup();
    expect(applyObjectPrefix('CustTable_Extension', 'CR')).toBe('CustTableCR_Extension');
  });

  it('prefix style is unaffected even when a model name is passed', () => {
    process.env.EXTENSION_PREFIX = 'CR';
    delete process.env.EXTENSION_NAMING_STYLE; // default = prefix
    expect(applyObjectPrefix('CustTable_Extension', 'CR', 'ContosoRobotics'))
      .toBe('CustTableCR_Extension');
    expect(applyObjectPrefix('CustTable.Extension', 'CR', 'ContosoRobotics'))
      .toBe('CustTable.CRExtension');
  });
});
