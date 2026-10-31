/**
 * find_references in write-only mode — the local companion of a hybrid setup.
 *
 * The shared read-only server holds the symbol index but no C# bridge, so it can
 * only search by name. The companion runs the bridge, and so is the only server
 * that reaches the cross-reference database (DYNAMICSXREFDB) — but its index is an
 * empty in-memory stub. So here the tool answers from the bridge, and wherever full
 * mode would run the name-based scan it points to the shared server instead of
 * scanning nothing and reporting a zero.
 */
import { describe, expect, it, vi } from 'vitest';
import { findReferencesTool } from '../../src/tools/analysis/findReferences';
import type { ServerMode } from '../../src/server/serverMode';

/** The write-only index: empty, every query matches nothing. */
const emptyDb = { prepare: () => ({ get: () => undefined, all: () => [] }) };

function xrefBridge(refsByPath: Record<string, number> = {}, opts: { throws?: boolean } = {}) {
  return {
    isReady: true,
    metadataAvailable: true,
    xrefAvailable: true,
    findReferences: vi.fn(async (path: string) => {
      if (opts.throws) throw new Error('SQL timeout');
      const n = refsByPath[path] ?? 0;
      return {
        objectPath: path, count: n,
        references: Array.from({ length: n }, (_, i) => ({
          sourcePath: `/Classes/Caller${i}/Methods/run`, sourceModule: 'M', line: 10 + i, column: 1,
          referenceType: 'call', callerClass: `Caller${i}`, callerMethod: 'run',
        })),
      };
    }),
  };
}

const call = (args: Record<string, unknown>, bridge: unknown, mode: ServerMode = 'write-only') =>
  findReferencesTool(
    { method: 'tools/call', params: { name: 'find_references', arguments: args } } as any,
    { symbolIndex: { getReadDb: () => emptyDb, db: emptyDb }, bridge } as any,
    mode,
  ) as Promise<{ content: Array<{ text: string }>; isError?: boolean }>;

const text = async (args: Record<string, unknown>, bridge: unknown, mode?: ServerMode) =>
  (await call(args, bridge, mode)).content[0].text;

const SHARED_SERVER = 'on the shared (read-only) server';

describe('find_references in write-only mode — answered by the bridge', () => {
  it('scopes a typed name to its container without the index', async () => {
    const bridge = xrefBridge({ '/Tables/ContosoTable': 3 });
    const out = await text({ targetName: 'ContosoTable', targetType: 'table' }, bridge);

    expect(bridge.findReferences).toHaveBeenCalledWith('/Tables/ContosoTable');
    expect(out).toContain('C# bridge (DYNAMICSXREFDB)');
    expect(out).not.toContain(SHARED_SERVER);
  });

  it('hands an untyped bare name to the bridge, which tries every type container itself', async () => {
    const bridge = xrefBridge({ ContosoTable: 2 });
    const out = await text({ targetName: 'ContosoTable' }, bridge);

    expect(bridge.findReferences).toHaveBeenCalledWith('ContosoTable');
    expect(out).toContain('C# bridge (DYNAMICSXREFDB)');
  });

  it('hands an untyped "Owner.member" to the bridge, which expands it across containers', async () => {
    const bridge = xrefBridge({ 'ContosoTable.validateWrite': 4 });
    const out = await text({ targetName: 'ContosoTable.validateWrite' }, bridge);

    expect(bridge.findReferences).toHaveBeenCalledWith('ContosoTable.validateWrite');
    expect(out).toContain('C# bridge (DYNAMICSXREFDB)');
  });

  it('answers an AOT path as given', async () => {
    const path = '/Classes/ContosoHelper/Methods/run';
    const bridge = xrefBridge({ [path]: 1 });
    const out = await text({ targetName: path }, bridge);

    expect(bridge.findReferences).toHaveBeenCalledWith(path);
    expect(out).toContain('C# bridge (DYNAMICSXREFDB)');
  });

  it('says in the headline that a zero for "Owner.method" left out methods added by [ExtensionOf] classes', async () => {
    // Seen on a VM: 0 for Owner.method, 12 callers on the extension class's path.
    for (const args of [
      { targetName: 'ContosoTable.contosoCheck', targetType: 'method' },
      { targetName: 'ContosoTable.contosoCheck' },
      { targetName: 'contosoCheck', ownerName: 'ContosoTable' },
    ]) {
      const out = await text(args, xrefBridge());
      const headline = out.split('\n').find(l => l.startsWith('**'));

      expect(headline, JSON.stringify(args)).toBe(
        '**Result:** 0 on `ContosoTable` itself — methods added by [ExtensionOf] classes were NOT searched');
      expect(out).not.toContain('Total References Found');
      expect(out).toContain('/Classes/<ExtensionClass>/Methods/contosoCheck');
      expect(out).toContain(SHARED_SERVER);
    }
  });

  it('keeps the plain zero for a field: the bridge itself adds the fields of table extensions', async () => {
    const out = await text({ targetName: 'ContosoTable.contosoField', targetType: 'field' }, xrefBridge());

    expect(out).toContain('**Total References Found:** 0');
    expect(out).not.toContain('[ExtensionOf]');
  });
});

describe('find_references in write-only mode — the pointer to the shared server', () => {
  it('does not send a bare method name to the bridge: only the index knows its declaring types', async () => {
    const bridge = xrefBridge();
    const result = await call({ targetName: 'contosoCheck', targetType: 'method' }, bridge);
    const out = result.content[0].text;

    expect(bridge.findReferences).not.toHaveBeenCalled();
    expect(out).toContain('NOT a count of zero');
    expect(out).toContain(SHARED_SERVER);
    expect(out).toContain('`Owner.contosoCheck`');
    expect(result.isError).toBe(false);
  });

  it('says that no rows is not proof of no use, instead of scanning an empty index', async () => {
    const out = await text({ targetName: 'contosoCheck' }, xrefBridge());

    expect(out).toContain('NOT proof that it is unused');
    expect(out).toContain('returned no rows');
    expect(out).toContain(SHARED_SERVER);
    expect(out).toContain('pass `Owner.contosoCheck`');
    expect(out).toContain('last Visual Studio build');
    expect(out).not.toContain('name-based index scan');
  });

  it('points to the shared server when there is no bridge', async () => {
    const out = await text({ targetName: 'ContosoTable', targetType: 'table' }, undefined);

    expect(out).toContain('NOT a count of zero');
    expect(out).toContain('bridge is not connected');
    expect(out).toContain(SHARED_SERVER);
    expect(out).not.toContain('name-based index scan');
  });

  it('points to the shared server and names the settings when the bridge has no xref database', async () => {
    const bridge = { isReady: true, metadataAvailable: true, xrefAvailable: false };
    const out = await text({ targetName: 'ContosoTable.validateWrite' }, bridge);

    expect(out).toContain('runs without a cross-reference database');
    expect(out).toContain('`D365FO_XREF_DB_NAME`');
    expect(out).toContain(SHARED_SERVER);
  });

  it('points to the shared server, as an error, when the xref query fails', async () => {
    const result = await call({ targetName: 'ContosoTable', targetType: 'class' }, xrefBridge({}, { throws: true }));
    const out = result.content[0].text;

    expect(out).toContain('cross-reference query failed');
    expect(out).toContain('bridge log');
    expect(out).toContain(SHARED_SERVER);
    expect(result.isError).toBe(true);
  });
});

describe('find_references in write-only mode — answers that never used the name-based scan', () => {
  // The shared server has no bridge either, so it cannot answer these better.
  it('keeps the label answer', async () => {
    const out = await text({ targetName: '@SYS12345' }, { isReady: true, metadataAvailable: true, xrefAvailable: false });

    expect(out).toContain('Label where-used requires the cross-reference database');
    expect(out).not.toContain(SHARED_SERVER);
  });

  it('keeps the answer for a type the scan cannot search', async () => {
    const out = await text({ targetName: 'ContosoEdt', targetType: 'edt' }, undefined);

    expect(out).toContain('inconclusive');
    expect(out).not.toContain(SHARED_SERVER);
  });
});

describe('find_references outside write-only mode — unchanged', () => {
  for (const mode of ['full', 'read-only'] as const) {
    it(`${mode}: falls back to the name-based scan without the bridge`, async () => {
      const out = await text({ targetName: 'ContosoHelper', targetType: 'class' }, undefined, mode);

      expect(out).toContain('name-based index scan');
      expect(out).not.toContain('write-only');
    });

    it(`${mode}: sends a bare method name to the bridge as before`, async () => {
      const bridge = xrefBridge();
      await call({ targetName: 'contosoCheck', targetType: 'method' }, bridge, mode);

      expect(bridge.findReferences).toHaveBeenCalledWith('contosoCheck');
    });

    it(`${mode}: reports a zero for "Owner.method" without the [ExtensionOf] warning`, async () => {
      const out = await text({ targetName: 'ContosoTable.contosoCheck', targetType: 'method' }, xrefBridge(), mode);

      expect(out).toContain('**Total References Found:** 0');
      expect(out).not.toContain('[ExtensionOf]');
    });
  }
});
