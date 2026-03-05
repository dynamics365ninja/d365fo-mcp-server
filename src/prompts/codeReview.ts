/**
 * MCP Prompt: X++ Code Review
 * Provides code review prompts for X++ best practices
 */

import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { GetPromptRequestSchema, ListPromptsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { XppServerContext } from '../types/context.js';
import { getSystemInstructionsPromptDefinition, handleSystemInstructionsPrompt } from './systemInstructions.js';

const CodeReviewArgsSchema = z.object({
  code: z.string().describe('X++ code to review'),
});

const ExplainClassArgsSchema = z.object({
  className: z.string().describe('Name of the class to explain'),
});

export function registerCodeReviewPrompt(server: Server, context: XppServerContext): void {
  const { symbolIndex, parser } = context;

  // List available prompts
  server.setRequestHandler(ListPromptsRequestSchema, async () => {
    return {
      prompts: [
        getSystemInstructionsPromptDefinition(),
        {
          name: 'xpp_create_file',
          description: '🔥 USE THIS WHEN CREATING D365FO FILES: Mandatory workflow for creating D365FO classes, tables, forms, enums. ALWAYS use create_d365fo_file tool FIRST.',
          arguments: [],
        },
        {
          name: 'xpp_code_review',
          description: 'Review X++ code for best practices and potential issues',
          arguments: [
            {
              name: 'code',
              description: 'X++ code to review',
              required: true,
            },
          ],
        },
        {
          name: 'xpp_explain_class',
          description: 'Get a detailed explanation of an X++ class',
          arguments: [
            {
              name: 'className',
              description: 'Name of the class to explain',
              required: true,
            },
          ],
        },
        {
          name: 'xpp_extension_guide',
          description: 'Complete guide for CoC (Chain of Command) extensions and event handlers in D365FO',
          arguments: [],
        },
        {
          name: 'xpp_security_guide',
          description: 'D365FO security model creation guide: privilege, duty, role, and menu item workflow',
          arguments: [
            {
              name: 'featureName',
              description: 'Feature or object name for context (optional)',
              required: false,
            },
          ],
        },
        {
          name: 'xpp_sysoperation_guide',
          description: 'SysOperation framework reference: DataContract + Controller + Service pattern for batch operations',
          arguments: [
            {
              name: 'operationDescription',
              description: 'Description of the operation to implement (optional)',
              required: false,
            },
          ],
        },
        {
          name: 'xpp_data_entity_guide',
          description: 'Data entity development guide: OData, DMF, staging tables, computed columns',
          arguments: [
            {
              name: 'entityCategory',
              description: 'Entity category: parameter, reference, master, document, or transaction (optional)',
              required: false,
            },
          ],
        },
      ],
    };
  });

  // Handle prompt requests
  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    const promptName = request.params.name;

    // Handle system instructions prompt
    if (promptName === 'xpp_system_instructions') {
      return handleSystemInstructionsPrompt();
    }

    // Handle file creation prompt
    if (promptName === 'xpp_create_file') {
      return {
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: `🔥 CRITICAL: File Creation Workflow for D365FO

When user asks to CREATE any D365FO object (class, table, form, enum, query, view):

MANDATORY STEPS (NO EXCEPTIONS):

1. ALWAYS call create_d365fo_file FIRST:
   - objectType: class/table/form/enum/query/view
   - objectName: from user request
   - modelName: extract from workspace path (NEVER ask user)
   - addToProject: true
   - sourceCode: generated X++ code

2. IF create_d365fo_file fails with "requires file system access":
   THEN use generate_d365fo_xml + create_file
   OTHERWISE: DONE

FORBIDDEN:
❌ NEVER use generate_d365fo_xml as first choice
❌ NEVER use create_file directly for D365FO objects
❌ NEVER skip create_d365fo_file

Example:
User: "Create class MyHelper"
You: create_d365fo_file({
  objectType: "class",
  objectName: "MyHelper", 
  modelName: "CustomCore",
  addToProject: true,
  sourceCode: "..."
})`,
            },
          },
        ],
      };
    }

    if (promptName === 'xpp_code_review') {
      const args = CodeReviewArgsSchema.parse(request.params.arguments || {});

      return {
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: `Please review the following X++ code for:
1. Best practices compliance
2. Performance considerations
3. Security issues
4. Transaction handling (ttsbegin/ttscommit)
5. Error handling patterns
6. Naming conventions
7. Code structure and organization
8. Deprecated API usage (today() → DateTimeUtil::getToday, RunBase → SysOperation)
9. Hardcoded strings — must use label references @ModelName:LabelId
10. Nested data access loops (while select inside while select → use joins)

Code to review:
\`\`\`xpp
${args.code}
\`\`\``,
            },
          },
        ],
      };
    }

    if (promptName === 'xpp_explain_class') {
      const args = ExplainClassArgsSchema.parse(request.params.arguments || {});
      const classSymbol = symbolIndex.getSymbolByName(args.className, 'class');
      
      let classSource = 'Class not found in index';

      if (classSymbol) {
        try {
          const classInfo = await parser.parseClassFile(classSymbol.filePath);
          if (classInfo.success && classInfo.data) {
            classSource = [
              classInfo.data.declaration,
              ...classInfo.data.methods.map((m: { source: string }) => m.source),
            ].join('\n\n');
          }
        } catch (error) {
          classSource = `Error loading class: ${error}`;
        }
      }

      return {
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: `Please explain the following X++ class "${args.className}", including:
1. Purpose and responsibilities
2. How it fits in D365 F&O architecture
3. Key methods and their functionality
4. Usage patterns and examples
5. Dependencies and relationships

Class source:
\`\`\`xpp
${classSource}
\`\`\``,
            },
          },
        ],
      };
    }

    if (promptName === 'xpp_extension_guide') {
      return {
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: `# D365FO Extension Guide: CoC and Event Handlers

## Chain of Command (CoC) Extensions

Use CoC when you need to wrap or augment an existing method's logic.

### Prerequisites
1. Call \`get_method_signature\` to get exact parameter types and return type
2. Call \`find_coc_extensions\` to check if the method is already wrapped
3. Call \`analyze_extension_points\` to verify the method is CoC-eligible (not \`final\` / \`[Hookable(false)]\`)

### Class rule
\`\`\`xpp
[ExtensionOf(classStr(SalesFormLetter))]
final class SalesFormLetterWHS_Extension
{
    public void run()
    {
        // Pre-processing (optional)
        next run();     // ALWAYS call next — never skip it
        // Post-processing (optional)
    }
}
\`\`\`

### Naming
- Class extensions:  \`{Base}{Prefix}_Extension\`   e.g. \`SalesFormLetterWHS_Extension\`
- Table/form/enum:   \`{Base}.{Prefix}Extension\`    e.g. \`SalesTable.WHSExtension\` (AOT name)

### Rules
- ALWAYS call \`next methodName(...)\` with ALL original parameters preserved
- Place \`next\` at the START for pre-processing, END for post-processing, or BOTH for wrapping
- Use \`generate_code pattern='table-extension'\` or \`'form-handler'\` for the skeleton

---

## Event Handler Pattern (SubscribesTo)

Use event handlers for loosely-coupled reactions to table/class/form events.

### When to use
- Need to react to standard table events (onInserted, onUpdated, onDeleted, onValidatedWrite …)
- Avoid tight coupling — no need to wrap a method

### Workflow
1. Call \`analyze_extension_points\` with the target class/table to see available events
2. Call \`find_event_handlers\` to check if the event already has handlers (avoid duplicates)
3. Use \`generate_code pattern='event-handler' name='{BaseName}EventHandler' baseName='{BaseName}'\`

### Template
\`\`\`xpp
public final class CustTableEventHandler
{
    [SubscribesTo(tableStr(CustTable),
                  delegateStr(CustTable, onInserted))]
    public static void CustTable_onInserted(Common _sender, InsertEventArgs _e)
    {
        CustTable record = _sender;
        // Logic here
    }
}
\`\`\`

### Rules
- Handler methods MUST be \`static public void\`
- Table events → use \`tableStr()\`; class events → \`classStr()\`; form events → \`formStr()\`
- Standard table events: onInserted, onUpdated, onDeleted, onValidatedWrite, onValidatedInsert, onValidatedDelete, onInitialized, onInitValue

---

## When to use CoC vs Event Handlers

| Scenario | Use |
|---|---|
| Modify return value of a method | CoC |
| Add logic before/after a specific method | CoC |
| React to a data change across the codebase | Event Handler |
| Avoid dependency on a specific class | Event Handler |
| Method is \`final\` or \`[Hookable(false)]\` | Neither — use delegate or different approach |
`,
            },
          },
        ],
      };
    }

    if (promptName === 'xpp_security_guide') {
      const featureName = (request.params.arguments as any)?.featureName || '';
      return {
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: `# D365FO Security Model Creation Guide${featureName ? ` — ${featureName}` : ''}

## Security Hierarchy
\`\`\`
Role (e.g. AccountsReceivableClerk)
  └── Duty  (e.g. CustTableMaintain)
        └── Privilege  (e.g. CustTableView, CustTableFullControl)
              └── Entry Point (e.g. MenuItemDisplay: CustTable)
\`\`\`

## Step-by-Step Workflow

### 1. Check existing coverage first
\`\`\`
get_security_coverage_for_object(objectName: "CustTable", objectType: "form")
\`\`\`

### 2. Create menu item XML
\`\`\`
generate_code(pattern: "menu-item", name: "MyFeature", menuItemType: "display", targetObject: "MyFeatureForm")
\`\`\`

### 3. Create privilege XML (always create BOTH View + Maintain)
\`\`\`
generate_code(pattern: "security-privilege", name: "MyFeature", targetObject: "MyFeature")
\`\`\`

This generates:
- **MyFeatureView** — Read access (for inquiry roles)
- **MyFeatureMaintain** — Update/Create/Delete access (for operational roles)

### 4. Create duty referencing both privileges
\`\`\`xml
<AxSecurityDuty>
  <Name>MyFeatureMaintainDuty</Name>
  <Label>@LabelId</Label>
  <Privileges>
    <AxSecurityRolePermissionSet><Name>MyFeatureView</Name></AxSecurityRolePermissionSet>
    <AxSecurityRolePermissionSet><Name>MyFeatureMaintain</Name></AxSecurityRolePermissionSet>
  </Privileges>
</AxSecurityDuty>
\`\`\`

### 5. Assign duty to an existing role
\`\`\`
get_security_artifact_info(name: "AccountsReceivableClerk", artifactType: "role")
\`\`\`
Then add the duty to that role's XML.

## Naming Conventions

| Object | Pattern | Example |
|---|---|---|
| Privilege (view) | \`{Object}View\` | \`CustTableView\` |
| Privilege (maintain) | \`{Object}Maintain\` | \`CustTableMaintain\` |
| Duty | \`{Object}{Action}Duty\` | \`CustTableMaintainDuty\` |
| Menu item | Match form/class name | \`CustTable\` |

## Segregation of Duties
- View and Maintain privileges should be in SEPARATE duties when SoD rules apply
- Never grant Delete access in the same privilege as Create without business justification
- Use \`get_security_artifact_info\` to verify existing duty assignments before creating new ones
`,
            },
          },
        ],
      };
    }

    if (promptName === 'xpp_sysoperation_guide') {
      const operationDescription = (request.params.arguments as any)?.operationDescription || '';
      return {
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: `# D365FO SysOperation Framework Guide${operationDescription ? `\nOperation: ${operationDescription}` : ''}

## Overview
SysOperation is the **modern replacement for RunBaseBatch**. Always use SysOperation for new batch/dialog operations.
Generate the full scaffold with: \`generate_code(pattern: "sysoperation", name: "MyOperation")\`

## Three Classes

### 1. DataContract — stores parameters
\`\`\`xpp
[DataContractAttribute]
public final class MyOperationDataContract
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
\`\`\`

**Rules:**
- Each parameter = one field + one \`parmXxx\` method
- \`[DataMemberAttribute('FieldName')]\` maps to dialog/DMF field name
- NEVER use \`pack()\`/\`unpack()\` — that's the old RunBase pattern
- For grouped parameters, use sub-contracts: \`[DataMemberAttribute] public SubContract parmSub(...)\`

### 2. Controller — entry point and execution mode
\`\`\`xpp
class MyOperationController extends SysOperationServiceController
{
    protected ClassDescription defaultCaption()
    {
        return "My Operation";
    }

    public static void main(Args _args)
    {
        MyOperationController controller = new MyOperationController(
            classStr(MyOperationService),
            methodStr(MyOperationService, processMyOperation),
            SysOperationExecutionMode::Synchronous);  // or Asynchronous / ScheduledBatch
        controller.startOperation();
    }
}
\`\`\`

**Execution modes:**
| Mode | Use case |
|---|---|
| \`Synchronous\` | Fast operations, immediate result needed |
| \`Asynchronous\` | Long-running but user waits |
| \`ScheduledBatch\` | Background batch processing |

### 3. Service — business logic
\`\`\`xpp
class MyOperationService extends SysOperationServiceBase
{
    [SysEntryPointAttribute(true)]   // required for security
    public void processMyOperation(MyOperationDataContract _contract)
    {
        TransDate transDate = _contract.parmTransDate();

        ttsbegin;
        // Business logic here
        ttscommit;
    }
}
\`\`\`

**Rules:**
- Service method MUST be marked \`[SysEntryPointAttribute(true)]\`
- Use \`ttsbegin/ttscommit\` for all database writes
- Never catch exceptions inside tts block — let the framework roll back

## UIBuilder (Advanced Dialog Customization)

Use \`SysOperationAutomaticUIBuilder\` to customize the dialog beyond DataContract defaults:

\`\`\`xpp
[DataContractAttribute,
 SysOperationContractProcessingAttribute(classStr(MyOperationUIBuilder))]
public final class MyOperationDataContract
{
    // ... parm methods as above
}

class MyOperationUIBuilder extends SysOperationAutomaticUIBuilder
{
    protected void postBuild()
    {
        super();
        // Access and customize dialog controls after they're auto-built
        DialogField dateField = this.bindInfo().getDialogField(
            this.dataContractObject(), methodStr(MyOperationDataContract, parmTransDate));
        dateField.lookupButton(FormLookupButton::Always);
    }

    protected void postRun()
    {
        super();
        // Register event handlers for dialog controls (e.g. lookup, modified)
    }
}
\`\`\`

## SysOperation vs RunBase Decision

| Feature | SysOperation ✅ | RunBase ❌ (deprecated) |
|---|---|---|
| Serialization | Automatic via DataContract | Manual pack()/unpack() |
| Dialog | Auto-generated from parm methods | Manual dialogFields |
| Batch support | Built-in | Manual canGoBatch() |
| Security | \`[SysEntryPointAttribute]\` | Manual authorization |
| Extensibility | CoC on service/controller | Hard to extend |
| State management | Framework-managed | Manual container |

## Error Handling
\`\`\`xpp
try
{
    ttsbegin;
    // logic
    ttscommit;
}
catch (Exception::Error)
{
    // tts is automatically rolled back
    error("Operation failed");
}
\`\`\`

## Testing
\`\`\`xpp
// Programmatic invocation (unit tests / runnable class)
MyOperationController::main(new Args());
\`\`\`
`,
            },
          },
        ],
      };
    }

    if (promptName === 'xpp_data_entity_guide') {
      const entityCategory = (request.params.arguments as any)?.entityCategory || '';
      return {
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: `# D365FO Data Entity Development Guide${entityCategory ? `\nCategory: ${entityCategory}` : ''}

## Entity Categories

| Category | Purpose | Example |
|---|---|---|
| \`parameter\` | System/module configuration | LedgerParameters |
| \`reference\` | Lookup/master data without transactions | Currency |
| \`master\` | Core business objects | Customer, Vendor |
| \`document\` | Business transactions with header/lines | SalesOrder |
| \`transaction\` | Posted/immutable records | GeneralJournalEntry |

## Checking Existing Entities
\`\`\`
get_data_entity_info(entityName: "CustCustomerV3Entity")
\`\`\`

## Structure Pattern
\`\`\`xpp
[DataEntityViewAttribute,
 SysOperationContractAttribute,
 PublicCollectionNameAttribute('Customers'),
 PublicEntityNameAttribute('Customer')]
public class CustCustomerV3Entity extends common
{
    // Root table datasource fields mapped directly
    // Cross-datasource fields via computedColumn methods
}
\`\`\`

## Key Properties (set in XML)
| Property | Description |
|---|---|
| \`PublicEntityName\` | OData resource name (singular, PascalCase) |
| \`PublicCollectionName\` | OData collection name (plural) |
| \`IsPublic\` | Expose via OData endpoint |
| \`DataManagementEnabled\` | Enable for DMF import/export |
| \`EntityCategory\` | One of the 5 categories above |
| \`StagingTable\` | Auto-generated staging table for DMF |

## OData vs DMF Considerations
- **OData**: Set \`IsPublic = Yes\`, use \`PublicEntityName\` for the resource name
- **DMF (Data Management)**: Set \`DataManagementEnabled = Yes\` and define a staging table
- Both can be enabled simultaneously

## Computed Columns
For fields that come from complex joins or expressions:
\`\`\`xpp
private static server str computePartyName()
{
    // Return SQL expression as a string
    return SysComputedColumn::returnField(tableStr(DirPartyTable), identifierStr(Name));
}
\`\`\`

## Keys and Indexes
- Every entity needs at least one **natural key** (for OData upsert and DMF deduplication)
- Key fields should be the business identifier (AccountNum, ItemId, etc.) — NOT RecId

## Common Pitfalls
- After adding fields, run **Refresh entity list** in Data Management workspace
- Computed columns must return a valid SQL expression string, not an X++ value
- Mandatory fields on staging table must have defaults or be mapped from source
- Use \`get_view_info\` to inspect the current entity's data sources and fields

## Workflow
1. \`get_data_entity_info(entityName: "...")\` — check if entity already exists
2. \`generate_smart_table\` — for the staging table if needed
3. \`create_d365fo_file(objectType: "view", ...)\` — create the entity file
4. After deployment: refresh entity list in Data Management
`,
            },
          },
        ],
      };
    }

    throw new Error(`Unknown prompt: ${promptName}`);
  });
}
