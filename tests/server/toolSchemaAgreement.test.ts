/**
 * The PUBLISHED tool schema and the handler's own schema must agree.
 *
 * A tool has two descriptions of its arguments: `src/server/toolSchemas/*.ts`,
 * which is what ListTools sends to the client and therefore what an agent can
 * actually choose from, and the zod schema in the handler, which is what the
 * call is validated against. Nothing tied them together.
 *
 * That bit immediately. #983 was filed because `prepare` refused the only name an
 * enum extension can have while `d365fo_file` published `enum-extension` happily
 * — two tools disagreeing about what exists. The fix added the extension types to
 * prepareCreate's ZOD schema and its tests passed, because they call the handler
 * directly. The published schema still did not list them, so the handler accepted
 * a value the tool list never offered: the same disagreement, one level up, and
 * invisible until the MCP server was reconnected and its real schema read back.
 *
 * These tests compare the two enums directly. They are deliberately about the
 * arguments an agent PICKS FROM — a published enum missing a value the handler
 * accepts is a capability nobody can reach.
 */
import { describe, it, expect } from 'vitest';
import { prepareTool } from '../../src/server/toolSchemas/prepare';
import { validateCodeTool } from '../../src/server/toolSchemas/validateCode';
import { prepareCreateArgsSchema } from '../../src/tools/prepare/prepareCreate';
import { prepareChangeArgsSchema } from '../../src/tools/prepare/prepareChange';
import { validateXppArgsSchema } from '../../src/tools/analysis/validateXpp';

/** The string values of a zod enum field, however it is wrapped (optional/default). */
function zodEnumValues(field: unknown): string[] {
  let def = (field as { _def?: Record<string, unknown> })._def;
  while (def && !def.values && !def.entries) {
    const inner = (def.innerType ?? def.schema) as { _def?: Record<string, unknown> } | undefined;
    if (!inner?._def) break;
    def = inner._def;
  }
  const values = (def?.values ?? def?.entries) as string[] | Record<string, string> | undefined;
  if (!values) throw new Error('not a zod enum');
  return Array.isArray(values) ? [...values] : Object.values(values);
}

const publishedEnum = (tool: { inputSchema: any }, prop: string): string[] =>
  tool.inputSchema.properties[prop].enum;

describe('published tool schema vs handler schema', () => {
  it('prepare publishes every objectType its handlers accept', () => {
    const published = new Set(publishedEnum(prepareTool, 'objectType'));
    const accepted = new Set([
      ...zodEnumValues(prepareCreateArgsSchema.shape.objectType),
      ...zodEnumValues(prepareChangeArgsSchema.shape.objectType),
    ]);
    const unreachable = [...accepted].filter(v => !published.has(v)).sort();
    expect(
      unreachable,
      'These objectTypes are accepted by the handler but absent from the tool list, so no agent ' +
      'can choose them — a capability that exists and cannot be reached.',
    ).toEqual([]);
  });

  it('prepare does not advertise an objectType its handlers would reject', () => {
    const accepted = new Set([
      ...zodEnumValues(prepareCreateArgsSchema.shape.objectType),
      ...zodEnumValues(prepareChangeArgsSchema.shape.objectType),
    ]);
    const rejected = publishedEnum(prepareTool, 'objectType').filter(v => !accepted.has(v)).sort();
    expect(rejected, 'Advertised in the tool list but rejected on arrival.').toEqual([]);
  });

  it('validate_code publishes exactly the codeTypes its handler accepts', () => {
    expect(publishedEnum(validateCodeTool, 'codeType').sort())
      .toEqual(zodEnumValues(validateXppArgsSchema.shape.codeType).sort());
  });

  it('specifically: the extension types #983 added are reachable from the tool list', () => {
    const published = publishedEnum(prepareTool, 'objectType');
    for (const t of ['enum-extension', 'table-extension', 'form-extension', 'edt-extension', 'class-extension']) {
      expect(published, t).toContain(t);
    }
  });
});
