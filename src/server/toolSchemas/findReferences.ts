/**
 * MCP tool definition for `find_references` (name/description/inputSchema),
 * extracted verbatim from mcpServer.ts. Serialized payload must not change
 * unintentionally — tests/utils/toolSchemaBudget.test.ts ratchets its size.
 */

export const findReferencesTool = {
    name: 'find_references',
    description: 'Find all references (where-used) to a class, method, field, table, enum, or LABEL. Essential for impact analysis before refactoring. For a method, SCOPE it to its declaring type — pass "Owner.method" (e.g. "SalesTable.initFromSalesQuotationTable"), set ownerName alongside a bare method name, or pass an AOT path ("/Tables/SalesTable/Methods/initFromSalesQuotationTable"). A bare method name (no owner) matches that name on every type and over-reports. For a label, pass the label id as targetName (e.g. "@WAX2194" or "@MyLabelFile:MyLabel"); results span every referencing object type (tables, forms, EDTs, enums, reports, menu items, …), not just code, and require the xref database (DYNAMICSXREFDB, full server mode).',
    inputSchema: {
      type: 'object',
      properties: {
        targetName: {
          type: 'string',
          description: 'Target name. Methods: see the scoping rule in the description above. Labels: the id exactly as written — "@WAX2194" or "@LabelFile:LabelId".'
        },
        targetType: {
          type: 'string',
          enum: ['class', 'method', 'field', 'table', 'enum', 'edt', 'form', 'query', 'view', 'report', 'label', 'all'],
          description: 'Type of the target to search for. Use "label" for label where-used (or just pass an "@…" / "/Labels/@…" targetName).',
          default: 'all'
        },
        ownerName: {
          type: 'string',
          description: 'Declaring table/class/form that owns the method, when targetName is the bare method name. Scopes the where-used to that single type.'
        },
        limit: {
          type: 'number',
          description: 'Maximum number of references to return',
          default: 50
        },
      },
      required: ['targetName'],
    },
  };
