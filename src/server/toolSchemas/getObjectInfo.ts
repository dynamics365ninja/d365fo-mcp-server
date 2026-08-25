/**
 * MCP tool definition for `get_object_info` (name/description/inputSchema),
 * extracted verbatim from mcpServer.ts. Serialized payload must not change
 * unintentionally — tests/utils/toolSchemaBudget.test.ts ratchets its size.
 */
import { OBJECT_INFO_TYPES } from '../../tools/readers/objectInfoRegistry.js';

export const getObjectInfoTool = {
    name: 'get_object_info',
    description: 'Read D365FO object metadata. For 2+ objects pass objects:[{objectType,objectName},…] (max 10) — ONE call, run in parallel, per-object sections back; never loop single calls. One object: {objectType, name}. Pick the kind via objectType: class, table, form, query, view, enum, edt, report, data-entity, menu-item, service, map, config-key, security-policy, macro. Extension types (table-extension, form-extension, enum-extension, edt-extension, data-entity-extension) list all extensions of a base object — pass the base object name or a full extension name (the dot suffix is stripped automatically). Type-specific flags go in options. For CLASSES, {"members":"names"} (optional {"prefix":...}) returns a fast IntelliSense-style member-name list instead of full metadata.',
    inputSchema: {
      type: 'object',
      properties: {
        objects: {
          type: 'array',
          minItems: 1,
          maxItems: 10,
          description: 'PREFERRED for 2+ objects: read them all in one round trip. Each entry takes the same objectType/options as the single form, with the name in objectName.',
          items: {
            type: 'object',
            properties: {
              // Enum deliberately NOT repeated — same values as the top-level
              // `objectType` below, and zod is what validates the call. The
              // second copy was only documentation, at ~260 chars per session.
              objectType: { type: 'string', description: 'Kind of object to read — same values as the top-level `objectType`.' },
              objectName: { type: 'string', description: 'Exact object name.' },
              options: { type: 'object', description: 'Optional type-specific flags for this object; overrides the top-level options.' },
            },
            required: ['objectType', 'objectName'],
          },
        },
        objectType: {
          type: 'string',
          enum: [...OBJECT_INFO_TYPES],
          description: 'Kind of object to read. REQUIRED unless using objects[].',
        },
        name: {
          type: 'string',
          description: 'Exact object name (use search first if unsure). REQUIRED unless using objects[].',
        },
        options: {
          type: 'object',
          description: 'Type-specific reader flags: includeRdl (report), searchControl/maxControls (form), compact/methodOffset (class+table), fieldsOffset/fieldFilter/relations (table), filter (macro), mode (edt), includeFields, includeOperations, modelName. On class/table/view/data-entity, {"method":"validateWrite","include":"signature"} returns ONE method (include: signature | source | both) — required before writing a CoC extension. {"include":"xml"} returns raw AOT XML + its path (page: startLine/endLine) — never shell out to find or read a file. Applies to every objects[] entry.',
        },
      },
    },
  };
