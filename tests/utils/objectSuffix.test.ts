/**
 * Extension Suffix Tests (issue #365)
 * Tests for configurable object name suffixes (EXTENSION_SUFFIX).
 */

import { describe, it, expect } from 'vitest';
import { getObjectSuffix, applyObjectSuffix } from '../../src/utils/modelClassifier';

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
    process.env.EXTENSION_SUFFIX = 'ZZ';
    expect(getObjectSuffix()).toBe('ZZ');
  });

  it('strips trailing underscores', () => {
    process.env.EXTENSION_SUFFIX = 'ZZ_';
    expect(getObjectSuffix()).toBe('ZZ');
  });

  it('trims whitespace', () => {
    process.env.EXTENSION_SUFFIX = '  AB  ';
    expect(getObjectSuffix()).toBe('AB');
  });

  it('returns empty for whitespace-only value', () => {
    process.env.EXTENSION_SUFFIX = '   ';
    expect(getObjectSuffix()).toBe('');
  });
});

describe('applyObjectSuffix', () => {
  it('appends suffix to regular object name', () => {
    expect(applyObjectSuffix('MyTable', 'ZZ')).toBe('MyTableZZ');
  });

  it('does not double-suffix (case-insensitive)', () => {
    expect(applyObjectSuffix('MyTableZZ', 'ZZ')).toBe('MyTableZZ');
    expect(applyObjectSuffix('MyTablezz', 'ZZ')).toBe('MyTablezz');
  });

  it('returns unchanged name when suffix is empty', () => {
    expect(applyObjectSuffix('MyTable', '')).toBe('MyTable');
  });

  it('skips dot-notation extension elements', () => {
    expect(applyObjectSuffix('CustTable.ContosoExtension', 'ZZ')).toBe('CustTable.ContosoExtension');
  });

  it('skips _Extension class names', () => {
    expect(applyObjectSuffix('CustTableContoso_Extension', 'ZZ')).toBe('CustTableContoso_Extension');
  });

  it('works with class names', () => {
    expect(applyObjectSuffix('MyController', 'ZZ')).toBe('MyControllerZZ');
  });

  it('works with underscore-style prefix', () => {
    expect(applyObjectSuffix('XY_MyTable', 'ZZ')).toBe('XY_MyTableZZ');
  });
});
