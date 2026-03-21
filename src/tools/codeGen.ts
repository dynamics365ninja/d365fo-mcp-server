/**
 * X++ Code Generation Tool
 * Generate X++ code templates for common patterns
 */

import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { resolveObjectPrefix, applyObjectPrefix, deriveExtensionInfix } from '../utils/modelClassifier.js';
import { getConfigManager } from '../utils/configManager.js';

const CodeGenArgsSchema = z.object({
  pattern: z
    .enum(['class', 'runnable', 'form-handler', 'data-entity', 'batch-job', 'table-extension',
           'sysoperation', 'event-handler', 'security-privilege', 'menu-item', 'class-extension',
           'ssrs-report-full', 'lookup-form',
           'dialog-box', 'dimension-controller', 'number-seq-handler',
           'display-menu-controller', 'data-entity-staging', 'service-class-ais',
           'form-datasource-extension', 'form-control-extension', 'map-extension'])
    .describe('Code pattern to generate'),
  name: z.string().describe(
    'For NEW objects (class, runnable, data-entity, batch-job, sysoperation): the object name WITHOUT prefix — prefix is auto-applied from EXTENSION_PREFIX env var or modelName. ' +
    'For EXTENSIONS (table-extension, form-handler, class-extension, map-extension): the BASE element name to extend (e.g. "CustTable", "SalesTable"). ' +
    'For form-datasource-extension and form-control-extension: the FORM name (e.g. "CustTable"). ' +
    'For XML patterns (security-privilege, menu-item): the name for the generated XML object.'
  ),
  modelName: z.string().optional().describe(
    'Actual model name from .mcp.json — used to derive the naming infix when EXTENSION_PREFIX env var is not set (e.g. "ContosoExt", "WHSExt", "ApplicationSuite"). ' +
    'Required for extension patterns when EXTENSION_PREFIX is not configured. ' +
    'NEVER pass generic placeholders like "MyModel" — always use the real model name from .mcp.json.'
  ),
  menuItemType: z.enum(['display', 'action', 'output']).optional()
    .describe('For menu-item pattern: type of menu item (display=form, action=class, output=report)'),
  baseName: z.string().optional()
    .describe(
      'For event-handler pattern: base class or table name whose events to handle. ' +
      'For form-datasource-extension: data source name within the form (e.g. "CustTable"). Defaults to form name if omitted. ' +
      'For form-control-extension: control name within the form (e.g. "AccountNum", "CustAccount").'
    ),
  targetObject: z.string().optional()
    .describe('For menu-item pattern: target form/class/report name'),
});

// Templates for NEW elements: (name already includes prefix)
const newElementTemplates: Record<string, (name: string) => string> = {
  class: (name) => `
/// <summary>
/// ${name} class
/// </summary>
public class ${name}
{
    public void run()
    {
        // TODO: Implement
    }
}`,

  runnable: (name) => `
/// <summary>
/// Runnable class ${name}
/// </summary>
internal final class ${name}
{
    /// <summary>
    /// Entry point
    /// </summary>
    public static void main(Args _args)
    {
        ${name} instance = new ${name}();
        instance.run();
    }

    /// <summary>
    /// Run method
    /// </summary>
    public void run()
    {
        // TODO: Implement logic
        info(strFmt("Executing %1", classStr(${name})));
    }
}`,

  'data-entity': (name) => `
// ══════════════════════════════════════════════════════════════════
// D365FO Data Entity: ${name}Entity
// ══════════════════════════════════════════════════════════════════
// Data entities are AxDataEntityView XML objects (NOT X++ classes).
// Use create_d365fo_file(objectType="view") or the VS designer.
//
// Key properties to set in XML:
//   PublicEntityName:       "${name}"  (OData singular name)
//   PublicCollectionName:   "${name}s" (OData plural name)
//   IsPublic:               Yes  (expose via OData)
//   DataManagementEnabled:  Yes  (enable DMF import/export)
//   EntityCategory:         Master | Transaction | Document | Reference | Parameter
//   PrimaryKey:             EntityKey (natural key index, NOT RecId)
//
// Datasource config:
//   Root datasource:  ${name} table (IsReadOnly = No for read-write entity)
//   Join datasources: Additional tables via inner/outer joins
//
// Example computed column (for cross-datasource or calculated fields):
//   private static server str computeDisplayName()
//   {
//       return SysComputedColumn::returnField(
//           tableStr(DirPartyTable), identifierStr(Name));
//   }
//
// Workflow:
//   1. get_data_entity_info("similar entity")  → study structure
//   2. generate_d365fo_xml(objectType="data-entity", ...)  → preview XML
//   3. create_d365fo_file(objectType="view", ...)  → create file
//   4. After deployment: refresh entity list in Data Management workspace
`,

  'batch-job': (name) => `
/// <summary>
/// Batch job controller for ${name}
/// </summary>
class ${name}Controller extends SysOperationServiceController
{
    /// <summary>
    /// Entry point
    /// </summary>
    public static void main(Args _args)
    {
        ${name}Controller controller = new ${name}Controller();
        controller.parmArgs(_args);
        controller.parmDialogCaption("${name}");
        controller.startOperation();
    }

    /// <summary>
    /// Constructor — wires up the service class and method.
    /// SysOperationServiceController handles pack/unpack automatically via DataContract.
    /// </summary>
    protected void new()
    {
        super();
        this.parmClassName(classStr(${name}Service));
        this.parmMethodName(methodStr(${name}Service, process));
    }
}

/// <summary>
/// Batch job service for ${name}
/// </summary>
class ${name}Service extends SysOperationServiceBase
{
    /// <summary>
    /// Process batch job
    /// </summary>
    public void process()
    {
        // TODO: Implement batch processing logic
        ttsbegin;

        // Your logic here

        ttscommit;

        info(strFmt("${name} completed successfully"));
    }
}`,
  sysoperation: sysOperationTemplate,
  'ssrs-report-full': ssrsReportFullTemplate,
  'lookup-form': lookupFormTemplate,
  'dialog-box': dialogBoxTemplate,
  'dimension-controller': dimensionControllerTemplate,
  'number-seq-handler': numberSeqHandlerTemplate,
  'display-menu-controller': displayMenuControllerTemplate,
  'data-entity-staging': dataEntityStagingTemplate,
  'service-class-ais': serviceClassAisTemplate,
};

// Templates for EXTENSION elements: (baseName = element being extended, prefix = model/ISV infix)
// Naming rules per https://learn.microsoft.com/en-us/dynamics365/fin-ops-core/dev-itpro/extensibility/naming-guidelines-extensions:
//   table-extension class : {BaseTable}{Prefix}_Extension   (e.g. CustTableWHS_Extension)
//   form-handler class    : {BaseForm}{Prefix}Form_Extension (e.g. SalesTableWHSForm_Extension)

function formHandlerTemplate(baseName: string, prefix: string): string {
  // Class name: {BaseForm}{Prefix}Form_Extension
  const className = baseName + prefix + 'Form_Extension';
  return `
/// <summary>
/// Form extension class for ${baseName} (prefix: ${prefix})
/// Naming: {BaseForm}{Prefix}Form_Extension per MS naming guidelines
/// </summary>
[ExtensionOf(formStr(${baseName}))]
final class ${className}
{
    /// <summary>
    /// Form initialization
    /// </summary>
    public void init()
    {
        next init();
        // TODO: Add custom initialization logic
    }

    /// <summary>
    /// Form close
    /// </summary>
    public void close()
    {
        // TODO: Add cleanup logic
        next close();
    }

    /// <summary>
    /// Data source active event handler
    /// </summary>
    [FormDataSourceEventHandler(formDataSourceStr(${baseName}, DataSourceName), FormDataSourceEventType::Activated)]
    public static void DataSourceName_OnActivated(FormDataSource sender, FormDataSourceEventArgs e)
    {
        // TODO: Handle data source activation
    }
}`;
}

function tableExtensionTemplate(baseName: string, prefix: string): string {
  // Class name: {BaseTable}{Prefix}_Extension
  const className = baseName + prefix + '_Extension';
  return `
/// <summary>
/// Table extension class for ${baseName} (prefix: ${prefix})
/// Naming: {BaseTable}{Prefix}_Extension per MS naming guidelines
/// </summary>
[ExtensionOf(tableStr(${baseName}))]
final class ${className}
{
    /// <summary>
    /// Validate write
    /// </summary>
    public boolean validateWrite()
    {
        boolean ret = next validateWrite();

        // TODO: Add custom validation

        return ret;
    }

    /// <summary>
    /// Insert event
    /// </summary>
    public void insert()
    {
        // TODO: Add pre-insert logic

        next insert();

        // TODO: Add post-insert logic
    }

    /// <summary>
    /// Update event
    /// </summary>
    public void update()
    {
        // TODO: Add pre-update logic

        next update();

        // TODO: Add post-update logic
    }
}`;
}

function classExtensionTemplate(baseName: string, prefix: string): string {
  // Class name: {BaseClass}{Prefix}_Extension per MS naming guidelines
  const className = baseName + prefix + '_Extension';
  return `
/// <summary>
/// Extension class for ${baseName} (prefix: ${prefix})
/// Naming: {BaseClass}{Prefix}_Extension per MS naming guidelines
/// </summary>
[ExtensionOf(classStr(${baseName}))]
final class ${className}
{
    // ⚠️  DO NOT add CoC methods before checking the original signature:
    //     get_method_signature("${baseName}", "methodName")
    //
    // X++ does NOT support method overloading — two methods with the same name
    // will always cause a compile error, even with different signatures.
    //
    // Instance method CoC template:
    //   public ReturnType methodName(ParamType _param)
    //   {
    //       ReturnType result = next methodName(_param);
    //       return result;
    //   }
    //
    // Static method CoC template:
    //   public static ReturnType methodName(ParamType _param)
    //   {
    //       ReturnType result = next methodName(_param);
    //       return result;
    //   }
}`;
}

function formDataSourceExtensionTemplate(formName: string, prefix: string, dataSourceName: string): string {
  // Class name: {FormName}_{DataSourceName}{Prefix}DS_Extension per MS naming guidelines
  const dsName = dataSourceName || formName;
  const className = `${formName}_${dsName}${prefix}DS_Extension`;
  return `
/// <summary>
/// Form data source extension class for ${formName}.${dsName} (prefix: ${prefix})
/// Naming: {FormName}_{DataSourceName}{Prefix}DS_Extension per MS naming guidelines
/// Use this to wrap data source methods (init, executeQuery, write, delete, validateWrite, active).
/// </summary>
[ExtensionOf(formDataSourceStr(${formName}, ${dsName}))]
final class ${className}
{
    /// <summary>
    /// Data source initialization — runs after the form and data source are ready.
    /// Call next init() first to preserve standard behaviour.
    /// </summary>
    public void init()
    {
        next init();
        // TODO: Add custom data source initialization (e.g. add ranges, set filters)
    }

    /// <summary>
    /// Override the query executed when the data source refreshes.
    /// </summary>
    public void executeQuery()
    {
        // TODO: Modify this.query() before calling next, if needed
        next executeQuery();
    }

    /// <summary>
    /// Called when the active (selected) record changes.
    /// </summary>
    public int active()
    {
        int ret = next active();
        // TODO: React to record selection change
        return ret;
    }

    /// <summary>
    /// Write event — runs when a record is saved from the form.
    /// </summary>
    public void write()
    {
        next write();
        // TODO: Add post-save logic
    }

    /// <summary>
    /// Validate write — add custom business rules before save.
    /// </summary>
    public boolean validateWrite()
    {
        boolean ret = next validateWrite();
        // TODO: if (ret) { /* custom validation */ }
        return ret;
    }
}`;
}

function formControlExtensionTemplate(formName: string, prefix: string, controlName: string): string {
  // Class name: {FormName}_{ControlName}{Prefix}Ctrl_Extension per MS naming guidelines
  const ctrlName = controlName || 'ControlName';
  const className = `${formName}_${ctrlName}${prefix}Ctrl_Extension`;
  return `
/// <summary>
/// Form control extension class for ${formName}.${ctrlName} (prefix: ${prefix})
/// Naming: {FormName}_{ControlName}{Prefix}Ctrl_Extension per MS naming guidelines
/// Use this to wrap a specific control's methods (modified, validate, lookup, gotFocus, …).
/// IMPORTANT: Use get_form_info("${formName}", searchControl="${ctrlName}") first to verify the exact control name.
/// </summary>
[ExtensionOf(formControlStr(${formName}, ${ctrlName}))]
final class ${className}
{
    /// <summary>
    /// Fires when the control value is changed by the user.
    /// </summary>
    public void modified()
    {
        next modified();
        // TODO: Add logic that reacts to the new value
        //       e.g. filter another field, refresh a data source, trigger a calculation
    }

    /// <summary>
    /// Validate the control value before save.
    /// Return false + error() to block saving.
    /// </summary>
    public boolean validate()
    {
        boolean ret = next validate();

        // TODO: if (ret) { str val = this.valueStr(); /* validate */ }

        return ret;
    }

    /// <summary>
    /// Override the lookup drop-down for this control.
    /// Use SysTableLookup or a custom query.
    /// </summary>
    public void lookup()
    {
        // TODO: Replace with custom lookup, or call next lookup() for standard behaviour
        next lookup();
    }
}`;
}

function mapExtensionTemplate(baseName: string, prefix: string): string {
  // Class name: {MapName}{Prefix}_Extension per MS naming guidelines
  const className = `${baseName}${prefix}_Extension`;
  return `
/// <summary>
/// Map extension class for ${baseName} (prefix: ${prefix})
/// Naming: {MapName}{Prefix}_Extension per MS naming guidelines
/// Use this to add or wrap methods on an X++ Map (InventItemOrdered, LogisticsPostalAddress, …).
/// </summary>
[ExtensionOf(mapStr(${baseName}))]
final class ${className}
{
    // ⚠️  Always call get_method_signature("${baseName}", "methodName") before adding a CoC method.
    //     X++ does NOT support method overloading — duplicate method names always cause compile errors.
    //
    // Instance CoC example:
    //   public str myMethod(str _param)
    //   {
    //       str ret = next myMethod(_param);
    //       // Custom logic here
    //       return ret;
    //   }
    //
    // New helper method (no next required — purely additive):
    //   public str myNewHelper()
    //   {
    //       return this.SomeMapField;
    //   }
}`;
}

const extensionTemplates: Record<string, (baseName: string, prefix: string) => string> = {
  'form-handler': formHandlerTemplate,
  'table-extension': tableExtensionTemplate,
  'event-handler': eventHandlerTemplate,
  'class-extension': classExtensionTemplate,
  'map-extension': mapExtensionTemplate,
};

// ── SysOperation pattern (3 classes: DataContract + Controller + Service) ──
function sysOperationTemplate(name: string): string {
  return `
// ── 1. DataContract ─────────────────────────────────────────────────────
[DataContractAttribute]
public final class ${name}DataContract
{
    TransDate   transDate;

    [DataMemberAttribute('TransDate'),
     SysOperationLabelAttribute(literalStr("Transaction date"))]
    public TransDate parmTransDate(TransDate _transDate = transDate)
    {
        transDate = _transDate;
        return transDate;
    }
}

// ── 2. Controller ────────────────────────────────────────────────────────
class ${name}Controller extends SysOperationServiceController
{
    protected ClassDescription defaultCaption()
    {
        return "${name}";
    }

    public static void main(Args _args)
    {
        ${name}Controller controller = new ${name}Controller(
            classStr(${name}Service),
            methodStr(${name}Service, process${name}),
            SysOperationExecutionMode::Synchronous);
        controller.startOperation();
    }
}

// ── 3. Service ───────────────────────────────────────────────────────────
class ${name}Service extends SysOperationServiceBase
{
    [SysEntryPointAttribute(true)]
    public void process${name}(${name}DataContract _contract)
    {
        TransDate transDate = _contract.parmTransDate();

        // TODO: Implement business logic
        ttsbegin;

        ttscommit;
    }
}`;
}

// ── Event handler pattern (class with SubscribesTo handlers) ─────────────
function eventHandlerTemplate(baseName: string, _prefix: string): string {
  return `
/// <summary>
/// Event handler class for ${baseName} data events.
/// Uses [DataEventHandler] for standard table events (onInserted, onValidatedWrite, etc.).
/// For custom delegates, use [SubscribesTo(tableStr(X), delegateStr(X, myDelegate))] instead.
/// </summary>
public final class ${baseName}EventHandler
{
    /// <summary>
    /// Handles the onInserted data event of ${baseName}.
    /// </summary>
    [DataEventHandler(tableStr(${baseName}), DataEventType::Inserted)]
    public static void ${baseName}_onInserted(Common _sender, DataEventArgs _e)
    {
        ${baseName} record = _sender;

        // TODO: Add event handling logic
    }

    /// <summary>
    /// Handles the onValidatedWrite data event of ${baseName}.
    /// </summary>
    [DataEventHandler(tableStr(${baseName}), DataEventType::ValidatedWrite)]
    public static void ${baseName}_onValidatedWrite(Common _sender, DataEventArgs _e)
    {
        ${baseName} record = _sender;
        ValidateEventArgs validateArgs = _e;
        boolean result = validateArgs.parmValidateResult();

        if (result)
        {
            // TODO: Add validation logic
        }

        validateArgs.parmValidateResult(result);
    }
}`;
}

// ── Security privilege XML pattern ──────────────────────────────────────
function securityPrivilegeXmlTemplate(name: string, targetMenuItemName: string): string {
  const viewName = name.endsWith('View') ? name : `${name}View`;
  const maintainName = name.endsWith('Maintain') ? name : `${name}Maintain`;
  // File 1: ViewName.xml
  const viewXml = `<?xml version="1.0" encoding="utf-8"?>
<AxSecurityPrivilege xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
\t<Name>${viewName}</Name>
\t<Label>@TODO:LabelId_View</Label>
\t<DataEntityPermissions />
\t<DirectAccessPermissions />
\t<EntryPoints>
\t\t<AxSecurityEntryPointReference>
\t\t\t<Name>${targetMenuItemName}</Name>
\t\t\t<Grant>
\t\t\t\t<Read>Allow</Read>
\t\t\t</Grant>
\t\t\t<ObjectName>${targetMenuItemName}</ObjectName>
\t\t\t<ObjectType>MenuItemDisplay</ObjectType>
\t\t\t<Forms />
\t\t</AxSecurityEntryPointReference>
\t</EntryPoints>
\t<FormControlOverrides />
</AxSecurityPrivilege>`;
  // File 2: MaintainName.xml
  const maintainXml = `<?xml version="1.0" encoding="utf-8"?>
<AxSecurityPrivilege xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
\t<Name>${maintainName}</Name>
\t<Label>@TODO:LabelId_Maintain</Label>
\t<DataEntityPermissions />
\t<DirectAccessPermissions />
\t<EntryPoints>
\t\t<AxSecurityEntryPointReference>
\t\t\t<Name>${targetMenuItemName}</Name>
\t\t\t<Grant>
\t\t\t\t<Read>Allow</Read>
\t\t\t\t<Update>Allow</Update>
\t\t\t\t<Create>Allow</Create>
\t\t\t\t<Delete>Allow</Delete>
\t\t\t</Grant>
\t\t\t<ObjectName>${targetMenuItemName}</ObjectName>
\t\t\t<ObjectType>MenuItemDisplay</ObjectType>
\t\t\t<Forms />
\t\t</AxSecurityEntryPointReference>
\t</EntryPoints>
\t<FormControlOverrides />
</AxSecurityPrivilege>`;
  return `<!-- FILE 1: ${viewName}.xml (Read access) -->\n${viewXml}\n\n<!-- FILE 2: ${maintainName}.xml (Update/Create/Delete access) -->\n${maintainXml}`;
}

// ── Menu item XML pattern ────────────────────────────────────────────────
function menuItemXmlTemplate(name: string, itemType: string, targetObject: string): string {
  const elemName = itemType === 'action' ? 'AxMenuItemAction'
    : itemType === 'output' ? 'AxMenuItemOutput'
    : 'AxMenuItemDisplay';
  // ObjectType rules (from real D365FO XML files):
  //   action  → always "Class"
  //   output  → "Class" (default for controller pattern) or "SSRSReport"; never "Report"
  //   display → OMIT when targeting a Form (implicit default); use "Class" for analytics/class targets
  let objectTypeXml: string;
  if (itemType === 'action') {
    objectTypeXml = '\n\t<ObjectType>Class</ObjectType>';
  } else if (itemType === 'output') {
    objectTypeXml = '\n\t<ObjectType>Class</ObjectType>';
  } else {
    // display — omit ObjectType (targets a form by default)
    objectTypeXml = '';
  }
  return `<?xml version="1.0" encoding="utf-8"?>
<${elemName} xmlns:i="http://www.w3.org/2001/XMLSchema-instance" xmlns="Microsoft.Dynamics.AX.Metadata.V1">
\t<Name>${name}</Name>
\t<Label>@TODO:LabelId</Label>
\t<Object>${targetObject}</Object>${objectTypeXml}
</${elemName}>`;
}

// ── SSRS Report Full pattern (DataContract + DP + Controller + TmpTable note) ─
function ssrsReportFullTemplate(name: string): string {
  return `// ══════════════════════════════════════════════════════════════════
// SSRS Report: ${name}
// 5 objects required (use create_d365fo_file for each):
//   1. ${name}TmpTable  — TempDB table (objectType="table", tableType="TempDB")
//   2. ${name}Contract  — DataContract class (below)
//   3. ${name}DP        — Data Provider class (below)
//   4. ${name}Controller — Report controller (below)
//   5. ${name}.xml      — AxReport with RDL design (use generate_smart_report)
// ══════════════════════════════════════════════════════════════════

// ── 1. DataContract ─────────────────────────────────────────────────────────
[DataContractAttribute]
public final class ${name}Contract
{
    FromDate    fromDate;
    ToDate      toDate;

    [DataMemberAttribute('FromDate'),
     SysOperationLabelAttribute(literalStr("From date"))]
    public FromDate parmFromDate(FromDate _fromDate = fromDate)
    {
        fromDate = _fromDate;
        return fromDate;
    }

    [DataMemberAttribute('ToDate'),
     SysOperationLabelAttribute(literalStr("To date"))]
    public ToDate parmToDate(ToDate _toDate = toDate)
    {
        toDate = _toDate;
        return toDate;
    }
}

// ── 2. Data Provider ────────────────────────────────────────────────────────
[SRSReportParameterAttribute(classStr(${name}Contract))]
public class ${name}DP extends SRSReportDataProviderBase
{
    ${name}TmpTable tmpTable;

    [SRSReportDataSetAttribute(tableStr(${name}TmpTable))]
    public ${name}TmpTable get${name}TmpTable()
    {
        select * from tmpTable;
        return tmpTable;
    }

    public void processReport()
    {
        ${name}Contract contract = this.parmDataContract() as ${name}Contract;
        // ✅ Assign filter values to variables before using in WHERE
        FromDate fromDate = contract.parmFromDate();
        ToDate   toDate   = contract.parmToDate();

        delete_from tmpTable;

        insert_recordset tmpTable (Field1, Field2)
            select Field1, Field2
            from SourceTable
            where SourceTable.TransDate >= fromDate
               && SourceTable.TransDate <= toDate;
    }
}

// ── 3. Controller ────────────────────────────────────────────────────────────
public class ${name}Controller extends SrsReportRunController
{
    public static void main(Args _args)
    {
        ${name}Controller controller = new ${name}Controller();
        controller.parmReportName(ssrsReportStr(${name}, Design));
        controller.parmArgs(_args);
        controller.startOperation();
    }

    protected void preRunModifyContract()
    {
        super();
        // Modify contract defaults here if needed
    }
}`;
}

// ── SysTableLookup pattern ─────────────────────────────────────────────────
function lookupFormTemplate(name: string): string {
  return `/// <summary>
/// Lookup for ${name} field.
/// Shows records from ${name} table with a filtered list.
/// Call this method from the field's lookup() override or a form extension.
/// </summary>
/// <param name="_formControl">The form string control that triggered the lookup.</param>
public static void lookup${name}(FormStringControl _formControl)
{
    SysTableLookup sysTableLookup = SysTableLookup::newParameters(
        tableNum(${name}),
        _formControl);

    // Add fields to display in the lookup grid
    sysTableLookup.addLookupfield(fieldNum(${name}, Id));      // key field first
    sysTableLookup.addLookupfield(fieldNum(${name}, Name));    // descriptive field

    // Optional: add a filter range
    // Query         query = new Query();
    // QueryBuildDataSource qbds = query.addDataSource(tableNum(${name}));
    // SysQuery::findOrCreateRange(qbds, fieldNum(${name}, Active)).value('1');
    // sysTableLookup.parmQuery(query);

    sysTableLookup.performFormLookup();
}`;
}

// ── Dialog Box pattern ─────────────────────────────────────────────────────
function dialogBoxTemplate(name: string): string {
  return `/// <summary>
/// Dialog for ${name}. Uses D365FO Dialog API without a dedicated form.
/// Call ${name}Dialog::prompt() to show the dialog and retrieve user input.
/// </summary>
public class ${name}Dialog
{
    private Dialog          dialog;
    private DialogField     dlgField1;
    private DialogField     dlgField2;

    // ── Constructor ─────────────────────────────────────────────────────
    private void new()
    {
    }

    public static ${name}Dialog construct()
    {
        ${name}Dialog d = new ${name}Dialog();
        d.initDialog();
        return d;
    }

    private void initDialog()
    {
        dialog = new Dialog("@MyModel:${name}DialogCaption");
        dialog.addText("@MyModel:${name}DialogDescription");

        // Add fields — use EDT names for automatic lookup/validation
        dlgField1 = dialog.addField(extendedTypeStr(TransDate), "@MyModel:DateLabel");
        dlgField2 = dialog.addField(extendedTypeStr(Description), "@MyModel:DescriptionLabel");

        // Set defaults
        dlgField1.value(systemDateGet());
    }

    /// <summary>
    /// Shows the dialog. Returns true if the user clicked OK.
    /// </summary>
    public boolean prompt()
    {
        return dialog.run();
    }

    /// <summary>Gets the date the user selected.</summary>
    public TransDate parmDate()
    {
        return dlgField1.value();
    }

    /// <summary>Gets the description the user entered.</summary>
    public Description parmDescription()
    {
        return dlgField2.value();
    }

    /// <summary>
    /// Convenience method: show dialog and return true if user confirmed.
    /// </summary>
    public static boolean run${name}(TransDate _date, Description _desc)
    {
        ${name}Dialog d = ${name}Dialog::construct();
        if (d.prompt())
        {
            // Process d.parmDate() / d.parmDescription()
            return true;
        }
        return false;
    }
}`;
}

// ── DimensionDefaultingController pattern ─────────────────────────────────
function dimensionControllerTemplate(name: string): string {
  return `/// <summary>
/// Handles financial dimension defaulting for ${name} form.
/// Add this to the form's init() and datasource active() methods.
/// </summary>
public class ${name}DimensionController
{
    private DimensionDefaultingController   dimensionDefaultingController;
    private FormRun                         formRun;
    private ${name}                         callerRecord;

    private void new()
    {
    }

    public static ${name}DimensionController construct(
        FormRun _formRun,
        ${name}  _record)
    {
        ${name}DimensionController ctrl = new ${name}DimensionController();
        ctrl.formRun      = _formRun;
        ctrl.callerRecord = _record;
        ctrl.initController();
        return ctrl;
    }

    private void initController()
    {
        // Create controller bound to the DefaultDimension field on the datasource
        dimensionDefaultingController =
            DimensionDefaultingController::constructInTabWithValues(
                true,                                               // show account
                true,                                              // show dimensions
                0,                                                 // location (0 = auto)
                formRun,
                formDataSourceStr(${name}, DefaultDimension),      // datasource field binding
                formControlStr(${name}Form, DimensionDefaultingControl)); // segment control
    }

    /// <summary>
    /// Call from datasource active() to refresh dimension values when record changes.
    /// </summary>
    public void datasourceActive()
    {
        dimensionDefaultingController.activated();
    }

    /// <summary>
    /// Call from form close() to clean up resources.
    /// </summary>
    public void formClosing()
    {
        dimensionDefaultingController.deleted();
    }
}

// ── Usage in form classDeclaration / init() ──────────────────────────────
// [Form]
// public class ${name}Form extends FormRun
// {
//     ${name}DimensionController dimCtrl;
//
//     public void init()
//     {
//         super();
//         dimCtrl = ${name}DimensionController::construct(this, ${name}_ds.getFirst());
//     }
// }
//
// ── Usage in datasource active() ────────────────────────────────────────
// public int active()
// {
//     int ret = super();
//     dimCtrl.datasourceActive();
//     return ret;
// }`;
}

// ── NumberSeqFormHandler pattern ──────────────────────────────────────────
function numberSeqHandlerTemplate(name: string): string {
  return `/// <summary>
/// Integrates number sequence auto-generation into the ${name} form.
/// This class handles the NumberSequenceFormHandler setup in the form.
/// Add init() call to form init(), and numSeqFormHandler reference to classDeclaration.
/// </summary>
// ── Step 1: Form classDeclaration ───────────────────────────────────────
// [Form]
// public class ${name}Form extends FormRun
// {
//     NumberSequenceFormHandler numSeqFormHandler;
// }

// ── Step 2: Form init() ─────────────────────────────────────────────────
// public void init()
// {
//     super();
//     // Hook number sequence handler to the ${name}Id field
//     numSeqFormHandler = NumberSequenceFormHandler::newForm(
//         ${name}Parameters::numRef${name}Id().NumberSequence,  // number sequence reference
//         element,                                              // FormRun
//         tableNum(${name}),                                    // table
//         fieldNum(${name}, ${name}Id));                        // field to fill
// }

// ── Step 3: datasource create() override ────────────────────────────────
// public void create(boolean _append = false)
// {
//     super(_append);
//     numSeqFormHandler.formMethodDataSourceCreatePre();
// }
// public void write()
// {
//     super();
//     numSeqFormHandler.formMethodDataSourceWrite();
// }
// public void delete()
// {
//     super();
//     numSeqFormHandler.formMethodDataSourceDelete();
// }

// ── Step 4: NumberSeqApplicationModule extension (loadModule CoC) ────────
/// <summary>
/// Extends NumberSeqApplicationModule to register the ${name}Id number sequence reference.
/// Apply CoC on NumberSeqApplicationModule.loadModule() in your model.
/// </summary>
[ExtensionOf(classStr(NumberSeqApplicationModule${name}))]
final class NumberSeqApplicationModule${name}_Extension
{
    public void loadModule()
    {
        next loadModule();

        // Add number sequence scope for ${name}Id
        NumberSeqScopeFactory scopeFactory;
        NumberSeqScope        scope = NumberSeqScopeFactory::createDataAreaScope();

        NumberSeqReference numSeqRef;
        numSeqRef.AllowManual         = NoYes::Yes;
        numSeqRef.Continuous          = NoYes::No;
        numSeqRef.DataTypeId          = extendedTypeNum(${name}Id);
        numSeqRef.NumberSequenceModule = extendedTypeNum(${name}Id); // use your module enum

        this.addModuleEntry(numSeqRef, scope, true, "${name} identifier");
    }
}

// ── Step 5: CompanyInfo.numRef${name}Id() static method via CoC ──────────
[ExtensionOf(tableStr(CompanyInfo))]
final class CompanyInfo_${name}_Extension
{
    /// <summary>Gets the number sequence reference for ${name}Id.</summary>
    public static NumberSequenceReference numRef${name}Id()
    {
        return NumberSeqReference::findReference(extendedTypeNum(${name}Id));
    }
}`;
}

// ── Display Menu Controller pattern ──────────────────────────────────────
function displayMenuControllerTemplate(name: string): string {
  return `/// <summary>
/// Menu controller for ${name}. Handles Args-based routing when a menu item
/// points to this class instead of directly to a form or report.
/// </summary>
public class ${name}Controller extends MenuFunction
{
    Args    args;
    MenuFunction menuFunction;

    /// <summary>
    /// Entry point — called by the menu item.
    /// </summary>
    public static void main(Args _args)
    {
        ${name}Controller controller = new ${name}Controller();
        controller.args = _args;
        controller.run();
    }

    private void run()
    {
        // Determine which form/report to open based on caller context
        FormName targetForm;

        // Example: route based on record type or calling context
        if (args && args.record() && args.record().TableId == tableNum(SalesTable))
        {
            targetForm = formStr(SalesTable);
        }
        else
        {
            targetForm = formStr(${name}Form);
        }

        menuFunction = new MenuFunction(targetForm, MenuItemType::Display);
        menuFunction.run(args);
    }

    /// <summary>
    /// Override canRun() to control when this menu item is available.
    /// </summary>
    public boolean canRun(Args _args)
    {
        // Return false to disable the menu item in certain contexts
        if (!_args || !_args.record())
        {
            return false;
        }
        return true;
    }
}`;
}

// ── Data Entity with Staging (DMF import) pattern ─────────────────────────
function dataEntityStagingTemplate(name: string): string {
  return `// ══════════════════════════════════════════════════════════════════════════
// Data Entity with Staging Table: ${name}
// 3 objects required (use create_d365fo_file for each):
//   1. ${name}StagingTable  — TempDB staging table
//   2. ${name}Entity        — Data entity (AxDataEntityView)
//   3. ${name}EntityService — Optional: AIF service class
// ══════════════════════════════════════════════════════════════════════════

// ── Object 1: Staging table ${name}Staging ─────────────────────────────────
// create_d365fo_file(objectType="table", objectName="${name}Staging", xmlContent=...)
// Set: TableType=TempDB (NOT RegularTable), TableGroup=Main
// Fields mirror the entity's public fields exactly (same names, same EDTs)

// ── Object 2: Data entity ${name}Entity ──────────────────────────────────
// AxDataEntityView XML — key properties:
//   <IsPublic>Yes</IsPublic>
//   <PublicEntityName>${name}</PublicEntityName>
//   <PublicCollectionName>${name}s</PublicCollectionName>
//   <StagingTable>${name}Staging</StagingTable>
//   <DataManagementEnabled>Yes</DataManagementEnabled>
//   <DataManagementStagingTable>${name}Staging</DataManagementStagingTable>

// ── Object 3: Entity class (copyCustomStagingToTarget override) ───────────
/// <summary>
/// ${name} data entity. Handles DMF import via staging table.
/// </summary>
public class ${name}EntityClass extends DMFEntityBase
{
    /// <summary>
    /// Maps staging table records to the target table during DMF import.
    /// Called for each staging record after validation.
    /// </summary>
    public boolean copyCustomStagingToTarget(DMFDefinitionGroupExecution _dmfDefinitionGroupExecution)
    {
        ${name}Staging  staging;
        ${name}          target;
        boolean          ret = true;

        // Process each staging record
        while select staging
            where staging.DefinitionGroup == _dmfDefinitionGroupExecution.DefinitionGroup
               && staging.ExecutionId      == _dmfDefinitionGroupExecution.ExecutionId
               && staging.TransferStatus   == DMFTransferStatus::NotStarted
        {
            try
            {
                ttsbegin;

                // Map staging → target
                target.clear();
                target.initValue();
                target.${name}Id   = staging.${name}Id;
                target.Description = staging.Description;
                // ... map remaining fields

                if (!target.validateWrite())
                {
                    staging.TransferStatus = DMFTransferStatus::Error;
                }
                else
                {
                    target.write();
                    staging.TransferStatus = DMFTransferStatus::Completed;
                }

                staging.update();
                ttscommit;
            }
            catch (Exception::UpdateConflict)
            {
                if (appl.ttsLevel() == 0)
                {
                    retry;
                }
                staging.TransferStatus = DMFTransferStatus::Error;
                staging.update();
            }
        }
        return ret;
    }
}`;
}

// ── AIF/OData Service class pattern ──────────────────────────────────────
function serviceClassAisTemplate(name: string): string {
  return `/// <summary>
/// OData/AIF service class for ${name}.
/// Exposes CRUD operations consumable via OData v4 (D365FO standard endpoint).
/// Register in Services node of the model's AxService XML.
/// </summary>
public class ${name}Service
{
    /// <summary>
    /// Creates a new ${name} record.
    /// </summary>
    [SysEntryPointAttribute(true)]
    public ${name}Id create(${name}Contract _contract)
    {
        ${name} record;

        ttsbegin;
        record.initValue();
        record.${name}Id   = _contract.parm${name}Id();
        record.Description = _contract.parmDescription();

        if (!record.validateWrite())
        {
            throw error("@MyModel:ValidationFailed");
        }
        record.insert();
        ttscommit;

        return record.${name}Id;
    }

    /// <summary>
    /// Updates an existing ${name} record.
    /// </summary>
    [SysEntryPointAttribute(true)]
    public void update(${name}Contract _contract)
    {
        ${name} record;
        ${name}Id recordId = _contract.parm${name}Id();

        select forupdate record
            where record.${name}Id == recordId;

        if (!record.RecId)
        {
            throw error(strFmt("@SYS23771", recordId));  // "Record %1 not found"
        }

        ttsbegin;
        record.Description = _contract.parmDescription();
        record.update();
        ttscommit;
    }

    /// <summary>
    /// Deletes a ${name} record.
    /// </summary>
    [SysEntryPointAttribute(true)]
    public void delete(${name}Id _id)
    {
        ${name} record;

        select forupdate record
            where record.${name}Id == _id;

        if (record.RecId)
        {
            ttsbegin;
            record.delete();
            ttscommit;
        }
    }

    /// <summary>
    /// Reads a ${name} record and returns a contract.
    /// </summary>
    [SysEntryPointAttribute(false)]
    public ${name}Contract read(${name}Id _id)
    {
        ${name}          record = ${name}::find(_id);
        ${name}Contract  contract = new ${name}Contract();

        if (!record.RecId)
        {
            throw error(strFmt("@SYS23771", _id));
        }

        contract.parm${name}Id(record.${name}Id);
        contract.parmDescription(record.Description);
        return contract;
    }
}

// ── Contract class for the service ─────────────────────────────────────────
/// <summary>
/// Data contract for ${name} service operations.
/// </summary>
[DataContractAttribute]
public class ${name}Contract
{
    private ${name}Id   ${name}Id;
    private Description description;

    [DataMemberAttribute('${name}Id')]
    public ${name}Id parm${name}Id(${name}Id _v = ${name}Id)
    {
        ${name}Id = _v;
        return ${name}Id;
    }

    [DataMemberAttribute('Description')]
    public Description parmDescription(Description _v = description)
    {
        description = _v;
        return description;
    }
}`;
}

const EXTENSION_PATTERNS = new Set([
  'table-extension', 'form-handler', 'event-handler', 'class-extension', 'map-extension',
  'form-datasource-extension', 'form-control-extension',
]);
const XML_PATTERNS = new Set(['security-privilege', 'menu-item']);

export async function codeGenTool(request: CallToolRequest) {
  try {
    const args = CodeGenArgsSchema.parse(request.params.arguments);

    // Resolve prefix: EXTENSION_PREFIX env var (stripped of trailing '_') or modelName arg → mcp.json → empty
    const resolvedModelName = args.modelName || getConfigManager().getModelName() || '';
    const prefix = resolveObjectPrefix(resolvedModelName);
    // Extension infix: PascalCase form without underscore (e.g. "XY" → "Xy" when env has "XY_")
    const extensionInfix = deriveExtensionInfix(prefix);

    let code: string;
    let displayName: string;
    let namingNote: string;

    if (XML_PATTERNS.has(args.pattern)) {
      // XML generation patterns (security-privilege, menu-item)
      let xml: string;
      let xmlNote: string;

      if (args.pattern === 'security-privilege') {
        const targetMenuItem = args.targetObject || args.name;
        xml = securityPrivilegeXmlTemplate(args.name, targetMenuItem);
        xmlNote = `📌 Creates two privilege objects: ${args.name}View (Read) and ${args.name}Maintain (Update/Create/Delete)\n` +
          `  Linked to entry point: ${targetMenuItem}\n\n` +
          `💡 Next steps:\n` +
          `1. Replace @TODO:LabelId_View and @TODO:LabelId_Maintain with actual label IDs\n` +
          `2. Create a duty referencing both privileges\n` +
          `3. Assign the duty to an appropriate role`;
      } else {
        // menu-item
        const targetObject = args.targetObject || args.name;
        const itemType = args.menuItemType || 'display';
        xml = menuItemXmlTemplate(args.name, itemType, targetObject);
        xmlNote = `📌 Creates AxMenuItem${itemType === 'action' ? 'Action' : itemType === 'output' ? 'Output' : 'Display'}: ${args.name}\n` +
          `  Target ${itemType === 'action' ? 'class' : itemType === 'output' ? 'report' : 'form'}: ${targetObject}\n\n` +
          `💡 Next steps:\n` +
          `1. Replace @TODO:LabelId with actual label ID\n` +
          `2. Create security privilege referencing this menu item\n` +
          `3. Add menu item to the appropriate menu`;
      }

      return {
        content: [{
          type: 'text',
          text: `Generated ${args.pattern} XML for "${args.name}":\n\n` +
            `\`\`\`xml\n${xml}\n\`\`\`\n\n---\n\n${xmlNote}`,
        }],
      };
    } else if (EXTENSION_PATTERNS.has(args.pattern)) {
      // Extension pattern — args.name is the BASE element; prefix becomes the infix

      // ── form-datasource-extension / form-control-extension (3-param templates) ──
      if (args.pattern === 'form-datasource-extension') {
        const formName = args.name;
        const dsName = args.baseName || args.name;
        code = formDataSourceExtensionTemplate(formName, extensionInfix, dsName);
        displayName = formName;
        const className = `${formName}_${dsName}${extensionInfix}DS_Extension`;
        namingNote = extensionInfix
          ? `📌 **Naming (MS guidelines):** Generated class: \`${className}\`\n  Form: \`${formName}\`, DataSource: \`${dsName}\`, Prefix infix: \`${extensionInfix}\``
          : `⚠️ **No prefix resolved** — pass \`modelName\` or set \`EXTENSION_PREFIX\` env var.\n  Generated bare name: \`${formName}_${dsName}DS_Extension\` (not MS-compliant without infix).`;

      } else if (args.pattern === 'form-control-extension') {
        const formName = args.name;
        const ctrlName = args.baseName || 'ControlName';
        code = formControlExtensionTemplate(formName, extensionInfix, ctrlName);
        displayName = formName;
        const className = `${formName}_${ctrlName}${extensionInfix}Ctrl_Extension`;
        namingNote = extensionInfix
          ? `📌 **Naming (MS guidelines):** Generated class: \`${className}\`\n  Form: \`${formName}\`, Control: \`${ctrlName}\`, Prefix infix: \`${extensionInfix}\``
          : `⚠️ **No prefix resolved** — pass \`modelName\` or set \`EXTENSION_PREFIX\` env var.\n  Generated bare name: \`${formName}_${ctrlName}Ctrl_Extension\` (not MS-compliant without infix).`;

      } else {
        // Generic 2-param extension templates
        const baseName = args.pattern === 'event-handler' ? (args.baseName || args.name) : args.name;
        const extTemplate = extensionTemplates[args.pattern];
        if (!extTemplate) {
          return {
            content: [{ type: 'text', text: `Unknown extension pattern: ${args.pattern}` }],
            isError: true,
          };
        }
        code = extTemplate(baseName, extensionInfix);
        displayName = baseName;

        if (args.pattern === 'event-handler') {
          namingNote = `📌 **Generated class:** \`${baseName}EventHandler\`\n` +
            `  Handles onInserted and onValidatedWrite events of \`${baseName}\`\n` +
            `  Add more handlers by repeating the [SubscribesTo] pattern.`;
        } else if (args.pattern === 'class-extension') {
          const exampleClass = `${baseName}${extensionInfix}_Extension`;
          const namingLine = extensionInfix
            ? `📌 **Naming (MS guidelines):** Generated class: \`${exampleClass}\`\n  Base class: \`${baseName}\`, Prefix infix: \`${extensionInfix}\``
            : `⚠️ **No prefix resolved** — set \`EXTENSION_PREFIX\` env var or pass \`modelName\` argument.\n  Generated bare name without prefix infix (e.g. \`${baseName}_Extension\`) which is **not MS-compliant**.`;
          namingNote = namingLine + '\n\n' +
            `🚨 **REQUIRED before adding CoC methods:**\n` +
            `   Call \`get_method_signature("${baseName}", "methodName")\` for EACH method you want to wrap.\n` +
            `   X++ does NOT support method overloading — adding both \`public boolean foo()\` and \`public static boolean foo()\`\n` +
            `   in the same class will always cause a compile error.\n` +
            `   The signature tool tells you whether the original is \`static\` or instance, so you generate exactly ONE CoC method.`;
        } else {
          const exampleClass =
            args.pattern === 'table-extension'  ? `${baseName}${extensionInfix}_Extension`
            : args.pattern === 'map-extension'  ? `${baseName}${extensionInfix}_Extension`
            : `${baseName}${extensionInfix}Form_Extension`;
          namingNote = extensionInfix
            ? `📌 **Naming (MS guidelines):** Generated class: \`${exampleClass}\`\n  Base element: \`${baseName}\`, Prefix infix: \`${extensionInfix}\``
            : `⚠️ **No prefix resolved** — set \`EXTENSION_PREFIX\` env var or pass \`modelName\` argument.\n  Generated bare name without prefix infix (e.g. \`${baseName}_Extension\`) which is **not MS-compliant**.`;
        }
      }
    } else {
      // New element pattern — apply prefix to the name
      const newTemplate = newElementTemplates[args.pattern];
      if (!newTemplate) {
        return {
          content: [{ type: 'text', text: `Unknown pattern: ${args.pattern}` }],
          isError: true,
        };
      }
      const finalName = applyObjectPrefix(args.name, prefix);
      code = newTemplate(finalName);
      displayName = finalName;
      namingNote = prefix
        ? `📌 **Naming (MS guidelines):** Object name with prefix: \`${finalName}\``
        : `⚠️ **No prefix resolved** — set \`EXTENSION_PREFIX\` env var or pass \`modelName\` to auto-prefix new objects.`;
    }

    return {
      content: [
        {
          type: 'text',
          text:
            `Generated ${args.pattern} template for "${displayName}":\n\n` +
            `\`\`\`xpp${code}\n\`\`\`\n\n` +
            `---\n\n` +
            `${namingNote}\n\n` +
            (args.pattern === 'class-extension'
              ? `💡 **Next Steps (class-extension CoC workflow):**\n\n` +
                `1. 🚨 Use \`get_method_signature("${displayName}", "<methodName>")\` — **REQUIRED** to get the exact signature (static vs instance, return type, parameters) before writing any CoC method\n` +
                `2. ✅ Use \`find_coc_extensions("${displayName}", "<methodName>")\` - See existing CoC wrappers for reference\n` +
                `3. ✅ Use \`suggest_method_implementation("${displayName}", "<methodName>")\` - Get real implementation examples\n` +
                `4. ✅ Use \`get_api_usage_patterns("<ClassName>")\` - See how to use D365FO APIs correctly\n\n` +
                `⚠️ Never guess static vs instance — always use get_method_signature first.`
              : `💡 **Next Steps for Better Code Quality:**\n\n` +
                `1. ✅ Use \`analyze_code_patterns("<scenario>")\` - Learn what D365FO classes are commonly used together\n` +
                `2. ✅ Use \`suggest_method_implementation("${displayName}", "<methodName>")\` - Get real implementation examples\n` +
                `3. ✅ Use \`analyze_class_completeness("${displayName}")\` - Check for missing common methods\n` +
                `4. ✅ Use \`get_api_usage_patterns("<ClassName>")\` - See how to use D365FO APIs correctly\n\n` +
                `These tools provide patterns from the actual codebase, not generic templates.`),
        },
      ],
    };
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `Error generating code: ${error instanceof Error ? error.message : 'Unknown error'}`,
        },
      ],
      isError: true,
    };
  }
}
