/**
 * Eval golden oracle — normalize + diff + score.
 * Fixtures are inline (NOT the gitignored eval/goldens/) so the harness is
 * self-contained and runs in CI without the VM.
 */

import { describe, it, expect } from 'vitest';
import {
  normalizeAotXml,
  normalizeMultiArtifact,
  renderNormalized,
  globToRegExp,
  diffNormalized,
  scoreRun,
  evaluate,
  evaluateMulti,
  canonicalizePrefix,
  GOLDEN_CAPTURE_PREFIX,
} from '../../src/eval/oracle/index';

const ENUM_GOLDEN = `<?xml version="1.0" encoding="utf-8"?>
<AxEnum xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
  <Name>ContosoXyzNoteStatus</Name>
  <Label>Note status</Label>
  <UseEnumValue>No</UseEnumValue>
  <IsExtensible>true</IsExtensible>
  <EnumValues>
    <AxEnumValue><Name>Draft</Name><Label>Draft</Label></AxEnumValue>
    <AxEnumValue><Name>Active</Name><Label>Active</Label></AxEnumValue>
    <AxEnumValue><Name>Archived</Name><Label>Archived</Label></AxEnumValue>
  </EnumValues>
</AxEnum>`;

// Same enum, values REORDERED — must still match (collections are order-independent).
const ENUM_REORDERED = `<?xml version="1.0" encoding="utf-8"?>
<AxEnum xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
  <Name>ContosoXyzNoteStatus</Name>
  <Label>Note status</Label>
  <UseEnumValue>No</UseEnumValue>
  <IsExtensible>true</IsExtensible>
  <EnumValues>
    <AxEnumValue><Name>Archived</Name><Label>Archived</Label></AxEnumValue>
    <AxEnumValue><Name>Draft</Name><Label>Draft</Label></AxEnumValue>
    <AxEnumValue><Name>Active</Name><Label>Active</Label></AxEnumValue>
  </EnumValues>
</AxEnum>`;

describe('globToRegExp', () => {
  it('matches ** across segments and * within a segment', () => {
    expect(globToRegExp('**/ModelSaveInfo').test('AxEnum/ModelSaveInfo')).toBe(true);
    expect(globToRegExp('**/ModelSaveInfo').test('ModelSaveInfo')).toBe(true);
    expect(globToRegExp('AxEnum/*/Label').test('AxEnum/EnumValues/Label')).toBe(true);
    expect(globToRegExp('AxEnum/*/Label').test('AxEnum/a/b/Label')).toBe(false);
  });
});

describe('normalizeAotXml', () => {
  it('flattens elements + attributes to a path → value map', async () => {
    const map = await normalizeAotXml(ENUM_GOLDEN);
    expect(map.get('AxEnum/Name')).toBe('ContosoXyzNoteStatus');
    expect(map.get('AxEnum/UseEnumValue')).toBe('No');
    expect(map.get('AxEnum/IsExtensible')).toBe('true');
    // Collection members keyed by <Name>, not position.
    expect(map.get('AxEnum/EnumValues/AxEnumValue[Draft]/Label')).toBe('Draft');
    expect(map.get('AxEnum/EnumValues/AxEnumValue[Archived]/Label')).toBe('Archived');
  });

  it('captures the i:type attribute as @type (field base type)', async () => {
    const xml = `<AxTableExtension xmlns:i="http://x"><Fields>
      <AxTableField i:type="AxTableFieldInt"><Name>NotePriority</Name>
        <ExtendedDataType>Counter</ExtendedDataType></AxTableField>
    </Fields></AxTableExtension>`;
    const map = await normalizeAotXml(xml);
    expect(map.get('AxTableExtension/Fields/AxTableField[NotePriority]/@type')).toBe('AxTableFieldInt');
    expect(map.get('AxTableExtension/Fields/AxTableField[NotePriority]/ExtendedDataType')).toBe('Counter');
  });

  it('strips ModelSaveInfo and @Id by default', async () => {
    const xml = `<AxEnum><Name>X</Name><Id>123</Id>
      <ModelSaveInfo><Name>foo</Name></ModelSaveInfo></AxEnum>`;
    const rendered = renderNormalized(await normalizeAotXml(xml));
    expect(rendered).not.toContain('ModelSaveInfo');
    expect(rendered).not.toContain('/Id =');
    expect(rendered).toContain('AxEnum/Name = X');
  });

  it('treats CRLF and LF line endings as equivalent (bridge writes CRLF; a hand-authored golden may use LF)', async () => {
    const crlf = `<AxClass><Name>X</Name><SourceCode><Declaration><![CDATA[\r\nclass X\r\n{\r\n}\r\n\r\n]]></Declaration></SourceCode></AxClass>`;
    const lf = `<AxClass><Name>X</Name><SourceCode><Declaration><![CDATA[\nclass X\n{\n}\n\n]]></Declaration></SourceCode></AxClass>`;
    const a = await normalizeAotXml(crlf);
    const b = await normalizeAotXml(lf);
    expect(diffNormalized(a, b).matched).toBe(true);
  });

  it('honors per-case ignore globs', async () => {
    const xml = `<AxTable><Name>T</Name><DeveloperDocumentation>doc</DeveloperDocumentation></AxTable>`;
    const map = await normalizeAotXml(xml, ['**/DeveloperDocumentation']);
    expect(map.has('AxTable/DeveloperDocumentation')).toBe(false);
    expect(map.get('AxTable/Name')).toBe('T');
  });

  // Regression: AxFormExtensionControl's own <Name> is a bridge-generated wrapper
  // id ("FormExtensionControl" + random lowercase/digit suffix) — using it as the
  // collection key made two independently-generated artifacts of the SAME logical
  // control (same nested FormControl/Name, different random wrapper id)
  // structurally false-mismatch on the whole subtree. Fixed by preferring the
  // nested stable name when the wrapper's own Name looks auto-generated.
  it('keys AxFormExtensionControl by the nested FormControl/Name, not the random wrapper Name', async () => {
    const xml = `<AxFormExtension xmlns:i="http://x"><Controls>
      <AxFormExtensionControl>
        <Name>FormExtensionControlfse38xiwz</Name>
        <FormControl i:type="AxFormCheckBoxControl">
          <Name>Grid_ContosoHasNotes</Name>
          <DataField>ContosoHasNotes</DataField>
        </FormControl>
        <Parent>Grid</Parent>
      </AxFormExtensionControl>
    </Controls></AxFormExtension>`;
    const map = await normalizeAotXml(xml);
    // FormControl itself is also keyed by its own Name (pre-existing behavior for any
    // single Name-bearing child) — the fix is the OUTER AxFormExtensionControl key.
    expect(map.get('AxFormExtension/Controls/AxFormExtensionControl[Grid_ContosoHasNotes]/FormControl[Grid_ContosoHasNotes]/DataField'))
      .toBe('ContosoHasNotes');
    expect(map.get('AxFormExtension/Controls/AxFormExtensionControl[Grid_ContosoHasNotes]/Parent')).toBe('Grid');
    // The wrapper's own random Name is still recorded as a leaf value (under the stable key) —
    // just no longer used as the KEY itself.
    expect(map.get('AxFormExtension/Controls/AxFormExtensionControl[Grid_ContosoHasNotes]/Name'))
      .toBe('FormExtensionControlfse38xiwz');
  });

  it('two independently-generated wrapper ids for the same logical control align under the same key', async () => {
    const build = (wrapperId: string) => `<AxFormExtension xmlns:i="http://x"><Controls>
      <AxFormExtensionControl>
        <Name>FormExtensionControl${wrapperId}</Name>
        <FormControl i:type="AxFormCheckBoxControl">
          <Name>Grid_ContosoHasNotes</Name>
          <DataField>ContosoHasNotes</DataField>
        </FormControl>
        <Parent>Grid</Parent>
      </AxFormExtensionControl>
    </Controls></AxFormExtension>`;
    const golden = await normalizeAotXml(build('fse38xiwz'), ['**/AxFormExtensionControl/Name']);
    const actual = await normalizeAotXml(build('qzr91mdko'), ['**/AxFormExtensionControl/Name']);
    expect(diffNormalized(golden, actual).matched).toBe(true);
  });

  it('does not treat a genuinely stable Name as auto-generated (no false positives on normal collections)', async () => {
    const xml = `<AxTable><Fields>
      <AxTableField i:type="AxTableFieldString"><Name>NoteId</Name></AxTableField>
    </Fields></AxTable>`;
    const map = await normalizeAotXml(xml);
    expect(map.get('AxTable/Fields/AxTableField[NoteId]/@type')).toBe('AxTableFieldString');
  });
});

describe('diffNormalized', () => {
  it('reports a clean match for identical documents', async () => {
    const a = await normalizeAotXml(ENUM_GOLDEN);
    const b = await normalizeAotXml(ENUM_GOLDEN);
    expect(diffNormalized(a, b).matched).toBe(true);
  });

  it('treats a reordered collection as a match', async () => {
    const golden = await normalizeAotXml(ENUM_GOLDEN);
    const actual = await normalizeAotXml(ENUM_REORDERED);
    expect(diffNormalized(golden, actual).matched).toBe(true);
  });

  it('classifies missing / extra / changed deltas', async () => {
    const golden = await normalizeAotXml(ENUM_GOLDEN);
    const broken = await normalizeAotXml(
      ENUM_GOLDEN.replace('<UseEnumValue>No</UseEnumValue>', '<UseEnumValue>Yes</UseEnumValue>')
        .replace('<AxEnumValue><Name>Archived</Name><Label>Archived</Label></AxEnumValue>', '')
        .replace('<Label>Note status</Label>', '<Label>Note status</Label><HelpText>extra</HelpText>'),
    );
    const d = diffNormalized(golden, broken);
    expect(d.matched).toBe(false);
    expect(d.changed.some(c => c.path === 'AxEnum/UseEnumValue' && c.expected === 'No' && c.actual === 'Yes')).toBe(true);
    expect(d.missing).toContain('AxEnum/EnumValues/AxEnumValue[Archived]/Label');
    expect(d.extra).toContain('AxEnum/HelpText');
  });
});

describe('scoreRun', () => {
  it('build is a hard gate; bp_clean and golden_match layered', () => {
    const matched = { matched: true, missing: [], extra: [], changed: [] };
    expect(scoreRun({ build: { succeeded: true, bpWarnings: [] }, goldenDiff: matched, tier: 2 }))
      .toEqual({ build: 1, bp_clean: 1, golden_match: 1, systest: null, tier_weight: 2 });
    expect(scoreRun({ build: { succeeded: false, bpWarnings: [{}] }, goldenDiff: matched, tier: 1 }))
      .toEqual({ build: 0, bp_clean: 0, golden_match: 1, systest: null, tier_weight: 1 });
  });

  it('systest is null unless provided', () => {
    const matched = { matched: false, missing: ['x'], extra: [], changed: [] };
    expect(scoreRun({ build: { succeeded: true }, goldenDiff: matched, tier: 0, systest: { passed: true } }).systest).toBe(1);
    expect(scoreRun({ build: { succeeded: true }, goldenDiff: matched, tier: 0 }).systest).toBeNull();
  });
});

describe('normalizeMultiArtifact', () => {
  const CONTRACT = `<AxClass><Name>ContosoMyContract</Name><SourceCode><Declaration><![CDATA[class ContosoMyContract {}]]></Declaration></SourceCode></AxClass>`;
  const CONTROLLER = `<AxClass><Name>ContosoMyController</Name><SourceCode><Declaration><![CDATA[class ContosoMyController {}]]></Declaration></SourceCode></AxClass>`;

  it('prefixes each artifact\'s paths with its filename', async () => {
    const map = await normalizeMultiArtifact({
      'ContosoMyContract.metadata.xml': CONTRACT,
      'ContosoMyController.metadata.xml': CONTROLLER,
    });
    expect(map.get('ContosoMyContract.metadata.xml::AxClass/Name')).toBe('ContosoMyContract');
    expect(map.get('ContosoMyController.metadata.xml::AxClass/Name')).toBe('ContosoMyController');
  });

  it('an entirely missing artifact diffs as all-missing under its prefix', async () => {
    const golden = await normalizeMultiArtifact({
      'ContosoMyContract.metadata.xml': CONTRACT,
      'ContosoMyController.metadata.xml': CONTROLLER,
    });
    const actual = await normalizeMultiArtifact({ 'ContosoMyContract.metadata.xml': CONTRACT });
    const diff = diffNormalized(golden, actual);
    expect(diff.matched).toBe(false);
    expect(diff.missing.every(p => p.startsWith('ContosoMyController.metadata.xml::'))).toBe(true);
  });

  it('an unexpected extra artifact diffs as all-extra under its prefix', async () => {
    const golden = await normalizeMultiArtifact({ 'ContosoMyContract.metadata.xml': CONTRACT });
    const actual = await normalizeMultiArtifact({
      'ContosoMyContract.metadata.xml': CONTRACT,
      'ContosoMyController.metadata.xml': CONTROLLER,
    });
    const diff = diffNormalized(golden, actual);
    expect(diff.matched).toBe(false);
    expect(diff.extra.every(p => p.startsWith('ContosoMyController.metadata.xml::'))).toBe(true);
  });
});

describe('evaluateMulti (end-to-end, multi-artifact)', () => {
  const CONTRACT = `<AxClass><Name>ContosoMyContract</Name></AxClass>`;
  const CONTROLLER = `<AxClass><Name>ContosoMyController</Name></AxClass>`;

  it('scores a perfect multi-artifact run as golden_match=1', async () => {
    const res = await evaluateMulti({
      caseSpec: { id: 'L3-batch-basic', tier: 3, ignore: [] },
      goldenArtifacts: { 'Contract.metadata.xml': CONTRACT, 'Controller.metadata.xml': CONTROLLER },
      actualArtifacts: { 'Contract.metadata.xml': CONTRACT, 'Controller.metadata.xml': CONTROLLER },
      build: { succeeded: true, bpWarnings: [] },
    });
    expect(res.goldenDiff.matched).toBe(true);
    expect(res.score.golden_match).toBe(1);
  });

  it('flags a mismatch in just one of several artifacts', async () => {
    const res = await evaluateMulti({
      caseSpec: { id: 'L3-batch-basic', tier: 3 },
      goldenArtifacts: { 'Contract.metadata.xml': CONTRACT, 'Controller.metadata.xml': CONTROLLER },
      actualArtifacts: {
        'Contract.metadata.xml': CONTRACT,
        'Controller.metadata.xml': CONTROLLER.replace('ContosoMyController', 'ContosoWrongName'),
      },
      build: { succeeded: true, bpWarnings: [] },
    });
    expect(res.score.golden_match).toBe(0);
    expect(res.goldenDiff.changed.some(c => c.path === 'Controller.metadata.xml::AxClass/Name')).toBe(true);
  });
});

describe('evaluate (end-to-end oracle)', () => {
  it('scores a perfect run as build/bp/golden all 1', async () => {
    const res = await evaluate({
      caseSpec: { id: 'L0-enum-basic', tier: 0, ignore: [] },
      actualXml: ENUM_REORDERED,
      goldenXml: ENUM_GOLDEN,
      build: { succeeded: true, bpWarnings: [] },
    });
    expect(res.goldenDiff.matched).toBe(true);
    expect(res.score).toEqual({ build: 1, bp_clean: 1, golden_match: 1, systest: null, tier_weight: 0 });
  });

  it('flags a golden mismatch while still recording build success', async () => {
    const res = await evaluate({
      caseSpec: { id: 'L0-enum-basic', tier: 0 },
      actualXml: ENUM_GOLDEN.replace('<UseEnumValue>No</UseEnumValue>', '<UseEnumValue>Yes</UseEnumValue>'),
      goldenXml: ENUM_GOLDEN,
      build: { succeeded: true, bpWarnings: [{ code: 'BPxxx' }] },
    });
    expect(res.score.golden_match).toBe(0);
    expect(res.score.build).toBe(1);
    expect(res.score.bp_clean).toBe(0);
  });
});

// Regression: a prefix-hardcoding bug discovered during a full-catalog eval run
// (eval/corpus/runs/2026-07-06T10__L0-edt-basic__4fafcd8.json, classification
// VALIDATOR_GAP). The L0-edt-basic golden was captured under EXTENSION_PREFIX="Contoso"
// (root object "ContosoXyzNoteSubject"); a run against a sandbox configured with
// EXTENSION_PREFIX="Demo" correctly produced "DemoXyzNoteSubject" — the server
// applied ITS session's configured prefix per its documented contract
// (src/utils/modelClassifier.ts). Every other field matched byte-for-byte, yet the
// oracle's literal string compare on the root Name spuriously failed golden_match.
// Fixed by making normalize.ts canonicalise prefixed identifiers away before
// diffing, given each side's own EXTENSION_PREFIX (docs/AGENT_EVAL_LOOP.md §6.2).
describe('prefix-agnostic golden comparison (regression: eval/corpus/runs/2026-07-06T10__L0-edt-basic__4fafcd8.json)', () => {
  const EDT_GOLDEN_CONTOSO = `<?xml version="1.0" encoding="utf-8"?>
<AxEdt xmlns:i="http://www.w3.org/2001/XMLSchema-instance" xmlns="" i:type="AxEdtString">
  <Name>ContosoXyzNoteSubject</Name>
  <Extends>Name</Extends>
  <Label>Note subject</Label>
  <ArrayElements />
  <Relations />
  <TableReferences />
</AxEdt>`;

  // Same logical object, produced under a DIFFERENT session's EXTENSION_PREFIX ("Demo"
  // instead of "Contoso") — this is the actual VM output that triggered the corpus record above.
  const EDT_ACTUAL_DEMO = EDT_GOLDEN_CONTOSO.replace(/ContosoXyzNoteSubject/g, 'DemoXyzNoteSubject');

  it('canonicalizePrefix reduces both prefix sessions to the same placeholder', () => {
    expect(canonicalizePrefix('ContosoXyzNoteSubject', 'Contoso'))
      .toBe(canonicalizePrefix('DemoXyzNoteSubject', 'Demo'));
  });

  it('does NOT strip a prefix-shaped substring that is not at an identifier boundary', () => {
    // "CustContosoThing" — "Contoso" is not at a boundary (preceded by a letter), so it must be left alone.
    expect(canonicalizePrefix('CustContosoThing', 'Contoso')).toBe('CustContosoThing');
  });

  it('does NOT strip when the prefix is not followed by an uppercase letter (not a real prefix use)', () => {
    // A free-text label that starts with "Contoso" but is not followed by an uppercase letter.
    expect(canonicalizePrefix('Contoso at the wheel', 'Contoso')).toBe('Contoso at the wheel');
  });

  it('normalizeAotXml: root Name canonicalises identically for two different EXTENSION_PREFIX sessions', async () => {
    const golden = await normalizeAotXml(EDT_GOLDEN_CONTOSO, [], 'Contoso');
    const actual = await normalizeAotXml(EDT_ACTUAL_DEMO, [], 'Demo');
    expect(golden.get('AxEdt/Name')).toBe(actual.get('AxEdt/Name'));
    expect(diffNormalized(golden, actual).matched).toBe(true);
  });

  it('evaluate(): golden_match=1 for an EDT captured under "Contoso" and produced under "Demo" (this session\'s prefix)', async () => {
    const res = await evaluate({
      caseSpec: { id: 'L0-edt-basic', tier: 0, ignore: ['AxEdt/@Id', '**/ModelSaveInfo'] },
      actualXml: EDT_ACTUAL_DEMO,
      goldenXml: EDT_GOLDEN_CONTOSO,
      build: { succeeded: true, bpWarnings: [{ code: 'BPErrorLabelIsText' }] },
      goldenPrefix: GOLDEN_CAPTURE_PREFIX,
      actualPrefix: 'Demo',
    });
    expect(res.goldenDiff.changed).toEqual([]);
    expect(res.goldenDiff.matched).toBe(true);
    expect(res.score.golden_match).toBe(1);
  });

  it('WITHOUT prefix canonicalisation (both prefixes empty) the same pair still mismatches — proves the fix is load-bearing', async () => {
    const res = await evaluate({
      caseSpec: { id: 'L0-edt-basic', tier: 0, ignore: ['AxEdt/@Id', '**/ModelSaveInfo'] },
      actualXml: EDT_ACTUAL_DEMO,
      goldenXml: EDT_GOLDEN_CONTOSO,
      build: { succeeded: true, bpWarnings: [{ code: 'BPErrorLabelIsText' }] },
      // no goldenPrefix/actualPrefix — legacy literal-string comparison
    });
    expect(res.score.golden_match).toBe(0);
    expect(res.goldenDiff.changed.some(c => c.path === 'AxEdt/Name')).toBe(true);
  });

  it('a genuinely different root Name (not just a prefix change) still correctly mismatches', async () => {
    const res = await evaluate({
      caseSpec: { id: 'L0-edt-basic', tier: 0 },
      actualXml: EDT_GOLDEN_CONTOSO.replace('ContosoXyzNoteSubject', 'ContosoCompletelyDifferentEdt'),
      goldenXml: EDT_GOLDEN_CONTOSO,
      build: { succeeded: true, bpWarnings: [] },
      goldenPrefix: 'Contoso',
      actualPrefix: 'Contoso',
    });
    expect(res.score.golden_match).toBe(0);
  });

  it('normalizeMultiArtifact: canonicalises the prefixed FILENAME key too, so a multi-artifact case matches across prefix sessions', async () => {
    const CONTRACT_CONTOSO = `<AxClass><Name>ContosoMyContract</Name></AxClass>`;
    const CONTRACT_DEMO = `<AxClass><Name>DemoMyContract</Name></AxClass>`;
    const golden = await normalizeMultiArtifact({ 'ContosoMyContract.metadata.xml': CONTRACT_CONTOSO }, [], 'Contoso');
    const actual = await normalizeMultiArtifact({ 'DemoMyContract.metadata.xml': CONTRACT_DEMO }, [], 'Demo');
    expect(diffNormalized(golden, actual).matched).toBe(true);
  });

  it('evaluateMulti(): a multi-artifact case matches across prefix sessions end-to-end', async () => {
    const CONTRACT_CONTOSO = `<AxClass><Name>ContosoMyContract</Name></AxClass>`;
    const CONTROLLER_CONTOSO = `<AxClass><Name>ContosoMyController</Name></AxClass>`;
    const CONTRACT_DEMO = `<AxClass><Name>DemoMyContract</Name></AxClass>`;
    const CONTROLLER_DEMO = `<AxClass><Name>DemoMyController</Name></AxClass>`;
    const res = await evaluateMulti({
      caseSpec: { id: 'L3-batch-basic', tier: 3 },
      goldenArtifacts: {
        'ContosoMyContract.metadata.xml': CONTRACT_CONTOSO,
        'ContosoMyController.metadata.xml': CONTROLLER_CONTOSO,
      },
      actualArtifacts: {
        'DemoMyContract.metadata.xml': CONTRACT_DEMO,
        'DemoMyController.metadata.xml': CONTROLLER_DEMO,
      },
      build: { succeeded: true, bpWarnings: [] },
      goldenPrefix: 'Contoso',
      actualPrefix: 'Demo',
    });
    expect(res.goldenDiff.matched).toBe(true);
    expect(res.score.golden_match).toBe(1);
  });
});

// Regression: eval/corpus/runs/2026-07-07T05__L2-dimension-basic__cb1b73d.json and
// eval/corpus/runs/2026-07-06T19__L2-business-event-basic__cb1b73d.json both scored
// golden_match=0 (classified TOOL_DEFECT) even though `build` and `bp_clean` passed and
// the generated Method/Source text was semantically IDENTICAL to the golden — the only
// delta was indentation depth (e.g. golden's method signature/brace at column 0, actual's
// at column 4, with every nested line shifted by the same one-level offset). X++ is
// whitespace-insensitive for indentation, and docs/AGENT_EVAL_LOOP.md §6.2 already commits
// the oracle to "canonicalise element ordering and whitespace" — but normalizeText() only
// did CRLF normalisation + trim, so any indentation-convention mismatch (tool vs. golden,
// or even the D365FO metadata SDK's own on-save reformatting, which is opaque to this repo)
// spuriously failed golden_match. Fixed by re-deriving indentation from brace depth alone
// (reusing src/utils/xppFormat.ts's reindentXppSource, baseDepth 0) for `Source`/
// `Declaration` text specifically before comparing.
describe('X++ source indentation is not a golden_match diff (regression: L2-dimension-basic / L2-business-event-basic)', () => {
  const DIMENSION_GOLDEN = `<?xml version="1.0" encoding="utf-8"?>
<AxTable xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
  <Name>PFXDemoNoteHeader</Name>
  <SourceCode>
    <Methods>
      <Method>
        <Name>dimensionDisplayValue</Name>
        <Source><![CDATA[
public display str dimensionDisplayValue()
{
    DimensionAttributeValueSetStorage dimStorage;

    if (!this.DefaultDimension)
    {
        return '';
    }

    dimStorage = DimensionAttributeValueSetStorage::find(this.DefaultDimension);

    return dimStorage.toString();
}
]]></Source>
      </Method>
    </Methods>
  </SourceCode>
</AxTable>`;

  // Same method, byte-identical tokens, but the tool's actual bridge/addMethod output
  // (captured verbatim in the corpus record) indents the brace/body one level deeper.
  const DIMENSION_ACTUAL = `<?xml version="1.0" encoding="utf-8"?>
<AxTable xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
  <Name>PFXDemoNoteHeader</Name>
  <SourceCode>
    <Methods>
      <Method>
        <Name>dimensionDisplayValue</Name>
        <Source><![CDATA[
public display str dimensionDisplayValue()
    {
        DimensionAttributeValueSetStorage dimStorage;

        if (!this.DefaultDimension)
        {
            return '';
        }

        dimStorage = DimensionAttributeValueSetStorage::find(this.DefaultDimension);

        return dimStorage.toString();
    }
]]></Source>
      </Method>
    </Methods>
  </SourceCode>
</AxTable>`;

  it('normalizeAotXml: a Method/Source that differs only in indentation canonicalises to the same value', async () => {
    const golden = await normalizeAotXml(DIMENSION_GOLDEN);
    const actual = await normalizeAotXml(DIMENSION_ACTUAL);
    const path = 'AxTable/SourceCode/Methods/Method[dimensionDisplayValue]/Source';
    expect(golden.get(path)).toBeDefined();
    expect(golden.get(path)).toBe(actual.get(path));
    expect(diffNormalized(golden, actual).matched).toBe(true);
  });

  it('evaluate(): golden_match=1 for an indentation-only difference in a table display method', async () => {
    const res = await evaluate({
      caseSpec: { id: 'L2-dimension-basic', tier: 2 },
      actualXml: DIMENSION_ACTUAL,
      goldenXml: DIMENSION_GOLDEN,
      build: { succeeded: true, bpWarnings: [] },
    });
    expect(res.goldenDiff.changed).toEqual([]);
    expect(res.score.golden_match).toBe(1);
  });

  it('WITHOUT indentation canonicalisation the same pair still mismatches — proves the fix is load-bearing', () => {
    // Direct string compare (what normalizeText did before the fix): CRLF-normalise + trim
    // only, no re-indent. The two CDATA bodies differ byte-for-byte on indentation alone.
    const rawGolden = DIMENSION_GOLDEN.match(/<!\[CDATA\[([\s\S]*?)\]\]>/)![1].trim();
    const rawActual = DIMENSION_ACTUAL.match(/<!\[CDATA\[([\s\S]*?)\]\]>/)![1].trim();
    expect(rawGolden).not.toBe(rawActual);
  });

  it('a genuinely different method BODY (not just indentation) still correctly mismatches', async () => {
    const differentBody = DIMENSION_ACTUAL.replace(
      "return dimStorage.toString();",
      "return 'wrong';",
    );
    const res = await evaluate({
      caseSpec: { id: 'L2-dimension-basic', tier: 2 },
      actualXml: differentBody,
      goldenXml: DIMENSION_GOLDEN,
      build: { succeeded: true, bpWarnings: [] },
    });
    expect(res.score.golden_match).toBe(0);
    expect(res.goldenDiff.changed.length).toBeGreaterThan(0);
  });

  it('only applies indentation canonicalisation to Source/Declaration text, not arbitrary element text', async () => {
    // A Label containing brace-like characters must still compare literally.
    const xmlA = `<AxTable><Name>T</Name><Label>{weird} label</Label></AxTable>`;
    const xmlB = `<AxTable><Name>T</Name><Label>{ weird } label</Label></AxTable>`;
    const a = await normalizeAotXml(xmlA);
    const b = await normalizeAotXml(xmlB);
    expect(a.get('AxTable/Label')).not.toBe(b.get('AxTable/Label'));
  });
});
