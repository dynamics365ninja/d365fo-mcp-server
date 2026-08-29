/**
 * Unified MCP Resource registrar.
 *
 * The MCP SDK keeps ONE handler per request schema — a second
 * server.setRequestHandler(ListResourcesRequestSchema, …) call would silently
 * overwrite the first. This module is the single dispatcher for ListResources /
 * ListResourceTemplates / ReadResource, routing by URI scheme so class and
 * workspace resources can coexist.
 *
 * Resources exposed:
 *   • xpp://class/{className}     — class source (resource template)
 *   • workspace://context        — curated context snapshot (JSON)
 *   • workspace://active         — most recently modified X++ object (JSON)
 *   • workspace://stats          — symbol-index + workspace statistics (JSON)
 *   • workspace://files          — list of X++ files in the workspace (JSON)
 *   • workspace://recent-changes — uncommitted X++ changes vs HEAD (JSON)
 */

import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { XppServerContext } from '../types/context.js';
import { isClassUri, readClassSource, CLASS_URI_PREFIX } from './classResource.js';
import { buildContextSnapshot } from '../workspace/contextSnapshot.js';

const WORKSPACE_RESOURCES = [
  {
    uri: 'workspace://context',
    name: 'Workspace Context Snapshot',
    description:
      'Curated snapshot of the current work: active model/project, recently ' +
      'edited objects, uncommitted X++ changes and index freshness. Read this ' +
      'first to ground a session.',
    mimeType: 'application/json',
  },
  {
    uri: 'workspace://active',
    name: 'Active Object',
    description:
      'The object the developer is most likely working on (most recently ' +
      'modified X++ file) enriched with its indexed metadata. Proxy for editor ' +
      'focus — MCP exposes roots, not the cursor.',
    mimeType: 'application/json',
  },
  {
    uri: 'workspace://stats',
    name: 'Workspace Statistics',
    description: 'Symbol-index totals by type, indexed models and workspace file counts.',
    mimeType: 'application/json',
  },
  {
    uri: 'workspace://files',
    name: 'Workspace Files',
    description: 'List of X++ metadata files detected in the workspace (most recent first).',
    mimeType: 'application/json',
  },
  {
    uri: 'workspace://recent-changes',
    name: 'Recent Workspace Changes',
    description: 'Uncommitted X++ object files (vs HEAD + untracked). Empty when not a git repo.',
    mimeType: 'application/json',
  },
] as const;

function json(uri: string, data: unknown) {
  return {
    contents: [
      {
        uri,
        mimeType: 'application/json',
        text: JSON.stringify(data, null, 2),
      },
    ],
  };
}

/**
 * Whether any client has actually LISTED or READ a resource this session.
 *
 * These handlers are the only place that knows. The HTTP transport logs its own
 * request line, but the stdio transport — which is what VS Code and VS 2022 use,
 * i.e. every target client — logs nothing per request, so without this a read of
 * `workspace://active` was indistinguishable from no client ever asking.
 *
 * That distinction is the open question behind two docs/BACKLOG.md entries
 * (context-pipeline Phase 3b and the VSIX shim): both are deferred *until we
 * verify a client consumes these resources*, and neither can be answered while
 * the evidence is discarded. One line per event, not gated behind a debug flag,
 * because the events are rare (a list at session start, a read on demand) and a
 * flag nobody sets collects nothing.
 */
function noteResourceUse(event: string): void {
  process.stderr.write(`[resources] 📄 ${event}\n`);
}

export function registerResources(server: Server, context: XppServerContext): void {
  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    noteResourceUse(`resources/list — client enumerated ${WORKSPACE_RESOURCES.length} workspace resources`);
    return { resources: WORKSPACE_RESOURCES.map((r) => ({ ...r })) };
  });

  // Classes are exposed as a template instead of being enumerated (100k+ entries) —
  // clients resolve xpp://class/<ClassName> on demand.
  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => {
    noteResourceUse('resources/templates/list — client enumerated the xpp://class/{name} template');
    return {
      resourceTemplates: [
        {
          uriTemplate: `${CLASS_URI_PREFIX}{className}`,
          name: 'X++ Class Source',
          description: 'Full source of an X++ class by name, e.g. xpp://class/CustTable',
          mimeType: 'text/x-xpp',
        },
      ],
    };
  });

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const uri = request.params.uri;
    noteResourceUse(`resources/read ${uri}`);

    if (isClassUri(uri)) {
      const source = await readClassSource(context, uri);
      return {
        contents: [{ uri, mimeType: 'text/x-xpp', text: source }],
      };
    }

    if (uri.startsWith('workspace://')) {
      // Blocking on purpose. These resources are read at SESSION START, i.e.
      // exactly when the caches are cold, and the non-blocking snapshot reports
      // a pending scan as an empty result — so the first thing a client saw
      // could be "no recent edits" for a workspace full of them. A resource read
      // is not on the latency path a tool call is.
      const snapshot = await buildContextSnapshot(context, { blocking: true });

      switch (uri) {
        case 'workspace://context':
          return json(uri, snapshot);

        case 'workspace://active': {
          const active = snapshot.activeObject;
          // Enrich with indexed metadata (signature/model) when the type maps
          // to an indexable symbol type. 'unknown' files are returned as-is.
          let indexed: { name: string; type: string; model: string; signature?: string } | null = null;
          if (active && active.type !== 'unknown') {
            try {
              const sym = context.symbolIndex.getSymbolByName(active.name, active.type);
              if (sym) {
                indexed = {
                  name: sym.name,
                  type: sym.type,
                  model: sym.model,
                  signature: sym.signature,
                };
              }
            } catch {
              /* enrichment optional */
            }
          }
          return json(uri, {
            activeObject: active,
            indexed,
            note: active
              ? 'Proxy for the active file (most recently modified). Not editor-cursor state.'
              : 'No workspace files detected — cannot infer an active object.',
            generatedAt: snapshot.generatedAt,
          });
        }

        case 'workspace://stats':
          return json(uri, {
            index: snapshot.index,
            workspacePath: snapshot.workspacePath,
            recentObjectCount: snapshot.recentObjects.length,
            uncommittedFileCount: snapshot.uncommittedFiles.length,
            generatedAt: snapshot.generatedAt,
          });

        case 'workspace://files':
          return json(uri, {
            workspacePath: snapshot.workspacePath,
            files: snapshot.recentObjects,
            note:
              snapshot.recentObjects.length === 0
                ? 'No workspace path configured or no X++ files found.'
                : `Showing the ${snapshot.recentObjects.length} most recently edited objects.`,
            generatedAt: snapshot.generatedAt,
          });

        case 'workspace://recent-changes':
          return json(uri, {
            workspacePath: snapshot.workspacePath,
            uncommittedFiles: snapshot.uncommittedFiles,
            generatedAt: snapshot.generatedAt,
          });
      }
    }

    throw new Error(`Unknown resource: ${uri}`);
  });
}
