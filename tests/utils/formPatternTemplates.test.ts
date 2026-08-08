/**
 * Form Pattern Templates Tests (Issue #388)
 *
 * Validates that each form pattern template generates structurally correct
 * AxForm XML matching the D365FO form pattern specifications.
 *
 * These are unit tests against FormPatternTemplates directly — no MCP context
 * or bridge needed. Each test parses the generated XML and asserts the
 * control hierarchy matches the D365FO pattern requirements.
 */

import { describe, it, expect } from 'vitest';
import { FormPatternTemplates } from '../../src/utils/formPatternTemplates';
import { validateFormPatternXml } from '../../src/validation/formPatternValidator';

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Check that an element with given Name appears in the XML */
const hasNamedControl = (xml: string, name: string): boolean =>
  xml.includes(`<Name>${name}</Name>`);

/** Check Design-level property */
const hasDesignProperty = (xml: string, prop: string, value: string): boolean => {
  // Design-level properties use xmlns="" attribute
  return xml.includes(`<${prop} xmlns="">${value}</${prop}>`) || xml.includes(`<${prop}>${value}</${prop}>`);
};

const defaultOpts = {
  formName: 'TestForm',
  dsName: 'TestDS',
  dsTable: 'TestTable',
  caption: 'Test Caption',
  gridFields: ['Field1', 'Field2', 'Field3'],
};

// ─── SimpleList ──────────────────────────────────────────────────────────────

describe('SimpleList pattern', () => {
  const xml = FormPatternTemplates.buildSimpleList(defaultOpts);

  it('generates valid XML with correct pattern', () => {
    expect(xml).toContain('<?xml version="1.0" encoding="utf-8"?>');
    expect(xml).toContain('<AxForm');
    expect(hasDesignProperty(xml, 'Pattern', 'SimpleList')).toBe(true);
    expect(hasDesignProperty(xml, 'PatternVersion', '1.1')).toBe(true);
  });

  it('has DataSource on Design', () => {
    expect(hasDesignProperty(xml, 'DataSource', 'TestDS')).toBe(true);
  });

  it('has TitleDataSource on Design', () => {
    expect(hasDesignProperty(xml, 'TitleDataSource', 'TestDS')).toBe(true);
  });

  it('has ActionPane control', () => {
    expect(hasNamedControl(xml, 'ActionPane')).toBe(true);
    expect(xml).toContain('AxFormActionPaneControl');
  });

  it('has CustomFilterGroup with QuickFilter', () => {
    expect(hasNamedControl(xml, 'CustomFilterGroup')).toBe(true);
    expect(hasNamedControl(xml, 'QuickFilterControl')).toBe(true);
    expect(xml).toContain('targetControlName');
  });

  it('has Grid with field controls', () => {
    expect(hasNamedControl(xml, 'Grid')).toBe(true);
    expect(xml).toContain('AxFormGridControl');
    expect(hasNamedControl(xml, 'Grid_Field1')).toBe(true);
    expect(hasNamedControl(xml, 'Grid_Field2')).toBe(true);
  });

  it('has InsertIfEmpty=No on datasource', () => {
    expect(xml).toContain('<InsertIfEmpty>No</InsertIfEmpty>');
  });

  it('binds grid fields to correct datasource', () => {
    expect(xml).toContain(`<DataSource>TestDS</DataSource>`);
    expect(xml).toContain(`<DataField>Field1</DataField>`);
  });

  it('generates correct classDeclaration', () => {
    expect(xml).toContain('class TestForm extends FormRun');
  });
});

// ─── SimpleListDetails ───────────────────────────────────────────────────────

describe('SimpleListDetails pattern', () => {
  const xml = FormPatternTemplates.buildSimpleListDetails(defaultOpts);

  it('generates valid XML with correct pattern', () => {
    expect(xml).toContain('<AxForm');
    expect(hasDesignProperty(xml, 'Pattern', 'SimpleListDetails')).toBe(true);
    expect(hasDesignProperty(xml, 'PatternVersion', '1.3')).toBe(true);
  });

  it('has DataSource on Design', () => {
    expect(hasDesignProperty(xml, 'DataSource', 'TestDS')).toBe(true);
  });

  it('has TitleDataSource on Design', () => {
    expect(hasDesignProperty(xml, 'TitleDataSource', 'TestDS')).toBe(true);
  });

  it('has InsertIfEmpty=No on datasource', () => {
    expect(xml).toContain('<InsertIfEmpty>No</InsertIfEmpty>');
  });

  it('has ActionPane control', () => {
    expect(hasNamedControl(xml, 'ActionPane')).toBe(true);
    expect(xml).toContain('AxFormActionPaneControl');
  });

  it('has GridContainer as a SidePanel (Style, not a Pattern)', () => {
    expect(hasNamedControl(xml, 'GridContainer')).toBe(true);
    // SidePanel is a Style on the nav-list container, NOT a <Pattern> — the
    // platform has no "SidePanel" sub-pattern (mining confirmed).
    expect(xml).toContain('<Style>SidePanel</Style>');
    expect(xml).not.toContain('<Pattern>SidePanel</Pattern>');
  });

  it('has QuickFilter inside GridContainer', () => {
    expect(hasNamedControl(xml, 'QuickFilterControl')).toBe(true);
  });

  it('has a read-only List-style nav grid', () => {
    expect(hasNamedControl(xml, 'Grid')).toBe(true);
    expect(xml).toContain('<Style>List</Style>');
    expect(xml).toContain('<AllowEdit>No</AllowEdit>');
  });

  it('has a DetailsHeader (FieldsFieldGroups) and a Details Tabs control', () => {
    expect(hasNamedControl(xml, 'DetailsHeader')).toBe(true);
    expect(hasNamedControl(xml, 'Tab')).toBe(true);
  });

  it('sets ColumnsMode=Fill on FieldsFieldGroups containers', () => {
    expect(xml).toContain('<ColumnsMode>Fill</ColumnsMode>');
  });

  it('has the General details tab page', () => {
    expect(hasNamedControl(xml, 'TabPageGeneral')).toBe(true);
  });

  it('places detail fields in the details header overview group', () => {
    expect(hasNamedControl(xml, 'Overview_Field1')).toBe(true);
  });
});

// ─── DetailsMaster ───────────────────────────────────────────────────────────

describe('DetailsMaster pattern', () => {
  const xml = FormPatternTemplates.buildDetailsMaster(defaultOpts);

  it('generates valid XML with correct pattern', () => {
    expect(xml).toContain('<AxForm');
    expect(hasDesignProperty(xml, 'Pattern', 'DetailsMaster')).toBe(true);
    expect(hasDesignProperty(xml, 'PatternVersion', '1.4')).toBe(true);
    expect(hasDesignProperty(xml, 'Style', 'DetailsFormMaster')).toBe(true);
  });

  it('has DataSource on Design', () => {
    expect(hasDesignProperty(xml, 'DataSource', 'TestDS')).toBe(true);
  });

  it('has TitleDataSource on Design', () => {
    expect(hasDesignProperty(xml, 'TitleDataSource', 'TestDS')).toBe(true);
  });

  it('has InsertIfEmpty=No on datasource', () => {
    expect(xml).toContain('<InsertIfEmpty>No</InsertIfEmpty>');
  });

  it('has ActionPane control', () => {
    expect(hasNamedControl(xml, 'ActionPane')).toBe(true);
    expect(xml).toContain('AxFormActionPaneControl');
  });

  it('has NavigationList (SidePanel) with QuickFilter and a List grid', () => {
    // DetailsMaster 1.4 keeps a hidden NavigationList side panel (not a bare filter).
    expect(hasNamedControl(xml, 'NavigationList')).toBe(true);
    expect(hasNamedControl(xml, 'QuickFilterControl')).toBe(true);
    expect(xml).toContain('<Style>SidePanel</Style>');
  });

  it('has a Details Panel (DetailHeaderGroup + DetailTab) under the Panel Tab', () => {
    // v1.4 wraps the detail view in FormTabPageDetail (PanelStyle=Details).
    expect(hasNamedControl(xml, 'FormTabPageDetail')).toBe(true);
    expect(hasNamedControl(xml, 'DetailHeaderGroup')).toBe(true);
    expect(hasNamedControl(xml, 'DetailTab')).toBe(true);
    expect(xml).toContain('<PanelStyle>Details</PanelStyle>');
  });

  it('has a Grid Panel with a default action', () => {
    expect(hasNamedControl(xml, 'FormTabPageGrid')).toBe(true);
    expect(xml).toContain('<PanelStyle>Grid</PanelStyle>');
    expect(xml).toContain('<DefaultAction>OverviewGridDefaultAction</DefaultAction>');
  });

  it('has Tab with FastTabs style on the inner detail tab', () => {
    expect(hasNamedControl(xml, 'Tab')).toBe(true);
    expect(xml).toContain('<Style>FastTabs</Style>');
  });

  it('has Overview and General tab pages', () => {
    expect(hasNamedControl(xml, 'TabPageOverview')).toBe(true);
    expect(hasNamedControl(xml, 'TabPageGeneral')).toBe(true);
  });

  it('places fields in Overview tab page', () => {
    expect(hasNamedControl(xml, 'Overview_Field1')).toBe(true);
    expect(hasNamedControl(xml, 'Overview_Field2')).toBe(true);
  });

  it('generates correct control hierarchy order: ActionPane → NavigationList → Tab', () => {
    const actionPaneIdx = xml.indexOf('<Name>ActionPane</Name>');
    const navListIdx = xml.indexOf('<Name>NavigationList</Name>');
    const tabIdx = xml.indexOf('<Name>Tab</Name>');
    expect(actionPaneIdx).toBeLessThan(navListIdx);
    expect(navListIdx).toBeLessThan(tabIdx);
  });
});

// ─── DetailsTransaction ──────────────────────────────────────────────────────

describe('DetailsTransaction pattern', () => {
  const opts = {
    ...defaultOpts,
    linesDsName: 'TestLines',
    linesDsTable: 'TestLineTable',
  };
  const xml = FormPatternTemplates.buildDetailsTransaction(opts);

  it('generates valid XML with correct pattern', () => {
    expect(xml).toContain('<AxForm');
    expect(hasDesignProperty(xml, 'Pattern', 'DetailsTransaction')).toBe(true);
    // v1.4 is the only DetailsTransaction version shipped by the platform.
    expect(hasDesignProperty(xml, 'PatternVersion', '1.4')).toBe(true);
    expect(hasDesignProperty(xml, 'Style', 'DetailsFormTransaction')).toBe(true);
  });

  it('has DataSource on Design', () => {
    expect(hasDesignProperty(xml, 'DataSource', 'TestDS')).toBe(true);
  });

  it('has TitleDataSource on Design', () => {
    expect(hasDesignProperty(xml, 'TitleDataSource', 'TestDS')).toBe(true);
  });

  it('has InsertIfEmpty=No on both datasources', () => {
    // Count occurrences of InsertIfEmpty
    const matches = xml.match(/<InsertIfEmpty>No<\/InsertIfEmpty>/g);
    expect(matches).not.toBeNull();
    expect(matches!.length).toBeGreaterThanOrEqual(2);
  });

  it('links lines datasource to the header via JoinSource + Delayed link', () => {
    expect(xml).toContain('<JoinSource>TestDS</JoinSource>');
    expect(xml).toContain('<LinkType>Delayed</LinkType>');
    expect(xml).not.toContain('<LinkType>InnerJoin</LinkType>');
  });

  it('has header and lines datasources', () => {
    expect(xml).toContain(`<Name>TestDS</Name>`);
    expect(xml).toContain(`<Table>TestTable</Table>`);
    expect(xml).toContain(`<Name>TestLines</Name>`);
    expect(xml).toContain(`<Table>TestLineTable</Table>`);
  });

  it('has ActionPane control', () => {
    expect(hasNamedControl(xml, 'ActionPane')).toBe(true);
  });

  it('has a Navigation List (read-only header grid) required by v1.4', () => {
    expect(hasNamedControl(xml, 'NavigationList')).toBe(true);
    expect(hasNamedControl(xml, 'NavigationListGrid')).toBe(true);
    expect(hasNamedControl(xml, 'QuickFilterControl')).toBe(true);
    // The nav list grid is a SidePanel, read-only, List-style grid bound to the header.
    expect(xml).toContain('<Style>SidePanel</Style>');
    expect(xml).toContain('<AllowEdit>No</AllowEdit>');
  });

  it('Navigation List grid is bound to the header datasource', () => {
    const gridIdx = xml.indexOf('<Name>NavigationListGrid</Name>');
    expect(gridIdx).toBeGreaterThan(-1);
    expect(xml.indexOf('<DataSource>TestDS</DataSource>', gridIdx)).toBeGreaterThan(-1);
  });

  it('has the v1.4 nested panel tabs (MainTab + DetailsTab) with FastTabs leaves', () => {
    expect(hasNamedControl(xml, 'MainTab')).toBe(true);
    expect(hasNamedControl(xml, 'DetailsTab')).toBe(true);
    expect(hasNamedControl(xml, 'LineViewTab')).toBe(true);
    expect(xml).toContain('<Style>FastTabs</Style>');
  });

  it('pairs Details and Grid panels under MainTab', () => {
    expect(hasNamedControl(xml, 'TabPageDetails')).toBe(true);
    expect(hasNamedControl(xml, 'TabPageGrid')).toBe(true);
    expect(xml).toContain('<PanelStyle>Details</PanelStyle>');
    expect(xml).toContain('<PanelStyle>Grid</PanelStyle>');
  });

  it('has Line View header and lines pages', () => {
    expect(hasNamedControl(xml, 'LineViewHeader')).toBe(true);
    expect(hasNamedControl(xml, 'LineViewLines')).toBe(true);
  });

  it('has LinesGrid bound to lines datasource', () => {
    expect(hasNamedControl(xml, 'LinesGrid')).toBe(true);
    expect(xml).toContain(`<DataSource>TestLines</DataSource>`);
  });

  it('carries a DetailTitleContainer header (HeaderInfo)', () => {
    expect(hasNamedControl(xml, 'HeaderInfo')).toBe(true);
    expect(xml).toContain('<Style>DetailTitleContainer</Style>');
  });

  it('HeaderGeneralGroup does not have redundant Pattern attribute', () => {
    // The group inside LineViewHeader should not have its own Pattern=FieldsFieldGroups
    const headerGroupIdx = xml.indexOf('<Name>HeaderGeneralGroup</Name>');
    expect(headerGroupIdx).toBeGreaterThan(-1);
    // Check the ~200 chars after HeaderGeneralGroup name — should have Type but not Pattern
    const after = xml.substring(headerGroupIdx, headerGroupIdx + 200);
    expect(after).toContain('<Type>Group</Type>');
    expect(after).not.toContain('<Pattern>FieldsFieldGroups</Pattern>');
  });
});

// ─── Dialog ──────────────────────────────────────────────────────────────────

describe('Dialog pattern', () => {
  const xml = FormPatternTemplates.buildDialog(defaultOpts);

  it('generates valid XML with correct pattern', () => {
    expect(xml).toContain('<AxForm');
    expect(hasDesignProperty(xml, 'Pattern', 'Dialog')).toBe(true);
    expect(hasDesignProperty(xml, 'PatternVersion', '1.2')).toBe(true);
    expect(hasDesignProperty(xml, 'Frame', 'Dialog')).toBe(true);
  });

  it('has DialogBody group with DialogContent style', () => {
    expect(hasNamedControl(xml, 'DialogBody')).toBe(true);
    expect(xml).toContain('<Style>DialogContent</Style>');
  });

  it('has OK and Cancel buttons', () => {
    expect(hasNamedControl(xml, 'OkButton')).toBe(true);
    expect(hasNamedControl(xml, 'CloseButton')).toBe(true);
    expect(xml).toContain('<Command>OK</Command>');
    expect(xml).toContain('<Command>Cancel</Command>');
  });

  it('has ButtonGroup with DialogCommitContainer style', () => {
    expect(xml).toContain('<Style>DialogCommitContainer</Style>');
  });

  it('binds body fields to datasource when dsName is provided', () => {
    expect(xml).toContain(`<DataSource>TestDS</DataSource>`);
    expect(xml).toContain(`<DataField>Field1</DataField>`);
  });

  it('supports unbound dialog (no datasource)', () => {
    const unboundXml = FormPatternTemplates.buildDialog({
      formName: 'UnboundDialog',
      gridFields: ['Param1'],
    });
    expect(unboundXml).toContain('<DataSources />');
    expect(hasNamedControl(unboundXml, 'Param1')).toBe(true);
  });

  it('supports sections as tab pages', () => {
    const sectionXml = FormPatternTemplates.buildDialog({
      formName: 'SectionDialog',
      sections: [
        { name: 'General', caption: 'General' },
        { name: 'Advanced', caption: 'Advanced' },
      ],
    });
    expect(hasNamedControl(sectionXml, 'General')).toBe(true);
    expect(hasNamedControl(sectionXml, 'Advanced')).toBe(true);
    expect(sectionXml).toContain('<Caption>Advanced</Caption>');
  });
});

// ─── TableOfContents ─────────────────────────────────────────────────────────

describe('TableOfContents pattern', () => {
  const xml = FormPatternTemplates.buildTableOfContents({
    ...defaultOpts,
    sections: [
      { name: 'TabPageGeneral', caption: 'General' },
      { name: 'TabPageSetup', caption: 'Setup' },
    ],
  });

  it('generates valid XML with correct pattern', () => {
    expect(xml).toContain('<AxForm');
    expect(hasDesignProperty(xml, 'Pattern', 'TableOfContents')).toBe(true);
    expect(hasDesignProperty(xml, 'PatternVersion', '1.1')).toBe(true);
  });

  it('has no ActionPane — the TableOfContents pattern forbids one in Design', () => {
    expect(hasNamedControl(xml, 'ActionPane')).toBe(false);
    expect(xml).not.toContain('AxFormActionPaneControl');
  });

  it('wraps each section in a TOCTitleContainer + nested FastTab', () => {
    expect(xml).toContain('<Style>TOCTitleContainer</Style>');
    expect(xml).toContain('<Style>VerticalTabs</Style>');
    expect(hasNamedControl(xml, 'TabPageGeneralFastTab')).toBe(true);
  });

  it('has DataSource on Design when dsName is provided', () => {
    expect(hasDesignProperty(xml, 'DataSource', 'TestDS')).toBe(true);
  });

  it('has InsertIfEmpty=No on datasource', () => {
    expect(xml).toContain('<InsertIfEmpty>No</InsertIfEmpty>');
  });

  it('has a TOC navigation Tab with no invalid TabStyle', () => {
    // 'TOCList' is not a valid FormTabStyle enum — it makes xppc abort
    // deserialization, which suppresses pattern validation for the whole build.
    expect(hasNamedControl(xml, 'Tab')).toBe(true);
    expect(xml).not.toContain('<Style>TOCList</Style>');
  });

  it('generates tab pages from sections', () => {
    expect(hasNamedControl(xml, 'TabPageGeneral')).toBe(true);
    expect(hasNamedControl(xml, 'TabPageSetup')).toBe(true);
    expect(xml).toContain('<Caption>General</Caption>');
    expect(xml).toContain('<Caption>Setup</Caption>');
  });

  it('generates correct control order: ActionPane before Tab', () => {
    const apIdx = xml.indexOf('<Name>ActionPane</Name>');
    const tabIdx = xml.indexOf('<Name>Tab</Name>');
    expect(apIdx).toBeLessThan(tabIdx);
  });

  it('works without datasource', () => {
    const noDsXml = FormPatternTemplates.buildTableOfContents({
      formName: 'NoDsForm',
    });
    expect(noDsXml).toContain('<DataSources />');
    expect(noDsXml).not.toContain('DataSource xmlns="">undefined');
  });

  it('generates default sections when none provided', () => {
    const defaultXml = FormPatternTemplates.buildTableOfContents({
      formName: 'DefaultTOC',
      dsName: 'Params',
      dsTable: 'ParamsTable',
    });
    expect(hasNamedControl(defaultXml, 'TabPageGeneral')).toBe(true);
    expect(hasNamedControl(defaultXml, 'TabPageSetup')).toBe(true);
  });
});

// ─── Lookup ──────────────────────────────────────────────────────────────────

describe('Lookup pattern', () => {
  const xml = FormPatternTemplates.buildLookup(defaultOpts);

  it('generates valid XML with correct pattern', () => {
    // The installed platform exposes the grid-only lookup as 'LookupGridOnly' 1.1.
    expect(hasDesignProperty(xml, 'Pattern', 'LookupGridOnly')).toBe(true);
    expect(hasDesignProperty(xml, 'PatternVersion', '1.1')).toBe(true);
    expect(hasDesignProperty(xml, 'Style', 'Lookup')).toBe(true);
  });

  it('is grid-only — no filter group allowed by LookupGridOnly', () => {
    expect(hasNamedControl(xml, 'CustomFilterGroup')).toBe(false);
    expect(hasDesignProperty(xml, 'HeightMode', 'SizeToContent')).toBe(true);
  });

  it('has Grid with fields', () => {
    expect(hasNamedControl(xml, 'Grid')).toBe(true);
    expect(hasNamedControl(xml, 'Grid_Field1')).toBe(true);
  });
});

// ─── ListPage ────────────────────────────────────────────────────────────────

describe('ListPage pattern', () => {
  const xml = FormPatternTemplates.buildListPage(defaultOpts);

  it('generates valid XML with correct pattern', () => {
    expect(hasDesignProperty(xml, 'Pattern', 'ListPage')).toBe(true);
    expect(hasDesignProperty(xml, 'PatternVersion', 'UX7 1.0')).toBe(true);
    expect(hasDesignProperty(xml, 'Style', 'ListPage')).toBe(true);
  });

  it('has DataSource and TitleDataSource on Design', () => {
    expect(hasDesignProperty(xml, 'DataSource', 'TestDS')).toBe(true);
    expect(hasDesignProperty(xml, 'TitleDataSource', 'TestDS')).toBe(true);
  });

  it('has ActionPane with ActionPaneTab structure', () => {
    expect(hasNamedControl(xml, 'ActionPane')).toBe(true);
    expect(hasNamedControl(xml, 'ActionPaneTab')).toBe(true);
    expect(hasNamedControl(xml, 'NewButtonGroup')).toBe(true);
  });

  it('has CustomFilterGroup with QuickFilter', () => {
    expect(hasNamedControl(xml, 'CustomFilterGroup')).toBe(true);
    expect(hasNamedControl(xml, 'QuickFilterControl')).toBe(true);
  });

  it('has Grid with read-only datasource', () => {
    expect(hasNamedControl(xml, 'Grid')).toBe(true);
    expect(xml).toContain('<AllowCreate>No</AllowCreate>');
    expect(xml).toContain('<AllowEdit>No</AllowEdit>');
    expect(xml).toContain('<AllowDelete>No</AllowDelete>');
    expect(xml).toContain('<InsertIfEmpty>No</InsertIfEmpty>');
  });
});

// ─── Edge cases ──────────────────────────────────────────────────────────────

describe('Form pattern edge cases', () => {
  it('SimpleList works with empty gridFields', () => {
    const xml = FormPatternTemplates.buildSimpleList({
      formName: 'EmptyForm', dsName: 'DS', dsTable: 'T',
    });
    expect(xml).toContain('<AxForm');
    expect(hasNamedControl(xml, 'Grid')).toBe(true);
  });

  it('DetailsMaster works with empty gridFields', () => {
    const xml = FormPatternTemplates.buildDetailsMaster({
      formName: 'EmptyMaster', dsName: 'DS', dsTable: 'T',
    });
    expect(xml).toContain('<AxForm');
    expect(hasNamedControl(xml, 'Tab')).toBe(true);
  });

  it('DetailsTransaction uses D365FO-correct default linesDsName when not provided', () => {
    // SalesTable → SalesLine, Order → OrderLine  (strips Table suffix, adds singular Line)
    const xmlTable = FormPatternTemplates.buildDetailsTransaction({
      formName: 'SalesForm', dsName: 'SalesTable', dsTable: 'SalesTable',
    });
    expect(xmlTable).toContain('<Name>SalesLine</Name>');

    const xmlNoSuffix = FormPatternTemplates.buildDetailsTransaction({
      formName: 'OrderForm', dsName: 'Order', dsTable: 'OrderTable',
    });
    expect(xmlNoSuffix).toContain('<Name>OrderLine</Name>');
  });

  it('caption is optional and omitted correctly', () => {
    const xml = FormPatternTemplates.buildSimpleList({
      formName: 'NoCaptionForm', dsName: 'DS', dsTable: 'T',
    });
    expect(xml).not.toContain('<Caption');
  });

  it('all patterns generate well-formed XML declarations', () => {
    const patterns = [
      FormPatternTemplates.buildSimpleList(defaultOpts),
      FormPatternTemplates.buildSimpleListDetails(defaultOpts),
      FormPatternTemplates.buildDetailsMaster(defaultOpts),
      FormPatternTemplates.buildDetailsTransaction({ ...defaultOpts, linesDsName: 'Lines', linesDsTable: 'LineT' }),
      FormPatternTemplates.buildDialog(defaultOpts),
      FormPatternTemplates.buildTableOfContents({ ...defaultOpts, sections: [{ name: 'S1', caption: 'S1' }] }),
      FormPatternTemplates.buildLookup(defaultOpts),
      FormPatternTemplates.buildListPage(defaultOpts),
    ];
    for (const xml of patterns) {
      expect(xml).toContain('<?xml version="1.0" encoding="utf-8"?>');
      expect(xml).toContain('<AxForm');
      expect(xml).toContain('</AxForm>');
    }
  });
});

// ─── Control-type correctness ────────────────────────────────────────────────

describe('typed field controls', () => {
  const fieldTypes = new Map([
    ['status', { iType: 'AxFormComboBoxControl', typeValue: 'ComboBox' }],
    ['amount', { iType: 'AxFormRealControl', typeValue: 'Real' }],
    ['name', { iType: 'AxFormStringControl', typeValue: 'String' }],
  ]);
  const opts = { ...defaultOpts, gridFields: ['Name', 'Status', 'Amount'], fieldTypes };

  it('SimpleList renders the correct control type per field', () => {
    const xml = FormPatternTemplates.buildSimpleList(opts);
    expect(xml).toContain('i:type="AxFormComboBoxControl"');
    expect(xml).toContain('<Type>ComboBox</Type>');
    expect(xml).toContain('i:type="AxFormRealControl"');
  });

  it('defaults to string controls when no type map is given', () => {
    const xml = FormPatternTemplates.buildSimpleList({ ...defaultOpts });
    expect(xml).toContain('i:type="AxFormStringControl"');
    expect(xml).not.toContain('AxFormComboBoxControl');
  });

  it('DetailsTransaction renders typed line-grid columns', () => {
    const xml = FormPatternTemplates.buildDetailsTransaction({
      ...opts,
      linesDsName: 'Lines',
      linesDsTable: 'LineT',
      linesFields: ['Qty'],
      linesFieldTypes: new Map([['qty', { iType: 'AxFormRealControl', typeValue: 'Real' }]]),
    });
    expect(xml).toContain('<Name>Line_Qty</Name>');
    const idx = xml.indexOf('<Name>Line_Qty</Name>');
    expect(xml.slice(idx - 120, idx)).toContain('AxFormRealControl');
  });
});

// ─── Generated forms conform to their own pattern (no validator errors) ───────

describe('generated forms pass the pattern validator', () => {
  const cases: Array<[string, string]> = [
    ['SimpleList', FormPatternTemplates.buildSimpleList(defaultOpts)],
    ['SimpleListDetails', FormPatternTemplates.buildSimpleListDetails(defaultOpts)],
    ['DetailsMaster', FormPatternTemplates.buildDetailsMaster(defaultOpts)],
    ['DetailsTransaction', FormPatternTemplates.buildDetailsTransaction({
      ...defaultOpts, linesDsName: 'Lines', linesDsTable: 'LineT', linesFields: ['Field1'],
    })],
  ];

  for (const [name, xml] of cases) {
    it(`${name} produces no pattern errors`, async () => {
      const report = await validateFormPatternXml(xml);
      const errors = report.violations.filter((v) => v.severity === 'error');
      expect(errors, JSON.stringify(errors, null, 2)).toHaveLength(0);
    });
  }
});
