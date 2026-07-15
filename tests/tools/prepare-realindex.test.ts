/**
 * prepare tools against a REAL in-memory symbol index.
 *
 * The mock-DB tests in prepare-change.test.ts / prepare-create.test.ts never
 * execute the SQL, so they missed two production defects:
 *   • method-signature/eligibility queries referenced a non-existent
 *     `parentName` column (DB column is `parent_name`) — the thrown error was
 *     swallowed and the sections silently degraded to "(not found)"
 *   • several lookups used `name = ? COLLATE NOCASE` / unindexed LIKE shapes
 *     that full-scan the symbols table (80–278 s on a production-size DB,
 *     blocking the event loop until MCP clients kill the server)
 * These tests run the real queries end-to-end so an invalid column, index
 * name (INDEXED BY), or FTS query shape fails loudly.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { XppSymbolIndex } from '../../src/metadata/symbolIndex';
import { prepareChangeTool } from '../../src/tools/prepareChange';
import { prepareCreateTool } from '../../src/tools/prepareCreate';
import type { XppServerContext } from '../../src/types/context';

let index: XppSymbolIndex;
let context: XppServerContext;

const symbol = (over: Record<string, unknown>) => ({
  name: '',
  type: 'class',
  filePath: '/x.xml',
  model: 'ApplicationSuite',
  ...over,
}) as any;

beforeAll(() => {
  index = new XppSymbolIndex(':memory:', ':memory:');

  index.addSymbol(symbol({ name: 'CustTable', type: 'table' }));
  index.addSymbol(symbol({
    name: 'validateWrite', type: 'method', parentName: 'CustTable',
    signature: 'boolean validateWrite()',
  }));
  index.addSymbol(symbol({
    name: 'doUpdate', type: 'method', parentName: 'CustTable',
    signature: 'void doUpdate()', tags: 'hookable:false',
  }));
  index.addSymbol(symbol({ name: 'CustTableCredMan_Extension', type: 'class-extension' }));
  index.addSymbol(symbol({
    name: 'CustParameters', type: 'table', description: 'Parameter table for AR',
  }));
  index.addSymbol(symbol({ name: 'AccountNum', type: 'edt', signature: 'SysString' }));

  index.addLabel({
    labelId: 'ImportParameters', labelFileId: 'SYS', model: 'ApplicationSuite',
    language: 'en-US', text: 'Import parameters', filePath: '/labels.xml',
  });

  context = { symbolIndex: index, bridge: undefined } as unknown as XppServerContext;
});

afterAll(() => {
  index.close();
});

const req = (name: string, args: Record<string, unknown>) => ({
  method: 'tools/call' as const,
  params: { name, arguments: args },
});

describe('prepare_change with a real index', () => {
  it('returns the real method signature (regression: parentName vs parent_name column)', async () => {
    const result = await prepareChangeTool(
      req('prepare_change', {
        goal: 'Add CoC on validateWrite',
        objectName: 'CustTable',
        methodName: 'validateWrite',
      }),
      context,
    );
    const text = result.content?.[0]?.text ?? '';
    expect(text).toContain('boolean validateWrite()');
    expect(text).toContain('✅ Method appears CoC-eligible');
    expect(text).not.toContain('(not found in symbol index)');
  });

  it('resolves canonical casing + type for lowercase input (FTS fallback path)', async () => {
    const result = await prepareChangeTool(
      req('prepare_change', {
        goal: 'Wrap validateWrite on custtable',
        objectName: 'custtable',
        methodName: 'validateWrite',
      }),
      context,
    );
    const text = result.content?.[0]?.text ?? '';
    expect(text).toContain('context for `CustTable`');
    expect(text).toContain('**Object type (resolved):** table');
    expect(text).toContain('boolean validateWrite()');
  });

  it('reports Hookable(false) methods as blocked', async () => {
    const result = await prepareChangeTool(
      req('prepare_change', {
        goal: 'Wrap doUpdate',
        objectName: 'CustTable',
        methodName: 'doUpdate',
      }),
      context,
    );
    const text = result.content?.[0]?.text ?? '';
    expect(text).toContain('[Hookable(false)]');
  });

  it('flags an existing proposedName via the index', async () => {
    const result = await prepareChangeTool(
      req('prepare_change', {
        goal: 'Extend CustTable',
        objectName: 'CustTable',
        proposedName: 'CustTableCredMan_Extension',
      }),
      context,
    );
    const text = result.content?.[0]?.text ?? '';
    expect(text).toContain('already exists in model');
  });
});

describe('prepare_create with a real index', () => {
  it('finds similar objects and EDT suggestions (regression: INDEXED BY query shapes)', async () => {
    const result = await prepareCreateTool(
      req('prepare_create', {
        goal: 'Parameter table for the import feature',
        objectName: 'ImportParameters',
        objectType: 'table',
        fieldsHint: ['CustAccount'],
      }),
      context,
    );
    const text = result.content?.[0]?.text ?? '';
    expect(result.isError).toBeFalsy();
    expect(text).toContain('CustParameters');       // similar object via idx_type_name
    expect(text).toContain('AccountNum');           // EDT suggestion via idx_type_name
  });
});

describe('searchLabels language routing', () => {
  it("treats 'en-us' as the FTS-indexed language (regression: case-sensitive compare → LIKE full scan)", () => {
    const rows = index.searchLabels('Import parameters', { language: 'en-us', limit: 5 });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].labelId).toBe('ImportParameters');
  });
});
