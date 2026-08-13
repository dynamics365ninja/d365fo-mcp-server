/**
 * Regression tests — control placement in an AxFormExtension.
 *
 * Field report (2026-08-12): `add-control` on a form extension emitted an
 * <AxFormExtensionControl> envelope INTO the nested <Controls> of a group the
 * extension itself defines, and reported ✅. Root cause was not a missing
 * branch but a blind splice:
 *
 *     content.replace('</Controls>', `${envelope}\n\t</Controls>`)
 *
 * A string pattern replaces the FIRST occurrence, and the nested </Controls>
 * closes before the root one — so `parentControl` never influenced the
 * insertion point at all (it only supplied the <Parent> text). Every fixture at
 * the time was flat, where first-</Controls> happens to be the right one; this
 * file pins the nested case in both directions.
 */

import { describe, it, expect } from 'vitest';
import {
  insertFormExtensionControl,
  findFormExtensionPlacementProblems,
  buildAbandonedWriteMessage,
  type FormExtensionControlSpec,
} from '../../src/utils/formExtensionControlXml';
import { validateFormExtensionControlShape } from '../../src/utils/formExtensionShapeValidator';

// ─── Fixtures ────────────────────────────────────────────────────────────────

/** Flat extension: one control attached to a base-form parent. Matches the golden. */
const FLAT_EXT = `<?xml version="1.0" encoding="utf-8"?>
<AxFormExtension xmlns:i="http://www.w3.org/2001/XMLSchema-instance" xmlns="Microsoft.Dynamics.AX.Metadata.V6">
\t<Name>CustGroup.ConExtension</Name>
\t<ControlModifications />
\t<Controls>
\t\t<AxFormExtensionControl xmlns="">
\t\t\t<Name>FormExtensionControlfse38xiwz</Name>
\t\t\t<FormControl xmlns="" i:type="AxFormCheckBoxControl">
\t\t\t\t<Name>Grid_ConHasNotes</Name>
\t\t\t\t<Type>CheckBox</Type>
\t\t\t\t<FormControlExtension i:nil="true" />
\t\t\t\t<DataField>ConHasNotes</DataField>
\t\t\t\t<DataSource>CustGroup</DataSource>
\t\t\t</FormControl>
\t\t\t<Parent>Grid</Parent>
\t\t</AxFormExtensionControl>
\t</Controls>
\t<DataSourceModifications />
\t<DataSources />
</AxFormExtension>`;

/**
 * The reported shape: the extension defines its OWN group container, so the file
 * has a nested <Controls> that closes before the root one.
 * `dataGroup` toggles the <DataGroup> binding described in the report's §6b.
 */
const nestedExt = (opts: { dataGroup?: boolean } = {}) => `<?xml version="1.0" encoding="utf-8"?>
<AxFormExtension xmlns:i="http://www.w3.org/2001/XMLSchema-instance" xmlns="Microsoft.Dynamics.AX.Metadata.V6">
\t<Name>InventTestGroup.ConExtension</Name>
\t<ControlModifications />
\t<Controls>
\t\t<AxFormExtensionControl xmlns="">
\t\t\t<Name>FormExtensionControlabc123xyz</Name>
\t\t\t<FormControl xmlns="" i:type="AxFormGroupControl">
\t\t\t\t<Name>ConQualityOrders</Name>
\t\t\t\t<Type>Group</Type>
\t\t\t\t<FormControlExtension i:nil="true" />
\t\t\t\t<Controls>
\t\t\t\t\t<AxFormControl xmlns="" i:type="AxFormCheckBoxControl">
\t\t\t\t\t\t<Name>ConQualityOrders_ConDisableInventoryBlocking</Name>
\t\t\t\t\t\t<Type>CheckBox</Type>
\t\t\t\t\t\t<FormControlExtension i:nil="true" />
\t\t\t\t\t\t<DataField>ConDisableInventoryBlocking</DataField>
\t\t\t\t\t\t<DataSource>InventTestGroup</DataSource>
\t\t\t\t\t</AxFormControl>
\t\t\t\t</Controls>
${opts.dataGroup ? '\t\t\t\t<DataGroup>ConQualityOrders</DataGroup>\n' : ''}\t\t\t\t<DataSource>InventTestGroup</DataSource>
\t\t\t</FormControl>
\t\t\t<Parent>TabHeaderGeneral</Parent>
\t\t</AxFormExtensionControl>
\t</Controls>
\t<DataSourceModifications />
\t<DataSources />
</AxFormExtension>`;

const spec = (over: Partial<FormExtensionControlSpec> = {}): FormExtensionControlSpec => ({
  controlName: 'ConQualityOrders_ConDisableProdQty',
  parentControl: 'ConQualityOrders',
  iType: 'AxFormCheckBoxControl',
  typeValue: 'CheckBox',
  dataSource: 'InventTestGroup',
  dataField: 'ConDisableProdQty',
  wrapperName: 'FormExtensionControlnew000001',
  ...over,
});

const count = (s: string, needle: string) => s.split(needle).length - 1;

/** Text between the extension-owned group's nested <Controls> … </Controls>. */
function nestedControlsBody(xml: string): string {
  const open = xml.indexOf('<Controls>', xml.indexOf('<Name>ConQualityOrders</Name>'));
  const close = xml.indexOf('</Controls>', open);
  expect(open).toBeGreaterThan(-1);
  expect(close).toBeGreaterThan(-1);
  return xml.slice(open, close);
}

const inserted = (r: ReturnType<typeof insertFormExtensionControl>) => {
  expect(r.kind).toBe('inserted');
  return r as Extract<typeof r, { kind: 'inserted' }>;
};

// ─── The primary defect ──────────────────────────────────────────────────────

describe('parent defined by the extension itself → bare nested AxFormControl', () => {
  it('writes the control into the parent group, not the root collection', () => {
    const r = inserted(insertFormExtensionControl(nestedExt(), spec()));

    expect(r.representation).toBe('nested');
    expect(nestedControlsBody(r.xml)).toContain('<Name>ConQualityOrders_ConDisableProdQty</Name>');
  });

  it('emits NO envelope and NO <Parent> for the new control', () => {
    const r = inserted(insertFormExtensionControl(nestedExt(), spec()));

    // Exactly the one envelope and the one <Parent> the fixture started with.
    expect(count(r.xml, '<AxFormExtensionControl')).toBe(count(nestedExt(), '<AxFormExtensionControl'));
    expect(count(r.xml, '<Parent>')).toBe(1);
    expect(r.xml).toContain('<Parent>TabHeaderGeneral</Parent>');
    expect(r.xml).not.toContain('<Parent>ConQualityOrders</Parent>');
  });

  it('never puts an AxFormExtensionControl inside the nested collection (the reported bug)', () => {
    const r = inserted(insertFormExtensionControl(nestedExt(), spec()));

    expect(nestedControlsBody(r.xml)).not.toContain('AxFormExtensionControl');
  });

  it('leaves the group\'s trailing properties in place after </Controls>', () => {
    const r = inserted(insertFormExtensionControl(nestedExt(), spec()));

    // The bad output stranded these behind a collection closed at the wrong depth.
    expect(r.xml).toMatch(/<\/Controls>\s*\n\s*<DataSource>InventTestGroup<\/DataSource>/);
  });

  it('appends after the existing sibling, preserving field order', () => {
    const r = inserted(insertFormExtensionControl(nestedExt(), spec()));
    const body = nestedControlsBody(r.xml);

    expect(body.indexOf('ConDisableInventoryBlocking'))
      .toBeLessThan(body.indexOf('ConQualityOrders_ConDisableProdQty'));
  });

  it('matches the designer shape byte-for-byte in the control body', () => {
    const r = inserted(insertFormExtensionControl(nestedExt(), spec()));

    expect(r.xml).toContain(
      '\t\t\t\t\t<AxFormControl xmlns="" i:type="AxFormCheckBoxControl">\n' +
      '\t\t\t\t\t\t<Name>ConQualityOrders_ConDisableProdQty</Name>\n' +
      '\t\t\t\t\t\t<Type>CheckBox</Type>\n' +
      '\t\t\t\t\t\t<FormControlExtension i:nil="true" />\n' +
      '\t\t\t\t\t\t<DataField>ConDisableProdQty</DataField>\n' +
      '\t\t\t\t\t\t<DataSource>InventTestGroup</DataSource>\n' +
      '\t\t\t\t\t</AxFormControl>\n'
    );
  });
});

// Report §11.3, reproduced in a second environment: two add-control calls against
// one file, naming two different sibling groups. The SECOND call inserted into the
// FIRST call's parent while writing the requested name into <Parent> — because the
// insertion point was found positionally (first </Controls>) and `parentControl`
// only ever supplied that text. Two sibling groups is the smallest shape that
// exposes it; a single-group fixture cannot.
describe('two sibling groups defined by the same extension', () => {
  const TWO_GROUPS = `<?xml version="1.0" encoding="utf-8"?>
<AxFormExtension xmlns:i="http://www.w3.org/2001/XMLSchema-instance" xmlns="Microsoft.Dynamics.AX.Metadata.V6">
\t<Name>ProdSetupReportFinished.ConExtension</Name>
\t<Controls>
\t\t<AxFormExtensionControl xmlns="">
\t\t\t<Name>FormExtensionControlgrp000001</Name>
\t\t\t<FormControl xmlns="" i:type="AxFormGroupControl">
\t\t\t\t<Name>ConFirstGroup</Name>
\t\t\t\t<Type>Group</Type>
\t\t\t\t<Controls>
\t\t\t\t\t<AxFormControl xmlns="" i:type="AxFormStringControl">
\t\t\t\t\t\t<Name>ConFirstGroup_Existing</Name>
\t\t\t\t\t</AxFormControl>
\t\t\t\t</Controls>
\t\t\t</FormControl>
\t\t\t<Parent>ProdSetupReportFinishedFields</Parent>
\t\t</AxFormExtensionControl>
\t\t<AxFormExtensionControl xmlns="">
\t\t\t<Name>FormExtensionControlgrp000002</Name>
\t\t\t<FormControl xmlns="" i:type="AxFormGroupControl">
\t\t\t\t<Name>ConSecondGroup</Name>
\t\t\t\t<Type>Group</Type>
\t\t\t\t<Controls>
\t\t\t\t\t<AxFormControl xmlns="" i:type="AxFormStringControl">
\t\t\t\t\t\t<Name>ConSecondGroup_Existing</Name>
\t\t\t\t\t</AxFormControl>
\t\t\t\t</Controls>
\t\t\t</FormControl>
\t\t\t<Parent>ProdSetupReportFinishedFields</Parent>
\t\t</AxFormExtensionControl>
\t</Controls>
</AxFormExtension>`;

  /** Children of the named group's nested <Controls>, in order. */
  const childrenOf = (xml: string, group: string): string[] => {
    const from = xml.indexOf(`<Name>${group}</Name>`);
    const open = xml.indexOf('<Controls>', from);
    const close = xml.indexOf('</Controls>', open);
    return [...xml.slice(open, close).matchAll(/<Name>([^<]+)<\/Name>/g)].map(m => m[1]);
  };

  it('inserts into the SECOND group when that is the one named', () => {
    const r = inserted(insertFormExtensionControl(TWO_GROUPS, spec({
      controlName: 'ConSecondGroup_Probe',
      parentControl: 'ConSecondGroup',
      dataField: 'AcceptError',
      dataSource: 'ProdParmReportFinished',
    })));

    expect(childrenOf(r.xml, 'ConSecondGroup')).toEqual([
      'ConSecondGroup_Existing', 'ConSecondGroup_Probe',
    ]);
    // The first group — which used to receive it — is untouched.
    expect(childrenOf(r.xml, 'ConFirstGroup')).toEqual(['ConFirstGroup_Existing']);
  });

  it('inserts into the FIRST group when that is the one named', () => {
    const r = inserted(insertFormExtensionControl(TWO_GROUPS, spec({
      controlName: 'ConFirstGroup_Probe',
      parentControl: 'ConFirstGroup',
    })));

    expect(childrenOf(r.xml, 'ConFirstGroup')).toEqual([
      'ConFirstGroup_Existing', 'ConFirstGroup_Probe',
    ]);
    expect(childrenOf(r.xml, 'ConSecondGroup')).toEqual(['ConSecondGroup_Existing']);
  });

  it('survives two successive calls naming different groups', () => {
    // The exact §11.3 sequence, which a single call cannot reproduce.
    const first = inserted(insertFormExtensionControl(TWO_GROUPS, spec({
      controlName: 'ConFirstGroup_Probe',
      parentControl: 'ConFirstGroup',
    })));
    const second = inserted(insertFormExtensionControl(first.xml, spec({
      controlName: 'ConSecondGroup_Probe',
      parentControl: 'ConSecondGroup',
    })));

    expect(childrenOf(second.xml, 'ConFirstGroup')).toEqual([
      'ConFirstGroup_Existing', 'ConFirstGroup_Probe',
    ]);
    expect(childrenOf(second.xml, 'ConSecondGroup')).toEqual([
      'ConSecondGroup_Existing', 'ConSecondGroup_Probe',
    ]);
    expect(findFormExtensionPlacementProblems(second.xml)).toEqual([]);
  });
});

describe('parent belonging to the base form → AxFormExtensionControl envelope', () => {
  it('wraps the control and references the parent by name', () => {
    const r = inserted(insertFormExtensionControl(FLAT_EXT, spec({
      controlName: 'Grid_ConDisableProdQty',
      parentControl: 'Grid',
    })));

    expect(r.representation).toBe('envelope');
    expect(r.xml).toContain('<Name>FormExtensionControlnew000001</Name>');
    expect(r.xml).toContain('<Parent>Grid</Parent>');
    expect(count(r.xml, '<AxFormExtensionControl')).toBe(2);
  });

  it('targets the ROOT collection even when a nested one closes first', () => {
    // The exact trap: parent is on the base form, but the file also contains an
    // extension-owned group whose </Controls> comes earlier in document order.
    const r = inserted(insertFormExtensionControl(nestedExt(), spec({
      controlName: 'TabHeaderGeneral_ConNote',
      parentControl: 'TabHeaderGeneral',
      dataField: 'ConNote',
    })));

    expect(r.representation).toBe('envelope');
    expect(nestedControlsBody(r.xml)).not.toContain('ConNote');
    expect(r.xml).toContain('<Parent>TabHeaderGeneral</Parent>');
    expect(count(r.xml, '<AxFormExtensionControl')).toBe(2);
  });
});

// ─── DataGroup-bound parent (report §6b) ─────────────────────────────────────

describe('parent bound to a table field group via <DataGroup>', () => {
  // Deliberately a warning, not a refusal. The base-form guard refuses because a
  // base-form <DataGroup> container generates its members, so an explicit control
  // duplicates one. An extension-created group generates nothing (§11.2 of the
  // report: a field-group member with no explicit control does not render), so
  // here the explicit control is the ONLY way to get the field onto the form —
  // refusing would send the caller to the VS designer to do the tool's job.
  it('writes the control and warns instead of refusing', () => {
    const r = inserted(insertFormExtensionControl(nestedExt({ dataGroup: true }), spec()));

    expect(nestedControlsBody(r.xml)).toContain('ConQualityOrders_ConDisableProdQty');
    expect(r.notes.join('\n')).toMatch(/DataGroup/);
  });

  it('names the control the designer Refresh would generate', () => {
    const r = inserted(insertFormExtensionControl(nestedExt({ dataGroup: true }), spec()));
    const note = r.notes.join('\n');

    expect(note).toContain('ConQualityOrders_ConDisableProdQty');
    expect(note).toContain('add-field-to-field-group');
  });

  it('says the field group alone will not render the field on an extension-owned group', () => {
    const note = inserted(insertFormExtensionControl(nestedExt({ dataGroup: true }), spec()))
      .notes.join('\n');

    expect(note).toMatch(/BASE-FORM/);
    expect(note).toMatch(/field group alone is NOT enough/);
  });

  // The advisory used to say "add the field to the field group INSTEAD" one
  // bullet before saying that doing so "will NOT put it on the form here", and
  // the op spec repeated the first half — so the model was told to take the
  // action the runtime documents as ineffective.
  it('asks for both halves rather than offering the field group as a substitute', () => {
    const note = inserted(insertFormExtensionControl(nestedExt({ dataGroup: true }), spec()))
      .notes.join('\n');

    expect(note).toMatch(/AS WELL/);
    expect(note).toMatch(/Both halves are required/);
    expect(note).not.toMatch(/field group instead/);
  });

  it('stays quiet when the parent has no DataGroup', () => {
    const r = inserted(insertFormExtensionControl(nestedExt(), spec()));
    expect(r.notes.join('\n')).not.toMatch(/DataGroup/);
  });
});

// ─── Collection variants ─────────────────────────────────────────────────────

describe('empty and self-closing collections', () => {
  const emptyGroup = nestedExt().replace(
    /\t\t\t\t<Controls>[\s\S]*?<\/Controls>\n/,
    '\t\t\t\t<Controls />\n',
  );

  it('expands a self-closing nested <Controls />, preserving its attributes', () => {
    const withAttrs = emptyGroup.replace('<Controls />', '<Controls xmlns="" />');
    const r = inserted(insertFormExtensionControl(withAttrs, spec()));

    expect(r.representation).toBe('nested');
    expect(r.xml).toContain('<Controls xmlns="">');
    expect(r.xml).toContain('<Name>ConQualityOrders_ConDisableProdQty</Name>');
    expect(r.xml).not.toContain('<Controls xmlns="" />');
  });

  it('expands a self-closing ROOT <Controls /> for a base-form parent', () => {
    const bare = FLAT_EXT.replace(/\t<Controls>[\s\S]*?\t<\/Controls>/, '\t<Controls />');
    const r = inserted(insertFormExtensionControl(bare, spec({ parentControl: 'Grid' })));

    expect(r.representation).toBe('envelope');
    expect(r.xml).toContain('<AxFormExtensionControl xmlns="">');
    expect(r.xml).not.toContain('<Controls />');
  });

  // Refusing here broke the tool's own two-step workflow: add-control can create
  // a group, and the group it writes has no <Controls> (innerControlLines emits
  // Name/Type/FormControlExtension only), so every "create a group, then fill
  // it" sequence failed on step two and sent the caller to Visual Studio.
  it('creates the <Controls> collection for a childless extension-owned parent', () => {
    const noControls = nestedExt().replace(/\t\t\t\t<Controls>[\s\S]*?<\/Controls>\n/, '');
    const r = inserted(insertFormExtensionControl(noControls, spec()));

    expect(r.representation).toBe('nested');
    expect(nestedControlsBody(r.xml)).toContain('ConQualityOrders_ConDisableProdQty');
    expect(findFormExtensionPlacementProblems(r.xml)).toEqual([]);
  });

  // Position is not a guess: across the 1088 shipped AxFormExtension files an
  // opening <Controls> follows <FormControlExtension> 2176 times and
  // <ControlModifications> 996 times, and nothing else — so inside a control it
  // goes straight after FormControlExtension, ahead of DataGroup/DataSource.
  it('puts the new collection after <FormControlExtension>, before the other properties', () => {
    const noControls = nestedExt({ dataGroup: true })
      .replace(/\t\t\t\t<Controls>[\s\S]*?<\/Controls>\n/, '');
    const r = inserted(insertFormExtensionControl(noControls, spec()));

    const ext = r.xml.indexOf('<FormControlExtension i:nil="true" />', r.xml.indexOf('ConQualityOrders'));
    const controls = r.xml.indexOf('<Controls>', ext);
    const dataGroup = r.xml.indexOf('<DataGroup>', ext);

    expect(ext).toBeLessThan(controls);
    expect(controls).toBeLessThan(dataGroup);
  });

  it('still refuses when there is no <FormControlExtension> to position against', () => {
    const noAnchor = nestedExt()
      .replace(/\t\t\t\t<Controls>[\s\S]*?<\/Controls>\n/, '')
      .replace('\t\t\t\t<FormControlExtension i:nil="true" />\n', '');
    const r = insertFormExtensionControl(noAnchor, spec());

    expect(r.kind).toBe('refused');
    expect((r as { message: string }).message).toMatch(/no <FormControlExtension>/);
  });
});

// ─── Idempotency ─────────────────────────────────────────────────────────────

describe('idempotency', () => {
  it('skips when the control already exists', () => {
    const r = insertFormExtensionControl(nestedExt(), spec({
      controlName: 'ConQualityOrders_ConDisableInventoryBlocking',
    }));
    expect(r.kind).toBe('exists');
  });

  it('is not fooled by a data source or field of the same name', () => {
    // The old check was `content.includes('<Name>' + controlName + '</Name>')`,
    // which also matched the extension's own <Name> and any element carrying one.
    const r = insertFormExtensionControl(nestedExt(), spec({
      controlName: 'InventTestGroup',
      parentControl: 'ConQualityOrders',
    }));
    expect(r.kind).toBe('inserted');
  });

  it('does not treat the auto-generated wrapper id as a control name', () => {
    const r = insertFormExtensionControl(nestedExt(), spec({
      parentControl: 'FormExtensionControlabc123xyz',
    }));
    // Resolves as a base-form parent (it is not a control), never as a nested one.
    expect(inserted(r).representation).toBe('envelope');
  });
});

// ─── previousSibling ─────────────────────────────────────────────────────────

describe('previousSibling', () => {
  const twoChildren = nestedExt().replace(
    '\t\t\t\t</Controls>',
    '\t\t\t\t\t<AxFormControl xmlns="" i:type="AxFormStringControl">\n' +
    '\t\t\t\t\t\t<Name>ConQualityOrders_ConComment</Name>\n' +
    '\t\t\t\t\t\t<Type>String</Type>\n' +
    '\t\t\t\t\t\t<FormControlExtension i:nil="true" />\n' +
    '\t\t\t\t\t</AxFormControl>\n' +
    '\t\t\t\t</Controls>',
  );

  it('inserts directly after the named sibling', () => {
    const r = inserted(insertFormExtensionControl(twoChildren, spec({
      previousSibling: 'ConQualityOrders_ConDisableInventoryBlocking',
    })));
    const body = nestedControlsBody(r.xml);

    expect(body.indexOf('ConDisableInventoryBlocking'))
      .toBeLessThan(body.indexOf('ConQualityOrders_ConDisableProdQty'));
    expect(body.indexOf('ConQualityOrders_ConDisableProdQty'))
      .toBeLessThan(body.indexOf('ConQualityOrders_ConComment'));
  });

  it('appends last and says so when the sibling is not found', () => {
    const r = inserted(insertFormExtensionControl(twoChildren, spec({
      previousSibling: 'NotAControl',
    })));

    expect(r.notes.join('\n')).toMatch(/NotAControl.*not found/);
  });

  // The envelope's position among the BASE FORM's children is carried by
  // <PositionType>/<PreviousSibling> next to <Parent>, not by splice order in
  // the extension's root <Controls>. Shipped evidence: 753 of the 1088
  // AxFormExtension files use exactly `Name, FormControl, Parent, PositionType,
  // PreviousSibling` (e.g. BusinessProcessActionLookup.Foundation.xml, which
  // positions RetailTaskActionType after TaskActionType in base-form group View).
  it('carries previousSibling into the envelope as PositionType/PreviousSibling', () => {
    const r = inserted(insertFormExtensionControl(FLAT_EXT, spec({
      parentControl: 'Grid',
      previousSibling: 'Grid_ConHasNotes',
    })));

    expect(r.representation).toBe('envelope');
    expect(r.xml).toContain('<PositionType>AfterItem</PositionType>');
    expect(r.xml).toContain('<PreviousSibling>Grid_ConHasNotes</PreviousSibling>');
    expect(r.notes.join('\n')).not.toMatch(/ignored/);
  });

  it('emits the position pair in the order shipped metadata uses', () => {
    const r = inserted(insertFormExtensionControl(FLAT_EXT, spec({
      parentControl: 'Grid',
      previousSibling: 'Grid_ConHasNotes',
    })));
    const at = (t: string) => r.xml.indexOf(t, r.xml.indexOf('FormExtensionControlnew000001'));

    expect(at('</FormControl>')).toBeLessThan(at('<Parent>'));
    expect(at('<Parent>')).toBeLessThan(at('<PositionType>'));
    expect(at('<PositionType>')).toBeLessThan(at('<PreviousSibling>'));
  });

  it('omits the pair entirely when no position was asked for', () => {
    const r = inserted(insertFormExtensionControl(FLAT_EXT, spec({ parentControl: 'Grid' })));

    expect(r.xml).not.toContain('<PositionType>');
    expect(r.xml).not.toContain('<PreviousSibling>');
  });
});

// ─── positionType ────────────────────────────────────────────────────────────

describe('positionType', () => {
  const onBaseForm = (over: Partial<FormExtensionControlSpec> = {}) =>
    insertFormExtensionControl(FLAT_EXT, spec({ parentControl: 'Grid', ...over }));

  it('writes Begin without a sibling', () => {
    const r = inserted(onBaseForm({ positionType: 'Begin' }));

    expect(r.xml).toContain('<PositionType>Begin</PositionType>');
    expect(r.xml).not.toContain('<PreviousSibling>');
  });

  it('treats End as the default and writes neither element', () => {
    const r = inserted(onBaseForm({ positionType: 'End' }));

    expect(r.xml).not.toContain('<PositionType>');
  });

  it('refuses AfterItem with no previousSibling to anchor it', () => {
    const r = onBaseForm({ positionType: 'AfterItem' });

    expect(r.kind).toBe('refused');
    expect((r as { message: string }).message).toMatch(/needs previousSibling/);
  });

  // Only AfterItem (765×) and Begin (182×) occur in the shipped corpus. An
  // unknown enum value is the failure mode this module exists to prevent —
  // it deserializes to a discarded node with the build reporting 0 errors.
  it('refuses a value that shipped metadata never uses', () => {
    const r = onBaseForm({ positionType: 'BeforeItem', previousSibling: 'Grid_ConHasNotes' });

    expect(r.kind).toBe('refused');
    expect((r as { message: string }).message).toMatch(/not a value D365FO/);
  });

  it('ignores previousSibling for Begin and says so', () => {
    const r = inserted(onBaseForm({ positionType: 'Begin', previousSibling: 'Grid_ConHasNotes' }));

    expect(r.notes.join('\n')).toMatch(/ignored/);
  });
});

// ─── Escaping ────────────────────────────────────────────────────────────────
//
// Every value here is interpolated into markup. None were escaped, so a label
// carrying an ampersand emitted XML that is not well-formed, and a value
// carrying markup could close its own element and smuggle a whole envelope into
// the nested <Controls> — the exact shape the deserializer silently discards.
// Real object names cannot contain either, which is why this never surfaced;
// labels are free text and can.

describe('escaping values on the way into XML', () => {
  it('escapes an ampersand in a label instead of emitting malformed XML', () => {
    const r = inserted(insertFormExtensionControl(nestedExt(), spec({
      label: 'Cost & freight',
    })));

    expect(r.xml).toContain('<Label>Cost &amp; freight</Label>');
    expect(r.xml).not.toContain('<Label>Cost & freight</Label>');
  });

  it('escapes markup in a field value rather than letting it become structure', () => {
    const payload =
      'ConDisableProdQty</DataField></AxFormControl>' +
      '<AxFormExtensionControl xmlns=""><Name>FormExtensionControlbad00001</Name>' +
      '<FormControl xmlns="" i:type="AxFormStringControl"><Name>Smuggled</Name></FormControl>' +
      '<Parent>ConQualityOrders</Parent></AxFormExtensionControl>' +
      '<AxFormControl xmlns="" i:type="AxFormStringControl"><DataField>Filler';

    const r = inserted(insertFormExtensionControl(nestedExt(), spec({ dataField: payload })));

    // Before escaping this produced a real <AxFormExtensionControl> inside the
    // parent's nested <Controls> and the write was abandoned by the post-write
    // guard. Now it is text, so there is nothing to abandon.
    expect(findFormExtensionPlacementProblems(r.xml)).toEqual([]);
    expect(r.xml).not.toContain('<Name>Smuggled</Name>');
    expect(r.xml).toContain('&lt;AxFormExtensionControl');
  });

  it('escapes the quote that would close an i:type attribute early', () => {
    const r = inserted(insertFormExtensionControl(nestedExt(), spec({
      iType: 'AxFormStringControl" evil="1',
    })));

    expect(r.xml).toContain('i:type="AxFormStringControl&quot; evil=&quot;1"');
    expect(r.xml).not.toContain('evil="1"');
  });

  it('does not double-escape an ampersand', () => {
    const r = inserted(insertFormExtensionControl(nestedExt(), spec({ label: 'A &lt; B' })));

    expect(r.xml).toContain('<Label>A &amp;lt; B</Label>');
    expect(r.xml).not.toContain('&amp;amp;');
  });

  // Escaping on write only holds up if reading undoes it: the idempotency check
  // compares the caller's spelling against the name in the file, so an escaped
  // name that decodes to something else would let the control be added twice.
  it('round-trips an escaped name through the idempotency check', () => {
    const first = inserted(insertFormExtensionControl(nestedExt(), spec({
      controlName: 'Weird & Name',
    })));
    const second = insertFormExtensionControl(first.xml, spec({ controlName: 'Weird & Name' }));

    expect(first.xml).toContain('<Name>Weird &amp; Name</Name>');
    expect(second.kind).toBe('exists');
  });

  it('resolves an escaped parent name and an escaped previousSibling', () => {
    const withOddParent = nestedExt().replace(
      '<Name>ConQualityOrders</Name>',
      '<Name>Quality &amp; Orders</Name>',
    );
    const r = inserted(insertFormExtensionControl(withOddParent, spec({
      parentControl: 'Quality & Orders',
      previousSibling: 'ConQualityOrders_ConDisableInventoryBlocking',
    })));

    expect(r.representation).toBe('nested');
  });
});

// ─── The abandoned-write message ─────────────────────────────────────────────
//
// Not reachable from ordinary input: the writer's output is clean on all 1088
// shipped extensions, and escaping closed the one route that reached it (a
// dataField payload that smuggled an envelope into the nested <Controls>). The
// message builder is exported so the naming it does is still pinned.

describe('buildAbandonedWriteMessage', () => {
  // Lazy: SHAPE_C is declared further down the file, so reading it while the
  // describe body runs would hit the temporal dead zone.
  const problems = () => findFormExtensionPlacementProblems(SHAPE_C);

  it('names the form extension in the banner, not the control', () => {
    const message = buildAbandonedWriteMessage(SHAPE_C, 'ConQualityOrders_ConDisableProdQty', problems());

    // The banner slot identifies the object whose XML is wrong — the control
    // name used to be passed straight into it.
    expect(message).toContain('form-extension "InventTestGroup.ConExtension"');
    expect(message).not.toContain('form-extension "ConQualityOrders_ConDisableProdQty"');
  });

  it('still names the control, in the sentence that describes the action', () => {
    const message = buildAbandonedWriteMessage(SHAPE_C, 'ConQualityOrders_ConDisableProdQty', problems());

    expect(message).toMatch(/while adding "ConQualityOrders_ConDisableProdQty"/);
    expect(message).toMatch(/ABANDONED/);
    expect(message).toMatch(/report it with the extension XML/);
  });

  it('says so rather than inventing a name when the document will not parse', () => {
    const message = buildAbandonedWriteMessage('not xml at all', 'SomeControl', problems());

    expect(message).toContain('(unparseable form extension)');
  });
});

// ─── Refusing shapes we don't understand ─────────────────────────────────────

describe('safety', () => {
  it('declines anything that is not an AxFormExtension', () => {
    const table = `<?xml version="1.0" encoding="utf-8"?>
<AxTable xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
\t<Name>ConTable</Name>
\t<Controls>
\t</Controls>
</AxTable>`;
    expect(insertFormExtensionControl(table, spec()).kind).toBe('unsupported');
  });

  it('declines unbalanced XML instead of splicing into it', () => {
    const broken = nestedExt().replace('</AxFormExtension>', '');
    expect(insertFormExtensionControl(broken, spec()).kind).toBe('unsupported');
  });

  it('declines an extension with no <Controls> collection', () => {
    const noControls = FLAT_EXT.replace(/\t<Controls>[\s\S]*?\t<\/Controls>\n/, '');
    expect(insertFormExtensionControl(noControls, spec({ parentControl: 'Grid' })).kind)
      .toBe('unsupported');
  });

  it('is not confused by CDATA containing angle brackets', () => {
    const withSource = nestedExt().replace(
      '\t<ControlModifications />',
      '\t<SourceCode>\n' +
      '\t\t<Methods>\n' +
      '\t\t\t<Method>\n' +
      '\t\t\t\t<Name>init</Name>\n' +
      '\t\t\t\t<Source><![CDATA[\npublic void init()\n{\n    if (a < b) { }\n    // </Controls>\n}\n]]></Source>\n' +
      '\t\t\t</Method>\n' +
      '\t\t</Methods>\n' +
      '\t</SourceCode>',
    );
    const r = inserted(insertFormExtensionControl(withSource, spec()));

    expect(r.representation).toBe('nested');
    expect(nestedControlsBody(r.xml)).toContain('ConQualityOrders_ConDisableProdQty');
  });

  it('preserves every byte outside the insertion point (control)', () => {
    const r = inserted(insertFormExtensionControl(nestedExt(), spec()));
    // Anchor on the NEW control so the pre-existing sibling isn't what gets cut.
    const stripped = r.xml.replace(
      /\n\t{5}<AxFormControl [^>]*>\n\t{6}<Name>ConQualityOrders_ConDisableProdQty<\/Name>[\s\S]*?<\/AxFormControl>/,
      '',
    );

    expect(stripped).toBe(nestedExt());
  });
});

// ─── Placement validation ────────────────────────────────────────────────────
//
// Build test, 2026-08-12 (xppc framework 10.0.2645.99): the malformed
// file compiles at exit 0 / 0 errors. The deserializer DISCARDS the misplaced
// node — the control never reaches the form. The only trace was a single extra
// metadata warning ("The form control has different fields from the field group
// … Use restore on the form control"), which names neither the control nor the
// malformed node, arrived among 52 pre-existing warnings, and only exists
// because this parent is DataGroup-bound and so had two field sets to compare.
//
// That makes validation the last line of defence rather than a nicety: nothing
// downstream reports it, so anything that slips past here ships silently.

/** The exact bad output from the report: an envelope inside the nested <Controls>. */
const SHAPE_C = `<?xml version="1.0" encoding="utf-8"?>
<AxFormExtension xmlns:i="http://www.w3.org/2001/XMLSchema-instance" xmlns="Microsoft.Dynamics.AX.Metadata.V6">
\t<Name>InventTestGroup.ConExtension</Name>
\t<Controls>
\t\t<AxFormExtensionControl xmlns="">
\t\t\t<Name>FormExtensionControlabc123xyz</Name>
\t\t\t<FormControl xmlns="" i:type="AxFormGroupControl">
\t\t\t\t<Name>ConQualityOrders</Name>
\t\t\t\t<Controls>
\t\t\t\t\t<AxFormControl xmlns="" i:type="AxFormCheckBoxControl">
\t\t\t\t\t\t<Name>ConQualityOrders_ConDisableInventoryBlocking</Name>
\t\t\t\t\t</AxFormControl>
\t\t\t\t\t<AxFormExtensionControl xmlns="">
\t\t\t\t\t\t<Name>FormExtensionControllhc7hmswk</Name>
\t\t\t\t\t\t<FormControl xmlns="" i:type="AxFormComboBoxControl">
\t\t\t\t\t\t\t<Name>ConQualityOrders_ConDisableProdQty</Name>
\t\t\t\t\t\t\t<Type>ComboBox</Type>
\t\t\t\t\t\t\t<Items />
\t\t\t\t\t\t</FormControl>
\t\t\t\t\t\t<Parent>ConQualityOrders</Parent>
\t\t\t\t\t</AxFormExtensionControl>
\t\t\t\t</Controls>
\t\t\t\t<DataGroup>ConQualityOrders</DataGroup>
\t\t\t</FormControl>
\t\t\t<Parent>TabHeaderGeneral</Parent>
\t\t</AxFormExtensionControl>
\t</Controls>
</AxFormExtension>`;

describe('placement validation', () => {
  it('flags an AxFormExtensionControl nested inside a control\'s <Controls>', () => {
    const problems = findFormExtensionPlacementProblems(SHAPE_C);

    expect(problems).toHaveLength(1);
    expect(problems[0].element).toBe('AxFormExtensionControl');
    expect(problems[0].line).toBe(13);
    // The consequence has to be stated: a reader who sees "0 errors" otherwise
    // concludes the file is fine.
    expect(problems[0].detail).toMatch(/DISCARDS/);
  });

  it('flags a bare AxFormControl left in the extension\'s root <Controls>', () => {
    // The inverse mistake: nested shape used where the envelope belongs.
    const inverted = `<?xml version="1.0" encoding="utf-8"?>
<AxFormExtension xmlns:i="http://www.w3.org/2001/XMLSchema-instance" xmlns="Microsoft.Dynamics.AX.Metadata.V6">
\t<Name>CustGroup.ConExtension</Name>
\t<Controls>
\t\t<AxFormControl xmlns="" i:type="AxFormCheckBoxControl">
\t\t\t<Name>Grid_ConHasNotes</Name>
\t\t</AxFormControl>
\t</Controls>
</AxFormExtension>`;
    const problems = findFormExtensionPlacementProblems(inverted);

    expect(problems).toHaveLength(1);
    expect(problems[0].element).toBe('AxFormControl');
  });

  it('passes both correct shapes', () => {
    expect(findFormExtensionPlacementProblems(FLAT_EXT)).toEqual([]);
    expect(findFormExtensionPlacementProblems(nestedExt())).toEqual([]);
    expect(findFormExtensionPlacementProblems(nestedExt({ dataGroup: true }))).toEqual([]);
  });

  it('passes everything this writer produces', () => {
    for (const [xml, s] of [
      [nestedExt(), spec()],
      [FLAT_EXT, spec({ parentControl: 'Grid' })],
      [nestedExt(), spec({ parentControl: 'TabHeaderGeneral' })],
    ] as const) {
      const r = inserted(insertFormExtensionControl(xml, s));
      expect(findFormExtensionPlacementProblems(r.xml)).toEqual([]);
    }
  });

  it('is reachable from the hand-written xmlContent gate', () => {
    // Every element in SHAPE_C is spelled correctly, so the name-based checks
    // alone returned 0 problems and let it through.
    expect(validateFormExtensionControlShape(SHAPE_C).length).toBeGreaterThan(0);
    expect(validateFormExtensionControlShape(FLAT_EXT)).toEqual([]);
  });

  it('stays quiet on files it does not understand', () => {
    expect(findFormExtensionPlacementProblems('<AxTable><Controls><Foo /></Controls></AxTable>')).toEqual([]);
    expect(findFormExtensionPlacementProblems('not xml at all')).toEqual([]);
  });
});

// ─── Repairing a file an earlier release damaged ─────────────────────────────
//
// SHAPE_C is not a hypothetical: it is the output the shipped writer produced.
// Whoever hits this bug has files in this state, and the release that fixes the
// writer is the one they will run against them — so every guard added here has
// to leave the repair path open. The post-write check gates on problems this
// write INTRODUCED, never on the file's existing ones.

describe('a file already damaged by the old writer', () => {
  it('accepts a correct write instead of refusing over the pre-existing damage', () => {
    const r = inserted(insertFormExtensionControl(SHAPE_C, spec({
      controlName: 'ConQualityOrders_ConComment',
    })));

    expect(nestedControlsBody(r.xml)).toContain('ConQualityOrders_ConComment');
    // Untouched: the write neither caused nor silently cleaned up the old node.
    expect(findFormExtensionPlacementProblems(r.xml)).toHaveLength(1);
  });

  it('reports the pre-existing damage rather than blaming the caller for it', () => {
    const r = inserted(insertFormExtensionControl(SHAPE_C, spec({
      controlName: 'ConQualityOrders_ConComment',
    })));

    expect(r.notes.join('\n')).toMatch(/already contained 1 misplaced control/);
    expect(r.notes.join('\n')).toMatch(/neither caused nor fixed/);
  });

  // The natural repair — re-run the identical add-control — used to answer
  // "already present, skipped (idempotent)" and write nothing, because the
  // discarded control's <Name> is perfectly readable where it lies.
  it('does not count a discarded control as already present', () => {
    const r = insertFormExtensionControl(SHAPE_C, spec());

    expect(r.kind).toBe('inserted');
    expect(inserted(r).notes.join('\n')).toMatch(/dead copy/);
  });

  it('leaves the file repaired, so a second identical call is idempotent again', () => {
    const first = inserted(insertFormExtensionControl(SHAPE_C, spec()));
    const second = insertFormExtensionControl(first.xml, spec());

    expect(second.kind).toBe('exists');
  });

  // Nesting into a dead parent buys a second discarded control and another ✅.
  it('refuses to use a discarded control as the parent', () => {
    const r = insertFormExtensionControl(SHAPE_C, spec({
      controlName: 'ConSomethingNew',
      parentControl: 'ConQualityOrders_ConDisableProdQty',
    }));

    expect(r.kind).toBe('refused');
    expect((r as { message: string }).message).toMatch(/discards/);
  });
});
