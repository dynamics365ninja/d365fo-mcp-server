/**
 * extension_info(mode="points") against a REAL in-memory symbol index built
 * through the real extraction pipeline.
 *
 * Two defects covered, both of which made the tool useless for the exact
 * question it exists to answer ("what can I wrap?"):
 *
 *  1. Eligibility was tested with `signature.includes('public ')`, but
 *     indexClasses builds the signature as `returnType name(params)` with NO
 *     access modifier — so the test could never be true and the tool reported
 *     ZERO CoC-eligible methods for every class in the AOT. Observed on the VM:
 *     SalesFormLetter_Invoice returned 3 blocked methods and nothing else,
 *     despite ~47 public/protected members.
 *
 *  2. Only declared methods were listed, so a leaf class — the kind people
 *     actually extend — showed almost no extension points. CoC can wrap a
 *     method the augmented class only inherits (verified against xppc; see the
 *     class-inheritance knowledge topic), so inherited methods belong here too.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { XppSymbolIndex } from '../../src/metadata/symbolIndex';
import { XppMetadataParser } from '../../src/metadata/xmlParser';
import { analyzeExtensionPointsTool } from '../../src/tools/analyzeExtensionPoints';
import type { XppServerContext } from '../../src/types/context';

const MODEL = 'MyCustomModel';

let tmpDir: string;
let index: XppSymbolIndex;
let context: XppServerContext;

const axClassXml = (
  name: string,
  declaration: string,
  methods: Array<{ name: string; source: string }>,
) => [
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

const CLASSES = [
  axClassXml('P_Base', 'public class P_Base\n{\n}', [
    {
      name: 'wrappableFromBase',
      source: '/// <summary>\n/// Nothing private about this one.\n/// </summary>\npublic void wrappableFromBase()\n{\n}',
    },
    {
      name: 'secretFromBase',
      source: 'private void secretFromBase()\n{\n}',
    },
  ]),
  axClassXml('P_Leaf', 'public class P_Leaf extends P_Base\n{\n}', [
    {
      name: 'ownPublic',
      source: 'public void ownPublic()\n{\n}',
    },
    {
      name: 'ownPrivate',
      source: 'private boolean ownPrivate(int _x)\n{\n    return true;\n}',
    },
  ]),
];

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ext-points-inherit-'));
  const aotDir = path.join(tmpDir, 'aot');
  const metadataDir = path.join(tmpDir, 'extracted', MODEL, 'classes');
  await fs.mkdir(aotDir, { recursive: true });
  await fs.mkdir(metadataDir, { recursive: true });

  const parser = new XppMetadataParser();
  for (const xml of CLASSES) {
    const name = /<Name>([^<]+)<\/Name>/.exec(xml)![1];
    const file = path.join(aotDir, `${name}.xml`);
    await fs.writeFile(file, xml, 'utf-8');
    const parsed = await parser.parseClassFile(file, MODEL);
    await fs.writeFile(
      path.join(metadataDir, `${name}.json`),
      JSON.stringify({ ...parsed.data, sourcePath: file }, null, 2),
    );
  }

  index = new XppSymbolIndex(':memory:', ':memory:');
  await index.indexMetadataDirectory(path.join(tmpDir, 'extracted'));
  context = { symbolIndex: index, parser, bridge: undefined } as unknown as XppServerContext;
});

afterAll(async () => {
  index.close();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

const req = (args: Record<string, unknown>) => ({
  method: 'tools/call' as const,
  params: { name: 'analyze_extension_points', arguments: args },
});

async function pointsFor(objectName: string): Promise<string> {
  const result = await analyzeExtensionPointsTool(
    req({ objectName, objectType: 'class' }),
    context,
  );
  return result.content?.[0]?.text ?? '';
}

describe('extension_info(mode="points") eligibility', () => {
  it('lists a public declared method as CoC-eligible', async () => {
    const text = await pointsFor('P_Leaf');
    expect(text).toMatch(/CoC-eligible methods \(\d+\)/);
    expect(text).toContain('ownPublic()');
  });

  it('does not report zero eligible methods for a class that has them', async () => {
    // The original defect: every class came back with an empty eligible list.
    const text = await pointsFor('P_Base');
    expect(text).toContain('wrappableFromBase()');
    expect(text).not.toMatch(/CoC-eligible methods \(0\)/);
  });

  it('excludes private methods', async () => {
    const text = await pointsFor('P_Leaf');
    const eligibleBlock = text.split('CoC-eligible methods')[1]?.split('\n\n')[0] ?? '';
    expect(eligibleBlock).not.toContain('ownPrivate');
    expect(eligibleBlock).not.toContain('secretFromBase');
  });
});

describe('extension_info(mode="points") inheritance', () => {
  it('includes methods inherited from a base class, marked with their origin', async () => {
    const text = await pointsFor('P_Leaf');
    expect(text).toContain('wrappableFromBase()');
    expect(text).toContain('inherited from P_Base');
  });

  it('explains that an inherited point can be wrapped on either class', async () => {
    const text = await pointsFor('P_Leaf');
    expect(text).toMatch(/affects only it/);
    expect(text).toMatch(/DECLARING class/);
  });

  it('does not mark a class\'s own methods as inherited', async () => {
    const text = await pointsFor('P_Base');
    expect(text).not.toContain('inherited from');
  });
});
