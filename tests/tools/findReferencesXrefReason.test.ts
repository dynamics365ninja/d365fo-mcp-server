/**
 * find_references — why there were no cross-references, said precisely.
 *
 * Both reasons used to read "the cross-reference bridge is unavailable in this
 * server mode", which sounds like a limitation of the mode. Seen on a
 * traditional VM: the bridge was running, and only the cross-reference database
 * had never been configured (no XPP config names it there). The fix is a
 * setting, so the text has to name it. A bridge that is not connected at all is
 * a different fault, with a different fix.
 */
import { describe, expect, it } from 'vitest';
import { findReferencesTool } from '../../src/tools/analysis/findReferences';

const emptyDb = { prepare: () => ({ get: () => undefined, all: () => [] }) };

const run = async (args: Record<string, unknown>, bridge?: unknown, bridgeStartup?: unknown) =>
  (await findReferencesTool(
    { method: 'tools/call', params: { name: 'find_references', arguments: args } } as any,
    { symbolIndex: { getReadDb: () => emptyDb, db: emptyDb }, bridge, bridgeStartup } as any,
  )).content[0].text as string;

const bridgeWithoutXref = { isReady: true, metadataAvailable: true, xrefAvailable: false };

describe('find_references — the reason for the name-based fallback', () => {
  it('names the settings when the bridge runs without a cross-reference database', async () => {
    const text = await run({ targetName: 'SomeName', targetType: 'class' }, bridgeWithoutXref);

    expect(text).toContain('runs without a cross-reference database');
    // The database name alone is not enough: a configured name on the wrong server is not reached either.
    expect(text).toContain('`D365FO_XREF_DB_NAME`');
    expect(text).toContain('`D365FO_XREF_DB_SERVER`');
    expect(text).toContain('restart the MCP server');
    expect(text).not.toContain('server mode');
  });

  it('says the bridge is not connected when there is none', async () => {
    const text = await run({ targetName: 'SomeName', targetType: 'class' }, undefined);

    expect(text).toContain('bridge is not connected');
    expect(text).not.toContain('D365FO_XREF_DB_NAME');
    expect(text).not.toContain('server mode');
  });

  it('says the bridge is not connected when it exists but is not ready', async () => {
    // A bridge process that crashed after startup: the object is still there.
    const text = await run({ targetName: 'SomeName', targetType: 'class' }, { ...bridgeWithoutXref, isReady: false });

    expect(text).toContain('bridge is not connected');
    expect(text).not.toContain('D365FO_XREF_DB_NAME');
  });

  it('says the bridge is still starting when its startup has not settled', async () => {
    // Reporting this as "not connected" sends the reader to fix a config that is fine (#826).
    const startup = { done: new Promise<void>(() => {}), settled: false };
    const text = await run({ targetName: 'SomeName', targetType: 'class' }, undefined, startup);

    expect(text).toContain('still starting');
    expect(text).toContain('Retry the identical call');
    expect(text).not.toContain('not connected');
    expect(text).not.toContain('D365FO_XREF_DB_NAME');
  });

  it('gives a targetType the fallback cannot search the same reason', async () => {
    const text = await run({ targetName: 'EcoResDescription', targetType: 'edt' }, bridgeWithoutXref);

    expect(text).toContain('inconclusive');
    expect(text).toContain('D365FO_XREF_DB_NAME');
  });
});

describe('find_references — the reason a label where-used could not run', () => {
  it('names the setting when the bridge runs without a cross-reference database', async () => {
    const text = await run({ targetName: '@SYS12345' }, bridgeWithoutXref);

    expect(text).toContain('D365FO_XREF_DB_NAME');
    expect(text).not.toContain('server mode');
  });

  it('says the bridge is not connected when there is none', async () => {
    const text = await run({ targetName: '@SYS12345' }, undefined);

    expect(text).toContain('bridge is not connected');
    expect(text).not.toContain('server mode');
  });
});
