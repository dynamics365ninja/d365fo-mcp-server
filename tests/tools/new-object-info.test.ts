/**
 * Tests for the new object-info tools:
 *   get_service_info, get_map_info, get_config_key_info,
 *   get_security_policy_info, get_macro_info
 *
 * Each tool reads the SQLite index via context.symbolIndex.getReadDb(); these
 * tests route mock query results by a substring of the SQL text.
 */

import { describe, it, expect, vi } from 'vitest';
import { getServiceInfoTool } from '../../src/tools/serviceInfo';
import { getMapInfoTool } from '../../src/tools/mapInfo';
import { getConfigKeyInfoTool } from '../../src/tools/configKeyInfo';
import { getSecurityPolicyInfoTool } from '../../src/tools/securityPolicyInfo';
import { getMacroInfoTool } from '../../src/tools/macroInfo';
import { getObjectInfoTool } from '../../src/tools/getObjectInfo';
import type { XppServerContext } from '../../src/types/context';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';

const req = (name: string, args: Record<string, unknown> = {}): CallToolRequest => ({
  method: 'tools/call',
  params: { name, arguments: args },
});

/**
 * Build a db whose prepare(sql) returns a statement that resolves get()/all()
 * by matching the first routing rule whose `match` substring appears in the SQL.
 *
 * Note: tools that resolve an object name go through symbolLookup (see #686),
 * whose exact-case probe is `SELECT ... FROM symbols s WHERE s.name = ? ...`
 * and returns rows via all() — so route those on 'FROM symbols s' with `all`,
 * not on a `type = '<x>'` literal (the type is a bound parameter there).
 */
type Route = { match: string; get?: any; all?: any[] };
const routedDb = (routes: Route[]) => ({
  prepare: vi.fn((sql: string) => {
    const r = routes.find(rt => sql.includes(rt.match));
    return {
      get: vi.fn(() => r?.get),
      all: vi.fn(() => r?.all ?? []),
      run: vi.fn(() => ({ changes: 0 })),
    };
  }),
});

const ctx = (db: any): XppServerContext => ({
  symbolIndex: { getReadDb: vi.fn(() => db) } as any,
  parser: {} as any,
  cache: {} as any,
  workspaceScanner: {} as any,
  hybridSearch: {} as any,
});

describe('get_service_info', () => {
  it('reports class, group and computed endpoint (happy path)', async () => {
    const db = routedDb([
      { match: "type = 'service'", get: { name: 'FooService', signature: 'FooServiceClass', description: 'FooExt', model: 'M', file_path: 'p' } },
      { match: 'FROM service_operations', all: [{ operation_name: 'doIt', method_name: 'doIt', idempotent: 1 }] },
      { match: 'FROM service_group_members', all: [{ group_name: 'FooGroup' }] },
    ]);
    const res = await getServiceInfoTool(req('get_service_info', { serviceName: 'FooService' }), ctx(db));
    const text = res.content[0].text;
    expect(res.isError).toBeFalsy();
    expect(text).toContain('FooServiceClass');
    expect(text).toContain('/api/services/FooGroup/FooService/doIt');
  });

  it('returns error when service not found', async () => {
    const res = await getServiceInfoTool(req('get_service_info', { serviceName: 'Nope' }), ctx(routedDb([])));
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('not found');
  });

  it('rejects missing required arg', async () => {
    const res = await getServiceInfoTool(req('get_service_info', {}), ctx(routedDb([])));
    expect(res.isError).toBe(true);
  });
});

describe('get_map_info', () => {
  it('lists mapped tables (happy path)', async () => {
    const db = routedDb([
      { match: 'FROM symbols s', all: [{ name: 'LogMap', type: 'map', extends_class: 'common', model: 'M', file_path: 'p' }] },
      { match: 'FROM map_mappings', all: [{ mapping_table: 'SysDataBaseLog', field_connections: 4 }] },
    ]);
    const res = await getMapInfoTool(req('get_map_info', { mapName: 'LogMap' }), ctx(db));
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain('SysDataBaseLog');
  });

  it('returns error when map not found', async () => {
    const res = await getMapInfoTool(req('get_map_info', { mapName: 'Nope' }), ctx(routedDb([])));
    expect(res.isError).toBe(true);
  });
});

describe('get_config_key_info', () => {
  it('shows parent chain and children (happy path)', async () => {
    const db = routedDb([
      { match: "type = 'configuration-key' LIMIT 1", get: { name: 'Child', description: '@SYS1', signature: 'Parent', model: 'M', file_path: 'p' } },
      { match: "signature = ?", all: [{ name: 'GrandChild' }] },
    ]);
    const res = await getConfigKeyInfoTool(req('get_config_key_info', { name: 'Child' }), ctx(db));
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain('Parent');
  });

  it('falls back to license code when not a config key', async () => {
    const db = routedDb([
      { match: "type = 'license-code'", get: { name: 'LimitedDevices', description: '@SYS2', signature: 'Access / Number', model: 'M', file_path: 'p' } },
    ]);
    const res = await getConfigKeyInfoTool(req('get_config_key_info', { name: 'LimitedDevices' }), ctx(db));
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain('AxLicenseCode');
  });

  it('returns error when neither found', async () => {
    const res = await getConfigKeyInfoTool(req('get_config_key_info', { name: 'Nope' }), ctx(routedDb([])));
    expect(res.isError).toBe(true);
  });
});

describe('get_security_policy_info', () => {
  it('shows primary table and operation (happy path)', async () => {
    const db = routedDb([
      { match: 'FROM security_policies', get: { policy_name: 'P', primary_table: 'DMFDefinitionGroup', query_name: 'Q', operation: 'AllOperations', constrained_table: 1, label: '@SYS1', model: 'M' } },
      { match: "type = 'security-policy'", get: { file_path: 'p' } },
    ]);
    const res = await getSecurityPolicyInfoTool(req('get_security_policy_info', { policyName: 'P' }), ctx(db));
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain('DMFDefinitionGroup');
  });

  it('returns error when policy not found', async () => {
    const res = await getSecurityPolicyInfoTool(req('get_security_policy_info', { policyName: 'Nope' }), ctx(routedDb([])));
    expect(res.isError).toBe(true);
  });
});

describe('get_macro_info', () => {
  it('lists defines and applies filter (happy path)', async () => {
    const db = routedDb([
      { match: 'FROM symbols s', all: [{ name: 'AOT', type: 'macro', model: 'M', file_path: 'p' }] },
      { match: 'FROM macro_defines', all: [
        { define_name: 'TablesPath', define_value: "'\\Tables'" },
        { define_name: 'ViewsPath', define_value: "'\\Views'" },
      ] },
    ]);
    const res = await getMacroInfoTool(req('get_macro_info', { macroName: 'AOT', filter: 'Tables' }), ctx(db));
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain('#AOT.TablesPath');
    expect(res.content[0].text).not.toContain('#AOT.ViewsPath');
  });

  it('returns error when macro library not found', async () => {
    const res = await getMacroInfoTool(req('get_macro_info', { macroName: 'Nope' }), ctx(routedDb([])));
    expect(res.isError).toBe(true);
  });
});

describe('get_object_info (unified dispatch)', () => {
  it('dispatches to the map reader for objectType=map', async () => {
    const db = routedDb([
      { match: 'FROM symbols s', all: [{ name: 'LogMap', type: 'map', extends_class: 'common', model: 'M', file_path: 'p' }] },
      { match: 'FROM map_mappings', all: [{ mapping_table: 'SysDataBaseLog', field_connections: 4 }] },
    ]);
    const res = await getObjectInfoTool(req('get_object_info', { objectType: 'map', name: 'LogMap' }), ctx(db));
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain('SysDataBaseLog');
  });

  it('forwards options to the underlying reader (macro filter)', async () => {
    const db = routedDb([
      { match: 'FROM symbols s', all: [{ name: 'AOT', type: 'macro', model: 'M', file_path: 'p' }] },
      { match: 'FROM macro_defines', all: [
        { define_name: 'TablesPath', define_value: "'\\Tables'" },
        { define_name: 'ViewsPath', define_value: "'\\Views'" },
      ] },
    ]);
    const res = await getObjectInfoTool(req('get_object_info', { objectType: 'macro', name: 'AOT', options: { filter: 'Tables' } }), ctx(db));
    expect(res.content[0].text).toContain('#AOT.TablesPath');
    expect(res.content[0].text).not.toContain('#AOT.ViewsPath');
  });

  it('rejects an unsupported objectType', async () => {
    const res = await getObjectInfoTool(req('get_object_info', { objectType: 'widget', name: 'X' }), ctx(routedDb([])));
    expect(res.isError).toBe(true);
  });

  it('rejects missing name', async () => {
    const res = await getObjectInfoTool(req('get_object_info', { objectType: 'table' }), ctx(routedDb([])));
    expect(res.isError).toBe(true);
  });
});
