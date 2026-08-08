/**
 * LABEL_LANGUAGES has to mean the same thing in the registry, the docs and the
 * indexer.
 *
 * It did not: docs/CONFIGURATION.md (generated from src/config/settings.ts)
 * promised `en-US`, while src/metadata/labelParser.ts carried its own
 * 'en-US,cs,sk,de' literal. Nobody who left the setting alone got what the docs
 * said — every unconfigured build indexed four label tables (~125 MB apiece)
 * instead of one, and nothing in the output said so.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { discoverLabelFiles } from '../../src/metadata/labelParser.js';
import { settingByEnv } from '../../src/config/settings.js';

let modelDir: string;
const savedLangs = process.env.LABEL_LANGUAGES;

/** {model}/AxLabelFile/LabelResources/{locale}/{LabelFileId}.{locale}.label.txt */
function writeLabelFile(locale: string): void {
  const dir = join(modelDir, 'AxLabelFile', 'LabelResources', locale);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(join(dir, `DemoLabels.${locale}.label.txt`), 'Hello=Hello\n', 'utf8');
}

beforeEach(() => {
  modelDir = fs.mkdtempSync(join(os.tmpdir(), 'd365fo-labels-'));
  for (const locale of ['en-US', 'cs', 'sk', 'de', 'fi']) writeLabelFile(locale);
  delete process.env.LABEL_LANGUAGES;
});

afterEach(() => {
  fs.rmSync(modelDir, { recursive: true, force: true });
  if (savedLangs === undefined) delete process.env.LABEL_LANGUAGES;
  else process.env.LABEL_LANGUAGES = savedLangs;
});

describe('LABEL_LANGUAGES default', () => {
  it('indexes only en-US when nothing configures it', async () => {
    const found = await discoverLabelFiles(modelDir);
    expect(found.map(f => f.language).sort()).toEqual(['en-US']);
  });

  it('is taken from the setting registry, so the docs table cannot drift from it', () => {
    expect(settingByEnv('LABEL_LANGUAGES')?.default).toEqual(['en-US']);
  });

  it('still honours an explicit list', async () => {
    process.env.LABEL_LANGUAGES = 'en-US,cs,sk,de';
    const found = await discoverLabelFiles(modelDir);
    expect(found.map(f => f.language).sort()).toEqual(['cs', 'de', 'en-US', 'sk']);
  });

  it('still honours LABEL_LANGUAGES=all', async () => {
    process.env.LABEL_LANGUAGES = 'all';
    const found = await discoverLabelFiles(modelDir);
    expect(found.map(f => f.language).sort()).toEqual(['cs', 'de', 'en-US', 'fi', 'sk']);
  });
});
