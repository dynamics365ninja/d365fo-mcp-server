/**
 * MCP tool definition for `get_object_info` (name/description/inputSchema),
 * extracted verbatim from mcpServer.ts. Serialized payload must not change
 * unintentionally — tests/utils/toolSchemaBudget.test.ts ratchets its size.
 */
import { OBJECT_INFO_TYPES } from '../../tools/objectInfoRegistry.js';

export const getObjectInfoTool = {
    name: 'get_object_info',
    description: 'Read D365FO object metadata. For 2+ objects pass objects:[{objectType,name},…] (max 10) — ONE call, run in parallel, per-object sections back; never loop single calls. One object: {objectType, name}. Pick the kind via objectType: class, table, form, query, view, enum, edt, report, data-entity, menu-item, service, map, config-key, security-policy, macro. Extension types (table-extension, form-extension, enum-extension, edt-extension, data-entity-extension) list all extensions of a base object — pass the base object name or a full extension name (the dot suffix is stripped automatically). Type-specific flags go in options, e.g. {"includeRdl":true} (report), {"searchControl":"General"} (form), {"compact":false} (class), {"filter":"Path"} (macro), {"mode":"hierarchy"} (edt). For CLASSES, {"members":"names"} (optional {"prefix":...}) returns a fast IntelliSense-style member-name list instead of full metadata. Replaces the former get_<type>_info, code_completion and batch_get_info tools.',
    inputSchema: {
      type: 'object',
      properties: {
        objects: {
          type: 'array',
          minItems: 1,
          maxItems: 10,
          description: 'PREFERRED for 2+ objects: read them all in one round trip. Each entry takes the same objectType/name/options as the single form.',
          items: {
            type: 'object',
            properties: {
              objectType: { type: 'string', enum: [...OBJECT_INFO_TYPES], description: 'Kind of object to read' },
              name: { type: 'string', description: 'Exact object name (use search first if unsure)' },
              options: { type: 'object', description: 'Optional type-specific flags for this object; overrides the top-level options.' },
            },
            required: ['objectType', 'name'],
          },
        },
        objectType: {
          type: 'string',
          enum: [...OBJECT_INFO_TYPES],
          description: 'Kind of object to read (incl. *-extension types — pass base object name or full extension name). REQUIRED unless using objects[].',
        },
        name: {
          type: 'string',
          description: 'Exact object name (use search first if unsure). REQUIRED unless using objects[].',
        },
        options: {
          type: 'object',
          description: 'Optional type-specific flags forwarded to the reader (e.g. includeRdl, includeFields, searchControl, compact, includeOperations, filter, mode, modelName). With objects[] it applies to every entry.',
        },
      },
    },
  };
