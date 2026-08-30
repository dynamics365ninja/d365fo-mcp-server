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
