/**
 * Regression gate for the three writer defects the 2026-07-22 corpus record
 * `2026-07-22T04__L2-form-over-view` raised alongside #37 and that were filed
 * under "Open — writers" in docs/eval-sweep-findings-2026-07-21.md.
 *
 * Covered here (both VM-free):
 *   - generate_object(scaffold, form) rejected a VIEW as `dataSource` because
 *     the scaffold's own lookup was scoped to tables only, even though
 *     object_patterns resolves the same view.
 *   - trigger_db_sync(tables=[…], syncViews=true) put tables AND views in
 *     `-viewlist`; SyncEngine aborts with "Invalid argument -viewlist=…".
 *
 * The third (view <DataSource> defaulting to the query name) is #38 and is
 * already gated by tests/tools/createWriterDefects.test.ts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { handleGenerateSmartForm } from '../../src/tools/generateSmartForm';
import { classifySyncTargets, extractTablesFromProject } from '../../src/tools/dbSync';
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
function fakeDb(rows: Array<{ name: string; type: string }>): DbLike {
  return {
    prepare: (sql: string) => ({
      get: () => undefined,
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
          .map(r => ({ ...r, model: 'MyModel', extends_class: null, file_path: null }));
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

describe('trigger_db_sync splits tables and views into their own SyncEngine lists', () => {
  const db = fakeDb([
    { name: 'ConDemoNoteHeader', type: 'table' },
    { name: 'ConDemoNoteView', type: 'view' },
  ]);

  it('routes each explicit name by its indexed type', () => {
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

  it('never puts a table in the view list — the failure SyncEngine aborts on', () => {
    const { targets } = classifySyncTargets(['ConDemoNoteHeader', 'ConDemoNoteView'], db);
    const views = targets.filter(t => t.kind === 'view').map(t => t.name);
    expect(views).toEqual(['ConDemoNoteView']);
    expect(views).not.toContain('ConDemoNoteHeader');
  });

  it('falls back to the table list for an unindexed name, and says so', () => {
    const { targets, unresolved } = classifySyncTargets(['BrandNewTable'], db);
    expect(targets).toEqual([{ name: 'BrandNewTable', kind: 'table' }]);
    expect(unresolved).toEqual(['BrandNewTable']);
  });

  it('classifies everything as a table when no index is available (pre-fix behaviour)', () => {
    const { targets, unresolved } = classifySyncTargets(['ConDemoNoteView'], undefined);
    expect(targets).toEqual([{ name: 'ConDemoNoteView', kind: 'table' }]);
    expect(unresolved).toEqual([]);
  });

  it('takes the split from the AOT folder when extracting from a project file', async () => {
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
