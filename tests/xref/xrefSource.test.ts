/**
 * Which cross-reference source answers (bridge → SQLite export → none), and the
 * tools on top of the SQLite provider: find_references, the CoC / event / API
 * usage lookups, the status shown by get_workspace_info and doctor.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  tryBridgeApiUsageCallers,
  tryBridgeCocExtensions,
  tryBridgeEventHandlers,
  tryBridgeReferences,
} from '../../src/bridge/bridgeAdapter';
import { checkXrefSqlite } from '../../src/cli/commands/doctor';
import { openStore, writeSetting } from '../../src/cli/settingsStore';
import { settingByPath } from '../../src/config/settings';
import { findReferencesTool } from '../../src/tools/analysis/findReferences';
import { getWorkspaceInfoTool } from '../../src/tools/readers/getWorkspaceInfo';
import {
  SqliteXrefProvider,
  XREF_META_REFS_WITHOUT_SOURCE_REMOVED,
  XREF_SQLITE_COUNT_CAP,
} from '../../src/xref/sqliteXrefProvider';
import { BRIDGE_SOURCE_LABEL, describeXrefSource, xrefSource, xrefSqliteFromEnv } from '../../src/xref/xrefSource';
import { K, VALID_META, buildXrefFixture, contosoRefs, manyRefs, tempDir } from './xrefFixture';

let dir: string;
let file: string;
const providers: SqliteXrefProvider[] = [];
const quiet = () => {};
const provider = (f = file) => {
  const p = new SqliteXrefProvider(f, quiet);
  providers.push(p);
  return p;
};

beforeEach(() => {
  dir = tempDir();
  file = path.join(dir, 'xref.db');
});

afterEach(() => {
  for (const p of providers.splice(0)) p.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const bridge = (xrefAvailable: boolean, isReady = true) => ({
  isReady,
  metadataAvailable: true,
  xrefAvailable,
  findReferences: vi.fn(async (p: string) => ({ objectPath: p, count: 0, total: 0, metadataTotal: 0, references: [] })),
  findExtensionClasses: vi.fn(async () => null),
  findEventSubscribers: vi.fn(async () => null),
  findApiUsageCallers: vi.fn(async () => null),
});

describe('selection order', () => {
  beforeEach(() => buildXrefFixture(file, { refs: contosoRefs() }));

  it('prefers a bridge that has DYNAMICSXREFDB, unchanged', () => {
    const b = bridge(true);
    expect(xrefSource({ bridge: b, xrefSqlite: provider() })).toBe(b);
  });

  it('uses the SQLite file when the bridge has no xref database, or there is no bridge', () => {
    const p = provider();
    expect(xrefSource({ bridge: bridge(false), xrefSqlite: p })).toBe(p);
    expect(xrefSource({ bridge: bridge(true, false), xrefSqlite: p })).toBe(p);
    expect(xrefSource({ xrefSqlite: p })).toBe(p);
  });

  it('falls back as before when the file is unusable: the bridge (unavailable) or nothing', () => {
    const b = bridge(false);
    expect(xrefSource({ bridge: b, xrefSqlite: provider(path.join(dir, 'absent.db')) })).toBe(b);
    expect(xrefSource({ xrefSqlite: provider(path.join(dir, 'absent.db')) })).toBeUndefined();
    expect(xrefSource({})).toBeUndefined();
  });

  it('creates the provider from D365FO_XREF_SQLITE_PATH without opening it', () => {
    expect(xrefSqliteFromEnv({})).toBeUndefined();
    expect(xrefSqliteFromEnv({ D365FO_XREF_SQLITE_PATH: '  ' })).toBeUndefined();
    const a = xrefSqliteFromEnv({ D365FO_XREF_SQLITE_PATH: path.join(dir, 'later.db') })!;
    expect(a).toBe(xrefSqliteFromEnv({ D365FO_XREF_SQLITE_PATH: path.join(dir, 'later.db') }));
    expect(fs.existsSync(path.join(dir, 'later.db'))).toBe(false);
    a.close();
  });
});

describe('the active source, for get_workspace_info', () => {
  it('shows the export date and module count of the SQLite file', () => {
    buildXrefFixture(file, { refs: contosoRefs() });
    const d = describeXrefSource({ xrefSqlite: provider() });
    expect(d.kind).toBe('sqlite');
    expect(d.line).toContain('exported 2026-10-30T12:00:00Z, 2 modules');
    expect(d.detail.join('\n')).toContain(file);
    expect(d.detail.join('\n')).toContain('Totals   : joined to Names, exact up to 20000 per lookup');
  });

  it('says when totals come from the index, and how many references the export left out', () => {
    buildXrefFixture(file, { refs: contosoRefs(), meta: { ...VALID_META, [XREF_META_REFS_WITHOUT_SOURCE_REMOVED]: '42' } });
    expect(describeXrefSource({ xrefSqlite: provider() }).detail.join('\n')).toContain(
      'Totals   : from the TargetId index, exact up to 500000 per lookup (the export left out 42 references without a source name)',
    );
  });

  it('names the bridge when it answers, and why the file is not used when it cannot be', () => {
    buildXrefFixture(file, { refs: contosoRefs(), meta: { ...VALID_META, schema: '9' } });
    expect(describeXrefSource({ bridge: bridge(true), xrefSqlite: provider() }).line).toContain(BRIDGE_SOURCE_LABEL);
    const none = describeXrefSource({ xrefSqlite: provider() });
    expect(none.kind).toBe('none');
    expect(none.line).toMatch(/not usable \(meta\.schema is '9'/);
    expect(describeXrefSource({}).line).toMatch(/^none/);
  });
});

describe('get_workspace_info', () => {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env.D365FO_MODEL_NAME;
    process.env.D365FO_MODEL_NAME = 'ContosoExt';
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.D365FO_MODEL_NAME;
    else process.env.D365FO_MODEL_NAME = saved;
  });
  const info = async (context: Record<string, unknown>, diagnostics = false) => {
    const ctx = {
      symbolIndex: {
        getLastIndexedAt: () => null,
        getReadDb: () => ({ prepare: () => ({ get: () => undefined, all: () => [] }) }),
      },
      ...context,
    };
    const r = (await getWorkspaceInfoTool(
      { params: { name: 'get_workspace_info', arguments: diagnostics ? { diagnostics: true } : {} } } as never,
      ctx as never,
    )) as { content: Array<{ text: string }> };
    return r.content[0].text;
  };

  it('shows the export date of a configured file, and nothing new without one', async () => {
    buildXrefFixture(file, { refs: contosoRefs() });
    expect(await info({ xrefSqlite: provider() })).toContain(
      'Xref        : SQLite export of DYNAMICSXREFDB — exported 2026-10-30T12:00:00Z, 2 modules',
    );
    const diag = await info({ xrefSqlite: provider() }, true);
    expect(diag).toContain('## Cross-references');
    expect(diag).toContain(`File     : ${file}`);
    expect(await info({ bridge: bridge(true) })).not.toContain('Xref');
  });
});

const call = (args: Record<string, unknown>, context: Record<string, unknown>) =>
  findReferencesTool(
    { method: 'tools/call', params: { name: 'find_references', arguments: args } } as never,
    {
      symbolIndex: { getReadDb: () => ({ prepare: () => ({ get: () => undefined, all: () => [] }) }) },
      ...context,
    } as never,
    'full',
  ) as Promise<{ content: Array<{ text: string }>; isError?: boolean }>;

describe('find_references on the SQLite file', () => {
  it('answers from the file instead of the name-based search, and says where from', async () => {
    buildXrefFixture(file, { refs: contosoRefs() });
    const out = (await call({ targetName: 'ContosoTable', targetType: 'table' }, { xrefSqlite: provider() })).content[0]
      .text;
    expect(out).toContain('_Source: xref SQLite file (DYNAMICSXREFDB export, exported 2026-10-30T12:00:00Z)');
    expect(out).toContain('ContosoCaller.doIt');
    expect(out).toContain('From declarative metadata');
    expect(out).not.toMatch(/name-based/i);
  });

  it('answers an EDT-like type with an authoritative zero instead of "inconclusive"', async () => {
    buildXrefFixture(file, { refs: contosoRefs() });
    const out = (await call({ targetName: 'ContosoAmountEdt', targetType: 'edt' }, { xrefSqlite: provider() }))
      .content[0].text;
    expect(out).toContain('**Total References Found:** 0');
    expect(out).toContain('_Source: xref SQLite file');
  });

  it('says why the configured file was not used when it falls back', async () => {
    buildXrefFixture(file, { refs: contosoRefs(), meta: null });
    const out = (await call({ targetName: 'ContosoAmountEdt', targetType: 'edt' }, { xrefSqlite: provider() }))
      .content[0].text;
    expect(out).toContain('inconclusive');
    expect(out).toContain('D365FO_XREF_SQLITE_PATH');
    expect(out).toContain('no meta table');
    expect(out).toContain("Ask the server's operator to check the cross-reference file");
    expect(out).not.toContain('C# bridge exe');
    // The path is the server's layout: the log and doctor show it, the client does not.
    expect(out).not.toContain(dir);
    expect(out).not.toContain('xref.db');
  });

  it('keeps the path out of a reason that would contain it', async () => {
    fs.mkdirSync(file);
    const out = (await call({ targetName: 'ContosoTable', targetType: 'table' }, { xrefSqlite: provider() }))
      .content[0].text;
    expect(out).toContain('not a regular file');
    expect(out).not.toContain(dir);
  });

  describe('a query on the file that fails', () => {
    const failing = () => {
      buildXrefFixture(file, { refs: contosoRefs() });
      const p = provider();
      vi.spyOn(p, 'findReferences').mockRejectedValue(new Error('disk I/O error'));
      return p;
    };

    it('names the file and the server log, not the bridge log', async () => {
      const out = (await call({ targetName: 'ContosoAmountEdt', targetType: 'edt' }, { xrefSqlite: failing() }))
        .content[0].text;
      expect(out).toContain('inconclusive');
      expect(out).toContain('the query on the xref SQLite file (D365FO_XREF_SQLITE_PATH) failed');
      expect(out).toContain('The error is in the server log');
      expect(out).not.toContain('bridge log');
      expect(out).not.toContain('disk I/O error');
    });

    it('says the same in the name-based fallback and the label answer', async () => {
      const p = failing();
      const table = (await call({ targetName: 'ContosoTable', targetType: 'table' }, { xrefSqlite: p })).content[0]
        .text;
      expect(table).toContain('_Source: name-based index scan — the query on the xref SQLite file');
      const label = await call({ targetName: '@Contoso:Amount' }, { xrefSqlite: p });
      expect(label.isError).toBe(true);
      expect(label.content[0].text).toContain('The query on the xref SQLite file failed. The error is in the server log');
      expect(label.content[0].text).not.toContain('bridge log');
    });
  });

  it('gives an exact total past the joined cap when the export left out references without a source', async () => {
    buildXrefFixture(file, {
      refs: manyRefs('/Classes/ContosoBusy', XREF_SQLITE_COUNT_CAP + 5),
      meta: { ...VALID_META, [XREF_META_REFS_WITHOUT_SOURCE_REMOVED]: '0' },
    });
    const outcome = await tryBridgeReferences(provider(), '/Classes/ContosoBusy', 50);
    const out = outcome.status === 'ok' ? outcome.result.content[0].text : '';
    expect(out).toContain(`**Total:** ${XREF_SQLITE_COUNT_CAP + 5} reference(s) found (showing 500)`);
    expect(out).toContain('the totals are exact');
    expect(out).not.toContain('more exist than counted');
  });

  it('marks a total that stopped at the count cap as a lower bound', async () => {
    buildXrefFixture(file, { refs: manyRefs('/Classes/ContosoBusy', XREF_SQLITE_COUNT_CAP + 5) });
    const outcome = await tryBridgeReferences(provider(), '/Classes/ContosoBusy', 50);
    expect(outcome.status).toBe('ok');
    const out = outcome.status === 'ok' ? outcome.result.content[0].text : '';
    expect(out).toContain(`**Total:** ${XREF_SQLITE_COUNT_CAP}+ reference(s) found (showing 500)`);
    expect(out).toContain('more exist than counted');
  });

  it('renders exactly what the bridge would for the same result, apart from the source line', async () => {
    buildXrefFixture(file, { refs: contosoRefs() });
    const p = provider();
    const result = await p.findReferences('ContosoTable');
    const fake = { ...bridge(true), findReferences: vi.fn(async () => result) };
    const viaBridge = await tryBridgeReferences(fake as never, 'ContosoTable', 50);
    const viaFile = await tryBridgeReferences(p, 'ContosoTable', 50);
    const text = (o: typeof viaFile) => (o.status === 'ok' ? o.result.content[0].text : '');
    expect(text(viaFile).replace(p.sourceLabel, BRIDGE_SOURCE_LABEL)).toBe(text(viaBridge));
  });

  it('answers a label where-used from the file', async () => {
    buildXrefFixture(file, {
      refs: [
        {
          src: 'Table/ContosoTable/TableFieldReal/Amount?Label',
          tgt: '/Labels/@Contoso:Amount',
          kind: K.TYPE,
          line: 0,
        },
      ],
    });
    const out = (await call({ targetName: '@Contoso:Amount' }, { xrefSqlite: provider() })).content[0].text;
    expect(out).toContain('References to label');
    expect(out).toContain('_Source: xref SQLite file');
  });
});

describe('knowledge tools on the SQLite file', () => {
  beforeEach(() => buildXrefFixture(file, { refs: contosoRefs() }));

  it('lists CoC extensions with the methods they wrap', async () => {
    const out = (await tryBridgeCocExtensions(provider(), 'ContosoService'))!.content[0].text;
    expect(out).toContain('_Source: xref SQLite file');
    expect(out).toContain('**ContosoService_ContosoExt_Extension** (ContosoExt)');
    expect(out).toContain('Wraps methods: run');
    expect(out).not.toContain('ContosoDecoy_Extension');
  });

  it('lists event handlers', async () => {
    const out = (await tryBridgeEventHandlers(provider(), 'ContosoTable'))!.content[0].text;
    expect(out).toContain('Found 2 handler(s)');
    expect(out).toContain('ContosoTableEventHandler**.ContosoTable_onInserted');
    expect(out).not.toContain('more handlers may exist');
  });

  it('lists API callers and says when more are available', async () => {
    const p = provider();
    expect((await tryBridgeApiUsageCallers(p, 'ContosoService'))!.content[0].text).toContain(
      '**Total references:** 5 from 3',
    );
    const capped = (await tryBridgeApiUsageCallers(p, 'ContosoService', 2))!.content[0].text;
    expect(capped).toContain('**Total references:** 2+');
    expect(capped).toContain('more available');
  });
});

describe('doctor', () => {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env.D365FO_XREF_SQLITE_PATH;
    delete process.env.D365FO_XREF_SQLITE_PATH;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.D365FO_XREF_SQLITE_PATH;
    else process.env.D365FO_XREF_SQLITE_PATH = saved;
  });

  it('is quiet without a file, and reports one from the config or the environment', () => {
    const store = openStore(dir, null);
    expect(checkXrefSqlite(store)).toBeNull();
    buildXrefFixture(file, { refs: contosoRefs() });
    writeSetting(store, settingByPath('index.xrefSqlitePath')!, 'xref.db'); // relative to the config dir
    expect(checkXrefSqlite(store)).toMatchObject({
      severity: 'ok',
      message: expect.stringContaining('exported 2026-10-30T12:00:00Z'),
    });
    expect(checkXrefSqlite(store)?.message).toContain('totals joined to Names, exact up to 20000');
    process.env.D365FO_XREF_SQLITE_PATH = path.join(dir, 'absent.db');
    expect(checkXrefSqlite(store)).toMatchObject({ severity: 'warn', message: expect.stringContaining('ENOENT') });
  });
});
