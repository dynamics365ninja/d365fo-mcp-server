/**
 * The six SysTest shapes, and why they are not interchangeable.
 *
 * Each observes the behaviour somewhere different, and using the wrong one
 * produces a test that compiles, runs, passes, and proves nothing:
 *
 *  - a CoC test that names the `_Extension` class exercises the wrapper in
 *    isolation and passes with `next` never reached;
 *  - a table rule answers with a boolean and explains through the infolog, so
 *    `new X()` and "expect an exception" find nothing;
 *  - an event handler cannot return a value, so only performing the write shows it;
 *  - a service reached through its controller drags in a dialog and the batch
 *    queue, which is neither fast nor deterministic;
 *  - a report tested through its controller asks the SSRS renderer a question,
 *    when the X++ half ends at the staged rows.
 *
 * Three of the five shapes are promoted from SysTests that actually EXECUTED on
 * the VM under SysTestConsole (`eval/systests/L2-coc-extension.xml`,
 * `L2-event-handler-basic.xml`, `L3-batch-basic.xml`, 2026-08-31, 2/2 each), so
 * these assertions pin shapes that ran rather than shapes that were imagined.
 */

import { describe, expect, it } from 'vitest';
import { codeGenTool } from '../../src/tools/smart/codeGen';

const generate = async (args: Record<string, unknown>): Promise<string> => {
  const r = await codeGenTool({
    params: { arguments: { mode: 'pattern', pattern: 'systest', ...args } },
  } as never) as { content: { text: string }[] };
  return r.content[0].text;
};

describe('systest kind: coc', () => {
  it('targets the BASE class and never the wrapper', async () => {
    const out = await generate({
      name: 'FMVehicleDataContract', testTargetType: 'coc', testMethods: ['carFactsSummary'],
    });
    expect(out).toContain('class FMVehicleDataContractCocTest extends SysTestCase');
    expect(out).toContain('[SysTestTarget(classStr(FMVehicleDataContract), UtilElementType::Class)]');
    expect(out).toContain('new FMVehicleDataContract()');
    // The whole point: no reference to an extension class anywhere.
    expect(out).not.toMatch(/_Extension\s*\(/);
    expect(out).not.toContain('ExtensionOf');
  });

  it('generates the second input that proves `next` was reached', async () => {
    // A wrapper that ignores `next` and returns a constant passes a single
    // assertion. Two inputs are what make the test a test of the wrapper.
    const out = await generate({
      name: 'FMVehicleDataContract', testTargetType: 'coc', testMethods: ['carFactsSummary'],
    });
    expect(out).toContain('testCarFactsSummaryIsWrapped');
    expect(out).toContain('testCarFactsSummaryPreservesBaseValueForDifferentInput');
  });
});

describe('systest kind: event-handler', () => {
  it('performs the write, because a handler returns nothing', async () => {
    const out = await generate({
      name: 'ConDemoNoteHeader', testTargetType: 'event-handler', testMethods: ['inserting'],
    });
    expect(out).toContain('class ConDemoNoteHeaderEventTest extends SysTestCase');
    expect(out).toContain('[SysTestTarget(tableStr(ConDemoNoteHeader), UtilElementType::Table)]');
    expect(out).toContain('conDemoNoteHeader.insert();');
  });

  it('generates the "explicit value is preserved" half', async () => {
    // Without it, a handler that overwrites unconditionally passes.
    const out = await generate({
      name: 'ConDemoNoteHeader', testTargetType: 'event-handler', testMethods: ['inserting'],
    });
    expect(out).toContain('testInsertingAppliesTheRule');
    expect(out).toContain('testInsertingPreservesAnExplicitValue');
  });
});

describe('systest kind: service', () => {
  it('builds the contract by hand and calls the service directly', async () => {
    const out = await generate({
      name: 'ConDemoBatchService', testTargetType: 'service',
      baseName: 'ConDemoBatchContract', testMethods: ['calculateEffectiveBatchSize'],
    });
    expect(out).toContain('new ConDemoBatchContract()');
    expect(out).toContain('new ConDemoBatchService()');
    // No controller, no dialog, no batch queue.
    expect(out).not.toContain('Controller');
    expect(out).not.toContain('SysOperationServiceController');
  });

  it('takes the contract as a parameter rather than deriving it', async () => {
    // The scaffold emits `{N}DataContract`; hand-written services commonly use
    // `{N}Contract`. Deriving it names a class that does not exist.
    const named = await generate({
      name: 'ConDemoBatchService', testTargetType: 'service', baseName: 'ConDemoWeirdlyNamedContract',
    });
    expect(named).toContain('new ConDemoWeirdlyNamedContract()');
    expect(named).toContain('Pass `baseName` to name a different one');
  });
});

describe('systest kinds — the shapes stay distinct', () => {
  it('table still emits the buffer shape, not the class shape', async () => {
    const out = await generate({
      name: 'CustTable', testTargetType: 'table', testMethods: ['validateWrite'],
    });
    expect(out).toContain('custTable.initValue();');
    expect(out).toContain('assertExpectedInfoLogMessage');
    expect(out).not.toContain('new CustTable()');
  });

  it('class remains the default when no kind is given', async () => {
    const out = await generate({ name: 'ConPriceEngine', testMethods: ['calculate'] });
    expect(out).toContain('class ConPriceEngineTest extends SysTestCase');
    expect(out).toContain('new ConPriceEngine()');
  });

  it('every kind is red on arrival', async () => {
    for (const kind of ['class', 'table', 'coc', 'event-handler', 'service', 'report-dp']) {
      const out = await generate({ name: 'ConThing', testTargetType: kind, testMethods: ['doIt'] });
      expect(out, kind).toMatch(/this\.fail\(/);
      expect(out, kind).toContain('Every test fails as written');
    }
  });

  it('never promises a run_systest_class parameter that does not exist', async () => {
    // The scaffold text once told the caller to pass `expectRed=true`, which was
    // never published — a strict MCP client drops undeclared top-level keys, so
    // the instruction could not be followed. The red-phase signal is derived by
    // the runner instead; nothing here may ask for a flag.
    const out = await generate({ name: 'ConThing', testTargetType: 'coc', testMethods: ['doIt'] });
    expect(out).not.toContain('expectRed');
  });
});

/**
 * The report-dp shape.
 *
 * A report has two halves and only one is testable here: the X++ half ends when
 * the provider has staged its rows, and everything after that is RDL. So the
 * test drives the provider directly — contract, `processReport()`, dataset
 * getter — which is the same boundary the framework uses.
 *
 * Compiler-verified before the template was written (probe `coverage-v4g.ts`):
 * `processReport()` is callable from outside, and the dataset getter returns the
 * temp-table buffer.
 */
describe('systest kind: report-dp', () => {
  it('drives the provider directly, with no controller', async () => {
    const out = await generate({
      name: 'ConDemoNoteReportDP', testTargetType: 'report-dp',
      baseName: 'ConDemoNoteReportContract', datasetAccessor: 'getConDemoNoteReportTmp',
      testMethods: ['processReport'],
    });
    expect(out).toContain('new ConDemoNoteReportContract()');
    expect(out).toContain('dp.parmDataContract(contract)');
    expect(out).toContain('dp.processReport();');
    expect(out).toContain('dp.getConDemoNoteReportTmp()');
    expect(out).not.toContain('SrsReportRunController');
  });

  it('takes the dataset getter as a parameter rather than deriving it', async () => {
    // `SrsReportDataProviderBase` has eleven members and none is a `getTmp*` —
    // the getter is developer-written, and the platform itself ships a mis-typed
    // one (`geAssetBarCodeTmp`), so a derived name is a coin flip.
    const out = await generate({
      name: 'ConWeirdDP', testTargetType: 'report-dp',
      baseName: 'ConWeirdContract', datasetAccessor: 'geConWeirdlyNamedTmp',
    });
    expect(out).toContain('dp.geConWeirdlyNamedTmp()');
  });

  it('generates the empty case beside the positive one', async () => {
    // A provider that stages rows unconditionally passes the positive test alone.
    const out = await generate({
      name: 'ConDemoNoteReportDP', testTargetType: 'report-dp',
      baseName: 'ConDemoNoteReportContract', testMethods: ['processReport'],
    });
    expect(out).toContain('testProcessReportStagesRows');
    expect(out).toContain('testProcessReportStagesNothingWhenThereIsNoData');
  });

  it('says what a SysTest cannot reach', async () => {
    const out = await generate({ name: 'ConDemoNoteReportDP', testTargetType: 'report-dp' });
    expect(out).toContain('Report Designer');
  });
});
