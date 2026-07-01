/**
 * resolve_references tests — semantic reference resolution against a real
 * in-memory SQLite database using the production schema subset.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  resolveXppReferences,
  gateOnReferenceErrors,
  resolveReferencesTool,
  type ResolverDeps,
} from '../../src/tools/resolveReferences';
import { validateCodeTool } from '../../src/tools/validateCode';

const ORIGINAL_ENFORCE = process.env.GROUNDING_ENFORCE;

let db: InstanceType<typeof Database>;
let deps: ResolverDeps;

const LABELS: Record<string, string[]> = {
  // labelFileId → known label ids
  SYS: ['SYS12345'],
  Contoso: ['MyLabel'],
};

function makeDeps(database: InstanceType<typeof Database>): ResolverDeps {
  return {
    db: database,
    getLabelById: (labelId: string, labelFileId?: string) => {
      const hit = (fileId: string) =>
        (LABELS[fileId] ?? []).includes(labelId) ? [{ labelId, labelFileId: fileId }] : [];
      if (labelFileId) return hit(labelFileId);
      return Object.keys(LABELS).flatMap(hit);
    },
    getLabelFileIds: () => Object.keys(LABELS).map(labelFileId => ({ labelFileId })),
  };
}

beforeAll(() => {
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE symbols (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      parent_name TEXT,
      signature TEXT,
      extends_class TEXT
    );
    CREATE TABLE extension_metadata (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      extension_name TEXT,
      extension_type TEXT,
      base_object_name TEXT,
      added_fields TEXT,
      added_methods TEXT,
      coc_methods TEXT
    );
    CREATE TABLE menu_item_targets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      menu_item_name TEXT NOT NULL,
      menu_item_type TEXT
    );
  `);

  const sym = db.prepare(
    'INSERT INTO symbols (name, type, parent_name, signature, extends_class) VALUES (?, ?, ?, ?, ?)',
  );
  // Tables + fields + methods
  sym.run('CustTable', 'table', null, null, null);
  sym.run('AccountNum', 'field', 'CustTable', 'CustAccount', null);
  sym.run('CustGroup', 'field', 'CustTable', 'CustGroupId', null);
  sym.run('Blocked', 'field', 'CustTable', 'CustVendorBlocked', null);
  sym.run('validateWrite', 'method', 'CustTable', 'public boolean validateWrite()', null);
  sym.run('find', 'method', 'CustTable',
    'public static CustTable find(CustAccount _custAccount, boolean _forUpdate = false)', null);
  sym.run('SalesTable', 'table', null, null, null);
  sym.run('SalesId', 'field', 'SalesTable', 'SalesIdBase', null);
  // Classes with inheritance
  sym.run('SalesFormLetter', 'class', null, null, 'RunBaseBatch');
  sym.run('run', 'method', 'SalesFormLetter', 'public void run()', null);
  sym.run('ContosoBase', 'class', null, null, null);
  sym.run('doStuff', 'method', 'ContosoBase', 'public int doStuff(int _a, str _b = "")', null);
  sym.run('ContosoChild', 'class', null, null, 'ContosoBase');
  // Enum / EDT / form / query
  sym.run('NoYes', 'enum', null, null, null);
  sym.run('CustAccount', 'edt', null, 'AccountNum', null);
  sym.run('CustTableListPage', 'form', null, null, null);
  sym.run('CustTableSRS', 'query', null, null, null);

  db.prepare(
    `INSERT INTO extension_metadata
       (extension_name, extension_type, base_object_name, added_fields, added_methods, coc_methods)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run('CustTable.ContosoExtension', 'table-extension', 'CustTable', '["ContosoTier"]', null, null);
  db.prepare(
    `INSERT INTO extension_metadata
       (extension_name, extension_type, base_object_name, added_fields, added_methods, coc_methods)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run('SalesFormLetterContoso_Extension', 'class-extension', 'SalesFormLetter',
    null, null, '[{"name":"postJournal"}]');

  db.prepare('INSERT INTO menu_item_targets (menu_item_name, menu_item_type) VALUES (?, ?)')
    .run('CustTableListPage', 'display');

  deps = makeDeps(db);
});

afterAll(() => db.close());

afterEach(() => {
  if (ORIGINAL_ENFORCE === undefined) delete process.env.GROUNDING_ENFORCE;
  else process.env.GROUNDING_ENFORCE = ORIGINAL_ENFORCE;
});

const errorsOf = (code: string) =>
  resolveXppReferences(code, deps).violations.filter(v => v.severity === 'error');
const warningsOf = (code: string) =>
  resolveXppReferences(code, deps).violations.filter(v => v.severity === 'warning');

// ─── Clean code ──────────────────────────────────────────────────────────────

describe('resolveXppReferences — clean code', () => {
  it('verifies a realistic CoC wrapper with zero violations', () => {
    const code = `
[ExtensionOf(tableStr(CustTable))]
final class CustTableContoso_Extension
{
    public boolean validateWrite()
    {
        boolean ret = next validateWrite();
        CustTable custTable;

        if (custTable.AccountNum && custTable.Blocked == NoYes::Yes)
        {
            ret = checkFailed("@Contoso:MyLabel");
        }
        return ret;
    }
}`;
    const result = resolveXppReferences(code, deps);
    expect(result.violations).toEqual([]);
    expect(result.verifiedCount).toBeGreaterThan(3);
  });

  it('accepts system fields, extension fields and builtin table methods', () => {
    const code = `
CustTable custTable;
custTable.ContosoTier = 1;
if (custTable.RecId)
{
    custTable.doUpdate();
}`;
    expect(resolveXppReferences(code, deps).violations).toEqual([]);
  });

  it('accepts kernel classes without metadata', () => {
    const code = `
Map valueMap = new Map(Types::String, Types::String);
Query query = new Query();
QueryBuildDataSource qbds;
`;
    // Types:: is a kernel enum — must not be flagged
    expect(errorsOf(code)).toEqual([]);
  });

  it('verifies static call through the inheritance chain', () => {
    expect(errorsOf('ContosoChild::doStuff(1);')).toEqual([]);
  });

  it('verifies a CoC method recorded in extension_metadata', () => {
    expect(errorsOf('methodStr(SalesFormLetter, postJournal)')).toEqual([]);
  });

  it('verifies menu item intrinsics against menu_item_targets', () => {
    expect(errorsOf('menuItemDisplayStr(CustTableListPage)')).toEqual([]);
  });
});

// ─── Hallucinated symbols ────────────────────────────────────────────────────

describe('resolveXppReferences — hallucination detection', () => {
  it('flags an unknown table in tableStr()', () => {
    const errors = errorsOf('[ExtensionOf(tableStr(CustTabel))]');
    expect(errors).toHaveLength(1);
    expect(errors[0].kind).toBe('unknown-intrinsic-target');
    expect(errors[0].identifier).toContain('CustTabel');
  });

  it('flags an unknown field in fieldStr()', () => {
    const errors = errorsOf('fieldStr(CustTable, CreditLimit)');
    expect(errors).toHaveLength(1);
    expect(errors[0].kind).toBe('unknown-field');
  });

  it('flags a fake field on a bound buffer', () => {
    const errors = errorsOf('CustTable custTable;\ncustTable.FakeField = 1;');
    expect(errors).toHaveLength(1);
    expect(errors[0].kind).toBe('unknown-field');
    expect(errors[0].identifier).toBe('CustTable.FakeField');
  });

  it('flags an unknown static method', () => {
    const errors = errorsOf('CustTable::findByFoo("x");');
    expect(errors).toHaveLength(1);
    expect(errors[0].kind).toBe('unknown-static-member');
  });

  it('flags a completely unknown type in static access', () => {
    const errors = errorsOf('ContosoFakeHelper::run();');
    expect(errors).toHaveLength(1);
    expect(errors[0].kind).toBe('unknown-type');
  });

  it('reports an unknown declared type as warning (kernel classes are unindexable)', () => {
    const warnings = warningsOf('ContosoMissingType helper;');
    expect(warnings).toHaveLength(1);
    expect(warnings[0].kind).toBe('unknown-type');
  });

  it('flags an unknown instance method as warning', () => {
    const warnings = warningsOf('CustTable custTable;\ncustTable.fakeMethod();');
    expect(warnings).toHaveLength(1);
    expect(warnings[0].kind).toBe('unknown-method');
  });
});

// ─── Arity ───────────────────────────────────────────────────────────────────

describe('resolveXppReferences — arity checks', () => {
  it('accepts calls within the signature arity range', () => {
    expect(errorsOf('CustTable::find("c1");')).toEqual([]);
    expect(errorsOf('CustTable::find("c1", true);')).toEqual([]);
  });

  it('flags too few arguments', () => {
    const errors = errorsOf('CustTable::find();');
    expect(errors).toHaveLength(1);
    expect(errors[0].kind).toBe('arity-mismatch');
  });

  it('flags too many arguments', () => {
    const errors = errorsOf('CustTable::find("c1", true, 42);');
    expect(errors).toHaveLength(1);
    expect(errors[0].kind).toBe('arity-mismatch');
  });
});

// ─── Labels ──────────────────────────────────────────────────────────────────

describe('resolveXppReferences — labels', () => {
  it('verifies existing modern and legacy labels', () => {
    expect(resolveXppReferences('info("@Contoso:MyLabel");\ninfo("@SYS12345");', deps).violations)
      .toEqual([]);
  });

  it('flags a missing id in a KNOWN label file as error', () => {
    const errors = errorsOf('info("@Contoso:DoesNotExist");');
    expect(errors).toHaveLength(1);
    expect(errors[0].kind).toBe('unknown-label');
  });

  it('flags an unknown label file as warning (may be created later)', () => {
    const warnings = warningsOf('info("@BrandNewFile:SomeLabel");');
    expect(warnings).toHaveLength(1);
    expect(warnings[0].kind).toBe('unknown-label');
  });

  it('flags a missing legacy label as warning', () => {
    const warnings = warningsOf('info("@SYS99999");');
    expect(warnings).toHaveLength(1);
  });
});

// ─── Comments and strings are ignored ───────────────────────────────────────

describe('resolveXppReferences — preprocessing', () => {
  it('ignores identifiers inside comments and plain strings', () => {
    const code = `
// FakeTable::method() in a comment
/* CustTable.NothingHere */
str s = "FakeClass::run()";
`;
    expect(resolveXppReferences(code, deps).violations).toEqual([]);
  });
});

// ─── Fail-closed gate ────────────────────────────────────────────────────────

describe('gateOnReferenceErrors', () => {
  const stubIndex = {
    getReadDb: () => db as unknown as ResolverDeps['db'],
    getLabelById: deps?.getLabelById ?? ((id: string, f?: string) => makeDeps(db).getLabelById(id, f)),
    getLabelFileIds: () => Object.keys(LABELS).map(labelFileId => ({ labelFileId })),
  };

  it('returns null when enforcement is disabled', () => {
    delete process.env.GROUNDING_ENFORCE;
    expect(gateOnReferenceErrors('CustTable::findByFoo();', stubIndex, 'op')).toBeNull();
  });

  it('rejects code with error-severity violations when enforced', () => {
    process.env.GROUNDING_ENFORCE = 'true';
    const result = gateOnReferenceErrors(
      'CustTable custTable;\ncustTable.FakeField = 1;',
      stubIndex,
      'create_d365fo_file(...)',
    );
    expect(result?.isError).toBe(true);
    expect(result?.content[0].text).toContain('FakeField');
    expect(result?.content[0].text).toContain('resolve_references');
  });

  it('passes warning-only code when enforced', () => {
    process.env.GROUNDING_ENFORCE = 'true';
    expect(gateOnReferenceErrors('ContosoMissingType helper;', stubIndex, 'op')).toBeNull();
  });

  it('never blocks when no symbolIndex is available', () => {
    process.env.GROUNDING_ENFORCE = 'true';
    expect(gateOnReferenceErrors('Fake::stuff();', undefined, 'op')).toBeNull();
  });
});

// ─── MCP tool handler ────────────────────────────────────────────────────────

describe('resolveReferencesTool', () => {
  const context = {
    symbolIndex: {
      getReadDb: () => db,
      getLabelById: (id: string, f?: string) => makeDeps(db).getLabelById(id, f),
      getLabelFileIds: () => Object.keys(LABELS).map(labelFileId => ({ labelFileId })),
    },
  } as any;

  it('returns success summary for clean code', async () => {
    const result = await resolveReferencesTool(
      { params: { arguments: { code: 'CustTable::find("c1");' } } },
      context,
    );
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('✅');
    expect(result.content[0].text).toContain('verified');
  });

  it('returns isError with structured violations for hallucinated code', async () => {
    const result = await resolveReferencesTool(
      { params: { arguments: { code: 'CustTable::fakeStatic();', context: 'MyClass' } } },
      context,
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('unknown-static-member');
    expect(result.content[0].text).toContain('MyClass');
  });

  it('rejects missing code argument', async () => {
    const result = await resolveReferencesTool({ params: { arguments: {} } }, context);
    expect(result.isError).toBe(true);
  });
});

// ─── validate_code references mode for XML (xml-table) ───────────────────────
// Regression for eval/corpus L1-table-basic VALIDATOR_GAP: references mode never
// checked EDT names inside <ExtendedDataType>, so wrong EDTs passed the gate and
// only surfaced at build time.

describe('validateCodeTool references mode — xml-table EDT checking', () => {
  const context = {
    symbolIndex: {
      getReadDb: () => db,
      getLabelById: (id: string, f?: string) => makeDeps(db).getLabelById(id, f),
      getLabelFileIds: () => Object.keys(LABELS).map(labelFileId => ({ labelFileId })),
    },
  } as any;

  it('verifies a valid EDT reference in AxTableField XML', async () => {
    const xml = `<?xml version="1.0"?><AxTable><Name>MyTable</Name><Fields>
      <AxTableField i:type="AxTableFieldString"><Name>Account</Name>
        <ExtendedDataType>CustAccount</ExtendedDataType></AxTableField>
    </Fields></AxTable>`;
    const result = await validateCodeTool(
      { params: { arguments: { mode: 'references', codeType: 'xml-table', code: xml } } } as any,
      context,
    );
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('✅');
    expect(result.content[0].text).toContain('verified');
  });

  it('flags a hallucinated EDT name as an error (the VALIDATOR_GAP this closes)', async () => {
    const xml = `<?xml version="1.0"?><AxTable><Name>MyTable</Name><Fields>
      <AxTableField i:type="AxTableFieldString"><Name>Subject</Name>
        <ExtendedDataType>NoSuchEdtName</ExtendedDataType></AxTableField>
    </Fields></AxTable>`;
    const result = await validateCodeTool(
      { params: { arguments: { mode: 'references', codeType: 'xml-table', code: xml } } } as any,
      context,
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('NoSuchEdtName');
    expect(result.content[0].text).toContain('ExtendedDataType');
  });

  it('flags an unknown enum in <EnumType>', async () => {
    const xml = `<?xml version="1.0"?><AxTable><Name>MyTable</Name><Fields>
      <AxTableField i:type="AxTableFieldEnum"><Name>Status</Name>
        <EnumType>NoSuchEnum</EnumType></AxTableField>
    </Fields></AxTable>`;
    const result = await validateCodeTool(
      { params: { arguments: { mode: 'references', codeType: 'xml-table', code: xml } } } as any,
      context,
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('NoSuchEnum');
  });

  it('accepts a known enum (NoYes) in <EnumType>', async () => {
    const xml = `<?xml version="1.0"?><AxTable><Name>MyTable</Name><Fields>
      <AxTableField i:type="AxTableFieldEnum"><Name>Active</Name>
        <EnumType>NoYes</EnumType></AxTableField>
    </Fields></AxTable>`;
    const result = await validateCodeTool(
      { params: { arguments: { mode: 'references', codeType: 'xml-table', code: xml } } } as any,
      context,
    );
    expect(result.isError).toBeFalsy();
  });
});
