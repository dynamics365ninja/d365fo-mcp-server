/**
 * A create that lands on an existing object must name the call the caller
 * actually wants.
 *
 * It used to answer with three generic retry options — "pass overwrite=true",
 * "use d365fo_file(action=\"modify\") to make targeted changes", "choose a
 * different objectName" — and none of them is what the caller is after, which is
 * to apply the entries it just passed to the object that is already there.
 * Naming `modify` without its operations still costs a discovery round trip,
 * because the operation spelling is NOT the create spelling: an EDT is
 * `fieldType` on modify but `edt` on create, an index's fields are objects not
 * strings, an enum-typed field takes `fieldEnumType` and no `fieldType` at all.
 * So the translation happens where both spellings are known, and the answer is
 * one copy-paste instead of one more call.
 */

import { describe, it, expect } from 'vitest';
import { renderEquivalentModifyCall } from '../../src/tools/write/createD365File';

/** The operations[] array out of the rendered call, parsed back into objects. */
function opsOf(rendered: string): any[] {
  const m = rendered.match(/operations=(\[.*\])\)/s);
  expect(m, `no operations[] in:\n${rendered}`).toBeTruthy();
  return JSON.parse(m![1]);
}

describe('renderEquivalentModifyCall', () => {
  it('translates create field specs into add-field operations in the MODIFY spelling', () => {
    const out = renderEquivalentModifyCall('table', 'ConProbeTable', {
      properties: {
        fields: [
          { name: 'ProbeId', type: 'String', edt: 'Name', mandatory: true, label: 'Probe' },
          { name: 'IsEnabled', enumType: 'NoYes' },
          { name: 'Counter', type: 'Integer' },
        ],
      },
    });

    expect(out).toContain('d365fo_file(action="modify", objectType="table", objectName="ConProbeTable"');
    const ops = opsOf(out);

    // `fieldType` on modify is the EDT — the base-type keyword create takes as
    // `type` is `fieldBaseType` there, and getting that backwards is the whole
    // reason this translation is not left to the caller.
    expect(ops[0]).toEqual({
      operation: 'add-field', fieldName: 'ProbeId', fieldType: 'Name',
      fieldMandatory: true, fieldLabel: 'Probe',
    });
    // An enum field is an AxTableFieldEnum: fieldEnumType and NO fieldType.
    expect(ops[1]).toEqual({ operation: 'add-field', fieldName: 'IsEnabled', fieldEnumType: 'NoYes' });
    expect(ops[2]).toEqual({ operation: 'add-field', fieldName: 'Counter', fieldBaseType: 'Integer' });
  });

  it('turns string index fields into the object form add-index requires', () => {
    const ops = opsOf(renderEquivalentModifyCall('table', 'ConProbeTable', {
      properties: {
        indexes: [{ name: 'ProbeIdx', fields: ['ProbeId'], allowDuplicates: false, alternateKey: true }],
      },
    }));

    expect(ops).toEqual([{
      operation: 'add-index', indexName: 'ProbeIdx',
      indexFields: [{ fieldName: 'ProbeId' }],
      indexAllowDuplicates: false, indexAlternateKey: true,
    }]);
  });

  it('covers field groups, relations and enum values too', () => {
    const ops = opsOf(renderEquivalentModifyCall('table', 'ConProbeTable', {
      properties: {
        fieldGroups: [{ name: 'Overview', fields: ['ProbeId'] }],
        relations: [{ name: 'ConProbeRel', relatedTable: 'CustTable' }],
        enumValues: [{ name: 'Gold', label: 'Gold tier', value: 2 }],
      },
    }));

    expect(ops).toContainEqual({ operation: 'add-field-group', fieldGroupName: 'Overview', fieldGroupFields: ['ProbeId'] });
    expect(ops).toContainEqual({ operation: 'add-relation', relationName: 'ConProbeRel', relatedTable: 'CustTable' });
    expect(ops).toContainEqual({ operation: 'add-enum-value', enumValueName: 'Gold', enumValueLabel: 'Gold tier', enumValueInt: 2 });
  });

  it('names each method but does NOT re-emit its X++', () => {
    const out = renderEquivalentModifyCall('class', 'ConProbeClass', {
      sourceCode: 'public class ConProbeClass\n{\n}\n\npublic void run()\n{\n    info("hello from the probe");\n}\n',
    });
    const ops = opsOf(out);

    expect(ops).toContainEqual({
      operation: 'add-method', methodName: 'run', sourceCode: '<the X++ you passed for run>',
    });
    // The caller is holding the source it just passed; inlining a whole class
    // into a response that is then re-billed on every later request is the cost
    // this whole change exists to remove.
    expect(out).not.toContain('hello from the probe');
  });

  it('renders scalar properties with the ELEMENT name modify-property wants', () => {
    const ops = opsOf(renderEquivalentModifyCall('table', 'ConProbeTable', {
      properties: { label: 'Probe table', cacheLookup: 'Found', someNestedThing: { a: 1 } },
    }));

    // propertyPath is the XML element name, not the camelCase create key.
    expect(ops).toContainEqual({ operation: 'modify-property', propertyPath: 'Label', propertyValue: 'Probe table' });
    expect(ops).toContainEqual({ operation: 'modify-property', propertyPath: 'CacheLookup', propertyValue: 'Found' });
    expect(ops.some(o => String(o.propertyPath).toLowerCase() === 'somenestedthing')).toBe(false);
  });

  // A call that fails is worse than no call: these create keys have no
  // propertyPath spelling at all — dataSource on a query builds a whole
  // <DataSources> collection, pattern on a form picks a template.
  it('does NOT invent a modify-property for create-only construction keys', () => {
    expect(renderEquivalentModifyCall('query', 'ConProbeQry', {
      properties: { dataSource: 'CustTable' },
    })).toBe('');
    expect(renderEquivalentModifyCall('form', 'ConProbeForm', {
      properties: { pattern: 'SimpleList', formTemplate: 'SimpleListDetails' },
    })).toBe('');
  });

  it('says nothing when the create carried nothing to apply', () => {
    expect(renderEquivalentModifyCall('table', 'ConProbeTable', {})).toBe('');
    expect(renderEquivalentModifyCall('table', 'ConProbeTable', { properties: { fields: [] } })).toBe('');
  });
});
