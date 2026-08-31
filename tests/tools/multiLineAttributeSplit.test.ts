/**
 * A multi-line attribute block must survive the class-source split.
 *
 * `d365fo_file(action="create", objectType="class")` silently dropped one. The
 * backwards walk that collects the `[Attribute]` and `///` lines above a method
 * tested each line in isolation, so it stopped at the CONTINUATION line of a
 * block like
 *
 *     [DataMemberAttribute('Query'),
 *      AifQueryTypeAttribute('_packedQuery', queryStr(MyQuery))]
 *
 * and the member-variable collector then skipped both lines — one starts with
 * '[', the other does not end in ';'. Nothing was reported, and the class
 * compiled clean, because attributes are syntactically optional. The result is a
 * data contract with no data members: green build, no dialog fields, no error.
 *
 * It reached a committed golden this way — L3-sysoperation-dialog-attributes
 * lost all five of the attributes its own README says it demonstrates — and only
 * an eval run comparing intent to output caught it.
 */
import { describe, expect, it } from 'vitest';
import { XmlTemplateGenerator } from '../../src/tools/xml/xmlTemplateGenerator.js';

const split = (src: string) => XmlTemplateGenerator.splitXppClassSource(src);
const sourceOf = (src: string, method: string) =>
  split(src).methods.find(m => m.name === method)?.source ?? '';

const CONTRACT = `[DataContractAttribute]
public class MyDemoContract
{
    private str packedQuery;
    private CustGroupId custGroup;

    [DataMemberAttribute('SingleLine')]
    public CustGroupId parmCustGroup(CustGroupId _custGroup = custGroup)
    {
        custGroup = _custGroup;
        return custGroup;
    }

    [DataMemberAttribute('Query'),
     AifQueryTypeAttribute('_packedQuery', queryStr(MyDemoQuery))]
    public str parmQuery(str _packedQuery = packedQuery)
    {
        packedQuery = _packedQuery;
        return packedQuery;
    }

    /// <summary>
    /// Three attributes, over three lines, with a doc comment above them.
    /// </summary>
    [SysOperationGroupMemberAttribute('Filters'),
     SysOperationDisplayOrderAttribute('1'),
     SysOperationLabelAttribute(literalStr("@SYS1"))]
    public boolean parmIncludeBlocked(boolean _v = false)
    {
        return _v;
    }
}`;

describe('splitXppClassSource — attribute blocks that span lines', () => {
  it('keeps a single-line attribute (it always did)', () => {
    expect(sourceOf(CONTRACT, 'parmCustGroup')).toContain("[DataMemberAttribute('SingleLine')]");
  });

  it('keeps BOTH lines of a two-line attribute block', () => {
    const src = sourceOf(CONTRACT, 'parmQuery');
    expect(src).toContain("DataMemberAttribute('Query')");
    expect(src).toContain('AifQueryTypeAttribute');
  });

  it('keeps a three-line block and the doc comment above it', () => {
    const src = sourceOf(CONTRACT, 'parmIncludeBlocked');
    expect(src).toContain('SysOperationGroupMemberAttribute');
    expect(src).toContain('SysOperationDisplayOrderAttribute');
    expect(src).toContain('SysOperationLabelAttribute');
    expect(src).toContain('Three attributes, over three lines');
  });

  it('loses nothing — every attribute in the input appears in some output', () => {
    // The failure mode was silent, so assert on the WHOLE source rather than on
    // the members we happened to think of.
    const emitted = split(CONTRACT).methods.map(m => m.source).join('\n') +
      split(CONTRACT).declaration;
    for (const attr of [
      'DataMemberAttribute', 'AifQueryTypeAttribute', 'SysOperationGroupMemberAttribute',
      'SysOperationDisplayOrderAttribute', 'SysOperationLabelAttribute',
    ]) {
      expect(emitted, `${attr} was dropped by the split`).toContain(attr);
    }
  });

  it('still puts member variables in the declaration, not in a method', () => {
    const { declaration } = split(CONTRACT);
    expect(declaration).toContain('private str packedQuery;');
    expect(declaration).toContain('private CustGroupId custGroup;');
  });

  it('does not swallow the previous method into the next one', () => {
    const methods = split(CONTRACT).methods;
    expect(methods.map(m => m.name)).toEqual(['parmCustGroup', 'parmQuery', 'parmIncludeBlocked']);
    expect(sourceOf(CONTRACT, 'parmQuery')).not.toContain('parmCustGroup');
  });
});
