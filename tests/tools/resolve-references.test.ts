/**
 * resolve_references tests — semantic reference resolution against a real
 * in-memory symbol index (production schema incl. the FTS table the nocase
 * lookups fall back to — a hand-rolled schema subset would silently miss
 * invalid columns or a broken FTS query shape).
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { XppSymbolIndex } from '../../src/metadata/symbolIndex';
import {
  resolveXppReferences,
  gateOnReferenceErrors,
  resolveReferencesTool,
  type ResolverDeps,
} from '../../src/tools/resolveReferences';
import { validateCodeTool } from '../../src/tools/validateCode';

const ORIGINAL_ENFORCE = process.env.GROUNDING_ENFORCE;

let index: XppSymbolIndex;
let db: ResolverDeps['db'];
let deps: ResolverDeps;

const LABELS: Record<string, string[]> = {
  // labelFileId → known label ids
  SYS: ['SYS12345'],
  Contoso: ['MyLabel'],
};

function makeDeps(database: ResolverDeps['db']): ResolverDeps {
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
  index = new XppSymbolIndex(':memory:', ':memory:');
  const sym = (
    name: string,
    type: string,
    parentName?: string,
    signature?: string,
    extendsClass?: string,
  ) => index.addSymbol({
    name, type, parentName, signature, extendsClass,
    filePath: '/x.xml', model: 'Test',
  } as any);

  // Tables + fields + methods
  sym('CustTable', 'table');
  sym('AccountNum', 'field', 'CustTable', 'CustAccount');
  sym('CustGroup', 'field', 'CustTable', 'CustGroupId');
  sym('Blocked', 'field', 'CustTable', 'CustVendorBlocked');
  sym('validateWrite', 'method', 'CustTable', 'public boolean validateWrite()');
  sym('find', 'method', 'CustTable',
    'public static CustTable find(CustAccount _custAccount, boolean _forUpdate = false)');
  sym('SalesTable', 'table');
  sym('SalesId', 'field', 'SalesTable', 'SalesIdBase');
  // Classes with inheritance
  sym('SalesFormLetter', 'class', undefined, undefined, 'RunBaseBatch');
  sym('run', 'method', 'SalesFormLetter', 'public void run()');
  sym('ContosoBase', 'class');
  sym('doStuff', 'method', 'ContosoBase', 'public int doStuff(int _a, str _b = "")');
  // Trailing default whose value is a function call (parens inside the default).
  sym('activateFrom', 'method', 'ContosoBase',
    'public static void activateFrom(int _type, str _user = curUserId())');
  sym('ContosoChild', 'class', undefined, undefined, 'ContosoBase');
  // Enum / EDT / form / query
  sym('NoYes', 'enum');
  sym('CustAccount', 'edt', undefined, 'AccountNum');
  sym('CustTableListPage', 'form');
  sym('CustTableSRS', 'query');

  // :memory: read pool is empty, so getReadDb() returns the writer — usable
  // for inserting the auxiliary rows the resolver checks.
  const writer = index.getReadDb();
  db = writer;
  writer.prepare(
    `INSERT INTO extension_metadata
       (extension_name, extension_type, base_object_name, added_fields, added_methods, coc_methods, model)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run('CustTable.ContosoExtension', 'table-extension', 'CustTable', '["ContosoTier"]', null, null, 'Test');
  writer.prepare(
    `INSERT INTO extension_metadata
       (extension_name, extension_type, base_object_name, added_fields, added_methods, coc_methods, model)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run('SalesFormLetterContoso_Extension', 'class-extension', 'SalesFormLetter',
    null, null, '[{"name":"postJournal"}]', 'Test');

  writer.prepare('INSERT INTO menu_item_targets (menu_item_name, menu_item_type, model) VALUES (?, ?, ?)')
    .run('CustTableListPage', 'display', 'Test');

  deps = makeDeps(db);
});

afterAll(() => index.close());

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

  // `Exception` is deliberately NOT seeded in `deps`, so this exercises the
  // kernel-enum allow-list rather than an index hit.
  it('accepts Exception:: typed catches with no AxEnum in the index (#12)', () => {
    const code = 'catch (Exception::DuplicateKeyException) {}\ncatch (Exception::Error) {}';
    expect(errorsOf(code)).toEqual([]);
  });

  // The shared `deps` seeds NoYes, which would mask the fix — prove the allow-list
  // against an empty index instead.
  it('accepts NoYes:: even when the index does not prove NoYes (#17)', () => {
    const empty = new XppSymbolIndex(':memory:', ':memory:');
    try {
      const emptyDeps = makeDeps(empty.getReadDb());
      const errs = resolveXppReferences('if (NoYes::Yes == NoYes::No) {}', emptyDeps)
        .violations.filter(v => v.severity === 'error');
      expect(errs).toEqual([]);
    } finally {
      empty.close();
    }
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

  // A default whose VALUE contains parens (`= curUserId()`) must still count as
  // optional — splitTopLevel keeps them balanced.
  it('treats a trailing function-call default as optional (#18)', () => {
    expect(errorsOf('ContosoBase::activateFrom(1);')).toEqual([]);       // omits the defaulted arg
    expect(errorsOf('ContosoBase::activateFrom(1, "u");')).toEqual([]);  // supplies it
  });

  it('still flags too few args even with a function-call default present (#18 guard)', () => {
    const errors = errorsOf('ContosoBase::activateFrom();'); // 0 args, min is 1
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

// ─── Case-insensitive resolution (regression: NOCASE full scans) ─────────────
// X++ identifiers are case-insensitive; the resolver must accept any casing.
// The former `= ? COLLATE NOCASE` probes did that via full table scans; the
// index-safe replacements (exact probe + FTS fallback, canonicalized parent)
// must keep the same semantics.

describe('resolveXppReferences — case-insensitive identifiers', () => {
  it('verifies differently-cased intrinsic targets and members', () => {
    expect(errorsOf('tableStr(custtable);')).toEqual([]);
    expect(errorsOf('fieldStr(CUSTTABLE, accountnum);')).toEqual([]);
    expect(errorsOf('methodStr(custtable, VALIDATEWRITE);')).toEqual([]);
  });

  it('verifies a static call through the inheritance chain, any casing', () => {
    expect(errorsOf('contosochild::doStuff(1);')).toEqual([]);
  });

  it('verifies extension fields on a differently-cased base table', () => {
    expect(errorsOf('fieldStr(custtable, ContosoTier);')).toEqual([]);
  });

  it('still flags unknown members under any casing', () => {
    expect(errorsOf('fieldStr(custtable, NoSuchField);')).toHaveLength(1);
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
