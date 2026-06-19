import { describe, it, expect } from 'vitest';
import { canBridgeModify } from '../../src/bridge/bridgeAdapter';

describe('canBridgeModify', () => {
  it('accepts add-menu-item-to-menu on a menu (the only type it targets)', () => {
    // Regression: 'menu' was missing from BRIDGE_MODIFY_TYPES, so the op was
    // rejected before dispatch even though the C# bridge implements it.
    expect(canBridgeModify('menu', 'add-menu-item-to-menu')).toBe(true);
    expect(canBridgeModify('Menu', 'add-menu-item-to-menu')).toBe(true);
  });

  it('accepts the common type/operation combinations', () => {
    expect(canBridgeModify('table', 'add-index')).toBe(true);
    expect(canBridgeModify('table', 'add-relation')).toBe(true);
    expect(canBridgeModify('form', 'add-method')).toBe(true);
    expect(canBridgeModify('form-extension', 'add-data-source')).toBe(true);
    expect(canBridgeModify('enum', 'add-enum-value')).toBe(true);
  });

  it('rejects unknown object types and operations', () => {
    expect(canBridgeModify('bogus-type', 'add-method')).toBe(false);
    expect(canBridgeModify('table', 'bogus-operation')).toBe(false);
  });
});
