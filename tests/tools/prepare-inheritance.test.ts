/**
 * prepare(mode="change") against an inherited method, on a REAL in-memory
 * symbol index built through the real extraction pipeline.
 *
 * Regression found by running eval case L2-coc-inherited-method on the VM
 * (corpus run 2026-07-28T15). PRs #780/#781/#782 taught get_method,
 * get_method_source, code_completion and extension_info to walk `extends`, but
 * prepare kept probing `parent_name = <objectName>` — declared members only.
 * For SalesFormLetter_Invoice.promptAndRun it answered:
 *
 *     Method signature _(symbol index)_
 *     (not found in symbol index)
 *
 *     CoC eligibility
 *     (could not determine — method not found in symbol index)
 *
 * prepare is the one-call aggregator agents are instructed to START from, so
 * that reads as "the method does not exist" and the CoC path is abandoned
 * before the fixed tools are ever reached — the original bug, surviving on the
 * one surface where it does the most damage.
 *
 * The chain is two levels deep on purpose: a fix that only consults the direct
 * parent still fails the grandparent case.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { XppSymbolIndex } from '../../src/metadata/symbolIndex';
import { XppMetadataParser } from '../../src/metadata/xmlParser';
import { prepareTool } from '../../src/tools/prepare/prepare';
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

// P_Base ◄── P_Mid ◄── P_Leaf — the SalesFormLetter_Invoice shape.
const CLASSES = [
  axClassXml('P_Base', 'public class P_Base\n{\n}', [
    { name: 'grandparentOnly', source: 'public void grandparentOnly(str _reason)\n{\n}' },
  ]),
  axClassXml('P_Mid', 'public class P_Mid extends P_Base\n{\n}', [
    { name: 'parentOnly', source: 'public void parentOnly(int _qty)\n{\n}' },
  ]),
  axClassXml('P_Leaf', 'public class P_Leaf extends P_Mid\n{\n}', [
    { name: 'leafOnly', source: 'public str leafOnly()\n{\n    return "leaf";\n}' },
  ]),
];

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prepare-inherit-'));
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

async function prepareChange(objectName: string, methodName: string): Promise<string> {
  const result = await prepareTool(
    {
      method: 'tools/call' as const,
      params: {
        name: 'prepare',
        arguments: {
          mode: 'change',
          goal: `Add a CoC wrapper for ${objectName}.${methodName}`,
          objectName,
          methodName,
          objectType: 'class',
        },
      },
    },
    context,
  );
  return result.content?.[0]?.text ?? '';
}

describe('prepare(mode="change") resolves inherited methods', () => {
  it('finds a method declared on the DIRECT parent', async () => {
    const text = await prepareChange('P_Leaf', 'parentOnly');
    expect(text).not.toContain('(not found in symbol index)');
    expect(text).toContain('void parentOnly(int _qty)');
    expect(text).toContain('P_Mid');
  });

  it('finds a method declared on the GRANDPARENT (a direct-parent-only fix fails here)', async () => {
    const text = await prepareChange('P_Leaf', 'grandparentOnly');
    expect(text).not.toContain('(not found in symbol index)');
    expect(text).toContain('void grandparentOnly(str _reason)');
    expect(text).toContain('P_Base');
  });

  it('reports CoC eligibility for an inherited method instead of "could not determine"', async () => {
    const text = await prepareChange('P_Leaf', 'grandparentOnly');
    expect(text).not.toContain('could not determine');
    expect(text).toContain('CoC-eligible');
  });

  it('names both wrap targets, since xppc accepts either', async () => {
    const text = await prepareChange('P_Leaf', 'grandparentOnly');
    expect(text).toContain('[ExtensionOf(classStr(P_Leaf))]');
    expect(text).toContain('[ExtensionOf(classStr(P_Base))]');
    // The signature is validated against the DECLARING class whichever is named.
    expect(text).toMatch(/signature must match `P_Base`/);
  });

  it('does not label a declared method as inherited', async () => {
    const text = await prepareChange('P_Leaf', 'leafOnly');
    expect(text).toContain('✅ Method appears CoC-eligible.');
    expect(text).not.toContain('Inherited');
    expect(text).not.toContain('inherited from');
  });

  it('still reports a genuinely absent method as not found', async () => {
    const text = await prepareChange('P_Leaf', 'noSuchMethodAnywhere');
    expect(text).toContain('(not found in symbol index)');
    expect(text).toContain('could not determine');
  });
});
