/**
 * One naming implementation for create and modify.
 *
 * The regression: `create({objectType:"table-extension", objectName:"PurchTable"})`
 * writes `PurchTable.CtsoExtension`, but `modify` with the same two arguments
 * looked for a file literally named `PurchTable`, missed, and answered "File
 * not found for table-extension" — one call after create had printed the path.
 * Three such round trips in the session that surfaced it, each ending in the
 * caller passing `filePath` by hand.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { normalizeObjectName, isExtensionObjectType } from '../../src/utils/objectNaming.js';
import { registerCustomModel } from '../../src/utils/modelClassifier.js';

const ENV_KEYS = ['EXTENSION_PREFIX', 'EXTENSION_SUFFIX', 'EXTENSION_NAMING_STYLE', 'EXTENSION_PREFIX_SOURCE'];
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.EXTENSION_PREFIX = 'Ctso';
  process.env.EXTENSION_PREFIX_SOURCE = 'config';
  registerCustomModel('ContosoExt');
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('normalizeObjectName', () => {
  it('turns a bare base name into a dot-notation extension', () => {
    // The exact shape modify used to miss.
    const n = normalizeObjectName('PurchTable', 'table-extension', 'ContosoExt');
    expect(n).toBe('PurchTable.CtsoExtension');
  });

  it('does the same for a form extension', () => {
    expect(normalizeObjectName('CustTable', 'form-extension', 'ContosoExt'))
      .toBe('CustTable.CtsoExtension');
  });

  it('turns a bare base class name into an _Extension class', () => {
    expect(normalizeObjectName('SalesFormLetter', 'class-extension', 'ContosoExt'))
      .toBe('SalesFormLetterCtso_Extension');
  });

  it('is idempotent — an already-normalised name comes back unchanged', () => {
    const once = normalizeObjectName('PurchTable', 'table-extension', 'ContosoExt');
    expect(normalizeObjectName(once, 'table-extension', 'ContosoExt')).toBe(once);
  });

  it('prefixes an ordinary new object instead of dotting it', () => {
    expect(normalizeObjectName('RentEquipment', 'table', 'ContosoExt')).toBe('CtsoRentEquipment');
  });

  it('normalises the casing of a hand-written extension token', () => {
    expect(normalizeObjectName('PurchTable.CTSOExtension', 'table-extension', 'ContosoExt'))
      .toBe('PurchTable.CtsoExtension');
  });

  it('never appends EXTENSION_SUFFIX to an extension', () => {
    process.env.EXTENSION_SUFFIX = '_Cust';
    expect(normalizeObjectName('PurchTable', 'table-extension', 'ContosoExt'))
      .toBe('PurchTable.CtsoExtension');
  });

  it('appends EXTENSION_SUFFIX to a new object', () => {
    process.env.EXTENSION_SUFFIX = '_Cust';
    expect(normalizeObjectName('RentEquipment', 'table', 'ContosoExt')).toBe('CtsoRentEquipment_Cust');
  });

  it('reports each transformation it made', () => {
    const notes: string[] = [];
    normalizeObjectName('PurchTable', 'table-extension', 'ContosoExt', n => notes.push(n));
    expect(notes.join('\n')).toMatch(/dot-notation/i);
  });
});

describe('isExtensionObjectType', () => {
  it('covers dot-notation extensions and class extensions', () => {
    expect(isExtensionObjectType('table-extension')).toBe(true);
    expect(isExtensionObjectType('class-extension')).toBe(true);
  });

  it('is false for ordinary object types', () => {
    expect(isExtensionObjectType('table')).toBe(false);
    expect(isExtensionObjectType('class')).toBe(false);
  });
});
