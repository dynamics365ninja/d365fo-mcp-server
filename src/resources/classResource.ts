/**
 * MCP Resource: X++ Class Source Code
 * Exposes class source code via xpp://class/{className} URIs
 */

import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ListResourcesRequestSchema, ReadResourceRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { XppServerContext } from '../types/context.js';

export function registerClassResource(server: Server, context: XppServerContext): void {
  const { symbolIndex, parser } = context;

  // List all available class resources
  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    const classes = symbolIndex.getAllClasses();
    
    return {
      resources: classes.map((cls) => ({
        uri: `xpp://class/${cls.name}`,
        name: `Class: ${cls.name}`,
        description: cls.signature || 'X++ class source code',
        mimeType: 'text/x-xpp',
      })),
    };
  });

  // Read specific class resource
  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const uri = request.params.uri;
    
    // Only handle xpp://class/* URIs
    if (!uri.startsWith('xpp://class/')) {
      return {
        contents: [],
      };
    }

    const className = uri.replace('xpp://class/', '');
    const classSymbol = symbolIndex.getSymbolByName(className, 'class');

    if (!classSymbol) {
      throw new Error(`Class "${className}" not found`);
    }

    try {
      const classInfo = await parser.parseClassFile(classSymbol.filePath);
      
      if (!classInfo.success || !classInfo.data) {
        throw new Error(`Failed to parse class: ${classInfo.error || 'Unknown error'}`);
      }

      // Combine declaration and methods into full source
      const fullSource = [
        classInfo.data.declaration,
        ...classInfo.data.methods.map((m) => m.source),
      ].join('\n\n');

      return {
        contents: [
          {
            uri,
            mimeType: 'text/x-xpp',
            text: fullSource,
          },
        ],
      };
    } catch (error) {
      throw new Error(`Failed to read class "${className}": ${error}`);
    }
  });
}
