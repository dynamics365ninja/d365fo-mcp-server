/**
 * Extensions & Security Tools Tests
 * Covers: find_coc_extensions, find_event_handlers, get_table_extension_info,
 *         get_security_artifact_info, get_security_coverage_for_object,
 *         analyze_extension_points, recommend_extension_strategy,
 *         and the menu-item / data-entity readers (now reached via get_object_info,
 *         exercised here directly against their handler functions).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { findCocExtensionsTool } from '../../src/tools/findCocExtensions';
import { findEventHandlersTool } from '../../src/tools/findEventHandlers';
import { tableExtensionInfoTool } from '../../src/tools/tableExtensionInfo';
import { securityArtifactInfoTool } from '../../src/tools/securityArtifactInfo';
import { securityCoverageInfoTool } from '../../src/tools/securityCoverageInfo';
import { analyzeExtensionPointsTool } from '../../src/tools/analyzeExtensionPoints';
import { menuItemInfoTool } from '../../src/tools/menuItemInfo';
import { dataEntityInfoTool } from '../../src/tools/dataEntityInfo';
import { extensionStrategyAdvisorTool } from '../../src/tools/extensionStrategyAdvisor';
import type { XppServerContext } from '../../src/types/context';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

const req = (name: string, args: Record<string, unknown> = {}): CallToolRequest => ({
  method: 'tools/call',
  params: { name, arguments: args },
});

/** Creates a mock db where every prepare() returns the same chainable statement mock */
const createMockDb = (
  allRows: any[] = [],
  getRow: any = undefined,
) => {
  const stmt = {
    all: vi.fn(() => allRows),
    get: vi.fn(() => getRow),
    run: vi.fn(() => ({ changes: 0 })),
  };
  return { prepare: vi.fn(() => stmt), stmt };
};

const buildContext = (dbOverride?: ReturnType<typeof createMockDb>): XppServerContext => {
  const db = dbOverride ?? createMockDb();
  return {
    symbolIndex: {
      searchSymbols: vi.fn(() => []),
      getSymbolByName: vi.fn(() => undefined),
      getClassMethods: vi.fn(() => []),
      getTableFields: vi.fn(() => []),
      searchLabels: vi.fn(() => []),
      getCustomModels: vi.fn(() => []),
      db,
      getReadDb: vi.fn(() => db),
    } as any,
    parser: {
      parseTableFile: vi.fn(async () => ({ success: false })),
    } as any,
    cache: {
      get: vi.fn(async () => null),
      set: vi.fn(async () => {}),
      generateSearchKey: vi.fn((q: string) => `k:${q}`),
    } as any,
    workspaceScanner: {} as any,
    hybridSearch: {} as any,
  };
};

// ─── find_coc_extensions ─────────────────────────────────────────────────────

describe('find_coc_extensions', () => {
  it('returns CoC extensions found in extension_metadata and symbols tables', async () => {
    const db = createMockDb();
    const ctx = buildContext(db);

    // Routed by SQL rather than by call order: the tool canonicalizes the
    // caller's name first (a symbols probe), so a positional
    // mockReturnValueOnce chain would feed the extension_metadata row to the
    // canonicalization probe instead.
    db.prepare.mockImplementation(((sql: string) => ({
      all: vi.fn(() =>
        sql.includes("extension_type = 'class-extension'")
          ? [
              {
                extension_name: 'SalesFormLetter_MyExt',
                model: 'MyModel',
                base_object_name: 'SalesFormLetter',
                coc_methods: '["run","parmSalesTable"]',
                added_methods: '[]',
                event_subscriptions: '[]',
              },
            ]
          : [],
      ),
      get: vi.fn(() => undefined),
      run: vi.fn(() => ({ changes: 0 })),
    })) as any);

    const result = await findCocExtensionsTool(
      req('find_coc_extensions', { className: 'SalesFormLetter' }),
      ctx,
    );

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('SalesFormLetter');
    expect(result.content[0].text).toContain('MyExt');
  });

  it('returns no-extensions message when nothing found', async () => {
    const ctx = buildContext(createMockDb([], undefined));
    const result = await findCocExtensionsTool(
      req('find_coc_extensions', { className: 'UnextendedClass' }),
      ctx,
    );
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toMatch(/no.*extension|0 extension/i);
  });

  it('filters by methodName when provided', async () => {
    const db = createMockDb();
    const ctx = buildContext(db);
    db.stmt.all.mockReturnValue([]);

    const result = await findCocExtensionsTool(
      req('find_coc_extensions', { className: 'CustTable', methodName: 'validateWrite' }),
      ctx,
    );
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('validateWrite');
  });

  it('returns error when className is missing', async () => {
    const result = await findCocExtensionsTool(req('find_coc_extensions', {}), buildContext());
    expect(result.isError).toBe(true);
  });
});

// ─── find_event_handlers ─────────────────────────────────────────────────────

describe('find_event_handlers', () => {
  it('returns event handlers for a table', async () => {
    const db = createMockDb();
    const ctx = buildContext(db);

    db.stmt.all
      .mockReturnValueOnce([
        {
          extension_name: 'SalesLine_EventHandlers',
          model: 'MyModel',
          event_subscriptions: JSON.stringify([
            '[SubscribesTo(tableStr(SalesLine), delegateStr(SalesLine, onInserted))]',
          ]),
        },
      ])
      .mockReturnValue([]);

    const result = await findEventHandlersTool(
      req('find_event_handlers', { targetTable: 'SalesLine' }),
      ctx,
    );
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('SalesLine');
  });

  it('returns error when neither targetClass nor targetTable is provided', async () => {
    const result = await findEventHandlersTool(req('find_event_handlers', {}), buildContext());
    expect(result.isError).toBe(true);
  });

  it('filters by eventName when provided', async () => {
    const db = createMockDb([], undefined);
    const ctx = buildContext(db);
    db.stmt.all.mockReturnValue([]);

    const result = await findEventHandlersTool(
      req('find_event_handlers', { targetTable: 'CustTable', eventName: 'onInserted' }),
      ctx,
    );
    expect(result.isError).toBeFalsy();
  });
});

// ─── get_table_extension_info ─────────────────────────────────────────────────

describe('get_table_extension_info', () => {
  it('returns table extension details', async () => {
    const db = createMockDb();
    const ctx = buildContext(db);

    db.stmt.all.mockReturnValue([
      {
        extension_name: 'CustTable_ISV_Extension',
        model: 'ISVModel',
        added_fields: JSON.stringify([{ name: 'ISV_Priority', type: 'Int' }]),
        added_indexes: '[]',
        added_methods: JSON.stringify(['ISV_getCustomField']),
      },
    ]);
    db.stmt.get.mockReturnValue({
      name: 'CustTable', type: 'table', model: 'ApplicationSuite',
      file_path: '/Tables/CustTable.xml',
    });

    const result = await tableExtensionInfoTool(
      req('get_table_extension_info', { tableName: 'CustTable' }),
      ctx,
    );
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('CustTable');
    expect(result.content[0].text).toContain('ISV_Extension');
  });

  it('returns no-extensions message when table has no extensions', async () => {
    const db = createMockDb([], undefined);
    const ctx = buildContext(db);
    db.stmt.get.mockReturnValue({ name: 'CustTable', type: 'table', model: 'ApplicationSuite', file_path: '' });

    const result = await tableExtensionInfoTool(
      req('get_table_extension_info', { tableName: 'CustTable' }),
      ctx,
    );
    expect(result.isError).toBeFalsy();
  });

  it('returns error when tableName is missing', async () => {
    const result = await tableExtensionInfoTool(req('get_table_extension_info', {}), buildContext());
    expect(result.isError).toBe(true);
  });
});

// ─── get_security_artifact_info ──────────────────────────────────────────────

describe('get_security_artifact_info', () => {
  it('returns privilege details', async () => {
    const db = createMockDb();
    const ctx = buildContext(db);

    db.stmt.get.mockReturnValue({
      name: 'CustTableFullControl', type: 'security-privilege', model: 'ApplicationSuite',
      file_path: '/SecurityPrivileges/CustTableFullControl.xml',
    });
    db.stmt.all.mockReturnValue([
      { name: 'CustTable', type: 'form', access: 'Update' },
    ]);

    const result = await securityArtifactInfoTool(
      req('get_security_artifact_info', { name: 'CustTableFullControl', artifactType: 'privilege' }),
      ctx,
    );
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('CustTableFullControl');
  });

  it('returns duty details with privilege chain', async () => {
    const db = createMockDb();
    const ctx = buildContext(db);

    db.stmt.get.mockReturnValue({
      name: 'CustTableMaintain', type: 'security-duty', model: 'ApplicationSuite',
      file_path: '/SecurityDuties/CustTableMaintain.xml',
    });
    db.stmt.all.mockReturnValue([
      { name: 'CustTableFullControl', type: 'security-privilege', model: 'ApplicationSuite' },
    ]);

    const result = await securityArtifactInfoTool(
      req('get_security_artifact_info', { name: 'CustTableMaintain', artifactType: 'duty', includeChain: true }),
      ctx,
    );
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('CustTableMaintain');
  });

  it('returns not-found for unknown artifact', async () => {
    const db = createMockDb([], undefined);
    const ctx = buildContext(db);
    db.stmt.get.mockReturnValue(undefined);

    const result = await securityArtifactInfoTool(
      req('get_security_artifact_info', { name: 'NoSuchPrivilege', artifactType: 'privilege' }),
      ctx,
    );
    expect(result.content[0].text).toMatch(/not found|no.*privilege|no.*artifact/i);
  });

  it('returns error when required args are missing', async () => {
    const result = await securityArtifactInfoTool(req('get_security_artifact_info', {}), buildContext());
    expect(result.isError).toBe(true);
  });
});

// ─── get_security_coverage_for_object ────────────────────────────────────────

describe('get_security_coverage_for_object', () => {
  it('returns full role chain for a form', async () => {
    const db = createMockDb();
    const ctx = buildContext(db);

    // menu items → privileges → duties → roles chain
    db.stmt.all
      .mockReturnValueOnce([{ name: 'SalesTableOpen', type: 'menu-item-display', model: 'ApplicationSuite' }])
      .mockReturnValueOnce([{ name: 'SalesTableView', type: 'security-privilege', model: 'ApplicationSuite' }])
      .mockReturnValueOnce([{ name: 'SalesOrderView', type: 'security-duty', model: 'ApplicationSuite' }])
      .mockReturnValueOnce([{ name: 'SalesClerk', type: 'security-role', model: 'ApplicationSuite' }]);

    const result = await securityCoverageInfoTool(
      req('get_security_coverage_for_object', { objectName: 'SalesTable', objectType: 'form' }),
      ctx,
    );
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('SalesTable');
  });

  it('returns no-coverage message when no roles grant access', async () => {
    const db = createMockDb([], undefined);
    const ctx = buildContext(db);

    const result = await securityCoverageInfoTool(
      req('get_security_coverage_for_object', { objectName: 'OrphanForm', objectType: 'form' }),
      ctx,
    );
    expect(result.isError).toBeFalsy();
  });

  it('returns error when objectName is missing', async () => {
    const result = await securityCoverageInfoTool(req('get_security_coverage_for_object', {}), buildContext());
    expect(result.isError).toBe(true);
  });
});

// ─── analyze_extension_points ────────────────────────────────────────────────

describe('analyze_extension_points', () => {
  it('returns CoC-eligible methods for a class', async () => {
    const db = createMockDb();
    const ctx = buildContext(db);

    // object type resolution
    db.stmt.get.mockReturnValue({ type: 'class' });
    db.stmt.all
      // canonical-name probe (symbolLookup, #686) — runs before everything else
      .mockReturnValueOnce([{ name: 'SalesFormLetter', type: 'class', model: 'M', extends_class: null, file_path: '' }])
      .mockReturnValueOnce([]) // existing extensions
      .mockReturnValueOnce([  // methods
        { name: 'run', type: 'method', signature: 'void run()', is_final: 0 },
        { name: 'init', type: 'method', signature: 'void init()', is_final: 0 },
        { name: 'locked', type: 'method', signature: 'void locked()', is_final: 1 },
      ]);

    const result = await analyzeExtensionPointsTool(
      req('analyze_extension_points', { objectName: 'SalesFormLetter', objectType: 'class' }),
      ctx,
    );
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('SalesFormLetter');
  });

  it('lists table events when object is a table', async () => {
    const db = createMockDb();
    const ctx = buildContext(db);

    db.stmt.get.mockReturnValue({ name: 'CustTable', type: 'table', model: 'ApplicationSuite', file_path: '' });
    db.stmt.all.mockReturnValue([]);

    const result = await analyzeExtensionPointsTool(
      req('analyze_extension_points', { objectName: 'CustTable', objectType: 'table' }),
      ctx,
    );
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('CustTable');
  });

  it('returns error when objectName is missing', async () => {
    const result = await analyzeExtensionPointsTool(req('analyze_extension_points', {}), buildContext());
    expect(result.isError).toBe(true);
  });
});

// ─── get_menu_item_info ──────────────────────────────────────────────────────

describe('get_menu_item_info', () => {
  it('returns menu item details', async () => {
    const db = createMockDb();
    const ctx = buildContext(db);

    db.stmt.get.mockReturnValue({
      name: 'SalesTableOpen', type: 'menu-item-display', model: 'ApplicationSuite',
      file_path: '/MenuItemsDisplay/SalesTableOpen.xml',
    });

    const result = await menuItemInfoTool(
      req('get_menu_item_info', { name: 'SalesTableOpen' }),
      ctx,
    );
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('SalesTableOpen');
  });

  it('returns not-found for unknown menu item', async () => {
    const db = createMockDb([], undefined);
    const ctx = buildContext(db);
    db.stmt.get.mockReturnValue(undefined);
    db.stmt.all.mockReturnValue([]);

    const result = await menuItemInfoTool(
      req('get_menu_item_info', { name: 'NoSuchMenuItem' }),
      ctx,
    );
    expect(result.content[0].text).toMatch(/not found|no.*menu/i);
  });

  it('returns error when menuItemName is missing', async () => {
    const result = await menuItemInfoTool(req('get_menu_item_info', {}), buildContext());
    expect(result.isError).toBe(true);
  });
});

// ─── get_data_entity_info ────────────────────────────────────────────────────

describe('get_data_entity_info', () => {
  it('returns entity OData metadata and field mappings', async () => {
    const db = createMockDb();
    const ctx = buildContext(db);

    db.stmt.get.mockReturnValue({
      name: 'CustCustomerV3Entity', type: 'data-entity', model: 'ApplicationSuite',
      file_path: '/DataEntityViews/CustCustomerV3Entity.xml',
    });
    db.stmt.all.mockReturnValue([
      { name: 'AccountNum', type: 'field', signature: 'str AccountNum', parentName: 'CustCustomerV3Entity' },
    ]);

    const result = await dataEntityInfoTool(
      req('get_data_entity_info', { entityName: 'CustCustomerV3Entity' }),
      ctx,
    );
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('CustCustomerV3Entity');
  });

  it('returns not-found for unknown entity', async () => {
    const db = createMockDb([], undefined);
    const ctx = buildContext(db);
    db.stmt.get.mockReturnValue(undefined);

    const result = await dataEntityInfoTool(
      req('get_data_entity_info', { entityName: 'NoEntity' }),
      ctx,
    );
    expect(result.content[0].text).toMatch(/not found|no.*entity/i);
  });

  it('returns error when entityName is missing', async () => {
    const result = await dataEntityInfoTool(req('get_data_entity_info', {}), buildContext());
    expect(result.isError).toBe(true);
  });
});

// ─── recommend_extension_strategy ────────────────────────────────────────────

describe('recommend_extension_strategy', () => {
  it('recommends table event for data validation scenario', async () => {
    const result = await extensionStrategyAdvisorTool(
      req('recommend_extension_strategy', {
        goal: 'validate that SalesLine quantity is positive',
        objectName: 'SalesLine',
      }),
      buildContext(),
    );
    expect(result.isError).toBeFalsy();
    const text = result.content[0].text;
    expect(text).toContain('data-validation');
    expect(text).toMatch(/Table Event|onValidat/i);
    expect(text).toContain('SalesLine');
  });

  it('recommends Business Event for outbound integration', async () => {
    const result = await extensionStrategyAdvisorTool(
      req('recommend_extension_strategy', {
        goal: 'send order confirmation to external ERP via Power Automate',
      }),
      buildContext(),
    );
    expect(result.isError).toBeFalsy();
    const text = result.content[0].text;
    expect(text).toContain('Business Event');
    expect(text).toContain('outbound-integration');
  });

  it('recommends Data Entity for inbound data', async () => {
    const result = await extensionStrategyAdvisorTool(
      req('recommend_extension_strategy', {
        goal: 'import vendor master data from CSV via DMF',
      }),
      buildContext(),
    );
    expect(result.isError).toBeFalsy();
    const text = result.content[0].text;
    expect(text).toContain('Data Entity');
    expect(text).toContain('inbound-data');
  });

  it('recommends Form Extension for UI modification', async () => {
    const result = await extensionStrategyAdvisorTool(
      req('recommend_extension_strategy', {
        goal: 'add custom field to CustTable form',
        objectName: 'CustTable',
      }),
      buildContext(),
    );
    expect(result.isError).toBeFalsy();
    const text = result.content[0].text;
    expect(text).toContain('Form Extension');
    expect(text).toContain('CustTable');
  });

  it('recommends CoC for business logic modification', async () => {
    const result = await extensionStrategyAdvisorTool(
      req('recommend_extension_strategy', {
        goal: 'add logic before posting sales invoice',
      }),
      buildContext(),
    );
    expect(result.isError).toBeFalsy();
    const text = result.content[0].text;
    expect(text).toContain('Chain of Command');
  });

  it('recommends ER/SSRS for document output', async () => {
    const result = await extensionStrategyAdvisorTool(
      req('recommend_extension_strategy', {
        goal: 'customize invoice print layout with new fields',
      }),
      buildContext(),
    );
    expect(result.isError).toBeFalsy();
    const text = result.content[0].text;
    expect(text).toMatch(/Electronic Reporting|SSRS/);
  });

  it('uses explicit scenario parameter when provided', async () => {
    const result = await extensionStrategyAdvisorTool(
      req('recommend_extension_strategy', {
        goal: 'do something with numbers',
        scenario: 'number-sequence',
      }),
      buildContext(),
    );
    expect(result.isError).toBeFalsy();
    const text = result.content[0].text;
    expect(text).toContain('Number Sequence');
  });

  it('returns anti-patterns to avoid', async () => {
    const result = await extensionStrategyAdvisorTool(
      req('recommend_extension_strategy', {
        goal: 'validate sales order amount is not negative',
      }),
      buildContext(),
    );
    expect(result.isError).toBeFalsy();
    const text = result.content[0].text;
    expect(text).toContain('Anti-Patterns');
  });

  it('returns next steps with MCP tool calls', async () => {
    const result = await extensionStrategyAdvisorTool(
      req('recommend_extension_strategy', {
        goal: 'add field to CustTable form',
        objectName: 'CustTable',
      }),
      buildContext(),
    );
    expect(result.isError).toBeFalsy();
    const text = result.content[0].text;
    expect(text).toContain('Next Steps');
    expect(text).toContain('CustTable');
  });

  it('shows fallback guidance when goal is ambiguous', async () => {
    const result = await extensionStrategyAdvisorTool(
      req('recommend_extension_strategy', {
        goal: 'do something completely unrelated to any known pattern xyz123',
      }),
      buildContext(),
    );
    expect(result.isError).toBeFalsy();
    const text = result.content[0].text;
    expect(text).toContain('scenario');
  });

  it('recommends SysOperation for batch processing', async () => {
    const result = await extensionStrategyAdvisorTool(
      req('recommend_extension_strategy', {
        goal: 'create a scheduled batch job to recalculate inventory',
        scenario: 'batch-processing',
      }),
      buildContext(),
    );
    expect(result.isError).toBeFalsy();
    const text = result.content[0].text;
    expect(text).toContain('SysOperation');
  });

  it('recommends security hierarchy for access control', async () => {
    const result = await extensionStrategyAdvisorTool(
      req('recommend_extension_strategy', {
        goal: 'grant users access to new custom form via security role',
      }),
      buildContext(),
    );
    expect(result.isError).toBeFalsy();
    const text = result.content[0].text;
    expect(text).toMatch(/Privilege|Duty|Role/);
  });
});
