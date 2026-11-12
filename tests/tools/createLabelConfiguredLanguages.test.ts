import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { configuredLabelLanguageMatcher, createLabelTool } from '../../src/tools/write/createLabel';
import { getLabelInfoTool } from '../../src/tools/readers/getLabelInfo';
import { lookupCreatedArtifact } from '../../src/workspace/createdArtifactLedger';
import type { XppServerContext } from '../../src/types/context';

vi.mock('../../src/utils/configManager', () => ({
  getConfigManager: () => ({
    ensureLoaded: async () => {},
    getProjectPath: async () => null,
    getDevEnvironmentType: async () => 'traditional',
    getWriteAnchorModel: () => 'ContosoExt',
    getToolProjectSwitch: () => null,
  }),
}));

/**
 * Without an explicit `languages` scope, create writes the label file's own languages
 * (createLabelOwnLanguages.test.ts). A supplied translation for a language the file
 * lacks adds that language only when LABEL_LANGUAGES lists it — a caller that
 * translates into every language it saw in the model (here the sibling report label
 * file's lt / nb-NO) must not grow the file. Every file create writes for the first
 * time is recorded so undo can remove it.
 */
describe('create_label adds languages only when LABEL_LANGUAGES allows', () => {
  let root: string;
  let axLabelDir: string;
  let resources: string;
  const savedLanguages = process.env.LABEL_LANGUAGES;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'label-owned-'));
    axLabelDir = path.join(root, 'ContosoExt', 'ContosoExt', 'AxLabelFile');
    resources = path.join(axLabelDir, 'LabelResources');
    await seed('ContosoExt', 'en-US');
    await seed('ContosoExt', 'fi');
    // Sibling report label file owns two more locales.
    for (const lang of ['en-US', 'lt', 'nb-NO']) await seed('ContosoReport', lang);
    delete process.env.LABEL_LANGUAGES;
  });

  afterEach(async () => {
    if (savedLanguages === undefined) delete process.env.LABEL_LANGUAGES;
    else process.env.LABEL_LANGUAGES = savedLanguages;
    await fs.rm(root, { recursive: true, force: true });
  });

  const txt = (file: string, lang: string) => path.join(resources, lang, `${file}.${lang}.label.txt`);
  const xml = (file: string, lang: string) => path.join(axLabelDir, `${file}_${lang}.xml`);
  const exists = (p: string) => fs.access(p).then(() => true, () => false);

  async function seed(file: string, lang: string) {
    await fs.mkdir(path.join(resources, lang), { recursive: true });
    await fs.writeFile(txt(file, lang), '﻿Other=Keep me\r\n');
    await fs.writeFile(xml(file, lang), '<AxLabelFile />');
  }

  async function create(translations: Array<{ language: string; text: string }>, extra: Record<string, unknown> = {}) {
    const result = await createLabelTool({
      method: 'tools/call',
      params: { name: 'create_label', arguments: {
        labelId: 'Greeting', labelFileId: 'ContosoExt', model: 'ContosoExt',
        packageName: 'ContosoExt', packagePath: root, addToProject: false,
        translations, ...extra,
      } },
    }, { symbolIndex: { bulkAddLabels: vi.fn() } } as unknown as XppServerContext);
    expect(result.isError).toBeFalsy();
    return String(result.content[0].text);
  }

  it('adds supplied languages as before when LABEL_LANGUAGES is unset', async () => {
    await create([{ language: 'en-US', text: 'Hello' }, { language: 'lt', text: 'Labas' }]);
    expect(await fs.readFile(txt('ContosoExt', 'lt'), 'utf8')).toContain('Greeting=Labas');
  });

  it('creates a label file with no configured language among the supplied ones', async () => {
    process.env.LABEL_LANGUAGES = 'en-US,fi';
    const result = await createLabelTool({
      method: 'tools/call',
      params: { name: 'create_label', arguments: {
        labelId: 'Greeting', labelFileId: 'ContosoNew', model: 'ContosoExt',
        packageName: 'ContosoExt', packagePath: root, addToProject: false,
        translations: [{ language: 'sv', text: 'Hej' }],
      } },
    }, { symbolIndex: { bulkAddLabels: vi.fn() } } as unknown as XppServerContext);
    expect(result.isError).toBeFalsy();
    expect(await fs.readFile(txt('ContosoNew', 'sv'), 'utf8')).toContain('Greeting=Hej');
  });

  it('skips a translation for a locale the file lacks when LABEL_LANGUAGES does not list it', async () => {
    process.env.LABEL_LANGUAGES = 'en-US,fi';
    const reply = await create([
      { language: 'en-US', text: 'Hello' }, { language: 'fi', text: 'Hei' },
      { language: 'lt', text: 'Labas' }, { language: 'nb-NO', text: 'Hei' },
    ]);
    expect(await exists(txt('ContosoExt', 'lt'))).toBe(false);
    expect(await exists(xml('ContosoExt', 'nb-NO'))).toBe(false);
    expect(reply).toMatch(/Not written: lt, nb-NO/);
    expect(await fs.readFile(txt('ContosoExt', 'fi'), 'utf8')).toContain('Greeting=Hei');
  });

  it('adds a configured locale the file lacks, and records the new files for undo', async () => {
    process.env.LABEL_LANGUAGES = 'en-US,fi,sv';
    await create([{ language: 'en-US', text: 'Hello' }, { language: 'sv', text: 'Hej' }]);
    expect(await fs.readFile(txt('ContosoExt', 'sv'), 'utf8')).toContain('Greeting=Hej');
    expect(lookupCreatedArtifact(txt('ContosoExt', 'sv'))).toBeDefined();
    expect(lookupCreatedArtifact(xml('ContosoExt', 'sv'))).toBeDefined();
    // Existing files are written, not created: undo must never delete them.
    expect(lookupCreatedArtifact(txt('ContosoExt', 'en-US'))).toBeUndefined();
  });

  it('still adds an unconfigured locale when languages=[…] asks for it explicitly', async () => {
    process.env.LABEL_LANGUAGES = 'en-US,fi';
    await create([{ language: 'en-US', text: 'Hello' }, { language: 'lt', text: 'Labas' }], { languages: ['en-US', 'lt'] });
    expect(await fs.readFile(txt('ContosoExt', 'lt'), 'utf8')).toContain('Greeting=Labas');
    expect(await exists(xml('ContosoExt', 'lt'))).toBe(true);
    expect(lookupCreatedArtifact(txt('ContosoExt', 'lt'))).toBeDefined();
  });

  it('keeps writing every locale a label file already owns, configured or not', async () => {
    process.env.LABEL_LANGUAGES = 'en-US';
    const result = await createLabelTool({
      method: 'tools/call',
      params: { name: 'create_label', arguments: {
        labelId: 'Total', labelFileId: 'ContosoReport', model: 'ContosoExt',
        packageName: 'ContosoExt', packagePath: root, addToProject: false,
        allowExtensionLabelFile: true,
        translations: [{ language: 'en-US', text: 'Total' }, { language: 'lt', text: 'Iš viso' }],
      } },
    }, { symbolIndex: { bulkAddLabels: vi.fn() } } as unknown as XppServerContext);
    expect(result.isError).toBeFalsy();
    expect(await fs.readFile(txt('ContosoReport', 'lt'), 'utf8')).toContain('Total=Iš viso');
    expect(await fs.readFile(txt('ContosoReport', 'nb-NO'), 'utf8')).toContain('Total=Total');
    expect(await exists(txt('ContosoReport', 'fi'))).toBe(false);
  });
});

describe('configuredLabelLanguageMatcher', () => {
  it('imposes no restriction when unset or "all"', () => {
    expect(configuredLabelLanguageMatcher(undefined)).toBeNull();
    expect(configuredLabelLanguageMatcher('')).toBeNull();
    expect(configuredLabelLanguageMatcher('ALL')).toBeNull();
  });

  it('matches exactly, ignoring case and `_` vs `-` only', () => {
    const m = configuredLabelLanguageMatcher('en-US, fi, de-AT')!;
    expect(m('en-us')).toBe(true);
    expect(m('en_US')).toBe(true);
    expect(m('fi')).toBe(true);
    // A bare and a regional code are distinct label languages.
    expect(m('fi-FI')).toBe(false);
    expect(m('de')).toBe(false);
    expect(m('en-GB')).toBe(false);
    expect(m('lt')).toBe(false);
  });
});

describe('labels info with a label file id', () => {
  it('does not report a locale whose indexed file is gone from disk', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'label-info-'));
    try {
      const present = path.join(dir, 'ContosoExt.en-US.label.txt');
      await fs.writeFile(present, '');
      const symbolIndex = {
        getLabelFileIds: () => [{ labelFileId: 'ContosoExt', model: 'ContosoExt', languages: 'en-US,lt' }],
        getLabelFilePaths: () => [
          { language: 'en-US', filePath: present, model: 'ContosoExt' },
          { language: 'lt', filePath: path.join(dir, 'gone', 'ContosoExt.lt.label.txt'), model: 'ContosoExt' },
        ],
      };
      const result = await getLabelInfoTool({
        method: 'tools/call',
        params: { name: 'get_label_info', arguments: { labelFileId: 'ContosoExt', model: 'ContosoExt' } },
      }, { symbolIndex } as unknown as XppServerContext);
      const text = String(result.content[0].text);
      expect(text).toMatch(/Languages\s+: en-US\n/);
      expect(text).toMatch(/Stale index : lt/);
      expect(text).toContain('(missing on disk)');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
