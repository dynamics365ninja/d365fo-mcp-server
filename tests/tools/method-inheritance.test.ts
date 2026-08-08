/**
 * get_method against an inherited method, on a REAL in-memory symbol index
 * built through the real extraction pipeline (parseClassFile → JSON →
 * indexMetadataDirectory → tool).
 *
 * Regression: every reader behind get_method sees *declared* members only —
 * the bridge reads `Classes.Read(name).Methods`, the XML path parses that one
 * file, SQLite matches `parent_name = <name>`. Nothing walked `extends`, so a
 * method the named class inherits came back as "not found" with no hint that it
 * exists one level up. Verified on the VM before the fix:
 * get_method("SalesFormLetter_Invoice", "promptAndRun") failed even though the
 * direct parent SalesFormLetter declares it.
 *
 * The chain here is two levels deep on purpose — a fix that only consults the
 * direct parent still fails the grandparent case.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { XppSymbolIndex } from '../../src/metadata/symbolIndex';
import { XppMetadataParser } from '../../src/metadata/xmlParser';
import { getMethodSignatureTool } from '../../src/tools/knowledge/methodSignature';
import { getMethodSourceTool } from '../../src/tools/readers/getMethodSource';
import { inheritanceAncestors, findDeclaringAncestor } from '../../src/utils/inheritanceChain';
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

// C_Base ◄── B_Mid ◄── A_Leaf, each declaring one method of its own.
const CLASSES = [
  axClassXml('C_Base', 'public class C_Base\n{\n}', [
    { name: 'baseOnly', source: 'public boolean baseOnly(str _reason)\n{\n    return true;\n}' },
    { name: 'overridden', source: 'public int overridden()\n{\n    return 1;\n}' },
  ]),
  axClassXml('B_Mid', 'public class B_Mid extends C_Base\n{\n}', [
    { name: 'midOnly', source: 'public void midOnly(int _qty)\n{\n}' },
  ]),
  axClassXml('A_Leaf', 'public class A_Leaf extends B_Mid\n{\n}', [
    { name: 'leafOnly', source: 'public str leafOnly()\n{\n    return "leaf";\n}' },
    { name: 'overridden', source: 'public int overridden()\n{\n    return 2;\n}' },
  ]),
];

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'method-inherit-'));
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
    // sourcePath is what the indexer stores as file_path, and it is the file the
    // XML fallback re-parses — it must point at the AxClass XML, not the JSON.
    await fs.writeFile(
      path.join(metadataDir, `${name}.json`),
      JSON.stringify({ ...parsed.data, sourcePath: file }, null, 2),
    );
  }

  index = new XppSymbolIndex(':memory:', ':memory:');
  await index.indexMetadataDirectory(path.join(tmpDir, 'extracted'));
  // No bridge: the XML fallback is the reader under test, which is also the
  // configuration the tools run in off-VM.
  context = { symbolIndex: index, parser, bridge: undefined } as unknown as XppServerContext;
});

afterAll(async () => {
  index.close();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

const sigReq = (args: Record<string, unknown>) => ({
  method: 'tools/call' as const,
  params: { name: 'get_method_signature', arguments: args },
});
const srcReq = (args: Record<string, unknown>) => ({
  method: 'tools/call' as const,
  params: { name: 'get_method_source', arguments: args },
});

describe('inheritance chain helpers', () => {
  it('walks past the direct parent', () => {
    expect(inheritanceAncestors(index.getReadDb(), 'A_Leaf')).toEqual(['B_Mid', 'C_Base']);
  });

  it('canonicalizes a mis-cased start name', () => {
    expect(inheritanceAncestors(index.getReadDb(), 'a_leaf')).toEqual(['B_Mid', 'C_Base']);
  });

  it('returns [] for a class with no base', () => {
    expect(inheritanceAncestors(index.getReadDb(), 'C_Base')).toEqual([]);
  });

  it('locates the nearest ancestor declaring a method', () => {
    const db = index.getReadDb();
    expect(findDeclaringAncestor(db, 'A_Leaf', 'midOnly')).toBe('B_Mid');
    expect(findDeclaringAncestor(db, 'A_Leaf', 'baseOnly')).toBe('C_Base');
    // Declared on A_Leaf itself — ancestors are not consulted for it here, but
    // C_Base also declares it, so "nearest ancestor" must be reported honestly.
    expect(findDeclaringAncestor(db, 'A_Leaf', 'overridden')).toBe('C_Base');
    expect(findDeclaringAncestor(db, 'A_Leaf', 'noSuchMethod')).toBeUndefined();
  });
});

describe('get_method(include="signature") on inherited methods', () => {
  it('finds a method declared on the direct parent', async () => {
    const result = await getMethodSignatureTool(
      sigReq({ className: 'A_Leaf', methodName: 'midOnly' }),
      context,
    );
    const text = result.content?.[0]?.text ?? '';
    expect(result.isError).toBeFalsy();
    expect(text).toContain('void midOnly(int _qty)');
    expect(text).toContain('Inherited method');
    expect(text).toContain('B_Mid');
  });

  it('finds a method declared two levels up', async () => {
    const result = await getMethodSignatureTool(
      sigReq({ className: 'A_Leaf', methodName: 'baseOnly' }),
      context,
    );
    const text = result.content?.[0]?.text ?? '';
    expect(result.isError).toBeFalsy();
    expect(text).toContain('boolean baseOnly(str _reason)');
    expect(text).toContain('C_Base');
  });

  // Both [ExtensionOf] targets compile — verified against xppc on the VM by
  // wrapping an inherited method from a subclass extension. The wrapper binds
  // to the base declaration: breaking its signature makes the compiler report
  // "The augmented class 'ConZzInhBase' provides a method by this name, but
  // ... the parameter profile does not match", naming the DECLARING class even
  // though [ExtensionOf] named the subclass. So the output must present the
  // target as a scope choice, not steer to the base.
  it('offers both CoC targets and does not steer away from the subclass', async () => {
    const result = await getMethodSignatureTool(
      sigReq({ className: 'A_Leaf', methodName: 'baseOnly', includeCocTemplate: true }),
      context,
    );
    const text = result.content?.[0]?.text ?? '';
    expect(text).toContain('classStr(A_Leaf)');
    expect(text).toContain('classStr(C_Base)');
    expect(text).toMatch(/every.*subclass/i);
  });

  it('prefers the class itself over an ancestor that also declares the method', async () => {
    const result = await getMethodSignatureTool(
      sigReq({ className: 'A_Leaf', methodName: 'overridden' }),
      context,
    );
    const text = result.content?.[0]?.text ?? '';
    expect(text).toContain('A_Leaf.overridden');
    expect(text).not.toContain('Inherited method');
  });

  it('still reports a method that exists nowhere in the chain', async () => {
    const result = await getMethodSignatureTool(
      sigReq({ className: 'A_Leaf', methodName: 'noSuchMethod' }),
      context,
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/not found/i);
  });
});

describe('get_method(include="source") on inherited methods', () => {
  it('returns the declaring class source, annotated', async () => {
    const result = await getMethodSourceTool(
      srcReq({ className: 'A_Leaf', methodName: 'baseOnly' }),
      context,
    );
    const text = result.content?.[0]?.text ?? '';
    expect(result.isError).toBeFalsy();
    expect(text).toContain('return true;');
    expect(text).toContain('Inherited method');
    expect(text).toContain('C_Base');
    // The heading still names the class the source actually came from.
    expect(text.split('\n')[0]).toContain('C_Base.baseOnly');
  });

  it('does not annotate a method the class declares itself', async () => {
    const result = await getMethodSourceTool(
      srcReq({ className: 'A_Leaf', methodName: 'leafOnly' }),
      context,
    );
    const text = result.content?.[0]?.text ?? '';
    expect(result.isError).toBeFalsy();
    expect(text).toContain('return "leaf";');
    expect(text).not.toContain('Inherited method');
  });

  it('still errors for a method that exists nowhere in the chain', async () => {
    const result = await getMethodSourceTool(
      srcReq({ className: 'A_Leaf', methodName: 'noSuchMethod' }),
      context,
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/not found/i);
  });
});
