/**
 * resolve_references tests — semantic reference resolution against a real
 * in-memory symbol index (production schema incl. the FTS table the nocase
 * lookups fall back to — a hand-rolled schema subset would silently miss
 * invalid columns or a broken FTS query shape).
 */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { XppSymbolIndex } from '../../src/metadata/symbolIndex';
import {
  resolveXppReferences,
  gateOnReferenceErrors,
  resolveReferencesTool,
  type ResolverDeps,
} from '../../src/tools/write/resolveReferences';
import { validateCodeTool } from '../../src/tools/analysis/validateCode';
import { labelIdSpellings, parseLabelReference } from '../../src/utils/labelReference';

const ORIGINAL_ENFORCE = process.env.GROUNDING_ENFORCE;

let index: XppSymbolIndex;
let db: ResolverDeps['db'];
let deps: ResolverDeps;

const LABELS: Record<string, string[]> = {
  // labelFileId → known label ids, stored the way labelParser writes them: the
  // `Key=` token verbatim. The 27 legacy AX-era files keep their sigil
  // (`@SYS12345=…`), modern ones do not. This mock used to hold a bare
  // 'SYS12345' — the opposite of the real index — and that is the only reason
  // the legacy-label test passed while every `@SYSnnnnn` in real X++ drew an
  // unknown-label warning (#888).
  SYS: ['@SYS12345'],
  Contoso: ['MyLabel'],
};

function makeDeps(database: ResolverDeps['db']): ResolverDeps {
  return {
    db: database,
    // Mirrors symbolIndex.getLabelById: the caller's spelling is normalised, the
    // STORED id comes back.
    getLabelById: (labelId: string, labelFileId?: string) => {
      const parsed = parseLabelReference(labelId);
      const spellings = labelIdSpellings(parsed.labelId);
      const file = labelFileId ?? parsed.labelFileId;
      const hit = (fileId: string) =>
        (LABELS[fileId] ?? [])
          .filter(stored => spellings.includes(stored))
          .map(stored => ({ labelId: stored, labelFileId: fileId }));
      if (file) return hit(file);
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
  // A table the index knows with ZERO indexed columns — the "created this
  // session, fields not indexed yet" shape the data-entity field check must
  // stay silent about rather than report every column as missing.
  sym('FieldlessTable', 'table');
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

  // `CustTable custTable;` is the universal convention and differs from the type
  // only in the first letter's case, so a declaredNames guard on the `::` path
  // skipped the check for almost every real method body.
  it('still checks Type::member when a local is named after the type', () => {
    const code = `public class ConDemoProbe
{
    public void run()
    {
        CustTable custTable;
        custTable = CustTable::find("c1", true, 42);
    }
}`;
    const errors = errorsOf(code);
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

  // `(...)` is renderMethodSignature's marker for a declaration the indexer
  // could not read. Reading it as zero parameters made every real call a
  // mismatch (NumberSeq::newGetVoucherFromId, indexed as `()`).
  it('makes no arity claim against an unknown parameter list', () => {
    const scratch = new XppSymbolIndex(':memory:', ':memory:');
    try {
      scratch.addSymbol({
        name: 'Opaque', type: 'class', filePath: '/x.xml', model: 'Test',
      } as any);
      scratch.addSymbol({
        name: 'mystery', type: 'method', parentName: 'Opaque',
        signature: 'void mystery(...)', filePath: '/x.xml', model: 'Test',
      } as any);
      const d = makeDeps(scratch.getReadDb());
      for (const call of ['Opaque::mystery();', 'Opaque::mystery(1);', 'Opaque::mystery(1, 2, 3);']) {
        expect(resolveXppReferences(call, d).violations.filter(v => v.kind === 'arity-mismatch'))
          .toEqual([]);
      }
    } finally {
      scratch.close();
    }
  });

  // The signature already in the index dropped defaults, so it under-reports the
  // optional count. The stored declaration is authoritative and needs no reindex.
  it('derives arity from the stored declaration, not the rendered signature', () => {
    const scratch = new XppSymbolIndex(':memory:', ':memory:');
    try {
      scratch.addSymbol({
        name: 'Legacy', type: 'class', filePath: '/x.xml', model: 'Test',
      } as any);
      scratch.addSymbol({
        name: 'find', type: 'method', parentName: 'Legacy',
        signature: 'Legacy find(LegacyId _id, boolean _forUpdate)',
        source: 'static Legacy find(LegacyId _id, boolean _forUpdate = false)\n{\n    return null;\n}',
        filePath: '/x.xml', model: 'Test',
      } as any);
      const d = makeDeps(scratch.getReadDb());
      expect(resolveXppReferences('Legacy::find(id);', d)
        .violations.filter(v => v.kind === 'arity-mismatch')).toEqual([]);

      const tooMany = resolveXppReferences('Legacy::find(id, true, 1);', d)
        .violations.filter(v => v.kind === 'arity-mismatch');
      expect(tooMany).toHaveLength(1);
      expect(tooMany[0].detail).toContain('_forUpdate = false');
    } finally {
      scratch.close();
    }
  });

  // A stored declaration this parser refuses to read is the case that rendered
  // as `()`, so the signature must not be trusted as a fallback.
  it('stays silent when the stored declaration is unreadable', () => {
    const scratch = new XppSymbolIndex(':memory:', ':memory:');
    try {
      scratch.addSymbol({
        name: 'Murky', type: 'class', filePath: '/x.xml', model: 'Test',
      } as any);
      scratch.addSymbol({
        name: 'go', type: 'method', parentName: 'Murky',
        signature: 'void go()',
        source: '    return 1 + 2;',
        filePath: '/x.xml', model: 'Test',
      } as any);
      const d = makeDeps(scratch.getReadDb());
      expect(resolveXppReferences('Murky::go(1, 2);', d)
        .violations.filter(v => v.kind === 'arity-mismatch')).toEqual([]);
    } finally {
      scratch.close();
    }
  });
});

// ─── Model visibility ────────────────────────────────────────────────────────

describe('resolveXppReferences — Descriptor visibility', () => {
  const ROOT = 'K:\\AosService\\PackagesLocalDirectory';
  const visibility = {
    model: 'Contoso',
    packagesRoot: ROOT,
    visiblePackages: new Set(['contoso', 'applicationsuite']),
    packageOf: (filePath: string) => {
      const lower = filePath.toLowerCase();
      const prefix = ROOT.toLowerCase() + '\\';
      if (!lower.startsWith(prefix)) return null;
      return filePath.slice(prefix.length).split('\\')[0] || null;
    },
  };

  let scoped: XppSymbolIndex;
  let scopedDeps: ResolverDeps;

  beforeAll(() => {
    scoped = new XppSymbolIndex(':memory:', ':memory:');
    const add = (name: string, type: string, pkg: string) => scoped.addSymbol({
      name, type, filePath: `${ROOT}\\${pkg}\\AxTable\\${name}.xml`, model: pkg,
    } as any);
    add('TaxAmountCur', 'edt', 'Tax');            // indexed, package not referenced
    add('CustTable', 'table', 'ApplicationSuite'); // referenced
    // Same name in two packages, one of them reachable ⇒ must stay silent.
    add('SharedName', 'class', 'Tax');
    scoped.addSymbol({
      name: 'SharedName', type: 'class',
      filePath: `${ROOT}\\ApplicationSuite\\AxClass\\SharedName.xml`, model: 'ApplicationSuite',
    } as any);
    // Outside the packages root ⇒ cannot tell which package owns it.
    scoped.addSymbol({
      name: 'WorkspaceType', type: 'class', filePath: 'K:\\src\\WorkspaceType.xml', model: 'Other',
    } as any);
    scopedDeps = { ...makeDeps(scoped.getReadDb()), visibility };
  });

  afterAll(() => scoped.close());

  const kindsOf = (code: string, d = scopedDeps) =>
    resolveXppReferences(code, d).violations.map(v => v.kind);

  it('reports a type whose only package the model does not reference', () => {
    const violations = resolveXppReferences('TaxAmountCur amount;', scopedDeps).violations;
    expect(violations.map(v => v.kind)).toEqual(['not-visible-from-model']);
    expect(violations[0].severity).toBe('error');
    expect(violations[0].detail).toContain('Tax');
    expect(violations[0].detail).toContain('Contoso');
  });

  it('accepts a type from a referenced package', () => {
    expect(kindsOf('CustTable custTable;')).toEqual([]);
  });

  it('stays silent when any occurrence of the name is reachable', () => {
    expect(kindsOf('SharedName x;')).toEqual([]);
  });

  it('stays silent when the indexed path is outside the packages root', () => {
    expect(kindsOf('WorkspaceType x;')).toEqual([]);
  });

  it('runs no check at all without an oracle', () => {
    const noOracle = makeDeps(scoped.getReadDb());
    expect(kindsOf('TaxAmountCur amount;', noOracle)).toEqual([]);
  });

  it('reports an invisible type once, not per occurrence', () => {
    const code = 'TaxAmountCur a;\nTaxAmountCur b;\nTaxAmountCur c;';
    expect(kindsOf(code)).toEqual(['not-visible-from-model']);
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
    // tableMethodStr, not methodStr: xppc rejects a table in methodStr (#1270 probes).
    expect(errorsOf('tableMethodStr(custtable, VALIDATEWRITE);')).toEqual([]);
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
    // The retry instruction must name the SURVIVING tool. It used to say
    // `resolve_references`, retired into validate_code(mode="references") — a
    // guaranteed Unknown-tool call on the one path where the model is already
    // blocked and looking for a way forward.
    expect(result?.content[0].text).toContain('validate_code(mode="references")');
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
    // Reported, but no longer fatal. This check is index-only, and on a real
    // installation 44 enum names that shipped Microsoft metadata references cannot be
    // resolved by it. A check that cannot tell "absent from the index" from "does
    // not exist" must not fail the call: the agent obeys, swaps in a real-but-
    // different enum out of search results, and the edit compiles clean meaning
    // something else.
    expect(result.content[0].text).toContain('NoSuchEnum');
    expect(result.content[0].text).toContain('warning');
    expect(result.isError).toBeFalsy();
  });

  // The shared fixture seeds sym('NoYes', 'enum'), so this passed for the wrong
  // reason for the whole life of the check: the mock index was more generous than
  // any real one, where NoYes has no AxEnum element and returns 0 rows. The X++
  // side had already spotted the same trap and tested against emptyDeps (see
  // "accepts NoYes:: even when the index does not prove NoYes"); the XML side had
  // not, which is how <EnumType>NoYes</EnumType> shipped as a hard error.
  it('accepts NoYes even when the index does NOT contain it', async () => {
    const xml = `<?xml version="1.0"?><AxTable><Name>MyTable</Name><Fields>
      <AxTableField i:type="AxTableFieldEnum"><Name>Active</Name>
        <EnumType>NoYes</EnumType></AxTableField>
    </Fields></AxTable>`;
    // An index that proves nothing — exactly what a real one offers for NoYes.
    const blindContext = {
      symbolIndex: {
        getReadDb: () => ({ prepare: () => ({ all: () => [], get: () => undefined }) }),
        getLabelById: () => [],
      },
    } as any;
    const result = await validateCodeTool(
      { params: { arguments: { mode: 'references', codeType: 'xml-table', code: xml } } } as any,
      blindContext,
    );
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).not.toContain('NoYes" is not in the symbol index');
  });
});

/**
 * A label's %n placeholders against the arguments the call site supplies.
 * Both directions compile and are wrong at runtime: a label with %1 used bare
 * shows the user a literal "%1", and arguments handed to a label without
 * placeholders are discarded.
 */
describe('label placeholders vs strFmt arguments', () => {
  const TEXTS: Record<string, string> = {
    Downgrade: 'The quality tier cannot be decreased from %1 to %2.',
    Plain: 'The quality tier cannot be decreased.',
  };

  const textDeps: ResolverDeps = {
    db: { prepare: () => ({ get: () => undefined, all: () => [] }) },
    getLabelById: (labelId: string) =>
      TEXTS[labelId]
        ? [{ labelId, labelFileId: 'ConSK', language: 'en-US', text: TEXTS[labelId] }]
        : [],
    getLabelFileIds: () => [{ labelFileId: 'ConSK' }],
  };

  const check = (code: string) =>
    resolveXppReferences(code, textDeps).violations.filter(
      v => v.kind === 'label-placeholder-mismatch',
    );

  it('flags a placeholder label used without strFmt', () => {
    const found = check('ret = checkFailed(literalStr("@ConSK:Downgrade"));');
    expect(found).toHaveLength(1);
    expect(found[0].severity).toBe('error');
    expect(found[0].detail).toContain('must be wrapped');
  });

  it('flags arguments passed to a label that has no placeholders', () => {
    const found = check('ret = checkFailed(strFmt("@ConSK:Plain", enum2str(a), enum2str(b)));');
    expect(found).toHaveLength(1);
    expect(found[0].detail).toContain('discarded');
  });

  it('flags an argument-count mismatch', () => {
    const found = check('ret = checkFailed(strFmt("@ConSK:Downgrade", enum2str(a)));');
    expect(found[0].detail).toContain('takes 2 argument(s), strFmt supplies 1');
  });

  it('accepts the matching call, wrapped and across lines', () => {
    expect(check(`ret = checkFailed(strFmt("@ConSK:Downgrade",
        enum2str(this.orig().Tier),
        enum2str(this.Tier)));`)).toHaveLength(0);
  });

  it('accepts a plain label used bare, and sees through literalStr', () => {
    expect(check('ret = checkFailed("@ConSK:Plain");')).toHaveLength(0);
    expect(check('ret = checkFailed(strFmt(literalStr("@ConSK:Downgrade"), a, b));')).toHaveLength(0);
  });

  it('says nothing when the index has no text for the label', () => {
    const noText: ResolverDeps = {
      ...textDeps,
      getLabelById: (labelId: string) => [{ labelId, labelFileId: 'ConSK' }],
    };
    expect(
      resolveXppReferences('ret = checkFailed("@ConSK:Downgrade");', noText)
        .violations.filter(v => v.kind === 'label-placeholder-mismatch'),
    ).toHaveLength(0);
  });
});

/**
 * A data entity keeps its references under element names NONE of the generic
 * scans use: the source table is <Table>, a mapped column is <DataField> paired
 * with a <DataSource>, and a query column is <Field>. So references mode on an
 * AxDataEntityView reported "all 0 reference(s) verified" — it had checked
 * nothing, and a hallucinated field name passed the static gate in silence.
 * Eval case L2-entity-query-range-roundtrip, 2026-08-23.
 */
describe('validateCodeTool references mode — AxDataEntityView', () => {
  const context = {
    symbolIndex: {
      getReadDb: () => db,
      getLabelById: (id: string, f?: string) => makeDeps(db).getLabelById(id, f),
      getLabelFileIds: () => Object.keys(LABELS).map(labelFileId => ({ labelFileId })),
    },
  } as any;

  const entity = (opts: {
    table?: string; queryField?: string; mappedField?: string; dataSource?: string;
  } = {}) => {
    const table = opts.table ?? 'CustTable';
    const ds = opts.dataSource ?? table;
    return `<?xml version="1.0"?><AxDataEntityView><Name>MyEntity</Name>
      <Fields>
        <AxDataEntityViewField i:type="AxDataEntityViewMappedField">
          <Name>Acct</Name>
          <DataField>${opts.mappedField ?? 'AccountNum'}</DataField>
          <DataSource>${ds}</DataSource>
        </AxDataEntityViewField>
      </Fields>
      <ViewMetadata><Name>Metadata</Name><DataSources>
        <AxQuerySimpleRootDataSource>
          <Name>${ds}</Name>
          <Table>${table}</Table>
          <DataSources />
          <Fields>
            <AxQuerySimpleDataSourceField>
              <Name>F</Name><Field>${opts.queryField ?? 'AccountNum'}</Field>
            </AxQuerySimpleDataSourceField>
          </Fields>
        </AxQuerySimpleRootDataSource>
      </DataSources></ViewMetadata>
    </AxDataEntityView>`;
  };

  const run = (xml: string) => validateCodeTool(
    { params: { arguments: { mode: 'references', codeType: 'xml-table', code: xml } } } as any,
    context,
  );

  it('actually verifies something — it used to report 0 references checked', async () => {
    const r: any = await run(entity());
    const text = r.content[0].text as string;
    expect(text, 'the entity pass must verify at least the source table').not.toContain('all 0 reference(s) verified');
  });

  it('flags a source table that does not exist', async () => {
    const r: any = await run(entity({ table: 'NoSuchTable' }));
    expect(r.content[0].text).toContain('NoSuchTable');
  });

  it('flags a query <Field> that is not a column of the data source table', async () => {
    const r: any = await run(entity({ queryField: 'NotAColumn' }));
    expect(r.content[0].text).toContain('NotAColumn');
  });

  it('flags a mapped <DataField> that is not a column of its <DataSource>', async () => {
    const r: any = await run(entity({ mappedField: 'AlsoNotAColumn' }));
    expect(r.content[0].text).toContain('AlsoNotAColumn');
  });

  it('accepts real columns without complaint', async () => {
    const r: any = await run(entity({ queryField: 'CustGroup', mappedField: 'Blocked' }));
    const text = r.content[0].text as string;
    expect(text).not.toContain('CustGroup"');
    expect(text).not.toContain('Blocked"');
  });

  it('stays silent about the fields of a table the index knows no columns for', async () => {
    // A table created earlier in the SAME session may be indexed while its
    // columns are not. Reporting every field as missing there would be a
    // confident lie about output that is fine — the failure class this repo
    // cares about most.
    const r: any = await run(entity({
      table: 'FieldlessTable', dataSource: 'FieldlessTable',
      queryField: 'Whatever', mappedField: 'Whatever2',
    }));
    const text = r.content[0].text as string;
    expect(text).not.toContain('Whatever');
    expect(text).not.toContain('Whatever2');
  });

  it('but DOES judge the fields of a table whose columns are indexed', () => {
    // The other half of the same rule — silence must be about missing evidence,
    // not a blanket exemption.
    return run(entity({ table: 'SalesTable', dataSource: 'SalesTable', queryField: 'NotOnSales' }))
      .then((r: any) => expect(r.content[0].text).toContain('NotOnSales'));
  });

  it('resolves a JOINED data source to its own table, not the nearest one', async () => {
    // Embedded data sources nest. A flat tag scan pairs <Field> with whichever
    // <Table> is nearest in document order, which is how a check reports the
    // wrong table with full confidence.
    const xml = `<?xml version="1.0"?><AxDataEntityView><Name>MyEntity</Name>
      <Fields />
      <ViewMetadata><Name>Metadata</Name><DataSources>
        <AxQuerySimpleRootDataSource>
          <Name>CustTable</Name><Table>CustTable</Table>
          <Fields>
            <AxQuerySimpleDataSourceField><Name>A</Name><Field>AccountNum</Field></AxQuerySimpleDataSourceField>
          </Fields>
          <DataSources>
            <AxQuerySimpleEmbeddedDataSource>
              <Name>SalesTable</Name><Table>SalesTable</Table>
              <Fields>
                <AxQuerySimpleDataSourceField><Name>B</Name><Field>SalesId</Field></AxQuerySimpleDataSourceField>
              </Fields>
            </AxQuerySimpleEmbeddedDataSource>
          </DataSources>
        </AxQuerySimpleRootDataSource>
      </DataSources></ViewMetadata>
    </AxDataEntityView>`;
    const r: any = await run(xml);
    const text = r.content[0].text as string;
    // SalesId is a column of SalesTable, not of CustTable — pairing it with the
    // root table would flag it.
    expect(text).not.toContain('SalesId');
  });
});

/**
 * A class calling its own static is spelled `MyClass::helper()` — X++ accepts
 * nothing else, because a bare name resolves only against predefined functions,
 * Global statics and local functions. So the reference is to a type the index
 * cannot contain yet: the class is being written. Reporting it as unknown-type
 * blocked writes of correct code under GROUNDING_ENFORCE, and every non-trivial
 * new class hits it. Found by an eval implementer, not by a test.
 *
 * The exemption is derived from the source itself, so it works for
 * validate_code(mode="references") too, with no extra parameter to thread.
 */
describe('resolveXppReferences — a class may call its own statics', () => {
  const NEW_CLASS = `
public class ConDemoNotIndexedYet
{
    public static boolean isElevated()
    {
        return isSystemAdministrator();
    }

    public static void assertElevated()
    {
        if (!ConDemoNotIndexedYet::isElevated())
        {
            throw error("@SYS1");
        }
    }
}`;

  it('does not report the class being written as an unknown type', () => {
    const errors = errorsOf(NEW_CLASS);
    expect(
      errors.filter(e => e.identifier?.startsWith('ConDemoNotIndexedYet')),
      JSON.stringify(errors, null, 2),
    ).toEqual([]);
  });

  it('exempts an interface it declares as well', () => {
    const code = `
public interface ConDemoStrategy
{
    public static str kind()
    {
        return ConDemoStrategy::kind();
    }
}`;
    expect(errorsOf(code).filter(e => e.identifier?.startsWith('ConDemoStrategy'))).toEqual([]);
  });

  it('still reports a DIFFERENT unknown type in the same source', () => {
    // The guard must be the declared name, not "anything that looks new" — a
    // typo has to keep failing, or the exemption would swallow the rule.
    const code = `${NEW_CLASS}
public class ConDemoOther
{
    public static void go()
    {
        ConDemoTypoedNameThatDoesNotExist::run();
    }
}`;
    const identifiers = errorsOf(code).map(e => e.identifier);
    expect(identifiers).toContain('ConDemoTypoedNameThatDoesNotExist::run');
  });

  it('is actually wired up — the declaration regex matches real X++', () => {
    // The first version of this exemption shipped with a literal backspace
    // instead of \b (a shell heredoc ate the escape), so the pattern matched
    // nothing and the guard silently did not exist. A test that only asserts
    // "no error" passes in that state too, which is why this one asserts the
    // extraction directly.
    const errorsWithout = errorsOf(`
public class ConDemoStandalone
{
    public static void go()
    {
        ConDemoStandalone::go();
    }
}`);
    const errorsForUndeclared = errorsOf(`
public class ConDemoStandalone
{
    public static void go()
    {
        ConDemoUndeclaredElsewhere::go();
    }
}`);
    expect(errorsWithout.map(e => e.identifier)).not.toContain('ConDemoStandalone::go');
    expect(errorsForUndeclared.map(e => e.identifier)).toContain('ConDemoUndeclaredElsewhere::go');
  });
});

/**
 * The intrinsic-target rule and the declared-type rule disagreed about the same
 * fact: a kernel class has no metadata, so the declared-type path warns and says
 * "if it is a kernel class this is a false positive" — while `methodStr(<same
 * class>, m)` was a hard error. An eval run hit it on the ONE spelling X++
 * accepts for a control override, where the class must be FormStringControl.
 */
describe('resolveXppReferences — intrinsics targeting kernel types', () => {
  it('does not error on methodStr() against a kernel control class', () => {
    const code = `
public class ConDemoLookupBinder
{
    public void bind(FormStringControl _control)
    {
        _control.registerOverrideMethod(
            methodStr(FormStringControl, lookup),
            methodStr(ConDemoLookupBinder, onLookup),
            this);
    }
}`;
    const errors = errorsOf(code);
    expect(
      errors.filter(e => e.kind === 'unknown-intrinsic-target'),
      JSON.stringify(errors, null, 2),
    ).toEqual([]);
  });

  it('still errors on an intrinsic target that is neither kernel nor declared here', () => {
    const code = `
public class ConDemoLookupBinder
{
    public void bind()
    {
        info(methodStr(ConDemoNoSuchClassAnywhere, onLookup));
    }
}`;
    expect(errorsOf(code).map(e => e.identifier))
      .toContain('methodStr(ConDemoNoSuchClassAnywhere, onLookup)');
  });
});

// ── label file existence: narrow lookups instead of the grouped list ─────────

describe('resolveXppReferences — label file existence lookup', () => {
  const FILES = ['ContosoExt', 'ContosoCore'];

  /** Deps that count how each "does this label file exist?" route is used. */
  function countingDeps(opts: { narrow: boolean }) {
    const wide = vi.fn(() => FILES.map(labelFileId => ({ labelFileId })));
    const has = vi.fn((id: string) => FILES.includes(id));
    const distinct = vi.fn(() => [...FILES]);
    const d: ResolverDeps = {
      db: { prepare: () => ({ get: () => undefined, all: () => [] }) },
      getLabelById: () => [],
      getLabelFileIds: wide,
      ...(opts.narrow ? { hasLabelFileId: has, getDistinctLabelFileIds: distinct } : {}),
    };
    return { d, wide, has, distinct };
  }

  const labelViolations = (code: string, d: ResolverDeps) =>
    resolveXppReferences(code, d).violations
      .filter(v => v.kind === 'unknown-label')
      .map(v => [v.identifier, v.severity]);

  it('does not call the wide grouping method for an unknown label file', () => {
    const { d, wide, distinct } = countingDeps({ narrow: true });
    expect(labelViolations('info("@ContosoNoSuchFile:Anything");', d))
      .toEqual([['@ContosoNoSuchFile:Anything', 'warning']]);
    expect(wide).not.toHaveBeenCalled();
    expect(distinct).toHaveBeenCalledTimes(1);
  });

  it('answers a known file in the exact case with the seek alone', () => {
    const { d, wide, has, distinct } = countingDeps({ narrow: true });
    expect(labelViolations('info("@ContosoExt:NoSuchId");', d))
      .toEqual([['@ContosoExt:NoSuchId', 'error']]);
    expect(has).toHaveBeenCalledWith('ContosoExt');
    expect(distinct).not.toHaveBeenCalled();
    expect(wide).not.toHaveBeenCalled();
  });

  it('builds the id set at most once for many unknown literals', () => {
    const { d, wide, has, distinct } = countingDeps({ narrow: true });
    const code = [
      'info("@ContosoNoSuchFile:A");',
      'info("@ContosoNoSuchFile:B");',
      'info("@ContosoNoSuchFile:C");',
      'info("@ContosoOtherMissing:D");',
      'info("@contosoext:E");',
    ].join('\n');
    const found = labelViolations(code, d);
    expect(found).toHaveLength(5);
    expect(distinct).toHaveBeenCalledTimes(1);
    expect(wide).not.toHaveBeenCalled();
    // One seek per distinct file id, not one per literal.
    expect(has).toHaveBeenCalledTimes(3);
  });

  it('gives the same verdicts with and without the narrow methods, in any letter case', () => {
    const code = [
      'info("@ContosoExt:Missing");',     // known, exact case
      'info("@CONTOSOEXT:Missing");',     // known, upper case
      'info("@contosocore:Missing");',    // known, lower case
      'info("@ContosoNoSuchFile:Missing");',
    ].join('\n');
    const narrow = labelViolations(code, countingDeps({ narrow: true }).d);
    const legacy = labelViolations(code, countingDeps({ narrow: false }).d);
    expect(narrow).toEqual(legacy);
    expect(narrow.map(v => v[1])).toEqual(['error', 'error', 'error', 'warning']);
  });

  it('falls back to getLabelFileIds when the deps object has no narrow methods', () => {
    const { d, wide } = countingDeps({ narrow: false });
    expect(labelViolations('info("@ContosoNoSuchFile:A");\ninfo("@ContosoNoSuchFile:B");', d))
      .toHaveLength(2);
    expect(wide).toHaveBeenCalledTimes(1);
  });

  it('treats a failing lookup as an unknown file, as before', () => {
    const { d } = countingDeps({ narrow: true });
    d.hasLabelFileId = () => { throw new Error('labels db closed'); };
    expect(labelViolations('info("@ContosoExt:Missing");', d))
      .toEqual([['@ContosoExt:Missing', 'warning']]);
  });

  describe('against a real labels index', () => {
    let labelIndex: XppSymbolIndex;

    beforeAll(() => {
      labelIndex = new XppSymbolIndex(':memory:', ':memory:');
      for (const [labelFileId, language] of [
        ['ContosoExt', 'en-US'], ['ContosoExt', 'cs'], ['ContosoCore', 'en-US'],
      ]) {
        labelIndex.addLabel({
          labelId: 'EquipmentName', labelFileId, model: labelFileId, language,
          text: 'Equipment name', filePath: `/${labelFileId}.${language}.label.txt`,
        });
      }
    });
    afterAll(() => labelIndex.close());

    it('hasLabelFileId is exact-case and getDistinctLabelFileIds lists each id once', () => {
      expect(labelIndex.hasLabelFileId('ContosoExt')).toBe(true);
      expect(labelIndex.hasLabelFileId('contosoext')).toBe(false);
      expect(labelIndex.hasLabelFileId('ContosoNoSuchFile')).toBe(false);
      expect(labelIndex.getDistinctLabelFileIds().sort()).toEqual(['ContosoCore', 'ContosoExt']);
    });

    it('the tool path never runs the grouped query for a missing id or file', async () => {
      const wide = vi.spyOn(labelIndex, 'getLabelFileIds');
      const res = await resolveReferencesTool(
        { params: { arguments: { code: 'info("@contosoext:NoSuchId");\ninfo("@ContosoNoSuchFile:X");' } } },
        { symbolIndex: labelIndex } as any,
      );
      const text = res.content[0].text;
      expect(text).toContain('Label id "NoSuchId" not found in label file "contosoext"');
      expect(text).toContain('Label file "ContosoNoSuchFile" not found in the index');
      expect(wide).not.toHaveBeenCalled();
      wide.mockRestore();
    });
  });
});
