/**
 * Caller-written form XML gets the namespace layout every shipped form has.
 *
 * Found by the model × MCP benchmark (ref-credit-hold-extension, 2026-10-10): an
 * agent passed d365fo_file(action="create", form-extension) an AxFormExtension with
 * no xmlns="Microsoft.Dynamics.AX.Metadata.V6". The server wrote it and said ✅;
 * xppc built it clean; xppbp then reported "Error reading FormExtension
 * 'CustTable.McpExtension'" and "not found". The same files with the layout fixed:
 * build clean, xppbp 0 errors (matched pair, eval/benchmark/.work/ns-probe.ts).
 *
 * The layout is a census, not a guess: only AxForm (9,442/9,442) and
 * AxFormExtension (1,088/1,088) roots declare V6; root and children are in it,
 * every grandchild resets to xmlns="" — no exception in 5.6 M elements. The
 * function also leaves all 10,530 shipped files byte-identical.
 */

import { describe, it, expect } from 'vitest';
import { ensureFormMetadataNamespace, FORM_METADATA_NAMESPACE } from '../../src/utils/formMetadataNamespace.js';

// What the benchmark agent sent (abridged to one control).
const AS_SENT = `<?xml version="1.0" encoding="utf-8"?>
<AxFormExtension xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
	<Name>CustTable.McpExtension</Name>
	<Controls>
		<AxFormExtensionControl>
			<Name>McpCreditHold</Name>
			<FormControl xmlns="" i:type="AxFormGroupControl">
				<Name>McpCreditHold</Name>
				<Type>Group</Type>
			</FormControl>
			<Parent>TabCredit</Parent>
		</AxFormExtensionControl>
	</Controls>
	<DataSources />
</AxFormExtension>`;

// The shipped shape of the same thing.
const SHIPPED = `<?xml version="1.0" encoding="utf-8"?>
<AxFormExtension xmlns:i="http://www.w3.org/2001/XMLSchema-instance" xmlns="${FORM_METADATA_NAMESPACE}">
	<Name>CustTable.McpExtension</Name>
	<Controls>
		<AxFormExtensionControl xmlns="">
			<Name>McpCreditHold</Name>
			<FormControl xmlns="" i:type="AxFormGroupControl">
				<Name>McpCreditHold</Name>
				<Type>Group</Type>
			</FormControl>
			<Parent>TabCredit</Parent>
		</AxFormExtensionControl>
	</Controls>
	<DataSources />
</AxFormExtension>`;

describe('ensureFormMetadataNamespace', () => {
  it('adds V6 to the root and xmlns="" to the grandchildren', () => {
    const r = ensureFormMetadataNamespace(AS_SENT);
    expect(r.changed).toBe(true);
    expect(r.xml).toContain(`<AxFormExtension xmlns:i="http://www.w3.org/2001/XMLSchema-instance" xmlns="${FORM_METADATA_NAMESPACE}">`);
    expect(r.xml).toContain('<AxFormExtensionControl xmlns="">');
    // Children of the root stay in V6 — no reset on them.
    expect(r.xml).toContain('\t<Controls>');
    expect(r.xml).toContain('<Name>CustTable.McpExtension</Name>');
  });

  it('leaves the shipped shape byte-identical', () => {
    const r = ensureFormMetadataNamespace(SHIPPED);
    expect(r.changed).toBe(false);
    expect(r.xml).toBe(SHIPPED);
  });

  it('is idempotent', () => {
    const once = ensureFormMetadataNamespace(AS_SENT).xml;
    expect(ensureFormMetadataNamespace(once)).toEqual({ xml: once, changed: false });
  });

  it('takes a child of the root back into V6', () => {
    const xml = SHIPPED.replace('\t<Controls>', '\t<Controls xmlns="">');
    const r = ensureFormMetadataNamespace(xml);
    expect(r.changed).toBe(true);
    expect(r.xml).toBe(SHIPPED);
  });

  it('applies to AxForm the same way', () => {
    const r = ensureFormMetadataNamespace('<AxForm xmlns:i="x"><Name>F</Name><Design><Pattern>SimpleList</Pattern></Design></AxForm>');
    expect(r.xml).toBe(`<AxForm xmlns:i="x" xmlns="${FORM_METADATA_NAMESPACE}"><Name>F</Name><Design><Pattern xmlns="">SimpleList</Pattern></Design></AxForm>`);
  });

  it('does not touch any other root — none of them carries the namespace', () => {
    const table = '<AxTable xmlns:i="x"><Name>T</Name><Fields><AxTableField i:type="AxTableFieldString"><Name>F</Name></AxTableField></Fields></AxTable>';
    expect(ensureFormMetadataNamespace(table)).toEqual({ xml: table, changed: false });
  });

  it('leaves CDATA, comments and quoted ">" alone', () => {
    const xml = '<AxForm xmlns:i="x"><!-- <Not> an element --><SourceCode><Methods><Method><Source><![CDATA[ if (a > b) { <x> } ]]></Source></Method></Methods></SourceCode><Name a="1>2">F</Name></AxForm>';
    const r = ensureFormMetadataNamespace(xml);
    expect(r.xml).toContain('<!-- <Not> an element -->');
    expect(r.xml).toContain('<![CDATA[ if (a > b) { <x> } ]]>');
    expect(r.xml).toContain('<Methods xmlns="">');
    expect(r.xml).toContain('<Name a="1>2">F</Name>');
  });
});
