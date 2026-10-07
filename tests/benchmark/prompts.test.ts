import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { adHocPromptSpec, evaluateChecks, loadPromptSpecs, promptHash } from '../../src/benchmark/prompts.js';

const CATALOGUE = path.resolve(__dirname, '../../eval/benchmark/prompts');

describe('prompt catalogue', () => {
  it('ships valid starter prompts whose ids match their file names', () => {
    const specs = loadPromptSpecs(CATALOGUE);
    expect(specs.length).toBeGreaterThanOrEqual(3);
    for (const s of specs) {
      expect(fs.existsSync(path.join(CATALOGUE, `${s.id}.json`))).toBe(true);
      expect(s.prompt.length).toBeGreaterThan(40);
      for (const re of [...(s.expects?.mustMatch ?? []), ...(s.expects?.mustNotMatch ?? [])]) expect(() => new RegExp(re, 'is')).not.toThrow();
    }
  });

  it('hashes the text independent of line endings', () => {
    expect(promptHash('a\r\nb')).toBe(promptHash('a\nb'));
    expect(promptHash('a')).not.toBe(promptHash('b'));
    expect(promptHash('x')).toMatch(/^[0-9a-f]{12}$/);
  });

  it('refuses an invalid spec by name rather than skipping it', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-prompts-'));
    try {
      fs.writeFileSync(path.join(dir, 'ok.json'), JSON.stringify({ id: 'ok', title: 't', prompt: 'p' }));
      expect(loadPromptSpecs(dir).map(s => s.id)).toEqual(['ok']);
      fs.writeFileSync(path.join(dir, 'bad.json'), JSON.stringify({ id: 'other-name', title: 't', prompt: 'p' }));
      expect(() => loadPromptSpecs(dir)).toThrow(/bad\.json.*must equal the file name/);
      fs.writeFileSync(path.join(dir, 'bad.json'), '{ not json');
      expect(() => loadPromptSpecs(dir)).toThrow(/not valid JSON/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('scores checks case-insensitively and treats a broken regex as a failed check', () => {
    const spec = adHocPromptSpec('x', 'p');
    spec.expects = { mustMatch: ['custaccount', '(unclosed'], mustNotMatch: ['today\\(\\)'] };
    const { checks, score } = evaluateChecks(spec, 'Use CustAccount; never today()');
    expect(checks.map(c => c.passed)).toEqual([true, false, false]);
    expect(score).toBeCloseTo(1 / 3, 6);
    expect(evaluateChecks(adHocPromptSpec('y', 'p'), 'anything')).toEqual({ checks: [], score: null });
    expect(evaluateChecks(spec, null).score).toBeCloseTo(1 / 3, 6); // no answer: must-match fail, must-not pass
  });

  it('rejects an ad-hoc id that would not make a file name', () => {
    expect(() => adHocPromptSpec('a b', 'p')).toThrow(/letters, digits/);
  });
});
