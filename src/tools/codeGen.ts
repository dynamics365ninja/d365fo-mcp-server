/**
 * X++ Code Generation Tool
 * Generate X++ code templates for common patterns
 */

import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

const CodeGenArgsSchema = z.object({
  pattern: z
    .enum(['class', 'runnable', 'form-handler', 'data-entity', 'batch-job', 'table-extension'])
    .describe('Code pattern to generate'),
  name: z.string().describe('Name for the generated element'),
});

const templates: Record<string, (name: string) => string> = {
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

  'form-handler': (name) => `
/// <summary>
/// Form extension for ${name}
/// </summary>
[ExtensionOf(formStr(${name}))]
final class ${name}Form_Extension
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
    /// Data source active
    /// </summary>
    [FormDataSourceEventHandler(formDataSourceStr(${name}, <DataSourceName>), FormDataSourceEventType::Activated)]
    public static void <DataSourceName>_OnActivated(FormDataSource sender, FormDataSourceEventArgs e)
    {
        // TODO: Handle data source activation
    }
}`,

  'data-entity': (name) => `
/// <summary>
/// Data entity for ${name}
/// </summary>
public class ${name}Entity extends common
{
    /// <summary>
    /// Find entity by RecId
    /// </summary>
    /// <param name="_recId">Record ID</param>
    /// <param name="_forUpdate">Select for update</param>
    /// <returns>Entity instance</returns>
    public static ${name}Entity find(RecId _recId, boolean _forUpdate = false)
    {
        ${name}Entity entity;
        
        entity.selectForUpdate(_forUpdate);
        
        select firstonly entity
            where entity.RecId == _recId;
            
        return entity;
    }

    /// <summary>
    /// Validate entity
    /// </summary>
    /// <returns>True if valid</returns>
    public boolean validateWrite()
    {
        boolean ret = super();
        
        // TODO: Add custom validation
        
        return ret;
    }
}`,

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
    /// Constructor
    /// </summary>
    protected void new()
    {
        super();
        this.parmClassName(classStr(${name}Service));
        this.parmMethodName(methodStr(${name}Service, process));
    }

    /// <summary>
    /// Pack settings
    /// </summary>
    public container pack()
    {
        return [#CurrentVersion, #CurrentList];
    }

    /// <summary>
    /// Unpack settings
    /// </summary>
    public boolean unpack(container _packedClass)
    {
        return true;
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

  'table-extension': (name) => `
/// <summary>
/// Table extension for ${name}
/// </summary>
[ExtensionOf(tableStr(${name}))]
final class ${name}_Extension
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
}`,
};

export async function codeGenTool(request: CallToolRequest) {
  const args = CodeGenArgsSchema.parse(request.params.arguments);

  try {
    const template = templates[args.pattern];
    if (!template) {
      return {
        content: [
          {
            type: 'text',
            text: `Unknown pattern: ${args.pattern}`,
          },
        ],
        isError: true,
      };
    }

    const code = template(args.name);

    return {
      content: [
        {
          type: 'text',
          text: `Generated ${args.pattern} template for "${args.name}":\n\n\`\`\`xpp${code}\n\`\`\`\n\n---\n\n💡 **Next Steps for Better Code Quality:**\n\n1. ✅ Use \`analyze_code_patterns("<scenario>")\` - Learn what D365FO classes are commonly used together\n2. ✅ Use \`suggest_method_implementation("${args.name}", "<methodName>")\` - Get real implementation examples\n3. ✅ Use \`analyze_class_completeness("${args.name}")\` - Check for missing common methods\n4. ✅ Use \`get_api_usage_patterns("<ClassName>")\` - See how to use D365FO APIs correctly\n\nThese tools provide patterns from the actual codebase, not generic templates.`,
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
