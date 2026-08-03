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

  // The gate is the first thing a new op has to clear: implement it in C#, publish it in
  // the schema, and it still never reaches the bridge unless BRIDGE_MODIFY_OPS knows it.
  it('accepts the collections that add-index / add-relation cannot reach', () => {
    for (const type of ['table', 'table-extension']) {
      expect(canBridgeModify(type, 'add-full-text-index')).toBe(true);
      expect(canBridgeModify(type, 'remove-full-text-index')).toBe(true);
      expect(canBridgeModify(type, 'add-table-mapping')).toBe(true);
      expect(canBridgeModify(type, 'remove-table-mapping')).toBe(true);
    }
  });

  it('routes modify-property on every extension type to the bridge', () => {
    // These write an <AxPropertyModification> through the provider. edt-extension was
    // missing from BRIDGE_MODIFY_TYPES, so it fell to the direct-XML writer, which can
    // only edit an element that already exists — a first-time override was unreachable.
    for (const type of ['table-extension', 'form-extension', 'enum-extension', 'edt-extension']) {
      expect(canBridgeModify(type, 'modify-property')).toBe(true);
    }
  });
});
