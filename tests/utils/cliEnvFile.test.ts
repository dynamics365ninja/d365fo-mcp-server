/**
 * Unit tests for the CLI .env helpers — they must mirror the semantics of the
 * PowerShell management scripts (active line wins, set replaces → uncomments
 * → appends, commented vars count as present for the missing-settings diff).
 */
import { describe, expect, it } from 'vitest';
import { getValue, missingVars, setValue, varNames } from '../../src/cli/envFile.js';

describe('cli envFile helpers', () => {
  describe('getValue', () => {
    it('reads an active assignment and trims the value', () => {
      expect(getValue('PORT= 8080 \nDB_PATH=./db\n', 'PORT')).toBe('8080');
    });

    it('ignores commented assignments', () => {
      expect(getValue('# PORT=8080\n', 'PORT')).toBeNull();
    });

    it('does not match keys that only share a prefix', () => {
      expect(getValue('DB_PATH_EXTRA=x\n', 'DB_PATH')).toBeNull();
    });

    it('returns empty string for an empty assignment', () => {
      expect(getValue('XPP_CONFIG_NAME=\n', 'XPP_CONFIG_NAME')).toBe('');
    });
  });

  describe('setValue', () => {
    it('replaces an existing active line in place', () => {
      const out = setValue('A=1\nPORT=8080\nB=2\n', 'PORT', '3001');
      expect(out).toBe('A=1\nPORT=3001\nB=2\n');
    });

    it('un-comments a commented line when no active line exists', () => {
      const out = setValue('# XPP_CONFIG_NAME=old\nB=2\n', 'XPP_CONFIG_NAME', 'env___10.0.1');
      expect(out).toBe('XPP_CONFIG_NAME=env___10.0.1\nB=2\n');
    });

    it('prefers the active line over a commented one', () => {
      const out = setValue('# PORT=1\nPORT=2\n', 'PORT', '3');
      expect(out).toContain('# PORT=1');
      expect(out).toContain('PORT=3');
      expect(out).not.toContain('PORT=2');
    });

    it('appends with a trailing newline when the key is absent', () => {
      expect(setValue('A=1', 'NEW', 'x')).toBe('A=1\nNEW=x\n');
      expect(setValue('A=1\n\n', 'NEW', 'x')).toBe('A=1\nNEW=x\n');
    });

    it('treats regex metacharacters in values literally', () => {
      const out = setValue('P=$old\n', 'P', 'C:\\a$b');
      expect(out).toBe('P=C:\\a$b\n');
    });

    it("does not expand replacement-string sequences like $& or $'", () => {
      expect(setValue('SECRET=x\n', 'SECRET', "a$&b$'c")).toBe("SECRET=a$&b$'c\n");
    });
  });

  describe('varNames / missingVars', () => {
    it('counts commented assignments as present', () => {
      expect(varNames('A=1\n# B=2\n  # C = 3\nnot a var\n')).toEqual(['A', 'B', 'C']);
    });

    it('reports example vars absent from the env, with active example values', () => {
      const example = 'A=1\nB=two\nC=3\n';
      const env = 'A=changed\n# B=disabled\n';
      expect(missingVars(example, env)).toEqual([{ name: 'C', value: '3' }]);
    });

    it('shows an empty value for example vars that are only commented', () => {
      expect(missingVars('# C=3\n', '')).toEqual([{ name: 'C', value: '' }]);
    });

    it('reports each missing var only once, with the active value', () => {
      const example = '# D=x\nD=y\n';
      expect(missingVars(example, '')).toEqual([{ name: 'D', value: 'y' }]);
    });
  });
});
