import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { describeSchemaChanges, scanSchemaChanges } from '../../src/tools/sdlc/schemaChangeGuard';

describe('scanSchemaChanges', () => {
  const PKG = 'ContosoExt';
  // The last build wrote its compiler metadata at BUILT; sources are older or newer than that.
  const OLDER = new Date('2026-01-01T00:00:00Z');
  const BUILT = new Date('2026-02-01T00:00:00Z');
  const NEWER = new Date('2026-03-01T00:00:00Z');
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-guard-'));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const write = (file: string, mtime: Date) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '<x/>', 'utf-8');
    fs.utimesSync(file, mtime, mtime);
  };
  const src = (type: string, name: string, model = PKG) => path.join(root, PKG, model, type, `${name}.xml`);
  const meta = (type: string, name: string, model = PKG) => path.join(root, PKG, 'XppMetadata', model, type, `${name}.xml`);
  /** A source the last build compiled: older than the metadata that build wrote for it. */
  const built = (type: string, name: string) => {
    write(src(type, name), OLDER);
    write(meta(type, name), BUILT);
  };
  const scan = () => scanSchemaChanges(root, root, PKG);

  it('reports nothing when every source is older than the last build', async () => {
    built('AxTable', 'ContosoRentEquipmentTable');
    built('AxClass', 'ContosoRentService');
    write(src('AxEdt', 'ContosoRentEquipmentId'), OLDER);
    write(src('AxEnum', 'ContosoRentStatus'), OLDER);
    write(src('AxTableExtension', 'CustTable.ContosoExt'), OLDER);

    expect(await scan()).toEqual({ changed: [], errors: [] });
  });

  it('flags a table whose source is newer than its own compiler-metadata copy', async () => {
    built('AxTable', 'ContosoRentEquipmentTable');
    built('AxTable', 'ContosoRentOrderTable');
    write(src('AxTable', 'ContosoRentOrderTable'), NEWER);

    expect((await scan()).changed).toEqual(['AxTable/ContosoRentOrderTable']);
  });

  it('flags a table that has no compiler-metadata copy yet', async () => {
    built('AxClass', 'ContosoRentService');
    write(src('AxTable', 'ContosoRentEquipmentTable'), OLDER);

    expect((await scan()).changed).toEqual(['AxTable/ContosoRentEquipmentTable']);
  });

  it('treats a table with the same mtime as its copy as current', async () => {
    write(src('AxTable', 'ContosoRentEquipmentTable'), BUILT);
    write(meta('AxTable', 'ContosoRentEquipmentTable'), BUILT);

    expect((await scan()).changed).toEqual([]);
  });

  it('flags EDTs, enums and extensions newer than the newest compiler-metadata file', async () => {
    built('AxClass', 'ContosoRentService');
    write(src('AxEdt', 'ContosoRentEquipmentId'), NEWER);
    write(src('AxEdt', 'ContosoRentUnchangedId'), OLDER);
    write(src('AxEdtExtension', 'ItemId.ContosoExt'), NEWER);
    write(src('AxEnum', 'ContosoRentStatus'), NEWER);
    write(src('AxEnumExtension', 'SalesStatus.ContosoExt'), NEWER);
    write(src('AxTableExtension', 'CustTable.ContosoExt'), NEWER);

    expect((await scan()).changed).toEqual([
      'AxTableExtension/CustTable.ContosoExt',
      'AxEdt/ContosoRentEquipmentId',
      'AxEdtExtension/ItemId.ContosoExt',
      'AxEnum/ContosoRentStatus',
      'AxEnumExtension/SalesStatus.ContosoExt',
    ]);
  });

  it('takes the newest metadata file of the whole package as the last build, not the oldest', async () => {
    // One class was rebuilt after the EDT changed: that build compiled the package, EDT included.
    built('AxTable', 'ContosoRentEquipmentTable');
    write(src('AxEdt', 'ContosoRentEquipmentId'), new Date('2026-02-10T00:00:00Z'));
    write(meta('AxClass', 'ContosoRentService', 'ContosoCore'), new Date('2026-02-20T00:00:00Z'));

    expect((await scan()).changed).toEqual([]);
  });

  it('reports nothing for a model that was never built, whatever its sources', async () => {
    write(src('AxTable', 'ContosoRentEquipmentTable'), NEWER);
    write(src('AxEdt', 'ContosoRentEquipmentId'), NEWER);
    write(src('AxEnum', 'ContosoRentStatus'), NEWER);

    expect(await scan()).toEqual({ changed: [], errors: [] });
  });

  it('does not promote on EDTs and enums when the metadata tree holds no file to compare with', async () => {
    fs.mkdirSync(path.join(root, PKG, 'XppMetadata', PKG), { recursive: true });
    write(src('AxEdt', 'ContosoRentEquipmentId'), NEWER);
    write(src('AxEnum', 'ContosoRentStatus'), NEWER);

    expect((await scan()).changed).toEqual([]);
  });

  it('ignores other element types and files that are not XML', async () => {
    built('AxTable', 'ContosoRentEquipmentTable');
    write(src('AxClass', 'ContosoRentService'), NEWER);
    write(src('AxForm', 'ContosoRentEquipment'), NEWER);
    write(path.join(root, PKG, PKG, 'AxEnum', 'notes.txt'), NEWER);

    expect((await scan()).changed).toEqual([]);
  });

  it('reads the compiler metadata from its own root when that differs from the source root', async () => {
    const metaRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-guard-meta-'));
    try {
      write(src('AxTable', 'ContosoRentEquipmentTable'), NEWER);
      write(path.join(metaRoot, PKG, 'XppMetadata', PKG, 'AxTable', 'ContosoRentEquipmentTable.xml'), BUILT);

      expect((await scanSchemaChanges(metaRoot, root, PKG)).changed).toEqual(['AxTable/ContosoRentEquipmentTable']);
    } finally {
      fs.rmSync(metaRoot, { recursive: true, force: true });
    }
  });

  it('reports a missing package folder as an error rather than throwing', async () => {
    const metaRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-guard-meta-'));
    try {
      write(path.join(metaRoot, PKG, 'XppMetadata', PKG, 'AxTable', 'ContosoRentEquipmentTable.xml'), BUILT);

      const r = await scanSchemaChanges(metaRoot, root, PKG);
      expect(r.changed).toEqual([]);
      expect(r.errors).toHaveLength(1);
    } finally {
      fs.rmSync(metaRoot, { recursive: true, force: true });
    }
  });
});

describe('describeSchemaChanges', () => {
  it('counts per type, singular and plural, and names the objects', () => {
    expect(
      describeSchemaChanges([
        'AxTable/ContosoRentEquipmentTable',
        'AxTable/ContosoRentOrderTable',
        'AxTable/ContosoRentLineTable',
        'AxEdt/ContosoRentEquipmentId',
      ]),
    ).toBe(
      '3 tables, 1 EDT changed since the last build: ContosoRentEquipmentTable, ContosoRentOrderTable, ContosoRentLineTable, ContosoRentEquipmentId',
    );
  });

  it('names the extension types and a single enum', () => {
    expect(describeSchemaChanges(['AxTableExtension/CustTable.ContosoExt', 'AxEnum/ContosoRentStatus', 'AxEnumExtension/SalesStatus.ContosoExt'])).toBe(
      '1 table extension, 1 enum, 1 enum extension changed since the last build: CustTable.ContosoExt, ContosoRentStatus, SalesStatus.ContosoExt',
    );
  });

  it('names a handful and counts the rest', () => {
    const changed = Array.from({ length: 8 }, (_, i) => `AxEdt/ContosoRentId${i}`);
    expect(describeSchemaChanges(changed)).toBe(
      '8 EDTs changed since the last build: ContosoRentId0, ContosoRentId1, ContosoRentId2, ContosoRentId3, ContosoRentId4, … (+3)',
    );
  });
});
