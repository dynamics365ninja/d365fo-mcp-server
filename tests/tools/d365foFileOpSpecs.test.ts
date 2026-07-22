/**
 * d365fo_file op-spec registry tests — the registry is the single source of
 * truth for modify-op parameters now that the published schema only advertises
 * a free-form `params` object. These tests guard:
 *   1. registry ↔ published `operation` enum stay in sync,
 *   2. every referenced param has a name/type/description entry,
 *   3. renderOpSpec produces the complete, actionable spec used in errors.
 */

import { describe, it, expect } from 'vitest';
import {
  D365FO_FILE_OP_SPECS,
  D365FO_FILE_PARAM_SPECS,
  OP_PARAM_ALIASES,
  getRequiredParams,
  renderOpSpec,
} from '../../src/tools/d365foFileOpSpecs';
import { d365foFileTool as d365foFileSchema } from '../../src/server/toolSchemas/d365foFile';

describe('d365fo_file op-spec registry', () => {
  it('covers exactly the operations published in the d365fo_file schema enum', () => {
    const publishedOps: string[] =
      (d365foFileSchema.inputSchema.properties as any).operation.enum;
    expect(new Set(Object.keys(D365FO_FILE_OP_SPECS))).toEqual(new Set(publishedOps));
    expect(publishedOps).toHaveLength(27);
  });

  it('every required/optional param has a param-spec entry with type and description', () => {
    for (const [op, spec] of Object.entries(D365FO_FILE_OP_SPECS)) {
      for (const param of [...spec.required, ...spec.optional]) {
        const p = D365FO_FILE_PARAM_SPECS[param];
        expect(p, `op '${op}' references param '${param}' with no spec entry`).toBeDefined();
        expect(p.type.length, `param '${param}' has an empty type`).toBeGreaterThan(0);
        expect(p.description.length, `param '${param}' has an empty description`).toBeGreaterThan(0);
      }
    }
  });

  it('alias params also have spec entries', () => {
    for (const aliases of Object.values(OP_PARAM_ALIASES)) {
      for (const alias of aliases) {
        expect(D365FO_FILE_PARAM_SPECS[alias], `alias '${alias}' has no spec entry`).toBeDefined();
      }
    }
  });

  it('getRequiredParams matches the pre-registry paramHints behaviour', () => {
    expect(getRequiredParams('add-method')).toEqual(['methodName', 'sourceCode']);
    expect(getRequiredParams('replace-code')).toEqual(['oldCode', 'newCode']);
    expect(getRequiredParams('add-index')).toEqual(['indexName', 'indexFields']);
    expect(getRequiredParams('modify-property')).toEqual(['propertyPath', 'propertyValue']);
    expect(getRequiredParams('nonexistent-op')).toEqual([]);
  });

  it('renderOpSpec emits names, types, descriptions and required markers', () => {
    const spec = renderOpSpec('add-index');
    expect(spec).toContain("operation 'add-index'");
    expect(spec).toContain('REQUIRED indexName (string)');
    expect(spec).toContain('REQUIRED indexFields (array of { fieldName, direction? ("Asc"|"Desc") })');
    expect(spec).toContain('optional indexAllowDuplicates (boolean)');
    expect(spec).toContain('default: false = unique');
  });

  it('renderOpSpec surfaces aliases and op notes', () => {
    const spec = renderOpSpec('add-method');
    expect(spec).toContain('(alias: methodCode)');
    expect(spec).toContain('Note:');
    expect(spec).toContain('updates in place');
  });

  it('renderOpSpec lists valid operations for an unknown op', () => {
    const spec = renderOpSpec('add-widget');
    expect(spec).toContain("Unknown operation 'add-widget'");
    expect(spec).toContain('add-method');
    expect(spec).toContain('modify-property');
  });
});
