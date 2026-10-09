/**
 * modify-property on a control the document itself defines (VM-free).
 *
 * Before this writer, `modify-property` reached a form's <Design> and — through
 * <ControlModifications> — a BASE-form control from an extension, but not a
 * control of the agent's own form or one an extension adds. Setting MenuItemName
 * / MultiSelect / NeedsRecord on such a button meant rewriting the whole form.
 *
 * Placement is asserted against the element-order census, because the metadata
 * deserializer drops an element written out of sequence without a word (#979).
 */

import { describe, it, expect } from 'vitest';
import { upsertFormControlProperty } from '../../src/utils/formControlPropertyXml';
import { findControlElementOrderViolations } from '../../src/validation/formControlElementOrder';

/** A form with a menu-item button and a plain button, as Visual Studio writes them. */
const FORM = `<?xml version="1.0" encoding="utf-8"?>
<AxForm xmlns:i="http://www.w3.org/2001/XMLSchema-instance" xmlns="Microsoft.Dynamics.AX.Metadata.V6">
	<Name>MyForm</Name>
	<Design>
		<Caption xmlns="">@MyModel:MyForm</Caption>
		<Controls xmlns="">
			<AxFormControl xmlns=""
				i:type="AxFormActionPaneControl">
				<Name>ActionPane</Name>
				<Type>ActionPane</Type>
				<Controls>
					<AxFormControl xmlns=""
						i:type="AxFormMenuFunctionButtonControl">
						<Name>PostButton</Name>
						<Type>MenuFunctionButton</Type>
						<FormControlExtension
							i:nil="true" />
						<DataSource>MyTable</DataSource>
						<MenuItemName>MyPostAction</MenuItemName>
						<MenuItemType>Action</MenuItemType>
					</AxFormControl>
					<AxFormControl xmlns=""
						i:type="AxFormButtonControl">
						<Name>PlainButton</Name>
						<Type>Button</Type>
						<FormControlExtension
							i:nil="true" />
						<Text>@MyModel:Plain</Text>
					</AxFormControl>
				</Controls>
			</AxFormControl>
		</Controls>
	</Design>
</AxForm>`;

/** A form extension that ADDS a button (the shape add-control writes). */
const EXTENSION = `<?xml version="1.0" encoding="utf-8"?>
<AxFormExtension xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
	<Name>CustTable.MyExt</Name>
	<ControlModifications />
	<Controls>
		<AxFormExtensionControl xmlns="">
			<Name>FormExtensionControl1</Name>
			<FormControl xmlns=""
				i:type="AxFormMenuFunctionButtonControl">
				<Name>MyExtButton</Name>
				<Type>MenuFunctionButton</Type>
				<FormControlExtension
					i:nil="true" />
				<MenuItemName>MyAction</MenuItemName>
			</FormControl>
			<Parent>ButtonGroup</Parent>
		</AxFormExtensionControl>
	</Controls>
</AxFormExtension>`;

function ok(r: ReturnType<typeof upsertFormControlProperty>) {
  if (!r) throw new Error('expected an outcome, got null (control not found)');
  if (!r.ok) throw new Error(`expected success, got: ${r.reason}`);
  return r;
}

/** The direct children of the control named `name`, in document order. */
function childOrder(xml: string, name: string): string[] {
  const start = xml.indexOf(`<Name>${name}</Name>`);
  const end = xml.indexOf('</AxFormControl>', start) >= 0 && xml.includes('<AxForm ')
    ? xml.indexOf('</AxFormControl>', start)
    : xml.indexOf('</FormControl>', start);
  return [...xml.slice(start, end).matchAll(/^\t*<([A-Za-z]+)[\s>/]/gm)].map(m => m[1]);
}

describe('upsertFormControlProperty — a control of the agent\'s own form', () => {
  it('adds NeedsRecord and MultiSelect where shipped metadata puts them', () => {
    let xml = ok(upsertFormControlProperty(FORM, 'PostButton', 'NeedsRecord', 'Yes')).xml;
    xml = ok(upsertFormControlProperty(xml, 'PostButton', 'MultiSelect', 'Yes')).xml;

    expect(childOrder(xml, 'PostButton')).toEqual([
      'Name', 'Type', 'FormControlExtension', 'DataSource', 'MenuItemName', 'MenuItemType', 'MultiSelect', 'NeedsRecord',
    ]);
    // The checker every form write already runs agrees: nothing out of order, nothing unknown.
    expect(findControlElementOrderViolations(xml)).toEqual([]);
    // Indented like its siblings.
    expect(xml).toContain('\t\t\t\t\t\t<MenuItemType>Action</MenuItemType>\n\t\t\t\t\t\t<MultiSelect>Yes</MultiSelect>');
  });

  it('replaces an existing value in place and leaves every other byte alone', () => {
    const r = ok(upsertFormControlProperty(FORM, 'PostButton', 'MenuItemName', 'MyOtherAction'));
    expect(r.changed).toBe(true);
    expect(r.xml).toBe(FORM.replace('<MenuItemName>MyPostAction</MenuItemName>', '<MenuItemName>MyOtherAction</MenuItemName>'));
  });

  it('is idempotent: the same value again writes nothing', () => {
    const r = ok(upsertFormControlProperty(FORM, 'PostButton', 'MenuItemType', 'Action'));
    expect(r.changed).toBe(false);
    expect(r.xml).toBe(FORM);
  });

  it('matches the control and the property case-insensitively, writing the census spelling', () => {
    const r = ok(upsertFormControlProperty(FORM, 'postbutton', 'needsrecord', 'Yes'));
    expect(r.xml).toContain('<NeedsRecord>Yes</NeedsRecord>');
    expect(r.xml).not.toContain('needsrecord');
  });

  it('removes the element for an empty value, and reports an absent one as already default', () => {
    const removed = ok(upsertFormControlProperty(FORM, 'PostButton', 'DataSource', ''));
    expect(removed.xml).not.toContain('<DataSource>MyTable</DataSource>');
    expect(removed.xml).toContain('i:nil="true" />\n\t\t\t\t\t\t<MenuItemName>');

    const absent = ok(upsertFormControlProperty(FORM, 'PostButton', 'NeedsRecord', ''));
    expect(absent.changed).toBe(false);
  });

  it('escapes the value', () => {
    const r = ok(upsertFormControlProperty(FORM, 'PlainButton', 'Text', 'A & <B>'));
    expect(r.xml).toContain('<Text>A &amp; &lt;B&gt;</Text>');
  });

  it('keeps CRLF files CRLF', () => {
    const crlf = FORM.replace(/\n/g, '\r\n');
    const r = ok(upsertFormControlProperty(crlf, 'PostButton', 'NeedsRecord', 'Yes'));
    expect(r.xml).toContain('<NeedsRecord>Yes</NeedsRecord>\r\n');
    expect(r.xml.replace(/\r\n/g, '')).not.toContain('\n');
  });
});

describe('upsertFormControlProperty — a control a form extension adds', () => {
  it('writes on the added <FormControl>, not in <ControlModifications>', () => {
    const r = ok(upsertFormControlProperty(EXTENSION, 'MyExtButton', 'NeedsRecord', 'Yes'));
    expect(r.xml).toContain('<MenuItemName>MyAction</MenuItemName>\n\t\t\t\t<NeedsRecord>Yes</NeedsRecord>');
    expect(r.xml).toContain('<ControlModifications />');
    expect(findControlElementOrderViolations(r.xml)).toEqual([]);
  });

  it('returns null for a name the extension does not define — that is a BASE-form control', () => {
    expect(upsertFormControlProperty(EXTENSION, 'ButtonGroup', 'Visible', 'No')).toBeNull();
  });
});

describe('upsertFormControlProperty — refusals write nothing', () => {
  it('refuses a property the control type never carries', () => {
    // MenuItemName belongs to a MenuFunctionButton; a plain Button has none.
    const r = upsertFormControlProperty(FORM, 'PlainButton', 'MenuItemName', 'MyPostAction');
    expect(r?.ok).toBe(false);
    expect(r && !r.ok && r.reason).toMatch(/AxFormButtonControl has no property "MenuItemName"/);
  });

  it('refuses structural children', () => {
    for (const property of ['Name', 'Type', 'Controls']) {
      const r = upsertFormControlProperty(FORM, 'ActionPane', property, 'X');
      expect(r?.ok, property).toBe(false);
    }
  });

  it('refuses an ambiguous control name', () => {
    const twice = FORM.replace('<Name>PlainButton</Name>', '<Name>PostButton</Name>');
    const r = upsertFormControlProperty(twice, 'PostButton', 'NeedsRecord', 'Yes');
    expect(r?.ok).toBe(false);
    expect(r && !r.ok && r.reason).toMatch(/2 controls are named/);
  });

  it('returns null when the form has no such control', () => {
    expect(upsertFormControlProperty(FORM, 'Missing', 'NeedsRecord', 'Yes')).toBeNull();
  });

  it('refuses names that are not plain identifiers, and unbalanced XML', () => {
    expect(upsertFormControlProperty(FORM, 'Post Button', 'NeedsRecord', 'Yes')?.ok).toBe(false);
    expect(upsertFormControlProperty(FORM, 'PostButton', 'Needs.Record', 'Yes')?.ok).toBe(false);
    expect(upsertFormControlProperty(FORM.replace('</Design>', ''), 'PostButton', 'NeedsRecord', 'Yes')?.ok).toBe(false);
  });
});
