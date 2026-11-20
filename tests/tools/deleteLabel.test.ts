/**
 * labels(action="delete") — real files in a scratch directory, real in-memory index.
 * Nothing here touches PackagesLocalDirectory or any real model.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import { XppSymbolIndex } from '../../src/metadata/symbolIndex';
import { labelsTool } from '../../src/tools/labels';
import { deleteLabelInTxt } from '../../src/tools/write/deleteLabel';

let root = '';
const mockConfigMgr = {
  ensureLoaded: vi.fn(async () => {}),
  getPackagePath: vi.fn(() => root),
  getModelName: vi.fn(() => 'ContosoExt'),
  getWriteAnchorModel: vi.fn(() => 'ContosoExt'),
  getToolProjectSwitch: vi.fn(() => null),
  getPackageNameFromWorkspacePath: vi.fn(() => 'ContosoExt'),
  getProjectPath: vi.fn(async () => null),
  getSolutionPath: vi.fn(async () => null),
  getDevEnvironmentType: vi.fn(async () => 'traditional'),
  getCustomPackagesPath: vi.fn(async () => null),
  getMicrosoftPackagesPath: vi.fn(async () => null),
};
vi.mock('../../src/utils/configManager', () => ({ getConfigManager: vi.fn(() => mockConfigMgr) }));

const BOM = '﻿';
const EN = `${BOM}Alpha=Alpha text\r\n ;alpha comment\r\nGone=Gone text\r\n ;gone comment\r\n ;second comment line\r\nZulu=Zulu text\r\n`;
const CS = `${BOM}Alpha=Alfa\r\n ;alpha comment\r\nGone=Pryč\r\n ;gone comment\r\nZulu=Zulu cs\r\n`;

let index: XppSymbolIndex;
const call = (args: Record<string, unknown>) =>
  labelsTool(
    { method: 'tools/call', params: { name: 'labels', arguments: { action: 'delete', model: 'ContosoExt', ...args } } } as CallToolRequest,
    { symbolIndex: index } as any,
  );
const txt = (lang: string) => path.join(root, 'ContosoExt', 'ContosoExt', 'AxLabelFile', 'LabelResources', lang, `ContosoExt.${lang}.label.txt`);
const read = (p: string) => fs.readFile(p, 'utf-8');
const out = (r: any) => r.content[0].text as string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'delete-label-'));
  for (const [lang, body] of [['en-US', EN], ['cs', CS]] as const) {
    await fs.mkdir(path.dirname(txt(lang)), { recursive: true });
    await fs.writeFile(txt(lang), body, 'utf-8');
  }
  index = new XppSymbolIndex(':memory:', ':memory:');
  index.bulkAddLabels(
    ['en-US', 'cs'].flatMap(language => ['Alpha', 'Gone', 'Zulu'].map(labelId => ({
      labelId, labelFileId: 'ContosoExt', model: 'ContosoExt', language,
      text: labelId === 'Gone' ? 'Vanishing words' : `${labelId} text`, filePath: txt(language),
    }))),
    { skipFtsRebuild: true, keepTriggers: true },
  );
});

afterEach(async () => {
  index.close();
  await fs.rm(root, { recursive: true, force: true });
});

const hits = () => index.searchLabels('Vanishing').length;

describe('deleteLabelInTxt', () => {
  it('removes the label and all its comment lines, keeping BOM, CRLF and order', () => {
    const r = deleteLabelInTxt(EN, 'Gone')!;
    expect(r.content).toBe(`${BOM}Alpha=Alpha text\r\n ;alpha comment\r\nZulu=Zulu text\r\n`);
    expect(r.removedLines).toHaveLength(3);
  });
  it('returns null for a missing label and keeps LF files LF', () => {
    expect(deleteLabelInTxt(EN, 'Nope')).toBeNull();
    expect(deleteLabelInTxt('A=a\n B\nGone=g\n', 'Gone')!.content).toBe('A=a\n B\n');
  });
});

describe('labels(action="delete")', () => {
  it('deletes from every language and from the index', async () => {
    expect(hits()).toBeGreaterThan(0);
    const r = await call({ labelId: 'Gone', labelFileId: 'ContosoExt' });
    expect(r.isError).toBeFalsy();
    expect(await read(txt('en-US'))).toBe(`${BOM}Alpha=Alpha text\r\n ;alpha comment\r\nZulu=Zulu text\r\n`);
    expect(await read(txt('cs'))).toBe(`${BOM}Alpha=Alfa\r\n ;alpha comment\r\nZulu=Zulu cs\r\n`);
    expect(hits()).toBe(0);
    expect(index.searchLabels('Zulu').length).toBeGreaterThan(0);
  });

  it('accepts @File:Id, also with the full-width ＠', async () => {
    const r = await call({ labelId: '＠ContosoExt:Gone' });
    expect(r.isError).toBeFalsy();
    expect(await read(txt('en-US'))).not.toContain('Gone=');
  });

  it('dryRun shows what would be removed and writes nothing', async () => {
    const r = await call({ labelId: 'Gone', labelFileId: 'ContosoExt', dryRun: true });
    expect(out(r)).toContain('DRY RUN');
    expect(out(r)).toContain('Gone=Gone text');
    expect(await read(txt('en-US'))).toBe(EN);
    expect(await read(txt('cs'))).toBe(CS);
    expect(hits()).toBeGreaterThan(0);
  });

  describe('with a reference in the model', () => {
    const xpp = () => path.join(root, 'ContosoExt', 'ContosoExt', 'AxClass', 'Foo.xml');
    beforeEach(async () => {
      await fs.mkdir(path.dirname(xpp()), { recursive: true });
      await fs.writeFile(xpp(), '<Source>info(literalStr("@ContosoExt:Gone"));</Source>', 'utf-8');
    });

    it('refuses and lists the reference', async () => {
      const r = await call({ labelId: 'Gone', labelFileId: 'ContosoExt' });
      expect(r.isError).toBe(true);
      expect(out(r)).toContain('Foo.xml');
      expect(await read(txt('en-US'))).toBe(EN);
      expect(hits()).toBeGreaterThan(0);
    });

    it('does not mistake a longer label ID for the reference', async () => {
      await fs.writeFile(xpp(), '<Source>literalStr("@ContosoExt:GoneToo")</Source>', 'utf-8');
      expect((await call({ labelId: 'Gone', labelFileId: 'ContosoExt' })).isError).toBeFalsy();
    });

    it('deletes anyway with force=true and reports the dangling reference', async () => {
      const r = await call({ labelId: 'Gone', labelFileId: 'ContosoExt', force: true });
      expect(r.isError).toBeFalsy();
      expect(out(r)).toContain('Foo.xml');
      expect(await read(txt('en-US'))).not.toContain('Gone=');
    });
  });

  it('reports a missing label clearly and writes nothing', async () => {
    const r = await call({ labelId: 'NoSuchLabel', labelFileId: 'ContosoExt' });
    expect(out(r)).toContain('not found');
    expect(await read(txt('en-US'))).toBe(EN);
  });

  it('refuses a label file extension unless allowed', async () => {
    const r = await call({ labelId: 'Gone', labelFileId: 'ContosoExt_Extension' });
    expect(r.isError).toBe(true);
    expect(out(r)).toMatch(/extension/i);
  });

  it('is reachable through the action aliases', async () => {
    const r = await call({ action: 'remove-label', labelId: 'Gone', labelFileId: 'ContosoExt', dryRun: true });
    expect(out(r)).toContain('DRY RUN');
  });
});
