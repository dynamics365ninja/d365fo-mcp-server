/**
 * `get_object_info(options.method)` and the types that own methods.
 *
 * The folded get_method accepted `objectType:"class"` only, while get_method
 * itself resolves methods on classes, tables, views and data entities. So
 * `options:{method:"validateWrite"}` on a TABLE — the call anyone writing table
 * CoC makes first — was refused with "only supported for objectType=class", and
 * the refusal named no working alternative.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/tools/readers/getMethod', () => ({
  getMethodTool: vi.fn(async (req: any) => ({
    content: [{
      type: 'text',
      text: `method:${req.params.arguments.className}.${req.params.arguments.methodName}`,
    }],
  })),
}));

import { getObjectInfoTool } from '../../src/tools/readers/getObjectInfo';
import { getMethodTool } from '../../src/tools/readers/getMethod';

const req = (args: Record<string, unknown>): any => ({
  method: 'tools/call',
  params: { name: 'get_object_info', arguments: args },
});

const context = {} as any;

const textOf = (result: any) => result.content.map((c: any) => c.text).join('\n');

describe('get_object_info — options.method owner types', () => {
  for (const objectType of ['class', 'table', 'view', 'data-entity']) {
    it(`reads a method on a ${objectType}`, async () => {
      vi.mocked(getMethodTool).mockClear();

      const result = await getObjectInfoTool(
        req({ objectType, name: 'ConCore_TaxTransReportChangeLog', options: { method: 'validateWrite', include: 'signature' } }),
        context,
      );

      expect(result.isError).toBeFalsy();
      expect(textOf(result)).toContain('method:ConCore_TaxTransReportChangeLog.validateWrite');
      expect(vi.mocked(getMethodTool)).toHaveBeenCalledTimes(1);
    });
  }

  it('still refuses a type that stores no methods, and names the ones that work', async () => {
    const result = await getObjectInfoTool(
      req({ objectType: 'enum', name: 'ConSK_QualityTier', options: { method: 'validateWrite' } }),
      context,
    );

    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toContain('class, table, view, data-entity');
    expect(text).toContain('"enum" stores no methods');
  });

  it('works through the plural objects[] form too', async () => {
    vi.mocked(getMethodTool).mockClear();

    const result = await getObjectInfoTool(
      req({
        objects: [
          { objectType: 'table', objectName: 'MyTable', options: { method: 'validateWrite' } },
          { objectType: 'class', objectName: 'MyClass', options: { method: 'run' } },
        ],
      }),
      context,
    );

    const text = textOf(result);
    expect(text).toContain('method:MyTable.validateWrite');
    expect(text).toContain('method:MyClass.run');
  });
});
