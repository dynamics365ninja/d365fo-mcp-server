/**
 * The "signatures only" hint on a compact class listing (#914 and its audit).
 *
 * A compact class view is signatures with no bodies, and it is the DEFAULT, so
 * for a caller who never read the tool schema it is indistinguishable from "no
 * source is available for this class" — which for a standard Microsoft class is
 * a dead end, since there is no workspace copy to check against. The hint says
 * which of the two it is.
 *
 * What it must NOT do is promise something the follow-up call cannot deliver:
 * a class whose bridge methods carry no source renders FEWER bytes with
 * compact:false than without it, so pointing there costs a round trip to lose
 * information. And it must not name `get_method(include="signature")`, which is
 * the one include value that returns a signature instead of a body, on a tool
 * that is no longer published in ListTools.
 */
import { describe, it, expect } from 'vitest';
import { tryBridgeClass } from '../../src/bridge/bridgeAdapter.js';
import { COMPACT_METHODS_HINT } from '../../src/utils/methodBodyHint.js';
import type { BridgeClassInfo, BridgeMethodInfo } from '../../src/bridge/bridgeTypes.js';

function method(name: string, source?: string): BridgeMethodInfo {
  return { name, returnType: 'void', source } as BridgeMethodInfo;
}

function classInfo(methods: BridgeMethodInfo[]): BridgeClassInfo {
  return {
    name: 'CustPostInvoice',
    isAbstract: false,
    isFinal: false,
    isStatic: false,
    model: 'ApplicationSuite',
    methods,
  } as BridgeClassInfo;
}

/** Minimal stand-in for the bridge client tryBridgeClass talks to. */
function fakeBridge(cls: BridgeClassInfo): any {
  return { isReady: true, metadataAvailable: true, readClass: async () => cls };
}

async function render(cls: BridgeClassInfo, compact: boolean, methodOffset = 0): Promise<string> {
  const result = await tryBridgeClass(fakeBridge(cls), cls.name, compact, methodOffset);
  return (result!.content[0] as { text: string }).text;
}

describe('compact class listing hint', () => {
  it('tells the caller bodies were withheld rather than absent', async () => {
    const out = await render(classInfo([method('run', 'public void run() { info("x"); }')]), true);

    expect(out).toContain(COMPACT_METHODS_HINT);
  });

  it('stays out of the way when bodies were actually asked for', async () => {
    const out = await render(classInfo([method('run', 'public void run() { info("x"); }')]), false);

    expect(out).not.toContain(COMPACT_METHODS_HINT);
  });

  it('does not offer compact:false for a class whose methods carry no source', async () => {
    // Bridge method source is Safe(() => method.Source) and `source` is
    // optional, so this is a real shape. The compact:false render of the same
    // class emits `### run` and no code block at all — strictly less than the
    // signature line compact already gave, for one more round trip.
    const cls = classInfo([method('run'), method('validate')]);
    const compactOut = await render(cls, true);
    const verboseOut = await render(cls, false);

    expect(compactOut).not.toContain(COMPACT_METHODS_HINT);
    expect(verboseOut).not.toContain('```xpp');
  });

  it('does not claim "signatures only" on a page that rendered no signatures', async () => {
    // An out-of-range methodOffset slices to nothing; there is no signature on
    // the page for the hint to be describing.
    const cls = classInfo([method('run', 'public void run() {}')]);
    const out = await render(cls, true, 30);

    expect(out).not.toContain(COMPACT_METHODS_HINT);
  });

  it('never points at get_method(include="signature") for a body', async () => {
    // That include value returns the signature INSTEAD of the body, and
    // get_method is no longer published in ListTools — an agent following it
    // either gets no body or calls a name it cannot see.
    const long = `public void run()\n{\n${'    info("x");\n'.repeat(80)}}`;
    const compactOut = await render(classInfo([method('run', long)]), true);
    const verboseOut = await render(classInfo([method('run', long)]), false);

    expect(compactOut).not.toContain('get_method(include=');
    expect(verboseOut).not.toContain('get_method(include=');
    // The truncated body still has to say how to get the rest of it.
    expect(verboseOut).toContain('"include":"source"');
  });
});

/**
 * The hint is advice about how to call the tool, not a fact about one object,
 * but only the per-class renderer knows whether bodies were withheld. The
 * plural form fans out to as many as MAX_OBJECTS=10 readers, so without a
 * dedupe a ten-class batch carries ten identical copies of the same two lines
 * of call syntax — in the very response format that exists to save round trips.
 */
describe('compact hint in a multi-object response', () => {
  it('says it once, not once per class', async () => {
    const withSource = (name: string) => ({
      name, isAbstract: false, isFinal: false, isStatic: false, model: 'ApplicationSuite',
      methods: [{ name: 'run', returnType: 'void', source: 'public void run() { info("x"); }' }],
    });
    const classes: Record<string, any> = {
      CustPostInvoice: withSource('CustPostInvoice'),
      VendPostInvoice: withSource('VendPostInvoice'),
      SalesPostInvoice: withSource('SalesPostInvoice'),
    };
    const context: any = {
      bridge: { isReady: true, metadataAvailable: true, readClass: async (n: string) => classes[n] },
    };

    const { getObjectInfoTool } = await import('../../src/tools/readers/getObjectInfo.js');
    const result: any = await getObjectInfoTool({
      method: 'tools/call',
      params: {
        name: 'get_object_info',
        arguments: {
          objects: Object.keys(classes).map(name => ({ objectType: 'class', objectName: name })),
        },
      },
    } as any, context);

    const text: string = result.content[0].text;
    // Every class is still there — the dedupe must drop the repeated advice,
    // not any of the metadata that made the batch worth requesting.
    for (const name of Object.keys(classes)) expect(text).toContain(name);
    expect(text.split(COMPACT_METHODS_HINT).length - 1).toBe(1);
  });
});
