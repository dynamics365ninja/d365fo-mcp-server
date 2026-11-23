/**
 * labels(action="list") — real files in a scratch directory, real in-memory index.
 * Nothing here touches PackagesLocalDirectory or any real model.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import { XppSymbolIndex } from '../../src/metadata/symbolIndex';
import { labelsTool } from '../../src/tools/labels';
import { capToolResponse } from '../../src/tools/responseCaps';

const BOM = '﻿';
const EN =
  `${BOM}AlphaOne=Alpha one\r\n ;TICKET-101\r\nAlphaTwo=Alpha two\r\n ;ticket-200 other\r\n` +
  `BetaOne=Beta one\r\n ;TICKET-101\r\nBetaNoComment=Beta plain\r\n`;
// fi: AlphaOne translated, AlphaTwo empty text, BetaOne absent, BetaNoComment translated.
const FI = `${BOM}AlphaOne=Alfa yksi\r\n ;TICKET-101\r\nAlphaTwo=\r\nBetaNoComment=Beta tavallinen\r\n`;

let root = '';
let index: XppSymbolIndex;
const txt = (lang: string) =>
  path.join(root, 'ContosoCore', 'ContosoCore', 'AxLabelFile', 'LabelResources', lang, `ContosoCore.${lang}.label.txt`);
const call = (args: Record<string, unknown>) =>
  labelsTool(
    { method: 'tools/call', params: { name: 'labels', arguments: { action: 'list', model: 'ContosoCore', labelFileId: 'ContosoCore', ...args } } } as CallToolRequest,
    { symbolIndex: index } as any,
  );
const out = (r: any) => r.content[0].text as string;
const ids = (text: string) => [...text.matchAll(/@ContosoCore:(\w+)/g)].map(m => m[1]);

async function setup(files: Record<string, string>) {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'list-labels-'));
  for (const [lang, body] of Object.entries(files)) {
    await fs.mkdir(path.dirname(txt(lang)), { recursive: true });
    await fs.writeFile(txt(lang), body, 'utf-8');
  }
  index = new XppSymbolIndex(':memory:', ':memory:');
  // Only en-US is indexed (LABEL_LANGUAGES=en-US): fi must still be read from disk.
  index.bulkAddLabels(
    ['AlphaOne', 'AlphaTwo', 'BetaOne', 'BetaNoComment'].map(labelId => ({
      labelId, labelFileId: 'ContosoCore', model: 'ContosoCore', language: 'en-US', text: labelId, filePath: txt('en-US'),
    })),
  );
}

afterEach(async () => { if (root) await fs.rm(root, { recursive: true, force: true }); root = ''; });

describe('labels(action="list")', () => {
  beforeEach(() => setup({ 'en-US': EN, fi: FI }));

  it('lists one line per label with id, en-US text and comment, in file order (BOM-safe)', async () => {
    const text = out(await call({}));
    expect(text).toContain('4 of 4 label(s)');
    expect(ids(text)).toEqual(['AlphaOne', 'AlphaTwo', 'BetaOne', 'BetaNoComment']);
    expect(text).toContain('@ContosoCore:AlphaOne — "Alpha one"  ;TICKET-101');
    expect(text).toContain('@ContosoCore:BetaNoComment — "Beta plain"');
    expect(text).toContain('End of list (4 matched)');
  });

  it('filters by id prefix, case-insensitively', async () => {
    expect(ids(out(await call({ idPrefix: 'beta' })))).toEqual(['BetaOne', 'BetaNoComment']);
  });

  it('filters by developer comment, case-insensitive substring', async () => {
    expect(ids(out(await call({ comment: 'ticket-101' })))).toEqual(['AlphaOne', 'BetaOne']);
    expect(ids(out(await call({ comment: 'TICKET-2' })))).toEqual(['AlphaTwo']);
  });

  it('missingLanguage: absent label and empty translation both count, translated ones do not', async () => {
    expect(ids(out(await call({ missingLanguage: 'fi' })))).toEqual(['AlphaTwo', 'BetaOne']);
    expect(ids(out(await call({ missingLanguage: 'fi', comment: 'TICKET-101' })))).toEqual(['BetaOne']);
  });

  it('missingLanguage for a language with no file says so and lists everything', async () => {
    const text = out(await call({ missingLanguage: 'de' }));
    expect(text).toContain('no .label.txt for "de"');
    expect(ids(text)).toHaveLength(4);
  });

  it('verbose shows every language, (missing) where there is none', async () => {
    const text = out(await call({ verbose: true, idPrefix: 'BetaOne' }));
    expect(text).toContain('[en-US] Beta one');
    expect(text).toContain('[fi] (missing)');
  });

  it('language=fi shows the fi text', async () => {
    expect(out(await call({ language: 'fi', idPrefix: 'AlphaOne' }))).toContain('"Alfa yksi"');
  });

  it('pages with maxResults + offset (also nested in params) and reports the rest', async () => {
    const first = out(await call({ maxResults: 3 }));
    expect(ids(first)).toEqual(['AlphaOne', 'AlphaTwo', 'BetaOne']);
    expect(first).toContain('showing 1–3');
    expect(first).toContain('1 more matched (4 total)');
    expect(first).toContain('params={offset:3}');

    const second = out(await call({ maxResults: 3, params: { offset: 3 } }));
    expect(ids(second)).toEqual(['BetaNoComment']);
    expect(second).toContain('End of list');
  });

  it('an offset past the end is explained, not empty', async () => {
    expect(out(await call({ offset: 99 }))).toContain('offset 99 is past the last match (4)');
  });

  it('no match says so', async () => {
    expect(out(await call({ comment: 'nothing like this' }))).toContain('No labels match');
  });

  it('an unindexed label file is an error that points at info', async () => {
    const r = await call({ labelFileId: 'Nope' });
    expect(r.isError).toBe(true);
    expect(out(r)).toContain('action="info"');
  });

  it('the legacy "list" -> info alias is gone but list-files still maps to info', async () => {
    const r = await labelsTool(
      { method: 'tools/call', params: { name: 'labels', arguments: { action: 'list-files', model: 'ContosoCore' } } } as CallToolRequest,
      { symbolIndex: index } as any,
    );
    expect(out(r)).toContain('LabelFileId : ContosoCore');
  });
});

describe('labels(action="list") on a big label file', () => {
  const COUNT = 600;
  beforeEach(async () => {
    const body = Array.from({ length: COUNT }, (_, i) =>
      `Label${String(i).padStart(4, '0')}=${'Some fairly long label text '.repeat(3)}${i}\r\n ;TICKET-101\r\n`).join('');
    await setup({ 'en-US': body });
  });

  it('never cuts silently: the page stays under the response cap and reports total + next offset', async () => {
    const r = await call({ maxResults: 500 });
    const text = out(r);
    expect(text.length).toBeLessThan(12_000);
    expect(capToolResponse('labels', r).content[0].text).toBe(text); // the cap does not touch it
    const shown = ids(text).length;
    expect(shown).toBeGreaterThan(0);
    expect(shown).toBeLessThan(500);
    expect(text).toContain(`${COUNT - shown} more matched (${COUNT} total)`);
    expect(text).toContain(`params={offset:${shown}}`);
  });

  it('walking the pages by the reported offset visits every label exactly once', async () => {
    const seen: string[] = [];
    let offset = 0;
    for (let guard = 0; guard < 100 && offset < COUNT; guard++) {
      const text = out(await call({ maxResults: 500, offset }));
      const page = ids(text);
      expect(page.length).toBeGreaterThan(0);
      seen.push(...page);
      offset += page.length;
    }
    expect(seen).toHaveLength(COUNT);
    expect(new Set(seen).size).toBe(COUNT);
  });
});
