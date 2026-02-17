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

    throw new Error(`Unknown prompt: ${promptName}`);
  });
}
