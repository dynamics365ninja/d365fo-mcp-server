import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  adHocPromptSpec,
  evaluateChecks,
  evaluateFileChecks,
  isPromptSpec,
  loadPromptSpecs,
  promptHash,
  renderPrompt,
  usesPlaceholders,
} from '../../src/benchmark/prompts.js';
import type { PromptSpec } from '../../src/benchmark/types.js';

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

  it('ships a reference set of workspace prompts that write, build and check files', () => {
    const reference = loadPromptSpecs(CATALOGUE).filter(s => s.tags.includes('reference'));
    expect(reference.length).toBeGreaterThanOrEqual(3);
    for (const s of reference) {
      expect(s.workspace?.build).toBe(true);
      expect(usesPlaceholders(s.prompt)).toBe(true);
      expect(s.expects?.files?.length).toBeGreaterThanOrEqual(3);
      for (const f of s.expects?.files ?? []) {
        for (const re of [f.path, ...(f.contains ?? []), ...(f.notContains ?? [])]) expect(() => new RegExp(re, 'is')).not.toThrow();
      }
    }
  });

  it('matches the form pattern element the way shipped metadata writes it (with xmlns="")', () => {
    // A first version required a bare <Pattern> and failed every SimpleList form,
    // because AxForm XML carries <Pattern xmlns="">SimpleList</Pattern> (CustGroup).
    const spec = loadPromptSpecs(CATALOGUE).find(s => s.id === 'ref-vendor-certificate-register')!;
    const form = spec.expects!.files!.find(f => f.path.includes('AxForm'))!;
    const xml = '<Design><Pattern xmlns="">SimpleList</Pattern></Design><DataSources><AxFormDataSource><Table>McpVendCertificate</Table></AxFormDataSource></DataSources>';
    expect(evaluateFileChecks(spec, [{ path: 'BenchmarkTestMcp/AxForm/McpVendCertificate.xml', read: () => xml }]).find(c => c.name.includes('SimpleList'))?.passed).toBe(true);
    expect(form.contains!.every(re => new RegExp(re, 'is').test(xml))).toBe(true);
  });

  it('rejects an ad-hoc id that would not make a file name', () => {
    expect(() => adHocPromptSpec('a b', 'p')).toThrow(/letters, digits/);
  });
});

describe('workspace prompts', () => {
  const vars = { model: 'fm-mcp', modelDir: 'K:/PLD/fm-mcp/fm-mcp', packageDir: 'K:/PLD/fm-mcp', packagesRoot: 'K:/PLD', buildCommand: 'node K:/r/scripts/benchmarkSandboxBuild.mjs K:/PLD/fm-mcp' };

  it('fills the placeholders, leaves them visible without a sandbox, and hashes the template', () => {
    const spec: PromptSpec = { id: 'w', title: 'w', prompt: 'Write into {{model}} at {{ modelDir }}; standard code under {{packagesRoot}}.', tags: [], workspace: {} };
    expect(renderPrompt(spec, vars)).toBe('Write into fm-mcp at K:/PLD/fm-mcp/fm-mcp; standard code under K:/PLD.');
    expect(renderPrompt(spec, null)).toBe(spec.prompt);
    expect(usesPlaceholders(spec.prompt)).toBe(true);
    expect(usesPlaceholders('no {{placeholders}} here')).toBe(false);
    expect(renderPrompt({ ...spec, prompt: 'Build: `{{buildCommand}}`' }, vars)).toBe('Build: `node K:/r/scripts/benchmarkSandboxBuild.mjs K:/PLD/fm-mcp`');
  });

  it('validates workspace, timeoutSeconds and file expectations; files need a workspace', () => {
    const base = { id: 'w', title: 't', prompt: 'p' };
    expect(isPromptSpec({ ...base, workspace: { build: true }, timeoutSeconds: 1800, expects: { files: [{ path: 'AxTable/X\\.xml$', contains: ['<Name>X</Name>'] }] } })).toBe(true);
    expect(isPromptSpec({ ...base, expects: { files: [{ path: 'x' }] } })).toBe(false);
    expect(isPromptSpec({ ...base, workspace: { build: 'yes' } })).toBe(false);
    expect(isPromptSpec({ ...base, timeoutSeconds: 0 })).toBe(false);
    expect(isPromptSpec({ ...base, workspace: {}, expects: { files: [{ contains: ['x'] }] } })).toBe(false);
  });

  it('scores a file check only on a changed file whose path and content both match', () => {
    const spec: PromptSpec = {
      id: 'w', title: 't', prompt: 'p', tags: [], workspace: {},
      expects: {
        files: [
          { name: 'enum', path: '/AxEnum/ConCreditHoldReason\\.xml$', contains: ['<IsExtensible>true</IsExtensible>'] },
          { name: 'coc', path: '/AxClass/[^/]*_Extension\\.xml$', contains: ['ExtensionOf\\(tableStr\\(SalesTable\\)\\)'], notContains: ['checkFailed\\(\\s*"[^@]'] },
          { path: '/AxReport/' },
          { name: 'broken', path: '(' },
        ],
      },
    };
    const files: Record<string, string> = {
      'fm-mcp/AxEnum/ConCreditHoldReason.xml': '<AxEnum><IsExtensible>true</IsExtensible></AxEnum>',
      'fm-mcp/AxClass/SalesTableConCreditHold_Extension.xml': '[ExtensionOf(tableStr(SalesTable))] ... checkFailed("Customer is on hold")',
    };
    const changed = Object.keys(files).map(p => ({ path: p, read: () => files[p] }));
    expect(evaluateFileChecks(spec, changed)).toEqual([
      { name: 'file enum', passed: true },
      { name: 'file coc', passed: false },
      { name: 'file /AxReport/', passed: false },
      { name: 'file broken', passed: false },
    ]);
    files['fm-mcp/AxClass/SalesTableConCreditHold_Extension.xml'] = '[ExtensionOf(tableStr(SalesTable))] checkFailed("@fm-mcp:ConCreditHoldBlocked")';
    expect(evaluateFileChecks(spec, changed)[1].passed).toBe(true);
    expect(evaluateFileChecks(spec, [])).toEqual(evaluateFileChecks(spec, []).map(c => ({ ...c, passed: false })));
  });
});
