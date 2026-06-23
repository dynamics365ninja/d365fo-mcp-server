/**
 * Unified MCP Resource registrar.
 *
 * The MCP SDK keeps ONE handler per request schema, so each call to
 * server.setRequestHandler(ListResourcesRequestSchema, …) overwrites the
 * previous one. Class and workspace resources used to register separately,
 * which meant whichever ran last silently shadowed the other. This module
 * registers a single dispatcher for ListResources / ListResourceTemplates /
 * ReadResource and routes by URI scheme, so both coexist.
 *
 * Resources exposed:
 *   • xpp://class/{className}     — class source (resource template)
 *   • workspace://context        — curated context snapshot (JSON)
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

export function registerResources(server: Server, context: XppServerContext): void {
  // ── List concrete (non-templated) resources ──────────────────────────────
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: WORKSPACE_RESOURCES.map((r) => ({ ...r })),
  }));

  // ── Advertise templated resources (classes are addressable by name) ──────
  // Enumerating every class would return 100k+ entries, so expose a template
  // instead — clients resolve xpp://class/<ClassName> on demand.
  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
    resourceTemplates: [
      {
        uriTemplate: `${CLASS_URI_PREFIX}{className}`,
        name: 'X++ Class Source',
        description: 'Full source of an X++ class by name, e.g. xpp://class/CustTable',
        mimeType: 'text/x-xpp',
      },
    ],
  }));

  // ── Read dispatcher ──────────────────────────────────────────────────────
  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const uri = request.params.uri;

    // xpp://class/{className}
    if (isClassUri(uri)) {
      const source = await readClassSource(context, uri);
      return {
        contents: [{ uri, mimeType: 'text/x-xpp', text: source }],
      };
    }

    // workspace://*
    if (uri.startsWith('workspace://')) {
      const snapshot = await buildContextSnapshot(context);

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
