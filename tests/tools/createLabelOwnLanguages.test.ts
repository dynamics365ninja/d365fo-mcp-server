/**
 * labels(action="create") writes only the languages the label file already has.
 *
 * LabelResources/ is shared by every label file of a model. A model whose other
 * label files carry `ja` has a `ja` folder, and create used to treat every
 * folder as a language of THIS file: it added `<File>.ja.label.txt` and a
 * `<File>_ja.xml` descriptor to a label file that never had Japanese.
 * A language is the file's own when its .label.txt or its descriptor exists.
 * Supplied translations and an explicit `languages` scope still add languages.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createLabelTool } from '../../src/tools/write/createLabel';
import type { XppServerContext } from '../../src/types/context';

vi.mock('../../src/utils/configManager', () => ({
  getConfigManager: () => ({
    ensureLoaded: async () => {},
    getProjectPath: async () => null,
    getDevEnvironmentType: async () => 'traditional',
    getWriteAnchorModel: () => 'Shop',
    getToolProjectSwitch: () => null,
  }),
}));

describe('create_label writes only the label file\'s own languages', () => {
  let root: string;
  let labelDir: string;
  let resources: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'label-own-langs-'));
    labelDir = path.join(root, 'ShopPkg', 'Shop', 'AxLabelFile');
    resources = path.join(labelDir, 'LabelResources');
    // Sibling file "Shop" has en-US and ja; the target file "ShopClaim" has en-US only.
    for (const [file, lang] of [['Shop', 'en-US'], ['Shop', 'ja'], ['ShopClaim', 'en-US']]) {
      await fs.mkdir(path.join(resources, lang), { recursive: true });
      await fs.writeFile(path.join(resources, lang, `${file}.${lang}.label.txt`), '﻿Old=Old\r\n');
      await fs.writeFile(path.join(labelDir, `${file}_${lang}.xml`), '<AxLabelFile />');
    }
  });

  afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

  async function create(labelFileId: string, translations: Array<{ language: string; text: string }>, extra: Record<string, unknown> = {}) {
    return createLabelTool({
      method: 'tools/call',
      params: { name: 'create_label', arguments: {
        labelId: 'Exported', labelFileId, model: 'Shop', packageName: 'ShopPkg', packagePath: root,
        addToProject: false, translations, ...extra,
      } },
    }, { symbolIndex: { bulkAddLabels: vi.fn() } } as unknown as XppServerContext);
  }

  const exists = (p: string) => fs.access(p).then(() => true, () => false);

  it('does not add a sibling\'s language (ja) to a label file that lacks it', async () => {
    const result = await create('ShopClaim', [{ language: 'en-US', text: 'Exported' }]);
    expect(result.isError).toBeFalsy();
    expect(await fs.readFile(path.join(resources, 'en-US', 'ShopClaim.en-US.label.txt'), 'utf8')).toContain('Exported=Exported');
    expect(await exists(path.join(resources, 'ja', 'ShopClaim.ja.label.txt'))).toBe(false);
    expect(await exists(path.join(labelDir, 'ShopClaim_ja.xml'))).toBe(false);
  });

  it('still writes every language the label file has (ja gets the en-US fallback)', async () => {
    const result = await create('Shop', [{ language: 'en-US', text: 'Exported' }]);
    expect(result.isError).toBeFalsy();
    expect(await fs.readFile(path.join(resources, 'ja', 'Shop.ja.label.txt'), 'utf8')).toContain('Exported=Exported');
  });

  it('adds a language when a translation for it is supplied', async () => {
    await create('ShopClaim', [{ language: 'en-US', text: 'Exported' }, { language: 'ja', text: 'エクスポート済み' }]);
    expect(await fs.readFile(path.join(resources, 'ja', 'ShopClaim.ja.label.txt'), 'utf8')).toContain('Exported=エクスポート済み');
    expect(await exists(path.join(labelDir, 'ShopClaim_ja.xml'))).toBe(true);
  });

  it('adds a language named in an explicit languages scope', async () => {
    await create('ShopClaim', [{ language: 'en-US', text: 'Exported' }], { languages: ['en-US', 'ja'] });
    expect(await exists(path.join(resources, 'ja', 'ShopClaim.ja.label.txt'))).toBe(true);
  });

  it('gives a new label file beside siblings only the supplied languages', async () => {
    const result = await create('ShopNew', [{ language: 'en-US', text: 'Exported' }]);
    expect(result.isError).toBeFalsy();
    expect(await exists(path.join(resources, 'en-US', 'ShopNew.en-US.label.txt'))).toBe(true);
    expect(await exists(path.join(resources, 'ja', 'ShopNew.ja.label.txt'))).toBe(false);
    expect(await exists(path.join(labelDir, 'ShopNew_ja.xml'))).toBe(false);
  });
});
