/**
 * Case mining — converts a mined failure description into a draft eval case.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { slugify, mineCaseFromFailure, writeMinedCase, type MinedFailureInput } from '../../src/eval/improver/caseMining';

describe('slugify', () => {
  it('lowercases and dashes non-alphanumerics', () => {
    expect(slugify('Bridge Drops Table Fields!')).toBe('bridge-drops-table-fields');
  });

  it('collapses repeated separators and trims edge dashes', () => {
    expect(slugify('  --Foo__Bar--  ')).toBe('foo-bar');
  });
});

describe('mineCaseFromFailure', () => {
  const baseInput: MinedFailureInput = {
    title: 'Bridge drops security privilege EntryPoints',
    tier: 4,
    instructionHint: 'Create a security privilege with a targetObject and confirm EntryPoints is populated.',
    targetArtifactTypes: ['AxSecurityPrivilege'],
    tags: ['security', 'tool-defect'],
  };

  it('derives an id from the tier and slugified title', () => {
    const spec = mineCaseFromFailure(baseInput);
    expect(spec.id).toBe('L4-bridge-drops-security-privilege-entrypoints');
  });

  it('uses an explicit idSlug when provided', () => {
    const spec = mineCaseFromFailure({ ...baseInput, idSlug: 'priv-entrypoints-dropped' });
    expect(spec.id).toBe('L4-priv-entrypoints-dropped');
  });

  it('marks the case golden_pending and holdout-split, matching the eval/cases schema', () => {
    const spec = mineCaseFromFailure(baseInput);
    expect(spec.golden_pending).toBe(true);
    expect(spec.split).toBe('holdout');
    expect(spec.golden_path).toBe(`eval/goldens/${spec.id}/`);
    expect(spec.target_artifact_types).toEqual(['AxSecurityPrivilege']);
    expect(spec.tags).toEqual(['security', 'tool-defect']);
  });

  it('throws when no usable slug can be derived', () => {
    expect(() => mineCaseFromFailure({ ...baseInput, title: '!!!' })).toThrow(/slug/i);
  });
});

describe('writeMinedCase', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'case-mining-test-'));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes a valid JSON file at eval/cases/<id>.json', () => {
    const spec = mineCaseFromFailure({
      title: 'Form modify-property unsupported',
      tier: 1,
      instructionHint: 'Reproduce the form modify-property gap.',
      targetArtifactTypes: ['AxForm'],
    });
    const outFile = writeMinedCase(spec, tmpDir);
    expect(fs.existsSync(outFile)).toBe(true);
    const written = JSON.parse(fs.readFileSync(outFile, 'utf8'));
    expect(written.id).toBe(spec.id);
  });

  it('refuses to overwrite an existing case', () => {
    const spec = mineCaseFromFailure({
      title: 'Duplicate case',
      tier: 0,
      instructionHint: 'x',
      targetArtifactTypes: ['AxEdt'],
    });
    writeMinedCase(spec, tmpDir);
    expect(() => writeMinedCase(spec, tmpDir)).toThrow(/already exists/i);
  });
});
