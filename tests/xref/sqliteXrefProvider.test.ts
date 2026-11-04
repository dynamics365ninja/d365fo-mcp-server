/**
 * The xref SQLite provider (src/xref/sqliteXrefProvider.ts): the bridge's four
 * cross-reference queries over a SQLite export of DYNAMICSXREFDB, bounded,
 * read-only and lazy. Every fixture is synthetic and built inside the test.
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseSyncClass } from '../../src/database/nodeSqlite';
import {
  SqliteXrefProvider,
  XREF_META_REFS_WITHOUT_SOURCE_REMOVED,
  XREF_SQLITE_COUNT_CAP,
  XREF_SQLITE_INDEX_COUNT_CAP,
  XREF_SQLITE_ROWS_PER_SHAPE,
  XREF_SQLITE_SCAN_CAP,
  __testing,
  openXrefSqliteReadOnly,
} from '../../src/xref/sqliteXrefProvider';
import { prefixRange } from '../../src/xref/xrefPaths';
import { K, VALID_META, buildXrefFixture, contosoRefs, manyRefs, tempDir } from './xrefFixture';

let dir: string;
let file: string;
let logs: string[];
let provider: SqliteXrefProvider | undefined;

const open = (f = file) => {
  provider = new SqliteXrefProvider(f, line => logs.push(line));
  return provider;
};

beforeEach(() => {
  dir = tempDir();
  file = path.join(dir, 'xref.db');
  logs = [];
});

afterEach(() => {
  provider?.close();
  provider = undefined;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('findReferences — the bridge query, ported', () => {
  beforeEach(() => buildXrefFixture(file, { refs: contosoRefs() }));

  it('answers a bare name across both shapes: code first, categorised, callers parsed', () => {
    const r = open().findReferencesSync('ContosoTable');
    // Code: the table itself, its field (2), its method (handler), the extension? no — only children of /Tables/ContosoTable.
    const code = r.references.filter(x => x.sourcePath.startsWith('/'));
    const metadata = r.references.filter(x => !x.sourcePath.startsWith('/'));
    expect(metadata.map(x => x.sourcePath)).toEqual([
      'Form/ContosoForm/FormDataSourceRoot/ContosoTable?Table',
      'Table/ContosoOrder/TableFieldReal/Amount?ExtendedDataType',
    ]);
    expect(r.references.indexOf(metadata[0])).toBe(code.length); // code rows come first
    expect(r.total).toBe(r.references.length);
    expect(r.metadataTotal).toBe(2);
    expect(r.totalCapped).toBeUndefined();

    const typeRef = r.references.find(x => x.line === 11)!;
    expect(typeRef).toMatchObject({
      sourcePath: '/Classes/ContosoCaller/Methods/doIt',
      sourceModule: 'ContosoExt',
      kind: '2',
      referenceType: 'type-reference',
      callerClass: 'ContosoCaller',
      callerMethod: 'doIt',
      column: 1,
    });
    expect(r.references.find(x => x.line === 12)!.referenceType).toBe('field-access');
    expect(r.references.find(x => x.line === 7)!.referenceType).toBe('method-reference');
    // Metadata sources carry no method; the "caller" is the object.
    expect(metadata[0]).toMatchObject({ callerClass: 'ContosoForm', line: 0 });
    expect(metadata[0].callerMethod).toBeUndefined();
  });

  it('never returns or counts a reference whose source is not in Names', () => {
    const r = open().findReferencesSync('/Tables/ContosoTable');
    expect(r.references.some(x => x.line === 99)).toBe(false);
    expect(r.total).toBe(r.references.length);
  });

  it('matches without regard to ASCII case, like the SQL Server collation', () => {
    const p = open();
    const lower = p.findReferencesSync('contosotable');
    expect(lower.total).toBe(p.findReferencesSync('ContosoTable').total);
    expect(p.findReferencesSync('/TABLES/contosotable/FIELDS/amount').total).toBe(2);
    expect(
      p
        .findReferencesSync('CONTOSOTABLE.amount')
        .references.map(x => x.line)
        .sort(),
    ).toEqual([0, 12, 3].sort());
  });

  it('scopes "Owner.member" to the member, with its metadata twin and extension-added fields', () => {
    const p = open();
    const amount = p.findReferencesSync('ContosoTable.Amount');
    expect(amount.references.map(x => x.sourcePath).sort()).toEqual([
      '/Classes/ContosoCaller/Methods/doIt',
      '/Classes/ContosoReport/Methods/print',
      'Table/ContosoOrder/TableFieldReal/Amount?ExtendedDataType',
    ]);
    const extra = p.findReferencesSync('ContosoTable.ExtraField');
    expect(extra.references.map(x => x.sourcePath).sort()).toEqual([
      '/Classes/ContosoCaller/Methods/extra',
      'Form/ContosoForm/FormDesign/Grid/ExtraField?DataField',
    ]);
  });

  it('takes "_" and "%" in names literally', () => {
    const p = open();
    // ContosoServiceXContosoExtXExtension would match ContosoService_ContosoExt_Extension if "_" were a wildcard.
    expect(
      p
        .findReferencesSync('ContosoService_ContosoExt_Extension')
        .references.some(x => x.sourcePath === '/Classes/ContosoXCaller/Methods/go'),
    ).toBe(false);
    expect(p.findReferencesSync('Contoso%').total).toBe(0);
  });

  it('answers an unknown target with an empty, exact result', () => {
    const r = open().findReferencesSync('NoSuchContosoThing');
    expect(r).toMatchObject({ count: 0, total: 0, metadataTotal: 0, references: [] });
  });
});

describe('bounds: rows per shape, paging, count cap', () => {
  it('returns at most the bridge row cap, with the exact total of a target below the count cap', () => {
    buildXrefFixture(file, { refs: manyRefs('/Classes/ContosoBusy', 1200) });
    const r = open().findReferencesSync('/Classes/ContosoBusy');
    expect(r.references).toHaveLength(XREF_SQLITE_ROWS_PER_SHAPE);
    expect(r.total).toBe(1200);
    expect(r.totalCapped).toBeUndefined();
  });

  it('pages through every row exactly once', () => {
    buildXrefFixture(file, { refs: manyRefs('/Classes/ContosoBusy', 1200) });
    const p = open();
    const seen: string[] = [];
    for (let offset = 0; ; offset += 500) {
      const page = p.findReferencesSync('/Classes/ContosoBusy', { limit: 500, offset });
      expect(page.total).toBe(1200);
      if (page.references.length === 0) break;
      seen.push(...page.references.map(x => x.sourcePath));
    }
    expect(seen).toHaveLength(1200);
    expect(new Set(seen).size).toBe(1200);
  });

  it('stops counting at the cap and says the total is a lower bound', () => {
    buildXrefFixture(file, { refs: manyRefs('/Classes/ContosoBusy', XREF_SQLITE_COUNT_CAP + 50) });
    const r = open().findReferencesSync('/Classes/ContosoBusy');
    expect(r.references).toHaveLength(XREF_SQLITE_ROWS_PER_SHAPE);
    expect(r.total).toBe(XREF_SQLITE_COUNT_CAP);
    expect(r.totalCapped).toBe(true);
  });

  describe('a file whose export left out the references without a source name', () => {
    const SOURCES_COMPLETE = { ...VALID_META, [XREF_META_REFS_WITHOUT_SOURCE_REMOVED]: '7135533' };
    const withoutSource = (target: string, n: number) =>
      manyRefs(target, n).map(r => ({ ...r, danglingSource: true }));

    it('counts from the index, exactly, past the joined cap', () => {
      buildXrefFixture(file, { refs: manyRefs('/Classes/ContosoBusy', XREF_SQLITE_COUNT_CAP + 50), meta: SOURCES_COMPLETE });
      const p = open();
      expect(p.status()).toMatchObject({ state: 'ok', countsFromIndex: true });
      expect(p.countCap).toBe(XREF_SQLITE_INDEX_COUNT_CAP);
      const r = p.findReferencesSync('/Classes/ContosoBusy');
      expect(r.references).toHaveLength(XREF_SQLITE_ROWS_PER_SHAPE);
      expect(r.total).toBe(XREF_SQLITE_COUNT_CAP + 50);
      expect(r.totalCapped).toBeUndefined();
    });

    it('gives the joined total when every source has a name, as the key promises', () => {
      const refs = manyRefs('/Classes/ContosoBusy', 1200);
      buildXrefFixture(file, { refs, meta: SOURCES_COMPLETE });
      const fromIndex = open().findReferencesSync('/Classes/ContosoBusy');
      provider?.close();
      fs.rmSync(file);
      buildXrefFixture(file, { refs });
      const joined = open().findReferencesSync('/Classes/ContosoBusy');
      expect(fromIndex.total).toBe(1200);
      expect(fromIndex).toEqual(joined);
    });

    it('joins to Names without the key, or with a value that is not a count', () => {
      buildXrefFixture(file, {
        refs: manyRefs('/Classes/ContosoBusy', XREF_SQLITE_COUNT_CAP + 50),
        meta: { ...VALID_META, [XREF_META_REFS_WITHOUT_SOURCE_REMOVED]: 'unknown' },
      });
      const p = open();
      expect(p.status()).toMatchObject({ state: 'ok', countsFromIndex: false });
      expect(p.countCap).toBe(XREF_SQLITE_COUNT_CAP);
      expect(p.findReferencesSync('/Classes/ContosoBusy')).toMatchObject({ total: XREF_SQLITE_COUNT_CAP, totalCapped: true });
    });

    it('trusts the key: a file that has it but still holds such references counts them', () => {
      // 600 references with a source name and 150 without. Joined, the bridge's way: 600.
      const refs = [...manyRefs('/Classes/ContosoBusy', 600), ...withoutSource('/Classes/ContosoBusy', 150)];
      buildXrefFixture(file, { refs, meta: SOURCES_COMPLETE });
      expect(open().findReferencesSync('/Classes/ContosoBusy').total).toBe(750);
      provider?.close();
      fs.rmSync(file);
      buildXrefFixture(file, { refs });
      expect(open().findReferencesSync('/Classes/ContosoBusy').total).toBe(600);
    });
  });

  it('bounds the per-module aggregate', () => {
    buildXrefFixture(file, { refs: manyRefs('/Classes/ContosoBusy', 300) });
    const p = open();
    const id = p.lookupPath('/Classes/ContosoBusy')[0];
    expect(p.referencesPerModule(id)).toEqual({ modules: new Map([['ApplicationSuite', 300]]), capped: false });
    const capped = p.referencesPerModule(id, 100);
    expect([...capped.modules.values()].reduce((a, b) => a + b, 0)).toBe(100);
    expect(capped.capped).toBe(true);
  });
});

describe('findExtensionClasses', () => {
  const expectContosoService = (p: SqliteXrefProvider) => {
    const r = p.findExtensionClassesSync('ContosoService');
    expect(r.extensions).toEqual([
      {
        className: 'ContosoService_ContosoExt_Extension',
        module: 'ContosoExt',
        extendedElement: '/Classes/ContosoService',
        wrappedMethods: ['run'],
      },
    ]);
    expect(r.count).toBe(1);
  };

  it('finds the CoC class from its [ExtensionOf] line and the methods it wraps, not the decoy', () => {
    buildXrefFixture(file, { refs: contosoRefs() });
    expectContosoService(open());
  });

  it('gives the same answer when the base is busy and the search starts from the declarations', () => {
    // Over 5,000 references to the base switch the query to the declaration-driven form.
    buildXrefFixture(file, { refs: [...contosoRefs(), ...manyRefs('/Classes/ContosoService', 5_100)] });
    expectContosoService(open());
  });

  it('reads the extended element of a nested intrinsic (a form data source), case-insensitively', () => {
    buildXrefFixture(file, { refs: contosoRefs() });
    const r = open().findExtensionClassesSync('contosoform');
    expect(r.extensions.map(e => [e.className, e.extendedElement])).toEqual([
      ['ContosoFormDS_Extension', '/Forms/ContosoForm/DataSources/ContosoTable'],
    ]);
  });
});

describe('findEventSubscribers', () => {
  it('lists handler classes by naming convention with type and event', () => {
    buildXrefFixture(file, { refs: contosoRefs() });
    const r = open().findEventSubscribersSync('ContosoTable');
    expect(r.handlers).toEqual(
      [
        {
          className: 'ContosoTableEventHandler',
          methodName: 'ContosoTable_onInserted',
          eventName: 'Oninserted',
          handlerType: 'dataEvent',
        },
        {
          className: 'ContosoTableEventHandler',
          methodName: 'ContosoTable_Post_validateWrite',
          eventName: 'ContosoTable_Post_validateWrite',
          handlerType: 'post',
        },
      ].map(h => ({ ...h, module: 'ApplicationSuite' })),
    );
    expect(r.scanCapped).toBeUndefined();
    // ContosoCaller references the table too, but is not named like a handler.
    expect(r.handlers.some(h => h.className === 'ContosoCaller')).toBe(false);
  });

  it('applies the eventName and handlerType filters', () => {
    buildXrefFixture(file, { refs: contosoRefs() });
    const p = open();
    expect(p.findEventSubscribersSync('ContosoTable', 'onInserted').handlers.map(h => h.methodName)).toEqual([
      'ContosoTable_onInserted',
    ]);
    expect(p.findEventSubscribersSync('ContosoTable', undefined, 'post').handlers.map(h => h.methodName)).toEqual([
      'ContosoTable_Post_validateWrite',
    ]);
  });

  it("examines at most the scan cap, the object's own references first, and says so", () => {
    buildXrefFixture(file, {
      refs: [
        ...manyRefs('/Tables/ContosoTable/Fields/Amount', XREF_SQLITE_SCAN_CAP + 10),
        {
          src: '/Classes/ContosoTableEventHandler/Methods/ContosoTable_onInserted',
          tgt: '/Tables/ContosoTable',
          kind: K.TYPE,
        },
      ],
    });
    const r = open().findEventSubscribersSync('ContosoTable');
    expect(r.scanCapped).toBe(true);
    expect(r.scanned).toBe(XREF_SQLITE_SCAN_CAP);
    expect(r.handlers.map(h => h.methodName)).toEqual(['ContosoTable_onInserted']);
  });
});

describe('findApiUsageCallers', () => {
  it('groups class callers by class, with methods and modules', () => {
    buildXrefFixture(file, { refs: contosoRefs() });
    const r = open().findApiUsageCallersSync('ContosoService');
    // As in the bridge, a class-level source (an [ExtensionOf] line, the decoy's declaration) is a caller too.
    expect(r.callersByClass.map(c => [c.callerClass, c.callCount, c.methods, c.module])).toEqual([
      ['ContosoService_ContosoExt_Extension', 3, ['run'], 'ContosoExt'],
      ['ContosoDecoy_Extension', 1, [], 'ApplicationSuite'],
      ['ContosoCaller', 1, ['doIt'], 'ContosoExt'],
    ]);
    expect(r.totalCallers).toBe(5);
    expect(r.more).toBeUndefined();
  });

  it('returns a page of `limit` callers and reports that more are available', () => {
    buildXrefFixture(file, { refs: manyRefs('/Classes/ContosoApi/Methods/call', 450) });
    const p = open();
    const first = p.findApiUsageCallersSync('/Classes/ContosoApi/Methods/call', { limit: 200 });
    expect(first.totalCallers).toBe(200);
    expect(first.more).toBe(true);
    const last = p.findApiUsageCallersSync('/Classes/ContosoApi/Methods/call', { limit: 200, offset: 400 });
    expect(last.totalCallers).toBe(50);
    expect(last.more).toBeUndefined();
  });
});

describe('every lookup stays on an index', () => {
  it('uses the NOCASE index for exact and prefix matches and never scans References or Names', () => {
    buildXrefFixture(file, { refs: [...contosoRefs(), ...manyRefs('/Classes/ContosoBusy', 2000)] });
    const db = openXrefSqliteReadOnly(file);
    try {
      const plans: Record<string, string> = {};
      const sqls = __testing.buildSql({
        namesPath: 'ix_names_path',
        refTarget: 'ix_ref_target',
        refSource: 'ix_ref_source',
      });
      for (const [name, sql] of Object.entries(sqls)) {
        const params = (sql.match(/\?/g) ?? []).map((_, i) => (sql.includes('json_each') ? '[1000]' : String(i)));
        const rows = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as Array<{ detail: string }>;
        plans[name] = rows.map(r => r.detail).join(' | ');
      }
      expect(plans.exact).toMatch(/USING COVERING INDEX ix_names_path \(Path=\?\)/);
      expect(plans.range).toMatch(/USING COVERING INDEX ix_names_path \(Path>\? AND Path<\?\)/);
      expect(plans.rangeLike).toMatch(/USING (COVERING )?INDEX ix_names_path \(Path>\? AND Path<\?\)/);
      expect(plans.wrappedCalls).toMatch(/SEARCH src USING (COVERING )?INDEX ix_names_path \(Path>\? AND Path<\?\)/);
      // The count for a file without references lacking a source name reads the TargetId index alone.
      expect(plans.refIndexCount).toMatch(/USING COVERING INDEX ix_ref_target \(TargetId=\?\)/);
      expect(plans.refIndexCount).not.toMatch(/Names|\bsrc\b/);
      for (const [name, plan] of Object.entries(plans)) {
        // A full scan of either big table is what the caps exist to prevent.
        expect(plan, name).not.toMatch(/SCAN (r|ra|rc|src|tgt|n|Names|"References"|References)\b(?! USING)/);
        expect(plan, name).not.toMatch(/USE TEMP B-TREE FOR ORDER BY/);
      }
    } finally {
      db.close();
    }
  });

  it('folds the bounds of a prefix range, so "Z…" finds "z…"', () => {
    expect(prefixRange('/Tables/Z/')).toEqual({ lo: '/tables/z/', hi: '/tables/z0' });
    expect(prefixRange('/TableExtensions/T.')).toEqual({ lo: '/tableextensions/t.', hi: '/tableextensions/t/' });
  });
});

describe('opening the file', () => {
  it('is lazy: constructing touches nothing, a missing file is a status, not an error', () => {
    const p = open(path.join(dir, 'absent.db'));
    expect(logs).toEqual([]);
    expect(p.isReady).toBe(false);
    expect(p.status()).toMatchObject({ state: 'missing' });
    expect(fs.existsSync(path.join(dir, 'absent.db'))).toBe(false);
    expect(() => p.findReferencesSync('ContosoTable')).toThrow(/not available/);
    expect(logs).toHaveLength(1); // logged once, not per call
  });

  it('refuses a file whose meta.schema is not 1', () => {
    buildXrefFixture(file, { refs: contosoRefs(), meta: { ...VALID_META, schema: '2' } });
    const st = open().status();
    expect(st).toMatchObject({ state: 'invalid' });
    expect(st.state !== 'ok' && st.reason).toMatch(/meta\.schema is '2'; this server reads schema '1'/);
    expect(logs.join('\n')).toMatch(/not using .*schema/);
  });

  it('refuses a file without a meta table', () => {
    buildXrefFixture(file, { refs: contosoRefs(), meta: null });
    expect(open().status()).toMatchObject({ state: 'invalid', reason: expect.stringMatching(/no meta table/) });
  });

  it('refuses a partial export and a file without the indexes', () => {
    buildXrefFixture(file, { refs: contosoRefs(), meta: { ...VALID_META, kind: 'delta' } });
    expect(open().status()).toMatchObject({ state: 'invalid', reason: expect.stringMatching(/kind 'full'/) });
    provider!.close();
    fs.rmSync(file);
    buildXrefFixture(file, { refs: contosoRefs(), noIndexes: true });
    expect(open().status()).toMatchObject({ state: 'invalid', reason: expect.stringMatching(/NOCASE/) });
  });

  it('refuses a file that is not SQLite at all', () => {
    fs.writeFileSync(file, 'not a database, just text '.repeat(200));
    expect(open().status()).toMatchObject({ state: 'invalid' });
  });

  it('reports the export date and module count', () => {
    buildXrefFixture(file, { refs: contosoRefs() });
    const st = open().status();
    expect(st).toMatchObject({ state: 'ok', exportedAt: '2026-10-30T12:00:00Z', modules: 2 });
    expect(provider!.sourceLabel).toBe('xref SQLite file (DYNAMICSXREFDB export, exported 2026-10-30T12:00:00Z)');
  });
});

describe('read-only', () => {
  const sha = (f: string) => createHash('sha256').update(fs.readFileSync(f)).digest('hex');

  it('leaves the file byte for byte unchanged and creates nothing next to it', async () => {
    buildXrefFixture(file, { refs: [...contosoRefs(), ...manyRefs('/Classes/ContosoBusy', 600)] });
    const before = sha(file);
    const mtime = fs.statSync(file).mtimeMs;
    const p = open();
    await p.findReferences('ContosoTable');
    await p.findReferences('/Classes/ContosoBusy');
    await p.findExtensionClasses('ContosoService');
    await p.findEventSubscribers('ContosoTable');
    await p.findApiUsageCallers('ContosoService', 10);
    p.referencesPerModule(p.lookupPath('/Classes/ContosoBusy')[0]);
    expect(fs.readdirSync(dir)).toEqual(['xref.db']); // no -journal, -wal or -shm
    p.close();
    expect(sha(file)).toBe(before);
    expect(fs.statSync(file).mtimeMs).toBe(mtime);
  });

  it('cannot write through its connection', () => {
    buildXrefFixture(file, { refs: contosoRefs() });
    const db = openXrefSqliteReadOnly(file);
    try {
      expect(() => db.exec('DELETE FROM Names')).toThrow(/readonly|read-only/i);
      expect(() => db.exec('CREATE TEMP TABLE t(x)')).toThrow(/readonly|read-only/i);
    } finally {
      db.close();
    }
  });

  it('never attaches another database: the file is the only one it reads', () => {
    const sqls = Object.values(__testing.buildSql({ namesPath: 'a', refTarget: 'b', refSource: 'c' }));
    expect(sqls.join('\n')).not.toMatch(/\bATTACH\b/i);
  });
});

describe('a file replaced while the server runs', () => {
  const rows = (p: SqliteXrefProvider) => p.findReferencesSync('/Classes/ContosoSwap').total;
  // Windows cannot rename over a file another handle holds open (EPERM): SQLite's
  // win32 VFS does not share delete access. There the operator stops the server to
  // replace the file, as the setting's description says.
  const renameOverOpenFile = it.skipIf(process.platform === 'win32');

  renameOverOpenFile('reads the new file after an atomic rename, never the old view', () => {
    buildXrefFixture(file, { refs: manyRefs('/Classes/ContosoSwap', 3) });
    const p = open();
    expect(rows(p)).toBe(3);
    const next = path.join(dir, 'xref.db.new');
    buildXrefFixture(next, {
      refs: manyRefs('/Classes/ContosoSwap', 7),
      meta: { ...VALID_META, exported_at: '2026-11-01T00:00:00Z' },
    });
    fs.renameSync(next, file);
    expect(rows(p)).toBe(7);
    expect(p.status()).toMatchObject({ exportedAt: '2026-11-01T00:00:00Z' });
    expect(logs.join('\n')).toMatch(/changed — reopening/);
  });

  it('reopens a file rewritten in place', () => {
    buildXrefFixture(file, { refs: manyRefs('/Classes/ContosoSwap', 3) });
    const p = open();
    expect(rows(p)).toBe(3);
    const next = path.join(dir, 'other.db');
    buildXrefFixture(next, { refs: manyRefs('/Classes/ContosoSwap', 5) });
    fs.writeFileSync(file, fs.readFileSync(next));
    // Same inode; size or mtime tells the change. Force a distinct mtime on coarse clocks.
    const t = new Date(Date.now() + 5_000);
    fs.utimesSync(file, t, t);
    expect(rows(p)).toBe(5);
  });

  renameOverOpenFile('stops answering when the file is replaced by garbage or removed, and resumes with a valid one', () => {
    buildXrefFixture(file, { refs: manyRefs('/Classes/ContosoSwap', 3) });
    const p = open();
    expect(rows(p)).toBe(3);
    const junk = path.join(dir, 'junk');
    fs.writeFileSync(junk, Buffer.alloc(8192, 0x41));
    fs.renameSync(junk, file);
    expect(p.isReady).toBe(false);
    expect(() => rows(p)).toThrow(/not available/);
    fs.rmSync(file);
    expect(p.status()).toMatchObject({ state: 'missing' });
    buildXrefFixture(file, { refs: manyRefs('/Classes/ContosoSwap', 2) });
    expect(rows(p)).toBe(2);
  });

  it('turns a query failure into an error, not an empty result, and recovers on the next call', () => {
    buildXrefFixture(file, { refs: manyRefs('/Classes/ContosoSwap', 3) });
    const p = open();
    expect(rows(p)).toBe(3);
    // Drop the connection under the provider: the next statement fails.
    (p as unknown as { db: InstanceType<typeof DatabaseSyncClass> }).db.close();
    expect(() => rows(p)).toThrow(/NOT an empty result/);
    expect(rows(p)).toBe(3);
  });
});
