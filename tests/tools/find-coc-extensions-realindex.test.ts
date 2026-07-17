/**
 * find_coc_extensions against a REAL in-memory symbol index, driven through the
 * real extraction pipeline (parseClassFile → buildClassExtensionRecord → JSON →
 * indexMetadataDirectory → tool).
 *
 * Regression (#693): extraction scanned an `AxClassExtension` folder that does
 * not exist in the AOT, so no class-extension row was ever written. Both
 * branches of this tool — extension_metadata.base_object_name and
 * symbols.type='class-extension' — had nothing to match, and the tool returned
 * "No class extensions found" for every class in the AOT.
 *
 * The parser-level tests cover the [ExtensionOf] shapes; this file exists to
 * prove the records actually reach the DB in a shape the tool's SQL matches —
 * the contract that silently broke.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { XppSymbolIndex } from '../../src/metadata/symbolIndex';
import { XppMetadataParser, buildClassExtensionRecord } from '../../src/metadata/xmlParser';
import { findCocExtensionsTool } from '../../src/tools/findCocExtensions';
import type { XppServerContext } from '../../src/types/context';

const MODEL = 'MyCustomModel';

let tmpDir: string;
let index: XppSymbolIndex;
let context: XppServerContext;

/** Write an AxClass XML file the way the AOT stores a class extension. */
const axClassXml = (name: string, declaration: string, methods: Array<{ name: string; source: string }>) => [
  '<?xml version="1.0" encoding="utf-8"?>',
  '<AxClass xmlns:i="http://www.w3.org/2001/XMLSchema-instance">',
  `  <Name>${name}</Name>`,
  '  <SourceCode>',
  `    <Declaration><![CDATA[${declaration}]]></Declaration>`,
  '    <Methods>',
  ...methods.flatMap(m => [
    '      <Method>',
    `        <Name>${m.name}</Name>`,
    `        <Source><![CDATA[${m.source}]]></Source>`,
    '      </Method>',
  ]),
  '    </Methods>',
  '  </SourceCode>',
  '</AxClass>',
].join('\n');

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'coc-ext-'));
  const aotDir = path.join(tmpDir, 'aot');
  const metadataDir = path.join(tmpDir, 'extracted', MODEL, 'class-extensions');
  await fs.mkdir(aotDir, { recursive: true });
  await fs.mkdir(metadataDir, { recursive: true });

  const parser = new XppMetadataParser();

  // Run the same steps extract-metadata runs for each AxClass file: parse it,
  // and when it carries [ExtensionOf(...)], emit a class-extension record.
  const classes = [
    axClassXml(
      'SalesFormLetter_MyExt',
      '[ExtensionOf(classStr(SalesFormLetter))]\nfinal class SalesFormLetter_MyExt\n{\n}',
      [
        { name: 'run', source: 'public void run()\n{\n    next run();\n}' },
        { name: 'myHelper', source: 'public str myHelper()\n{\n    return "x";\n}' },
      ],
    ),
    // Named like an extension but carrying no attribute — must NOT be indexed
    // as a class extension.
    axClassXml('SalesFormLetter_NotAnExtension', 'final class SalesFormLetter_NotAnExtension\n{\n}', []),
    // Extends a DIFFERENT class whose name merely starts with 'SalesFormLetter'.
    // Modelled on the real AOT pair JmgRegistrationForm / JmgRegistrationFormBase.
    axClassXml(
      'SalesFormLetterBase_MyExt',
      '[ExtensionOf(classStr(SalesFormLetterBase))]\nfinal class SalesFormLetterBase_MyExt\n{\n}',
      [{ name: 'openThing', source: 'public void openThing()\n{\n}' }],
    ),
  ];

  for (const xml of classes) {
    const name = /<Name>([^<]+)<\/Name>/.exec(xml)![1];
    const file = path.join(aotDir, `${name}.xml`);
    await fs.writeFile(file, xml, 'utf-8');

    const parsed = await parser.parseClassFile(file, MODEL);
    const record = buildClassExtensionRecord(parsed.data!, MODEL);
    if (record) {
      await fs.writeFile(path.join(metadataDir, `${name}.json`), JSON.stringify(record, null, 2));
    }
  }

  index = new XppSymbolIndex(':memory:', ':memory:');
  await index.indexMetadataDirectory(path.join(tmpDir, 'extracted'));
  context = { symbolIndex: index, bridge: undefined } as unknown as XppServerContext;
});

afterAll(async () => {
  index.close();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

const req = (args: Record<string, unknown>) => ({
  method: 'tools/call' as const,
  params: { name: 'find_coc_extensions', arguments: args },
});

describe('class-extension records reach the index', () => {
  it('writes class-extension rows to symbols and extension_metadata', () => {
    const db = index.getReadDb();

    // Both [ExtensionOf] classes are indexed; the *_NotAnExtension class is not.
    const symbolRows = db.prepare(
      `SELECT name, extends_class FROM symbols WHERE type = 'class-extension' ORDER BY name`,
    ).all() as any[];
    expect(symbolRows.map(r => r.name)).toEqual(['SalesFormLetterBase_MyExt', 'SalesFormLetter_MyExt']);
    expect(symbolRows.find(r => r.name === 'SalesFormLetter_MyExt')).toMatchObject({
      extends_class: 'SalesFormLetter',
    });

    const metaRow = db.prepare(
      `SELECT base_object_name, coc_methods FROM extension_metadata
       WHERE extension_type = 'class-extension' AND extension_name = ?`,
    ).all('SalesFormLetter_MyExt') as any[];
    expect(metaRow).toHaveLength(1);
    expect(metaRow[0].base_object_name).toBe('SalesFormLetter');
    expect(JSON.parse(metaRow[0].coc_methods)).toEqual(['run']);
  });
});

describe('find_coc_extensions with a real index', () => {
  it('finds the class extension and reports the method it wraps', async () => {
    const result = await findCocExtensionsTool(req({ className: 'SalesFormLetter' }), context);
    const text = result.content?.[0]?.text ?? '';

    expect(text).not.toContain('No class extensions found');
    expect(text).toContain('SalesFormLetter_MyExt');
    expect(text).toContain('Wraps methods: run');
    expect(text).toContain('Added methods: myHelper');
  });

  it('filters to a specific wrapped method', async () => {
    const result = await findCocExtensionsTool(
      req({ className: 'SalesFormLetter', methodName: 'run' }),
      context,
    );
    expect(result.content?.[0]?.text ?? '').toContain('SalesFormLetter_MyExt');
  });

  it('does not report a class merely named *_Extension', async () => {
    // The name convention is not the signal — only [ExtensionOf] is.
    const text = (await findCocExtensionsTool(req({ className: 'SalesFormLetter' }), context))
      .content?.[0]?.text ?? '';
    expect(text).not.toContain('SalesFormLetter_NotAnExtension');
  });

  it('still reports nothing for a class that has no extensions', async () => {
    const result = await findCocExtensionsTool(req({ className: 'PurchFormLetter' }), context);
    expect(result.content?.[0]?.text ?? '').toContain('No class extensions found');
  });

  it('does not attribute an extension of a name-prefixed sibling to this class', async () => {
    // SalesFormLetterBase_MyExt extends SalesFormLetterBase, not SalesFormLetter.
    // The old `name LIKE 'SalesFormLetter%_Extension'` fallback swept siblings
    // like this in and reported them as CoC on the wrong base.
    const text = (await findCocExtensionsTool(req({ className: 'SalesFormLetter' }), context))
      .content?.[0]?.text ?? '';
    expect(text).not.toContain('SalesFormLetterBase_MyExt');

    // …and it is still found under the base it actually extends.
    const base = (await findCocExtensionsTool(req({ className: 'SalesFormLetterBase' }), context))
      .content?.[0]?.text ?? '';
    expect(base).toContain('SalesFormLetterBase_MyExt');
  });

  it('resolves a mis-cased base object name', async () => {
    // The name-LIKE fallback used to supply case-insensitivity by accident
    // (SQLite LIKE is case-insensitive for ASCII); dropping it means the tool
    // must canonicalize the caller's name itself.
    const text = (await findCocExtensionsTool(req({ className: 'salesformletter' }), context))
      .content?.[0]?.text ?? '';
    expect(text).toContain('SalesFormLetter_MyExt');
  });
});
