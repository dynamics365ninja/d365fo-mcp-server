/**
 * The three write-path defects the 2026-08-31 capture wave found, and the guards
 * that make their whole CLASS non-silent.
 *
 * What makes them worth their own suite: every one of them built with 0 errors,
 * was xppbp-clean, and read back as plausible metadata. A 5,779-test suite and a
 * golden diff passed all three. Only running the artifacts — a SysTest reading
 * enum2int(), a second write landing on the same object — could see them.
 *
 * Evidence for each is in the corpus:
 *   eval/corpus/runs/2026-08-31T22__L3-enum-field-form-downgrade-guard__278eee3.json
 *   eval/corpus/runs/2026-08-31T22__L4-headerlines-document-slice__278eee3.json
 *   eval/corpus/runs/2026-08-31T23__L2-event-handler-basic__278eee3.json
 */

import { describe, it, expect } from 'vitest';
import { XmlTemplateGenerator } from '../../src/tools/xml/xmlTemplateGenerator';
import { resolveEnumValueMode } from '../../src/utils/axEnumProperties';
import {
  checkObjectIdentity,
  readDeclarationName,
  readRootObjectName,
  rewriteRootObjectName,
} from '../../src/tools/write/objectIdentityGate';
import {
  claimedMarkerFor,
  preserveDroppedProperties,
  readTopLevelLeaves,
  renderClaimCheck,
} from '../../src/tools/write/preserveMetadataElements';

// ───────────────────────── defect 1: the all-zero enum ─────────────────────────

describe('an enum member without <Value> is 0, not its ordinal', () => {
  const tiers = [
    { name: 'None' }, { name: 'Silver' }, { name: 'Gold' }, { name: 'Platinum' },
  ];

  it('writes the number of every member after the zero', () => {
    const xml = XmlTemplateGenerator.generateAxEnumXml('ConDemoServiceTier', { enumValues: tiers });

    // The zero stays implicit — that is the serialiser's own default and the
    // shape all 3,913 shipped AxEnum files use.
    expect(xml).not.toContain('<Value>0</Value>');
    expect(xml).toContain('<Value>1</Value>');
    expect(xml).toContain('<Value>2</Value>');
    expect(xml).toContain('<Value>3</Value>');
  });

  it('keeps caller-chosen numbers that positions would not give', () => {
    const xml = XmlTemplateGenerator.generateAxEnumXml('ConDemoOrderType', {
      enumValues: [{ name: 'None' }, { name: 'Second', value: 2 }, { name: 'First', value: 1 }],
    });
    expect(xml).toMatch(/<Name>Second<\/Name>\s*<Value>2<\/Value>/);
    expect(xml).toMatch(/<Name>First<\/Name>\s*<Value>1<\/Value>/);
  });

  it('writes them on an EXTENSIBLE enum too — xppc compiles that shape', () => {
    // Probed on the VM 2026-09-01: IsExtensible=true + UseEnumValue=No + explicit
    // non-positional values built clean, and the negative control in the same
    // build (UseEnumValue=Yes) failed with the documented message.
    const xml = XmlTemplateGenerator.generateAxEnumXml('ConDemoCategory', {
      isExtensible: true,
      enumValues: tiers,
    });
    expect(xml).toContain('<UseEnumValue>No</UseEnumValue>');
    expect(xml).toContain('<IsExtensible>true</IsExtensible>');
    expect(xml).toContain('<Value>3</Value>');
  });

  it('refuses only the pairing xppc itself refuses', () => {
    expect(() => resolveEnumValueMode('E', { isExtensible: true, useEnumValue: true }, tiers))
      .toThrow(/UseEnumValue property must be set to 'No'/);
    // …and no longer refuses explicit values on an extensible enum.
    expect(resolveEnumValueMode('E', { isExtensible: true }, tiers)).toEqual({ useEnumValue: 'No' });
    expect(resolveEnumValueMode('E', { useEnumValue: false }, tiers)).toEqual({ useEnumValue: 'No' });
  });
});

// ────────────────── defect 2: a write that drops what it was not asked about ──────────────────

const TABLE_BEFORE = `<?xml version="1.0" encoding="utf-8"?>
<AxTable xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
\t<Name>ConDemoRentLine</Name>
\t<SourceCode>
\t\t<Declaration><![CDATA[
public class ConDemoRentLine extends common
{
}
]]></Declaration>
\t</SourceCode>
\t<Label>@Contoso:Line</Label>
\t<TableGroup>Transaction</TableGroup>
\t<CacheLookup>None</CacheLookup>
\t<Fields />
</AxTable>
`;

describe('a bridge round trip may not silently drop a property', () => {
  it('reads only the root\'s own leaf properties', () => {
    const leaves = readTopLevelLeaves(TABLE_BEFORE);
    expect([...leaves.keys()]).toEqual(['Name', 'Label', 'TableGroup', 'CacheLookup']);
    expect(leaves.get('CacheLookup')).toBe('None');
  });

  it('restores a property the operation never touched, in its canonical slot', () => {
    // Exactly reproduction 1: create(table, cacheLookup:"None") patched the file,
    // then add-relation round-tripped it through a provider that had not re-read
    // the patch, and CacheLookup was gone.
    const after = TABLE_BEFORE.replace('\t<CacheLookup>None</CacheLookup>\n', '');
    const { xml, restored } = preserveDroppedProperties(TABLE_BEFORE, after, 'add-relation');

    expect(restored).toEqual(['CacheLookup=None']);
    expect(xml).toMatch(/<TableGroup>Transaction<\/TableGroup>\n\t<CacheLookup>None<\/CacheLookup>/);
  });

  it('leaves an asked-for removal alone', () => {
    const after = TABLE_BEFORE.replace('\t<CacheLookup>None</CacheLookup>\n', '');
    expect(preserveDroppedProperties(TABLE_BEFORE, after, 'remove-relation').restored).toEqual([]);
    // …and the property a modify-property call is ABOUT is the caller's to clear.
    expect(
      preserveDroppedProperties(TABLE_BEFORE, after, 'modify-property', 'CacheLookup').restored,
    ).toEqual([]);
  });

  it('says nothing when the write changed nothing it should not have', () => {
    const after = TABLE_BEFORE.replace('<Label>@Contoso:Line</Label>', '<Label>@Contoso:Other</Label>');
    expect(preserveDroppedProperties(TABLE_BEFORE, after, 'modify-property', 'Label').restored).toEqual([]);
  });

  it('never papers over a lost <Name> — that is a broken document, not a property', () => {
    const after = TABLE_BEFORE.replace('\t<Name>ConDemoRentLine</Name>\n', '');
    expect(preserveDroppedProperties(TABLE_BEFORE, after, 'add-field').restored).toEqual([]);
  });
});

describe('"Verified: on disk" is not a verification of the value', () => {
  it('reports a modify-property whose value is not in the file', () => {
    const marker = claimedMarkerFor('modify-property', { propertyPath: 'CacheLookup', propertyValue: 'None' });
    expect(renderClaimCheck(marker, TABLE_BEFORE)).toBe('');
    expect(renderClaimCheck(marker, TABLE_BEFORE.replace('<CacheLookup>None</CacheLookup>', '')))
      .toMatch(/❌ Verification: "CacheLookup=None" is NOT in the file/);
  });

  it('checks a delete action by its TYPE, which is the half that went missing', () => {
    const marker = claimedMarkerFor('add-delete-action', {
      deleteActionName: 'ConDemoRentLine', deleteActionType: 'Cascade',
    });
    const good = '<Name>ConDemoRentLine</Name>\n<DeleteAction>Cascade</DeleteAction>\n<Table>ConDemoRentLine</Table>';
    const corrupted = '<Name>ConDemoRentLine</Name>\n<Table>ConDemoRentLine</Table>';
    expect(renderClaimCheck(marker, good)).toBe('');
    expect(renderClaimCheck(marker, corrupted)).toMatch(/is NOT in the file/);
  });

  it('stays quiet when no marker can be derived — an unmade check is not a pass', () => {
    expect(claimedMarkerFor('add-method', { methodName: 'foo' })).toBeNull();
    expect(renderClaimCheck(null, TABLE_BEFORE)).toBe('');
  });
});

// ─────────────── defect 3: one object stating three different identities ───────────────

const CLASS_XML = `<?xml version="1.0" encoding="utf-8"?>
<AxClass xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
\t<Name>EvalTest</Name>
\t<SourceCode>
\t\t<Declaration><![CDATA[
class EvalTest extends SysTestCase
{
}
]]></Declaration>
\t</SourceCode>
</AxClass>
`;

describe('file name, <Name> and the X++ declaration must agree', () => {
  it('reads both identities out of the document', () => {
    expect(readRootObjectName(CLASS_XML)).toBe('EvalTest');
    expect(readDeclarationName(CLASS_XML)).toBe('EvalTest');
  });

  it('rewrites the root <Name> when the model prefix is applied', () => {
    const renamed = rewriteRootObjectName(CLASS_XML, 'EvalTest', 'ConDemoEvalTest');
    expect(readRootObjectName(renamed)).toBe('ConDemoEvalTest');
    // Only the root element — a member that happens to share the name keeps it.
    expect(rewriteRootObjectName('<A>\n\t<Name>X</Name>\n\t<F><Name>X</Name></F>\n</A>', 'X', 'PX'))
      .toBe('<A>\n\t<Name>PX</Name>\n\t<F><Name>X</Name></F>\n</A>');
  });

  it('names every identity that disagrees', () => {
    // The exact shape the L2-event-handler-basic run wrote: prefix on the file and
    // on the declaration, none on <Name>.
    const half = CLASS_XML.replace('class EvalTest', 'class ConDemoEvalTest');
    const problems = checkObjectIdentity(half, 'ConDemoEvalTest');
    expect(problems).toEqual([{ where: 'root-name', found: 'EvalTest' }]);
    expect(checkObjectIdentity(CLASS_XML, 'EvalTest')).toEqual([]);
  });

  it('does not fault an extension, whose metadata name and X++ name differ by design', () => {
    const ext = `<?xml version="1.0" encoding="utf-8"?>
<AxClass xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
\t<Name>CustTable.ConDemo</Name>
\t<SourceCode>
\t\t<Declaration><![CDATA[
final class CustTable_Extension
{
}
]]></Declaration>
\t</SourceCode>
</AxClass>
`;
    expect(checkObjectIdentity(ext, 'CustTable.ConDemo')).toEqual([]);
  });

  it('does not read a declaration out of a doc comment', () => {
    // The generated class opens with "/// Provides my new class MyNewClass
    // functionality" — the word `class` in prose. Matching that made the gate
    // refuse correct creates; the full suite caught it the same hour it was
    // written, which is what the shared lexer is for.
    const documented = CLASS_XML.replace(
      'class EvalTest extends SysTestCase',
      [
        '/// <summary>',
        '/// Provides my new class NotTheClassName functionality.',
        '/// </summary>',
        'class EvalTest extends SysTestCase',
      ].join('\n'),
    );
    expect(readDeclarationName(documented)).toBe('EvalTest');
    expect(checkObjectIdentity(documented, 'EvalTest')).toEqual([]);
  });

  it('ignores a name that only appears in a comment', () => {
    const commented = CLASS_XML.replace('\t<Name>EvalTest</Name>', '\t<!-- <Name>Other</Name> -->\n\t<Name>EvalTest</Name>');
    expect(readRootObjectName(commented)).toBe('EvalTest');
  });
});
