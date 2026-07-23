/**
 * get_object_info extension-type tests.
 *
 * Exercises the generic object-extension readers (form/enum/edt/data-entity/
 * class-extension) end-to-end through getObjectInfoTool → READER_DISPATCH,
 * against a real in-memory SQLite database using the production schema subset.
 *
 * Regression guard for PR #557: extension types must be advertised by both
 * OBJECT_INFO_TYPES and the dispatch registry, and class-extension must return
 * extension metadata (CoC/added methods) — not be silently routed to the base
 * class reader.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Database from '../../src/database/sqlite.js';
import { getObjectInfoTool } from '../../src/tools/getObjectInfo';
import {
  READER_DISPATCH,
  OBJECT_INFO_TYPES,
  BATCH_INFO_TYPES,
} from '../../src/tools/objectInfoRegistry';
import type { XppServerContext } from '../../src/types/context';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';

let db: InstanceType<typeof Database>;
let context: XppServerContext;

const req = (objectType: string, name: string): CallToolRequest => ({
  method: 'tools/call',
  params: { name: 'get_object_info', arguments: { objectType, name } },
});

const textOf = async (objectType: string, name: string): Promise<string> => {
  const res = await getObjectInfoTool(req(objectType, name), context);
  return res.content[0].text as string;
};

beforeAll(() => {
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE symbols (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      model TEXT,
      parent_name TEXT,
      extends_class TEXT
    );
    CREATE TABLE extension_metadata (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      extension_name TEXT,
      extension_type TEXT,
      base_object_name TEXT,
      added_fields TEXT,
      added_indexes TEXT,
      added_methods TEXT,
      coc_methods TEXT,
      event_subscriptions TEXT,
      model TEXT
    );
  `);

  const insMeta = db.prepare(
    `INSERT INTO extension_metadata
       (extension_name, extension_type, base_object_name, added_fields, added_indexes,
        added_methods, coc_methods, event_subscriptions, model)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  // form-extension with a CoC method + event subscription
  insMeta.run('CustTable.ContosoForm_Extension', 'form-extension', 'CustTable',
    null, null, null, '["init"]', '["onInitialized"]', 'Contoso');
  // enum-extension
  insMeta.run('NoYes.Contoso_Extension', 'enum-extension', 'NoYes',
    null, null, null, null, null, 'Contoso');
  // edt-extension
  insMeta.run('AccountNum.Contoso_Extension', 'edt-extension', 'AccountNum',
    null, null, null, null, null, 'Contoso');
  // data-entity-extension
  insMeta.run('CustomerEntity.Contoso_Extension', 'data-entity-extension', 'CustomerEntity',
    null, null, null, null, null, 'Contoso');
  // class-extension — the regression-critical one (CoC wrap + new method)
  insMeta.run('SalesFormLetterContoso_Extension', 'class-extension', 'SalesFormLetter',
    null, null, '["postJournal","helper"]', '["postJournal"]', null, 'Contoso');

  // symbols-only fallback (no extension_metadata row) for a form extension
  db.prepare(
    'INSERT INTO symbols (name, type, model, extends_class) VALUES (?, ?, ?, ?)',
  ).run('VendTable.Legacy_Extension', 'form-extension', 'LegacyModel', 'VendTable');

  context = {
    symbolIndex: {
      getReadDb: () => db,
    } as any,
  } as XppServerContext;
});

afterAll(() => db.close());

describe('get_object_info — extension types are registered', () => {
  it('OBJECT_INFO_TYPES contains every extension type', () => {
    for (const t of [
      'table-extension', 'form-extension', 'enum-extension',
      'edt-extension', 'data-entity-extension', 'class-extension',
    ]) {
      expect(OBJECT_INFO_TYPES).toContain(t);
      expect(BATCH_INFO_TYPES).toContain(t);
      expect(READER_DISPATCH[t]).toBeDefined();
    }
  });
});

describe('get_object_info — generic object-extension readers', () => {
  it('returns a form extension from extension_metadata', async () => {
    const text = await textOf('form-extension', 'CustTable');
    expect(text).toContain('Form Extensions of: CustTable');
    expect(text).toContain('CustTable.ContosoForm_Extension');
    expect(text).toContain('Wraps Methods (CoC) (1): init');
    expect(text).toContain('Event Subscriptions (1): onInitialized');
  });

  it('accepts a full extension name and strips the dot suffix to the base name', async () => {
    const text = await textOf('form-extension', 'CustTable.AnythingHere');
    expect(text).toContain('Form Extensions of: CustTable');
    expect(text).toContain('CustTable.ContosoForm_Extension');
  });

  it('reads enum / edt / data-entity extensions with the right label', async () => {
    expect(await textOf('enum-extension', 'NoYes')).toContain('Enum Extensions of: NoYes');
    expect(await textOf('edt-extension', 'AccountNum')).toContain('EDT Extensions of: AccountNum');
    expect(await textOf('data-entity-extension', 'CustomerEntity'))
      .toContain('DataEntity Extensions of: CustomerEntity');
  });

  it('class-extension returns extension metadata (CoC + new methods), not base class info', async () => {
    const text = await textOf('class-extension', 'SalesFormLetter');
    expect(text).toContain('Class Extensions of: SalesFormLetter');
    expect(text).toContain('SalesFormLetterContoso_Extension');
    // CoC wrap surfaced
    expect(text).toContain('Wraps Methods (CoC) (1): postJournal');
    // "helper" is a genuinely new method (not a CoC wrap) → listed under Added Methods
    expect(text).toContain('Added Methods (1): helper');
    // must NOT have fallen through to the base-class reader
    expect(text).not.toContain('# Class:');
    expect(text).not.toContain('not found');
  });

  it('falls back to the symbols table when extension_metadata has no row', async () => {
    const text = await textOf('form-extension', 'VendTable');
    expect(text).toContain('VendTable.Legacy_Extension');
    expect(text).toContain('LegacyModel');
  });

  it('reports an empty result cleanly for an unknown base object', async () => {
    const text = await textOf('enum-extension', 'DoesNotExist');
    expect(text).toContain('No enum-extension found in index for "DoesNotExist"');
  });
});
