import { describe, it, expect } from 'vitest';
import { canBridgeCreate } from '../../src/bridge/bridgeAdapter';

describe('canBridgeCreate', () => {
  it('excludes security-privilege/security-duty/security-role (TOOL_DEFECT)', () => {
    // Regression: the bridge's generic properties:Dictionary<string,string> channel
    // has no way to carry EntryPoints/DataEntityPermissions/Privileges/Duties —
    // these types must fall through to the local XML generator instead, which
    // builds them correctly (eval case L4-entity-security, 2026-06-30). A bridge
    // create for these types previously "succeeded" while silently producing an
    // empty, functionally-broken privilege/duty/role.
    expect(canBridgeCreate('security-privilege')).toBe(false);
    expect(canBridgeCreate('security-duty')).toBe(false);
    expect(canBridgeCreate('security-role')).toBe(false);
  });

  it('excludes query/view (TOOL_DEFECT)', () => {
    // Regression: the bridge accepted dataSource/query as scalar properties
    // and reported success, but produced an empty query/view that can select
    // nothing (Phase 6 query+view eval case, 2026-07-01).
    expect(canBridgeCreate('query')).toBe(false);
    expect(canBridgeCreate('view')).toBe(false);
  });

  it('still accepts the core bridge-backed types', () => {
    expect(canBridgeCreate('class')).toBe(true);
    expect(canBridgeCreate('table')).toBe(true);
    expect(canBridgeCreate('form')).toBe(true);
    expect(canBridgeCreate('menu-item-display')).toBe(true);
    expect(canBridgeCreate('Table')).toBe(true);
  });

  it('rejects complex types that always use TypeScript XML generation', () => {
    expect(canBridgeCreate('report')).toBe(false);
    expect(canBridgeCreate('data-entity')).toBe(false);
    expect(canBridgeCreate('business-event')).toBe(false);
  });
});
