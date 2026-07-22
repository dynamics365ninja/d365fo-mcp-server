/**
 * D365FO Form Pattern Templates
 *
 * Each static method generates a complete, pattern-correct AxForm XML skeleton
 * validated against real AOT forms from K:\AosService\PackagesLocalDirectory.
 *
 * Reference forms used:
 *   SimpleList        → CustGroup.xml         (ApplicationSuite\Foundation)
 *   SimpleListDetails → PaymTerm.xml          (ApplicationSuite\Foundation)
 *   DetailsMaster     → CustTable.xml         (ApplicationSuite\Foundation)
 *   DetailsTransaction→ SalesTable.xml        (ApplicationSuite\Foundation)
 *   Dialog            → ProjTableCreate.xml   (ApplicationSuite\Foundation)
 *   TableOfContents   → CustParameters.xml    (ApplicationSuite\Foundation)
 *   Lookup            → SysLanguageLookup.xml (ApplicationPlatform)
 */

import { type FieldControlMap, controlForField } from './fieldControlTypes.js';

export interface FormTemplateOptions {
  /** Form name (also used for classDeclaration) */
  formName: string;
  /** Primary datasource name (usually same as table name) */
  dsName?: string;
  /** Primary datasource table name */
  dsTable?: string;
  /** Caption label text or label reference (@Model:Label) */
  caption?: string;
  /** Field names to put in the grid (for SimpleList, Lookup, etc.) */
  gridFields?: string[];
  /** Section definitions for TableOfContents / Dialog */
  sections?: Array<{ name: string; caption: string }>;
  /** Lines datasource name for DetailsTransaction */
  linesDsName?: string;
  /** Lines datasource table name for DetailsTransaction */
  linesDsTable?: string;
  /** Field names to show in the lines grid (DetailsTransaction) */
  linesFields?: string[];
  /**
   * Field → control-type map for the primary table. When provided, field
   * controls render with the correct type (ComboBox for enums, Date for dates,
   * …) instead of defaulting every field to a string control.
   */
  fieldTypes?: FieldControlMap;
  /** Field → control-type map for the lines table (DetailsTransaction). */
  linesFieldTypes?: FieldControlMap;
  /**
   * The datasource table's `TitleField1` — the field a DetailsMaster header
   * title control must bind to. When omitted the first grid field is used, which
   * is only ever right by accident: grid fields arrive in ALPHABETICAL order, so
   * the title ends up bound to whatever field sorts first
   * (docs/eval-sweep-findings-2026-07-21.md #32).
   */
  titleField?: string;
}

/**
 * A form control that carries `<DataGroup>` MUST also carry a sibling
 * `<DataSource>`; the field group is resolved on that datasource's table. Without
 * it a full build fails with `Field group 'Overview' does not exist` — and an
 * INCREMENTAL build passes it silently, which is why this survived several
 * captures (docs/eval-sweep-findings-2026-07-21.md #32, HEADLINE (b)).
 */

/** Supported top-level D365FO form patterns */
export type FormPattern =
  | 'SimpleList'
  | 'SimpleListDetails'
  | 'DetailsMaster'
  | 'DetailsTransaction'
  | 'Dialog'
  | 'TableOfContents'
  | 'Lookup'
  | 'ListPage'
  | 'Workspace';

export class FormPatternTemplates {

  /**
   * Render a single field input control with the correct control type.
   *
   * `indent` is the tab string for the opening `<AxFormControl>` line; child
   * elements are emitted one tab deeper and the `i:type` attribute two tabs
   * deeper, matching the surrounding AOT layout. The control type is resolved
   * from `types` (enum→ComboBox, date→Date, …); unknown fields fall back to a
   * string control.
   */
  static fieldControl(
    field: string,
    dsName: string,
    indent: string,
    namePrefix = '',
    types?: FieldControlMap,
  ): string {
    const ctl = controlForField(field, types);
    return (
      `${indent}<AxFormControl xmlns=""\n` +
      `${indent}\t\ti:type="${ctl.iType}">\n` +
      `${indent}\t<Name>${namePrefix}${field}</Name>\n` +
      `${indent}\t<Type>${ctl.typeValue}</Type>\n` +
      `${indent}\t<FormControlExtension\n${indent}\t\ti:nil="true" />\n` +
      `${indent}\t<DataField>${field}</DataField>\n` +
      `${indent}\t<DataSource>${dsName}</DataSource>\n` +
      `${indent}</AxFormControl>\n`
    );
  }

  // SimpleList (v1.1): simple entity with < 10 fields per record (setup tables, groups, etc). Reference: CustGroup.
  static buildSimpleList(opt: FormTemplateOptions): string {
    const { formName, dsName = formName, dsTable = dsName, caption, gridFields = [] } = opt;
    const captionXml = caption
      ? `\t\t<Caption xmlns="">${caption}</Caption>\n`
      : '';
    const defaultCol = gridFields.length > 0 ? `Grid_${gridFields[0]}` : `Grid_${dsName}`;

    const fieldControls = gridFields.map(f =>
      FormPatternTemplates.fieldControl(f, dsName, '\t\t\t\t\t', 'Grid_', opt.fieldTypes)
    ).join('');

    const dsFields = gridFields.length > 0
      ? `\t\t\t<Fields>\n` +
        gridFields.map(f =>
          `\t\t\t\t<AxFormDataSourceField>\n\t\t\t\t\t<DataField>${f}</DataField>\n\t\t\t\t</AxFormDataSourceField>\n`
        ).join('') +
        `\t\t\t</Fields>\n`
      : `\t\t\t<Fields />\n`;

    return `<?xml version="1.0" encoding="utf-8"?>
<AxForm xmlns:i="http://www.w3.org/2001/XMLSchema-instance" xmlns="Microsoft.Dynamics.AX.Metadata.V6">
\t<Name>${formName}</Name>
\t<SourceCode>
\t\t<Methods xmlns="">
\t\t\t<Method>
\t\t\t\t<Name>classDeclaration</Name>
\t\t\t\t<Source><![CDATA[
[Form]
public class ${formName} extends FormRun
{
}

]]></Source>
\t\t\t</Method>
\t\t</Methods>
\t\t<DataSources xmlns="" />
\t\t<DataControls xmlns="" />
\t\t<Members xmlns="" />
\t</SourceCode>
\t<DataSources>
\t\t<AxFormDataSource xmlns="">
\t\t\t<Name>${dsName}</Name>
\t\t\t<Table>${dsTable}</Table>
${dsFields}\t\t\t<ReferencedDataSources />
\t\t\t<InsertIfEmpty>No</InsertIfEmpty>
\t\t\t<DataSourceLinks />
\t\t\t<DerivedDataSources />
\t\t</AxFormDataSource>
\t</DataSources>
\t<Design>
${captionXml}\t\t<DataSource xmlns="">${dsName}</DataSource>
\t\t<HideIfEmpty xmlns="">No</HideIfEmpty>
\t\t<Pattern xmlns="">SimpleList</Pattern>
\t\t<PatternVersion xmlns="">1.1</PatternVersion>
\t\t<Style xmlns="">SimpleList</Style>
\t\t<TitleDataSource xmlns="">${dsName}</TitleDataSource>
\t\t<Controls xmlns="">
\t\t\t<AxFormControl xmlns=""
\t\t\t\t\ti:type="AxFormActionPaneControl">
\t\t\t\t<Name>ActionPane</Name>
\t\t\t\t<ElementPosition>134217727</ElementPosition>
\t\t\t\t<FilterExpression>%1</FilterExpression>
\t\t\t\t<Type>ActionPane</Type>
\t\t\t\t<VerticalSpacing>-1</VerticalSpacing>
\t\t\t\t<FormControlExtension
\t\t\t\t\ti:nil="true" />
\t\t\t\t<Controls>
\t\t\t\t\t<AxFormControl xmlns=""
\t\t\t\t\t\t\ti:type="AxFormButtonGroupControl">
\t\t\t\t\t\t<Name>ButtonGroup</Name>
\t\t\t\t\t\t<Type>ButtonGroup</Type>
\t\t\t\t\t\t<FormControlExtension
\t\t\t\t\t\t\ti:nil="true" />
\t\t\t\t\t\t<Controls />
\t\t\t\t\t\t<ArrangeMethod>Vertical</ArrangeMethod>
\t\t\t\t\t</AxFormControl>
\t\t\t\t</Controls>
\t\t\t\t<AlignChild>No</AlignChild>
\t\t\t\t<AlignChildren>No</AlignChildren>
\t\t\t\t<ArrangeMethod>Vertical</ArrangeMethod>
\t\t\t</AxFormControl>
\t\t\t<AxFormControl xmlns=""
\t\t\t\t\ti:type="AxFormGroupControl">
\t\t\t\t<Name>CustomFilterGroup</Name>
\t\t\t\t<Pattern>CustomAndQuickFilters</Pattern>
\t\t\t\t<PatternVersion>1.1</PatternVersion>
\t\t\t\t<Type>Group</Type>
\t\t\t\t<WidthMode>SizeToAvailable</WidthMode>
\t\t\t\t<FormControlExtension
\t\t\t\t\ti:nil="true" />
\t\t\t\t<Controls>
\t\t\t\t\t<AxFormControl>
\t\t\t\t\t\t<Name>QuickFilterControl</Name>
\t\t\t\t\t\t<FormControlExtension>
\t\t\t\t\t\t\t<Name>QuickFilterControl</Name>
\t\t\t\t\t\t\t<ExtensionComponents />
\t\t\t\t\t\t\t<ExtensionProperties>
\t\t\t\t\t\t\t\t<AxFormControlExtensionProperty>
\t\t\t\t\t\t\t\t\t<Name>targetControlName</Name>
\t\t\t\t\t\t\t\t\t<Type>String</Type>
\t\t\t\t\t\t\t\t\t<Value>Grid</Value>
\t\t\t\t\t\t\t\t</AxFormControlExtensionProperty>
\t\t\t\t\t\t\t\t<AxFormControlExtensionProperty>
\t\t\t\t\t\t\t\t\t<Name>defaultColumnName</Name>
\t\t\t\t\t\t\t\t\t<Type>String</Type>
\t\t\t\t\t\t\t\t\t<Value>${defaultCol}</Value>
\t\t\t\t\t\t\t\t</AxFormControlExtensionProperty>
\t\t\t\t\t\t\t\t<AxFormControlExtensionProperty>
\t\t\t\t\t\t\t\t\t<Name>placeholderText</Name>
\t\t\t\t\t\t\t\t\t<Type>String</Type>
\t\t\t\t\t\t\t\t</AxFormControlExtensionProperty>
\t\t\t\t\t\t\t</ExtensionProperties>
\t\t\t\t\t\t</FormControlExtension>
\t\t\t\t\t</AxFormControl>
\t\t\t\t</Controls>
\t\t\t\t<ArrangeMethod>HorizontalLeft</ArrangeMethod>
\t\t\t\t<FrameType>None</FrameType>
\t\t\t\t<Style>CustomFilter</Style>
\t\t\t\t<ViewEditMode>Edit</ViewEditMode>
\t\t\t</AxFormControl>
\t\t\t<AxFormControl xmlns=""
\t\t\t\t\ti:type="AxFormGridControl">
\t\t\t\t<Name>Grid</Name>
\t\t\t\t<ElementPosition>1431655764</ElementPosition>
\t\t\t\t<FilterExpression>%1</FilterExpression>
\t\t\t\t<Type>Grid</Type>
\t\t\t\t<VerticalSpacing>-1</VerticalSpacing>
\t\t\t\t<FormControlExtension
\t\t\t\t\ti:nil="true" />
\t\t\t\t<Controls>
${fieldControls}\t\t\t\t</Controls>
\t\t\t\t<AlternateRowShading>No</AlternateRowShading>
\t\t\t\t<DataGroup>Overview</DataGroup>
\t\t\t\t<DataSource>${dsName}</DataSource>
\t\t\t\t<MultiSelect>No</MultiSelect>
\t\t\t\t<ShowRowLabels>No</ShowRowLabels>
\t\t\t\t<Style>Tabular</Style>
\t\t\t</AxFormControl>
\t\t</Controls>
\t</Design>
\t<Parts />
</AxForm>
`;
  }

  // SimpleListDetails (v1.3): medium complexity entity — left list panel, right details panel. Reference: PaymTerm.
  static buildSimpleListDetails(opt: FormTemplateOptions): string {
    const { formName, dsName = formName, dsTable = dsName, caption, gridFields = [] } = opt;
    const captionXml = caption
      ? `\t\t<Caption xmlns="">${caption}</Caption>\n`
      : '';
    const defaultCol = gridFields.length > 0 ? `Grid_${gridFields[0]}` : `Grid_${dsName}`;

    const listFieldControls = gridFields.slice(0, 3).map(f =>
      FormPatternTemplates.fieldControl(f, dsName, '\t\t\t\t\t\t\t\t', 'Grid_', opt.fieldTypes)
    ).join('');

    const detailFieldControls = gridFields.map(f =>
      FormPatternTemplates.fieldControl(f, dsName, '\t\t\t\t\t\t\t\t\t\t', 'Overview_', opt.fieldTypes)
    ).join('');

    // xppc requires the Tab's FieldsFieldGroups page to hold real controls; an empty group is rejected.
    const tabFieldControls = gridFields.map(f =>
      FormPatternTemplates.fieldControl(f, dsName, '\t\t\t\t\t\t\t\t\t', 'Tab_', opt.fieldTypes)
    ).join('');

    return `<?xml version="1.0" encoding="utf-8"?>
<AxForm xmlns:i="http://www.w3.org/2001/XMLSchema-instance" xmlns="Microsoft.Dynamics.AX.Metadata.V6">
\t<Name>${formName}</Name>
\t<SourceCode>
\t\t<Methods xmlns="">
\t\t\t<Method>
\t\t\t\t<Name>classDeclaration</Name>
\t\t\t\t<Source><![CDATA[
[Form]
public class ${formName} extends FormRun
{
}

]]></Source>
\t\t\t</Method>
\t\t</Methods>
\t\t<DataSources xmlns="" />
\t\t<DataControls xmlns="" />
\t\t<Members xmlns="" />
\t</SourceCode>
\t<DataSources>
\t\t<AxFormDataSource xmlns="">
\t\t\t<Name>${dsName}</Name>
\t\t\t<Table>${dsTable}</Table>
\t\t\t<Fields />
\t\t\t<ReferencedDataSources />
\t\t\t<InsertIfEmpty>No</InsertIfEmpty>
\t\t\t<DataSourceLinks />
\t\t\t<DerivedDataSources />
\t\t</AxFormDataSource>
\t</DataSources>
\t<Design>
${captionXml}\t\t<DataSource xmlns="">${dsName}</DataSource>
\t\t<Pattern xmlns="">SimpleListDetails</Pattern>
\t\t<PatternVersion xmlns="">1.3</PatternVersion>
\t\t<Style xmlns="">SimpleListDetails</Style>
\t\t<TitleDataSource xmlns="">${dsName}</TitleDataSource>
\t\t<Controls xmlns="">
\t\t\t<AxFormControl xmlns=""
\t\t\t\t\ti:type="AxFormActionPaneControl">
\t\t\t\t<Name>ActionPane</Name>
\t\t\t\t<ElementPosition>134217727</ElementPosition>
\t\t\t\t<FilterExpression>%1</FilterExpression>
\t\t\t\t<Type>ActionPane</Type>
\t\t\t\t<VerticalSpacing>-1</VerticalSpacing>
\t\t\t\t<FormControlExtension
\t\t\t\t\ti:nil="true" />
\t\t\t\t<Controls>
\t\t\t\t\t<AxFormControl xmlns=""
\t\t\t\t\t\t\ti:type="AxFormButtonGroupControl">
\t\t\t\t\t\t<Name>ButtonGroup</Name>
\t\t\t\t\t\t<Type>ButtonGroup</Type>
\t\t\t\t\t\t<FormControlExtension
\t\t\t\t\t\t\ti:nil="true" />
\t\t\t\t\t\t<Controls />
\t\t\t\t\t\t<ArrangeMethod>Vertical</ArrangeMethod>
\t\t\t\t\t</AxFormControl>
\t\t\t\t</Controls>
\t\t\t\t<AlignChild>No</AlignChild>
\t\t\t\t<AlignChildren>No</AlignChildren>
\t\t\t\t<ArrangeMethod>Vertical</ArrangeMethod>
\t\t\t</AxFormControl>
\t\t\t<AxFormControl xmlns=""
\t\t\t\t\ti:type="AxFormGroupControl">
\t\t\t\t<Name>GridContainer</Name>
\t\t\t\t<HeightMode>SizeToAvailable</HeightMode>
\t\t\t\t<Type>Group</Type>
\t\t\t\t<FormControlExtension
\t\t\t\t\ti:nil="true" />
\t\t\t\t<Controls>
\t\t\t\t\t<AxFormControl>
\t\t\t\t\t\t<Name>QuickFilterControl</Name>
\t\t\t\t\t\t<WidthMode>SizeToAvailable</WidthMode>
\t\t\t\t\t\t<FormControlExtension>
\t\t\t\t\t\t\t<Name>QuickFilterControl</Name>
\t\t\t\t\t\t\t<ExtensionComponents />
\t\t\t\t\t\t\t<ExtensionProperties>
\t\t\t\t\t\t\t\t<AxFormControlExtensionProperty>
\t\t\t\t\t\t\t\t\t<Name>targetControlName</Name>
\t\t\t\t\t\t\t\t\t<Type>String</Type>
\t\t\t\t\t\t\t\t\t<Value>Grid</Value>
\t\t\t\t\t\t\t\t</AxFormControlExtensionProperty>
\t\t\t\t\t\t\t\t<AxFormControlExtensionProperty>
\t\t\t\t\t\t\t\t\t<Name>defaultColumnName</Name>
\t\t\t\t\t\t\t\t\t<Type>String</Type>
\t\t\t\t\t\t\t\t\t<Value>${defaultCol}</Value>
\t\t\t\t\t\t\t\t</AxFormControlExtensionProperty>
\t\t\t\t\t\t\t\t<AxFormControlExtensionProperty>
\t\t\t\t\t\t\t\t\t<Name>placeholderText</Name>
\t\t\t\t\t\t\t\t\t<Type>String</Type>
\t\t\t\t\t\t\t\t</AxFormControlExtensionProperty>
\t\t\t\t\t\t\t</ExtensionProperties>
\t\t\t\t\t\t</FormControlExtension>
\t\t\t\t\t</AxFormControl>
\t\t\t\t\t<AxFormControl xmlns=""
\t\t\t\t\t\t\ti:type="AxFormGridControl">
\t\t\t\t\t\t<Name>Grid</Name>
\t\t\t\t\t\t<AllowEdit>No</AllowEdit>
\t\t\t\t\t\t<Type>Grid</Type>
\t\t\t\t\t\t<WidthMode>SizeToContent</WidthMode>
\t\t\t\t\t\t<FormControlExtension
\t\t\t\t\t\t\ti:nil="true" />
\t\t\t\t\t\t<Controls>
${listFieldControls}\t\t\t\t\t\t</Controls>
\t\t\t\t\t\t<AlternateRowShading>No</AlternateRowShading>
\t\t\t\t\t\t<DataSource>${dsName}</DataSource>
\t\t\t\t\t\t<GridLinesStyle>Vertical</GridLinesStyle>
\t\t\t\t\t\t<MultiSelect>No</MultiSelect>
\t\t\t\t\t\t<ShowRowLabels>No</ShowRowLabels>
\t\t\t\t\t\t<Style>List</Style>
\t\t\t\t\t</AxFormControl>
\t\t\t\t</Controls>
\t\t\t\t<FrameType>None</FrameType>
\t\t\t\t<Style>SidePanel</Style>
\t\t\t</AxFormControl>
\t\t\t<AxFormControl xmlns=""
\t\t\t\t\ti:type="AxFormGroupControl">
\t\t\t\t<Name>DetailsHeader</Name>
\t\t\t\t<Pattern>FieldsFieldGroups</Pattern>
\t\t\t\t<PatternVersion>1.1</PatternVersion>
\t\t\t\t<Type>Group</Type>
\t\t\t\t<WidthMode>SizeToAvailable</WidthMode>
\t\t\t\t<FormControlExtension
\t\t\t\t\ti:nil="true" />
\t\t\t\t<Controls>
\t\t\t\t\t<AxFormControl xmlns=""
\t\t\t\t\t\t\ti:type="AxFormGroupControl">
\t\t\t\t\t\t<Name>Overview</Name>
\t\t\t\t\t\t<Type>Group</Type>
\t\t\t\t\t\t<DataGroup>Overview</DataGroup>
\t\t\t\t\t\t<DataSource>${dsName}</DataSource>
\t\t\t\t\t\t<FormControlExtension
\t\t\t\t\t\t\ti:nil="true" />
\t\t\t\t\t\t<Controls>
${detailFieldControls}\t\t\t\t\t\t</Controls>
\t\t\t\t\t\t<FrameType>None</FrameType>
\t\t\t\t\t</AxFormControl>
\t\t\t\t</Controls>
\t\t\t\t<ColumnsMode>Fill</ColumnsMode>
\t\t\t\t<FrameType>None</FrameType>
\t\t\t</AxFormControl>
\t\t\t<AxFormControl xmlns=""
\t\t\t\t\ti:type="AxFormTabControl">
\t\t\t\t<Name>Tab</Name>
\t\t\t\t<Type>Tab</Type>
\t\t\t\t<FormControlExtension
\t\t\t\t\ti:nil="true" />
\t\t\t\t<Controls>
\t\t\t\t\t<AxFormControl xmlns=""
\t\t\t\t\t\t\ti:type="AxFormTabPageControl">
\t\t\t\t\t\t<Name>TabPageGeneral</Name>
\t\t\t\t\t\t<Pattern>FieldsFieldGroups</Pattern>
\t\t\t\t\t\t<PatternVersion>1.1</PatternVersion>
\t\t\t\t\t\t<Type>TabPage</Type>
\t\t\t\t\t\t<FormControlExtension
\t\t\t\t\t\t\ti:nil="true" />
\t\t\t\t\t\t<Controls>
\t\t\t\t\t\t\t<AxFormControl xmlns=""
\t\t\t\t\t\t\t\t\ti:type="AxFormGroupControl">
\t\t\t\t\t\t\t\t<Name>GeneralGroup</Name>
\t\t\t\t\t\t\t\t<Type>Group</Type>
\t\t\t\t\t\t\t\t<FormControlExtension
\t\t\t\t\t\t\t\t\ti:nil="true" />
\t\t\t\t\t\t\t\t<Controls>
${tabFieldControls}\t\t\t\t\t\t\t\t</Controls>
\t\t\t\t\t\t\t</AxFormControl>
\t\t\t\t\t\t</Controls>
\t\t\t\t\t\t<ColumnsMode>Fill</ColumnsMode>
\t\t\t\t\t\t<Caption>General</Caption>
\t\t\t\t\t</AxFormControl>
\t\t\t\t</Controls>
\t\t\t\t<Style>FastTabs</Style>
\t\t\t</AxFormControl>
\t\t</Controls>
\t</Design>
\t<Parts />
</AxForm>
`;
  }

  // DetailsMaster (v1.1): complex master entity with FastTabs (customers, vendors, workers...). Reference: CustTable.
  static buildDetailsMaster(opt: FormTemplateOptions): string {
    const { formName, dsName = formName, dsTable = dsName, caption, gridFields = [] } = opt;
    const captionXml = caption
      ? `\t\t<Caption xmlns="">${caption}</Caption>\n`
      : '';

    const overviewFieldControls = gridFields.map(f =>
      FormPatternTemplates.fieldControl(f, dsName, '\t\t\t\t\t\t\t\t\t\t', 'Overview_', opt.fieldTypes)
    ).join('');

    // DetailsMaster 1.4 keeps a left NavigationList (SidePanel) whose grid must be
    // a List-style grid carrying the identifying columns.
    const navListFieldControls = gridFields.slice(0, 3).map(f =>
      FormPatternTemplates.fieldControl(f, dsName, '\t\t\t\t\t\t', 'NavList_', opt.fieldTypes)
    ).join('');

    const generalFieldControls = gridFields.map(f =>
      FormPatternTemplates.fieldControl(f, dsName, '\t\t\t\t\t\t\t\t\t\t\t\t', 'General_', opt.fieldTypes)
    ).join('');

    const gridPanelFieldControls = gridFields.slice(0, 5).map(f =>
      FormPatternTemplates.fieldControl(f, dsName, '\t\t\t\t\t\t\t\t', 'GridPanel_', opt.fieldTypes)
    ).join('');

    // DetailsMaster 1.4 wraps the detail view in a single "Panel Tab" page whose
    // header is a DetailTitleContainer group carrying a TitleField bound to the
    // record's identifying field.
    // Bind the title to the table's TitleField1 when it is known. `gridFields` is
    // alphabetically ordered, so gridFields[0] is an arbitrary field — it is only
    // a last-resort fallback (findings #32).
    const titleField = opt.titleField && opt.titleField.trim().length > 0
      ? opt.titleField.trim()
      : gridFields[0];
    const titleCtl = controlForField(titleField ?? '', opt.fieldTypes);
    const detailTitleXml = titleField
      ? `\t\t\t\t\t\t\t\t\t<AxFormControl xmlns=""\n` +
        `\t\t\t\t\t\t\t\t\t\t\ti:type="${titleCtl.iType}">\n` +
        `\t\t\t\t\t\t\t\t\t\t<Name>TitleField</Name>\n` +
        `\t\t\t\t\t\t\t\t\t\t<Skip>Yes</Skip>\n` +
        `\t\t\t\t\t\t\t\t\t\t<Type>${titleCtl.typeValue}</Type>\n` +
        `\t\t\t\t\t\t\t\t\t\t<WidthMode>SizeToAvailable</WidthMode>\n` +
        `\t\t\t\t\t\t\t\t\t\t<FormControlExtension\n\t\t\t\t\t\t\t\t\t\t\ti:nil="true" />\n` +
        `\t\t\t\t\t\t\t\t\t\t<DataField>${titleField}</DataField>\n` +
        `\t\t\t\t\t\t\t\t\t\t<DataSource>${dsName}</DataSource>\n` +
        `\t\t\t\t\t\t\t\t\t\t<ShowLabel>No</ShowLabel>\n` +
        `\t\t\t\t\t\t\t\t\t\t<Style>TitleField</Style>\n` +
        `\t\t\t\t\t\t\t\t\t</AxFormControl>\n`
      : '';

    return `<?xml version="1.0" encoding="utf-8"?>
<AxForm xmlns:i="http://www.w3.org/2001/XMLSchema-instance" xmlns="Microsoft.Dynamics.AX.Metadata.V6">
\t<Name>${formName}</Name>
\t<SourceCode>
\t\t<Methods xmlns="">
\t\t\t<Method>
\t\t\t\t<Name>classDeclaration</Name>
\t\t\t\t<Source><![CDATA[
[Form]
public class ${formName} extends FormRun
{
}

]]></Source>
\t\t\t</Method>
\t\t</Methods>
\t\t<DataSources xmlns="" />
\t\t<DataControls xmlns="" />
\t\t<Members xmlns="" />
\t</SourceCode>
\t<DataSources>
\t\t<AxFormDataSource xmlns="">
\t\t\t<Name>${dsName}</Name>
\t\t\t<Table>${dsTable}</Table>
\t\t\t<Fields />
\t\t\t<ReferencedDataSources />
\t\t\t<InsertIfEmpty>No</InsertIfEmpty>
\t\t\t<DataSourceLinks />
\t\t\t<DerivedDataSources />
\t\t</AxFormDataSource>
\t</DataSources>
\t<Design>
${captionXml}\t\t<DataSource xmlns="">${dsName}</DataSource>
\t\t<Pattern xmlns="">DetailsMaster</Pattern>
\t\t<PatternVersion xmlns="">1.4</PatternVersion>
\t\t<Style xmlns="">DetailsFormMaster</Style>
\t\t<TitleDataSource xmlns="">${dsName}</TitleDataSource>
\t\t<Controls xmlns="">
\t\t\t<AxFormControl xmlns=""
\t\t\t\t\ti:type="AxFormActionPaneControl">
\t\t\t\t<Name>ActionPane</Name>
\t\t\t\t<ElementPosition>134217727</ElementPosition>
\t\t\t\t<FilterExpression>%1</FilterExpression>
\t\t\t\t<Type>ActionPane</Type>
\t\t\t\t<VerticalSpacing>-1</VerticalSpacing>
\t\t\t\t<FormControlExtension
\t\t\t\t\ti:nil="true" />
\t\t\t\t<Controls>
\t\t\t\t\t<AxFormControl xmlns=""
\t\t\t\t\t\t\ti:type="AxFormButtonGroupControl">
\t\t\t\t\t\t<Name>ButtonGroup</Name>
\t\t\t\t\t\t<Type>ButtonGroup</Type>
\t\t\t\t\t\t<FormControlExtension
\t\t\t\t\t\t\ti:nil="true" />
\t\t\t\t\t\t<Controls />
\t\t\t\t\t\t<ArrangeMethod>Vertical</ArrangeMethod>
\t\t\t\t\t</AxFormControl>
\t\t\t\t</Controls>
\t\t\t\t<AlignChild>No</AlignChild>
\t\t\t\t<AlignChildren>No</AlignChildren>
\t\t\t\t<ArrangeMethod>Vertical</ArrangeMethod>
\t\t\t</AxFormControl>
\t\t\t<AxFormControl xmlns=""
\t\t\t\t\ti:type="AxFormGroupControl">
\t\t\t\t<Name>NavigationList</Name>
\t\t\t\t<HeightMode>SizeToAvailable</HeightMode>
\t\t\t\t<Type>Group</Type>
\t\t\t\t<Visible>No</Visible>
\t\t\t\t<FormControlExtension
\t\t\t\t\ti:nil="true" />
\t\t\t\t<Controls>
\t\t\t\t\t<AxFormControl>
\t\t\t\t\t\t<Name>QuickFilterControl</Name>
\t\t\t\t\t\t<WidthMode>SizeToAvailable</WidthMode>
\t\t\t\t\t\t<FormControlExtension>
\t\t\t\t\t\t\t<Name>QuickFilterControl</Name>
\t\t\t\t\t\t\t<ExtensionComponents />
\t\t\t\t\t\t\t<ExtensionProperties>
\t\t\t\t\t\t\t\t<AxFormControlExtensionProperty>
\t\t\t\t\t\t\t\t\t<Name>targetControlName</Name>
\t\t\t\t\t\t\t\t\t<Type>String</Type>
\t\t\t\t\t\t\t\t\t<Value>NavigationGrid</Value>
\t\t\t\t\t\t\t\t</AxFormControlExtensionProperty>
\t\t\t\t\t\t\t</ExtensionProperties>
\t\t\t\t\t\t</FormControlExtension>
\t\t\t\t\t</AxFormControl>
\t\t\t\t\t<AxFormControl xmlns=""
\t\t\t\t\t\t\ti:type="AxFormGridControl">
\t\t\t\t\t\t<Name>NavigationGrid</Name>
\t\t\t\t\t\t<AllowEdit>No</AllowEdit>
\t\t\t\t\t\t<Type>Grid</Type>
\t\t\t\t\t\t<WidthMode>SizeToContent</WidthMode>
\t\t\t\t\t\t<FormControlExtension
\t\t\t\t\t\t\ti:nil="true" />
\t\t\t\t\t\t<Controls>
${navListFieldControls}\t\t\t\t\t\t</Controls>
\t\t\t\t\t\t<DataSource>${dsName}</DataSource>
\t\t\t\t\t\t<MultiSelect>No</MultiSelect>
\t\t\t\t\t\t<ShowRowLabels>No</ShowRowLabels>
\t\t\t\t\t\t<Style>List</Style>
\t\t\t\t\t</AxFormControl>
\t\t\t\t</Controls>
\t\t\t\t<FrameType>None</FrameType>
\t\t\t\t<Style>SidePanel</Style>
\t\t\t</AxFormControl>
\t\t\t<AxFormControl xmlns=""
\t\t\t\t\ti:type="AxFormTabControl">
\t\t\t\t<Name>Tab</Name>
\t\t\t\t<AlignControl>No</AlignControl>
\t\t\t\t<AutoDeclaration>Yes</AutoDeclaration>
\t\t\t\t<Type>Tab</Type>
\t\t\t\t<FormControlExtension
\t\t\t\t\ti:nil="true" />
\t\t\t\t<Controls>
\t\t\t\t\t<AxFormControl xmlns=""
\t\t\t\t\t\t\ti:type="AxFormTabPageControl">
\t\t\t\t\t\t<Name>FormTabPageDetail</Name>
\t\t\t\t\t\t<Type>TabPage</Type>
\t\t\t\t\t\t<FormControlExtension
\t\t\t\t\t\t\ti:nil="true" />
\t\t\t\t\t\t<Controls>
\t\t\t\t\t\t\t<AxFormControl xmlns=""
\t\t\t\t\t\t\t\t\ti:type="AxFormGroupControl">
\t\t\t\t\t\t\t\t<Name>DetailHeaderGroup</Name>
\t\t\t\t\t\t\t\t<Type>Group</Type>
\t\t\t\t\t\t\t\t<WidthMode>SizeToAvailable</WidthMode>
\t\t\t\t\t\t\t\t<FormControlExtension
\t\t\t\t\t\t\t\t\ti:nil="true" />
\t\t\t\t\t\t\t\t<Controls>
${detailTitleXml}\t\t\t\t\t\t\t\t</Controls>
\t\t\t\t\t\t\t\t<ArrangeMethod>HorizontalLeft</ArrangeMethod>
\t\t\t\t\t\t\t\t<FrameType>None</FrameType>
\t\t\t\t\t\t\t\t<Style>DetailTitleContainer</Style>
\t\t\t\t\t\t\t</AxFormControl>
\t\t\t\t\t\t\t<AxFormControl xmlns=""
\t\t\t\t\t\t\t\t\ti:type="AxFormTabControl">
\t\t\t\t\t\t\t\t<Name>DetailTab</Name>
\t\t\t\t\t\t\t\t<AutoDeclaration>Yes</AutoDeclaration>
\t\t\t\t\t\t\t\t<Type>Tab</Type>
\t\t\t\t\t\t\t\t<FormControlExtension
\t\t\t\t\t\t\t\t\ti:nil="true" />
\t\t\t\t\t\t\t\t<Controls>
\t\t\t\t\t\t\t\t\t<AxFormControl xmlns=""
\t\t\t\t\t\t\t\t\t\t\ti:type="AxFormTabPageControl">
\t\t\t\t\t\t\t\t\t\t<Name>TabPageOverview</Name>
\t\t\t\t\t\t\t\t\t\t<Pattern>FieldsFieldGroups</Pattern>
\t\t\t\t\t\t\t\t\t\t<PatternVersion>1.1</PatternVersion>
\t\t\t\t\t\t\t\t\t\t<Type>TabPage</Type>
\t\t\t\t\t\t\t\t\t\t<FormControlExtension
\t\t\t\t\t\t\t\t\t\t\ti:nil="true" />
\t\t\t\t\t\t\t\t\t\t<Controls>
\t\t\t\t\t\t\t\t\t\t\t<AxFormControl xmlns=""
\t\t\t\t\t\t\t\t\t\t\t\t\ti:type="AxFormGroupControl">
\t\t\t\t\t\t\t\t\t\t\t\t<Name>OverviewGroup</Name>
\t\t\t\t\t\t\t\t\t\t\t\t<Type>Group</Type>
\t\t\t\t\t\t\t\t\t\t\t\t<FormControlExtension
\t\t\t\t\t\t\t\t\t\t\t\t\ti:nil="true" />
\t\t\t\t\t\t\t\t\t\t\t\t<Controls>
${overviewFieldControls}\t\t\t\t\t\t\t\t\t\t\t\t</Controls>
\t\t\t\t\t\t\t\t\t\t\t\t<DataGroup>Overview</DataGroup>
\t\t\t\t\t\t\t\t\t\t\t\t<DataSource>${dsName}</DataSource>
\t\t\t\t\t\t\t\t\t\t\t</AxFormControl>
\t\t\t\t\t\t\t\t\t\t</Controls>
\t\t\t\t\t\t\t\t\t\t<ColumnsMode>Fill</ColumnsMode>
\t\t\t\t\t\t\t\t\t\t<Caption>Overview</Caption>
\t\t\t\t\t\t\t\t\t</AxFormControl>
\t\t\t\t\t\t\t\t\t<AxFormControl xmlns=""
\t\t\t\t\t\t\t\t\t\t\ti:type="AxFormTabPageControl">
\t\t\t\t\t\t\t\t\t\t<Name>TabPageGeneral</Name>
\t\t\t\t\t\t\t\t\t\t<Pattern>FieldsFieldGroups</Pattern>
\t\t\t\t\t\t\t\t\t\t<PatternVersion>1.1</PatternVersion>
\t\t\t\t\t\t\t\t\t\t<Type>TabPage</Type>
\t\t\t\t\t\t\t\t\t\t<FormControlExtension
\t\t\t\t\t\t\t\t\t\t\ti:nil="true" />
\t\t\t\t\t\t\t\t\t\t<Controls>
\t\t\t\t\t\t\t\t\t\t\t<AxFormControl xmlns=""
\t\t\t\t\t\t\t\t\t\t\t\t\ti:type="AxFormGroupControl">
\t\t\t\t\t\t\t\t\t\t\t\t<Name>GeneralGroup</Name>
\t\t\t\t\t\t\t\t\t\t\t\t<Type>Group</Type>
\t\t\t\t\t\t\t\t\t\t\t\t<FormControlExtension
\t\t\t\t\t\t\t\t\t\t\t\t\ti:nil="true" />
\t\t\t\t\t\t\t\t\t\t\t\t<Controls>
${generalFieldControls}\t\t\t\t\t\t\t\t\t\t\t\t</Controls>
\t\t\t\t\t\t\t\t\t\t\t</AxFormControl>
\t\t\t\t\t\t\t\t\t\t</Controls>
\t\t\t\t\t\t\t\t\t\t<ColumnsMode>Fill</ColumnsMode>
\t\t\t\t\t\t\t\t\t\t<Caption>General</Caption>
\t\t\t\t\t\t\t\t\t</AxFormControl>
\t\t\t\t\t\t\t\t</Controls>
\t\t\t\t\t\t\t\t<Style>FastTabs</Style>
\t\t\t\t\t\t\t</AxFormControl>
\t\t\t\t\t\t</Controls>
\t\t\t\t\t\t<PanelStyle>Details</PanelStyle>
\t\t\t\t\t\t<Style>DetailsFormDetails</Style>
\t\t\t\t\t</AxFormControl>
\t\t\t\t\t<AxFormControl xmlns=""
\t\t\t\t\t\t\ti:type="AxFormTabPageControl">
\t\t\t\t\t\t<Name>FormTabPageGrid</Name>
\t\t\t\t\t\t<Type>TabPage</Type>
\t\t\t\t\t\t<FormControlExtension
\t\t\t\t\t\t\ti:nil="true" />
\t\t\t\t\t\t<Controls>
\t\t\t\t\t\t\t<AxFormControl xmlns=""
\t\t\t\t\t\t\t\t\ti:type="AxFormGroupControl">
\t\t\t\t\t\t\t\t<Name>GridFilterGroup</Name>
\t\t\t\t\t\t\t\t<Pattern>CustomAndQuickFilters</Pattern>
\t\t\t\t\t\t\t\t<PatternVersion>1.1</PatternVersion>
\t\t\t\t\t\t\t\t<Type>Group</Type>
\t\t\t\t\t\t\t\t<WidthMode>SizeToAvailable</WidthMode>
\t\t\t\t\t\t\t\t<FormControlExtension
\t\t\t\t\t\t\t\t\ti:nil="true" />
\t\t\t\t\t\t\t\t<Controls>
\t\t\t\t\t\t\t\t\t<AxFormControl>
\t\t\t\t\t\t\t\t\t\t<Name>GridQuickFilter</Name>
\t\t\t\t\t\t\t\t\t\t<WidthMode>SizeToAvailable</WidthMode>
\t\t\t\t\t\t\t\t\t\t<FormControlExtension>
\t\t\t\t\t\t\t\t\t\t\t<Name>QuickFilterControl</Name>
\t\t\t\t\t\t\t\t\t\t\t<ExtensionComponents />
\t\t\t\t\t\t\t\t\t\t\t<ExtensionProperties>
\t\t\t\t\t\t\t\t\t\t\t\t<AxFormControlExtensionProperty>
\t\t\t\t\t\t\t\t\t\t\t\t\t<Name>targetControlName</Name>
\t\t\t\t\t\t\t\t\t\t\t\t\t<Type>String</Type>
\t\t\t\t\t\t\t\t\t\t\t\t\t<Value>OverviewGrid</Value>
\t\t\t\t\t\t\t\t\t\t\t\t</AxFormControlExtensionProperty>
\t\t\t\t\t\t\t\t\t\t\t</ExtensionProperties>
\t\t\t\t\t\t\t\t\t\t</FormControlExtension>
\t\t\t\t\t\t\t\t\t</AxFormControl>
\t\t\t\t\t\t\t\t</Controls>
\t\t\t\t\t\t\t\t<ArrangeMethod>HorizontalLeft</ArrangeMethod>
\t\t\t\t\t\t\t\t<FrameType>None</FrameType>
\t\t\t\t\t\t\t\t<Style>CustomFilter</Style>
\t\t\t\t\t\t\t\t<ViewEditMode>Edit</ViewEditMode>
\t\t\t\t\t\t\t</AxFormControl>
\t\t\t\t\t\t\t<AxFormControl xmlns=""
\t\t\t\t\t\t\t\t\ti:type="AxFormGridControl">
\t\t\t\t\t\t\t\t<Name>OverviewGrid</Name>
\t\t\t\t\t\t\t\t<AllowEdit>Yes</AllowEdit>
\t\t\t\t\t\t\t\t<Type>Grid</Type>
\t\t\t\t\t\t\t\t<FormControlExtension
\t\t\t\t\t\t\t\t\ti:nil="true" />
\t\t\t\t\t\t\t\t<Controls>
${gridPanelFieldControls}\t\t\t\t\t\t\t\t</Controls>
\t\t\t\t\t\t\t\t<DataSource>${dsName}</DataSource>
\t\t\t\t\t\t\t\t<DefaultAction>OverviewGridDefaultAction</DefaultAction>
\t\t\t\t\t\t\t\t<MultiSelect>No</MultiSelect>
\t\t\t\t\t\t\t\t<ShowRowLabels>No</ShowRowLabels>
\t\t\t\t\t\t\t\t<Style>Tabular</Style>
\t\t\t\t\t\t\t</AxFormControl>
\t\t\t\t\t\t\t<AxFormControl xmlns=""
\t\t\t\t\t\t\t\t\ti:type="AxFormCommandButtonControl">
\t\t\t\t\t\t\t\t<Name>OverviewGridDefaultAction</Name>
\t\t\t\t\t\t\t\t<Type>CommandButton</Type>
\t\t\t\t\t\t\t\t<Visible>No</Visible>
\t\t\t\t\t\t\t\t<FormControlExtension
\t\t\t\t\t\t\t\t\ti:nil="true" />
\t\t\t\t\t\t\t\t<Command>DetailsView</Command>
\t\t\t\t\t\t\t</AxFormControl>
\t\t\t\t\t\t</Controls>
\t\t\t\t\t\t<PanelStyle>Grid</PanelStyle>
\t\t\t\t\t\t<Style>DetailsFormGrid</Style>
\t\t\t\t\t</AxFormControl>
\t\t\t\t</Controls>
\t\t\t\t<AlignChild>No</AlignChild>
\t\t\t\t<DataSource>${dsName}</DataSource>
\t\t\t\t<ShowTabs>No</ShowTabs>
\t\t\t</AxFormControl>
\t\t</Controls>
\t</Design>
\t<Parts />
</AxForm>
`;
  }

  // ---------------------------------------------------------------------------
  // DetailsTransaction  (v1.1)
  // Use: transaction entity with header + lines (orders, journals...)
  // Reference: SalesTable form structure
  // Structure: ActionPane; Tab → HeaderPage (FastTabs) + LinesPage (Grid)
  // ---------------------------------------------------------------------------
  static buildDetailsTransaction(opt: FormTemplateOptions): string {
    const {
      formName,
      dsName = formName,
      dsTable = dsName,
      caption,
      linesDsName = `${dsName.replace(/Table$/i, '')}Line`,
      linesDsTable = linesDsName,
      gridFields = [],
      linesFields = [],
    } = opt;
    const captionXml = caption
      ? `\t\t<Caption xmlns="">${caption}</Caption>\n`
      : '';

    // Read-only navigation list: up to 3 identifying header fields.
    const navListColumns = gridFields.slice(0, 3).map(f =>
      FormPatternTemplates.fieldControl(f, dsName, '\t\t\t\t\t\t\t', 'Nav_', opt.fieldTypes)
    ).join('');

    const headerFieldControls = gridFields.map(f =>
      FormPatternTemplates.fieldControl(f, dsName, '\t\t\t\t\t\t\t\t\t', 'Header_', opt.fieldTypes)
    ).join('');

    const linesColumns = linesFields.map(f =>
      FormPatternTemplates.fieldControl(f, linesDsName, '\t\t\t\t\t\t\t\t\t', 'Line_', opt.linesFieldTypes)
    ).join('');

    // LineViewTab's third page: a line-details fast-tab showing the selected
    // line's fields (distinct control names from the lines grid columns).
    const lineDetailControls = linesFields.map(f =>
      FormPatternTemplates.fieldControl(f, linesDsName, '\t\t\t\t\t\t\t\t\t\t', 'LineDtl_', opt.linesFieldTypes)
    ).join('');

    // The Grid panel (alternate "list" view) of the MainTab needs its own grid
    // columns — distinct names from the nav list / header to avoid collisions.
    const gridPanelColumns = gridFields.slice(0, 5).map(f =>
      FormPatternTemplates.fieldControl(f, dsName, '\t\t\t\t\t\t\t\t', 'GridPanel_', opt.fieldTypes)
    ).join('');

    // The DetailsTab pairs a header-only panel (HeaderView) with the combined
    // header+lines panel (LineView); its fields need distinct control names.
    const headerViewFieldControls = gridFields.map(f =>
      FormPatternTemplates.fieldControl(f, dsName, '\t\t\t\t\t\t\t\t\t\t', 'HView_', opt.fieldTypes)
    ).join('');

    const dsFieldList = (fields: string[]): string =>
      fields.length > 0
        ? `\t\t\t<Fields>\n` +
          fields.map(f =>
            `\t\t\t\t<AxFormDataSourceField>\n\t\t\t\t\t<DataField>${f}</DataField>\n\t\t\t\t</AxFormDataSourceField>\n`,
          ).join('') +
          `\t\t\t</Fields>\n`
        : `\t\t\t<Fields />\n`;
    const headerDsFields = dsFieldList(gridFields);
    const linesDsFields = dsFieldList(linesFields);

    // DetailsTransaction v1.4 carries the title in a DetailTitleContainer header
    // (HeaderInfo) bound to the record's identifying field.
    const titleField = gridFields[0];

    return `<?xml version="1.0" encoding="utf-8"?>
<AxForm xmlns:i="http://www.w3.org/2001/XMLSchema-instance" xmlns="Microsoft.Dynamics.AX.Metadata.V6">
\t<Name>${formName}</Name>
\t<SourceCode>
\t\t<Methods xmlns="">
\t\t\t<Method>
\t\t\t\t<Name>classDeclaration</Name>
\t\t\t\t<Source><![CDATA[
[Form]
public class ${formName} extends FormRun
{
}

]]></Source>
\t\t\t</Method>
\t\t</Methods>
\t\t<DataSources xmlns="" />
\t\t<DataControls xmlns="" />
\t\t<Members xmlns="" />
\t</SourceCode>
\t<DataSources>
\t\t<AxFormDataSource xmlns="">
\t\t\t<Name>${dsName}</Name>
\t\t\t<Table>${dsTable}</Table>
${headerDsFields}\t\t\t<ReferencedDataSources />
\t\t\t<InsertIfEmpty>No</InsertIfEmpty>
\t\t\t<DataSourceLinks />
\t\t\t<DerivedDataSources />
\t\t</AxFormDataSource>
\t\t<AxFormDataSource xmlns="">
\t\t\t<Name>${linesDsName}</Name>
\t\t\t<Table>${linesDsTable}</Table>
${linesDsFields}\t\t\t<ReferencedDataSources />
\t\t\t<JoinSource>${dsName}</JoinSource>
\t\t\t<LinkType>Delayed</LinkType>
\t\t\t<InsertIfEmpty>No</InsertIfEmpty>
\t\t\t<DataSourceLinks />
\t\t\t<DerivedDataSources />
\t\t</AxFormDataSource>
\t</DataSources>
\t<Design>
${captionXml}\t\t<DataSource xmlns="">${dsName}</DataSource>
\t\t<Pattern xmlns="">DetailsTransaction</Pattern>
\t\t<PatternVersion xmlns="">1.4</PatternVersion>
\t\t<Style xmlns="">DetailsFormTransaction</Style>
\t\t<TitleDataSource xmlns="">${dsName}</TitleDataSource>
\t\t<Controls xmlns="">
\t\t\t<AxFormControl xmlns=""
\t\t\t\t\ti:type="AxFormActionPaneControl">
\t\t\t\t<Name>ActionPane</Name>
\t\t\t\t<ElementPosition>134217727</ElementPosition>
\t\t\t\t<FilterExpression>%1</FilterExpression>
\t\t\t\t<Type>ActionPane</Type>
\t\t\t\t<VerticalSpacing>-1</VerticalSpacing>
\t\t\t\t<FormControlExtension
\t\t\t\t\ti:nil="true" />
\t\t\t\t<Controls>
\t\t\t\t\t<AxFormControl xmlns=""
\t\t\t\t\t\t\ti:type="AxFormButtonGroupControl">
\t\t\t\t\t\t<Name>ButtonGroup</Name>
\t\t\t\t\t\t<Type>ButtonGroup</Type>
\t\t\t\t\t\t<FormControlExtension
\t\t\t\t\t\t\ti:nil="true" />
\t\t\t\t\t\t<Controls />
\t\t\t\t\t\t<ArrangeMethod>Vertical</ArrangeMethod>
\t\t\t\t\t</AxFormControl>
\t\t\t\t</Controls>
\t\t\t\t<AlignChild>No</AlignChild>
\t\t\t\t<AlignChildren>No</AlignChildren>
\t\t\t\t<ArrangeMethod>Vertical</ArrangeMethod>
\t\t\t</AxFormControl>
\t\t\t<AxFormControl xmlns=""
\t\t\t\t\ti:type="AxFormGroupControl">
\t\t\t\t<Name>NavigationList</Name>
\t\t\t\t<HeightMode>SizeToAvailable</HeightMode>
\t\t\t\t<Type>Group</Type>
\t\t\t\t<Visible>No</Visible>
\t\t\t\t<FormControlExtension
\t\t\t\t\ti:nil="true" />
\t\t\t\t<Controls>
\t\t\t\t\t<AxFormControl>
\t\t\t\t\t\t<Name>NavigationListFilter</Name>
\t\t\t\t\t\t<WidthMode>SizeToAvailable</WidthMode>
\t\t\t\t\t\t<FormControlExtension>
\t\t\t\t\t\t\t<Name>QuickFilterControl</Name>
\t\t\t\t\t\t\t<ExtensionComponents />
\t\t\t\t\t\t\t<ExtensionProperties>
\t\t\t\t\t\t\t\t<AxFormControlExtensionProperty>
\t\t\t\t\t\t\t\t\t<Name>targetControlName</Name>
\t\t\t\t\t\t\t\t\t<Type>String</Type>
\t\t\t\t\t\t\t\t\t<Value>NavigationListGrid</Value>
\t\t\t\t\t\t\t\t</AxFormControlExtensionProperty>
\t\t\t\t\t\t\t</ExtensionProperties>
\t\t\t\t\t\t</FormControlExtension>
\t\t\t\t\t</AxFormControl>
\t\t\t\t\t<AxFormControl xmlns=""
\t\t\t\t\t\t\ti:type="AxFormGridControl">
\t\t\t\t\t\t<Name>NavigationListGrid</Name>
\t\t\t\t\t\t<AllowEdit>No</AllowEdit>
\t\t\t\t\t\t<Type>Grid</Type>
\t\t\t\t\t\t<WidthMode>SizeToContent</WidthMode>
\t\t\t\t\t\t<FormControlExtension
\t\t\t\t\t\t\ti:nil="true" />
\t\t\t\t\t\t<Controls>
${navListColumns}\t\t\t\t\t\t</Controls>
\t\t\t\t\t\t<DataSource>${dsName}</DataSource>
\t\t\t\t\t\t<MultiSelect>No</MultiSelect>
\t\t\t\t\t\t<ShowRowLabels>No</ShowRowLabels>
\t\t\t\t\t\t<Style>List</Style>
\t\t\t\t\t</AxFormControl>
\t\t\t\t</Controls>
\t\t\t\t<FrameType>None</FrameType>
\t\t\t\t<Style>SidePanel</Style>
\t\t\t</AxFormControl>
\t\t\t<AxFormControl xmlns=""
\t\t\t\t\ti:type="AxFormTabControl">
\t\t\t\t<Name>MainTab</Name>
\t\t\t\t<AlignControl>No</AlignControl>
\t\t\t\t<Type>Tab</Type>
\t\t\t\t<FormControlExtension
\t\t\t\t\ti:nil="true" />
\t\t\t\t<Controls>
\t\t\t\t\t<AxFormControl xmlns=""
\t\t\t\t\t\t\ti:type="AxFormTabPageControl">
\t\t\t\t\t\t<Name>TabPageDetails</Name>
\t\t\t\t\t\t<AutoDeclaration>Yes</AutoDeclaration>
\t\t\t\t\t\t<HeightMode>SizeToAvailable</HeightMode>
\t\t\t\t\t\t<Type>TabPage</Type>
\t\t\t\t\t\t<WidthMode>SizeToAvailable</WidthMode>
\t\t\t\t\t\t<FormControlExtension
\t\t\t\t\t\t\ti:nil="true" />
\t\t\t\t\t\t<Controls>
\t\t\t\t\t\t\t<AxFormControl xmlns=""
\t\t\t\t\t\t\t\t\ti:type="AxFormGroupControl">
\t\t\t\t\t\t\t\t<Name>HeaderInfo</Name>
\t\t\t\t\t\t\t\t<Type>Group</Type>
\t\t\t\t\t\t\t\t<WidthMode>SizeToAvailable</WidthMode>
\t\t\t\t\t\t\t\t<FormControlExtension
\t\t\t\t\t\t\t\t\ti:nil="true" />
\t\t\t\t\t\t\t\t<Controls>
${titleField ? `\t\t\t\t\t\t\t\t\t<AxFormControl xmlns=""
\t\t\t\t\t\t\t\t\t\t\ti:type="AxFormStringControl">
\t\t\t\t\t\t\t\t\t\t<Name>HeaderTitle</Name>
\t\t\t\t\t\t\t\t\t\t<Skip>Yes</Skip>
\t\t\t\t\t\t\t\t\t\t<Type>String</Type>
\t\t\t\t\t\t\t\t\t\t<WidthMode>SizeToAvailable</WidthMode>
\t\t\t\t\t\t\t\t\t\t<FormControlExtension
\t\t\t\t\t\t\t\t\t\t\ti:nil="true" />
\t\t\t\t\t\t\t\t\t\t<DataField>${titleField}</DataField>
\t\t\t\t\t\t\t\t\t\t<DataSource>${dsName}</DataSource>
\t\t\t\t\t\t\t\t\t\t<ShowLabel>No</ShowLabel>
\t\t\t\t\t\t\t\t\t\t<Style>TitleField</Style>
\t\t\t\t\t\t\t\t\t</AxFormControl>\n` : ''}\t\t\t\t\t\t\t\t</Controls>
\t\t\t\t\t\t\t\t<ArrangeMethod>HorizontalLeft</ArrangeMethod>
\t\t\t\t\t\t\t\t<FrameType>None</FrameType>
\t\t\t\t\t\t\t\t<Style>DetailTitleContainer</Style>
\t\t\t\t\t\t\t</AxFormControl>
\t\t\t\t\t\t\t<AxFormControl xmlns=""
\t\t\t\t\t\t\t\t\ti:type="AxFormTabControl">
\t\t\t\t\t\t\t\t<Name>DetailsTab</Name>
\t\t\t\t\t\t\t\t<Type>Tab</Type>
\t\t\t\t\t\t\t\t<FormControlExtension
\t\t\t\t\t\t\t\t\ti:nil="true" />
\t\t\t\t\t\t\t\t<Controls>
\t\t\t\t\t\t\t\t\t<AxFormControl xmlns=""
\t\t\t\t\t\t\t\t\t\t\ti:type="AxFormTabPageControl">
\t\t\t\t\t\t\t\t\t\t<Name>LineView</Name>
\t\t\t\t\t\t\t\t\t\t<AutoDeclaration>Yes</AutoDeclaration>
\t\t\t\t\t\t\t\t\t\t<HeightMode>SizeToAvailable</HeightMode>
\t\t\t\t\t\t\t\t\t\t<Type>TabPage</Type>
\t\t\t\t\t\t\t\t\t\t<WidthMode>SizeToAvailable</WidthMode>
\t\t\t\t\t\t\t\t\t\t<FormControlExtension
\t\t\t\t\t\t\t\t\t\t\ti:nil="true" />
\t\t\t\t\t\t\t\t\t\t<Controls>
\t\t\t\t\t\t\t\t\t\t\t<AxFormControl xmlns=""
\t\t\t\t\t\t\t\t\t\t\t\t\ti:type="AxFormTabControl">
\t\t\t\t\t\t\t\t\t\t\t\t<Name>LineViewTab</Name>
\t\t\t\t\t\t\t\t\t\t\t\t<AutoDeclaration>Yes</AutoDeclaration>
\t\t\t\t\t\t\t\t\t\t\t\t<Type>Tab</Type>
\t\t\t\t\t\t\t\t\t\t\t\t<FormControlExtension
\t\t\t\t\t\t\t\t\t\t\t\t\ti:nil="true" />
\t\t\t\t\t\t\t\t\t\t\t\t<Controls>
\t\t\t\t\t\t\t\t\t\t\t\t\t<AxFormControl xmlns=""
\t\t\t\t\t\t\t\t\t\t\t\t\t\t\ti:type="AxFormTabPageControl">
\t\t\t\t\t\t\t\t\t\t\t\t\t\t<Name>LineViewHeader</Name>
\t\t\t\t\t\t\t\t\t\t\t\t\t\t<Pattern>FieldsFieldGroups</Pattern>
\t\t\t\t\t\t\t\t\t\t\t\t\t\t<PatternVersion>1.1</PatternVersion>
\t\t\t\t\t\t\t\t\t\t\t\t\t\t<Type>TabPage</Type>
\t\t\t\t\t\t\t\t\t\t\t\t\t\t<FormControlExtension
\t\t\t\t\t\t\t\t\t\t\t\t\t\t\ti:nil="true" />
\t\t\t\t\t\t\t\t\t\t\t\t\t\t<Controls>
\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t<AxFormControl xmlns=""
\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\ti:type="AxFormGroupControl">
\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t<Name>HeaderGeneralGroup</Name>
\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t<Type>Group</Type>
\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t<FormControlExtension
\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\ti:nil="true" />
\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t<Controls>
${headerFieldControls}\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t</Controls>
\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t</AxFormControl>
\t\t\t\t\t\t\t\t\t\t\t\t\t\t</Controls>
\t\t\t\t\t\t\t\t\t\t\t\t\t\t<ColumnsMode>Fill</ColumnsMode>
\t\t\t\t\t\t\t\t\t\t\t\t\t\t<Caption>Header</Caption>
\t\t\t\t\t\t\t\t\t\t\t\t\t\t<FastTabExpanded>No</FastTabExpanded>
\t\t\t\t\t\t\t\t\t\t\t\t\t</AxFormControl>
\t\t\t\t\t\t\t\t\t\t\t\t\t<AxFormControl xmlns=""
\t\t\t\t\t\t\t\t\t\t\t\t\t\t\ti:type="AxFormTabPageControl">
\t\t\t\t\t\t\t\t\t\t\t\t\t\t<Name>LineViewLines</Name>
\t\t\t\t\t\t\t\t\t\t\t\t\t\t<HeightMode>SizeToAvailable</HeightMode>
\t\t\t\t\t\t\t\t\t\t\t\t\t\t<Type>TabPage</Type>
\t\t\t\t\t\t\t\t\t\t\t\t\t\t<FormControlExtension
\t\t\t\t\t\t\t\t\t\t\t\t\t\t\ti:nil="true" />
\t\t\t\t\t\t\t\t\t\t\t\t\t\t<Controls>
\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t<AxFormControl xmlns=""
\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\ti:type="AxFormActionPaneControl">
\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t<Name>LinesActionPaneStrip</Name>
\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t<Type>ActionPane</Type>
\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t<FormControlExtension
\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\ti:nil="true" />
\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t<Controls>
\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t<AxFormControl xmlns=""
\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\ti:type="AxFormActionPaneTabControl">
\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t<Name>LinesActionTab</Name>
\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t<Type>ActionPaneTab</Type>
\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t<FormControlExtension
\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\ti:nil="true" />
\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t<Controls>
\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t<AxFormControl xmlns=""
\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\ti:type="AxFormButtonGroupControl">
\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t<Name>LinesStripButtonGroup</Name>
\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t<Type>ButtonGroup</Type>
\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t<FormControlExtension
\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\ti:nil="true" />
\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t<Controls />
\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t</AxFormControl>
\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t</Controls>
\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t</AxFormControl>
\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t</Controls>
\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t<AlignChild>No</AlignChild>
\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t<AlignChildren>No</AlignChildren>
\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t<ArrangeMethod>Vertical</ArrangeMethod>
\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t<DataSource>${linesDsName}</DataSource>
\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t<Style>Strip</Style>
\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t</AxFormControl>
\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t<AxFormControl xmlns=""
\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\ti:type="AxFormGridControl">
\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t<Name>LinesGrid</Name>
\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t<Type>Grid</Type>
\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t<FormControlExtension
\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\ti:nil="true" />
\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t<Controls>
${linesColumns}\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t</Controls>
\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t<DataSource>${linesDsName}</DataSource>
\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t<Style>Tabular</Style>
\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t<VisibleRows>5</VisibleRows>
\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t<VisibleRowsMode>Fixed</VisibleRowsMode>
\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t</AxFormControl>
\t\t\t\t\t\t\t\t\t\t\t\t\t\t</Controls>
\t\t\t\t\t\t\t\t\t\t\t\t\t\t<Caption>Lines</Caption>
\t\t\t\t\t\t\t\t\t\t\t\t\t\t<FastTabExpanded>Always</FastTabExpanded>
\t\t\t\t\t\t\t\t\t\t\t\t\t</AxFormControl>
\t\t\t\t\t\t\t\t\t\t\t\t\t<AxFormControl xmlns=""
\t\t\t\t\t\t\t\t\t\t\t\t\t\t\ti:type="AxFormTabPageControl">
\t\t\t\t\t\t\t\t\t\t\t\t\t\t<Name>LineViewLineDetails</Name>
\t\t\t\t\t\t\t\t\t\t\t\t\t\t<HeightMode>SizeToAvailable</HeightMode>
\t\t\t\t\t\t\t\t\t\t\t\t\t\t<Type>TabPage</Type>
\t\t\t\t\t\t\t\t\t\t\t\t\t\t<WidthMode>SizeToAvailable</WidthMode>
\t\t\t\t\t\t\t\t\t\t\t\t\t\t<FormControlExtension
\t\t\t\t\t\t\t\t\t\t\t\t\t\t\ti:nil="true" />
\t\t\t\t\t\t\t\t\t\t\t\t\t\t<Controls>
\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t<AxFormControl xmlns=""
\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\ti:type="AxFormTabControl">
\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t<Name>LineDetailsTab</Name>
\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t<AutoDeclaration>Yes</AutoDeclaration>
\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t<Type>Tab</Type>
\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t<FormControlExtension
\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\ti:nil="true" />
\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t<Controls>
\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t<AxFormControl xmlns=""
\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\ti:type="AxFormTabPageControl">
\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t<Name>TabLineGeneral</Name>
\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t<Pattern>FieldsFieldGroups</Pattern>
\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t<PatternVersion>1.1</PatternVersion>
\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t<Type>TabPage</Type>
\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t<FormControlExtension
\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\ti:nil="true" />
\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t<Controls>
\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t<AxFormControl xmlns=""
\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\ti:type="AxFormGroupControl">
\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t<Name>LineDetailsGroup</Name>
\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t<Type>Group</Type>
\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t<FormControlExtension
\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\ti:nil="true" />
\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t<Controls>
${lineDetailControls}\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t</Controls>
\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t</AxFormControl>
\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t</Controls>
\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t<ColumnsMode>Fill</ColumnsMode>
\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t<Caption>General</Caption>
\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t</AxFormControl>
\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t</Controls>
\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t<AlignChild>No</AlignChild>
\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t<Style>Tabs</Style>
\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t</AxFormControl>
\t\t\t\t\t\t\t\t\t\t\t\t\t\t</Controls>
\t\t\t\t\t\t\t\t\t\t\t\t\t\t<Caption>Line details</Caption>
\t\t\t\t\t\t\t\t\t\t\t\t\t\t<DataSource>${linesDsName}</DataSource>
\t\t\t\t\t\t\t\t\t\t\t\t\t\t<FastTabExpanded>No</FastTabExpanded>
\t\t\t\t\t\t\t\t\t\t\t\t\t</AxFormControl>
\t\t\t\t\t\t\t\t\t\t\t\t</Controls>
\t\t\t\t\t\t\t\t\t\t\t\t<AlignChild>No</AlignChild>
\t\t\t\t\t\t\t\t\t\t\t\t<Style>FastTabs</Style>
\t\t\t\t\t\t\t\t\t\t\t</AxFormControl>
\t\t\t\t\t\t\t\t\t\t</Controls>
\t\t\t\t\t\t\t\t\t\t<PanelStyle>DetailsLine</PanelStyle>
\t\t\t\t\t\t\t\t\t\t<Style>DetailsFormDetails</Style>
\t\t\t\t\t\t\t\t\t</AxFormControl>
\t\t\t\t\t\t\t\t\t<AxFormControl xmlns=""
\t\t\t\t\t\t\t\t\t\t\ti:type="AxFormTabPageControl">
\t\t\t\t\t\t\t\t\t\t<Name>HeaderView</Name>
\t\t\t\t\t\t\t\t\t\t<HeightMode>SizeToAvailable</HeightMode>
\t\t\t\t\t\t\t\t\t\t<Type>TabPage</Type>
\t\t\t\t\t\t\t\t\t\t<WidthMode>SizeToAvailable</WidthMode>
\t\t\t\t\t\t\t\t\t\t<FormControlExtension
\t\t\t\t\t\t\t\t\t\t\ti:nil="true" />
\t\t\t\t\t\t\t\t\t\t<Controls>
\t\t\t\t\t\t\t\t\t\t\t<AxFormControl xmlns=""
\t\t\t\t\t\t\t\t\t\t\t\t\ti:type="AxFormTabControl">
\t\t\t\t\t\t\t\t\t\t\t\t<Name>HeaderDetailsTab</Name>
\t\t\t\t\t\t\t\t\t\t\t\t<AutoDeclaration>Yes</AutoDeclaration>
\t\t\t\t\t\t\t\t\t\t\t\t<Type>Tab</Type>
\t\t\t\t\t\t\t\t\t\t\t\t<FormControlExtension
\t\t\t\t\t\t\t\t\t\t\t\t\ti:nil="true" />
\t\t\t\t\t\t\t\t\t\t\t\t<Controls>
\t\t\t\t\t\t\t\t\t\t\t\t\t<AxFormControl xmlns=""
\t\t\t\t\t\t\t\t\t\t\t\t\t\t\ti:type="AxFormTabPageControl">
\t\t\t\t\t\t\t\t\t\t\t\t\t\t<Name>TabHeaderGeneral</Name>
\t\t\t\t\t\t\t\t\t\t\t\t\t\t<Pattern>FieldsFieldGroups</Pattern>
\t\t\t\t\t\t\t\t\t\t\t\t\t\t<PatternVersion>1.1</PatternVersion>
\t\t\t\t\t\t\t\t\t\t\t\t\t\t<Type>TabPage</Type>
\t\t\t\t\t\t\t\t\t\t\t\t\t\t<FormControlExtension
\t\t\t\t\t\t\t\t\t\t\t\t\t\t\ti:nil="true" />
\t\t\t\t\t\t\t\t\t\t\t\t\t\t<Controls>
\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t<AxFormControl xmlns=""
\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\ti:type="AxFormGroupControl">
\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t<Name>HeaderViewGroup</Name>
\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t<Type>Group</Type>
\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t<FormControlExtension
\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\ti:nil="true" />
\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t<Controls>
${headerViewFieldControls}\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t</Controls>
\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t</AxFormControl>
\t\t\t\t\t\t\t\t\t\t\t\t\t\t</Controls>
\t\t\t\t\t\t\t\t\t\t\t\t\t\t<ColumnsMode>Fill</ColumnsMode>
\t\t\t\t\t\t\t\t\t\t\t\t\t\t<Caption>General</Caption>
\t\t\t\t\t\t\t\t\t\t\t\t\t</AxFormControl>
\t\t\t\t\t\t\t\t\t\t\t\t</Controls>
\t\t\t\t\t\t\t\t\t\t\t\t<AlignChild>No</AlignChild>
\t\t\t\t\t\t\t\t\t\t\t\t<Style>FastTabs</Style>
\t\t\t\t\t\t\t\t\t\t\t</AxFormControl>
\t\t\t\t\t\t\t\t\t\t</Controls>
\t\t\t\t\t\t\t\t\t\t<PanelStyle>DetailsHeader</PanelStyle>
\t\t\t\t\t\t\t\t\t\t<Style>DetailsFormDetails</Style>
\t\t\t\t\t\t\t\t\t</AxFormControl>
\t\t\t\t\t\t\t\t</Controls>
\t\t\t\t\t\t\t\t<AlignChild>No</AlignChild>
\t\t\t\t\t\t\t\t<ShowTabs>No</ShowTabs>
\t\t\t\t\t\t\t</AxFormControl>
\t\t\t\t\t\t</Controls>
\t\t\t\t\t\t<PanelStyle>Details</PanelStyle>
\t\t\t\t\t\t<Style>DetailsFormDetails</Style>
\t\t\t\t\t</AxFormControl>
\t\t\t\t\t<AxFormControl xmlns=""
\t\t\t\t\t\t\ti:type="AxFormTabPageControl">
\t\t\t\t\t\t<Name>TabPageGrid</Name>
\t\t\t\t\t\t<Type>TabPage</Type>
\t\t\t\t\t\t<FormControlExtension
\t\t\t\t\t\t\ti:nil="true" />
\t\t\t\t\t\t<Controls>
\t\t\t\t\t\t\t<AxFormControl xmlns=""
\t\t\t\t\t\t\t\t\ti:type="AxFormGroupControl">
\t\t\t\t\t\t\t\t<Name>GridFilterGroup</Name>
\t\t\t\t\t\t\t\t<Pattern>CustomAndQuickFilters</Pattern>
\t\t\t\t\t\t\t\t<PatternVersion>1.1</PatternVersion>
\t\t\t\t\t\t\t\t<Type>Group</Type>
\t\t\t\t\t\t\t\t<WidthMode>SizeToAvailable</WidthMode>
\t\t\t\t\t\t\t\t<FormControlExtension
\t\t\t\t\t\t\t\t\ti:nil="true" />
\t\t\t\t\t\t\t\t<Controls>
\t\t\t\t\t\t\t\t\t<AxFormControl>
\t\t\t\t\t\t\t\t\t\t<Name>GridQuickFilter</Name>
\t\t\t\t\t\t\t\t\t\t<WidthMode>SizeToAvailable</WidthMode>
\t\t\t\t\t\t\t\t\t\t<FormControlExtension>
\t\t\t\t\t\t\t\t\t\t\t<Name>QuickFilterControl</Name>
\t\t\t\t\t\t\t\t\t\t\t<ExtensionComponents />
\t\t\t\t\t\t\t\t\t\t\t<ExtensionProperties>
\t\t\t\t\t\t\t\t\t\t\t\t<AxFormControlExtensionProperty>
\t\t\t\t\t\t\t\t\t\t\t\t\t<Name>targetControlName</Name>
\t\t\t\t\t\t\t\t\t\t\t\t\t<Type>String</Type>
\t\t\t\t\t\t\t\t\t\t\t\t\t<Value>OverviewGrid</Value>
\t\t\t\t\t\t\t\t\t\t\t\t</AxFormControlExtensionProperty>
\t\t\t\t\t\t\t\t\t\t\t</ExtensionProperties>
\t\t\t\t\t\t\t\t\t\t</FormControlExtension>
\t\t\t\t\t\t\t\t\t</AxFormControl>
\t\t\t\t\t\t\t\t</Controls>
\t\t\t\t\t\t\t\t<ArrangeMethod>HorizontalLeft</ArrangeMethod>
\t\t\t\t\t\t\t\t<FrameType>None</FrameType>
\t\t\t\t\t\t\t\t<Style>CustomFilter</Style>
\t\t\t\t\t\t\t\t<ViewEditMode>Edit</ViewEditMode>
\t\t\t\t\t\t\t</AxFormControl>
\t\t\t\t\t\t\t<AxFormControl xmlns=""
\t\t\t\t\t\t\t\t\ti:type="AxFormGridControl">
\t\t\t\t\t\t\t\t<Name>OverviewGrid</Name>
\t\t\t\t\t\t\t\t<AllowEdit>Yes</AllowEdit>
\t\t\t\t\t\t\t\t<Type>Grid</Type>
\t\t\t\t\t\t\t\t<FormControlExtension
\t\t\t\t\t\t\t\t\ti:nil="true" />
\t\t\t\t\t\t\t\t<Controls>
${gridPanelColumns}\t\t\t\t\t\t\t\t</Controls>
\t\t\t\t\t\t\t\t<DataSource>${dsName}</DataSource>
\t\t\t\t\t\t\t\t<DefaultAction>OverviewGridDefaultAction</DefaultAction>
\t\t\t\t\t\t\t\t<MultiSelect>No</MultiSelect>
\t\t\t\t\t\t\t\t<ShowRowLabels>No</ShowRowLabels>
\t\t\t\t\t\t\t\t<Style>Tabular</Style>
\t\t\t\t\t\t\t</AxFormControl>
\t\t\t\t\t\t\t<AxFormControl xmlns=""
\t\t\t\t\t\t\t\t\ti:type="AxFormCommandButtonControl">
\t\t\t\t\t\t\t\t<Name>OverviewGridDefaultAction</Name>
\t\t\t\t\t\t\t\t<Type>CommandButton</Type>
\t\t\t\t\t\t\t\t<Visible>No</Visible>
\t\t\t\t\t\t\t\t<FormControlExtension
\t\t\t\t\t\t\t\t\ti:nil="true" />
\t\t\t\t\t\t\t\t<Command>DetailsView</Command>
\t\t\t\t\t\t\t</AxFormControl>
\t\t\t\t\t\t</Controls>
\t\t\t\t\t\t<PanelStyle>Grid</PanelStyle>
\t\t\t\t\t\t<Style>DetailsFormGrid</Style>
\t\t\t\t\t</AxFormControl>
\t\t\t\t</Controls>
\t\t\t\t<AlignChild>No</AlignChild>
\t\t\t\t<ArrangeMethod>Vertical</ArrangeMethod>
\t\t\t\t<ShowTabs>No</ShowTabs>
\t\t\t</AxFormControl>
\t\t</Controls>
\t</Design>
\t<Parts />
</AxForm>
`;
  }

  // ---------------------------------------------------------------------------
  // Dialog  (v1.2)
  // Use: gather/show a set of information (modal form for an action)
  // Reference: ProjTableCreate form
  // Structure: Body (FieldsFieldGroups, Style=DialogContent) → fields
  //            ButtonGroup (Style=DialogCommitContainer)
  // ---------------------------------------------------------------------------
  static buildDialog(opt: FormTemplateOptions): string {
    const { formName, dsName, dsTable, caption, gridFields = [], sections = [] } = opt;
    const captionXml = caption
      ? `\t\t<Caption xmlns="">${caption}</Caption>\n`
      : '';

    // Body fields: from gridFields or empty
    const bodyFieldControls = gridFields.map(f =>
      `\t\t\t\t\t<AxFormControl xmlns=""\n` +
      `\t\t\t\t\t\t\ti:type="AxFormStringControl">\n` +
      `\t\t\t\t\t\t<Name>${f}</Name>\n` +
      `\t\t\t\t\t\t<Type>String</Type>\n` +
      `\t\t\t\t\t\t<FormControlExtension\n\t\t\t\t\t\t\ti:nil="true" />\n` +
      (dsName ? `\t\t\t\t\t\t<DataField>${f}</DataField>\n\t\t\t\t\t\t<DataSource>${dsName}</DataSource>\n` : '') +
      `\t\t\t\t\t</AxFormControl>\n`
    ).join('');

    const dsXml = dsName && dsTable
      ? `\t<DataSources>\n` +
        `\t\t<AxFormDataSource xmlns="">\n` +
        `\t\t\t<Name>${dsName}</Name>\n` +
        `\t\t\t<Table>${dsTable}</Table>\n` +
        `\t\t\t<Fields />\n` +
        `\t\t\t<ReferencedDataSources />\n` +
        `\t\t\t<DataSourceLinks />\n` +
        `\t\t\t<DerivedDataSources />\n` +
        `\t\t</AxFormDataSource>\n` +
        `\t</DataSources>\n`
      : `\t<DataSources />\n`;

    // Optional sections (extra tab pages)
    const sectionControls = sections.map(s =>
      `\t\t\t\t<AxFormControl xmlns=""\n` +
      `\t\t\t\t\t\ti:type="AxFormTabPageControl">\n` +
      `\t\t\t\t\t<Name>${s.name}</Name>\n` +
      `\t\t\t\t\t<Pattern>FieldsFieldGroups</Pattern>\n` +
      `\t\t\t\t\t<PatternVersion>1.1</PatternVersion>\n` +
      `\t\t\t\t\t<Type>TabPage</Type>\n` +
      `\t\t\t\t\t<Caption>${s.caption}</Caption>\n` +
      `\t\t\t\t\t<FormControlExtension\n\t\t\t\t\t\ti:nil="true" />\n` +
      `\t\t\t\t\t<Controls />\n` +
      `\t\t\t\t</AxFormControl>\n`
    ).join('');

    const bodyContent = sections.length > 0
      ? `\t\t\t<AxFormControl xmlns=""\n` +
        `\t\t\t\t\ti:type="AxFormTabControl">\n` +
        `\t\t\t\t<Name>Tab</Name>\n` +
        `\t\t\t\t<Type>Tab</Type>\n` +
        `\t\t\t\t<FormControlExtension\n\t\t\t\t\ti:nil="true" />\n` +
        `\t\t\t\t<Controls>\n` +
        sectionControls +
        `\t\t\t\t</Controls>\n` +
        `\t\t\t</AxFormControl>\n`
      : bodyFieldControls;

    // FieldsFieldGroups only allows fields + one level of groups — when the
    // body holds a Tab (sectioned dialog), the sub-pattern lives on the tab
    // pages instead and DialogBody itself stays unpatterned.
    const dialogBodyPattern = sections.length > 0
      ? ''
      : `\t\t\t\t<Pattern>FieldsFieldGroups</Pattern>\n\t\t\t\t<PatternVersion>1.1</PatternVersion>\n`;

    // The 'Dialog - Basic' pattern requires the body to fill the dialog. D365
    // serializes a control's properties in two alphabetical groups split by
    // <Controls>: HeightMode/WidthMode belong to the BEFORE group (HeightMode
    // before Pattern, WidthMode after Type), ColumnsMode to the AFTER group.
    const dialogBodyLayout = sections.length > 0
      ? ''
      : `\t\t\t\t<ColumnsMode>Fill</ColumnsMode>\n`;

    return `<?xml version="1.0" encoding="utf-8"?>
<AxForm xmlns:i="http://www.w3.org/2001/XMLSchema-instance" xmlns="Microsoft.Dynamics.AX.Metadata.V6">
\t<Name>${formName}</Name>
\t<SourceCode>
\t\t<Methods xmlns="">
\t\t\t<Method>
\t\t\t\t<Name>classDeclaration</Name>
\t\t\t\t<Source><![CDATA[
[Form]
public class ${formName} extends FormRun
{
}

]]></Source>
\t\t\t</Method>
\t\t</Methods>
\t\t<DataSources xmlns="" />
\t\t<DataControls xmlns="" />
\t\t<Members xmlns="" />
\t</SourceCode>
${dsXml}\t<Design>
${captionXml}\t\t<Frame xmlns="">Dialog</Frame>
\t\t<Pattern xmlns="">Dialog</Pattern>
\t\t<PatternVersion xmlns="">1.2</PatternVersion>
\t\t<Style xmlns="">Dialog</Style>
\t\t<Controls xmlns="">
\t\t\t<AxFormControl xmlns=""
\t\t\t\t\ti:type="AxFormGroupControl">
\t\t\t\t<Name>DialogBody</Name>
\t\t\t\t<HeightMode>SizeToAvailable</HeightMode>
${dialogBodyPattern}\t\t\t\t<Type>Group</Type>
\t\t\t\t<WidthMode>SizeToAvailable</WidthMode>
\t\t\t\t<FormControlExtension
\t\t\t\t\ti:nil="true" />
\t\t\t\t<Controls>
${bodyContent}\t\t\t\t</Controls>
${dialogBodyLayout}\t\t\t\t<Style>DialogContent</Style>
\t\t\t</AxFormControl>
\t\t\t<AxFormControl xmlns=""
\t\t\t\t\ti:type="AxFormButtonGroupControl">
\t\t\t\t<Name>ButtonGroup</Name>
\t\t\t\t<Type>ButtonGroup</Type>
\t\t\t\t<WidthMode>SizeToAvailable</WidthMode>
\t\t\t\t<FormControlExtension
\t\t\t\t\ti:nil="true" />
\t\t\t\t<Controls>
\t\t\t\t\t<AxFormControl xmlns=""
\t\t\t\t\t\t\ti:type="AxFormCommandButtonControl">
\t\t\t\t\t\t<Name>OkButton</Name>
\t\t\t\t\t\t<Type>CommandButton</Type>
\t\t\t\t\t\t<FormControlExtension
\t\t\t\t\t\t\ti:nil="true" />
\t\t\t\t\t\t<Command>OK</Command>
\t\t\t\t\t</AxFormControl>
\t\t\t\t\t<AxFormControl xmlns=""
\t\t\t\t\t\t\ti:type="AxFormCommandButtonControl">
\t\t\t\t\t\t<Name>CloseButton</Name>
\t\t\t\t\t\t<Type>CommandButton</Type>
\t\t\t\t\t\t<FormControlExtension
\t\t\t\t\t\t\ti:nil="true" />
\t\t\t\t\t\t<Command>Cancel</Command>
\t\t\t\t\t</AxFormControl>
\t\t\t\t</Controls>
\t\t\t\t<ArrangeMethod>HorizontalRight</ArrangeMethod>
\t\t\t\t<Style>DialogCommitContainer</Style>
\t\t\t</AxFormControl>
\t\t</Controls>
\t</Design>
\t<Parts />
</AxForm>
`;
  }

  // ---------------------------------------------------------------------------
  // TableOfContents  (v1.1)
  // Use: setup/parameters forms — loosely related information in sections
  // Reference: CustParameters form
  // Structure: Tab control (TOC navigation) → TabPages (FieldsFieldGroups each)
  // ---------------------------------------------------------------------------
  static buildTableOfContents(opt: FormTemplateOptions): string {
    const { formName, dsName, dsTable, caption, sections = [], gridFields = [] } = opt;
    const captionXml = caption
      ? `\t\t<Caption xmlns="">${caption}</Caption>\n`
      : '';

    const effectiveSections = sections.length > 0
      ? sections
      : [
          { name: 'TabPageGeneral',  caption: 'General' },
          { name: 'TabPageSetup',    caption: 'Setup' },
        ];

    // TableOfContents = a single TOC navigation Tab whose every page carries a
    // TOCTitleContainer group (heading) plus a nested FastTabs tab holding the
    // FieldsFieldGroups content. The section TabPage itself is unpatterned.
    const sectionFields = (s: { name: string }): string =>
      (dsName ? gridFields : []).map(f =>
        FormPatternTemplates.fieldControl(f, dsName!, '\t\t\t\t\t\t\t\t\t\t', `${s.name}_`, opt.fieldTypes),
      ).join('');

    const tabPageControls = effectiveSections.map(s =>
      `\t\t\t\t<AxFormControl xmlns=""\n` +
      `\t\t\t\t\t\ti:type="AxFormTabPageControl">\n` +
      `\t\t\t\t\t<Name>${s.name}</Name>\n` +
      `\t\t\t\t\t<Type>TabPage</Type>\n` +
      `\t\t\t\t\t<FormControlExtension\n\t\t\t\t\t\ti:nil="true" />\n` +
      `\t\t\t\t\t<Controls>\n` +
      // TOC heading
      `\t\t\t\t\t\t<AxFormControl xmlns=""\n\t\t\t\t\t\t\t\ti:type="AxFormGroupControl">\n` +
      `\t\t\t\t\t\t\t<Name>${s.name}Title</Name>\n` +
      `\t\t\t\t\t\t\t<Skip>Yes</Skip>\n` +
      `\t\t\t\t\t\t\t<Type>Group</Type>\n` +
      `\t\t\t\t\t\t\t<WidthMode>SizeToAvailable</WidthMode>\n` +
      `\t\t\t\t\t\t\t<FormControlExtension\n\t\t\t\t\t\t\t\ti:nil="true" />\n` +
      `\t\t\t\t\t\t\t<Controls>\n` +
      `\t\t\t\t\t\t\t\t<AxFormControl xmlns=""\n\t\t\t\t\t\t\t\t\t\ti:type="AxFormStaticTextControl">\n` +
      `\t\t\t\t\t\t\t\t\t<Name>${s.name}Instruction</Name>\n` +
      `\t\t\t\t\t\t\t\t\t<Skip>Yes</Skip>\n` +
      `\t\t\t\t\t\t\t\t\t<Type>StaticText</Type>\n` +
      `\t\t\t\t\t\t\t\t\t<WidthMode>SizeToAvailable</WidthMode>\n` +
      `\t\t\t\t\t\t\t\t\t<FormControlExtension\n\t\t\t\t\t\t\t\t\t\ti:nil="true" />\n` +
      `\t\t\t\t\t\t\t\t\t<Style>MainInstruction</Style>\n` +
      `\t\t\t\t\t\t\t\t\t<Text>${s.caption}</Text>\n` +
      `\t\t\t\t\t\t\t\t</AxFormControl>\n` +
      `\t\t\t\t\t\t\t</Controls>\n` +
      `\t\t\t\t\t\t\t<AllowUserSetup>No</AllowUserSetup>\n` +
      `\t\t\t\t\t\t\t<FrameType>None</FrameType>\n` +
      `\t\t\t\t\t\t\t<Style>TOCTitleContainer</Style>\n` +
      `\t\t\t\t\t\t</AxFormControl>\n` +
      // nested FastTabs content tab
      `\t\t\t\t\t\t<AxFormControl xmlns=""\n\t\t\t\t\t\t\t\ti:type="AxFormTabControl">\n` +
      `\t\t\t\t\t\t\t<Name>${s.name}FastTab</Name>\n` +
      `\t\t\t\t\t\t\t<Type>Tab</Type>\n` +
      `\t\t\t\t\t\t\t<FormControlExtension\n\t\t\t\t\t\t\t\ti:nil="true" />\n` +
      `\t\t\t\t\t\t\t<Controls>\n` +
      `\t\t\t\t\t\t\t\t<AxFormControl xmlns=""\n\t\t\t\t\t\t\t\t\t\ti:type="AxFormTabPageControl">\n` +
      `\t\t\t\t\t\t\t\t\t<Name>${s.name}Page</Name>\n` +
      `\t\t\t\t\t\t\t\t\t<Pattern>FieldsFieldGroups</Pattern>\n` +
      `\t\t\t\t\t\t\t\t\t<PatternVersion>1.1</PatternVersion>\n` +
      `\t\t\t\t\t\t\t\t\t<Type>TabPage</Type>\n` +
      `\t\t\t\t\t\t\t\t\t<FormControlExtension\n\t\t\t\t\t\t\t\t\t\ti:nil="true" />\n` +
      `\t\t\t\t\t\t\t\t\t<Controls>\n` +
      `\t\t\t\t\t\t\t\t\t\t<AxFormControl xmlns=""\n\t\t\t\t\t\t\t\t\t\t\t\ti:type="AxFormGroupControl">\n` +
      `\t\t\t\t\t\t\t\t\t\t\t<Name>${s.name}Group</Name>\n` +
      `\t\t\t\t\t\t\t\t\t\t\t<Type>Group</Type>\n` +
      `\t\t\t\t\t\t\t\t\t\t\t<FormControlExtension\n\t\t\t\t\t\t\t\t\t\t\t\ti:nil="true" />\n` +
      `\t\t\t\t\t\t\t\t\t\t\t<Controls>\n` +
      sectionFields(s) +
      `\t\t\t\t\t\t\t\t\t\t\t</Controls>\n` +
      `\t\t\t\t\t\t\t\t\t\t</AxFormControl>\n` +
      `\t\t\t\t\t\t\t\t\t</Controls>\n` +
      `\t\t\t\t\t\t\t\t\t<ColumnsMode>Fill</ColumnsMode>\n` +
      `\t\t\t\t\t\t\t\t\t<Caption>${s.caption}</Caption>\n` +
      `\t\t\t\t\t\t\t\t</AxFormControl>\n` +
      `\t\t\t\t\t\t\t</Controls>\n` +
      `\t\t\t\t\t\t\t<Style>FastTabs</Style>\n` +
      `\t\t\t\t\t\t</AxFormControl>\n` +
      `\t\t\t\t\t</Controls>\n` +
      `\t\t\t\t</AxFormControl>\n`
    ).join('');

    const dsXml = dsName && dsTable
      ? `\t<DataSources>\n` +
        `\t\t<AxFormDataSource xmlns="">\n` +
        `\t\t\t<Name>${dsName}</Name>\n` +
        `\t\t\t<Table>${dsTable}</Table>\n` +
        `\t\t\t<Fields />\n` +
        `\t\t\t<ReferencedDataSources />\n` +
        `\t\t\t<InsertIfEmpty>No</InsertIfEmpty>\n` +
        `\t\t\t<DataSourceLinks />\n` +
        `\t\t\t<DerivedDataSources />\n` +
        `\t\t</AxFormDataSource>\n` +
        `\t</DataSources>\n`
      : `\t<DataSources />\n`;

    const dsOnDesign = dsName ? `\t\t<DataSource xmlns="">${dsName}</DataSource>\n` : '';

    return `<?xml version="1.0" encoding="utf-8"?>
<AxForm xmlns:i="http://www.w3.org/2001/XMLSchema-instance" xmlns="Microsoft.Dynamics.AX.Metadata.V6">
\t<Name>${formName}</Name>
\t<SourceCode>
\t\t<Methods xmlns="">
\t\t\t<Method>
\t\t\t\t<Name>classDeclaration</Name>
\t\t\t\t<Source><![CDATA[
[Form]
public class ${formName} extends FormRun
{
}

]]></Source>
\t\t\t</Method>
\t\t</Methods>
\t\t<DataSources xmlns="" />
\t\t<DataControls xmlns="" />
\t\t<Members xmlns="" />
\t</SourceCode>
${dsXml}\t<Design>
${captionXml}${dsOnDesign}\t\t<Pattern xmlns="">TableOfContents</Pattern>
\t\t<PatternVersion xmlns="">1.1</PatternVersion>
\t\t<Style xmlns="">TableOfContents</Style>
\t\t<Controls xmlns="">
\t\t\t<AxFormControl xmlns=""
\t\t\t\t\ti:type="AxFormTabControl">
\t\t\t\t<Name>Tab</Name>
\t\t\t\t<Type>Tab</Type>
\t\t\t\t<FormControlExtension
\t\t\t\t\ti:nil="true" />
\t\t\t\t<Controls>
${tabPageControls}\t\t\t\t</Controls>
\t\t\t\t<Style>VerticalTabs</Style>
\t\t\t</AxFormControl>
\t\t</Controls>
\t</Design>
\t<Parts />
</AxForm>
`;
  }

  // ---------------------------------------------------------------------------
  // Lookup  (v1.2)
  // Use: lookup forms — a grid with optional filters
  // Reference: SysLanguageLookup form
  // Structure: Grid with field columns
  // ---------------------------------------------------------------------------
  static buildLookup(opt: FormTemplateOptions): string {
    const { formName, dsName = formName, dsTable = dsName, caption, gridFields = [] } = opt;
    const captionXml = caption
      ? `\t\t<Caption xmlns="">${caption}</Caption>\n`
      : '';

    const fieldControls = gridFields.map(f =>
      `\t\t\t\t\t<AxFormControl xmlns=""\n` +
      `\t\t\t\t\t\t\ti:type="AxFormStringControl">\n` +
      `\t\t\t\t\t\t<Name>Grid_${f}</Name>\n` +
      `\t\t\t\t\t\t<Type>String</Type>\n` +
      `\t\t\t\t\t\t<FormControlExtension\n\t\t\t\t\t\t\ti:nil="true" />\n` +
      `\t\t\t\t\t\t<DataField>${f}</DataField>\n` +
      `\t\t\t\t\t\t<DataSource>${dsName}</DataSource>\n` +
      `\t\t\t\t\t</AxFormControl>\n`
    ).join('');

    return `<?xml version="1.0" encoding="utf-8"?>
<AxForm xmlns:i="http://www.w3.org/2001/XMLSchema-instance" xmlns="Microsoft.Dynamics.AX.Metadata.V6">
\t<Name>${formName}</Name>
\t<SourceCode>
\t\t<Methods xmlns="">
\t\t\t<Method>
\t\t\t\t<Name>classDeclaration</Name>
\t\t\t\t<Source><![CDATA[
[Form]
public class ${formName} extends FormRun
{
}

]]></Source>
\t\t\t</Method>
\t\t</Methods>
\t\t<DataSources xmlns="" />
\t\t<DataControls xmlns="" />
\t\t<Members xmlns="" />
\t</SourceCode>
\t<DataSources>
\t\t<AxFormDataSource xmlns="">
\t\t\t<Name>${dsName}</Name>
\t\t\t<Table>${dsTable}</Table>
\t\t\t<Fields />
\t\t\t<ReferencedDataSources />
\t\t\t<DataSourceLinks />
\t\t\t<DerivedDataSources />
\t\t</AxFormDataSource>
\t</DataSources>
\t<Design>
${captionXml}\t\t<Frame xmlns="">Border</Frame>
\t\t<HeightMode xmlns="">SizeToContent</HeightMode>
\t\t<Pattern xmlns="">LookupGridOnly</Pattern>
\t\t<PatternVersion xmlns="">1.1</PatternVersion>
\t\t<Style xmlns="">Lookup</Style>
\t\t<WidthMode xmlns="">SizeToAvailable</WidthMode>
\t\t<WindowType xmlns="">Popup</WindowType>
\t\t<Controls xmlns="">
\t\t\t<AxFormControl xmlns=""
\t\t\t\t\ti:type="AxFormGridControl">
\t\t\t\t<Name>Grid</Name>
\t\t\t\t<AllowEdit>No</AllowEdit>
\t\t\t\t<ElementPosition>1431655764</ElementPosition>
\t\t\t\t<FilterExpression>%1</FilterExpression>
\t\t\t\t<HeightMode>SizeToContent</HeightMode>
\t\t\t\t<Type>Grid</Type>
\t\t\t\t<VerticalSpacing>-1</VerticalSpacing>
\t\t\t\t<FormControlExtension
\t\t\t\t\ti:nil="true" />
\t\t\t\t<Controls>
${fieldControls}\t\t\t\t</Controls>
\t\t\t\t<DataSource>${dsName}</DataSource>
\t\t\t\t<Style>Tabular</Style>
\t\t\t</AxFormControl>
\t\t</Controls>
\t</Design>
\t<Parts />
</AxForm>
`;
  }

  // ---------------------------------------------------------------------------
  // ListPage  (v1.1)
  // Use: workspace/area page with rich filtering, typically backed by a query.
  // The user navigates from the ListPage to a DetailsMaster form for editing.
  // Reference: SalesTableListPage, CustTableListPage
  // Structure: ActionPane (with action pane tabs → button groups)
  //            CustomFilterGroup → QuickFilterControl
  //            Grid (Style = Tabular, ShowRowLabels = No, AllowEdit = No)
  // ---------------------------------------------------------------------------
  static buildListPage(opt: FormTemplateOptions): string {
    const { formName, dsName = formName, dsTable = dsName, caption, gridFields = [] } = opt;
    const captionXml = caption
      ? `\t\t<Caption xmlns="">${caption}</Caption>\n`
      : '';
    const defaultCol = gridFields.length > 0 ? `Grid_${gridFields[0]}` : `Grid_${dsName}`;

    const fieldControls = gridFields.map(f =>
      `\t\t\t\t\t<AxFormControl xmlns=""\n` +
      `\t\t\t\t\t\t\ti:type="AxFormStringControl">\n` +
      `\t\t\t\t\t\t<Name>Grid_${f}</Name>\n` +
      `\t\t\t\t\t\t<Type>String</Type>\n` +
      `\t\t\t\t\t\t<FormControlExtension\n\t\t\t\t\t\t\ti:nil="true" />\n` +
      `\t\t\t\t\t\t<DataField>${f}</DataField>\n` +
      `\t\t\t\t\t\t<DataSource>${dsName}</DataSource>\n` +
      `\t\t\t\t\t</AxFormControl>\n`
    ).join('');

    return `<?xml version="1.0" encoding="utf-8"?>
<AxForm xmlns:i="http://www.w3.org/2001/XMLSchema-instance" xmlns="Microsoft.Dynamics.AX.Metadata.V6">
\t<Name>${formName}</Name>
\t<SourceCode>
\t\t<Methods xmlns="">
\t\t\t<Method>
\t\t\t\t<Name>classDeclaration</Name>
\t\t\t\t<Source><![CDATA[
[Form]
public class ${formName} extends FormRun
{
}

]]></Source>
\t\t\t</Method>
\t\t</Methods>
\t\t<DataSources xmlns="" />
\t\t<DataControls xmlns="" />
\t\t<Members xmlns="" />
\t</SourceCode>
\t<DataSources>
\t\t<AxFormDataSource xmlns="">
\t\t\t<Name>${dsName}</Name>
\t\t\t<Table>${dsTable}</Table>
\t\t\t<Fields />
\t\t\t<ReferencedDataSources />
\t\t\t<AllowCreate>No</AllowCreate>
\t\t\t<AllowEdit>No</AllowEdit>
\t\t\t<AllowDelete>No</AllowDelete>
\t\t\t<InsertIfEmpty>No</InsertIfEmpty>
\t\t\t<DataSourceLinks />
\t\t\t<DerivedDataSources />
\t\t</AxFormDataSource>
\t</DataSources>
\t<Design>
${captionXml}\t\t<DataSource xmlns="">${dsName}</DataSource>
\t\t<Pattern xmlns="">ListPage</Pattern>
\t\t<PatternVersion xmlns="">UX7 1.0</PatternVersion>
\t\t<Style xmlns="">ListPage</Style>
\t\t<TitleDataSource xmlns="">${dsName}</TitleDataSource>
\t\t<Controls xmlns="">
\t\t\t<AxFormControl xmlns=""
\t\t\t\t\ti:type="AxFormActionPaneControl">
\t\t\t\t<Name>ActionPane</Name>
\t\t\t\t<ElementPosition>134217727</ElementPosition>
\t\t\t\t<FilterExpression>%1</FilterExpression>
\t\t\t\t<Type>ActionPane</Type>
\t\t\t\t<VerticalSpacing>-1</VerticalSpacing>
\t\t\t\t<FormControlExtension
\t\t\t\t\ti:nil="true" />
\t\t\t\t<Controls>
\t\t\t\t\t<AxFormControl xmlns=""
\t\t\t\t\t\t\ti:type="AxFormActionPaneTabControl">
\t\t\t\t\t\t<Name>ActionPaneTab</Name>
\t\t\t\t\t\t<Type>ActionPaneTab</Type>
\t\t\t\t\t\t<FormControlExtension
\t\t\t\t\t\t\ti:nil="true" />
\t\t\t\t\t\t<Controls>
\t\t\t\t\t\t\t<AxFormControl xmlns=""
\t\t\t\t\t\t\t\t\ti:type="AxFormButtonGroupControl">
\t\t\t\t\t\t\t\t<Name>NewButtonGroup</Name>
\t\t\t\t\t\t\t\t<Type>ButtonGroup</Type>
\t\t\t\t\t\t\t\t<FormControlExtension
\t\t\t\t\t\t\t\t\ti:nil="true" />
\t\t\t\t\t\t\t\t<Controls />
\t\t\t\t\t\t\t</AxFormControl>
\t\t\t\t\t\t\t<AxFormControl xmlns=""
\t\t\t\t\t\t\t\t\ti:type="AxFormButtonGroupControl">
\t\t\t\t\t\t\t\t<Name>MaintainButtonGroup</Name>
\t\t\t\t\t\t\t\t<Type>ButtonGroup</Type>
\t\t\t\t\t\t\t\t<FormControlExtension
\t\t\t\t\t\t\t\t\ti:nil="true" />
\t\t\t\t\t\t\t\t<Controls />
\t\t\t\t\t\t\t</AxFormControl>
\t\t\t\t\t\t</Controls>
\t\t\t\t\t</AxFormControl>
\t\t\t\t</Controls>
\t\t\t\t<AlignChild>No</AlignChild>
\t\t\t\t<AlignChildren>No</AlignChildren>
\t\t\t\t<ArrangeMethod>Vertical</ArrangeMethod>
\t\t\t</AxFormControl>
\t\t\t<AxFormControl xmlns=""
\t\t\t\t\ti:type="AxFormGroupControl">
\t\t\t\t<Name>CustomFilterGroup</Name>
\t\t\t\t<Pattern>CustomAndQuickFilters</Pattern>
\t\t\t\t<PatternVersion>1.1</PatternVersion>
\t\t\t\t<Type>Group</Type>
\t\t\t\t<WidthMode>SizeToAvailable</WidthMode>
\t\t\t\t<FormControlExtension
\t\t\t\t\ti:nil="true" />
\t\t\t\t<Controls>
\t\t\t\t\t<AxFormControl>
\t\t\t\t\t\t<Name>QuickFilterControl</Name>
\t\t\t\t\t\t<FormControlExtension>
\t\t\t\t\t\t\t<Name>QuickFilterControl</Name>
\t\t\t\t\t\t\t<ExtensionComponents />
\t\t\t\t\t\t\t<ExtensionProperties>
\t\t\t\t\t\t\t\t<AxFormControlExtensionProperty>
\t\t\t\t\t\t\t\t\t<Name>targetControlName</Name>
\t\t\t\t\t\t\t\t\t<Type>String</Type>
\t\t\t\t\t\t\t\t\t<Value>Grid</Value>
\t\t\t\t\t\t\t\t</AxFormControlExtensionProperty>
\t\t\t\t\t\t\t\t<AxFormControlExtensionProperty>
\t\t\t\t\t\t\t\t\t<Name>defaultColumnName</Name>
\t\t\t\t\t\t\t\t\t<Type>String</Type>
\t\t\t\t\t\t\t\t\t<Value>${defaultCol}</Value>
\t\t\t\t\t\t\t\t</AxFormControlExtensionProperty>
\t\t\t\t\t\t\t\t<AxFormControlExtensionProperty>
\t\t\t\t\t\t\t\t\t<Name>placeholderText</Name>
\t\t\t\t\t\t\t\t\t<Type>String</Type>
\t\t\t\t\t\t\t\t</AxFormControlExtensionProperty>
\t\t\t\t\t\t\t</ExtensionProperties>
\t\t\t\t\t\t</FormControlExtension>
\t\t\t\t\t</AxFormControl>
\t\t\t\t</Controls>
\t\t\t\t<ArrangeMethod>HorizontalLeft</ArrangeMethod>
\t\t\t\t<FrameType>None</FrameType>
\t\t\t\t<Style>CustomFilter</Style>
\t\t\t\t<ViewEditMode>Edit</ViewEditMode>
\t\t\t</AxFormControl>
\t\t\t<AxFormControl xmlns=""
\t\t\t\t\ti:type="AxFormGridControl">
\t\t\t\t<Name>Grid</Name>
\t\t\t\t<AllowEdit>No</AllowEdit>
\t\t\t\t<ElementPosition>1431655764</ElementPosition>
\t\t\t\t<FilterExpression>%1</FilterExpression>
\t\t\t\t<Type>Grid</Type>
\t\t\t\t<VerticalSpacing>-1</VerticalSpacing>
\t\t\t\t<FormControlExtension
\t\t\t\t\ti:nil="true" />
\t\t\t\t<Controls>
${fieldControls}\t\t\t\t</Controls>
\t\t\t\t<AlternateRowShading>No</AlternateRowShading>
\t\t\t\t<DataSource>${dsName}</DataSource>
\t\t\t\t<MultiSelect>Yes</MultiSelect>
\t\t\t\t<ShowRowLabels>No</ShowRowLabels>
\t\t\t\t<Style>Tabular</Style>
\t\t\t</AxFormControl>
\t\t</Controls>
\t</Design>
\t<Parts />
</AxForm>
`;
  }

  // ---------------------------------------------------------------------------
  // Workspace  (v1.0)
  // Use: Operational workspace — KPI summary tiles + tabbed list sections.
  // Reference: VendPaymentWorkspace, LedgerJournalWorkspace
  // Structure: ActionPane
  //            PanoramaBody (Tab, Style=Panorama)
  //              SummarySection (TabPage) → TileSection (Group) → KPI tile buttons
  //              ListSection(s) (TabPage) → CustomFilterGroup + Grid per section
  // ---------------------------------------------------------------------------
  static buildWorkspace(opt: FormTemplateOptions): string {
    const { formName, dsName = formName, dsTable = dsName, caption, sections = [] } = opt;
    const captionXml = caption
      ? `\t\t<Caption xmlns="">${caption}</Caption>\n`
      : '';

    // Generate extra panorama list sections from the `sections` option
    const listSections = sections.map((sec, idx) =>
      `\t\t\t\t\t<AxFormControl xmlns=""\n` +
      `\t\t\t\t\t\t\ti:type="AxFormTabPageControl">\n` +
      `\t\t\t\t\t\t<Name>${sec.name}Section</Name>\n` +
      `\t\t\t\t\t\t<ElementPosition>${536870912 * (idx + 2)}</ElementPosition>\n` +
      `\t\t\t\t\t\t<Type>TabPage</Type>\n` +
      `\t\t\t\t\t\t<FormControlExtension\n\t\t\t\t\t\t\ti:nil="true" />\n` +
      `\t\t\t\t\t\t<Controls>\n` +
      `\t\t\t\t\t\t\t<AxFormControl xmlns=""\n` +
      `\t\t\t\t\t\t\t\t\ti:type="AxFormGroupControl">\n` +
      `\t\t\t\t\t\t\t\t<Name>${sec.name}CustomFilterGroup</Name>\n` +
      `\t\t\t\t\t\t\t\t<Pattern>CustomAndQuickFilters</Pattern>\n` +
      `\t\t\t\t\t\t\t\t<PatternVersion>1.1</PatternVersion>\n` +
      `\t\t\t\t\t\t\t\t<Type>Group</Type>\n` +
      `\t\t\t\t\t\t\t\t<WidthMode>SizeToAvailable</WidthMode>\n` +
      `\t\t\t\t\t\t\t\t<FormControlExtension\n\t\t\t\t\t\t\t\t\ti:nil="true" />\n` +
      `\t\t\t\t\t\t\t\t<Controls>\n` +
      `\t\t\t\t\t\t\t\t\t<AxFormControl>\n` +
      `\t\t\t\t\t\t\t\t\t\t<Name>${sec.name}QuickFilter</Name>\n` +
      `\t\t\t\t\t\t\t\t\t\t<FormControlExtension>\n` +
      `\t\t\t\t\t\t\t\t\t\t\t<Name>QuickFilterControl</Name>\n` +
      `\t\t\t\t\t\t\t\t\t\t\t<ExtensionComponents />\n` +
      `\t\t\t\t\t\t\t\t\t\t\t<ExtensionProperties>\n` +
      `\t\t\t\t\t\t\t\t\t\t\t\t<AxFormControlExtensionProperty>\n` +
      `\t\t\t\t\t\t\t\t\t\t\t\t\t<Name>targetControlName</Name>\n` +
      `\t\t\t\t\t\t\t\t\t\t\t\t\t<Type>String</Type>\n` +
      `\t\t\t\t\t\t\t\t\t\t\t\t\t<Value>${sec.name}Grid</Value>\n` +
      `\t\t\t\t\t\t\t\t\t\t\t\t</AxFormControlExtensionProperty>\n` +
      `\t\t\t\t\t\t\t\t\t\t\t</ExtensionProperties>\n` +
      `\t\t\t\t\t\t\t\t\t\t</FormControlExtension>\n` +
      `\t\t\t\t\t\t\t\t\t</AxFormControl>\n` +
      `\t\t\t\t\t\t\t\t</Controls>\n` +
      `\t\t\t\t\t\t\t\t<ArrangeMethod>HorizontalLeft</ArrangeMethod>\n` +
      `\t\t\t\t\t\t\t\t<FrameType>None</FrameType>\n` +
      `\t\t\t\t\t\t\t\t<Style>CustomFilter</Style>\n` +
      `\t\t\t\t\t\t\t\t<ViewEditMode>Edit</ViewEditMode>\n` +
      `\t\t\t\t\t\t\t</AxFormControl>\n` +
      `\t\t\t\t\t\t\t<AxFormControl xmlns=""\n` +
      `\t\t\t\t\t\t\t\t\ti:type="AxFormGridControl">\n` +
      `\t\t\t\t\t\t\t\t<Name>${sec.name}Grid</Name>\n` +
      `\t\t\t\t\t\t\t\t<Type>Grid</Type>\n` +
      `\t\t\t\t\t\t\t\t<WidthMode>SizeToAvailable</WidthMode>\n` +
      `\t\t\t\t\t\t\t\t<FormControlExtension\n\t\t\t\t\t\t\t\t\ti:nil="true" />\n` +
      `\t\t\t\t\t\t\t\t<Controls />\n` +
      `\t\t\t\t\t\t\t\t<DataSource>${dsName}</DataSource>\n` +
      `\t\t\t\t\t\t\t\t<ShowRowLabels>No</ShowRowLabels>\n` +
      `\t\t\t\t\t\t\t\t<Style>Tabular</Style>\n` +
      `\t\t\t\t\t\t\t</AxFormControl>\n` +
      `\t\t\t\t\t\t</Controls>\n` +
      `\t\t\t\t\t\t<FastTabExpanded>Yes</FastTabExpanded>\n` +
      `\t\t\t\t\t\t<FrameType>None</FrameType>\n` +
      `\t\t\t\t\t\t<Caption>${sec.caption}</Caption>\n` +
      `\t\t\t\t\t</AxFormControl>\n`
    ).join('');

    return `<?xml version="1.0" encoding="utf-8"?>
<AxForm xmlns:i="http://www.w3.org/2001/XMLSchema-instance" xmlns="Microsoft.Dynamics.AX.Metadata.V6">
\t<Name>${formName}</Name>
\t<SourceCode>
\t\t<Methods xmlns="">
\t\t\t<Method>
\t\t\t\t<Name>classDeclaration</Name>
\t\t\t\t<Source><![CDATA[
[Form]
public class ${formName} extends FormRun
{
}

]]></Source>
\t\t\t</Method>
\t\t</Methods>
\t\t<DataSources xmlns="" />
\t\t<DataControls xmlns="" />
\t\t<Members xmlns="" />
\t</SourceCode>
\t<DataSources>
\t\t<AxFormDataSource xmlns="">
\t\t\t<Name>${dsName}</Name>
\t\t\t<Table>${dsTable}</Table>
\t\t\t<Fields />
\t\t\t<ReferencedDataSources />
\t\t\t<AllowCreate>No</AllowCreate>
\t\t\t<AllowEdit>No</AllowEdit>
\t\t\t<AllowDelete>No</AllowDelete>
\t\t\t<InsertIfEmpty>No</InsertIfEmpty>
\t\t\t<DataSourceLinks />
\t\t\t<DerivedDataSources />
\t\t</AxFormDataSource>
\t</DataSources>
\t<Design>
${captionXml}\t\t<Pattern xmlns="">WorkspaceOperational</Pattern>
\t\t<PatternVersion xmlns="">1.1</PatternVersion>
\t\t<ShowDeleteButton xmlns="">No</ShowDeleteButton>
\t\t<ShowNewButton xmlns="">No</ShowNewButton>
\t\t<Style xmlns="">Workspace</Style>
\t\t<ViewEditMode xmlns="">View</ViewEditMode>
\t\t<Controls xmlns="">
\t\t\t<AxFormControl xmlns=""
\t\t\t\t\ti:type="AxFormActionPaneControl">
\t\t\t\t<Name>ActionPane</Name>
\t\t\t\t<ElementPosition>134217727</ElementPosition>
\t\t\t\t<FilterExpression>%1</FilterExpression>
\t\t\t\t<Type>ActionPane</Type>
\t\t\t\t<VerticalSpacing>-1</VerticalSpacing>
\t\t\t\t<FormControlExtension
\t\t\t\t\ti:nil="true" />
\t\t\t\t<Controls>
\t\t\t\t\t<AxFormControl xmlns=""
\t\t\t\t\t\t\ti:type="AxFormActionPaneTabControl">
\t\t\t\t\t\t<Name>ActionPaneTab</Name>
\t\t\t\t\t\t<Type>ActionPaneTab</Type>
\t\t\t\t\t\t<FormControlExtension
\t\t\t\t\t\t\ti:nil="true" />
\t\t\t\t\t\t<Controls>
\t\t\t\t\t\t\t<AxFormControl xmlns=""
\t\t\t\t\t\t\t\t\ti:type="AxFormButtonGroupControl">
\t\t\t\t\t\t\t\t<Name>NewButtonGroup</Name>
\t\t\t\t\t\t\t\t<Type>ButtonGroup</Type>
\t\t\t\t\t\t\t\t<FormControlExtension
\t\t\t\t\t\t\t\t\ti:nil="true" />
\t\t\t\t\t\t\t\t<Controls />
\t\t\t\t\t\t\t</AxFormControl>
\t\t\t\t\t\t</Controls>
\t\t\t\t\t</AxFormControl>
\t\t\t\t</Controls>
\t\t\t\t<AlignChild>No</AlignChild>
\t\t\t\t<AlignChildren>No</AlignChildren>
\t\t\t\t<ArrangeMethod>Vertical</ArrangeMethod>
\t\t\t</AxFormControl>
\t\t\t<AxFormControl xmlns=""
\t\t\t\t\ti:type="AxFormTabControl">
\t\t\t\t<Name>PanoramaBody</Name>
\t\t\t\t<AutoDeclaration>Yes</AutoDeclaration>
\t\t\t\t<ElementPosition>268435455</ElementPosition>
\t\t\t\t<ExtendedStyle>tab_simpleFastTab</ExtendedStyle>
\t\t\t\t<Type>Tab</Type>
\t\t\t\t<WidthMode>SizeToAvailable</WidthMode>
\t\t\t\t<HeightMode>SizeToAvailable</HeightMode>
\t\t\t\t<FormControlExtension
\t\t\t\t\ti:nil="true" />
\t\t\t\t<Controls>
\t\t\t\t\t<AxFormControl xmlns=""
\t\t\t\t\t\t\ti:type="AxFormTabPageControl">
\t\t\t\t\t\t<Name>SummarySection</Name>
\t\t\t\t\t\t<ElementPosition>536870911</ElementPosition>
\t\t\t\t\t\t<Type>TabPage</Type>
\t\t\t\t\t\t<FormControlExtension
\t\t\t\t\t\t\ti:nil="true" />
\t\t\t\t\t\t<Controls>
\t\t\t\t\t\t\t<AxFormControl xmlns=""
\t\t\t\t\t\t\t\t\ti:type="AxFormGroupControl">
\t\t\t\t\t\t\t\t<Name>TileSection</Name>
\t\t\t\t\t\t\t\t<Type>Group</Type>
\t\t\t\t\t\t\t\t<WidthMode>SizeToAvailable</WidthMode>
\t\t\t\t\t\t\t\t<FormControlExtension
\t\t\t\t\t\t\t\t\ti:nil="true" />
\t\t\t\t\t\t\t\t<Controls>
\t\t\t\t\t\t\t\t\t<!-- Add AxFormControlButtonControl tiles here -->
\t\t\t\t\t\t\t\t\t<!-- Example: <AxFormControl i:type="AxFormButtonControl"><Name>Tile1</Name><Style>TileButton</Style>... -->
\t\t\t\t\t\t\t\t</Controls>
\t\t\t\t\t\t\t\t<ArrangeMethod>HorizontalLeft</ArrangeMethod>
\t\t\t\t\t\t\t\t<FrameType>None</FrameType>
\t\t\t\t\t\t\t</AxFormControl>
\t\t\t\t\t\t\t<AxFormControl xmlns=""
\t\t\t\t\t\t\t\t\ti:type="AxFormGroupControl">
\t\t\t\t\t\t\t\t<Name>ChartSection</Name>
\t\t\t\t\t\t\t\t<Type>Group</Type>
\t\t\t\t\t\t\t\t<WidthMode>SizeToAvailable</WidthMode>
\t\t\t\t\t\t\t\t<FormControlExtension
\t\t\t\t\t\t\t\t\ti:nil="true" />
\t\t\t\t\t\t\t\t<Controls>
\t\t\t\t\t\t\t\t\t<!-- Add FormPart references for charts/KPIs here -->
\t\t\t\t\t\t\t\t</Controls>
\t\t\t\t\t\t\t\t<ArrangeMethod>HorizontalLeft</ArrangeMethod>
\t\t\t\t\t\t\t\t<FrameType>None</FrameType>
\t\t\t\t\t\t\t</AxFormControl>
\t\t\t\t\t\t</Controls>
\t\t\t\t\t\t<FastTabExpanded>Yes</FastTabExpanded>
\t\t\t\t\t\t<FrameType>None</FrameType>
\t\t\t\t\t\t<Caption>Summary</Caption>
\t\t\t\t\t</AxFormControl>
${listSections}\t\t\t\t</Controls>
\t\t\t\t<AlignChild>No</AlignChild>
\t\t\t\t<ShowTabs>Yes</ShowTabs>
\t\t\t\t<Style>FastTabs</Style>
\t\t\t</AxFormControl>
\t\t</Controls>
\t</Design>
\t<Parts />
</AxForm>
`;
  }

  // ---------------------------------------------------------------------------
  // Dispatcher — pick the right pattern builder
  // ---------------------------------------------------------------------------
  static build(pattern: FormPattern, opt: FormTemplateOptions): string {
    switch (pattern) {
      case 'SimpleList':         return this.buildSimpleList(opt);
      case 'SimpleListDetails':  return this.buildSimpleListDetails(opt);
      case 'DetailsMaster':      return this.buildDetailsMaster(opt);
      case 'DetailsTransaction': return this.buildDetailsTransaction(opt);
      case 'Dialog':             return this.buildDialog(opt);
      case 'TableOfContents':    return this.buildTableOfContents(opt);
      case 'Lookup':             return this.buildLookup(opt);
      case 'ListPage':           return this.buildListPage(opt);
      case 'Workspace':          return this.buildWorkspace(opt);
      default:                   return this.buildSimpleList(opt);
    }
  }

  /**
   * Map common pattern name aliases to canonical FormPattern values.
   * Handles various casing and abbreviation styles the AI or user might use.
   */
  static normalizePattern(raw: string): FormPattern {
    const s = raw.toLowerCase().replace(/[^a-z]/g, '');
    if (s.includes('simplelist') && s.includes('detail')) return 'SimpleListDetails';
    if (s.includes('simplelist'))                           return 'SimpleList';
    if (s.includes('listpage'))                             return 'ListPage';
    if (s.includes('detailmaster') || s.includes('detailsmaster'))     return 'DetailsMaster';
    if (s.includes('detailtransaction') || s.includes('detailstransaction')) return 'DetailsTransaction';
    if (s.includes('dialog') || s.includes('dropdialog')) return 'Dialog';
    if (s.includes('tableofcontents') || s.includes('toc') || s.includes('parameter')) return 'TableOfContents';
    if (s.includes('lookup'))                              return 'Lookup';
    if (s.includes('workspace') || s.includes('panorama') || s.includes('operational')) return 'Workspace';
    return 'SimpleList'; // default — most common for new setup tables
  }
}
