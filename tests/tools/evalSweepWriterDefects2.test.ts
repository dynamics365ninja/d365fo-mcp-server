/**
 * Regression gate for the three writer defects the 2026-07-22 corpus record
 * `2026-07-22T04__L2-form-over-view` raised alongside #37 and that were filed
 * under "Open — writers" in docs/eval-sweep-findings-2026-07-21.md.
 *
 * Covered here (all VM-free):
 *   - generate_object(scaffold, form) rejected a VIEW as `dataSource` because
 *     the scaffold's own lookup was scoped to tables only, even though
 *     object_patterns resolves the same view.
 *   - trigger_db_sync emitted `-viewlist`, which is not a SyncEngine argument:
 *     it prints "Invalid argument -viewlist=… specified", CONTINUES, and drops
 *     those names — so a requested view was never synced and nothing failed.
 *     Verified against SyncEngine 7.0.30743 on the dev VM, whose parameter dump
 *     has one `TableOrViewList` fed by `-synclist` and no view list at all.
 *   - every control on a form over a view came out String, because the map was
 *     parsed from view XML, which holds no AxTableField at all.
 *
 * The remaining item (view <DataSource> defaulting to the query name) is #38 and
 * is already gated by tests/tools/createWriterDefects.test.ts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { handleGenerateSmartForm } from '../../src/tools/generateSmartForm';
import {
  buildSyncEngineArgs,
  classifySyncOutcome,
  classifySyncTargets,
  extractTablesFromProject,
} from '../../src/tools/dbSync';
import {
  getFieldControlMap,
  parseQueryDataSourceTables,
  parseViewFieldBindings,
  parseViewQueryName,
} from '../../src/utils/fieldControlTypes';
import type { DbLike } from '../../src/utils/symbolLookup';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

// ── a symbol index that knows exactly one object, of a given type ───────────

/**
 * Minimal DB double for utils/symbolLookup: it answers the exact-case probe and
 * the FTS fallback, honouring the `type IN (…)` filter so a lookup scoped to
 * tables genuinely cannot see a view.
 */
function fakeDb(rows: Array<{ name: string; type: string; file_path?: string }>): DbLike {
  return {
    prepare: (sql: string) => ({
      // getFieldControlMap reaches an object's XML through one of its field rows.
      get: (...params: unknown[]) => {
        if (!sql.includes("type = 'field'")) return undefined;
        const owner = rows.find(r => r.name === String(params[0]));
        return owner?.file_path ? { file_path: owner.file_path } : undefined;
      },
      all: (...params: unknown[]) => {
        const isFts = sql.includes('symbols_fts');
        // exact:  [name, ...types, limit]      fts: [match, name, ...types, limit]
        const name = String(params[isFts ? 1 : 0]);
        const types = params.slice(isFts ? 2 : 1, -1).map(String);
        return rows
          .filter(r => (isFts
            ? r.name.toLowerCase() === name.toLowerCase()
            : r.name === name))
          .filter(r => types.length === 0 || types.includes(r.type))
          .map(r => ({ model: 'MyModel', extends_class: null, file_path: null, ...r }));
      },
    }),
  };
}

const symbolIndexOver = (rows: Array<{ name: string; type: string }>) => ({
  searchSymbols: vi.fn(() => []),
  getSymbolByName: vi.fn(() => undefined),
  getTableFields: vi.fn(() => []),
  getCustomModels: vi.fn(() => ['MyModel']),
  db: fakeDb(rows),
  getReadDb: vi.fn(function (this: any) { return this.db; }),
}) as any;

// ── form scaffold over a view ───────────────────────────────────────────────

describe('generate_object(scaffold, form) accepts a view as dataSource', () => {
  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    vi.stubEnv('EXTENSION_PREFIX', '');
  });
  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    vi.unstubAllEnvs();
  });

  it('binds the form to an indexed VIEW instead of failing "not found in the symbol index"', async () => {
    const result = await handleGenerateSmartForm(
      { name: 'ConDemoNoteViewForm', modelName: 'MyModel', dataSource: 'ConDemoNoteView' },
      symbolIndexOver([{ name: 'ConDemoNoteView', type: 'view' }]),
    );
    const text = (result?.content[0].text as string) ?? '';
    expect(text).not.toContain('not found in the symbol index');
    expect(text).toContain('<Table>ConDemoNoteView</Table>');
  });

  it('says the datasource is a read-only view — the templates emit the writable default', async () => {
    const result = await handleGenerateSmartForm(
      { name: 'ConDemoNoteViewForm', modelName: 'MyModel', dataSource: 'ConDemoNoteView' },
      symbolIndexOver([{ name: 'ConDemoNoteView', type: 'view' }]),
    );
    const text = (result?.content[0].text as string) ?? '';
    expect(text).toContain('is a VIEW — read-only at runtime');
  });

  it('says nothing of the sort for a TABLE datasource (unchanged behaviour)', async () => {
    const result = await handleGenerateSmartForm(
      { name: 'ConDemoNoteHeaderForm', modelName: 'MyModel', dataSource: 'ConDemoNoteHeader' },
      symbolIndexOver([{ name: 'ConDemoNoteHeader', type: 'table' }]),
    );
    const text = (result?.content[0].text as string) ?? '';
    expect(text).toContain('<Table>ConDemoNoteHeader</Table>');
    expect(text).not.toContain('is a VIEW');
  });

  it('still reports a name that is neither table nor view', async () => {
    const result = await handleGenerateSmartForm(
      { name: 'GhostForm', modelName: 'MyModel', dataSource: 'GhostObject' },
      symbolIndexOver([{ name: 'ConDemoNoteView', type: 'view' }]),
    );
    const text = (result?.content[0].text as string) ?? '';
    expect(text).toContain('not found in the symbol index');
  });
});

// ── trigger_db_sync list routing ────────────────────────────────────────────

describe('trigger_db_sync sends tables and views in the one list SyncEngine has', () => {
  const db = fakeDb([
    { name: 'ConDemoNoteHeader', type: 'table' },
    { name: 'ConDemoNoteView', type: 'view' },
  ]);

  it('labels each explicit name by its indexed type (for the summary, not for routing)', () => {
    const { targets, unresolved } = classifySyncTargets(
      ['ConDemoNoteHeader', 'ConDemoNoteView'],
      db,
    );
    expect(targets).toEqual([
      { name: 'ConDemoNoteHeader', kind: 'table' },
      { name: 'ConDemoNoteView', kind: 'view' },
    ]);
    expect(unresolved).toEqual([]);
  });

  it('keeps every requested name — a view must not be dropped on its way to -synclist', () => {
    const { targets } = classifySyncTargets(['ConDemoNoteHeader', 'ConDemoNoteView'], db);
    expect(targets.map(t => t.name).join(',')).toBe('ConDemoNoteHeader,ConDemoNoteView');
  });

  it('reports an unindexed name instead of vouching for it', () => {
    const { targets, unresolved } = classifySyncTargets(['BrandNewTable'], db);
    expect(targets).toEqual([{ name: 'BrandNewTable', kind: 'table' }]);
    expect(unresolved).toEqual(['BrandNewTable']);
  });

  it('labels everything a table when no index is available (unchanged behaviour)', () => {
    const { targets, unresolved } = classifySyncTargets(['ConDemoNoteView'], undefined);
    expect(targets).toEqual([{ name: 'ConDemoNoteView', kind: 'table' }]);
    expect(unresolved).toEqual([]);
  });

  it('never emits -viewlist — SyncEngine has no such argument', () => {
    const args = buildSyncEngineArgs({
      targets: [
        { name: 'ConDemoNoteHeader', kind: 'table' },
        { name: 'ConDemoNoteView', kind: 'view' },
      ],
      syncViews: true,
      metadataBinPath: 'K:\\Pkg',
      connStr: 'Data Source=localhost',
    });
    expect(args.some(a => a.startsWith('-viewlist'))).toBe(false);
    // Both names, one list — the parameter SyncEngine reports as TableOrViewList.
    expect(args).toContain('-synclist=ConDemoNoteHeader,ConDemoNoteView');
    expect(args).toContain('-syncmode=PartialList');
  });

  it('still uses FullAllAndViews for a full sync with syncViews', () => {
    const args = buildSyncEngineArgs({
      targets: [], syncViews: true, metadataBinPath: 'K:\\Pkg', connStr: 'Data Source=localhost',
    });
    expect(args).toContain('-syncmode=FullAllAndViews');
    expect(args).toContain('-verbosediagnostics');
    expect(args.some(a => a.startsWith('-synclist'))).toBe(false);
    expect(args.some(a => a.startsWith('-viewlist'))).toBe(false);
  });

  it('keeps -verbosediagnostics off the partial path', () => {
    const args = buildSyncEngineArgs({
      targets: [{ name: 'ConDemoNoteHeader', kind: 'table' }],
      syncViews: false, metadataBinPath: 'K:\\Pkg', connStr: 'Data Source=localhost',
    });
    expect(args).not.toContain('-verbosediagnostics');
  });

  it('takes the kind from the AOT folder when extracting from a project file', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dbsync-'));
    const projectPath = path.join(dir, 'Demo.rnrproj');
    await fs.writeFile(projectPath, `<?xml version="1.0" encoding="utf-8"?>
<Project xmlns="http://schemas.microsoft.com/developer/msbuild/2003">
  <ItemGroup>
    <Content Include="AxTable\\ConDemoNoteHeader" />
    <Content Include="AxTableExtension\\CustTable.ConDemoExt" />
    <Content Include="AxView\\ConDemoNoteView" />
    <Content Include="AxDataEntityView\\ConDemoNoteEntity" />
    <Content Include="AxClass\\ConDemoService" />
  </ItemGroup>
</Project>
`, 'utf-8');
    try {
      const targets = await extractTablesFromProject(projectPath);
      expect(targets).toEqual([
        { name: 'ConDemoNoteHeader', kind: 'table' },
        { name: 'CustTable', kind: 'table' },
        { name: 'ConDemoNoteView', kind: 'view' },
        { name: 'ConDemoNoteEntity', kind: 'view' },
      ]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

// ── control types for a form over a view ────────────────────────────────────

describe('form controls over a view are typed from the underlying table', () => {
  // Shapes taken from the real AOT: ApplicationSuite/Foundation/AxView/
  // ActivityListOpenStatusView.xml and its AxQuery/ActivityListOpenStatus.xml.
  const VIEW_XML = `<?xml version="1.0" encoding="utf-8"?>
<AxView xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
\t<Name>ConDemoNoteView</Name>
\t<TitleField1>NoteId</TitleField1>
\t<Query>ConDemoNoteQuery</Query>
\t<Fields>
\t\t<AxViewField xmlns=""
\t\t\ti:type="AxViewFieldBound">
\t\t\t<Name>NoteId</Name>
\t\t\t<DataField>NoteId</DataField>
\t\t\t<DataSource>ConDemoNoteHeader</DataSource>
\t\t</AxViewField>
\t\t<AxViewField xmlns=""
\t\t\ti:type="AxViewFieldBound">
\t\t\t<Name>ViewNoteStatus</Name>
\t\t\t<DataField>NoteStatus</DataField>
\t\t\t<DataSource>ConDemoNoteHeader</DataSource>
\t\t</AxViewField>
\t\t<AxViewField xmlns=""
\t\t\ti:type="AxViewFieldBound">
\t\t\t<Name>NoteDate</Name>
\t\t\t<DataField>NoteDate</DataField>
\t\t\t<DataSource>ConDemoNoteHeader</DataSource>
\t\t</AxViewField>
\t</Fields>
</AxView>
`;

  const QUERY_XML = `<?xml version="1.0" encoding="utf-8"?>
<AxQuery xmlns:i="http://www.w3.org/2001/XMLSchema-instance" i:type="AxQuerySimple">
\t<Name>ConDemoNoteQuery</Name>
\t<DataSources>
\t\t<AxQuerySimpleRootDataSource>
\t\t\t<Name>ConDemoNoteHeader</Name>
\t\t\t<Table>ConDemoNoteHeaderTable</Table>
\t\t\t<DataSources />
\t\t</AxQuerySimpleRootDataSource>
\t</DataSources>
</AxQuery>
`;

  const TABLE_XML = `<?xml version="1.0" encoding="utf-8"?>
<AxTable xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
\t<Name>ConDemoNoteHeaderTable</Name>
\t<Fields>
\t\t<AxTableField xmlns=""
\t\t\t\ti:type="AxTableFieldString">
\t\t\t<Name>NoteId</Name>
\t\t</AxTableField>
\t\t<AxTableField xmlns=""
\t\t\t\ti:type="AxTableFieldEnum">
\t\t\t<Name>NoteStatus</Name>
\t\t\t<EnumType>ConDemoNoteStatus</EnumType>
\t\t</AxTableField>
\t\t<AxTableField xmlns=""
\t\t\t\ti:type="AxTableFieldDate">
\t\t\t<Name>NoteDate</Name>
\t\t</AxTableField>
\t</Fields>
</AxTable>
`;

  let dir: string;
  let db: DbLike;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'viewtypes-'));
    const write = async (n: string, xml: string) => {
      const p = path.join(dir, `${n}.xml`);
      await fs.writeFile(p, xml, 'utf-8');
      return p;
    };
    db = fakeDb([
      { name: 'ConDemoNoteView', type: 'view', file_path: await write('ConDemoNoteView', VIEW_XML) },
      { name: 'ConDemoNoteQuery', type: 'query', file_path: await write('ConDemoNoteQuery', QUERY_XML) },
      { name: 'ConDemoNoteHeaderTable', type: 'table', file_path: await write('ConDemoNoteHeaderTable', TABLE_XML) },
    ]);
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('types each view field from the table field it is bound to', () => {
    const map = getFieldControlMap(db, 'ConDemoNoteView');
    // Keyed by the VIEW field name, typed by the TABLE field behind it.
    expect(map.get('noteid')?.typeValue).toBe('String');
    expect(map.get('viewnotestatus')?.typeValue).toBe('ComboBox');
    expect(map.get('notedate')?.typeValue).toBe('Date');
  });

  it('does not fall back to String for everything (the defect)', () => {
    const map = getFieldControlMap(db, 'ConDemoNoteView');
    const values = [...map.values()].map(v => v.typeValue);
    expect(values.every(v => v === 'String')).toBe(false);
  });

  it('resolves the view → query → table hop step by step', () => {
    const bindings = parseViewFieldBindings(VIEW_XML);
    expect(bindings).toEqual([
      { name: 'NoteId', dataField: 'NoteId', dataSource: 'ConDemoNoteHeader' },
      { name: 'ViewNoteStatus', dataField: 'NoteStatus', dataSource: 'ConDemoNoteHeader' },
      { name: 'NoteDate', dataField: 'NoteDate', dataSource: 'ConDemoNoteHeader' },
    ]);
    expect(parseViewQueryName(VIEW_XML)).toBe('ConDemoNoteQuery');
    // The datasource ALIAS is not the table name — that is the whole point of the hop.
    expect(parseQueryDataSourceTables(QUERY_XML).get('ConDemoNoteHeader')).toBe('ConDemoNoteHeaderTable');
  });

  it('leaves a plain table map exactly as it was', () => {
    const map = getFieldControlMap(db, 'ConDemoNoteHeaderTable');
    expect(map.get('noteid')?.typeValue).toBe('String');
    expect(map.get('notestatus')?.typeValue).toBe('ComboBox');
    expect(map.get('notedate')?.typeValue).toBe('Date');
  });

  it('returns an empty map — not a crash — when the query cannot be resolved', () => {
    const orphan = fakeDb([{ name: 'ConDemoNoteView', type: 'view', file_path: path.join(dir, 'ConDemoNoteView.xml') }]);
    expect(getFieldControlMap(orphan, 'ConDemoNoteView').size).toBe(0);
  });
});

// ── the sync verdict itself ─────────────────────────────────────────────────

describe('trigger_db_sync reports the outcome SyncEngine actually reported', () => {
  // Verbatim from a real run on the dev VM, 2026-07-22 (SyncEngine 7.0.30743).
  // The benign startup warning fires on EVERY sync in this environment.
  const BENIGN_WARNING =
    `Log level - Warning | Failed to abort paused PostServiceync resumable index from last run: ` +
    `System.Data.SqlClient.SqlException (0x80131904): Invalid column name 'DEFERREDOPERATIONSTATE'.\n` +
    `   at System.Data.SqlClient.SqlConnection.OnError(SqlException exception, Boolean breakConnection)`;
  const COMPLETED =
    `2026-07-22T12:04:35.1357614+00:00 PartialList finished. Time elapsed: 00:02:03.4793213.\n` +
    `Sync finished and took 141001 milliseconds.`;

  it('a completed sync is a success even though the log says "Failed"/"Exception"', () => {
    const v = classifySyncOutcome(`${BENIGN_WARNING}\n${COMPLETED}`);
    expect(v.succeeded).toBe(true);
  });

  it('the old any-word-anywhere heuristic is what called that run a failure', () => {
    // Pinned so nobody reintroduces it: this is the exact test that was wrong.
    const old = /\b(error|failed|exception)\b/i.test(`${BENIGN_WARNING}\n${COMPLETED}`);
    expect(old).toBe(true);
    expect(classifySyncOutcome(`${BENIGN_WARNING}\n${COMPLETED}`).succeeded).toBe(true);
  });

  it('a rejected argument fails the run even when SyncEngine carries on to completion', () => {
    // Exactly how the bogus -viewlist went unnoticed: dropped, then "finished".
    const v = classifySyncOutcome(
      `Invalid argument -viewlist=ActivityListOpenStatusView specified\n${COMPLETED}`,
    );
    expect(v.succeeded).toBe(false);
    expect(v.reason).toContain('-viewlist');
  });

  it('a run that never reports completion is a failure', () => {
    expect(classifySyncOutcome(BENIGN_WARNING).succeeded).toBe(false);
    expect(classifySyncOutcome('').succeeded).toBe(false);
  });

  it('an explicit failure line is a failure regardless of a completion line', () => {
    const v = classifySyncOutcome(`Sync failed for table CustTable\n${COMPLETED}`);
    expect(v.succeeded).toBe(false);
    expect(v.reason).toContain('Sync failed');
  });
});
