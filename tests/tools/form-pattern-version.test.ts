import { describe, it, expect } from 'vitest';
import { resolveEnvPatternVersion } from '../../src/tools/generateSmartForm';

describe('resolveEnvPatternVersion', () => {
  it('returns the most-common Design PatternVersion mined for the pattern', () => {
    const db = {
      prepare: () => ({ get: () => ({ pattern_version: '1.4', n: 12 }) }),
    };
    expect(resolveEnvPatternVersion(db, 'SimpleListDetails')).toBe('1.4');
  });

  it('returns null when no mined version exists for the pattern', () => {
    const db = { prepare: () => ({ get: () => undefined }) };
    expect(resolveEnvPatternVersion(db, 'SimpleList')).toBeNull();
  });

  it('returns null (keeps template default) when the form_patterns table is absent', () => {
    const db = {
      prepare: () => {
        throw new Error('no such table: form_patterns');
      },
    };
    expect(resolveEnvPatternVersion(db, 'ListPage')).toBeNull();
  });
});
