/**
 * `prepare(mode="test")` picks the SHAPE, and hands it to the scaffold.
 *
 * The two halves of the loop have to agree, or the loop is worse than nothing:
 * `prepare` tells the developer which kind of test their target needs, and the
 * call it prints is the one `generate_object` will honour. If `prepare` says
 * "this is a wrapper" and then emits a scaffold that constructs the wrapper, the
 * developer gets a test that compiles, runs, passes, and never reaches `next`.
 *
 * Run against a REAL in-memory index for the same reason `prepare-realindex`
 * does: every signal here is a query, and a mocked DB executes none of them.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { XppSymbolIndex } from '../../src/metadata/symbolIndex';
import { prepareTestTool } from '../../src/tools/prepare/prepareTest';
import type { XppServerContext } from '../../src/types/context';

let index: XppSymbolIndex;
let context: XppServerContext;

const symbol = (over: Record<string, unknown>) => ({
  name: '', type: 'class', filePath: '/x.xml', model: 'ApplicationSuite', ...over,
}) as never;

const prepare = async (objectName: string, goal = 'cover the rules'): Promise<string> => {
  const r = await prepareTestTool({ goal, objectName }, context) as { content: { text: string }[] };
  return r.content[0].text;
};

beforeAll(() => {
  index = new XppSymbolIndex(':memory:', ':memory:');

  index.addSymbol(symbol({ name: 'CustTable', type: 'table' }));
  index.addSymbol(symbol({
    name: 'validateWrite', type: 'method', parentName: 'CustTable', signature: 'boolean validateWrite()',
  }));

  index.addSymbol(symbol({ name: 'FMVehicleDataContract', type: 'class' }));
  index.addSymbol(symbol({
    name: 'carFactsSummary', type: 'method', parentName: 'FMVehicleDataContract',
    signature: 'str carFactsSummary(str _name)',
  }));

  index.addSymbol(symbol({
    name: 'ConDemoBatchService', type: 'class',
    signature: 'public class ConDemoBatchService extends SysOperationServiceBase',
  }));
  index.addSymbol(symbol({
    name: 'calculateEffectiveBatchSize', type: 'method', parentName: 'ConDemoBatchService',
    signature: 'int calculateEffectiveBatchSize(ConDemoBatchContract _contract)',
  }));

  index.addSymbol(symbol({ name: 'ConPriceEngine', type: 'class' }));
  index.addSymbol(symbol({
    name: 'calculateDiscount', type: 'method', parentName: 'ConPriceEngine',
    signature: 'real calculateDiscount(real _amount)',
  }));

  context = { symbolIndex: index, bridge: undefined } as unknown as XppServerContext;
});

afterAll(() => index.close());

describe('shape: coc', () => {
  it('reduces an extension name to its base and asks for the coc shape', async () => {
    const out = await prepare('FMVehicleDataContractCon_Extension');
    expect(out).toContain('testTargetType: "coc"');
    // The scaffold call must name the BASE, not the extension.
    expect(out).toContain('name="FMVehicleDataContract"');
    expect(out).not.toContain('name="FMVehicleDataContractCon_Extension"');
  });

  it('states the rule that makes a CoC test a test of the wrapper', async () => {
    const out = await prepare('FMVehicleDataContractCon_Extension');
    expect(out).toContain('must NOT name the extension class');
    expect(out).toContain('remove the wrapper and the test must fail');
  });

  it('names the test class after the shape', async () => {
    expect(await prepare('FMVehicleDataContractCon_Extension')).toContain('FMVehicleDataContractCocTest');
  });
});

describe('shape: service', () => {
  it('detects a SysOperation service from what it extends', async () => {
    const out = await prepare('ConDemoBatchService');
    expect(out).toContain('testTargetType: "service"');
    expect(out).toContain('baseName: "<the DataContract class>"');
  });

  it('says why the contract is not derived', async () => {
    const out = await prepare('ConDemoBatchService');
    expect(out).toContain('It is not derived');
    expect(out).toContain('{N}DataContract');
  });
});

describe('shape: table and class are unchanged', () => {
  it('still selects the table shape for a table method', async () => {
    const out = await prepare('CustTable.validateWrite');
    expect(out).toContain('testTargetType: "table"');
    expect(out).toContain('assertExpectedInfoLogMessage');
  });

  it('emits no testTargetType for a plain class — "class" is the default', async () => {
    const out = await prepare('ConPriceEngine');
    expect(out).not.toContain('testTargetType');
    expect(out).toContain('ConPriceEngineTest');
  });
});

describe('the two halves agree', () => {
  it('every printed scaffold call is one generate_object accepts', async () => {
    // The published enum is the contract; a shape prepare names but the
    // generator does not know is a call that fails on send.
    const shapes = ['class', 'table', 'coc', 'event-handler', 'service'];
    for (const target of ['CustTable.validateWrite', 'FMVehicleDataContractCon_Extension', 'ConDemoBatchService', 'ConPriceEngine']) {
      const out = await prepare(target);
      const emitted = /testTargetType: "([a-z-]+)"/.exec(out)?.[1];
      if (emitted) expect(shapes, target).toContain(emitted);
    }
  });
});
