/**
 * The three scaffolds for extending a report that already ships.
 *
 * All four emitted shapes were compiled on the VM (xppc 7.0.7996.33) against
 * AssetBarCodeDP / AssetBarCodeTmp / AssetBarCodeController and
 * SalesInvoiceController, WITH a negative control — a deliberately broken class
 * in the same build — because this repo has been fooled once already by a probe
 * whose method bodies were never compiled. What the tests below pin is the
 * handful of details that make the difference between code that compiles and
 * code that looks right:
 *
 *  • the parameter profile of each handler (a mismatch is a compile error);
 *  • linkPhysicalTableInstance in the bulk shape — without it the handler
 *    updates a different, empty temp table and appears to work;
 *  • the absence of `initArgs`, which the knowledge base used to promise and
 *    which exists nowhere in the SrsReportRunController hierarchy;
 *  • that the accessor is never invented from the table name — the platform's
 *    own AssetBarCodeDP spells its getter `geAssetBarCodeTmp`.
 */
import { describe, expect, it } from 'vitest';

import { codeGenTool } from '../../src/tools/smart/codeGen.js';
import { resolveReportPattern } from '../../src/knowledge/reportPatterns/index.js';

type Result = { content: Array<{ text: string }>; isError?: boolean };

async function generate(args: Record<string, unknown>): Promise<Result> {
  return await codeGenTool(
    { params: { arguments: { modelName: 'ConDemo', ...args } } } as never,
    {} as never,
  ) as Result;
}

async function xpp(args: Record<string, unknown>): Promise<string> {
  const res = await generate(args);
  expect(res.isError, res.content?.[0]?.text).not.toBe(true);
  return res.content[0].text;
}

describe('generate_object(pattern="report-dataset-extension")', () => {
  const base = { pattern: 'report-dataset-extension', name: 'AssetBarCodeDP', baseName: 'AssetBarCodeTmp' };

  it('emits the bulk post-handler when the dataset accessor is known', async () => {
    const text = await xpp({ ...base, datasetAccessor: 'geAssetBarCodeTmp' });

    expect(text).toContain('[PostHandlerFor(classStr(AssetBarCodeDP), methodStr(AssetBarCodeDP, processReport))]');
    // The parameter profile is the whole game: anything but XppPrePostArgs is
    // a compile error, not a runtime surprise.
    expect(text).toContain('(XppPrePostArgs _args)');
    expect(text).toContain('_args.getThis() as AssetBarCodeDP');
    // Load-bearing: a buffer merely declared here is a DIFFERENT, empty table.
    expect(text).toContain('tmpUpdate.linkPhysicalTableInstance(providerRows)');
    expect(text).toContain('dataProvider.geAssetBarCodeTmp()');
    expect(text).toContain('while select forupdate tmpUpdate');
  });

  it('emits the per-row handler when it is NOT, rather than inventing an accessor', async () => {
    const text = await xpp(base);

    expect(text).toContain('[DataEventHandler(tableStr(AssetBarCodeTmp), DataEventType::Inserting)]');
    expect(text).toContain('(Common _sender, DataEventArgs _e)');
    // No accessor may be guessed from the table name — the platform ships
    // "geAssetBarCodeTmp" for AssetBarCodeTmp, and a guess would not compile.
    expect(text).not.toContain('getAssetBarCodeTmp');
    expect(text).not.toContain('linkPhysicalTableInstance');
  });

  it('refuses without the temp table instead of guessing one', async () => {
    const res = await generate({ pattern: 'report-dataset-extension', name: 'AssetBarCodeDP' });
    expect(res.isError).toBe(true);
    // The refusal has to say where the answer lives, or it just costs a turn.
    expect(res.content[0].text).toContain('SRSReportDataSetAttribute');
    expect(res.content[0].text).toContain('get_object_info');
  });

  it('names the metadata half, which no amount of X++ replaces', async () => {
    const text = await xpp(base);
    expect(text).toContain('table-extension');
    expect(text).toContain('AssetBarCodeTmp');
  });
});

describe('generate_object(pattern="report-custom-design")', () => {
  const base = {
    pattern: 'report-custom-design',
    name: 'SalesInvoice',
    baseName: 'SalesInvoiceController',
    documentType: 'SalesOrderInvoice',
    designName: 'Report',
  };

  it('builds main() the way shipped controllers do — and not with initArgs', async () => {
    const text = await xpp(base);

    expect(text).toContain('extends SalesInvoiceController');
    expect(text).toContain('controller.parmArgs(_args)');
    expect(text).toContain('controller.parmReportName(ssrsReportStr(');
    expect(text).toContain('controller.startOperation()');
    // There is no initArgs on SrsReportRunController or anywhere above it.
    // The knowledge base said there was; xppc disagreed.
    expect(text).not.toContain('initArgs');
  });

  it('subscribes to the print-management delegate with the shape it declares', async () => {
    const text = await xpp(base);

    expect(text).toContain(
      '[SubscribesTo(classStr(PrintMgmtDocType), delegateStr(PrintMgmtDocType, getDefaultReportFormatDelegate))]');
    expect(text).toContain('PrintMgmtDocumentType _docType');
    expect(text).toContain('EventHandlerResult    _result');
    expect(text).toContain('case PrintMgmtDocumentType::SalesOrderInvoice:');
  });

  it('carries the design name through instead of hardcoding "Report"', async () => {
    const text = await xpp({ ...base, designName: 'CopyPreprinted' });
    expect(text).toContain('ssrsReportStr(ConDemoSalesInvoice, CopyPreprinted)');
    expect(text).not.toContain(', Report)');
  });

  it('says the report copy must exist first, because nothing compiles until it does', async () => {
    const text = await xpp(base);
    expect(text).toMatch(/[Dd]uplicate/);
    expect(text).toContain('menu-item-output-extension');
  });
});

describe('generate_object(pattern="report-menu-redirect")', () => {
  const base = {
    pattern: 'report-menu-redirect',
    name: 'SalesInvoiceController',
    baseName: 'ConDemoSalesInvoice',
    designName: 'Report',
  };

  it('post-handles the controller\'s static construct()', async () => {
    const text = await xpp(base);

    expect(text).toContain(
      '[PostHandlerFor(classStr(SalesInvoiceController), staticMethodStr(SalesInvoiceController, construct))]');
    expect(text).toContain('(XppPrePostArgs _args)');
    expect(text).toContain('_args.getReturnValue() as SrsReportRunController');
    expect(text).toContain('controller.parmReportName(ssrsReportStr(ConDemoSalesInvoice, Report))');
  });

  it('warns that half the shipped controllers have no construct(), and gives the way out', async () => {
    const text = await xpp(base);
    expect(text).toContain('construct()');
    expect(text).toContain('get_object_info');
    // The menu-item extension works for EVERY report; the caller has to hear
    // about it before spending a build finding out staticMethodStr failed.
    expect(text).toContain('menu-item-output-extension');
  });
});

describe('the scaffolds and the catalog recipes agree', () => {
  it('each recipe scaffolds through the pattern this file tests', async () => {
    for (const [pattern, recipe] of [
      ['report-dataset-extension', 'DatasetExtension'],
      ['report-custom-design', 'CustomDesign'],
      ['report-menu-redirect', 'MenuRedirect'],
    ] as const) {
      const spec = resolveReportPattern(pattern);
      expect(spec?.id, `${pattern} does not resolve to a recipe`).toBe(recipe);
      expect(spec!.scaffold).toContain(`generate_object(mode="pattern", pattern="${pattern}"`);
      // A recipe that names no metadata half would let an agent believe the X++
      // is the whole job; for all three, it is not.
      expect(JSON.stringify(spec!.objects)).toMatch(/Extension|extension/);
    }
  });
});
