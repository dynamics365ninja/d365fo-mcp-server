import { describe, it, expect } from 'vitest';
import { buildProgressMessage } from '../../src/utils/toolProgressMessage.js';

describe('buildProgressMessage — d365fo_file modify labels', () => {
  it('reads op params nested under `params` (not just flat top level)', () => {
    const msg = buildProgressMessage('d365fo_file', {
      action: 'modify',
      operation: 'add-method',
      objectType: 'class',
      objectName: 'ConDemoCounterBump',
      params: { methodName: 'increment', sourceCode: 'public static void increment(str _n) {}' },
    });
    expect(msg).toBe('✏️ add-method "increment" on class ConDemoCounterBump');
  });

  it('falls back to the filePath basename when objectName is omitted', () => {
    const msg = buildProgressMessage('d365fo_file', {
      action: 'modify',
      operation: 'add-method',
      objectType: 'class',
      filePath: 'K:\\AOSService\\PackagesLocalDirectory\\Contoso\\Contoso\\AxClass\\ConDemoCounterBump.xml',
      params: { sourceCode: 'public static void increment(str _n) {}' },
    });
    // methodName omitted → derived from the source signature for the label
    expect(msg).toBe('✏️ add-method "increment" on class ConDemoCounterBump');
  });

  it('does not regress flat top-level params', () => {
    const msg = buildProgressMessage('d365fo_file', {
      action: 'modify',
      operation: 'add-field',
      objectType: 'table',
      objectName: 'ConDemoCounter',
      fieldName: 'CounterValue',
    });
    expect(msg).toBe('✏️ add-field "CounterValue" on table ConDemoCounter');
  });

  it('never emits blank name/object for add-method when both params and filePath given', () => {
    const msg = buildProgressMessage('d365fo_file', {
      action: 'modify',
      operation: 'add-method',
      objectType: 'class',
      filePath: '/tmp/AxClass/Foo.xml',
      params: { methodName: 'bar' },
    });
    expect(msg).toBe('✏️ add-method "bar" on class Foo');
    expect(msg).not.toContain('"" on');
  });
});

describe('buildProgressMessage — d365fo_file actions that create nothing', () => {
  // Each of these used to fall through to the create label.
  it('undo', () => {
    expect(buildProgressMessage('d365fo_file', { action: 'undo', filePath: 'K:\\X\\AxView\\CRView.xml' }))
      .toBe('↩️ Undoing changes to K:\\X\\AxView\\CRView.xml');
  });

  it('project add-object, with the operation nested in params', () => {
    const msg = buildProgressMessage('d365fo_file', {
      action: 'project', objectType: 'view', objectName: 'CRView',
      params: { operation: 'add-object', objectType: 'view', objectName: 'CRView' },
    });
    expect(msg).toBe('🗂️ Project add-object CRView');
  });

  it('delete', () => {
    expect(buildProgressMessage('d365fo_file', { action: 'delete', objectType: 'class', objectName: 'CRThing' }))
      .toBe('🗑️ Deleting class CRThing');
  });

  it('create keeps its label', () => {
    expect(buildProgressMessage('d365fo_file', { action: 'create', objectType: 'class', objectName: 'CRThing' }))
      .toBe('📁 Creating class CRThing');
  });
});
