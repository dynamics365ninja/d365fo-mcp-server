/**
 * <ControlModifications> writer for AxFormExtension (VM-free).
 *
 * Regression: eval case L2-form-control-removal-lifecycle (run 2026-08-23) probed
 * the remedy that `remove-control`'s own refusal message recommends — "hide it
 * with modify-property on a form extension" — and found it unimplemented and
 * unreported:
 *
 *   {controlName:"HeaderNoteId", propertyPath:"Visible", propertyValue:"No"}
 *     → ✅, but wrote a FORM-level <AxPropertyModification>, hiding the whole form.
 *   {propertyPath:"HeaderNoteId.Visible"}
 *     → ✅ with no warning, writing a root property literally named
 *       "HeaderNoteId.Visible", which is not a member of AxFormExtension.
 *
 * Both are the ✅-reported-wrong-write family this catalog exists to catch. The
 * shapes asserted below are measured against the shipped AOT (ApplicationSuite +
 * ApplicationFoundation + ApplicationPlatform: 416 AxFormExtension files, 83 with
 * a non-empty <ControlModifications>, 1102 property modifications, 0 duplicate
 * envelope <Name>s, and <Controls> as the next sibling in 83 of 83).
 */

import { describe, it, expect } from 'vitest';
import {
  upsertFormExtensionControlProperty,
  resolveControlPropertyTarget,
} from '../../src/utils/formExtensionControlModifications';

/** A form extension as `d365fo_file(action="create")` scaffolds one. */
const SCAFFOLD = `<?xml version="1.0" encoding="utf-8"?>
<AxFormExtension xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
	<Name>MyForm.Extension</Name>
	<ControlModifications />
	<Controls />
</AxFormExtension>`;

/** The shipped shape: an extension that already modifies one control. */
const POPULATED = `<?xml version="1.0" encoding="utf-8"?>
<AxFormExtension xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
	<Name>CustGroup.Extension</Name>
	<ControlModifications>
		<AxExtensionModification xmlns="">
			<Name>ButtonGroup</Name>
			<PropertyModifications>
				<AxPropertyModification>
					<Name>Visible</Name>
					<Value>No</Value>
				</AxPropertyModification>
			</PropertyModifications>
		</AxExtensionModification>
	</ControlModifications>
	<Controls />
</AxFormExtension>`;

function ok(r: ReturnType<typeof upsertFormExtensionControlProperty>) {
  if (!r.ok) throw new Error(`expected success, got: ${r.reason}`);
  return r;
}

describe('upsertFormExtensionControlProperty — the collection does not exist yet', () => {
  it('expands a self-closing <ControlModifications /> into the shipped shape', () => {
    const r = ok(upsertFormExtensionControlProperty(SCAFFOLD, 'HeaderNoteId', 'Visible', 'No'));
    expect(r.changed).toBe(true);
    expect(r.xml).toContain('<ControlModifications>');
    expect(r.xml).toContain('<AxExtensionModification xmlns="">');
    expect(r.xml).toContain('<Name>HeaderNoteId</Name>');
    expect(r.xml).toContain('<Name>Visible</Name>');
    expect(r.xml).toContain('<Value>No</Value>');
    // The defect being fixed: nothing may land in the extension's OWN properties.
    expect(r.xml).not.toMatch(/<AxFormExtension[^>]*>[\s\S]*?<PropertyModifications>[\s\S]*?<\/PropertyModifications>[\s\S]*?<ControlModifications>/);
  });

  it('keeps <Controls> as the next sibling — the 83-of-83 shipped placement', () => {
    const r = ok(upsertFormExtensionControlProperty(SCAFFOLD, 'Grid', 'Visible', 'No'));
    const cm = r.xml.indexOf('</ControlModifications>');
    const controls = r.xml.indexOf('<Controls');
    expect(cm).toBeGreaterThan(0);
    expect(controls).toBeGreaterThan(cm);
  });

  it('inserts the collection ahead of <Controls> when it is absent entirely', () => {
    const xml = SCAFFOLD.replace('\t<ControlModifications />\n', '');
    const r = ok(upsertFormExtensionControlProperty(xml, 'Grid', 'Enabled', 'No'));
    expect(r.xml.indexOf('<ControlModifications>')).toBeLessThan(r.xml.indexOf('<Controls'));
  });

  it('declines — rather than guessing a position — with no anchor to measure from', () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<AxFormExtension xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
	<Name>MyForm.Extension</Name>
</AxFormExtension>`;
    const r = upsertFormExtensionControlProperty(xml, 'Grid', 'Visible', 'No');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/no measured position/);
  });
});

describe('upsertFormExtensionControlProperty — the collection exists', () => {
  it('adds a second control as its own envelope, leaving the first alone', () => {
    const r = ok(upsertFormExtensionControlProperty(POPULATED, 'Shipments', 'Visible', 'No'));
    expect(r.xml).toContain('<Name>ButtonGroup</Name>');
    expect(r.xml).toContain('<Name>Shipments</Name>');
    expect(r.xml.match(/<AxExtensionModification/g)).toHaveLength(2);
  });

  it('joins the EXISTING envelope for a second property — 0 shipped files repeat a <Name>', () => {
    const r = ok(upsertFormExtensionControlProperty(POPULATED, 'ButtonGroup', 'Enabled', 'No'));
    expect(r.xml.match(/<AxExtensionModification/g)).toHaveLength(1);
    expect(r.xml.match(/<AxPropertyModification>/g)).toHaveLength(2);
    expect(r.xml).toContain('<Name>Enabled</Name>');
  });

  /**
   * The first cut of this writer passed every `toContain` assertion above while
   * emitting `\t\t\t\t\t\t\t<AxPropertyModification>` inside a `\t\t\t\t`
   * collection: it inserted at `closeStart` without consuming the closing tag's
   * own indent. Substring assertions cannot see that, so siblings are compared
   * by indentation depth here — the same anchoring rule
   * xml-writer-nesting-scope-trap prescribes for these writers.
   */
  it.each([
    ['a second property', 'ButtonGroup', 'Enabled', /^(\t+)<AxPropertyModification>$/gm],
    ['a second control', 'Shipments', 'Visible', /^(\t+)<AxExtensionModification xmlns="">$/gm],
  ])('indents %s to the same depth as its sibling', (_what, control, property, re) => {
    const r = ok(upsertFormExtensionControlProperty(POPULATED, control, property, 'No'));
    const depths = [...r.xml.matchAll(re)].map(m => m[1].length);
    expect(depths).toHaveLength(2);
    expect(depths[0]).toBe(depths[1]);
  });

  it('leaves no line indented deeper than its parent collection', () => {
    let xml = POPULATED;
    for (const [c, p] of [['ButtonGroup', 'Enabled'], ['Shipments', 'Visible'], ['Grid', 'Caption']]) {
      const r = ok(upsertFormExtensionControlProperty(xml, c, p, 'No'));
      xml = r.xml;
    }
    // Every <AxPropertyModification> sits exactly one tab inside a <PropertyModifications>.
    const propDepths = [...xml.matchAll(/^(\t+)<PropertyModifications>$/gm)].map(m => m[1].length);
    const modDepths = [...xml.matchAll(/^(\t+)<AxPropertyModification>$/gm)].map(m => m[1].length);
    expect(new Set(modDepths).size).toBe(1);
    expect(modDepths[0]).toBe(propDepths[0] + 1);
  });

  it('updates the value in place when the property is already modified', () => {
    const r = ok(upsertFormExtensionControlProperty(POPULATED, 'ButtonGroup', 'Visible', 'Yes'));
    expect(r.changed).toBe(true);
    expect(r.xml).toContain('<Value>Yes</Value>');
    expect(r.xml).not.toContain('<Value>No</Value>');
    expect(r.xml.match(/<AxPropertyModification>/g)).toHaveLength(1);
  });

  it('is idempotent — re-issuing the same call writes nothing', () => {
    const r = ok(upsertFormExtensionControlProperty(POPULATED, 'ButtonGroup', 'Visible', 'No'));
    expect(r.changed).toBe(false);
    expect(r.xml).toBe(POPULATED);
  });

  it('matches the control name case-insensitively rather than opening a duplicate envelope', () => {
    const r = ok(upsertFormExtensionControlProperty(POPULATED, 'buttongroup', 'Visible', 'Yes'));
    expect(r.xml.match(/<AxExtensionModification/g)).toHaveLength(1);
  });
});

describe('upsertFormExtensionControlProperty — refusals and escaping', () => {
  it('escapes XML metacharacters in the value', () => {
    const r = ok(upsertFormExtensionControlProperty(SCAFFOLD, 'Grid', 'Caption', 'A & B <c>'));
    expect(r.xml).toContain('<Value>A &amp; B &lt;c&gt;</Value>');
  });

  it.each([
    ['control', 'Head.erId', 'Visible'],
    ['property', 'HeaderNoteId', 'Vis ible'],
  ])('refuses a %s name that is not a plain identifier', (_what, control, property) => {
    const r = upsertFormExtensionControlProperty(SCAFFOLD, control, property, 'No');
    expect(r.ok).toBe(false);
  });

  it('refuses a document that is not a form extension', () => {
    const r = upsertFormExtensionControlProperty(
      '<?xml version="1.0"?>\n<AxForm><Name>X</Name><Controls /></AxForm>',
      'Grid', 'Visible', 'No',
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/AxFormExtension/);
  });

  it('refuses unbalanced XML instead of splicing into it', () => {
    const r = upsertFormExtensionControlProperty(
      '<AxFormExtension><Name>X</Name><Controls />',
      'Grid', 'Visible', 'No',
    );
    expect(r.ok).toBe(false);
  });
});

describe('resolveControlPropertyTarget — both spellings the tool receives', () => {
  it('reads an explicit controlName', () => {
    expect(resolveControlPropertyTarget('Visible', 'HeaderNoteId'))
      .toEqual({ controlName: 'HeaderNoteId', propertyName: 'Visible' });
  });

  it('reads the dotted path that used to be written verbatim as a property name', () => {
    expect(resolveControlPropertyTarget('HeaderNoteId.Visible'))
      .toEqual({ controlName: 'HeaderNoteId', propertyName: 'Visible' });
  });

  it('leaves a bare property to the generic writer — that is the extension\'s own', () => {
    expect(resolveControlPropertyTarget('ConfigurationKey')).toBeNull();
  });

  it('does not read a three-segment path as a control target', () => {
    expect(resolveControlPropertyTarget('A.B.C')).toBeNull();
  });
});

/**
 * Line endings, the thing a clean build cannot tell you about.
 *
 * Every block this module splices in is built with '\n', while AOT metadata on
 * disk is CRLF with a BOM. So a real insert left the file MIXED: CRLF on every
 * pre-existing line and LF on the new ones. xppc accepts that — the eval run
 * exercising this writer built 0 errors — but Visual Studio, VCS diffs and any
 * byte-comparison against a golden do not, and nothing here asserted it.
 */
describe('line endings follow the host document', () => {
  const crlf = [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<AxFormExtension xmlns:i="http://www.w3.org/2001/XMLSchema-instance">',
    '\t<Name>MyForm.Ext</Name>',
    '\t<ControlModifications />',
    '\t<Controls />',
    '</AxFormExtension>',
  ].join('\r\n');

  it('writes CRLF into a CRLF document, with none left LF-only', () => {
    const out = upsertFormExtensionControlProperty(crlf, 'HeaderNoteId', 'Visible', 'No');
    if (!out.ok) throw new Error(out.reason);
    expect(out.changed).toBe(true);
    // The inserted block is really there...
    expect(out.xml).toContain('<Name>HeaderNoteId</Name>');
    // ...and every newline in the whole document is a CRLF.
    expect(out.xml.replace(/\r\n/g, '')).not.toContain('\n');
  });

  it('leaves an LF document entirely LF', () => {
    const lf = crlf.replace(/\r\n/g, '\n');
    const out = upsertFormExtensionControlProperty(lf, 'HeaderNoteId', 'Visible', 'No');
    if (!out.ok) throw new Error(out.reason);
    expect(out.xml).not.toContain('\r');
  });
});
