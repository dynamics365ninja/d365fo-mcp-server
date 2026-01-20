/**
 * X++ MCP Prompts
 * Pre-built prompts for X++ code assistance
 */

import { z } from 'zod';

// ============================================
// Prompt Input Schemas
// ============================================

export const CodeReviewSchema = z.object({
  code: z.string().describe('X++ code to review')
});

export const ExplainClassSchema = z.object({
  className: z.string().describe('Name of the X++ class to explain'),
  classSource: z.string().optional().describe('Source code of the class (if already available)')
});

export const RefactorCodeSchema = z.object({
  code: z.string().describe('X++ code to refactor'),
  goal: z.string().optional().describe('Specific refactoring goal or pattern to apply')
});

export const BestPracticesSchema = z.object({
  topic: z.enum([
    'transaction-handling',
    'error-handling',
    'performance',
    'security',
    'extensibility',
    'testing',
    'naming-conventions'
  ]).describe('Best practices topic')
});

// ============================================
// Prompt Result Types
// ============================================

export interface PromptMessage {
  role: 'user' | 'assistant';
  content: {
    type: 'text';
    text: string;
  };
}

export interface PromptResult {
  messages: PromptMessage[];
}

// ============================================
// Prompt Implementations
// ============================================

export function createCodeReviewPrompt(args: z.infer<typeof CodeReviewSchema>): PromptResult {
  return {
    messages: [{
      role: 'user',
      content: {
        type: 'text',
        text: `Please review the following X++ code for Microsoft Dynamics 365 Finance & Operations. Analyze it for:

1. **Best Practices Compliance**
   - Proper use of X++ patterns and conventions
   - Code organization and structure
   - Naming conventions (Hungarian notation where appropriate)

2. **Performance Considerations**
   - Set-based operations vs record-by-record
   - Proper indexing usage
   - Query optimization (exists joins, firstonly, etc.)
   - Caching strategies

3. **Transaction Handling**
   - Proper ttsbegin/ttscommit usage
   - Exception handling within transactions
   - Nested transaction awareness

4. **Security Issues**
   - Data access controls
   - SQL injection prevention
   - Sensitive data handling

5. **Error Handling**
   - Exception patterns
   - Info/warning/error message usage
   - Validation patterns

6. **Extensibility**
   - Chain of Command compatibility
   - Event handler patterns
   - Avoiding blocking customizations

Code to review:
\`\`\`xpp
${args.code}
\`\`\`

Provide specific recommendations with corrected code examples where applicable.`
      }
    }]
  };
}

export function createExplainClassPrompt(args: z.infer<typeof ExplainClassSchema>): PromptResult {
  const sourceSection = args.classSource 
    ? `\n\nClass source code:\n\`\`\`xpp\n${args.classSource}\n\`\`\``
    : '';

  return {
    messages: [{
      role: 'user',
      content: {
        type: 'text',
        text: `Please explain the X++ class "${args.className}" in Microsoft Dynamics 365 Finance & Operations.

Include the following in your explanation:

1. **Purpose and Responsibilities**
   - What is this class designed to do?
   - What business processes does it support?

2. **Architecture Context**
   - How does it fit into the D365 F&O application framework?
   - What patterns does it implement (RunBase, SysOperation, Form, etc.)?

3. **Key Methods and Their Functionality**
   - List and explain the main methods
   - Describe the method signatures and parameters

4. **Usage Patterns and Examples**
   - How should developers use this class?
   - Common customization scenarios
   - Chain of Command extension points

5. **Related Classes and Tables**
   - Dependencies and relationships
   - Commonly used together with what other objects?${sourceSection}`
      }
    }]
  };
}

export function createRefactorPrompt(args: z.infer<typeof RefactorCodeSchema>): PromptResult {
  const goalSection = args.goal 
    ? `\n\nSpecific refactoring goal: ${args.goal}`
    : '';

  return {
    messages: [{
      role: 'user',
      content: {
        type: 'text',
        text: `Please refactor the following X++ code for Microsoft Dynamics 365 Finance & Operations.${goalSection}

Consider the following refactoring strategies:

1. **Code Quality**
   - Extract methods for complex logic
   - Reduce cognitive complexity
   - Improve readability

2. **Performance**
   - Convert record-by-record to set-based operations
   - Optimize queries
   - Add proper caching

3. **Extensibility**
   - Make the code Chain of Command friendly
   - Add appropriate extension points
   - Follow the open/closed principle

4. **Modern Patterns**
   - Use SysOperation framework where applicable
   - Implement proper data contracts
   - Apply dependency injection patterns

Original code:
\`\`\`xpp
${args.code}
\`\`\`

Provide the refactored code with explanations for each change.`
      }
    }]
  };
}

export function createBestPracticesPrompt(args: z.infer<typeof BestPracticesSchema>): PromptResult {
  const topics: Record<string, string> = {
    'transaction-handling': `# X++ Transaction Handling Best Practices

Please explain best practices for transaction handling in X++ including:

1. **ttsbegin/ttscommit patterns**
   - When to use transactions
   - Nested transaction behavior
   - Transaction scope management

2. **Exception handling in transactions**
   - Proper try/catch within tts blocks
   - ttsabort usage
   - Error recovery patterns

3. **Optimistic Concurrency Control (OCC)**
   - Understanding update conflicts
   - Handling concurrency exceptions

4. **Set-based operations**
   - update_recordset, delete_from, insert_recordset
   - When to use vs record-by-record

Provide code examples for each pattern.`,

    'error-handling': `# X++ Error Handling Best Practices

Please explain best practices for error handling in X++ including:

1. **Exception types and hierarchy**
   - Built-in exception types
   - When to throw which exception
   - Custom exception patterns

2. **Try/catch patterns**
   - Proper exception catching
   - Exception propagation
   - Finally blocks

3. **Infolog messages**
   - info(), warning(), error() usage
   - checkFailed() pattern
   - SysInfoAction usage

4. **Validation patterns**
   - validateWrite(), validateField()
   - Business rule validation
   - Cross-field validation

Provide code examples for each pattern.`,

    'performance': `# X++ Performance Best Practices

Please explain performance optimization best practices in X++ including:

1. **Query optimization**
   - Index usage and hints
   - exists/notexists joins
   - firstonly and firstfast
   - Field lists vs select *

2. **Set-based operations**
   - update_recordset, insert_recordset, delete_from
   - RecordInsertList for bulk inserts
   - When record-by-record is acceptable

3. **Caching strategies**
   - Table caching types
   - SysGlobalObjectCache
   - Record caching patterns

4. **Memory management**
   - Container vs temporary tables
   - Cursor management
   - Disposing resources

Provide code examples for each pattern.`,

    'security': `# X++ Security Best Practices

Please explain security best practices in X++ including:

1. **Data access security**
   - Role-based security
   - Record-level security
   - Table permissions

2. **Input validation**
   - Preventing SQL injection
   - Validating user input
   - Sanitizing data

3. **Sensitive data handling**
   - Encryption patterns
   - Masking sensitive fields
   - Audit logging

4. **API security**
   - Service authentication
   - Authorization checks
   - Rate limiting considerations

Provide code examples for each pattern.`,

    'extensibility': `# X++ Extensibility Best Practices

Please explain extensibility best practices in X++ including:

1. **Chain of Command (CoC)**
   - Extension class patterns
   - next keyword usage
   - Wrapping methods

2. **Event handlers**
   - Pre/Post event handlers
   - Data events
   - Form events

3. **Extension points**
   - Delegates
   - Plugin patterns
   - SysExtension framework

4. **Avoiding sealed patterns**
   - What not to customize
   - Upgrade-safe extensions
   - ISV layer considerations

Provide code examples for each pattern.`,

    'testing': `# X++ Testing Best Practices

Please explain testing best practices in X++ including:

1. **Unit testing with SysTest**
   - Test class structure
   - Assert patterns
   - Test data setup

2. **Integration testing**
   - Business scenario testing
   - Data entity testing
   - API testing

3. **Test data management**
   - Test data factories
   - Cleanup patterns
   - Isolation strategies

4. **Mocking and stubs**
   - SysTestMock framework
   - Dependency injection for testing
   - External service mocking

Provide code examples for each pattern.`,

    'naming-conventions': `# X++ Naming Convention Best Practices

Please explain naming convention best practices in X++ including:

1. **Object naming**
   - Tables, Classes, Forms, Enums
   - Prefix conventions
   - ISV/Partner prefixes

2. **Variable naming**
   - Hungarian notation usage
   - Parameter naming
   - Local vs member variables

3. **Method naming**
   - Action methods
   - Getter/setter patterns
   - Find methods

4. **Label conventions**
   - Label creation
   - Reusing standard labels
   - Multi-language considerations

Provide examples for each convention.`
  };

  return {
    messages: [{
      role: 'user',
      content: {
        type: 'text',
        text: topics[args.topic]
      }
    }]
  };
}

// ============================================
// Prompt Definitions for MCP Server
// ============================================

export interface PromptDefinition {
  name: string;
  description: string;
  argsSchema: z.ZodType;
}

export const promptDefinitions: PromptDefinition[] = [
  {
    name: 'xpp_code_review',
    description: 'Review X++ code for best practices, performance, security, and error handling',
    argsSchema: CodeReviewSchema
  },
  {
    name: 'xpp_explain_class',
    description: 'Get a detailed explanation of an X++ class including its purpose, architecture context, and usage patterns',
    argsSchema: ExplainClassSchema
  },
  {
    name: 'xpp_refactor_code',
    description: 'Get suggestions for refactoring X++ code to improve quality, performance, and extensibility',
    argsSchema: RefactorCodeSchema
  },
  {
    name: 'xpp_best_practices',
    description: 'Learn X++ best practices for specific topics like transaction handling, error handling, performance, etc.',
    argsSchema: BestPracticesSchema
  }
];
