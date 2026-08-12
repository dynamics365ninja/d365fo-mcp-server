/**
 * The class access modifier — parsed, carried and reported (#902).
 *
 * `parseXppClassHeader` sliced the modifier text off the class line and tested it
 * for exactly two keywords, `abstract` and `final`. The access modifier was read
 * and dropped, and no field could have held it. Two consequences, both measured
 * against Microsoft's WHSEWOutboundShipmentOrderUpdateMessageType:
 *
 *  1. No get_object_info path reported class access, on any of the three routes.
 *     Roughly one AxClass in three in 10.0.2645.90 is `internal` (23,540 of
 *     66,779), and every one of them rendered as `**Final:** Yes` with no access
 *     line — which reads as "subclassing blocked, CoC still available" when the
 *     truth is that a caller outside the owning package cannot reference the type
 *     at all.
 *  2. `extractClassDeclaration` rebuilt the line from the two surviving booleans,
 *     so under a heading reading `## Declaration` the source's `internal final
 *     class …` was printed as `final class …`. Not an omission — a replacement,
 *     with nothing marking the block as a reconstruction.
 *
 * The modifier is reported as a FACT, never as a verdict: whether `internal`
 * blocks the reader depends on which model the reader is writing in, and the
 * `**Model:**` line sits directly above it.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { XppMetadataParser } from '../../src/metadata/xmlParser';
import { parseXppClassHeader } from '../../src/metadata/xppDeclaration';
import { XppSymbolIndex } from '../../src/metadata/symbolIndex';
import { classInfoTool } from '../../src/tools/readers/classInfo';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';

/** The issue's repro, verbatim from the AOT. */
const WHSEW_DECLARATION =
  '[SysMessageTypeFactoryAttribute(SysMessageType::WHSEWOutboundShipmentOrderUpdate)]\n' +
  'internal final class WHSEWOutboundShipmentOrderUpdateMessageType extends WHSEWShipmentOrderUpdateMessageType\n' +
  '{\n}';

let tmpDir: string;

const writeClass = async (name: string, declaration: string, methods: string[] = []) => {
  const xml = [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<AxClass xmlns:i="http://www.w3.org/2001/XMLSchema-instance">',
    `  <Name>${name}</Name>`,
    '  <SourceCode>',
    `    <Declaration><![CDATA[${declaration}]]></Declaration>`,
    '    <Methods>',
    ...methods.map(src => [
      '      <Method>',
      `        <Name>${/\b(\w+)\s*\(/.exec(src)?.[1] ?? 'unknown'}</Name>`,
      `        <Source><![CDATA[${src}]]></Source>`,
      '      </Method>',
    ].join('\n')),
    '    </Methods>',
    '  </SourceCode>',
    '</AxClass>',
  ].join('\n');
  const file = path.join(tmpDir, `${name}.xml`);
  await fs.writeFile(file, xml, 'utf-8');
  return file;
};

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xpp-class-access-'));
});

afterAll(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('parseXppClassHeader reads the access modifier', () => {
  it('reports internal on the class the issue was filed against', () => {
    expect(parseXppClassHeader(WHSEW_DECLARATION)).toMatchObject({
      name: 'WHSEWOutboundShipmentOrderUpdateMessageType',
      extends: 'WHSEWShipmentOrderUpdateMessageType',
      isFinal: true,
      isAbstract: false,
      visibility: 'internal',
    });
  });

  it('reads the other three modifiers, whatever their case', () => {
    expect(parseXppClassHeader('public final class C\n{\n}')?.visibility).toBe('public');
    expect(parseXppClassHeader('PROTECTED abstract class P\n{\n}')?.visibility).toBe('protected');
    expect(parseXppClassHeader('private class Q\n{\n}')?.visibility).toBe('private');
  });

  it('leaves it undefined when the source states none', () => {
    // NOT defaulted to public. The declaration is rebuilt from this header, and a
    // synthesised modifier would print a line the source does not contain.
    expect(parseXppClassHeader('class Plain extends Base\n{\n}')?.visibility).toBeUndefined();
    expect(parseXppClassHeader('interface IThing\n{\n}')?.visibility).toBeUndefined();
  });

  it('is not fooled by an attribute, a comment or the class body', () => {
    expect(parseXppClassHeader('[InternalUseOnlyAttribute]\nclass A\n{\n}')?.visibility).toBeUndefined();
    expect(parseXppClassHeader('// internal helper for posting\nclass B\n{\n}')?.visibility).toBeUndefined();
    expect(parseXppClassHeader('class C\n{\n    protected void m() {}\n}')?.visibility).toBeUndefined();
  });
});

describe('parseClassFile carries the modifier instead of rewriting the line', () => {
  it('rebuilds the declaration the source actually has', async () => {
    const file = await writeClass('WHSEWOutboundShipmentOrderUpdateMessageType', WHSEW_DECLARATION);
    const result = await new XppMetadataParser().parseClassFile(file, 'WarehouseOrdersIntegration');

    expect(result.data?.visibility).toBe('internal');
    expect(result.data?.declaration).toBe(
      'internal final class WHSEWOutboundShipmentOrderUpdateMessageType ' +
      'extends WHSEWShipmentOrderUpdateMessageType',
    );
  });

  it('adds no modifier to a class that declares none', async () => {
    const file = await writeClass('Plain', 'class Plain extends Base\n{\n}');
    const result = await new XppMetadataParser().parseClassFile(file, 'M');

    expect(result.data?.visibility).toBeUndefined();
    expect(result.data?.declaration).toBe('class Plain extends Base');
  });
});

describe('method visibility comes from the declaration, not from a missing XML element', () => {
  it('reports each method as the source declares it', async () => {
    // parseVisibility read <Method><Visibility>, which real AxClass XML has no
    // element for, so every method in the AOT reported public — including the
    // protected ones the issue lists on this very class.
    const file = await writeClass('Visible', 'internal class Visible\n{\n}', [
      'protected void processMessage(str _payload)\n{\n}',
      'private boolean markMessageAsReceived()\n{\n    return true;\n}',
      'internal void markMessageAsFailed()\n{\n}',
      'public str parmId()\n{\n    return id;\n}',
      'void noModifier()\n{\n}',
    ]);
    const result = await new XppMetadataParser().parseClassFile(file, 'M');

    const byName = Object.fromEntries((result.data?.methods ?? []).map(m => [m.name, m.visibility]));
    expect(byName).toEqual({
      processMessage: 'protected',
      markMessageAsReceived: 'private',
      markMessageAsFailed: 'internal',
      parmId: 'public',
      // X++ defaults to public, and the declaration parsed — so this one is read,
      // not assumed.
      noModifier: 'public',
    });
  });

  it('still honours a <Visibility> element when the declaration cannot be parsed', async () => {
    // Synthetic/hand-written XML — the only place the element ever appears.
    const xml = [
      '<?xml version="1.0" encoding="utf-8"?>',
      '<AxClass xmlns:i="http://www.w3.org/2001/XMLSchema-instance">',
      '  <Name>Synthetic</Name>',
      '  <SourceCode>',
      '    <Declaration><![CDATA[class Synthetic\n{\n}]]></Declaration>',
      '    <Methods>',
      '      <Method>',
      '        <Name>doWork</Name>',
      '        <Visibility>protected</Visibility>',
      '        <Source><![CDATA[// body only, no declaration line]]></Source>',
      '      </Method>',
      '    </Methods>',
      '  </SourceCode>',
      '</AxClass>',
    ].join('\n');
    const file = path.join(tmpDir, 'Synthetic.xml');
    await fs.writeFile(file, xml, 'utf-8');

    const result = await new XppMetadataParser().parseClassFile(file, 'M');
    expect(result.data?.methods[0]?.visibility).toBe('protected');
  });
});

describe('the symbol index carries class visibility', () => {
  it('round-trips the column', () => {
    const index: any = new XppSymbolIndex(':memory:', ':memory:');
    index.addSymbol({
      name: 'Scoped', type: 'class', filePath: 'K:\\x\\Scoped.xml', model: 'M', visibility: 'internal',
    });
    index.addSymbol({ name: 'Open', type: 'class', filePath: 'K:\\x\\Open.xml', model: 'M' });

    expect(index.getSymbolByName('Scoped', 'class')?.visibility).toBe('internal');
    // Absent, not 'public': a class indexed without one is indistinguishable from
    // a row written before the column existed.
    expect(index.getSymbolByName('Open', 'class')?.visibility).toBeUndefined();
    index.close?.();
  });
});

/** get_object_info(objectType="class") — all three routes render the same fact. */
describe('get_object_info reports class access', () => {
  const req = (className: string, compact: boolean): CallToolRequest => ({
    method: 'tools/call',
    params: { name: 'get_object_info', arguments: { className, compact } },
  });

  const contextWith = (over: Record<string, any>) => ({
    bridge: undefined,
    parser: new XppMetadataParser(),
    symbolIndex: {
      getSymbolByName: vi.fn(() => undefined),
      getClassMethods: vi.fn(() => []),
      getReadDb: vi.fn(() => ({ prepare: vi.fn(() => ({ all: vi.fn(() => []), get: vi.fn(() => undefined) })) })),
    },
    ...over,
  }) as any;

  it('names it on the XML path, beside the declaration it belongs to', async () => {
    const file = await writeClass('WHSEWRendered', WHSEW_DECLARATION.replace(
      'WHSEWOutboundShipmentOrderUpdateMessageType', 'WHSEWRendered',
    ));
    const context = contextWith({
      symbolIndex: {
        getSymbolByName: vi.fn(() => ({ name: 'WHSEWRendered', filePath: file, model: 'WarehouseOrdersIntegration' })),
        getClassMethods: vi.fn(() => []),
        getReadDb: vi.fn(() => ({ prepare: vi.fn(() => ({ all: vi.fn(() => []), get: vi.fn(() => undefined) })) })),
      },
    });

    const text = (await classInfoTool(req('WHSEWRendered', false), context)).content[0].text as string;
    expect(text).toContain('**Access:** internal');
    expect(text).toContain('internal final class WHSEWRendered');
  });

  it('says public on the XML path when the source declares nothing', async () => {
    const file = await writeClass('OpenClass', 'class OpenClass extends Base\n{\n}');
    const context = contextWith({
      symbolIndex: {
        getSymbolByName: vi.fn(() => ({ name: 'OpenClass', filePath: file, model: 'M' })),
        getClassMethods: vi.fn(() => []),
        getReadDb: vi.fn(() => ({ prepare: vi.fn(() => ({ all: vi.fn(() => []), get: vi.fn(() => undefined) })) })),
      },
    });

    const text = (await classInfoTool(req('OpenClass', false), context)).content[0].text as string;
    // The source was read here, so the X++ default is a fact and not a guess…
    expect(text).toContain('**Access:** public');
    // …but the declaration block still shows the line as written.
    expect(text).toContain('class OpenClass extends Base');
    expect(text).not.toContain('public class OpenClass');
  });

  it('names it on the DB path when the column holds it, and stays silent when it does not', async () => {
    const indexed = (visibility?: string) => contextWith({
      symbolIndex: {
        getSymbolByName: vi.fn(() => ({ name: 'Scoped', filePath: 'K:\\x.xml', model: 'M', visibility })),
        getClassMethods: vi.fn(() => []),
        getReadDb: vi.fn(() => ({ prepare: vi.fn(() => ({ all: vi.fn(() => []), get: vi.fn(() => undefined) })) })),
      },
    });

    const withCol = (await classInfoTool(req('Scoped', true), indexed('internal'))).content[0].text as string;
    expect(withCol).toContain('**Access:** internal');

    // A database built before the column existed answers NULL for every class.
    // That is "not indexed yet", not "public", so the line is simply absent.
    const withoutCol = (await classInfoTool(req('Scoped', true), indexed(undefined))).content[0].text as string;
    expect(withoutCol).not.toContain('**Access:**');
  });

  it('derives it from the declaration on the bridge path', async () => {
    const bridgeContext = (declaration?: string) => contextWith({
      bridge: {
        isReady: true,
        metadataAvailable: true,
        readClass: vi.fn(async () => ({
          name: 'BridgeClass', isAbstract: false, isFinal: true, isStatic: false,
          model: 'WarehouseOrdersIntegration', declaration, methods: [],
        })),
      },
    });

    const internal = (await classInfoTool(
      req('BridgeClass', true),
      bridgeContext('internal final class BridgeClass extends Base'),
    )).content[0].text as string;
    expect(internal).toContain('**Access:** internal');

    const plain = (await classInfoTool(
      req('BridgeClass', true),
      bridgeContext('final class BridgeClass extends Base'),
    )).content[0].text as string;
    expect(plain).toContain('**Access:** public');

    // Nothing to read means nothing is claimed.
    const none = (await classInfoTool(req('BridgeClass', true), bridgeContext(undefined)))
      .content[0].text as string;
    expect(none).not.toContain('**Access:**');
  });
});
