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
}

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

  // ---------------------------------------------------------------------------
  // SimpleList  (v1.1)
  // Use: simple entity with < 10 fields per record (setup tables, groups, etc.)
  // Reference: CustGroup form
  // Structure: ActionPane → ButtonGroup
  //            CustomFilterGroup → QuickFilterControl
  //            Grid → field columns
  // ---------------------------------------------------------------------------
  static buildSimpleList(opt: FormTemplateOptions): string {
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

  // ---------------------------------------------------------------------------
  // SimpleListDetails  (v1.3)
  // Use: entities of medium complexity — left list panel, right details panel
  // Reference: PaymTerm form
  // Structure: ActionPane → ButtonGroup
  //            GridContainer (SidePanel) → QuickFilter + Grid (Style=List)
  //            DetailsGroup (FieldsFieldGroups) → Tab → TabPages
  // ---------------------------------------------------------------------------
  static buildSimpleListDetails(opt: FormTemplateOptions): string {
    const { formName, dsName = formName, dsTable = dsName, caption, gridFields = [] } = opt;
    const captionXml = caption
      ? `\t\t<Caption xmlns="">${caption}</Caption>\n`
      : '';
    const defaultCol = gridFields.length > 0 ? `Grid_${gridFields[0]}` : `Grid_${dsName}`;

    const listFieldControls = gridFields.slice(0, 3).map(f =>
      `\t\t\t\t\t\t\t\t<AxFormControl xmlns=""\n` +
      `\t\t\t\t\t\t\t\t\t\ti:type="AxFormStringControl">\n` +
      `\t\t\t\t\t\t\t\t\t<Name>Grid_${f}</Name>\n` +
      `\t\t\t\t\t\t\t\t\t<Type>String</Type>\n` +
      `\t\t\t\t\t\t\t\t\t<FormControlExtension\n\t\t\t\t\t\t\t\t\t\ti:nil="true" />\n` +
      `\t\t\t\t\t\t\t\t\t<DataField>${f}</DataField>\n` +
      `\t\t\t\t\t\t\t\t\t<DataSource>${dsName}</DataSource>\n` +
      `\t\t\t\t\t\t\t\t</AxFormControl>\n`
    ).join('');

    const detailFieldControls = gridFields.map(f =>
      `\t\t\t\t\t\t\t\t\t\t<AxFormControl xmlns=""\n` +
      `\t\t\t\t\t\t\t\t\t\t\t\ti:type="AxFormStringControl">\n` +
      `\t\t\t\t\t\t\t\t\t\t\t<Name>Overview_${f}</Name>\n` +
      `\t\t\t\t\t\t\t\t\t\t\t<Type>String</Type>\n` +
      `\t\t\t\t\t\t\t\t\t\t\t<FormControlExtension\n\t\t\t\t\t\t\t\t\t\t\t\ti:nil="true" />\n` +
      `\t\t\t\t\t\t\t\t\t\t\t<DataField>${f}</DataField>\n` +
      `\t\t\t\t\t\t\t\t\t\t\t<DataSource>${dsName}</DataSource>\n` +
      `\t\t\t\t\t\t\t\t\t\t</AxFormControl>\n`
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
${captionXml}\t\t<Pattern xmlns="">SimpleListDetails</Pattern>
\t\t<PatternVersion xmlns="">1.3</PatternVersion>
\t\t<Style xmlns="">SimpleListDetails</Style>
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
\t\t\t\t<Type>Group</Type>
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
\t\t\t\t\t<AxFormControl xmlns=""
\t\t\t\t\t\t\ti:type="AxFormGridControl">
\t\t\t\t\t\t<Name>Grid</Name>
\t\t\t\t\t\t<Type>Grid</Type>
\t\t\t\t\t\t<FormControlExtension
\t\t\t\t\t\t\ti:nil="true" />
\t\t\t\t\t\t<Controls>
${listFieldControls}\t\t\t\t\t\t</Controls>
\t\t\t\t\t\t<DataSource>${dsName}</DataSource>
\t\t\t\t\t\t<GridLinesStyle>Vertical</GridLinesStyle>
\t\t\t\t\t\t<Style>List</Style>
\t\t\t\t\t</AxFormControl>
\t\t\t\t</Controls>
\t\t\t\t<Style>SidePanel</Style>
\t\t\t</AxFormControl>
\t\t\t<AxFormControl xmlns=""
\t\t\t\t\ti:type="AxFormGroupControl">
\t\t\t\t<Name>DetailsGroup</Name>
\t\t\t\t<Pattern>FieldsFieldGroups</Pattern>
\t\t\t\t<PatternVersion>1.1</PatternVersion>
\t\t\t\t<Type>Group</Type>
\t\t\t\t<FormControlExtension
\t\t\t\t\ti:nil="true" />
\t\t\t\t<Controls>
\t\t\t\t\t<AxFormControl xmlns=""
\t\t\t\t\t\t\ti:type="AxFormTabControl">
\t\t\t\t\t\t<Name>Tab</Name>
\t\t\t\t\t\t<Type>Tab</Type>
\t\t\t\t\t\t<FormControlExtension
\t\t\t\t\t\t\ti:nil="true" />
\t\t\t\t\t\t<Controls>
\t\t\t\t\t\t\t<AxFormControl xmlns=""
\t\t\t\t\t\t\t\t\ti:type="AxFormTabPageControl">
\t\t\t\t\t\t\t\t<Name>TabPageOverview</Name>
\t\t\t\t\t\t\t\t<Pattern>FieldsFieldGroups</Pattern>
\t\t\t\t\t\t\t\t<PatternVersion>1.1</PatternVersion>
\t\t\t\t\t\t\t\t<Type>TabPage</Type>
\t\t\t\t\t\t\t\t<Caption>Overview</Caption>
\t\t\t\t\t\t\t\t<FormControlExtension
\t\t\t\t\t\t\t\t\ti:nil="true" />
\t\t\t\t\t\t\t\t<Controls>
\t\t\t\t\t\t\t\t\t<AxFormControl xmlns=""
\t\t\t\t\t\t\t\t\t\t\ti:type="AxFormGroupControl">
\t\t\t\t\t\t\t\t\t\t<Name>OverviewGroup</Name>
\t\t\t\t\t\t\t\t\t\t<Type>Group</Type>
\t\t\t\t\t\t\t\t\t\t<DataGroup>Overview</DataGroup>
\t\t\t\t\t\t\t\t\t\t<FormControlExtension
\t\t\t\t\t\t\t\t\t\t\ti:nil="true" />
\t\t\t\t\t\t\t\t\t\t<Controls>
${detailFieldControls}\t\t\t\t\t\t\t\t\t\t</Controls>
\t\t\t\t\t\t\t\t\t</AxFormControl>
\t\t\t\t\t\t\t\t</Controls>
\t\t\t\t\t\t\t</AxFormControl>
\t\t\t\t\t\t\t<AxFormControl xmlns=""
\t\t\t\t\t\t\t\t\ti:type="AxFormTabPageControl">
\t\t\t\t\t\t\t\t<Name>TabPageGeneral</Name>
\t\t\t\t\t\t\t\t<Pattern>FieldsFieldGroups</Pattern>
\t\t\t\t\t\t\t\t<PatternVersion>1.1</PatternVersion>
\t\t\t\t\t\t\t\t<Type>TabPage</Type>
\t\t\t\t\t\t\t\t<Caption>General</Caption>
\t\t\t\t\t\t\t\t<FormControlExtension
\t\t\t\t\t\t\t\t\ti:nil="true" />
\t\t\t\t\t\t\t\t<Controls>
\t\t\t\t\t\t\t\t\t<AxFormControl xmlns=""
\t\t\t\t\t\t\t\t\t\t\ti:type="AxFormGroupControl">
\t\t\t\t\t\t\t\t\t\t<Name>GeneralGroup</Name>
\t\t\t\t\t\t\t\t\t\t<Type>Group</Type>
\t\t\t\t\t\t\t\t\t\t<DataGroup>General</DataGroup>
\t\t\t\t\t\t\t\t\t\t<FormControlExtension
\t\t\t\t\t\t\t\t\t\t\ti:nil="true" />
\t\t\t\t\t\t\t\t\t\t<Controls />
\t\t\t\t\t\t\t\t\t</AxFormControl>
\t\t\t\t\t\t\t\t</Controls>
\t\t\t\t\t\t\t</AxFormControl>
\t\t\t\t\t\t</Controls>
\t\t\t\t\t</AxFormControl>
\t\t\t\t</Controls>
\t\t\t</AxFormControl>
\t\t</Controls>
\t</Design>
\t<Parts />
</AxForm>
`;
  }

  // ---------------------------------------------------------------------------
  // DetailsMaster  (v1.1)
  // Use: complex master entity with FastTabs (customers, vendors, workers...)
  // Reference: CustTable form structure
  // Structure: ActionPane; header Group (Status fields); Tab (FastTabs)
  //   Grid view (hidden by default, Pattern=PanoramaBody_MasterGrid) OR
  //   Details view with FastTabs (Pattern=FieldsFieldGroups per FastTab)
  // ---------------------------------------------------------------------------
  static buildDetailsMaster(opt: FormTemplateOptions): string {
    const { formName, dsName = formName, dsTable = dsName, caption, gridFields = [] } = opt;
    const captionXml = caption
      ? `\t\t<Caption xmlns="">${caption}</Caption>\n`
      : '';

    const overviewFieldControls = gridFields.map(f =>
      `\t\t\t\t\t\t\t\t\t\t<AxFormControl xmlns=""\n` +
      `\t\t\t\t\t\t\t\t\t\t\t\ti:type="AxFormStringControl">\n` +
      `\t\t\t\t\t\t\t\t\t\t\t<Name>Overview_${f}</Name>\n` +
      `\t\t\t\t\t\t\t\t\t\t\t<Type>String</Type>\n` +
      `\t\t\t\t\t\t\t\t\t\t\t<FormControlExtension\n\t\t\t\t\t\t\t\t\t\t\t\ti:nil="true" />\n` +
      `\t\t\t\t\t\t\t\t\t\t\t<DataField>${f}</DataField>\n` +
      `\t\t\t\t\t\t\t\t\t\t\t<DataSource>${dsName}</DataSource>\n` +
      `\t\t\t\t\t\t\t\t\t\t</AxFormControl>\n`
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
${captionXml}\t\t<Pattern xmlns="">DetailsMaster</Pattern>
\t\t<PatternVersion xmlns="">1.1</PatternVersion>
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
\t\t\t\t<Name>HeaderGroup</Name>
\t\t\t\t<Type>Group</Type>
\t\t\t\t<FormControlExtension
\t\t\t\t\ti:nil="true" />
\t\t\t\t<Controls />
\t\t\t\t<WidthMode>SizeToAvailable</WidthMode>
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
\t\t\t\t\t\t<Name>TabPageOverview</Name>
\t\t\t\t\t\t<Pattern>FieldsFieldGroups</Pattern>
\t\t\t\t\t\t<PatternVersion>1.1</PatternVersion>
\t\t\t\t\t\t<Type>TabPage</Type>
\t\t\t\t\t\t<Caption>Overview</Caption>
\t\t\t\t\t\t<FormControlExtension
\t\t\t\t\t\t\ti:nil="true" />
\t\t\t\t\t\t<Controls>
\t\t\t\t\t\t\t<AxFormControl xmlns=""
\t\t\t\t\t\t\t\t\ti:type="AxFormGroupControl">
\t\t\t\t\t\t\t\t<Name>OverviewGroup</Name>
\t\t\t\t\t\t\t\t<Type>Group</Type>
\t\t\t\t\t\t\t\t<DataGroup>Overview</DataGroup>
\t\t\t\t\t\t\t\t<FormControlExtension
\t\t\t\t\t\t\t\t\ti:nil="true" />
\t\t\t\t\t\t\t\t<Controls>
${overviewFieldControls}\t\t\t\t\t\t\t\t</Controls>
\t\t\t\t\t\t\t</AxFormControl>
\t\t\t\t\t\t</Controls>
\t\t\t\t\t</AxFormControl>
\t\t\t\t\t<AxFormControl xmlns=""
\t\t\t\t\t\t\ti:type="AxFormTabPageControl">
\t\t\t\t\t\t<Name>TabPageGeneral</Name>
\t\t\t\t\t\t<Pattern>FieldsFieldGroups</Pattern>
\t\t\t\t\t\t<PatternVersion>1.1</PatternVersion>
\t\t\t\t\t\t<Type>TabPage</Type>
\t\t\t\t\t\t<Caption>General</Caption>
\t\t\t\t\t\t<FormControlExtension
\t\t\t\t\t\t\ti:nil="true" />
\t\t\t\t\t\t<Controls>
\t\t\t\t\t\t\t<AxFormControl xmlns=""
\t\t\t\t\t\t\t\t\ti:type="AxFormGroupControl">
\t\t\t\t\t\t\t\t<Name>GeneralGroup</Name>
\t\t\t\t\t\t\t\t<Type>Group</Type>
\t\t\t\t\t\t\t\t<DataGroup>General</DataGroup>
\t\t\t\t\t\t\t\t<FormControlExtension
\t\t\t\t\t\t\t\t\ti:nil="true" />
\t\t\t\t\t\t\t\t<Controls />
\t\t\t\t\t\t\t</AxFormControl>
\t\t\t\t\t\t</Controls>
\t\t\t\t\t</AxFormControl>
\t\t\t\t</Controls>
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
      linesDsName = `${dsName}Lines`,
      linesDsTable = linesDsName,
      gridFields = [],
    } = opt;
    const captionXml = caption
      ? `\t\t<Caption xmlns="">${caption}</Caption>\n`
      : '';

    const headerFieldControls = gridFields.map(f =>
      `\t\t\t\t\t\t\t\t\t\t\t<AxFormControl xmlns=""\n` +
      `\t\t\t\t\t\t\t\t\t\t\t\t\ti:type="AxFormStringControl">\n` +
      `\t\t\t\t\t\t\t\t\t\t\t\t<Name>Header_${f}</Name>\n` +
      `\t\t\t\t\t\t\t\t\t\t\t\t<Type>String</Type>\n` +
      `\t\t\t\t\t\t\t\t\t\t\t\t<FormControlExtension\n\t\t\t\t\t\t\t\t\t\t\t\t\ti:nil="true" />\n` +
      `\t\t\t\t\t\t\t\t\t\t\t\t<DataField>${f}</DataField>\n` +
      `\t\t\t\t\t\t\t\t\t\t\t\t<DataSource>${dsName}</DataSource>\n` +
      `\t\t\t\t\t\t\t\t\t\t\t</AxFormControl>\n`
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
\t\t<AxFormDataSource xmlns="">
\t\t\t<Name>${linesDsName}</Name>
\t\t\t<Table>${linesDsTable}</Table>
\t\t\t<Fields />
\t\t\t<ReferencedDataSources />
\t\t\t<DataSourceLinks>
\t\t\t\t<AxFormDataSourceLink>
\t\t\t\t\t<LinkType>InnerJoin</LinkType>
\t\t\t\t\t<Table>${dsName}</Table>
\t\t\t\t</AxFormDataSourceLink>
\t\t\t</DataSourceLinks>
\t\t\t<DerivedDataSources />
\t\t</AxFormDataSource>
\t</DataSources>
\t<Design>
${captionXml}\t\t<Pattern xmlns="">DetailsTransaction</Pattern>
\t\t<PatternVersion xmlns="">1.1</PatternVersion>
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
\t\t\t\t\ti:type="AxFormTabControl">
\t\t\t\t<Name>Tab</Name>
\t\t\t\t<Type>Tab</Type>
\t\t\t\t<FormControlExtension
\t\t\t\t\ti:nil="true" />
\t\t\t\t<Controls>
\t\t\t\t\t<AxFormControl xmlns=""
\t\t\t\t\t\t\ti:type="AxFormTabPageControl">
\t\t\t\t\t\t<Name>TabPageHeader</Name>
\t\t\t\t\t\t<Pattern>FieldsFieldGroups</Pattern>
\t\t\t\t\t\t<PatternVersion>1.1</PatternVersion>
\t\t\t\t\t\t<Type>TabPage</Type>
\t\t\t\t\t\t<Caption>Header</Caption>
\t\t\t\t\t\t<FormControlExtension
\t\t\t\t\t\t\ti:nil="true" />
\t\t\t\t\t\t<Controls>
\t\t\t\t\t\t\t<AxFormControl xmlns=""
\t\t\t\t\t\t\t\t\ti:type="AxFormGroupControl">
\t\t\t\t\t\t\t\t<Name>HeaderGeneralGroup</Name>
\t\t\t\t\t\t\t\t<Pattern>FieldsFieldGroups</Pattern>
\t\t\t\t\t\t\t\t<PatternVersion>1.1</PatternVersion>
\t\t\t\t\t\t\t\t<Type>Group</Type>
\t\t\t\t\t\t\t\t<Caption>General</Caption>
\t\t\t\t\t\t\t\t<DataGroup>Overview</DataGroup>
\t\t\t\t\t\t\t\t<FormControlExtension
\t\t\t\t\t\t\t\t\ti:nil="true" />
\t\t\t\t\t\t\t\t<Controls>
${headerFieldControls}\t\t\t\t\t\t\t\t</Controls>
\t\t\t\t\t\t\t</AxFormControl>
\t\t\t\t\t\t</Controls>
\t\t\t\t\t</AxFormControl>
\t\t\t\t\t<AxFormControl xmlns=""
\t\t\t\t\t\t\ti:type="AxFormTabPageControl">
\t\t\t\t\t\t<Name>TabPageLines</Name>
\t\t\t\t\t\t<Type>TabPage</Type>
\t\t\t\t\t\t<Caption>Lines</Caption>
\t\t\t\t\t\t<FormControlExtension
\t\t\t\t\t\t\ti:nil="true" />
\t\t\t\t\t\t<Controls>
\t\t\t\t\t\t\t<AxFormControl xmlns=""
\t\t\t\t\t\t\t\t\ti:type="AxFormActionPaneTabControl">
\t\t\t\t\t\t\t\t<Name>LinesActionPane</Name>
\t\t\t\t\t\t\t\t<Type>ActionPaneTab</Type>
\t\t\t\t\t\t\t\t<FormControlExtension
\t\t\t\t\t\t\t\t\ti:nil="true" />
\t\t\t\t\t\t\t\t<Controls>
\t\t\t\t\t\t\t\t\t<AxFormControl xmlns=""
\t\t\t\t\t\t\t\t\t\t\ti:type="AxFormButtonGroupControl">
\t\t\t\t\t\t\t\t\t\t<Name>LinesButtonGroup</Name>
\t\t\t\t\t\t\t\t\t\t<Type>ButtonGroup</Type>
\t\t\t\t\t\t\t\t\t\t<FormControlExtension
\t\t\t\t\t\t\t\t\t\t\ti:nil="true" />
\t\t\t\t\t\t\t\t\t\t<Controls />
\t\t\t\t\t\t\t\t\t\t<ArrangeMethod>Vertical</ArrangeMethod>
\t\t\t\t\t\t\t\t\t</AxFormControl>
\t\t\t\t\t\t\t\t</Controls>
\t\t\t\t\t\t\t</AxFormControl>
\t\t\t\t\t\t\t<AxFormControl xmlns=""
\t\t\t\t\t\t\t\t\ti:type="AxFormGridControl">
\t\t\t\t\t\t\t\t<Name>LinesGrid</Name>
\t\t\t\t\t\t\t\t<Type>Grid</Type>
\t\t\t\t\t\t\t\t<FormControlExtension
\t\t\t\t\t\t\t\t\ti:nil="true" />
\t\t\t\t\t\t\t\t<Controls />
\t\t\t\t\t\t\t\t<DataSource>${linesDsName}</DataSource>
\t\t\t\t\t\t\t\t<DataGroup>Overview</DataGroup>
\t\t\t\t\t\t\t\t<Style>Tabular</Style>
\t\t\t\t\t\t\t</AxFormControl>
\t\t\t\t\t\t</Controls>
\t\t\t\t\t</AxFormControl>
\t\t\t\t</Controls>
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
\t\t\t\t<Pattern>FieldsFieldGroups</Pattern>
\t\t\t\t<PatternVersion>1.1</PatternVersion>
\t\t\t\t<Type>Group</Type>
\t\t\t\t<FormControlExtension
\t\t\t\t\ti:nil="true" />
\t\t\t\t<Controls>
${bodyContent}\t\t\t\t</Controls>
\t\t\t\t<Style>DialogContent</Style>
\t\t\t</AxFormControl>
\t\t\t<AxFormControl xmlns=""
\t\t\t\t\ti:type="AxFormButtonGroupControl">
\t\t\t\t<Name>ButtonGroup</Name>
\t\t\t\t<Type>ButtonGroup</Type>
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
    const { formName, dsName, dsTable, caption, sections = [] } = opt;
    const captionXml = caption
      ? `\t\t<Caption xmlns="">${caption}</Caption>\n`
      : '';

    const effectiveSections = sections.length > 0
      ? sections
      : [
          { name: 'TabPageGeneral',  caption: 'General' },
          { name: 'TabPageSetup',    caption: 'Setup' },
        ];

    const tabPageControls = effectiveSections.map(s =>
      `\t\t\t\t<AxFormControl xmlns=""\n` +
      `\t\t\t\t\t\ti:type="AxFormTabPageControl">\n` +
      `\t\t\t\t\t<Name>${s.name}</Name>\n` +
      `\t\t\t\t\t<Pattern>FieldsFieldGroups</Pattern>\n` +
      `\t\t\t\t\t<PatternVersion>1.1</PatternVersion>\n` +
      `\t\t\t\t\t<Type>TabPage</Type>\n` +
      `\t\t\t\t\t<Caption>${s.caption}</Caption>\n` +
      `\t\t\t\t\t<FrameType>None</FrameType>\n` +
      `\t\t\t\t\t<FormControlExtension\n\t\t\t\t\t\ti:nil="true" />\n` +
      `\t\t\t\t\t<Controls />\n` +
      `\t\t\t\t</AxFormControl>\n`
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
${captionXml}\t\t<Pattern xmlns="">TableOfContents</Pattern>
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
\t\t\t\t<Style>TOCList</Style>
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
\t\t\t<DataSourceLinks />
\t\t\t<DerivedDataSources />
\t\t</AxFormDataSource>
\t</DataSources>
\t<Design>
${captionXml}\t\t<Pattern xmlns="">Lookup</Pattern>
\t\t<PatternVersion xmlns="">1.2</PatternVersion>
\t\t<Style xmlns="">Lookup</Style>
\t\t<Controls xmlns="">
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
\t\t<PatternVersion xmlns="">1.1</PatternVersion>
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
      `\t\t\t\t\t\t<Caption>${sec.caption}</Caption>\n` +
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
      `\t\t\t\t\t\t\t\t<Controls />\n` +
      `\t\t\t\t\t\t\t\t<ArrangeMethod>HorizontalLeft</ArrangeMethod>\n` +
      `\t\t\t\t\t\t\t\t<FrameType>None</FrameType>\n` +
      `\t\t\t\t\t\t\t\t<Style>CustomFilter</Style>\n` +
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
      `\t\t\t\t\t\t<FrameType>None</FrameType>\n` +
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
${captionXml}\t\t<Pattern xmlns="">Workspace</Pattern>
\t\t<PatternVersion xmlns="">1.0</PatternVersion>
\t\t<Style xmlns="">Workspace</Style>
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
\t\t\t\t<ElementPosition>268435455</ElementPosition>
\t\t\t\t<Type>Tab</Type>
\t\t\t\t<WidthMode>SizeToAvailable</WidthMode>
\t\t\t\t<HeightMode>SizeToAvailable</HeightMode>
\t\t\t\t<FormControlExtension
\t\t\t\t\ti:nil="true" />
\t\t\t\t<Controls>
\t\t\t\t\t<AxFormControl xmlns=""
\t\t\t\t\t\t\ti:type="AxFormTabPageControl">
\t\t\t\t\t\t<Name>SummarySection</Name>
\t\t\t\t\t\t<Caption>Summary</Caption>
\t\t\t\t\t\t<ElementPosition>536870911</ElementPosition>
\t\t\t\t\t\t<Type>TabPage</Type>
\t\t\t\t\t\t<FormControlExtension
\t\t\t\t\t\t\ti:nil="true" />
\t\t\t\t\t\t<Controls>
\t\t\t\t\t\t\t<AxFormControl xmlns=""
\t\t\t\t\t\t\t\t\ti:type="AxFormGroupControl">
\t\t\t\t\t\t\t\t<Name>TileSection</Name>
\t\t\t\t\t\t\t\t<Pattern>Workspace_SummaryNumbers_UnboundFields</Pattern>
\t\t\t\t\t\t\t\t<PatternVersion>1.0</PatternVersion>
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
\t\t\t\t\t\t\t\t<Style>TileSection</Style>
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
\t\t\t\t\t\t<FrameType>None</FrameType>
\t\t\t\t\t</AxFormControl>
${listSections}\t\t\t\t</Controls>
\t\t\t\t<AlignChild>No</AlignChild>
\t\t\t\t<ShowTabs>No</ShowTabs>
\t\t\t\t<Style>Panorama</Style>
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
