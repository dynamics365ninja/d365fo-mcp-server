/**
 * tableInfoTool — symbol-index staleness guard.
 *
 * Regression: eval/corpus/runs/2026-07-06T17__L1-form-dialog__cb1b73d.json.
 * get_object_info's DB-index fallback path ("Served from symbol index (bridge
 * unavailable)") trusted a `symbols` row for a table without checking whether
 * the table's file still exists on disk. A prior (rolled-back) run's table
 * left a phantom row in the index, which then resolved as if the table still
 * existed — generate_object(scaffold) went on to bind a form's datasource to
 * it, producing a form with 4 build errors ("Table '<Name>' does not exist").
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { XppServerContext } from '../../src/types/context';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';

vi.mock('fs', () => ({
  existsSync: vi.fn(() => true),
}));

vi.mock('../../src/bridge/bridgeAdapter', () => ({
  tryBridgeTable: vi.fn(async () => null), // force the DB-index fallback path
}));

vi.mock('../../src/tools/write/modifyD365File', () => ({
  findD365FileOnDisk: vi.fn(async () => null), // no disk fallback hit either
}));

import { tableInfoTool } from '../../src/tools/readers/tableInfo';
import * as fs from 'fs';

const req = (args: Record<string, unknown>): CallToolRequest => ({
  method: 'tools/call',
  params: { name: 'get_object_info', arguments: args },
});

function buildContext(
  tableRow: { name: string; filePath: string; model: string } | null,
  fields: Array<{ name: string; signature: string | null }> = [],
): XppServerContext {
  return {
    symbolIndex: {
      getSymbolByName: vi.fn((name: string, type: string) => {
        if (type !== 'table' || !tableRow || name !== tableRow.name) return null;
        return tableRow;
      }),
      getReadDb: vi.fn(() => ({
        // The reader issues two queries in order: fields, then methods.
        prepare: vi.fn((sql: string) => ({
          all: vi.fn(() => (sql.includes("'field'") ? fields : [])),
        })),
      })),
    } as any,
    parser: { parseTableFile: vi.fn(async () => ({ success: false })) } as any,
  } as any;
}

beforeEach(() => {
  vi.mocked(fs.existsSync).mockReset().mockReturnValue(true);
});

describe('tableInfoTool — stale symbol-index guard', () => {
  it('serves table info from the index when the indexed file still exists on disk', async () => {
    const ctx = buildContext({ name: 'ConDemoNoteHeader', filePath: 'K:\\Pkg\\Model\\AxTable\\ConDemoNoteHeader.xml', model: 'MyModel' });
    vi.mocked(fs.existsSync).mockReturnValue(true);

    const result = await tableInfoTool(req({ tableName: 'ConDemoNoteHeader' }), ctx);
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('ConDemoNoteHeader');
    expect(result.content[0].text).toContain('Served from symbol index');
  });

  it('treats a stale index row (file no longer on disk) as not-found instead of serving phantom data', async () => {
    // Regression: this is the exact scenario — a rolled-back table's row survives
    // in the index; its file no longer exists.
    const ctx = buildContext({ name: 'ConDemoNoteHeader', filePath: 'K:\\Pkg\\Model\\AxTable\\ConDemoNoteHeader.xml', model: 'MyModel' });
    vi.mocked(fs.existsSync).mockReturnValue(false);

    const result = await tableInfoTool(req({ tableName: 'ConDemoNoteHeader' }), ctx);
    // Falls through the DB hit (now rejected as stale), no disk fallback (mocked null),
    // no bridge (mocked null) — ends at the final not-found error, NOT phantom data.
    expect(result.isError).toBe(true);
    expect(result.content[0].text).not.toContain('Served from symbol index');
    expect(result.content[0].text).toMatch(/not found/i);
  });
});

describe('tableInfoTool — the DB fallback pages fields too', () => {
  // The bridge path is the one that normally serves CustTable, but the offline
  // fallback dumped every indexed field just as unboundedly, so the fix has to
  // land on both paths or a bridge-less session pays the old price.
  const manyFields = Array.from({ length: 300 }, (_, i) => ({ name: `Field${i}`, signature: 'str 20' }));

  it('cuts the field list at one page and names both ways out', async () => {
    const ctx = buildContext({ name: 'CustTable', filePath: 'K:\\Pkg\\M\\AxTable\\CustTable.xml', model: 'M' }, manyFields);

    const result = await tableInfoTool(req({ tableName: 'CustTable' }), ctx);
    const text = result.content[0].text;

    expect(text).toContain('Fields (300 total, showing 1–50)');
    expect(text).not.toContain('**Field50**');
    expect(text).toContain('250 more fields');
    expect(text).toContain('fieldsOffset: 50');
    expect(text).toContain('fieldFilter');
  });

  it('honours fieldFilter on the DB fallback', async () => {
    const ctx = buildContext({ name: 'CustTable', filePath: 'K:\\Pkg\\M\\AxTable\\CustTable.xml', model: 'M' }, manyFields);

    const result = await tableInfoTool(req({ tableName: 'CustTable', fieldFilter: 'field29' }), ctx);
    const text = result.content[0].text;

    expect(text).toContain('matching "field29"');
    expect(text).toContain('**Field290**');
    expect(text).not.toContain('**Field1**:');
  });
});
