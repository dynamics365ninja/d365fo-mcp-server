/**
 * The compiler-facts ratchet.
 *
 * `eval/compiler-facts.snapshot.json` is what xppc itself answered on the VM
 * (scripts/capture-compiler-facts.ts). `src/knowledge/compilerFacts.generated.ts`
 * is the module the server runs on. These tests fail when the two drift apart, and
 * when a rule or a knowledge entry states something the compiler contradicts.
 *
 * The point is not to re-test the compiler. It is that nothing in this repo may
 * assert a language fact from memory: the arity table used to say date2Str took 8
 * arguments while the platform calls it with 7 (161 times), and the knowledge base
 * denied a `using` statement the platform uses 8,306 times.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

import {
  COMPILER_VERSION,
  XPP_EXEMPTED_KEYWORDS,
  XPP_INTRINSICS,
  XPP_KEYWORDS,
  XPP_OBSOLETE_FUNCTIONS,
  XPP_RUNTIME_FUNCTIONS,
  XPP_UNKNOWN_FUNCTIONS,
  acceptsArgumentCount,
  intrinsicInfo,
  isReservedKeyword,
  isUnknownFunction,
  runtimeFunctionInfo,
} from '../../src/knowledge/compilerFacts.js';
import { runRules } from '../../src/tools/analysis/validateXpp.js';
import { KNOWLEDGE_BASE } from '../../src/tools/knowledge/xppKnowledge.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const snapshot = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, 'eval', 'compiler-facts.snapshot.json'), 'utf-8'),
) as {
  compilerVersion: string;
  keywords: string[];
  exemptedKeywords: string[];
  intrinsics: Record<string, number>;
  runtimeFunctions: Record<string, { min: number; max: number | 'variadic' }>;
  unknownFunctions: string[];
  obsoleteFunctions: string[];
};

describe('compiler facts — generated module matches the capture', () => {
  it('carries the same compiler version', () => {
    expect(COMPILER_VERSION).toBe(snapshot.compilerVersion);
  });

  it('carries the same keyword tables', () => {
    expect([...XPP_KEYWORDS]).toEqual(snapshot.keywords);
    expect([...XPP_EXEMPTED_KEYWORDS]).toEqual(snapshot.exemptedKeywords);
  });

  it('carries the same intrinsic table', () => {
    expect(XPP_INTRINSICS).toEqual(snapshot.intrinsics);
  });

  it('carries the same run-time function arities', () => {
    expect(XPP_RUNTIME_FUNCTIONS).toEqual(snapshot.runtimeFunctions);
    expect([...XPP_UNKNOWN_FUNCTIONS]).toEqual(snapshot.unknownFunctions);
    expect([...XPP_OBSOLETE_FUNCTIONS]).toEqual(snapshot.obsoleteFunctions);
  });

  it('is a plausible capture, not an empty one', () => {
    expect(XPP_KEYWORDS.length).toBeGreaterThan(100);
    expect(Object.keys(XPP_INTRINSICS).length).toBeGreaterThan(70);
    expect(Object.keys(XPP_RUNTIME_FUNCTIONS).length).toBeGreaterThan(150);
  });
});

describe('compiler facts — the answers the language reference gets wrong', () => {
  it('knows the keywords that were removed and the ones that were added', () => {
    // Removed: the parser no longer reserves these, so they are ordinary
    // identifiers and any statement using them is a syntax error.
    for (const gone of ['window', 'pause', 'tablelock', 'changesite']) {
      expect(isReservedKeyword(gone), gone).toBe(false);
    }
    // Reserved but not implemented — they parse as keywords and then fail.
    for (const reserved of ['having', 'foreach', 'async', 'await', 'namespace']) {
      expect(isReservedKeyword(reserved), reserved).toBe(true);
    }
    // `in` is reserved AND exempted: legal as an identifier.
    expect(isReservedKeyword('in')).toBe(false);
    // Case-insensitive, like the language.
    expect(isReservedKeyword('ForUpdate')).toBe(true);
  });

  it('records the optional trailing parameters the docs describe as fixed', () => {
    expect(runtimeFunctionInfo('date2Str')!.arity).toEqual({ min: 7, max: 8 });
    expect(runtimeFunctionInfo('datetime2Str')!.arity).toEqual({ min: 1, max: 2 });
    expect(runtimeFunctionInfo('fieldId2Name')!.arity).toEqual({ min: 2, max: 3 });
    expect(runtimeFunctionInfo('error')!.arity).toEqual({ min: 1, max: 3 });
    expect(runtimeFunctionInfo('runAs')!.arity).toEqual({ min: 4, max: 7 });
  });

  it('records the variadic functions no arity rule may police', () => {
    for (const fn of ['strFmt', 'conIns', 'max', 'min']) {
      expect(runtimeFunctionInfo(fn)!.arity.max, fn).toBe('variadic');
    }
  });

  it('records the AX 2012 names that no longer exist', () => {
    for (const gone of ['corrFlagGet', 'dateMin', 'int2Enum', 'refPrintAll', 'typeName2Id']) {
      expect(isUnknownFunction(gone), gone).toBe(true);
    }
    expect(isUnknownFunction('strLen')).toBe(false);
  });

  it('knows ssrsReportStr takes the report AND the design', () => {
    expect(intrinsicInfo('ssrsReportStr')!.args).toBe(2);
    expect(intrinsicInfo('fieldStr')!.args).toBe(2);
    expect(intrinsicInfo('classStr')!.args).toBe(1);
    // formDataFieldStr(form, datasource, field) — three, not two.
    expect(intrinsicInfo('formDataFieldStr')!.args).toBe(3);
  });

  it('accepts a call inside the compiler-declared range', () => {
    const date2Str = runtimeFunctionInfo('date2Str')!.arity;
    expect(acceptsArgumentCount(date2Str, 7)).toBe(true);
    expect(acceptsArgumentCount(date2Str, 8)).toBe(true);
    expect(acceptsArgumentCount(date2Str, 6)).toBe(false);
    expect(acceptsArgumentCount(date2Str, 9)).toBe(false);
  });
});

describe('FN001/FN002 read the compiler table, not a hand-written one', () => {
  const rulesOf = (code: string) => runRules(code, 'xpp');

  it('accepts the 7-argument date2Str the platform ships 161 times', () => {
    const v = rulesOf('str s = date2Str(d, 321, 2, 1, 2, 1, 4);');
    expect(v.filter(x => x.rule === 'FN001')).toHaveLength(0);
  });

  it('accepts the 8-argument form with DateFlags', () => {
    const v = rulesOf('str s = date2Str(d, 321, 2, 1, 2, 1, 4, DateFlags::FormatAll);');
    expect(v.filter(x => x.rule === 'FN001')).toHaveLength(0);
  });

  it('rejects a date2Str missing an argument', () => {
    const v = rulesOf('str s = date2Str(d, 321, 2, 1, 2, 1);');
    expect(v.some(x => x.rule === 'FN001' && x.severity === 'error')).toBe(true);
  });

  it('accepts both arities of datetime2Str', () => {
    expect(rulesOf('str a = datetime2Str(u);').filter(x => x.rule === 'FN001')).toHaveLength(0);
    expect(rulesOf('str a = datetime2Str(u, DateFlags::FormatAll);').filter(x => x.rule === 'FN001')).toHaveLength(0);
  });

  it('still catches the enum2Str/enum2Symbol confusion it was built for', () => {
    const v = rulesOf('info(enum2Str(enumNum(NoYes), NoYes::Yes));');
    expect(v.some(x => x.rule === 'FN001')).toBe(true);
  });

  it('checks intrinsics too — ssrsReportStr needs the design name', () => {
    const v = rulesOf('controller.parmReportName(ssrsReportStr(MyReport));');
    expect(v.some(x => x.rule === 'FN001' && /ssrsReportStr/.test(x.fix))).toBe(true);
  });

  it('never fires on a variadic function', () => {
    const v = rulesOf('str s = strFmt("%1 %2 %3", a, b, c);\ncontainer c2 = conIns(c, 1, 2, 3);');
    expect(v.filter(x => x.rule === 'FN001')).toHaveLength(0);
  });

  it('reports a call to a function that no longer exists (FN002)', () => {
    const v = rulesOf('real r = corrFlagGet(x);');
    expect(v.some(x => x.rule === 'FN002' && x.severity === 'error')).toBe(true);
  });

  it('does not read a method declaration as a call', () => {
    // A form adaptor declares `public IntEditAdaptor Year()`; that is not year().
    const v = rulesOf('public IntEditAdaptor Year()\n{\n    return this.intEdit();\n}');
    expect(v.filter(x => x.rule === 'FN001')).toHaveLength(0);
  });

  it('does not read another class\'s static as the predefined function', () => {
    const v = rulesOf('str s = MyHelper::subStr(a, b);');
    expect(v.filter(x => x.rule === 'FN001')).toHaveLength(0);
  });
});

describe('knowledge base does not contradict the compiler', () => {
  const entry = (id: string) => KNOWLEDGE_BASE.find(e => e.id === id)!;
  const rulesText = (id: string) => entry(id).rules.join('\n');

  it('dotnet-interop no longer denies the using statement', () => {
    const text = rulesText('dotnet-interop');
    expect(text).not.toMatch(/no `using` STATEMENT/i);
    expect(text).toMatch(/using \(var reader|HAS the `using` statement/i);
  });

  it('dotnet-interop no longer prescribes the deprecated server modifier', () => {
    expect(rulesText('dotnet-interop')).not.toMatch(/put them in a `server` static method/i);
  });

  it('select-statement states the real `in` operator constraints', () => {
    const text = rulesText('select-statement');
    expect(text).toMatch(/ENUM field/);
    expect(text).toMatch(/Container literals in 'in' expression are not supported/);
    expect(text).not.toMatch(/works with str\/int\/int64\/real\/enum\/boolean\/date/);
  });

  it('select-statement calls forceLiterals a risk, not a prohibition', () => {
    const text = rulesText('select-statement');
    expect(text).not.toMatch(/forceLiterals is FORBIDDEN/);
    expect(text).toMatch(/forceLiterals reveals the where-clause values/);
  });

  it('multi-company allows the literal and expression company lists', () => {
    const text = rulesText('multi-company');
    expect(text).not.toMatch(/must be a variable, not an inline literal/);
    expect(text).toMatch(/inline literal/);
  });

  it('switch-loops reports client/server as deprecated rather than ignored', () => {
    const text = rulesText('switch-loops');
    expect(text).not.toMatch(/parsed but IGNORED/);
    expect(text).toMatch(/deprecation warning|has been deprecated/);
  });

  it('operators-precedence knows *= and /= compile', () => {
    expect(rulesText('operators-precedence')).toMatch(/\*= and \/= do compile/);
  });

  it('xpp-class-rules no longer restricts local functions to the top of the body', () => {
    expect(rulesText('xpp-class-rules')).not.toMatch(/declared at the top of a method body/);
  });

  it('every function a knowledge rule names as predefined exists on this platform', () => {
    // A rule may only tell a developer to call something the compiler knows.
    for (const e of KNOWLEDGE_BASE) {
      for (const rule of e.rules) {
        for (const gone of XPP_UNKNOWN_FUNCTIONS) {
          const named = new RegExp(`\\b${gone}\\s*\\(`).test(rule);
          expect(named, `${e.id} names the nonexistent ${gone}()`).toBe(false);
        }
      }
    }
  });
});

describe('the rules added from compiler diagnostics fire on the bad shape', () => {
  const rulesOf = (code: string) => runRules(code, 'xpp');
  const has = (code: string, rule: string) => rulesOf(code).some(v => v.rule === rule);

  it('BP006 — statements the language no longer has', () => {
    expect(has('    pause;', 'BP006')).toBe(true);
    expect(has('    window 10, 10;', 'BP006')).toBe(true);
    expect(has('    tableLock CustGroup;', 'BP006')).toBe(true);
    expect(has('    changeSite(1) { info("@X:Y"); }', 'BP006')).toBe(true);
    // print and breakpoint still compile — a warning, not an error.
    expect(has('    print "x";', 'BP006')).toBe(false);
  });

  it('MAC001 — a directive written without its dot', () => {
    expect(has('#define X(1)\nint i = 1;', 'MAC001')).toBe(true);
    expect(has('#define.X(1)\nint i = #X;', 'MAC001')).toBe(false);
    expect(has('#localmacro MyBlock\n#endmacro', 'MAC001')).toBe(true);
  });

  it('SEL008 — order by after the where of the same segment', () => {
    expect(has('select cg where cg.CustGroup != "" order by CustGroup;', 'SEL008')).toBe(true);
    expect(has('select cg order by CustGroup where cg.CustGroup != "";', 'SEL008')).toBe(false);
    // A join opens a new segment: ordering it after the previous where is correct.
    expect(has(
      'while select cg where cg.A == 1 join ct order by ct.B where ct.C == cg.C { }',
      'SEL008',
    )).toBe(false);
  });

  it('SEL009 — an inline container literal on the in operator', () => {
    expect(has('select firstonly ct where ct.Blocked in [CustVendorBlocked::No];', 'SEL009')).toBe(true);
    expect(has('select firstonly ct where ct.Blocked in blockedStates;', 'SEL009')).toBe(false);
  });

  it('SEL010 — a select expression on an aliased buffer, and validTimeState with a call', () => {
    expect(has('CustGroup cg;\nstr s = (select firstonly cg).Name;', 'SEL010')).toBe(true);
    // The buffer named after its table resolves as the table and compiles.
    expect(has('CustGroup custGroup;\nstr s = (select firstonly custGroup).Name;', 'SEL010')).toBe(false);
    expect(has('str s = (select firstonly CustGroup).Name;', 'SEL010')).toBe(false);
    expect(has('select validTimeState(DateTimeUtil::utcNow()) e;', 'SEL010')).toBe(true);
    expect(has('select validTimeState(asOf) e;', 'SEL010')).toBe(false);
    expect(has('select validTimeState(fromDate, toDate) e;', 'SEL010')).toBe(false);
  });

  it('ATTR001/ATTR002 — attribute arguments', () => {
    expect(has('[SysObsolete(message, false, 1\\1\\2026)]\npublic void f()\n{\n}', 'ATTR001')).toBe(true);
    expect(has('[SysObsolete(strFmt("x"), false, 1\\1\\2026)]\npublic void f()\n{\n}', 'ATTR001')).toBe(true);
    expect(has('[ExtensionOf(classStr(CustTable))]\nfinal class X_Extension\n{\n}', 'ATTR001')).toBe(false);
    expect(has('[SysObsolete("gone", false, 1\\1\\2026)]\npublic void f()\n{\n}', 'ATTR001')).toBe(false);
    expect(has('[SysObsolete("gone", false)]\npublic void f()\n{\n}', 'ATTR002')).toBe(true);
    expect(has('[SysObsolete("gone", false, 1\\1\\2026)]\npublic void f()\n{\n}', 'ATTR002')).toBe(false);
    // A container literal of intrinsics on its own line is not an attribute list.
    expect(has('    [fieldNum(MyTable, A),\n     fieldNum(MyTable, B)]', 'ATTR001')).toBe(false);
  });

  it('EXT001 — an extension-method class whose methods are not static', () => {
    expect(has(
      'public static class MyTable_Extension\n{\n    public str name(MyTable _t)\n    {\n        return "";\n    }\n}',
      'EXT001',
    )).toBe(true);
    expect(has(
      'public static class MyTable_Extension\n{\n    public static str name(MyTable _t)\n    {\n        return "";\n    }\n}',
      'EXT001',
    )).toBe(false);
    expect(has(
      '[ExtensionOf(tableStr(MyTable))]\nfinal class MyTable_Extension\n{\n    public void insert()\n    {\n        next insert();\n    }\n}',
      'EXT001',
    )).toBe(false);
  });

  it('KW001 — a variable named after a reserved word', () => {
    expect(has('    int having;', 'KW001')).toBe(true);
    expect(has('    str namespace = "x";', 'KW001')).toBe(true);
    // `in` is reserved but exempted — legal as an identifier.
    expect(has('    int in;', 'KW001')).toBe(false);
    expect(has('    int counter;', 'KW001')).toBe(false);
  });

  it('CS001 — C# shapes, but not the .NET generics the platform ships', () => {
    expect(has('    public override void run()\n    {\n    }', 'CS001')).toBe(true);
    expect(has('    private protected void f()\n    {\n    }', 'CS001')).toBe(true);
    expect(has('    bool flag = true;', 'CS001')).toBe(true);
    expect(has('    try { f(); } catch (System.Exception ex) { }', 'CS001')).toBe(true);
    expect(has('    private List<str> operatingUnitNumbers;', 'CS001')).toBe(false);
    expect(has('    var l = new System.Collections.Generic.List<str>();', 'CS001')).toBe(false);
  });
});

describe('knowledge names the testing API the platform actually has', () => {
  const rulesText = (id: string) =>
    KNOWLEDGE_BASE.find(e => e.id === id)!.rules.join('\n');

  it('names assertExpectedException only to say it does not exist', () => {
    for (const id of ['testing', 'unit-testing']) {
      const text = rulesText(id);
      expect(text, id).toMatch(/parmExceptionExpected/);
      // The name may appear, but only inside the sentence that denies it.
      for (const m of text.matchAll(/.{0,40}assertExpectedException.{0,40}/g)) {
        expect(m[0], `${id}: ${m[0]}`).toMatch(/There is NO |does not exist/i);
      }
    }
  });

  it('names the suite classes that exist and not the one that does not', () => {
    const text = rulesText('unit-testing');
    expect(text).toMatch(/SysTestSuiteCompanyIsolateClass/);
    // …and says it is OBSOLETE. Compiler-verified 2026-09-02 (probe
    // coverage-v4f, SuiteIsolationAfterD2): returning one builds with
    // "'SysTestSuiteCompanyIsolateClass' is obsolete: 'This suite type is
    // obsolete. Please use SysTestSuite directly'". The entry used to list it
    // among "the ones that exist", which is true and reads as a recommendation.
    expect(text).toMatch(/OBSOLETE/);
    expect(text).toMatch(/use SysTestSuite directly/i);
    expect(text).toMatch(/SysTestSuiteCompanyIsolateMethod/);
    expect(text).not.toMatch(/SysTestSuiteCompanyIsolateShared/);
    expect(text).not.toMatch(/SysTestCaseAutoRollback\b(?!\s+attribute)/);
  });

  it('places SysTestCase where the platform ships it', () => {
    // Moved from the `testing` entry when the two testing topics were
    // consolidated: `unit-testing` is now the authoritative one for the
    // SysTestCase contract, and which package ships the base class is part of
    // that contract — it is the reference a model needs before anything compiles.
    expect(rulesText('unit-testing')).toMatch(/ApplicationFoundation/);
  });

  it('carries the run-time function catalog with the compiler-verified ranges', () => {
    const text = rulesText('runtime-functions');
    expect(text).toMatch(/date2Str takes 7 or 8/);
    expect(text).toMatch(/conIns, conFind and conPoke are VARIADIC/);
    expect(text).toMatch(/corrFlagGet, dateMin, int2Enum, refPrintAll, typeName2Id/);
    expect(text).toMatch(/strSplit\(text, separator\) — returns a List/);
  });
});

describe('report-extension knowledge names only compiler-verified shapes', () => {
  const entry = KNOWLEDGE_BASE.find(e => e.id === 'report-extension-patterns')!;
  const text = entry.rules.join('\n');

  it('carries the XppPrePostArgs surface a probe compiled', () => {
    for (const member of ['getThis()', 'getReturnValue()', 'setReturnValue(', 'getArg(', 'setArg(']) {
      expect(text, member).toContain(member);
    }
  });

  it('quotes the compiler message for a mismatched handler signature', () => {
    expect(text).toMatch(/cannot be used as an event handler/);
  });

  it('lists the print-management delegates that exist', () => {
    for (const d of [
      'getDefaultReportFormatDelegate',
      'getQueryTableIdDelegate',
      'getQueryRangeFieldsDelegate',
      'getPartyTypeDelegate',
      'getPartyRecIdDelegate',
      'getEmailAddressDelegate',
      'getDestinationPartyTypeAndIdDelegate',
    ]) {
      expect(text, d).toContain(d);
    }
  });

  it('separates the design rule from what the compiler enforces', () => {
    // "You can't extend RDP classes" is Microsoft's guidance; a CoC wrapper on
    // SrsReportDataProviderBase.processReport does compile, and the entry says so
    // rather than presenting the guidance as a compiler restriction.
    expect(text).toMatch(/design rule, not something the build will enforce/);
  });
});

describe('the three entries written from probe evidence, not from memory', () => {
  const rulesText = (id: string) => KNOWLEDGE_BASE.find(e => e.id === id)!.rules.join('\n');

  it('args-object names only accessors a probe compiled', () => {
    const text = rulesText('args-object');
    for (const m of ['record()', 'dataset()', 'caller()', 'parmEnum()', 'parmEnumType()',
      'parmObject()', 'menuItemName()', 'menuItemType()', 'openMode()', 'lookupField()',
      'lookupValue()']) {
      expect(text, m).toContain(m);
    }
    // dataset() before record() is the rule the entry exists for.
    expect(text).toMatch(/BEFORE trusting it/);
  });

  it('display-edit-methods states the modifier conflict the compiler reports', () => {
    const text = rulesText('display-edit-methods');
    expect(text).toContain("Conflicting modifiers 'static display'");
    expect(text).toContain('SysClientCacheDataMethodAttribute(true)');
    expect(text).toMatch(/ONCE PER VISIBLE ROW/);
  });

  it('sysoperation-ui-attributes lists attributes that compile together', () => {
    const text = rulesText('sysoperation-ui-attributes');
    for (const a of ['SysOperationGroupAttribute', 'SysOperationGroupMemberAttribute',
      'SysOperationDisplayOrderAttribute', 'SysOperationLabelAttribute',
      'SysOperationHelpTextAttribute', 'SysOperationControlVisibilityAttribute',
      'SysOperationInitializable']) {
      expect(text, a).toContain(a);
    }
    // DisplayOrder takes a string; getting this wrong is a compile error.
    expect(text).toMatch(/a STRING, not an int/);
    // And the deprecation the compiler warns about.
    expect(text).toMatch(/SysEntryPointAttribute.*obsolete/);
  });

  it('the SysOperation scaffold no longer emits the deprecated entry-point attribute', async () => {
    const { codeGenTool } = await import('../../src/tools/smart/codeGen.js');
    const res = await codeGenTool(
      { params: { arguments: { pattern: 'sysoperation', name: 'ConPosting' } } } as never,
      {} as never,
    ) as { content: Array<{ text: string }> };
    expect(res.content[0].text).not.toContain('SysEntryPointAttribute');
  });

  it('the AIS service scaffold does not emit it either', async () => {
    const { codeGenTool } = await import('../../src/tools/smart/codeGen.js');
    const res = await codeGenTool(
      { params: { arguments: { pattern: 'service-class-ais', name: 'ConOrder' } } } as never,
      {} as never,
    ) as { content: Array<{ text: string }> };
    expect(res.content[0].text).not.toContain('SysEntryPointAttribute');
  });
});
