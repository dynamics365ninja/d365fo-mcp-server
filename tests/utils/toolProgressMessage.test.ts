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
