/**
 * Upgrade impact on synthetic fixtures: a dependency model in two versions (ContosoDep), and our
 * model (ContosoApp) with one method per kind of break, so every kind has its own test.
 */
import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { referenceFindings } from '../../src/tools/analysis/upgradeImpactReferences';
import { XppSymbolIndex } from '../../src/metadata/symbolIndex';
import type { ModelSnapshot, RawClass, RawMethod } from '../../src/metadata/versionDiff';
import {
  analyzeImpact,
  buildDependencyIndex,
  hasName,
  mergeFindings,
  renderImpactMarkdown,
  scanCalls,
  stripSource,
  variableTypes,
  type ImpactFinding,
} from '../../src/metadata/upgradeImpact';

const m = (name: string, params: string[] = [], over: Partial<RawMethod> = {}): RawMethod => ({
  name,
  visibility: 'public',
  returnType: 'void',
  parameters: params.map(p => {
    const [type, pname, def] = p.split(' ');
    return { name: pname, type, ...(def ? { defaultValue: def } : {}) };
  }),
  isStatic: false,
  ...over,
});

const lib = (methods: RawMethod[], over: Partial<RawClass> = {}): RawClass => ({
  name: 'ContosoLib',
  model: 'ContosoDep',
  declaration: 'public class ContosoLib\n{\n}',
  methods,
  ...over,
});

/** The platform kernel: `Common` declares the methods every table has, which the tables below override or not. */
function kernel(): ModelSnapshot {
  return {
    model: 'Kernel',
    classes: [{ name: 'Object', model: 'Kernel', methods: [] }],
    tables: [
      {
        name: 'Common',
        methods: [m('update'), m('doUpdate'), m('validateWrite', [], { returnType: 'boolean' })],
        fields: [],
      },
    ],
    edts: [],
    enums: [],
  };
}

const deps = (version: 'old' | 'new'): ModelSnapshot[] => [dependency(version), kernel()];

function dependency(version: 'old' | 'new'): ModelSnapshot {
  const v2 = version === 'new';
  const methods: RawMethod[] = [
    m('process', ['Name _name']),
    m('hidden', [], { visibility: v2 ? 'private' : 'public' }),
    v2 ? m('typed', ['int _s']) : m('typed', ['str _s']),
    v2 ? m('result', [], { returnType: 'int' }) : m('result', [], { returnType: 'str' }),
    m('toStatic', [], { isStatic: v2 }),
    v2 ? m('addedRequired', ['int _a', 'int _b']) : m('addedRequired', ['int _a']),
    v2 ? m('addedOptional', ['int _a', 'int _b 1']) : m('addedOptional', ['int _a']),
    m('old', [], { attributes: v2 ? ['[SysObsolete("@Contoso:Use2")]'] : [] }),
    m('older', [], { attributes: v2 ? ['[SysObsolete("@Contoso:Use2", true)]'] : [] }),
    v2 ? m('wrapped', ['int _a', 'str _b']) : m('wrapped', ['int _a']),
    m('returnsWrapped', [], { returnType: v2 ? 'int' : 'str' }),
    m('locked', [], { isFinal: v2 }),
    m('overridable', [], { isFinal: v2 }),
    v2 ? m('sig', ['str _x']) : m('sig', ['int _x']),
    m('onDone', v2 ? ['int _x', 'str _y'] : ['int _x'], { isDelegate: true }),
    m('onHooked', ['int _x'], { isDelegate: true, attributes: v2 ? ['[Hookable(false)]'] : [] }),
    m('onPlain', ['int _x'], { isDelegate: true }),
  ];
  if (!v2)
    methods.push(m('removed'), m('gone'), m('orphan'), m('onGone', ['int _x'], { isDelegate: true }), m('preTarget'));
  const classes: RawClass[] = [lib(methods), { name: 'ContosoRemovedClass', model: 'ContosoDep', methods: [] }];
  classes.push({ name: 'ContosoParent', model: 'ContosoDep', methods: [m('shared'), m('act', ['str _x'])] });
  classes.push({
    name: 'ContosoChild2',
    model: 'ContosoDep',
    extends: 'ContosoParent',
    methods: v2 ? [] : [m('act', ['int _x'])],
  });
  // Its base is not part of the compared metadata: nothing can be said about what it declares.
  classes.push({
    name: 'ContosoDangling',
    model: 'ContosoDep',
    extends: 'ContosoMissingBase',
    methods: v2 ? [] : [m('m')],
  });
  classes.push({
    name: 'ContosoChild',
    model: 'ContosoDep',
    extends: 'ContosoParent',
    methods: v2 ? [] : [m('shared'), m('childOnly')],
  });
  classes.push({
    name: 'ContosoObsoleteClass',
    model: 'ContosoDep',
    declaration: v2
      ? '[SysObsolete("@Contoso:Old")]\npublic class ContosoObsoleteClass\n{\n}'
      : 'public class ContosoObsoleteClass\n{\n}',
    methods: [],
  });
  classes.push({
    name: 'ContosoObsoleteErrorClass',
    model: 'ContosoDep',
    declaration: v2
      ? '[SysObsolete("@Contoso:Old", true)]\npublic class ContosoObsoleteErrorClass\n{\n}'
      : 'public class ContosoObsoleteErrorClass\n{\n}',
    methods: [],
  });
  return {
    model: 'ContosoDep',
    classes: v2 ? classes.filter(c => c.name !== 'ContosoRemovedClass') : classes,
    tables: [
      {
        name: 'ContosoDepTable',
        methods: v2
          ? []
          : [m('update'), m('customCheck'), m('doUpdate'), m('validateWrite', [], { returnType: 'boolean' })],
        fields: [
          { name: 'Keep', type: 'Int64', extendedDataType: 'RefRecId' },
          ...(v2 ? [] : [{ name: 'Gone', type: 'String', extendedDataType: 'Name' }]),
          { name: 'TypeChg', type: v2 ? 'Int64' : 'String' },
          { name: 'EdtChg', type: 'String', extendedDataType: v2 ? 'Description' : 'Name' },
        ],
      },
    ],
    edts: [{ name: 'ContosoDepEdt', extends: 'Name', stringSize: v2 ? 20 : 10 }],
    enums: [{ name: 'ContosoDepEnum', values: v2 ? [{ name: 'A' }] : [{ name: 'A' }, { name: 'B' }] }],
  };
}

const src = (header: string, body: string): string => `${header}\n{\n${body}\n}`;

function ourClass(name: string, methods: Array<[string, string]>, over: Partial<RawClass> = {}): RawClass {
  return {
    name,
    model: 'ContosoApp',
    sourcePath: `AxClass/${name}.xml`,
    declaration: `final class ${name}\n{\n}`,
    methods: methods.map(([n, source]) => ({
      name: n,
      visibility: 'public',
      returnType: 'void',
      parameters: [],
      isStatic: false,
      source,
    })),
    ...over,
  };
}

function wrapperMethod(
  name: string,
  params: Array<[string, string]>,
  body = `next ${name}(${params.map(p => p[1]).join(', ')});`,
): RawMethod {
  return {
    name,
    visibility: 'public',
    returnType: 'void',
    isStatic: false,
    parameters: params.map(([type, pname]) => ({ type, name: pname })),
    source: src(`public void ${name}(${params.map(([t, n]) => `${t} ${n}`).join(', ')})`, `    ${body}`),
  };
}

const call = (header: string, body: string): string => src(header, `    ContosoLib l = new ContosoLib();\n    ${body}`);

function ours(): ModelSnapshot {
  const users = ourClass('ContosoUser', [
    ['callRemoved', call('public void callRemoved()', 'l.removed();')],
    ['callHidden', call('public void callHidden()', 'l.hidden();')],
    ['callTyped', call('public void callTyped()', "l.typed('x');")],
    ['callResult', call('public void callResult()', 'str s = l.result();')],
    ['callStatic', call('public void callStatic()', 'l.toStatic();')],
    ['callRequired', call('public void callRequired()', 'l.addedRequired(1);')],
    ['callOptional', call('public void callOptional()', 'l.addedOptional(1);')],
    ['callOld', call('public void callOld()', 'l.old();')],
    ['callOlder', call('public void callOlder()', 'l.older();')],
    ['useRemovedType', src('public void useRemovedType()', '    ContosoRemovedClass x;')],
    ['useObsoleteClass', src('public void useObsoleteClass()', '    ContosoObsoleteClass x;')],
    ['useObsoleteErrorClass', src('public void useObsoleteErrorClass()', '    ContosoObsoleteErrorClass x;')],
    ['useEdt', src('public void useEdt()', '    ContosoDepEdt e;')],
    ['fieldGone', src('public void fieldGone(ContosoDepTable t)', '    t.Gone = "x";')],
    ['fieldType', src('public void fieldType(ContosoDepTable t)', '    t.TypeChg = "x";')],
    ['fieldEdt', src('public void fieldEdt()', '    FieldId id = fieldNum(ContosoDepTable, EdtChg);')],
    ['fieldKept', src('public void fieldKept(ContosoDepTable t)', '    t.Keep = 1;')],
    ['enumGone', src('public void enumGone()', '    ContosoDepEnum e = ContosoDepEnum::B;')],
    ['enumKept', src('public void enumKept()', '    ContosoDepEnum e = ContosoDepEnum::A;')],
    ['callUntyped', src('public void callUntyped()', '    unknownThing.removed();')],
    ['callKernel', src('public void callKernel(ContosoDepTable t)', '    t.update();')],
    ['callCustom', src('public void callCustom(ContosoDepTable t)', '    t.customCheck();')],
    ['callDirect', src('public void callDirect(ContosoDepTable t)', '    t.doUpdate();')],
    ['callValidate', src('public void callValidate(ContosoDepTable t)', '    boolean ok = t.validateWrite();')],
    ['callInherited', src('public void callInherited(ContosoChild c)', '    c.shared();')],
    ['callIncompatibleBase', src('public void callIncompatibleBase(ContosoChild2 c)', '    c.act(1);')],
    ['callDangling', src('public void callDangling(ContosoDangling d)', '    d.m();')],
    ['callChildOnly', src('public void callChildOnly(ContosoChild c)', '    c.childOnly();')],
  ]);

  const wrapper = ourClass('ContosoLib_Contoso_Extension', [], {
    extensionOf: { baseObjectName: 'ContosoLib', baseKind: 'class' },
    declaration: '[ExtensionOf(classStr(ContosoLib))]\nfinal class ContosoLib_Contoso_Extension\n{\n}',
  });
  wrapper.methods = [
    wrapperMethod('wrapped', [['int', '_a']]),
    wrapperMethod('gone', []),
    wrapperMethod('locked', []),
    wrapperMethod('process', [['Name', '_name']]),
    { ...wrapperMethod('returnsWrapped', []), returnType: 'str' },
  ];

  const sub = ourClass('ContosoSub', [], { extends: 'ContosoLib' });
  sub.methods = [
    {
      name: 'overridable',
      visibility: 'public',
      returnType: 'void',
      parameters: [],
      isStatic: false,
      source: src('public void overridable()', ''),
    },
    {
      name: 'orphan',
      visibility: 'public',
      returnType: 'void',
      parameters: [],
      isStatic: false,
      source: src('public void orphan()', ''),
    },
    {
      name: 'sig',
      visibility: 'public',
      returnType: 'void',
      parameters: [{ name: '_x', type: 'int' }],
      isStatic: false,
      source: src('public void sig(int _x)', ''),
    },
  ];

  const handlers = ourClass('ContosoHandlers', []);
  const handler = (name: string, attr: string, params: Array<[string, string]> = [['int', '_x']]): RawMethod => ({
    name,
    visibility: 'public',
    returnType: 'void',
    isStatic: true,
    parameters: params.map(([type, pname]) => ({ type, name: pname })),
    source: `${attr}\npublic static void ${name}(${params.map(([t, n]) => `${t} ${n}`).join(', ')})\n{\n}`,
  });
  handlers.methods = [
    handler('onDoneHandler', '[SubscribesTo(classStr(ContosoLib), delegateStr(ContosoLib, onDone))]'),
    handler('onGoneHandler', '[SubscribesTo(classStr(ContosoLib), delegateStr(ContosoLib, onGone))]'),
    handler('onHookedHandler', '[SubscribesTo(classStr(ContosoLib), delegateStr(ContosoLib, onHooked))]'),
    handler('onPlainHandler', '[SubscribesTo(classStr(ContosoLib), delegateStr(ContosoLib, onPlain))]'),
    handler('preHandler', '[PreHandlerFor(classStr(ContosoLib), methodStr(ContosoLib, preTarget))]', [
      ['XppPrePostArgs', '_args'],
    ]),
  ];

  const tableExt = ourClass('ContosoDepTable_Contoso_Extension', [], {
    extensionOf: { baseObjectName: 'ContosoDepTable', baseKind: 'table' },
  });
  tableExt.methods = [wrapperMethod('update', []), wrapperMethod('doUpdate', []), wrapperMethod('validateWrite', [])];

  const orphanExt = ourClass('ContosoRemovedClass_Contoso_Extension', [], {
    extensionOf: { baseObjectName: 'ContosoRemovedClass', baseKind: 'class' },
  });
  orphanExt.methods = [wrapperMethod('anything', [])];

  return {
    model: 'ContosoApp',
    classes: [users, wrapper, sub, handlers, orphanExt, tableExt],
    tables: [],
    edts: [],
    enums: [],
  };
}

const report = analyzeImpact({
  from: 'old',
  to: 'new',
  fromDeps: deps('old'),
  toDeps: deps('new'),
  ours: [ours()],
});
const find = (object: string): ImpactFinding[] => report.findings.filter(f => f.object === object);

describe('calls into a changed dependency', () => {
  it.each([
    ['ContosoUser.callRemoved', 'method-removed', 'error'],
    ['ContosoUser.callHidden', 'not-visible', 'error'],
    ['ContosoUser.callTyped', 'param-type', 'error'],
    ['ContosoUser.callResult', 'return-type', 'error'],
    ['ContosoUser.callStatic', 'static-changed', 'error'],
    ['ContosoUser.callRequired', 'arity', 'error'],
    ['ContosoUser.callOptional', 'optional-parameter-added', 'warning'],
    ['ContosoUser.callOld', 'obsolete', 'warning'],
    ['ContosoUser.callOlder', 'obsolete', 'error'],
  ])('%s -> %s (%s)', (object, kind, level) => {
    const hits = find(object).filter(f => f.kind === kind);
    expect(hits).toHaveLength(1);
    expect(hits[0].level).toBe(level);
    expect(hits[0].dependency).toContain('ContosoLib');
    expect(hits[0].line).toBeGreaterThan(0);
  });

  it('gives before and after, and the new required argument for an arity break', () => {
    const f = find('ContosoUser.callRequired')[0];
    expect(f.before).toBe('public void addedRequired(int _a)');
    expect(f.after).toBe('public void addedRequired(int _a, int _b)');
    expect(f.fix).toContain('int _b');
  });

  it('reports nothing for a call that is untouched or cannot be typed', () => {
    expect(find('ContosoUser.callUntyped')).toEqual([]);
  });
});

describe('names that vanished or changed', () => {
  it('a removed class', () => {
    expect(find('ContosoUser.useRemovedType')).toMatchObject([
      { kind: 'type-removed', level: 'error', dependency: 'ContosoRemovedClass' },
    ]);
  });

  it('an obsolete class, error when the flag is set', () => {
    expect(find('ContosoUser.useObsoleteClass')).toMatchObject([{ kind: 'obsolete', level: 'warning' }]);
    expect(find('ContosoUser.useObsoleteErrorClass')).toMatchObject([{ kind: 'obsolete', level: 'error' }]);
  });

  it('an EDT whose size changed is a behaviour change', () => {
    expect(find('ContosoUser.useEdt')).toMatchObject([{ kind: 'edt-changed', level: 'behaviour' }]);
  });
});

describe('fields and enum values', () => {
  it('a removed field', () => {
    expect(find('ContosoUser.fieldGone')).toMatchObject([
      { kind: 'field-removed', level: 'error', dependency: 'ContosoDepTable.Gone' },
    ]);
  });

  it('a base type change is an error, an EDT change a behaviour change', () => {
    expect(find('ContosoUser.fieldType')).toMatchObject([
      { kind: 'field-type', level: 'error', before: 'String', after: 'Int64' },
    ]);
    expect(find('ContosoUser.fieldEdt')).toMatchObject([
      { kind: 'field-edt', level: 'behaviour', before: 'Name', after: 'Description' },
    ]);
  });

  it('leaves a field that did not change alone', () => {
    expect(find('ContosoUser.fieldKept')).toEqual([]);
  });

  it('a removed enum value', () => {
    expect(find('ContosoUser.enumGone')).toMatchObject([
      { kind: 'enum-value-removed', level: 'error', dependency: 'ContosoDepEnum::B' },
    ]);
    expect(find('ContosoUser.enumKept')).toEqual([]);
  });
});

describe('Chain of Command wrappers', () => {
  const wrapper = 'ContosoLib_Contoso_Extension';

  it('a parameter added to the wrapped method: the wrapper must repeat the new signature', () => {
    const f = find(`${wrapper}.wrapped`)[0];
    expect(f).toMatchObject({
      kind: 'coc-signature',
      level: 'error',
      before: 'public void wrapped(int _a)',
      after: 'public void wrapped(int _a, str _b)',
    });
    expect(f.fix).toBe('public void wrapped(int _a, str _b)');
  });

  it('a changed return type', () => {
    expect(find(`${wrapper}.returnsWrapped`)).toMatchObject([{ kind: 'coc-signature', level: 'error' }]);
  });

  it('a wrapped method that no longer exists', () => {
    expect(find(`${wrapper}.gone`)).toMatchObject([{ kind: 'coc-method-removed', level: 'error' }]);
  });

  it('a wrapped method that became final', () => {
    expect(find(`${wrapper}.locked`)).toMatchObject([{ kind: 'coc-not-wrappable', level: 'error' }]);
  });

  it('a wrapper whose method did not change is clean', () => {
    expect(find(`${wrapper}.process`)).toEqual([]);
  });

  it('a wrapper whose target class was removed', () => {
    expect(find('ContosoRemovedClass_Contoso_Extension.anything')).toMatchObject([
      { kind: 'coc-base-removed', level: 'error' },
    ]);
  });
});

describe('event handlers', () => {
  it('a delegate that gained a parameter: the handler must match', () => {
    const f = find('ContosoHandlers.onDoneHandler')[0];
    expect(f).toMatchObject({ kind: 'subscription-signature', level: 'error' });
    expect(f.fix).toContain('int _x, str _y');
  });

  it('a delegate that no longer exists', () => {
    expect(find('ContosoHandlers.onGoneHandler')).toMatchObject([
      { kind: 'subscription-target-removed', level: 'error' },
    ]);
  });

  it('a delegate that lost Hookable', () => {
    expect(find('ContosoHandlers.onHookedHandler')).toMatchObject([{ kind: 'not-hookable', level: 'error' }]);
  });

  it('an unchanged delegate is clean', () => {
    expect(find('ContosoHandlers.onPlainHandler')).toEqual([]);
  });

  it('a pre-handler whose target method was removed', () => {
    expect(find('ContosoHandlers.preHandler')).toMatchObject([{ kind: 'handler-target-removed', level: 'error' }]);
  });
});

describe('a method the type stopped declaring but still has by inheritance', () => {
  const ext = 'ContosoDepTable_Contoso_Extension';
  const affectedBy = (object: string): string[] =>
    report.affected.filter(n => n.object === object).map(n => n.dependency);

  it('a wrapper of such a method: the wrapper now wraps the inherited one and the dependency logic is gone (behaviour)', () => {
    for (const method of ['update', 'doUpdate', 'validateWrite']) {
      expect(find(`${ext}.${method}`)).toMatchObject([
        { kind: 'override-dropped', level: 'behaviour', dependency: `ContosoDepTable.${method}` },
      ]);
    }
    expect(find(`${ext}.update`)[0].after).toContain('inherited from Common');
  });

  it('a plain call is no finding at any level, only listed as affected by the change', () => {
    for (const [object, method] of [
      ['ContosoUser.callKernel', 'update'],
      ['ContosoUser.callDirect', 'doUpdate'],
      ['ContosoUser.callValidate', 'validateWrite'],
    ]) {
      expect(find(object)).toEqual([]);
      expect(affectedBy(object)).toEqual([`ContosoDepTable.${method}`]);
    }
    expect(find('ContosoUser.callInherited')).toEqual([]);
    expect(affectedBy('ContosoUser.callInherited')).toEqual(['ContosoChild.shared']);
  });

  it('is a fact about the dependency: listed with where the method comes from now', () => {
    expect(report.overridesDropped).toEqual(
      expect.arrayContaining([
        { type: 'ContosoDepTable', method: 'update', inheritedFrom: 'Common' },
        { type: 'ContosoChild', method: 'shared', inheritedFrom: 'ContosoParent' },
      ]),
    );
    const md = renderImpactMarkdown(report);
    expect(md).toContain('`ContosoDepTable.update` — now inherited from `Common`');
    expect(md).toContain('used by `ContosoDepTable_Contoso_Extension.update`');
    expect(md).toContain('### Affected by a change in the dependency, no action implied');
  });

  it('with an incompatible signature on the base, the call breaks', () => {
    expect(find('ContosoUser.callIncompatibleBase')).toMatchObject([{ kind: 'param-type', level: 'error' }]);
  });

  it('gone from the whole hierarchy: an error (a table method that Common does not declare, a method only the child had)', () => {
    expect(find('ContosoUser.callCustom')).toMatchObject([{ kind: 'method-removed', level: 'error' }]);
    expect(find('ContosoUser.callChildOnly')).toMatchObject([{ kind: 'method-removed', level: 'error' }]);
  });

  it('a hierarchy with an ancestor outside the compared metadata proves nothing: affected, not an error', () => {
    expect(find('ContosoUser.callDangling')).toEqual([]);
    expect(report.affected.find(n => n.object === 'ContosoUser.callDangling')?.message).toContain('ContosoMissingBase');
  });

  it('a wrapper of a method that left the whole hierarchy is an error', () => {
    expect(find('ContosoLib_Contoso_Extension.gone')).toMatchObject([{ kind: 'coc-method-removed', level: 'error' }]);
  });
});

describe('overriding', () => {
  it('a base method that became final', () => {
    expect(find('ContosoSub.overridable')).toMatchObject([{ kind: 'override-final', level: 'error' }]);
  });

  it('a base method that was removed leaves an override that is never called', () => {
    expect(find('ContosoSub.orphan')).toMatchObject([{ kind: 'override-orphaned', level: 'behaviour' }]);
  });

  it('a base method whose parameters changed', () => {
    expect(find('ContosoSub.sig')).toMatchObject([
      { kind: 'override-signature', level: 'error', fix: 'public void sig(str _x)' },
    ]);
  });
});

describe('report', () => {
  it('counts by level and says how much of our code was placed against the dependency', () => {
    const t = report.totals;
    expect(t.error + t.behaviour + t.warning).toBe(report.findings.length);
    expect(t.behaviour).toBeGreaterThan(0);
    expect(report.checked.calls).toBeGreaterThan(0);
    expect(report.checked.cocWrappers).toBe(9);
    expect(report.checked.handlers).toBe(5);
  });

  it('lists dependencies present in only one version instead of reporting them as removed', () => {
    const r = analyzeImpact({
      from: 'old',
      to: 'new',
      fromDeps: deps('old'),
      toDeps: deps('new'),
      ours: [ours()],
      notCompared: { onlyInFrom: [], onlyInTo: ['ContosoOther'] },
    });
    const md = renderImpactMarkdown(r);
    expect(md).toContain('only in new: ContosoOther');
    expect(md).toContain('## What changed in the dependencies');
    expect(md).toContain('### Will not compile');
    expect(md).toContain('### Compiles, behaves differently');
    expect(md).toContain('- fix: public void wrapped(int _a, str _b)');
  });
});

describe('source scanning', () => {
  it('types variables and parameters, blanks comments and strings, counts arguments', () => {
    const clean = stripSource(
      'void f(ContosoLib _p)\n{\n    // l.removed();\n    ContosoLib l;\n    l.addedRequired(1, "a,b", g(2, 3));\n    _p.process(x);\n}',
    );
    const calls = scanCalls(clean, variableTypes(clean, undefined));
    expect(calls.map(c => `${c.type}.${c.member}/${c.argc}@${c.line}`)).toEqual([
      'ContosoLib.addedRequired/3@5',
      'ContosoLib.process/1@6',
    ]);
  });
});

describe('reference layer (validate_code references, old index against new)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'upgrade-impact-'));
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const writeClass = (dir: string, model: string, cls: RawClass): void => {
    fs.mkdirSync(path.join(dir, model, 'classes'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, model, 'classes', `${cls.name}.json`),
      JSON.stringify({ ...cls, type: 'class', model }),
    );
  };
  const staticMethod = (name: string, params: string[] = []): RawMethod => ({
    ...m(name, params),
    isStatic: true,
    source: '',
  });

  it('reports a static member removed from a class that existed, and nothing it never had', async () => {
    const oldDir = path.join(tmp, 'old');
    const newDir = path.join(tmp, 'new');
    writeClass(oldDir, 'ContosoDep', lib([staticMethod('create'), staticMethod('keep')]));
    writeClass(newDir, 'ContosoDep', lib([staticMethod('keep')]));
    // A class that appears only in the new version: our code naming a member it lacks is another question.
    writeClass(newDir, 'ContosoDep', { name: 'ContosoNewcomer', model: 'ContosoDep', methods: [] });

    const body = src(
      'public void run()',
      '    ContosoLib::create();\n    ContosoLib::keep();\n    ContosoLib::neverExisted();\n    ContosoNewcomer::missing();',
    );
    const user: ModelSnapshot = {
      model: 'ContosoApp',
      classes: [ourClass('ContosoRunner', [['run', body]])],
      tables: [],
      edts: [],
      enums: [],
    };
    const oldIndex = new XppSymbolIndex(':memory:', ':memory:');
    const newIndex = new XppSymbolIndex(':memory:', ':memory:');
    await oldIndex.indexMetadataDirectory(oldDir, ['ContosoDep']);
    await newIndex.indexMetadataDirectory(newDir, ['ContosoDep']);
    const before = buildDependencyIndex([
      {
        model: 'ContosoDep',
        classes: [lib([staticMethod('create'), staticMethod('keep')])],
        tables: [],
        edts: [],
        enums: [],
      },
    ]);

    const found = referenceFindings([user], oldIndex, newIndex, n => hasName(before, n));
    expect(found.map(f => `${f.kind}:${f.dependency}`)).toEqual(['reference:unknown-static-member:ContosoLib::create']);
    expect(found[0]).toMatchObject({ level: 'error', object: 'ContosoRunner.run', file: 'AxClass/ContosoRunner.xml' });

    const merged = mergeFindings({ ...report, findings: [], totals: { error: 0, behaviour: 0, warning: 0 } }, found);
    expect(merged.totals.error).toBe(1);
    oldIndex.close?.();
    newIndex.close?.();
  });
});

describe('a model without method bodies (binary ISV)', () => {
  const noSource = (name: string, params: Array<[string, string]> = [], over: Partial<RawMethod> = {}): RawMethod => ({
    name,
    visibility: 'public',
    returnType: 'void',
    isStatic: false,
    parameters: params.map(([type, pname]) => ({ type, name: pname })),
    ...over,
  });
  const binary: ModelSnapshot = {
    model: 'ContosoBinary',
    classes: [
      {
        name: 'ContosoBinaryWrap_Extension',
        model: 'ContosoBinary',
        extensionOf: { baseObjectName: 'ContosoLib', baseKind: 'class' },
        chainOfCommand: { target: 'ContosoLib', wrapped: ['wrapped'] },
        methods: [noSource('wrapped', [['int', '_a']]), noSource('process', [['Name', '_name']])],
      },
      {
        name: 'ContosoBinarySub',
        model: 'ContosoBinary',
        extends: 'ContosoLib',
        methods: [noSource('overridable'), noSource('sig', [['int', '_x']])],
      },
      { name: 'ContosoBinaryChild', model: 'ContosoBinary', extends: 'ContosoRemovedClass', methods: [] },
    ],
    tables: [
      {
        name: 'ContosoBinaryTable',
        fields: [
          { name: 'Code', type: 'String', extendedDataType: 'ContosoDepEdt' },
          { name: 'Mode', type: 'Enum', enumType: 'ContosoDepEnum' },
        ],
      },
    ],
    edts: [],
    enums: [],
  };
  const r = analyzeImpact({
    from: 'old',
    to: 'new',
    fromDeps: deps('old'),
    toDeps: deps('new'),
    ours: [binary],
  });
  const kinds = (object: string): string[] =>
    r.findings.filter(f => f.object === object).map(f => `${f.level}:${f.kind}`);

  it('takes the wrapped methods from the compiler record and checks the signature they must repeat', () => {
    expect(kinds('ContosoBinaryWrap_Extension.wrapped')).toEqual(['error:coc-signature']);
    expect(kinds('ContosoBinaryWrap_Extension.process')).toEqual([]);
  });

  it('checks overrides from signatures alone', () => {
    expect(kinds('ContosoBinarySub.overridable')).toEqual(['error:override-final']);
    expect(kinds('ContosoBinarySub.sig')).toEqual(['error:override-signature']);
  });

  it('checks inheritance and the EDT of a field without any body', () => {
    expect(kinds('ContosoBinaryChild')).toEqual(['error:type-removed']);
    expect(kinds('ContosoBinaryTable')).toEqual(['behaviour:edt-changed']);
  });

  it('says in the report that calls inside such a model are not visible', () => {
    expect(r.checked.modelsWithoutBodies).toEqual(['ContosoBinary']);
    expect(r.checked.methodsWithoutBodies).toBe(r.checked.ourMethods);
    const md = renderImpactMarkdown(r);
    expect(md).toContain('Coverage limit');
    expect(md).toContain('ContosoBinary has no method bodies');
  });
});

describe('selected models in the report', () => {
  it('lists what each mask selected on each side and what only one side has', () => {
    const md = renderImpactMarkdown({
      ...report,
      selection: {
        models: 'Contoso*,!ContosoDemo*',
        deps: 'Fabrikam*',
        depsSides: {
          from: ['FabrikamCore', 'FabrikamOld'],
          to: ['FabrikamCore', 'FabrikamNew'],
          both: ['FabrikamCore'],
          onlyInFrom: ['FabrikamOld'],
          onlyInTo: ['FabrikamNew'],
        },
      },
    });
    expect(md).toContain('## Selected models');
    expect(md).toContain('`--models Contoso*,!ContosoDemo*`');
    expect(md).toContain('`--deps Fabrikam*`: 2 in old, 2 in new, 1 compared');
    expect(md).toContain('only in old (not compared): FabrikamOld');
    expect(md).toContain('only in new (not compared): FabrikamNew');
  });

  it('prints the run time when the caller measured it', () => {
    expect(renderImpactMarkdown({ ...report, timings: { 'slice from': 1.234, analysis: 0.5 } })).toContain(
      '_Run time: slice from 1.2 s, analysis 0.5 s._',
    );
  });
});
