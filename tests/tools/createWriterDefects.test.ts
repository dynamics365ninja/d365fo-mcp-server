/**
 * Regression gate for the create/generate WRITER defects found during the
 * 2026-07-21 golden-capture sweep (docs/eval-sweep-findings-2026-07-21.md).
 *
 * Every test here reproduces a defect that shipped a ✅ to the caller while
 * writing metadata that does not build, does not resolve, or silently loses
 * what was passed in. All of them are VM-free: the emitters are pure functions.
 *
 * Findings covered: #13, #19, #20, #22, #30, #31, #32, #38.
 * Corpus evidence: eval/corpus/runs/2026-07-21T20__L4-master-security-slice__c262b19.json,
 *                  eval/corpus/runs/2026-07-21T20__L3-workflow-document-submit__c262b19.json,
 *                  eval/corpus/runs/2026-07-21T19__L2-error-handling-infolog__c262b19.json
 */

import { describe, it, expect } from 'vitest';
import { XmlTemplateGenerator } from '../../src/tools/createD365File';
import { buildAxQueryXml, buildAxViewXml, extractQueryRootDataSourceName } from '../../src/tools/queryViewXml';
import { FormPatternTemplates } from '../../src/utils/formPatternTemplates';
import {
  AX_TABLE_ELEMENT_ORDER,
  axTableElementRank,
  upsertAxTableProperty,
} from '../../src/utils/axTablePropertyOrder';
import { parseTableTitleField } from '../../src/utils/fieldControlTypes';
import { runRules } from '../../src/tools/validateXpp';
import { SmartXmlBuilder } from '../../src/utils/smartXmlBuilder';

// ── #31: security duty/role references must actually resolve ────────────────
describe('#31 security duty/role reference element names', () => {
  it('duty lists privileges as AxSecurityPrivilegeReference', () => {
    const xml = XmlTemplateGenerator.generateAxSecurityDutyXml('ConDemoDuty', {
      privileges: ['ConDemoPrivilege'],
    });
    expect(xml).toContain('<AxSecurityPrivilegeReference>');
    expect(xml).toContain('<Name>ConDemoPrivilege</Name>');
    // The old shape deserialized to an empty list → BPErrorDutyHasNoPrivileges.
    expect(xml).not.toContain('AxSecurityRolePermissionSet');
  });

  it('role lists duties as AxSecurityDutyReference and privileges as AxSecurityPrivilegeReference', () => {
    const xml = XmlTemplateGenerator.generateAxSecurityRoleXml('ConDemoRole', {
      duties: ['ConDemoDuty'],
      privileges: ['ConDemoPrivilege'],
    });
    expect(xml).toContain('<AxSecurityDutyReference>');
    expect(xml).toContain('<AxSecurityPrivilegeReference>');
    expect(xml).not.toContain('AxSecurityRoleDutyPermission');
    expect(xml).not.toContain('AxSecurityRolePermissionSet');
  });

  it('matches the shape the *Extension writers already used', () => {
    const roleExt = XmlTemplateGenerator.generateAxSecurityRoleExtensionXml('Base.ConExtension', {
      duties: ['ConDemoDuty'],
    });
    const role = XmlTemplateGenerator.generateAxSecurityRoleXml('ConDemoRole', {
      duties: ['ConDemoDuty'],
    });
    expect(roleExt).toContain('<AxSecurityDutyReference>');
    expect(role).toContain('<AxSecurityDutyReference>');
  });
});

// ── #32: a DataGroup control needs a sibling DataSource ─────────────────────
describe('#32 form scaffold produces a buildable design', () => {
  const opts = {
    formName: 'ConDemoNoteHeaderMaster',
    dsName: 'ConDemoNoteHeader',
    dsTable: 'ConDemoNoteHeader',
    gridFields: ['Alpha', 'NoteId', 'Subject'],
  };

  for (const pattern of ['SimpleListDetails', 'DetailsMaster'] as const) {
    it(`${pattern}: every <DataGroup> has a sibling <DataSource>`, () => {
      const xml = FormPatternTemplates.build(pattern, opts);
      const groups = [...xml.matchAll(/<DataGroup>([^<]+)<\/DataGroup>\s*\n\s*(<[^>\s]+)/g)];
      expect(groups.length).toBeGreaterThan(0);
      for (const g of groups) {
        // A field group is resolved on the control's datasource table; without a
        // DataSource sibling a FULL build fails "Field group 'Overview' does not
        // exist" (an incremental build passes it, which is how this got captured).
        expect(g[2]).toBe('<DataSource');
      }
      expect(xml).toContain('<DataGroup>Overview</DataGroup>\n');
    });
  }

  it('DetailsMaster binds TitleField to the table TitleField1, not the alphabetically first field', () => {
    const xml = FormPatternTemplates.build('DetailsMaster', { ...opts, titleField: 'Subject' });
    const title = xml.match(/<Name>TitleField<\/Name>[\s\S]*?<\/AxFormControl>/)?.[0] ?? '';
    expect(title).toContain('<DataField>Subject</DataField>');
    expect(title).not.toContain('<DataField>Alpha</DataField>');
  });

  it('falls back to the first grid field only when no TitleField1 is known', () => {
    const xml = FormPatternTemplates.build('DetailsMaster', opts);
    const title = xml.match(/<Name>TitleField<\/Name>[\s\S]*?<\/AxFormControl>/)?.[0] ?? '';
    expect(title).toContain('<DataField>Alpha</DataField>');
  });

  it('parseTableTitleField reads TitleField1 out of a table document', () => {
    expect(parseTableTitleField('<AxTable><TitleField1>Subject</TitleField1></AxTable>')).toBe('Subject');
    expect(parseTableTitleField('<AxTable><TitleField1></TitleField1></AxTable>')).toBeUndefined();
    expect(parseTableTitleField('<AxTable />')).toBeUndefined();
  });
});

// ── #19: table create must not swallow sourceCode ───────────────────────────
describe('#19 create objectType="table" keeps methods passed in sourceCode', () => {
  const source = `public class ConDemoWfRequest extends common
{
}

public boolean canSubmitToWorkflow(str _workflowType)
{
    return true;
}
`;

  it('emits the method instead of an empty <Methods />', () => {
    const xml = XmlTemplateGenerator.generate('table', 'ConDemoWfRequest', source, {});
    expect(xml).toContain('<Name>canSubmitToWorkflow</Name>');
    expect(xml).toContain('public boolean canSubmitToWorkflow');
    expect(xml).not.toContain('<Methods />');
  });

  it('still emits an empty <Methods /> when no source was given', () => {
    const xml = XmlTemplateGenerator.generate('table', 'ConDemoWfRequest', undefined, {});
    expect(xml).toContain('<Methods />');
  });

  it('still treats a JSON sourceCode payload as field definitions, not X++', () => {
    const xml = XmlTemplateGenerator.generate(
      'table',
      'ConDemoWfRequest',
      JSON.stringify({ fields: [{ name: 'NoteId', edt: 'Num' }] }),
      undefined,
    );
    expect(xml).toContain('<Name>NoteId</Name>');
    expect(xml).toContain('<Methods />');
  });
});

// ── #13: AxTable element order ──────────────────────────────────────────────
describe('#13 AxTable canonical element order', () => {
  it('the writer emits the order captured in eval/goldens/L1-table-basic', () => {
    const xml = XmlTemplateGenerator.generateAxTableXml('ConDemoAgentNote', {
      label: '@SYS13887',
      tableGroup: 'Main',
      titleField1: 'Subject',
      titleField2: 'NoteId',
      cacheLookup: 'Found',
      clusteredIndex: 'NoteIdx',
      primaryIndex: 'NoteIdx',
      developerDocumentation: '@SYS1234',
      formRef: 'ConDemoAgentNoteForm',
      configurationKey: 'LedgerBasic',
    });
    const order = ['ConfigurationKey', 'DeveloperDocumentation', 'FormRef', 'Label', 'TableGroup',
      'TitleField1', 'TitleField2', 'CacheLookup', 'ClusteredIndex', 'PrimaryIndex',
      'ReplacementKey'];
    const positions = order.map(t => xml.indexOf(`<${t}>`));
    expect(positions.every(p => p > 0)).toBe(true);
    for (let i = 1; i < positions.length; i++) {
      expect(positions[i]).toBeGreaterThan(positions[i - 1]);
    }
  });

  it('omits properties the caller did not set instead of writing empty elements', () => {
    const xml = XmlTemplateGenerator.generateAxTableXml('ConDemoAgentNote', {});
    expect(xml).not.toContain('<TitleField1></TitleField1>');
    expect(xml).not.toContain('<TitleField1>');
    expect(xml).toContain('<Label>ConDemoAgentNote</Label>');
  });

  it('validate_code(xml-table) FLAGS a misordered document (it used to report "no violations")', () => {
    const misordered = `<?xml version="1.0" encoding="utf-8"?>
<AxTable xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
\t<Name>ConDemoTicket</Name>
\t<CacheLookup>Found</CacheLookup>
\t<DeveloperDocumentation>@SYS1</DeveloperDocumentation>
\t<Label>@SYS2</Label>
\t<TableGroup>Main</TableGroup>
\t<TitleField1>Subject</TitleField1>
\t<PrimaryIndex>NoteIdx</PrimaryIndex>
\t<ReplacementKey>NoteIdx</ReplacementKey>
\t<Fields />
\t<Indexes>
\t\t<AxTableIndex>
\t\t\t<Name>NoteIdx</Name>
\t\t\t<AlternateKey>Yes</AlternateKey>
\t\t</AxTableIndex>
\t</Indexes>
</AxTable>`;
    const violations = runRules(misordered, 'xml-table');
    const order = violations.filter(v => v.rule === 'XML006');
    expect(order).toHaveLength(1);
    expect(order[0].severity).toBe('error');
    expect(order[0].excerpt).toContain('<DeveloperDocumentation>');
  });

  it('does not flag a canonically ordered document', () => {
    const ok = XmlTemplateGenerator.generateAxTableXml('ConDemoTicket', {
      label: '@SYS2', titleField1: 'Subject', cacheLookup: 'Found', primaryIndex: 'NoteIdx',
    });
    expect(runRules(ok, 'xml-table').filter(v => v.rule === 'XML006')).toHaveLength(0);
  });

  it('X++ inside CDATA does not confuse the element scan', () => {
    const withSource = XmlTemplateGenerator.generate(
      'table',
      'ConDemoTicket',
      'public boolean isOpen()\n{\n    return 1 < 2 && 3 > 2;\n}\n',
      { label: '@SYS2', titleField1: 'Subject' },
    );
    expect(runRules(withSource, 'xml-table').filter(v => v.rule === 'XML006')).toHaveLength(0);
  });

  // The element scan used to strip CDATA/comments with chained `.replace()`. A non-greedy
  // `<!--[\s\S]*?-->` never matches an UNTERMINATED region, so its contents survived and were
  // scanned as real elements — a malformed document could then invent violations that are not
  // there. Skipping regions in a forward scan runs an unterminated one to EOF instead.
  it('does not scan the contents of an unterminated comment as elements', () => {
    const xml = `<AxTable xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
\t<Name>ConDemoTicket</Name>
\t<Label>@SYS2</Label>
\t<TitleField1>Subject</TitleField1>
\t<!-- <CacheLookup>Found</CacheLookup><DeveloperDocumentation>@SYS1</DeveloperDocumentation>
\t<Fields />
</AxTable>`;
    expect(runRules(xml, 'xml-table').filter(v => v.rule === 'XML006')).toHaveLength(0);
  });

  // Same guarantee for CDATA. The block sits directly under the root so its contents WOULD
  // land at the depth the order check reads — otherwise the test passes either way and proves
  // nothing.
  it('does not scan the contents of an unterminated CDATA block as elements', () => {
    const xml = `<AxTable xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
\t<Name>ConDemoTicket</Name>
\t<Label>@SYS2</Label>
\t<TitleField1>Subject</TitleField1>
\t<![CDATA[ if (a < b) { }
\t<CacheLookup>Found</CacheLookup><DeveloperDocumentation>@SYS1</DeveloperDocumentation>
</AxTable>`;
    expect(runRules(xml, 'xml-table').filter(v => v.rule === 'XML006')).toHaveLength(0);
  });

  it('flags a table-level <AlternateKey>, which does not exist in the AxTable model', () => {
    const bogus = `<AxTable xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
\t<Name>ConDemoTicket</Name>
\t<Label>@SYS2</Label>
\t<AlternateKey>Yes</AlternateKey>
\t<Fields />
</AxTable>`;
    const violations = runRules(bogus, 'xml-table').filter(v => v.rule === 'XML007');
    expect(violations).toHaveLength(1);
    expect(violations[0].fix).toContain('INDEX property');
  });

  it('does NOT flag an index-level <AlternateKey>', () => {
    const good = `<AxTable xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
\t<Name>ConDemoTicket</Name>
\t<Label>@SYS2</Label>
\t<Indexes>
\t\t<AxTableIndex>
\t\t\t<Name>NoteIdx</Name>
\t\t\t<AlternateKey>Yes</AlternateKey>
\t\t</AxTableIndex>
\t</Indexes>
</AxTable>`;
    expect(runRules(good, 'xml-table').filter(v => v.rule === 'XML007')).toHaveLength(0);
  });
});

describe('#13 the smart table builder emits the same canonical order', () => {
  it('CacheLookup/SaveDataPerCompany no longer precede TableGroup/TitleField1', () => {
    const xml = new SmartXmlBuilder().buildTableXml({
      name: 'ConDemoTicket',
      label: '@SYS2',
      tableGroup: 'Main',
      fields: [{ name: 'TicketId', edt: 'Num' }, { name: 'Subject', edt: 'Name' }],
      indexes: [{ name: 'TicketIdx', fields: ['TicketId'], unique: true, clustered: true }],
    });
    const seq = ['Label', 'TableGroup', 'TitleField1', 'TitleField2', 'CacheLookup',
      'ClusteredIndex', 'PrimaryIndex', 'ReplacementKey', 'SaveDataPerCompany'];
    const positions = seq.map(t => xml.indexOf(`<${t}>`));
    expect(positions.every(p => p > 0)).toBe(true);
    for (let i = 1; i < positions.length; i++) {
      expect(positions[i]).toBeGreaterThan(positions[i - 1]);
    }
    expect(runRules(xml, 'xml-table').filter(v => v.rule === 'XML006')).toHaveLength(0);
  });
});

// ── #37: a missing table property can be inserted in canonical order ────────
describe('#37 upsertAxTableProperty inserts in canonical order', () => {
  const table = XmlTemplateGenerator.generateAxTableXml('ConDemoTicket', {
    label: '@SYS2', tableGroup: 'Main', titleField1: 'Subject',
  });

  it('adds FormRef before Label (the bridge rejects FormRef outright)', () => {
    const out = upsertAxTableProperty(table, 'FormRef', 'ConDemoTicketForm');
    expect(out).not.toBeNull();
    expect(out!).toContain('<FormRef>ConDemoTicketForm</FormRef>');
    expect(out!.indexOf('<FormRef>')).toBeLessThan(out!.indexOf('<Label>'));
    expect(runRules(out!, 'xml-table').filter(v => v.rule === 'XML006')).toHaveLength(0);
  });

  it('replaces an existing property in place', () => {
    const out = upsertAxTableProperty(table, 'TableGroup', 'Transaction');
    expect(out!).toContain('<TableGroup>Transaction</TableGroup>');
    expect(out!).not.toContain('<TableGroup>Main</TableGroup>');
  });

  it('refuses properties that do not exist at table level', () => {
    expect(upsertAxTableProperty(table, 'AlternateKey', 'Yes')).toBeNull();
  });

  it('refuses documents that are not AxTable', () => {
    expect(upsertAxTableProperty('<AxClass><Name>Foo</Name></AxClass>', 'Label', 'x')).toBeNull();
  });

  it('ranks unknown elements last so they never reorder known ones', () => {
    expect(axTableElementRank('Label')).toBeLessThan(axTableElementRank('Fields'));
    expect(axTableElementRank('SomethingElse')).toBe(Number.MAX_SAFE_INTEGER);
    expect(AX_TABLE_ELEMENT_ORDER[0]).toBe('ConfigurationKey');
  });
});

// ── #20 / #38: query and view ───────────────────────────────────────────────
describe('#20 query with no explicit field list is marked dynamic', () => {
  it('emits <DynamicFields>Yes</DynamicFields> and an empty <Fields />', () => {
    const xml = buildAxQueryXml('ConDemoQuery', { dataSource: 'ConDemoNoteHeader' });
    // xppc: "The field list of the data source 'X' cannot be empty if the dynamic
    // field is set to false" — every "all fields" query used to fail the build.
    expect(xml).toContain('<DynamicFields>Yes</DynamicFields>');
    expect(xml).toContain('<Fields />');
    // Contract order is Name → DynamicFields → Table → … : emitted anywhere later
    // the deserializer DROPS the element and reads the flag back as false, which
    // reintroduces the very build error above (L3-xds-policy-constrained-table run).
    expect(xml.indexOf('<DynamicFields>')).toBeLessThan(xml.indexOf('<Table>'));
    expect(xml.indexOf('<Name>ConDemoNoteHeader</Name>')).toBeLessThan(xml.indexOf('<DynamicFields>'));
    expect(xml.indexOf('<DynamicFields>')).toBeLessThan(xml.indexOf('<DerivedDataSources />'));
  });

  it('omits <Title> unless the caller gives one — the slot holds a label id', () => {
    // 905 of the 4941 platform queries set <Title>, and only 3 of those carry
    // literal text. Defaulting it to the object name put a literal in a label slot
    // and earned every generated query a BPErrorLabelIsText.
    const bare = buildAxQueryXml('ConDemoQuery', { dataSource: 'ConDemoNoteHeader' });
    expect(bare).not.toContain('<Title>');

    const labelled = buildAxQueryXml('ConDemoQuery', {
      dataSource: 'ConDemoNoteHeader',
      label: '@MyModule:QueryTitle',
    });
    expect(labelled).toContain('<Title>@MyModule:QueryTitle</Title>');
  });

  it('writes the data source ranges instead of dropping them', () => {
    // The range was unreachable through the grounded path: properties.ranges[] was
    // accepted and dropped without a warning and modify has no range op, so the
    // L3-xds-policy-constrained-table runs needed an xmlContent fallback.
    const xml = buildAxQueryXml('ConDemoQuery', {
      dataSource: 'ConDemoTerritory',
      ranges: [{ name: 'OwnerUserId', field: 'OwnerUserId', value: '(currentUserId())' }],
    });
    expect(xml).toContain('<AxQuerySimpleDataSourceRange>');
    expect(xml).toContain('<Field>OwnerUserId</Field>');
    expect(xml).toContain('<Value>(currentUserId())</Value>');
    expect(xml).not.toContain('<Ranges />');
    // Name, Field, Value — and the block still sits between Fields and GroupBy.
    expect(xml.indexOf('<Ranges>')).toBeGreaterThan(xml.indexOf('<Fields'));
    expect(xml.indexOf('</Ranges>')).toBeLessThan(xml.indexOf('<GroupBy />'));
  });

  it('a range with no value omits <Value> the way BatchDelete does', () => {
    const xml = buildAxQueryXml('ConDemoQuery', {
      dataSource: 'ConDemoTerritory',
      ranges: [{ field: 'Status' }],
    });
    expect(xml).toContain('<Name>Status</Name>');
    expect(xml).not.toContain('<Value>');
  });

  it('an explicit field list stays static', () => {
    const xml = buildAxQueryXml('ConDemoQuery', {
      dataSource: 'ConDemoNoteHeader',
      fields: [{ name: 'NoteId' }],
    });
    expect(xml).not.toContain('<DynamicFields>');
    expect(xml).toContain('<Field>NoteId</Field>');
  });

  it('dynamicFields can be forced by the caller', () => {
    const xml = buildAxQueryXml('ConDemoQuery', {
      dataSource: 'ConDemoNoteHeader',
      fields: [{ name: 'NoteId' }],
      dynamicFields: 'Yes',
    });
    expect(xml).toContain('<DynamicFields>Yes</DynamicFields>');
    expect(xml).toContain('<Field>NoteId</Field>');
  });
});

describe('#38 view field DataSource is the query root datasource, not the query name', () => {
  const queryXml = buildAxQueryXml('ConDemoNoteHeaderQuery', {
    dataSource: 'ConDemoNoteHeader',
    fields: [{ name: 'NoteId' }, { name: 'Subject' }],
  });

  it('extracts the root datasource name from a query document', () => {
    expect(extractQueryRootDataSourceName(queryXml)).toBe('ConDemoNoteHeader');
  });

  it('binds view fields to it (ground truth: eval/goldens/L1-query-view-basic)', () => {
    const xml = buildAxViewXml('ConDemoNoteHeaderView', {
      query: 'ConDemoNoteHeaderQuery',
      queryXml,
      fields: [{ name: 'NoteId' }, { name: 'Subject' }],
    });
    expect(xml).toContain('<DataSource>ConDemoNoteHeader</DataSource>');
    expect(xml).not.toContain('<DataSource>ConDemoNoteHeaderQuery</DataSource>');
  });

  it('an explicit dataSource still wins', () => {
    const xml = buildAxViewXml('ConDemoNoteHeaderView', {
      query: 'ConDemoNoteHeaderQuery',
      queryXml,
      dataSource: 'ExplicitDs',
      fields: [{ name: 'NoteId' }],
    });
    expect(xml).toContain('<DataSource>ExplicitDs</DataSource>');
  });

  it('falls back to the query name when the query cannot be resolved (documented last resort)', () => {
    const xml = buildAxViewXml('ConDemoNoteHeaderView', {
      query: 'ConDemoNoteHeaderQuery',
      fields: [{ name: 'NoteId' }],
    });
    expect(xml).toContain('<DataSource>ConDemoNoteHeaderQuery</DataSource>');
  });
});

// ── #22: declaration doc comments must survive the name realignment ─────────
describe('#22 class create does not corrupt declaration doc comments', () => {
  const declaration = `/// <summary>
/// The <c>ConDemoWfRequestDocument</c> class is the workflow document for requests.
/// </summary>
public class ConDemoWfRequestDocument extends WorkflowDocument
{
}`;

  it('leaves the doc comment alone when the header already matches', () => {
    const out = XmlTemplateGenerator.normalizeSelfReferenceName(
      'ConDemoWfRequestDocument',
      declaration,
      [],
    );
    expect(out.declaration).toContain('class is the workflow document');
    expect(out.declaration).not.toContain('class ConDemoWfRequestDocument the workflow document');
  });

  it('still renames a genuinely stale class header', () => {
    const stale = `/// <summary>
/// The <c>WfRequestDocument</c> class is the workflow document for requests.
/// </summary>
public class WfRequestDocument extends WorkflowDocument
{
}`;
    const out = XmlTemplateGenerator.normalizeSelfReferenceName(
      'ConDemoWfRequestDocument',
      stale,
      [{ name: 'run', source: 'public void run() { WfRequestDocument doc; }' }],
    );
    expect(out.declaration).toContain('public class ConDemoWfRequestDocument');
    expect(out.methods[0].source).toContain('ConDemoWfRequestDocument doc;');
    // and the comment prose is untouched
    expect(out.declaration).toContain('class is the workflow document');
  });

  it('end-to-end: the generated AxClass keeps the sentence intact', () => {
    const xml = XmlTemplateGenerator.generateAxClassXml('ConDemoWfRequestDocument', declaration);
    expect(xml).toContain('class is the workflow document');
  });
});

describe('extractInnerClassMethods — macro directives in the declaration', () => {
  // Corpus: eval/corpus/runs/2026-07-23T18__L1-macro-library-flight__b7abafe.json
  // The class-source splitter rebuilt <Declaration> from lines ending in ';' only.
  // A macro include (`#ConDemoModuleFlights`) has no semicolon, so it was silently
  // dropped — the class then referenced `#DemoFastPostingFlight` with no library
  // included and failed to compile, while the tool still reported success.
  it('preserves a macro include line when splitting a class with inner methods', () => {
    const decl = `public class ConDemoFlightReader
{
    #ConDemoModuleFlights

    public boolean isFast()
    {
        return Global::isFlightEnabled(#DemoFastPostingFlight);
    }
}`;
    const out = XmlTemplateGenerator.extractInnerClassMethods(decl);
    expect(out).not.toBeNull();
    expect(out!.declaration).toContain('#ConDemoModuleFlights');
    expect(out!.methods).toHaveLength(1);
    expect(out!.methods[0].name).toBe('isFast');
    expect(out!.methods[0].source).toContain('#DemoFastPostingFlight');
  });

  it('emits the macro directive BEFORE member variables that use it', () => {
    const decl = `public class ConDemoReader
{
    #ConDemoLib
    int cachedValue;

    public int read()
    {
        return cachedValue;
    }
}`;
    const out = XmlTemplateGenerator.extractInnerClassMethods(decl);
    expect(out).not.toBeNull();
    const macroIdx = out!.declaration.indexOf('#ConDemoLib');
    const memberIdx = out!.declaration.indexOf('int cachedValue;');
    expect(macroIdx).toBeGreaterThan(-1);
    expect(memberIdx).toBeGreaterThan(-1);
    expect(macroIdx).toBeLessThan(memberIdx);
  });
});
