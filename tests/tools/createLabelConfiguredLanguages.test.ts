import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { configuredLabelLanguages, createLabelTool } from '../../src/tools/write/createLabel';
import { getLabelInfoTool } from '../../src/tools/readers/getLabelInfo';
import { undoLastModificationTool } from '../../src/tools/sdlc/undoLastModification';
import { isListedLabelLanguage, parseLabelLanguages } from '../../src/metadata/labelParser';
import { _clearCreatedArtifactLedger, lookupCreatedArtifact } from '../../src/workspace/createdArtifactLedger';
import type { XppServerContext } from '../../src/types/context';

vi.mock('../../src/utils/configManager', () => ({
  getConfigManager: () => ({
    ensureLoaded: async () => {},
    getProjectPath: async () => null,
    getDevEnvironmentType: async () => 'traditional',
    getWriteAnchorModel: () => 'ContosoExt',
    getToolProjectSwitch: () => null,
    getSolutionPath: async () => null,
    getContext: () => null,
    getConfiguredProjectPath: () => null,
    getServerDetectedProject: () => null,
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
  const savedSolutions = process.env.D365FO_SOLUTIONS_PATH;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'label-owned-'));
    axLabelDir = path.join(root, 'ContosoExt', 'ContosoExt', 'AxLabelFile');
    resources = path.join(axLabelDir, 'LabelResources');
    await seed('ContosoExt', 'en-US');
    await seed('ContosoExt', 'fi');
    // Sibling report label file owns two more locales.
    for (const lang of ['en-US', 'lt', 'nb-NO']) await seed('ContosoReport', lang);
    delete process.env.LABEL_LANGUAGES;
    _clearCreatedArtifactLedger();
  });

  afterEach(async () => {
    if (savedLanguages === undefined) delete process.env.LABEL_LANGUAGES;
    else process.env.LABEL_LANGUAGES = savedLanguages;
    if (savedSolutions === undefined) delete process.env.D365FO_SOLUTIONS_PATH;
    else process.env.D365FO_SOLUTIONS_PATH = savedSolutions;
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

  it('starts a new label file with every configured language, untranslated ones with the fallback', async () => {
    process.env.LABEL_LANGUAGES = 'en-US,fi';
    const result = await createLabelTool({
      method: 'tools/call',
      params: { name: 'create_label', arguments: {
        labelId: 'Greeting', labelFileId: 'ContosoNew', model: 'ContosoExt',
        packageName: 'ContosoExt', packagePath: root, addToProject: false,
        translations: [{ language: 'en-US', text: 'Hello' }, { language: 'lt', text: 'Labas' }],
      } },
    }, { symbolIndex: { bulkAddLabels: vi.fn() } } as unknown as XppServerContext);
    expect(result.isError).toBeFalsy();
    const reply = String(result.content[0].text);
    expect(await fs.readFile(txt('ContosoNew', 'en-US'), 'utf8')).toContain('Greeting=Hello');
    expect(await fs.readFile(txt('ContosoNew', 'fi'), 'utf8')).toContain('Greeting=Hello');
    expect(await exists(xml('ContosoNew', 'fi'))).toBe(true);
    expect(await exists(txt('ContosoNew', 'lt'))).toBe(false);
    expect(reply).toMatch(/Translation fallback \(en-US\): en-US text written to fi/);
    expect(reply).toMatch(/Not written: lt/);
  });

  it('names a case-variant language once in the Not written warning', async () => {
    process.env.LABEL_LANGUAGES = 'en-US,fi';
    const reply = await create([
      { language: 'en-US', text: 'Hello' }, { language: 'lt', text: 'Labas' }, { language: 'LT', text: 'Labas' },
    ]);
    expect(reply).toMatch(/Not written: lt —/);
  });

  it('reports a skipped language also when the label already exists everywhere else', async () => {
    process.env.LABEL_LANGUAGES = 'en-US,fi';
    await create([{ language: 'en-US', text: 'Hello' }, { language: 'fi', text: 'Hei' }]);
    const reply = await create([
      { language: 'en-US', text: 'Hello' }, { language: 'fi', text: 'Hei' }, { language: 'lt', text: 'Labas' },
    ]);
    expect(reply).toMatch(/already exists/);
    expect(reply).toMatch(/Not written: lt/);
  });

  it('lets undo remove a created label file together with its own project entry only', async () => {
    process.env.LABEL_LANGUAGES = 'en-US,fi,sv';
    process.env.D365FO_SOLUTIONS_PATH = root;
    const projectPath = path.join(root, 'ContosoExt.rnrproj');
    const entry = (lang: string) =>
      `    <Content Include="AxLabelFile\\ContosoExt_${lang}">\r\n      <SubType>Content</SubType>\r\n` +
      `      <Name>ContosoExt_${lang}</Name>\r\n      <Link>Label Files\\ContosoExt_${lang}</Link>\r\n    </Content>\r\n` +
      `    <Content Include="ContosoExt.${lang}.label.txt">\r\n      <SubType>Content</SubType>\r\n` +
      `      <Name>ContosoExt.${lang}.label.txt</Name>\r\n      <DependentUpon>AxLabelFile\\ContosoExt_${lang}</DependentUpon>\r\n    </Content>\r\n`;
    await fs.writeFile(projectPath,
      '<?xml version="1.0" encoding="utf-8"?>\r\n' +
      '<Project ToolsVersion="14.0" DefaultTargets="Build" xmlns="http://schemas.microsoft.com/developer/msbuild/2003">\r\n' +
      '  <ItemGroup>\r\n    <Folder Include="Label Files\\" />\r\n  </ItemGroup>\r\n' +
      '  <ItemGroup>\r\n' + entry('en-US') + entry('fi') + '  </ItemGroup>\r\n</Project>\r\n');

    await create([{ language: 'en-US', text: 'Hello' }, { language: 'sv', text: 'Hej' }], { addToProject: true, projectPath });
    expect(await fs.readFile(projectPath, 'utf8')).toContain('AxLabelFile\\ContosoExt_sv');

    const context = {
      symbolIndex: { removeSymbolsByFile: vi.fn(() => ({ deletedCount: 0 })), removeLabelsByFile: vi.fn(() => 1) },
    } as unknown as XppServerContext;
    const undoXml = await undoLastModificationTool({ filePath: xml('ContosoExt', 'sv') }, context);
    expect(undoXml.isError).toBeFalsy();
    expect(await exists(xml('ContosoExt', 'sv'))).toBe(false);
    let project = await fs.readFile(projectPath, 'utf8');
    expect(project).not.toContain('Include="AxLabelFile\\ContosoExt_sv"');
    expect(project).toContain('Include="ContosoExt.sv.label.txt"');

    const undoTxt = await undoLastModificationTool({ filePath: txt('ContosoExt', 'sv') }, context);
    expect(undoTxt.isError).toBeFalsy();
    expect(await exists(txt('ContosoExt', 'sv'))).toBe(false);
    project = await fs.readFile(projectPath, 'utf8');
    expect(project).not.toContain('ContosoExt.sv.label.txt');
    // Entries that were in the project before the create stay.
    expect(project).toContain('Include="AxLabelFile\\ContosoExt_fi"');
    expect(project).toContain('Include="ContosoExt.en-US.label.txt"');
    // An existing file the create only rewrote is not undo's to delete.
    expect((await undoLastModificationTool({ filePath: txt('ContosoExt', 'en-US') }, context)).isError).toBe(true);
    expect(await exists(txt('ContosoExt', 'en-US'))).toBe(true);
  });

  async function createRaw(args: Record<string, unknown>) {
    const result = await createLabelTool({
      method: 'tools/call',
      params: { name: 'create_label', arguments: {
        labelId: 'Greeting', labelFileId: 'ContosoExt', model: 'ContosoExt',
        packageName: 'ContosoExt', packagePath: root, addToProject: false, ...args,
      } },
    }, { symbolIndex: { bulkAddLabels: vi.fn() } } as unknown as XppServerContext);
    return { isError: !!result.isError, text: String(result.content[0].text) };
  }

  it('fails instead of replacing a label file that exists but cannot be read', async () => {
    // A directory in place of the .label.txt: reading it fails with EISDIR, not ENOENT.
    await fs.rm(txt('ContosoExt', 'fi'));
    await fs.mkdir(txt('ContosoExt', 'fi'));
    const r = await createRaw({ translations: [{ language: 'en-US', text: 'Hello' }, { language: 'fi', text: 'Hei' }] });
    expect(r.isError).toBe(true);
    expect((await fs.stat(txt('ContosoExt', 'fi'))).isDirectory()).toBe(true);
    expect(lookupCreatedArtifact(txt('ContosoExt', 'fi'))).toBeUndefined();
  });

  it('refuses a new label file with createLabelFileIfMissing=false although other label files exist', async () => {
    process.env.LABEL_LANGUAGES = 'en-US,fi';
    const r = await createRaw({ labelFileId: 'ContosoExtt', createLabelFileIfMissing: false,
      translations: [{ language: 'en-US', text: 'Hello' }] });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/not found/);
    expect(await exists(xml('ContosoExtt', 'en-US'))).toBe(false);
    expect(await exists(txt('ContosoExtt', 'fi'))).toBe(false);
  });

  it('stops offering a created label file to undo once a later call adds a label to it', async () => {
    process.env.LABEL_LANGUAGES = 'en-US,fi';
    await createRaw({ labelFileId: 'ContosoNew', translations: [{ language: 'en-US', text: 'Hello' }] });
    expect(lookupCreatedArtifact(txt('ContosoNew', 'en-US'))).toBeDefined();
    expect(lookupCreatedArtifact(xml('ContosoNew', 'fi'))).toBeDefined();

    await createRaw({ labelFileId: 'ContosoNew', labelId: 'Second', translations: [{ language: 'en-US', text: 'Second' }] });
    for (const lang of ['en-US', 'fi']) {
      expect(lookupCreatedArtifact(txt('ContosoNew', lang))).toBeUndefined();
      expect(lookupCreatedArtifact(xml('ContosoNew', lang))).toBeUndefined();
    }
    const undo = await undoLastModificationTool({ filePath: txt('ContosoNew', 'en-US') },
      { symbolIndex: {} } as unknown as XppServerContext);
    expect(undo.isError).toBe(true);
    expect(await fs.readFile(txt('ContosoNew', 'en-US'), 'utf8')).toMatch(/Greeting=Hello[\s\S]*|Second=Second/);
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

describe('LABEL_LANGUAGES parsing', () => {
  it('imposes no restriction for create when unset, empty or "all"', () => {
    expect(configuredLabelLanguages('')).toBeNull();
    expect(configuredLabelLanguages('  ')).toBeNull();
    expect(configuredLabelLanguages('ALL')).toBeNull();
  });

  it('reads a value with no usable code as "nothing allowed", not "everything"', () => {
    // The indexer would otherwise ingest every shipped language over a typo.
    expect(parseLabelLanguages(' , ')).toEqual([]);
    expect(configuredLabelLanguages(' , ')).toEqual([]);
  });

  it('keeps the configured spelling and order, without duplicates', () => {
    expect(parseLabelLanguages('en-US, fi,EN-us, de_AT')).toEqual(['en-US', 'fi', 'de-AT']);
  });

  it('matches exactly, ignoring case and `_` vs `-` only', () => {
    const configured = parseLabelLanguages('en-US, fi, de-AT')!;
    expect(isListedLabelLanguage(configured, 'en-us')).toBe(true);
    expect(isListedLabelLanguage(configured, 'en_US')).toBe(true);
    expect(isListedLabelLanguage(configured, 'fi')).toBe(true);
    // A bare and a regional code are distinct label languages.
    expect(isListedLabelLanguage(configured, 'fi-FI')).toBe(false);
    expect(isListedLabelLanguage(configured, 'de')).toBe(false);
    expect(isListedLabelLanguage(configured, 'lt')).toBe(false);
  });
});

describe('labels info with a label file id', () => {
  it('does not report a locale whose indexed file is gone from disk', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'label-info-'));
    try {
      const present = path.join(dir, 'ContosoExt.en-US.label.txt');
      await fs.writeFile(present, '');
      const goneLt = path.join(dir, 'gone', 'ContosoExt.lt.label.txt');
      const goneCore = path.join(dir, 'gone', 'core.en-US.label.txt');
      const removeLabelsByFile = vi.fn(() => 3);
      const symbolIndex = {
        getLabelFileIds: () => [
          { labelFileId: 'ContosoExt', model: 'ContosoExt', languages: 'en-US,lt' },
          { labelFileId: 'ContosoExt', model: 'ContosoCore', languages: 'en-US,lt' },
        ],
        // No `model` in the call: the paths of both models come back.
        getLabelFilePaths: () => [
          { language: 'en-US', filePath: present, model: 'ContosoExt' },
          { language: 'lt', filePath: goneLt, model: 'ContosoExt' },
          { language: 'en-US', filePath: goneCore, model: 'ContosoCore' },
          { language: 'en-US', filePath: present, model: 'ContosoCore' },
          { language: 'lt', filePath: present, model: 'ContosoCore' },
        ],
        removeLabelsByFile,
      };
      const result = await getLabelInfoTool({
        method: 'tools/call',
        params: { name: 'get_label_info', arguments: { labelFileId: 'ContosoExt' } },
      }, { symbolIndex } as unknown as XppServerContext);
      const [ext, core] = String(result.content[0].text).split('LabelFileId : ').slice(1);
      // ContosoExt: its lt file is gone; ContosoCore's lt file must not hide that.
      expect(ext).toMatch(/Languages\s+: en-US\n/);
      expect(ext).toMatch(/Stale index : lt .*removed from the index/);
      expect(ext).toContain(`${goneLt}  (missing on disk)`);
      expect(ext).not.toContain(goneCore);
      // ContosoCore: one of its two en-US paths is gone — marked per path, en-US not stale.
      expect(core).toMatch(/Languages\s+: en-US,lt\n/);
      expect(core).not.toContain('Stale index');
      expect(core).toContain(`${goneCore}  (missing on disk)`);
      expect(core).not.toContain(`${present}  (missing on disk)`);
      expect(removeLabelsByFile).toHaveBeenCalledWith(goneLt);
      expect(removeLabelsByFile).toHaveBeenCalledWith(goneCore);
      expect(removeLabelsByFile).toHaveBeenCalledTimes(2);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('leaves the index alone when none of the file\'s indexed paths exist on this machine', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'label-info-'));
    try {
      // An index built elsewhere (downloaded database, a build VM's drive).
      const removeLabelsByFile = vi.fn(() => 1);
      const symbolIndex = {
        getLabelFileIds: () => [{ labelFileId: 'ContosoExt', model: 'ContosoExt', languages: 'en-US,fi' }],
        getLabelFilePaths: () => [
          { language: 'en-US', filePath: path.join(dir, 'elsewhere', 'ContosoExt.en-US.label.txt'), model: 'ContosoExt' },
          { language: 'fi', filePath: path.join(dir, 'elsewhere', 'ContosoExt.fi.label.txt'), model: 'ContosoExt' },
        ],
        removeLabelsByFile,
      };
      const result = await getLabelInfoTool({
        method: 'tools/call',
        params: { name: 'get_label_info', arguments: { labelFileId: 'ContosoExt', model: 'ContosoExt' } },
      }, { symbolIndex } as unknown as XppServerContext);
      const text = String(result.content[0].text);
      expect(text).toMatch(/Languages\s+: en-US,fi\n/);
      expect(text).toMatch(/none of the indexed files exist on this machine/);
      expect(text).not.toContain('Stale index');
      expect(text).not.toContain('(missing on disk)');
      expect(removeLabelsByFile).not.toHaveBeenCalled();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
