/**
 * Synthetic xref SQLite files in the export's format (schema 1): the three
 * DYNAMICSXREFDB tables, the export's indexes, ANALYZE and a meta table. Built
 * inside each test from a list of references between paths; no real data.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSyncClass } from '../../src/database/nodeSqlite';

export interface FixtureRef {
  src: string;
  tgt: string;
  kind: number;
  line?: number;
  col?: number;
  /** Module of the source name (created on first use). */
  module?: string;
  /** Source id that is not in Names (the export keeps such rows). */
  danglingSource?: boolean;
}

export interface FixtureOptions {
  refs: FixtureRef[];
  /** Extra names with no references. */
  names?: string[];
  /** meta rows; null = no meta table. Defaults to a valid schema-1 full export. */
  meta?: Record<string, string> | null;
  /** Leave out the export's indexes. */
  noIndexes?: boolean;
}

export const VALID_META: Record<string, string> = {
  kind: 'full',
  schema: '1',
  exported_at: '2026-10-30T12:00:00Z',
  source_server: 'contoso-dev',
  source_db: 'DYNAMICSXREFDB',
  customer: 'contoso',
  names: '0',
  references: '0',
  orphans_removed: '0',
};

export function tempDir(prefix = 'xref-sqlite-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function buildXrefFixture(file: string, opts: FixtureOptions): void {
  const db = new DatabaseSyncClass(file);
  try {
    db.exec(`
      CREATE TABLE Modules(Id INTEGER PRIMARY KEY, Module TEXT NOT NULL);
      CREATE TABLE Names(Id INTEGER PRIMARY KEY, Path TEXT NOT NULL, ModuleId INTEGER);
      CREATE TABLE "References"(SourceId INTEGER NOT NULL, TargetId INTEGER NOT NULL, Kind INTEGER, Line INTEGER, "Column" INTEGER);
    `);
    const modules = new Map<string, number>();
    const names = new Map<string, number>();
    const moduleId = (m: string) => {
      let id = modules.get(m);
      if (id === undefined) {
        id = modules.size + 1;
        modules.set(m, id);
        db.prepare('INSERT INTO Modules VALUES (?, ?)').run(id, m);
      }
      return id;
    };
    const insName = db.prepare('INSERT INTO Names VALUES (?, ?, ?)');
    const nameId = (p: string, module = 'ApplicationSuite') => {
      let id = names.get(p);
      if (id === undefined) {
        // Ids are spread out, as in a real export: nothing may assume they are dense.
        id = 1000 + names.size * 7;
        names.set(p, id);
        insName.run(id, p, moduleId(module));
      }
      return id;
    };
    const insRef = db.prepare('INSERT INTO "References" VALUES (?, ?, ?, ?, ?)');
    db.exec('BEGIN');
    for (const n of opts.names ?? []) nameId(n);
    let dangling = 9_000_000;
    for (const r of opts.refs) {
      const src = r.danglingSource ? dangling++ : nameId(r.src, r.module);
      insRef.run(src, nameId(r.tgt), r.kind, r.line ?? 1, r.col ?? 1);
    }
    db.exec('COMMIT');
    if (!opts.noIndexes) {
      db.exec(`
        CREATE INDEX ix_names_path ON Names(Path COLLATE NOCASE);
        CREATE INDEX ix_ref_target ON "References"(TargetId);
        CREATE INDEX ix_ref_source ON "References"(SourceId);
      `);
    }
    db.exec('ANALYZE');
    const meta = opts.meta === undefined ? VALID_META : opts.meta;
    if (meta !== null) {
      db.exec('CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL)');
      const ins = db.prepare('INSERT INTO meta VALUES (?, ?)');
      for (const [k, v] of Object.entries({
        ...meta,
        names: String(names.size),
        references: String(opts.refs.length),
      })) {
        if (k in meta) ins.run(k, v);
      }
    }
  } finally {
    db.close();
  }
}

// ── The standard fixture: one Contoso table, service class, extension and handler ──

export const K = { CALL: 1, TYPE: 2, ATTR: 7 } as const;

export function contosoRefs(): FixtureRef[] {
  return [
    // X++ code references to the table, its field and the service.
    {
      src: '/Classes/ContosoCaller/Methods/doIt',
      tgt: '/Classes/ContosoService/Methods/run',
      kind: K.CALL,
      line: 10,
      module: 'ContosoExt',
    },
    {
      src: '/Classes/ContosoCaller/Methods/doIt',
      tgt: '/Tables/ContosoTable',
      kind: K.TYPE,
      line: 11,
      module: 'ContosoExt',
    },
    {
      src: '/Classes/ContosoCaller/Methods/doIt',
      tgt: '/Tables/ContosoTable/Fields/Amount',
      kind: K.TYPE,
      line: 12,
      module: 'ContosoExt',
    },
    { src: '/Classes/ContosoReport/Methods/print', tgt: '/Tables/ContosoTable/Fields/Amount', kind: K.TYPE, line: 3 },
    // Declarative metadata references (singular, no leading slash).
    { src: 'Form/ContosoForm/FormDataSourceRoot/ContosoTable?Table', tgt: 'Table/ContosoTable', kind: K.TYPE, line: 0 },
    {
      src: 'Table/ContosoOrder/TableFieldReal/Amount?ExtendedDataType',
      tgt: 'Table/ContosoTable/TableFieldReal/Amount',
      kind: K.TYPE,
      line: 0,
    },
    // A field added by a table extension, in both shapes.
    {
      src: '/Classes/ContosoCaller/Methods/extra',
      tgt: '/TableExtensions/ContosoTable.ContosoExt/Fields/ExtraField',
      kind: K.TYPE,
      line: 4,
      module: 'ContosoExt',
    },
    {
      src: 'Form/ContosoForm/FormDesign/Grid/ExtraField?DataField',
      tgt: 'TableExtension/ContosoTable.ContosoExt/TableFieldString/ExtraField',
      kind: K.TYPE,
      line: 0,
    },
    // A reference whose source is no longer in Names: never a row, never counted.
    { src: '', tgt: '/Tables/ContosoTable', kind: K.TYPE, line: 99, danglingSource: true },
    // A name that collides with the LIKE metacharacters: "_" must stay literal.
    {
      src: '/Classes/ContosoXCaller/Methods/go',
      tgt: '/Classes/ContosoServiceXContosoExtXExtension/Methods/run',
      kind: K.CALL,
      line: 2,
    },

    // CoC: [ExtensionOf(classStr(ContosoService))] on line 3; its run() calls next run().
    {
      src: '/Classes/ContosoService_ContosoExt_Extension',
      tgt: '/Classes/ExtensionOf',
      kind: K.ATTR,
      line: 3,
      col: 2,
      module: 'ContosoExt',
    },
    {
      src: '/Classes/ContosoService_ContosoExt_Extension',
      tgt: '/Classes/ContosoService',
      kind: K.TYPE,
      line: 3,
      col: 14,
      module: 'ContosoExt',
    },
    {
      src: '/Classes/ContosoService_ContosoExt_Extension/Methods/run',
      tgt: '/Classes/ContosoService/Methods/run',
      kind: K.CALL,
      line: 8,
      module: 'ContosoExt',
    },
    {
      src: '/Classes/ContosoService_ContosoExt_Extension/Methods/run',
      tgt: '/Classes/ContosoService/Methods/other',
      kind: K.CALL,
      line: 9,
      module: 'ContosoExt',
    },
    // Not an extension of ContosoService: it extends another class and names the service on another line.
    { src: '/Classes/ContosoDecoy_Extension', tgt: '/Classes/ExtensionOf', kind: K.ATTR, line: 1, col: 2 },
    { src: '/Classes/ContosoDecoy_Extension', tgt: '/Classes/ContosoOtherBase', kind: K.TYPE, line: 1, col: 14 },
    { src: '/Classes/ContosoDecoy_Extension', tgt: '/Classes/ContosoService', kind: K.TYPE, line: 5, col: 4 },
    // A form data source CoC: formDataSourceStr(ContosoForm, ContosoTable) → a prefix chain.
    { src: '/Classes/ContosoFormDS_Extension', tgt: '/Classes/ExtensionOf', kind: K.ATTR, line: 1, col: 2 },
    { src: '/Classes/ContosoFormDS_Extension', tgt: '/Forms/ContosoForm', kind: K.TYPE, line: 1, col: 20 },
    {
      src: '/Classes/ContosoFormDS_Extension',
      tgt: '/Forms/ContosoForm/DataSources/ContosoTable',
      kind: K.TYPE,
      line: 1,
      col: 32,
    },

    // Event handlers referencing the table.
    {
      src: '/Classes/ContosoTableEventHandler/Methods/ContosoTable_onInserted',
      tgt: '/Tables/ContosoTable',
      kind: K.TYPE,
      line: 5,
    },
    {
      src: '/Classes/ContosoTableEventHandler/Methods/ContosoTable_Post_validateWrite',
      tgt: '/Tables/ContosoTable/Methods/validateWrite',
      kind: K.TYPE,
      line: 7,
    },
  ];
}

/** `n` code references from distinct callers to one target. */
export function manyRefs(target: string, n: number, srcPrefix = '/Classes/ContosoBulk'): FixtureRef[] {
  return Array.from({ length: n }, (_, i) => ({
    src: `${srcPrefix}${i}/Methods/m`,
    tgt: target,
    kind: K.CALL,
    line: i + 1,
  }));
}
