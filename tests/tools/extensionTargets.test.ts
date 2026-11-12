/**
 * What an extension binds to (#1225): Chain of Command wrappers, event handlers
 * and calls to obsolete methods, checked against the indexed declaration.
 *
 * Every error case mirrors a probe xppc rejects, and every "silent" case one it
 * accepts (scripts/oracles/probes/extension-targets.ts): the shapes are the
 * probes', the names are Contoso ones.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { XppSymbolIndex } from '../../src/metadata/symbolIndex';
import {
  resolveXppReferences,
  type ReferenceViolation,
  type ResolverDeps,
} from '../../src/tools/write/resolveReferences';
import { readMethodHeader } from '../../src/tools/write/extensionTargets';

let index: XppSymbolIndex;
let deps: ResolverDeps;

beforeAll(() => {
  index = new XppSymbolIndex(':memory:', ':memory:');
  const add = (name: string, type: string, extra: Record<string, unknown> = {}) =>
    index.addSymbol({ name, type, filePath: '/x.xml', model: 'Test', ...extra } as any);
  const method = (owner: string, name: string, source: string) =>
    add(name, 'method', { parentName: owner, source });

  add('ContosoTransDate', 'edt');
  add('ContosoAssetId', 'edt');
  add('ContosoOtherId', 'edt');
  add('ContosoTransType', 'enum');
  add('ContosoLink', 'class');
  add('ContosoBook', 'class');
  add('EventHandlerResult', 'class');
  add('XppPrePostArgs', 'class');

  add('ContosoRoot', 'class');
  method('ContosoRoot', 'allowSaveLast', 'public boolean allowSaveLast()\n{\n    return true;\n}');

  add('ContosoProposal', 'class', { extendsClass: 'ContosoRoot' });
  const m = (name: string, source: string) => method('ContosoProposal', name, source);
  m('canGoBatch', '/// <summary>Can go batch.</summary>\npublic boolean canGoBatch()\n{\n    return true;\n}');
  m('isBundleReady', 'public boolean isBundleReady(int _bookCount)\n{\n    return true;\n}');
  m('initFirstDate',
    'public ContosoTransDate initFirstDate(ContosoTransDate _transDate, ContosoAssetId _assetId)\n{\n    return _transDate;\n}');
  m('getJournalLink', 'private ContosoLink getJournalLink()\n{\n    return null;\n}');
  m('construct', 'public static ContosoProposal construct(ContosoTransType _transType)\n{\n    return new ContosoProposal();\n}');
  m('outputMessage', '[Wrappable(false)]\nprotected boolean outputMessage()\n{\n    return true;\n}');
  m('isOverridden', '[Wrappable(false)]\npublic boolean isOverridden()\n{\n    return true;\n}');
  m('runOnServer', 'public final void runOnServer()\n{\n}');
  m('trueUp', '[Wrappable(true)]\nfinal protected boolean trueUp(ContosoBook _book)\n{\n    return true;\n}');
  m('process', '/// <summary>[Wrappable(true)] in a comment is not an attribute.</summary>\n[Hookable(false)]\npublic void process()\n{\n}');
  m('creating',
    '/// <summary>Delegate.</summary>\nstatic delegate void creating(ContosoTransType _transType, EventHandlerResult _result)\n{\n}');
  m('changed', 'delegate void changed(ContosoTransType _transType)\n{\n}');
  m('parmBookType',
    "[SysObsolete('Use parmModel instead, [Hookable(false)] does not apply', true, 20\\09\\2016)]\npublic static int parmBookType()\n{\n    return 0;\n}");
  m('oldMethod', "[SysObsolete('Use newMethod', false, 22\\12\\2024)]\npublic static void oldMethod()\n{\n}");
  m('instanceOld', "[SysObsolete('Use newMethod', true)]\npublic void instanceOld()\n{\n}");

  // A class whose base is not in the index: nothing can be said about it.
  add('ContosoOrphan', 'class', { extendsClass: 'ContosoNotIndexedBase' });

  add('CustTable', 'table');
  method('CustTable', 'validateWrite', 'public boolean validateWrite()\n{\n    return true;\n}');

  const writer = index.getReadDb();
  writer.prepare(
    `INSERT INTO extension_metadata
       (extension_name, extension_type, base_object_name, added_fields, added_methods, coc_methods, model)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run('ContosoProposalAdd_Extension', 'class-extension', 'ContosoProposal', null, '["addedByExtension"]', null, 'Test');

  deps = {
    db: writer,
    getLabelById: () => [],
    getLabelFileIds: () => [],
  };
});

afterAll(() => index.close());

/** A CoC class over `target` holding `methods`. */
function coc(target: string, methods: string, kind: 'class' | 'table' = 'class'): string {
  return `[ExtensionOf(${kind}Str(${target}))]\nfinal class ContosoProbe_Extension\n{\n${methods}\n}`;
}

function wrapper(modifiers: string, ret: string, name: string, params = '', args = ''): string {
  const call = `next ${name}(${args})`;
  return `    ${modifiers} ${ret} ${name}(${params})\n    {\n        ${ret === 'void' ? `${call};` : `return ${call};`}\n    }`;
}

function findings(code: string, kind: ReferenceViolation['kind']): ReferenceViolation[] {
  return resolveXppReferences(code, deps).violations.filter(v => v.kind === kind);
}

describe('Chain of Command wrapper targets', () => {
  it('accepts a wrapper of a method the class declares', () => {
    expect(findings(coc('ContosoProposal', wrapper('public', 'boolean', 'canGoBatch')), 'coc-target')).toEqual([]);
  });

  it('reports a wrapper of a method no type in the chain declares, naming the chain', () => {
    const [v, ...rest] = findings(coc('ContosoProposal', wrapper('public', 'void', 'noSuchMethod')), 'coc-target');
    expect(rest).toEqual([]);
    expect(v.severity).toBe('error');
    expect(v.identifier).toBe('ContosoProposal.noSuchMethod');
    expect(v.detail).toContain('ContosoProposal → ContosoRoot');
    expect(v.line).toBe(4);
  });

  it('accepts a wrapper of a method only a base class declares', () => {
    expect(findings(coc('ContosoProposal', wrapper('public', 'boolean', 'allowSaveLast')), 'coc-target')).toEqual([]);
  });

  it('stays silent when the chain leaves the index', () => {
    expect(findings(coc('ContosoOrphan', wrapper('public', 'void', 'anything')), 'coc-target')).toEqual([]);
  });

  it('stays silent on a method an extension contributes', () => {
    expect(findings(coc('ContosoProposal', wrapper('public', 'void', 'addedByExtension')), 'coc-target')).toEqual([]);
  });

  it('ignores `next` inside a comment', () => {
    const code = coc('ContosoProposal', '    public void helper()\n    {\n        // call next noSuchMethod() here\n    }');
    expect(findings(code, 'coc-target')).toEqual([]);
  });

  it.each([
    ['a private target', wrapper('private', 'ContosoLink', 'getJournalLink'), 'private'],
    ['a final target without [Wrappable(true)]', wrapper('public', 'void', 'runOnServer'), 'final'],
    ['a public [Wrappable(false)] target', wrapper('public', 'boolean', 'isOverridden'), 'Wrappable(false)'],
    ['a [Hookable(false)] target', wrapper('public', 'void', 'process'), 'Hookable(false)'],
    ['a dropped parameter', wrapper('public', 'boolean', 'isBundleReady'), '0 parameter(s), the target 1'],
    ['a str parameter where the base has int',
      wrapper('public', 'boolean', 'isBundleReady', 'str _bookCount', '_bookCount'), 'parameter 1 is str'],
    ['an instance wrapper of a static target',
      wrapper('public', 'ContosoProposal', 'construct', 'ContosoTransType _transType', '_transType'), 'the target is static'],
  ])('reports %s as an error', (_label, method, reason) => {
    const [v, ...rest] = findings(coc('ContosoProposal', method), 'coc-target');
    expect(rest).toEqual([]);
    expect(v.severity).toBe('error');
    expect(v.detail).toContain(reason);
  });

  it('reports a wrapper whose return type cannot convert', () => {
    const code = coc('ContosoProposal',
      '    public int isBundleReady(int _bookCount)\n    {\n        next isBundleReady(_bookCount);\n        return 0;\n    }');
    const [v] = findings(code, 'coc-target');
    expect(v.severity).toBe('error');
    expect(v.detail).toContain('returns int, the target boolean');
  });

  it.each([
    ['a final target with [Wrappable(true)]', wrapper('protected', 'boolean', 'trueUp', 'ContosoBook _book', '_book')],
    ['a protected [Wrappable(false)] target', wrapper('protected', 'boolean', 'outputMessage')],
    ['a renamed parameter', wrapper('public', 'boolean', 'isBundleReady', 'int _count', '_count')],
    ['a type spelled in another case',
      wrapper('public', 'ContosoTransDate', 'initFirstDate', 'contosotransdate _d, ContosoAssetId _a', '_d, _a')],
    ['a static wrapper of a static target',
      wrapper('public static', 'ContosoProposal', 'construct', 'ContosoTransType _transType', '_transType')],
  ])('accepts %s', (_label, method) => {
    expect(findings(coc('ContosoProposal', method), 'coc-target')).toEqual([]);
  });

  it('only warns when a parameter uses another EDT (the compiler warns too)', () => {
    const code = coc('ContosoProposal',
      wrapper('public', 'ContosoTransDate', 'initFirstDate', 'ContosoTransDate _d, ContosoOtherId _a', '_d, _a'));
    const [v, ...rest] = findings(code, 'coc-target');
    expect(rest).toEqual([]);
    expect(v.severity).toBe('warning');
    expect(v.detail).toContain('parameter 2 is ContosoOtherId');
  });

  describe('on a table', () => {
    it('accepts a kernel method the table does not declare', () => {
      expect(findings(coc('CustTable', wrapper('public', 'void', 'postLoad'), 'table'), 'coc-target')).toEqual([]);
    });

    it('reports a method the table does not have', () => {
      const [v] = findings(coc('CustTable', wrapper('public', 'void', 'noSuchMethod'), 'table'), 'coc-target');
      expect(v.severity).toBe('error');
    });

    it('reports a wrapper of a declared method with an extra parameter', () => {
      const code = coc('CustTable', wrapper('public', 'boolean', 'validateWrite', 'boolean _extra', '_extra'), 'table');
      const [v] = findings(code, 'coc-target');
      expect(v.severity).toBe('error');
      expect(v.detail).toContain('1 parameter(s), the target 0');
    });
  });
});

describe('event handler targets', () => {
  const handler = (attribute: string, params: string) =>
    `class ContosoHandlers\n{\n    ${attribute}\n    public static void onIt(${params})\n    {\n    }\n}`;
  const creating = 'ContosoTransType _transType, EventHandlerResult _result';

  it('accepts a handler of a static delegate named with staticDelegateStr', () => {
    const code = handler('[SubscribesTo(classStr(ContosoProposal), staticDelegateStr(ContosoProposal, creating))]', creating);
    expect(findings(code, 'handler-target')).toEqual([]);
  });

  // The delegate itself (exists on the named type, is a delegate, static or not)
  // is the delegateStr() check's finding, reported once, not twice.
  it.each([
    ['a static delegate named with delegateStr',
      '[SubscribesTo(classStr(ContosoProposal), delegateStr(ContosoProposal, creating))]', creating,
      'wrong-member-kind', 'staticDelegateStr(ContosoProposal, creating)'],
    ['a delegate the class does not have',
      '[SubscribesTo(classStr(ContosoProposal), staticDelegateStr(ContosoProposal, noSuchDelegate))]', creating,
      'unknown-method', 'declares no delegate'],
    ['an ordinary method',
      '[SubscribesTo(classStr(ContosoProposal), delegateStr(ContosoProposal, canGoBatch))]', '',
      'wrong-member-kind', 'not a delegate'],
  ] as const)('reports %s once, through the intrinsic', (_label, attribute, params, kind, reason) => {
    const code = handler(attribute, params);
    expect(findings(code, 'handler-target')).toEqual([]);
    const [v, ...rest] = findings(code, kind);
    expect(rest).toEqual([]);
    expect(v.severity).toBe('error');
    expect(v.detail).toContain(reason);
  });

  it.each([
    ['a handler with one parameter fewer',
      '[SubscribesTo(classStr(ContosoProposal), staticDelegateStr(ContosoProposal, creating))]',
      'ContosoTransType _transType', '1 parameter(s), the target 2'],
    ['a handler whose parameter is int where the delegate has an enum',
      '[SubscribesTo(classStr(ContosoProposal), staticDelegateStr(ContosoProposal, creating))]',
      'int _transType, EventHandlerResult _result', 'parameter 1 is int'],
  ])('reports %s as an error', (_label, attribute, params, reason) => {
    const [v, ...rest] = findings(handler(attribute, params), 'handler-target');
    expect(rest).toEqual([]);
    expect(v.severity).toBe('error');
    expect(v.detail).toContain(reason);
  });

  it('accepts an instance delegate named with delegateStr', () => {
    const code = handler('[SubscribesTo(classStr(ContosoProposal), delegateStr(ContosoProposal, changed))]',
      'ContosoTransType _transType');
    expect(findings(code, 'handler-target')).toEqual([]);
  });

  it.each([
    ['a [Hookable(false)] method', 'process', 'Hookable(false)'],
    ['a private method', 'getJournalLink', 'private'],
  ])('reports a post-handler on %s', (_label, method, reason) => {
    const code = handler(
      `[PostHandlerFor(classStr(ContosoProposal), methodStr(ContosoProposal, ${method}))]`, 'XppPrePostArgs _args');
    const [v] = findings(code, 'handler-target');
    expect(v.severity).toBe('error');
    expect(v.detail).toContain(reason);
  });

  it('accepts a post-handler on an ordinary public method', () => {
    const code = handler('[PostHandlerFor(classStr(ContosoProposal), methodStr(ContosoProposal, canGoBatch))]',
      'XppPrePostArgs _args');
    expect(findings(code, 'handler-target')).toEqual([]);
  });
});

describe('calls to obsolete methods', () => {
  it('reports a call to a method obsolete with isError = true as an error', () => {
    const [v] = findings('void run()\n{\n    int i = ContosoProposal::parmBookType();\n}', 'obsolete-method');
    expect(v.severity).toBe('error');
    expect(v.identifier).toBe('ContosoProposal::parmBookType');
    expect(v.line).toBe(3);
  });

  it('only warns on a method obsolete without the error flag', () => {
    const [v] = findings('void run()\n{\n    ContosoProposal::oldMethod();\n}', 'obsolete-method');
    expect(v.severity).toBe('warning');
  });

  it('checks instance calls on a declared variable too', () => {
    const [v] = findings('void run()\n{\n    ContosoProposal proposal;\n    proposal.instanceOld();\n}', 'obsolete-method');
    expect(v.severity).toBe('error');
  });

  it('says nothing about a method that is not obsolete', () => {
    expect(findings('void run()\n{\n    ContosoProposal::construct(ContosoTransType::None);\n}', 'obsolete-method'))
      .toEqual([]);
  });
});

describe('readMethodHeader', () => {
  it('reads attributes only in front of the body, not inside strings or the body', () => {
    const header = readMethodHeader(
      "[SysObsolete('see [Hookable(false)]', false)]\npublic void m()\n{\n    // [Wrappable(false)]\n    str s = 'delegate';\n}");
    expect(header).toEqual({ isDelegate: false, hookable: undefined, wrappable: undefined, obsoleteError: false });
  });

  it.each([
    ['[Wrappable]', { wrappable: true }],
    ['[Wrappable(true)]', { wrappable: true }],
    ['[WrappableAttribute(false)]', { wrappable: false }],
    ['[HookableAttribute(true)]', { hookable: true }],
    ['[Hookable(false), Wrappable(false)]', { hookable: false, wrappable: false }],
  ])('reads %s', (attribute, expected) => {
    expect(readMethodHeader(`${attribute}\npublic void m()\n{\n}`)).toMatchObject(expected);
  });
});

/**
 * Each case below is a false ERROR the first sweep over the shipped AOT raised on
 * code that compiles (69 in all), reduced to its shape.
 */
describe('shapes the shipped sweep proved legal', () => {
  beforeAll(() => {
    const add = (name: string, type: string, extra: Record<string, unknown> = {}) =>
      index.addSymbol({ name, type, filePath: `/${type}/${name}.xml`, model: 'Test', ...extra } as any);
    // A table and a form share this name; the delegate lives on the form, whose
    // methods are not indexed.
    add('ContosoShared', 'table');
    add('ContosoShared', 'form');
    add('checkQty', 'method', {
      parentName: 'ContosoProposal',
      source: '[HookableAttribute(true)]\nprivate boolean checkQty()\n{\n    return true;\n}',
    });
    add('postReady', 'method', {
      parentName: 'ContosoProposal',
      source: '[Wrappable]\nprotected final boolean postReady(int _count)\n{\n    return true;\n}',
    });
  });

  it('does not look for a form delegate on a table of the same name', () => {
    const code = 'class ContosoHandlers\n{\n' +
      '    [SubscribesTo(formStr(ContosoShared), delegateStr(ContosoShared, controlsUpdating))]\n' +
      '    public static void onUpdating()\n    {\n    }\n}';
    expect(findings(code, 'handler-target')).toEqual([]);
  });

  it('accepts a post-handler on a private method marked [HookableAttribute(true)]', () => {
    const code = 'class ContosoHandlers\n{\n' +
      '    [PostHandlerFor(classStr(ContosoProposal), methodStr(ContosoProposal, checkQty))]\n' +
      '    public static void postCheckQty(XppPrePostArgs _args)\n    {\n    }\n}';
    expect(findings(code, 'handler-target')).toEqual([]);
  });

  it('accepts a wrapper of a final method marked with the bare [Wrappable]', () => {
    const code = coc('ContosoProposal', wrapper('protected', 'boolean', 'postReady', 'int _count', '_count'));
    expect(findings(code, 'coc-target')).toEqual([]);
  });

  it('only warns on an obsolete call from code that is obsolete itself', () => {
    const code = "[SysObsolete('Retired', true)]\nclass ContosoRetired\n{\n" +
      '    public void run()\n    {\n        int i = ContosoProposal::parmBookType();\n    }\n}';
    const [v] = findings(code, 'obsolete-method');
    expect(v.severity).toBe('warning');
  });
});

/**
 * The member of methodStr / staticMethodStr / tableMethodStr /
 * tableStaticMethodStr / delegateStr / staticDelegateStr (#1270 probes,
 * scripts/oracles/probes/intrinsic-members.ts: every error case FAILS in xppc).
 */
describe('intrinsic members', () => {
  beforeAll(() => {
    const add = (name: string, type: string, extra: Record<string, unknown> = {}) =>
      index.addSymbol({ name, type, filePath: `/${type}/${name}.xml`, model: 'Test', ...extra } as any);
    add('find', 'method', {
      parentName: 'CustTable',
      source: 'public static CustTable find(str _accountNum)\n{\n    CustTable custTable;\n    return custTable;\n}',
    });
    add('ContosoFormOnly', 'form');
    add('ContosoView', 'view');
    add('ContosoChildProposal', 'class', { extendsClass: 'ContosoProposal' });
  });

  const one = (expr: string) => resolveXppReferences(`void run()\n{\n    str s = ${expr};\n}`, deps)
    .violations.filter(v => ['unknown-method', 'wrong-member-kind'].includes(v.kind));

  it.each([
    ['a method the class declares', 'methodStr(ContosoProposal, canGoBatch)'],
    ['a static method through staticMethodStr', 'staticMethodStr(ContosoProposal, construct)'],
    ['a method an extension class adds', 'methodStr(ContosoProposal, addedByExtension)'],
    ['a table method through tableMethodStr, any casing', 'tableMethodStr(custtable, VALIDATEWRITE)'],
    ['a static table method through tableStaticMethodStr', 'tableStaticMethodStr(CustTable, find)'],
    ['an instance delegate through delegateStr', 'delegateStr(ContosoProposal, changed)'],
    ['a static delegate through staticDelegateStr', 'staticDelegateStr(ContosoProposal, creating)'],
    ['a view owner, which the index cannot answer for', 'tableMethodStr(ContosoView, anything)'],
    ['a delegate of a form that shares its name with a table', 'delegateStr(ContosoShared, controlsUpdating)'],
  ])('accepts %s', (_label, expr) => {
    expect(one(expr)).toEqual([]);
  });

  it.each([
    ['a method nobody declares', 'methodStr(ContosoProposal, noSuchMethod)', 'unknown-method', 'declares no method'],
    ['a method only the base class declares', 'methodStr(ContosoProposal, allowSaveLast)', 'unknown-method',
      'methodStr(ContosoRoot, allowSaveLast)'],
    ['a delegate only the base class declares', 'delegateStr(ContosoChildProposal, changed)', 'unknown-method',
      'delegateStr(ContosoProposal, changed)'],
    ['a kernel method the table does not override', 'tableMethodStr(CustTable, postLoad)', 'unknown-method',
      'kernel method it does not override'],
    ['a static method through methodStr', 'methodStr(ContosoProposal, construct)', 'wrong-member-kind',
      'staticMethodStr(ContosoProposal, construct)'],
    ['an instance method through staticMethodStr', 'staticMethodStr(ContosoProposal, canGoBatch)', 'wrong-member-kind',
      'methodStr(ContosoProposal, canGoBatch)'],
    ['a static table method through tableMethodStr', 'tableMethodStr(CustTable, find)', 'wrong-member-kind',
      'tableStaticMethodStr(CustTable, find)'],
    ['an instance delegate through staticDelegateStr', 'staticDelegateStr(ContosoProposal, changed)', 'wrong-member-kind',
      'delegateStr(ContosoProposal, changed)'],
    ['an ordinary method through delegateStr', 'delegateStr(ContosoProposal, canGoBatch)', 'wrong-member-kind',
      'not a delegate'],
    ['a table in methodStr', 'methodStr(CustTable, validateWrite)', 'wrong-member-kind',
      'tableMethodStr(CustTable, validateWrite)'],
    ['a form in methodStr', 'methodStr(ContosoFormOnly, init)', 'wrong-member-kind', 'formMethodStr(ContosoFormOnly, init)'],
  ])('reports %s', (_label, expr, kind, text) => {
    const [v, ...rest] = one(expr);
    expect(rest).toEqual([]);
    expect(v.kind).toBe(kind);
    expect(v.severity).toBe('error');
    expect(v.detail).toContain(text);
  });
});
