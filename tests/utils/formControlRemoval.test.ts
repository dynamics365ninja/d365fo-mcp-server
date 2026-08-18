/**
 * removeFormControl — the pure half of the remove-control operation.
 *
 * add-control's placement logic lives in formExtensionControlXml.ts and is unit-
 * tested there for the same reason this is tested here: the writer that gets the
 * node wrong produces well-formed XML in the wrong place and reports a ✅ for it.
 * Removal has the mirror-image failure — cutting the wrong element, or half of
 * one — and both are invisible until the form is opened.
 */

import { describe, it, expect } from 'vitest';
import { removeFormControl } from '../../src/utils/formControlRemoval';

/**
 * A form whose ActionPane holds a ButtonGroup with two buttons and the separator
 * between them, so the target sits three <Controls> levels deep. Also carries a
 * <SourceCode> CDATA block and a data source named after a control, which is what
 * a `<Name>`-substring implementation trips over.
 */
const FORM_XML = `<?xml version="1.0" encoding="utf-8"?>
<AxForm xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
\t<Name>ConDemoTicketTable</Name>
\t<SourceCode>
\t\t<Methods>
\t\t\t<Method>
\t\t\t\t<Name>init</Name>
\t\t\t\t<Source><![CDATA[
public void init()
{
    super();
}
]]></Source>
\t\t\t</Method>
\t\t</Methods>
\t</SourceCode>
\t<DataSources>
\t\t<AxFormDataSource xmlns="">
\t\t\t<Name>PostTicket</Name>
\t\t\t<Table>ConDemoTicket</Table>
\t\t</AxFormDataSource>
\t</DataSources>
\t<Design>
\t\t<Controls>
\t\t\t<AxFormControl xmlns="" i:type="AxFormActionPaneControl">
\t\t\t\t<Name>ActionPane</Name>
\t\t\t\t<Controls>
\t\t\t\t\t<AxFormControl xmlns="" i:type="AxFormButtonGroupControl">
\t\t\t\t\t\t<Name>MaintainGroup</Name>
\t\t\t\t\t\t<Controls>
\t\t\t\t\t\t\t<AxFormControl xmlns="" i:type="AxFormCommandButtonControl">
\t\t\t\t\t\t\t\t<Name>NewButton</Name>
\t\t\t\t\t\t\t\t<Command>New</Command>
\t\t\t\t\t\t\t</AxFormControl>
\t\t\t\t\t\t\t<AxFormControl xmlns="" i:type="AxFormButtonSeparatorControl">
\t\t\t\t\t\t\t\t<Name>PostSeparator</Name>
\t\t\t\t\t\t\t</AxFormControl>
\t\t\t\t\t\t\t<AxFormControl xmlns="" i:type="AxFormButtonControl">
\t\t\t\t\t\t\t\t<Name>PostTicket</Name>
\t\t\t\t\t\t\t\t<Text>Post</Text>
\t\t\t\t\t\t\t</AxFormControl>
\t\t\t\t\t\t</Controls>
\t\t\t\t\t</AxFormControl>
\t\t\t\t</Controls>
\t\t\t</AxFormControl>
\t\t\t<AxFormControl xmlns="" i:type="AxFormGridControl">
\t\t\t\t<Name>Grid</Name>
\t\t\t</AxFormControl>
\t\t</Controls>
\t</Design>
</AxForm>`;

/** Extension with both shapes: an envelope over a base-form parent, and a nested control. */
const EXTENSION_XML = `<?xml version="1.0" encoding="utf-8"?>
<AxFormExtension xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
\t<Name>SalesTable.ConDemoExtension</Name>
\t<Controls>
\t\t<AxFormExtensionControl xmlns="">
\t\t\t<Name>FormExtensionControlab12cd34e</Name>
\t\t\t<FormControl xmlns="" i:type="AxFormButtonControl">
\t\t\t\t<Name>ConDemoPostButton</Name>
\t\t\t\t<Text>Post</Text>
\t\t\t</FormControl>
\t\t\t<Parent>ButtonGroup</Parent>
\t\t</AxFormExtensionControl>
\t\t<AxFormExtensionControl xmlns="">
\t\t\t<Name>FormExtensionControlzz99yy88x</Name>
\t\t\t<FormControl xmlns="" i:type="AxFormGroupControl">
\t\t\t\t<Name>ConDemoGroup</Name>
\t\t\t\t<Controls>
\t\t\t\t\t<AxFormControl xmlns="" i:type="AxFormStringControl">
\t\t\t\t\t\t<Name>ConDemoTicketId</Name>
\t\t\t\t\t\t<DataSource>SalesTable</DataSource>
\t\t\t\t\t</AxFormControl>
\t\t\t\t</Controls>
\t\t\t</FormControl>
\t\t\t<Parent>TabGeneral</Parent>
\t\t</AxFormExtensionControl>
\t</Controls>
</AxFormExtension>`;

describe('removeFormControl on an AxForm', () => {
  it('removes a control nested three collections deep', () => {
    const result = removeFormControl(FORM_XML, { controlName: 'PostTicket' });
    expect(result.kind).toBe('removed');
    if (result.kind !== 'removed') return;

    expect(result.removed).toEqual(['PostTicket']);
    expect(result.xml).not.toContain('<Name>PostTicket</Name>\n\t\t\t\t\t\t\t\t<Text>Post</Text>');
    expect(result.xml).not.toContain('<Text>Post</Text>');
    // Its siblings and every container above it survive byte-for-byte.
    expect(result.xml).toContain('<Name>NewButton</Name>');
    expect(result.xml).toContain('<Name>MaintainGroup</Name>');
    expect(result.xml).toContain('<Name>ActionPane</Name>');
    expect(result.xml).toContain('<Name>Grid</Name>');
  });

  it('does not touch a data source that shares the control name', () => {
    // The form's data source is also called PostTicket. A `<Name>` substring
    // implementation cuts whichever comes first in the file — here, the data source.
    const result = removeFormControl(FORM_XML, { controlName: 'PostTicket' });
    expect(result.kind).toBe('removed');
    if (result.kind !== 'removed') return;
    expect(result.xml).toContain('<AxFormDataSource xmlns="">');
    expect(result.xml).toContain('<Table>ConDemoTicket</Table>');
    expect(result.xml).toMatch(/<AxFormDataSource[\s\S]*?<Name>PostTicket<\/Name>/);
  });

  it('leaves the CDATA source block alone', () => {
    const result = removeFormControl(FORM_XML, { controlName: 'PostTicket' });
    if (result.kind !== 'removed') throw new Error('expected removal');
    expect(result.xml).toContain('public void init()');
    expect(result.xml).toContain(']]></Source>');
  });

  it('matches the control name case-insensitively', () => {
    const result = removeFormControl(FORM_XML, { controlName: 'postticket' });
    expect(result.kind).toBe('removed');
  });

  it('removes the following separator only when asked', () => {
    const kept = removeFormControl(FORM_XML, { controlName: 'NewButton' });
    if (kept.kind !== 'removed') throw new Error('expected removal');
    expect(kept.xml).toContain('<Name>PostSeparator</Name>');
    expect(kept.removed).toEqual(['NewButton']);

    const dropped = removeFormControl(FORM_XML, { controlName: 'NewButton', removeSeparator: true });
    if (dropped.kind !== 'removed') throw new Error('expected removal');
    expect(dropped.xml).not.toContain('<Name>PostSeparator</Name>');
    expect(dropped.removed).toEqual(['NewButton', 'PostSeparator']);
    // The button after the separator stays — only the orphaned divider goes.
    expect(dropped.xml).toContain('<Name>PostTicket</Name>');
  });

  it('falls back to the PRECEDING separator when nothing follows', () => {
    const result = removeFormControl(FORM_XML, { controlName: 'PostTicket', removeSeparator: true });
    if (result.kind !== 'removed') throw new Error('expected removal');
    expect(result.removed).toEqual(['PostSeparator', 'PostTicket']);
    expect(result.xml).toContain('<Name>NewButton</Name>');
  });

  it('says so when removeSeparator finds no separator', () => {
    const result = removeFormControl(FORM_XML, { controlName: 'Grid', removeSeparator: true });
    if (result.kind !== 'removed') throw new Error('expected removal');
    expect(result.removed).toEqual(['Grid']);
    expect(result.notes.join(' ')).toMatch(/no adjacent/i);
  });

  it('collapses an emptied <Controls> to the self-closing spelling', () => {
    // MaintainGroup's Controls is left with nothing after all three of its
    // children go, and <Controls></Controls> is not a shape the serializer writes.
    let xml = FORM_XML;
    for (const name of ['NewButton', 'PostSeparator', 'PostTicket']) {
      const step = removeFormControl(xml, { controlName: name });
      if (step.kind !== 'removed') throw new Error(`expected removal of ${name}`);
      xml = step.xml;
    }
    expect(xml).toContain('<Controls />');
    expect(xml).not.toMatch(/<Controls>\s*<\/Controls>/);
    expect(xml).toContain('<Name>MaintainGroup</Name>');
  });

  it('reports not-found with the names that ARE there', () => {
    const result = removeFormControl(FORM_XML, { controlName: 'NoSuchButton' });
    expect(result.kind).toBe('not-found');
    if (result.kind !== 'not-found') return;
    expect(result.present).toContain('PostTicket');
    expect(result.present).toContain('Grid');
  });

  it('declines a file that is not a form', () => {
    const enumXml = `<?xml version="1.0" encoding="utf-8"?>\n<AxEnum><Name>ConDemoStatus</Name></AxEnum>`;
    expect(removeFormControl(enumXml, { controlName: 'Grid' }).kind).toBe('unsupported');
  });

  it('declines unbalanced XML rather than guessing', () => {
    expect(removeFormControl('<AxForm><Design><Controls>', { controlName: 'Grid' }).kind).toBe('unsupported');
  });
});

describe('removeFormControl on an AxFormExtension', () => {
  it('removes the whole AxFormExtensionControl envelope, not just its FormControl', () => {
    const result = removeFormControl(EXTENSION_XML, { controlName: 'ConDemoPostButton' });
    expect(result.kind).toBe('removed');
    if (result.kind !== 'removed') return;

    // The envelope's wrapper name and its <Parent> go with the control: an
    // envelope without a FormControl is a parent reference to nothing.
    expect(result.xml).not.toContain('FormExtensionControlab12cd34e');
    expect(result.xml).not.toContain('<Parent>ButtonGroup</Parent>');
    expect(result.xml).not.toContain('<Name>ConDemoPostButton</Name>');
    // The other envelope is untouched.
    expect(result.xml).toContain('FormExtensionControlzz99yy88x');
    expect(result.xml).toContain('<Parent>TabGeneral</Parent>');
  });

  it('removes a nested control without disturbing the envelope around its parent', () => {
    const result = removeFormControl(EXTENSION_XML, { controlName: 'ConDemoTicketId' });
    if (result.kind !== 'removed') throw new Error('expected removal');
    expect(result.xml).not.toContain('<Name>ConDemoTicketId</Name>');
    expect(result.xml).toContain('<Name>ConDemoGroup</Name>');
    expect(result.xml).toContain('FormExtensionControlzz99yy88x');
    // The group's now-empty collection is collapsed, not left as an empty pair.
    expect(result.xml).toContain('<Controls />');
  });

  it('never resolves the auto-generated wrapper name as a control', () => {
    // parentControl/controlName must never match a wrapper id — it is not a
    // control name, and treating it as one deletes an arbitrary envelope.
    const result = removeFormControl(EXTENSION_XML, { controlName: 'FormExtensionControlab12cd34e' });
    expect(result.kind).toBe('not-found');
  });
});
