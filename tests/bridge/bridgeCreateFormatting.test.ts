/**
 * X++ handed to the bridge gets the same treatment as X++ handed to the XML writer.
 *
 * `ensureXppDocComment` was wired into the XML fallback only, so the SAME
 * `d365fo_file(action="create", objectType="class")` produced a documented class
 * when the bridge was down and an undocumented one when it was up. The undocumented
 * one then failed `run_bp_check` on `BPXmlDocNoDocumentationComments`, and the
 * repair was two hand-edits of the AOT XML with a plain text tool — the bypass this
 * server exists to remove.
 */

import { describe, it, expect, vi } from 'vitest';
import { bridgeCreateObject, bridgeAddMethod } from '../../src/bridge/bridgeAdapter';

const stubBridge = (capture: (params: any) => void) => ({
  isReady: true,
  metadataAvailable: true,
  createObject: vi.fn(async (params: any) => {
    capture(params);
    return { success: true, filePath: 'K:\\x\\MyClass.xml', api: 'IMetaClassProvider.Create' };
  }),
  addMethod: vi.fn(async (_t: string, _o: string, _m: string, source: string) => {
    capture({ methods: [{ name: _m, source }] });
    return { success: true, api: 'IMetaClassProvider.Update' };
  }),
}) as any;

describe('bridgeCreateObject — doc comments and indentation', () => {
  it('adds the doc comment BP asks for to a declaration and to every method', async () => {
    let sent: any;
    const bridge = stubBridge(p => { sent = p; });

    await bridgeCreateObject(bridge, {
      objectType: 'class',
      objectName: 'MyTable_Extension',
      modelName: 'MyModel',
      declaration: '[ExtensionOf(tableStr(MyTable))]\nfinal class MyTable_Extension\n{\n}',
      methods: [{ name: 'validateWrite', source: 'public boolean validateWrite()\n{\nreturn next validateWrite();\n}' }],
    });

    expect(sent.declaration).toContain('/// <summary>');
    expect(sent.methods[0].source).toContain('/// <summary>');
    // The attribute must stay attached to the class, not be pushed in a level.
    expect(sent.declaration).toContain('[ExtensionOf(tableStr(MyTable))]\nfinal class MyTable_Extension');
  });

  it('re-indents the method body to the shipped convention', async () => {
    let sent: any;
    const bridge = stubBridge(p => { sent = p; });

    await bridgeCreateObject(bridge, {
      objectType: 'class',
      objectName: 'MyClass',
      modelName: 'MyModel',
      methods: [{ name: 'm', source: 'public void m()\n{\nx = 1;\n}' }],
    });

    expect(sent.methods[0].source).toContain('    public void m()');
    expect(sent.methods[0].source).toContain('        x = 1;');
  });

  it('keeps the indentation of a wrapped statement instead of flattening it', async () => {
    let sent: any;
    const bridge = stubBridge(p => { sent = p; });

    await bridgeCreateObject(bridge, {
      objectType: 'class',
      objectName: 'MyClass',
      modelName: 'MyModel',
      methods: [{
        name: 'm',
        source: 'public void m()\n{\n    select firstonly t\n        where t.RecId == this.RecId;\n}',
      }],
    });

    expect(sent.methods[0].source).toContain('        select firstonly t\n            where t.RecId == this.RecId;');
  });

  it('leaves already-documented, already-formatted source alone', async () => {
    let first: any;
    let second: any;
    const source = 'public void m()\n{\nx = 1;\n}';

    await bridgeCreateObject(stubBridge(p => { first = p; }), {
      objectType: 'class', objectName: 'MyClass', modelName: 'MyModel',
      methods: [{ name: 'm', source }],
    });
    await bridgeCreateObject(stubBridge(p => { second = p; }), {
      objectType: 'class', objectName: 'MyClass', modelName: 'MyModel',
      methods: [{ name: 'm', source: first.methods[0].source }],
    });

    expect(second.methods[0].source).toBe(first.methods[0].source);
  });

  it('documents a method added through the bridge too', async () => {
    let sent: any;
    const bridge = stubBridge(p => { sent = p; });

    await bridgeAddMethod(bridge, 'class', 'MyClass', 'm', 'public void m()\n{\nx = 1;\n}');

    expect(sent.methods[0].source).toContain('/// <summary>');
    expect(sent.methods[0].source).toContain('    public void m()');
  });
});
