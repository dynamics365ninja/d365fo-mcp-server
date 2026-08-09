/**
 * MCP tool definition for `d365fo_file` (name/description/inputSchema).
 *
 * Deliberately carries the DISCRIMINATORS only (action / objectType /
 * operation as closed enums) — never the parameters behind them. The per-
 * operation and per-objectType contracts live in src/tools/d365foFileOpSpecs.ts
 * and are fetched on demand via get_knowledge(kind="op-spec", topic=…), because
 * this payload is re-sent on every request while a call needs exactly one of
 * them (issue #825). Every missing-parameter error names that lookup, so the
 * contract stays one call away.
 *
 * Serialized payload must not change unintentionally —
 * tests/utils/toolSchemaBudget.test.ts ratchets its size.
 */

export const d365foFileTool = {
    name: 'd365fo_file',
    description: `Create, modify, or generate a D365FO AOT object. Choose an \`action\`:
• create → write a NEW object file into PackagesLocalDirectory (UTF-8 BOM, auto-added to .rnrproj). THE WRITE STEP — incomplete until isError=false; ⚠️/❌ = failure. Extensions: objectName="Base.PrefixExtension".
• modify → edit an EXISTING object. APPLIES IMMEDIATELY, no dry-run — confirm with the user first; revert with undo_last_modification. Needs \`operation\`.
• generate → XML as TEXT only, no write (Azure/Linux fallback). Try create first. create/modify need Windows.
📖 Parameters are NOT inlined here: get_knowledge(kind="op-spec", topic="<operation>"|"<objectType>") returns the contract for the one you picked — pass its values nested in \`params\` (modify) / \`properties\` (create), along with any packageName/packagePath/solutionPath/workspacePath override.
Model + prefix auto-applied. Classes: member vars inside the class { }, methods after the closing }.`,
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['create', 'modify', 'generate'],
          description: 'One of the three modes described above.',
        },
        objectType: {
          type: 'string',
          enum: [
            'class', 'table', 'enum', 'form', 'query', 'view', 'data-entity', 'report', 'edt',
            'table-extension', 'class-extension', 'form-extension', 'enum-extension', 'edt-extension',
            'data-entity-extension', 'menu-item-display-extension',
            'menu-item-action-extension', 'menu-item-output-extension', 'menu-extension',
            'menu-item-display', 'menu-item-action', 'menu-item-output', 'menu',
            'security-privilege', 'security-duty', 'security-role',
            'security-duty-extension', 'security-role-extension',
            'business-event', 'tile', 'kpi', 'map',
            'service', 'service-group',
            'macro', 'configuration-key', 'security-policy', 'aggregate-measurement', 'license-code',
          ],
          description:
            'Each security/menu-item type is its own AOT folder — NEVER use security-privilege for duty or role. ' +
            '[modify]/[generate] cover the core families + their *-extension variants.'
        },
        objectName: {
          type: 'string',
          description: 'Base name WITHOUT model prefix — the tool prepends it. Extension classes: "{Base}_Extension". NEVER hand-build the prefix.'
        },
        modelName: {
          type: 'string',
          description: 'Target model — auto-detected. NEVER take it from search results (those are source models).'
        },
        sourceCode: {
          type: 'string',
          description: 'X++ source. FOR CLASSES auto-split: <Declaration> = class line + member vars; <Methods> = each method after the closing }.'
        },
        properties: {
          type: 'object',
          additionalProperties: true,
          description:
            '[create] Per-objectType creation properties (label, fields[], extends, enumValues[], primaryTable, …) — ' +
            'NOT in this schema. Fetch yours: get_knowledge(kind="op-spec", topic="<objectType>").'
        },
        addToProject: { type: 'boolean', description: 'Add to the ACTIVE .rnrproj — keep the default.', default: true },
        projectPath: { type: 'string', description: 'Path to .rnrproj (auto-detected).' },
        xmlContent: { type: 'string', description: 'Complete XML written verbatim (+overwrite=true rewrites an object).' },
        overwrite: { type: 'boolean', description: 'Allow overwriting — never rewrite via PowerShell.', default: false },
        groundingToken: {
          type: 'string',
          description: 'From prepare(change/create). Required for *-extension when GROUNDING_ENFORCE=true; object-bound.',
        },
        // action=modify only
        operation: {
          type: 'string',
          enum: [
            'add-method', 'remove-method', 'replace-code',
            'add-field', 'modify-field', 'rename-field', 'replace-all-fields', 'remove-field',
            'add-display-method', 'add-table-method',
            'add-index', 'remove-index',
            'add-full-text-index', 'remove-full-text-index',
            'add-table-mapping', 'remove-table-mapping',
            'add-relation', 'remove-relation',
            'add-delete-action', 'remove-delete-action',
            'add-field-group', 'remove-field-group', 'add-field-to-field-group',
            'add-field-modification',
            'add-data-source', 'add-control',
            'add-enum-value', 'modify-enum-value', 'remove-enum-value',
            'add-menu-item-to-menu',
            'modify-property',
          ],
          description:
            '[modify] REQUIRED unless using operations[]. add-method also UPDATES in place; replace-code is the surgical oldCode→newCode path. ' +
            'Parameters: get_knowledge(kind="op-spec", topic="<operation>").'
        },
        operations: {
          type: 'array',
          maxItems: 20,
          description:
            '[modify] PREFERRED for 2+ edits to the SAME object — ONE call, not one per edit. ' +
            'Entries are {operation, …op-spec params}; objectType/objectName/modelName stay top-level. ' +
            'Applied in order, stopped at the first failure, per-operation results back. ' +
            '3 fields + their field groups + an index: 7 calls flat, 1 here.',
          items: { type: 'object', additionalProperties: true },
        },
        params: {
          type: 'object',
          additionalProperties: true,
          description:
            '[modify] Operation-specific parameters as ONE nested object, per get_knowledge(kind="op-spec", ' +
            'topic="<operation>"). A missing/wrong one returns that COMPLETE spec — follow it, do not guess.',
        },
        createBackup: { type: 'boolean', description: '[modify] Back up before modifying.', default: false },
        filePath: { type: 'string', description: '[modify] Absolute XML path — bypasses symbol-DB lookup. Use for objects just created.' },
      },
      required: ['action'],
    },
  };
