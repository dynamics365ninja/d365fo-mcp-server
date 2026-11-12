/**
 * Probe batch — what the compiler rejects about an extension's TARGET.
 *
 * `validate_code(mode="references")` proves that names exist. It did not look at
 * what a Chain of Command wrapper or an event handler binds to: the wrapped
 * method, the delegate, the method a pre/post handler names, or an obsolete
 * method a call reaches. These are the things an ISV or platform update breaks
 * in code that compiled yesterday (#1225), and the things an agent most often
 * gets wrong when it writes a wrapper from memory.
 *
 * Every rule the resolver reports as an ERROR must be one of the FAILS below.
 * The COMPILES rows are the false positives a rule must not have: a wrapper
 * whose parameter NAME differs, a wrapper of a method only the base class
 * declares, a `final` method opened with `[Wrappable(true)]`, a parameter typed
 * with the base EDT (only a warning), a kernel table method the table does not
 * declare.
 *
 * Two answers the first run gave were not the expected ones, and each changed
 * a rule:
 *  - `[Wrappable(false)]` on a protected method does NOT stop a wrapper from
 *    compiling, while `final` (reported as "Wrappable = false") and
 *    `[Hookable(false)]` do. The attribute alone is not an error rule.
 *  - A static delegate must be named with `staticDelegateStr`; `delegateStr` on
 *    it fails ("must not specify an instance delegate").
 *
 * A third one was this batch fooling itself, and it is why every "missing"
 * member below has its OWN name. The first run reused `conProbeNoSuchMethod` for
 * `CocMissing`, `HdlPostMissing` and `MethodStrMissing`. `CocMissing`'s extension
 * class DECLARES that method, and an extension class adds its methods to the
 * augmented class, so in the same build `methodStr(AssetProposal,
 * conProbeNoSuchMethod)` named a real method and compiled. That "xppc does not
 * check methodStr's member" was filed as #1270 and refuted there by
 * probes/intrinsic-members.ts: every two-argument intrinsic checks it.
 *
 * Targets are shipped Microsoft classes in ApplicationSuite / ApplicationPlatform:
 *   AssetProposal (extends RunBaseBatch) — canGoBatch, isBundleReady(int),
 *     initFirstDate(AssetTransDate, AssetId), private getJournalLink,
 *     protected [Wrappable(false)] outputJournalCreatedMessageOnCreate,
 *     static construct(AssetTransType), static delegate
 *     assetProposalCreating(AssetTransType, EventHandlerResult);
 *     allowSaveLast is declared only on RunBaseBatch.
 *   RunBaseMultiParm.runOnServer — `public final`, no Wrappable attribute.
 *   AssetPost.createTrueUpDepreciation — `final protected`, [Wrappable(true)].
 *   InterCompanyRetailOrderExtensionResult.IsChannelOverridden — public [Wrappable(false)].
 *   AbstractNettingProcessor.process — [Hookable(false)] only.
 *   CustTable — declares validateWrite, not postLoad.
 *   AssetDepScheduleContract_IN.parmBookType — [SysObsolete(..., true)].
 *   AssetDepreciableAssetsDP_JP.summariseAcquiredConsumedAmountByType —
 *     [SysObsolete(..., false)].
 *
 * Run:  npm run oracle:probe -- --file scripts/oracles/probes/extension-targets.ts \
 *         --json .oracle-probe-extension-targets.json
 */
import type { Probe } from '../xppcProbe.js';

/** A CoC extension class of `target` (`classStr` or `tableStr`) holding the given wrappers. */
function coc(
  id: string,
  target: string,
  question: string,
  methods: string[],
  expect: Probe['expect'],
  kind: 'class' | 'table' = 'class',
): Probe {
  return {
    id,
    question,
    declaration: `[ExtensionOf(${kind}Str(${target}))]\nfinal class ConProbe${id}_Extension`,
    methods,
    expect,
  };
}

/** A plain class holding one static event handler. */
function handler(id: string, question: string, method: string, expect: Probe['expect']): Probe {
  return { id, question, methods: [method], expect };
}

/** `public <ret> <name>(<params>) { [return] next <name>(<args>); }` */
function wrapper(modifiers: string, ret: string, name: string, params = '', args = ''): string {
  const call = `next ${name}(${args})`;
  const body = ret === 'void' ? `${call};` : `return ${call};`;
  return `${modifiers} ${ret} ${name}(${params})\n    {\n        ${body}\n    }`;
}

/** A static handler whose attribute line is `attribute`. */
function handlerMethod(attribute: string, name: string, params: string): string {
  return `${attribute}\n    public static void ${name}(${params})\n    {\n    }`;
}

const CREATING = 'AssetTransType _assetTransType, EventHandlerResult _result';

const probes: Probe[] = [
  // ── Chain of Command: the wrapped method must exist and be wrappable ───────
  coc('CocControl', 'AssetProposal', 'CONTROL — wrapping a public method the class declares',
    [wrapper('public', 'boolean', 'canGoBatch')], 'compiles'),
  coc('CocMissing', 'AssetProposal', 'wrapping a method the class does not have',
    [wrapper('public', 'void', 'conProbeNoSuchMethod')], 'fails'),
  coc('CocInherited', 'AssetProposal', 'wrapping a method only the base class (RunBaseBatch) declares',
    [wrapper('public', 'boolean', 'allowSaveLast')], 'compiles'),
  coc('CocPrivate', 'AssetProposal', 'wrapping a private method',
    [wrapper('private', 'AssetProposalJournalLink', 'getJournalLink')], 'fails'),
  coc('CocFinal', 'RunBaseMultiParm', 'wrapping a final method without [Wrappable(true)]',
    [wrapper('public', 'void', 'runOnServer')], 'fails'),
  coc('CocFinalWrappable', 'AssetPost', 'wrapping a final method that carries [Wrappable(true)]',
    [wrapper('protected', 'boolean', 'createTrueUpDepreciation', 'AssetBook _assetBook', '_assetBook')], 'compiles'),
  coc('CocWrapFalse', 'AssetProposalDepreciation', 'wrapping a protected [Wrappable(false)] method (override)',
    [wrapper('protected', 'boolean', 'outputJournalCreatedMessageOnCreate')], 'compiles'),
  coc('CocWrapFalseBase', 'AssetProposal', 'wrapping the protected [Wrappable(false)] method on the class that first declares it',
    [wrapper('protected', 'boolean', 'outputJournalCreatedMessageOnCreate')], undefined),
  coc('CocWrapFalsePublic', 'InterCompanyRetailOrderExtensionResult', 'wrapping a public [Wrappable(false)] method',
    [wrapper('public', 'boolean', 'IsChannelOverridden')], undefined),
  coc('CocHookFalse', 'AbstractNettingProcessor', 'wrapping a [Hookable(false)] method (no Wrappable attribute)',
    [wrapper('public', 'void', 'process')], 'fails'),

  // ── Chain of Command on a table: kernel methods need no declaration ───────
  coc('CocTableKernel', 'CustTable', 'wrapping postLoad, which CustTable does not declare (kernel Common method)',
    [wrapper('public', 'void', 'postLoad')], 'compiles', 'table'),
  coc('CocTableMissing', 'CustTable', 'wrapping a method the table does not have',
    [wrapper('public', 'void', 'conProbeNoSuchMethod')], 'fails', 'table'),
  coc('CocTableArity', 'CustTable', 'wrapper of validateWrite() that adds a parameter',
    [wrapper('public', 'boolean', 'validateWrite', 'boolean _extra', '_extra')], 'fails', 'table'),
  coc('CocTableKernelArity', 'CustTable', 'wrapper of the kernel postLoad() that adds a parameter',
    [wrapper('public', 'void', 'postLoad', 'boolean _extra', '_extra')], undefined, 'table'),

  // ── Chain of Command: the wrapper must repeat the signature ────────────────
  coc('CocArity', 'AssetProposal', 'wrapper drops the parameter of isBundleReady(int)',
    [wrapper('public', 'boolean', 'isBundleReady')], 'fails'),
  coc('CocParamType', 'AssetProposal', 'wrapper declares str where the base has int',
    [wrapper('public', 'boolean', 'isBundleReady', 'str _bookCount', '_bookCount')], 'fails'),
  coc('CocParamName', 'AssetProposal', 'wrapper renames the parameter (same type)',
    [wrapper('public', 'boolean', 'isBundleReady', 'int _count', '_count')], 'compiles'),
  coc('CocParamEdtBase', 'AssetProposal', 'wrapper spells the AssetTransDate parameter as TransDate (its base EDT)',
    [wrapper('public', 'AssetTransDate', 'initFirstDate', 'TransDate _assetTransDate, AssetId _assetId', '_assetTransDate, _assetId')],
    'compiles'),
  coc('CocParamUnrelatedEdt', 'AssetProposal', 'wrapper types the AssetId parameter as CustAccount (an unrelated str EDT)',
    [wrapper('public', 'AssetTransDate', 'initFirstDate', 'AssetTransDate _assetTransDate, CustAccount _assetId', '_assetTransDate, _assetId')],
    undefined),
  coc('CocParamCase', 'AssetProposal', 'wrapper spells the parameter type in another case (assettransdate)',
    [wrapper('public', 'AssetTransDate', 'initFirstDate', 'assettransdate _assetTransDate, AssetId _assetId', '_assetTransDate, _assetId')],
    'compiles'),
  coc('CocReturnType', 'AssetProposal', 'wrapper returns int where the base returns boolean', [
    'public int isBundleReady(int _bookCount)\n    {\n        next isBundleReady(_bookCount);\n        return 0;\n    }',
  ], 'fails'),
  coc('CocStaticMismatch', 'AssetProposal', 'instance wrapper of the static construct()',
    [wrapper('public', 'AssetProposal', 'construct', 'AssetTransType _assetTransType', '_assetTransType')], 'fails'),
  coc('CocStaticOk', 'AssetProposal', 'static wrapper of the static construct()',
    [wrapper('public static', 'AssetProposal', 'construct', 'AssetTransType _assetTransType', '_assetTransType')], 'compiles'),

  // ── Event handlers: the delegate / method they subscribe to ───────────────
  handler('HdlControl', 'CONTROL — [SubscribesTo] a real static delegate with its exact parameters',
    handlerMethod('[SubscribesTo(classStr(AssetProposal), staticDelegateStr(AssetProposal, assetProposalCreating))]',
      'onCreating', CREATING), 'compiles'),
  handler('HdlStaticAsInstance', '[SubscribesTo] a static delegate through delegateStr',
    handlerMethod('[SubscribesTo(classStr(AssetProposal), delegateStr(AssetProposal, assetProposalCreating))]',
      'onCreatingInstance', CREATING), 'fails'),
  handler('HdlNoStaticDelegate', '[SubscribesTo] a static delegate the class does not declare',
    handlerMethod('[SubscribesTo(classStr(AssetProposal), staticDelegateStr(AssetProposal, conProbeNoSuchDelegate))]',
      'onNothingStatic', CREATING), 'fails'),
  handler('HdlNoDelegate', '[SubscribesTo] a delegate the class does not declare',
    handlerMethod('[SubscribesTo(classStr(AssetProposal), delegateStr(AssetProposal, conProbeNoSuchDelegate))]',
      'onNothing', CREATING), 'fails'),
  handler('HdlNotDelegate', '[SubscribesTo] names an ordinary method, not a delegate',
    handlerMethod('[SubscribesTo(classStr(AssetProposal), delegateStr(AssetProposal, canGoBatch))]',
      'onCanGoBatch', ''), 'fails'),
  handler('HdlArity', '[SubscribesTo] handler with one parameter fewer than the delegate',
    handlerMethod('[SubscribesTo(classStr(AssetProposal), staticDelegateStr(AssetProposal, assetProposalCreating))]',
      'onCreatingShort', 'AssetTransType _assetTransType'), 'fails'),
  handler('HdlParamType', '[SubscribesTo] handler with a different parameter type',
    handlerMethod('[SubscribesTo(classStr(AssetProposal), staticDelegateStr(AssetProposal, assetProposalCreating))]',
      'onCreatingType', 'int _assetTransType, EventHandlerResult _result'), 'fails'),
  handler('HdlPostControl', 'CONTROL — [PostHandlerFor] an ordinary public method',
    handlerMethod('[PostHandlerFor(classStr(AssetProposal), methodStr(AssetProposal, canGoBatch))]',
      'postCanGoBatch', 'XppPrePostArgs _args'), 'compiles'),
  handler('HdlPostHookFalse', '[PostHandlerFor] a [Hookable(false)] method',
    handlerMethod('[PostHandlerFor(classStr(AbstractNettingProcessor), methodStr(AbstractNettingProcessor, process))]',
      'postProcess', 'XppPrePostArgs _args'), 'fails'),
  handler('HdlPostPrivate', '[PostHandlerFor] a private method',
    handlerMethod('[PostHandlerFor(classStr(AssetProposal), methodStr(AssetProposal, getJournalLink))]',
      'postGetJournalLink', 'XppPrePostArgs _args'), 'fails'),
  handler('HdlPostMissing', '[PostHandlerFor] a method the class does not have',
    handlerMethod('[PostHandlerFor(classStr(AssetProposal), methodStr(AssetProposal, conProbeNoSuchPostTarget))]',
      'postMissing', 'XppPrePostArgs _args'), 'fails'),
  {
    id: 'MethodStrMissing',
    question: 'methodStr() naming a method the class does not have, in a method body',
    body: 'str name = methodStr(AssetProposal, conProbeNoSuchMethodStrTarget);',
    expect: 'fails',
  },
  {
    id: 'MethodStrExtensionAdded',
    question: 'methodStr() naming the method CocMissing\'s extension class adds to AssetProposal',
    body: 'str name = methodStr(AssetProposal, conProbeNoSuchMethod);',
    expect: 'compiles',
  },

  // ── [SysObsolete]: the error flag is what turns a call into a build error ──
  {
    id: 'ObsoleteError',
    question: 'calling a method marked [SysObsolete(..., true)]',
    locals: 'AssetDepScheduleContract_IN contract = new AssetDepScheduleContract_IN();',
    body: 'contract.parmBookType();',
    expect: 'fails',
  },
  {
    id: 'ObsoleteWarning',
    question: 'calling a method marked [SysObsolete(..., false)]',
    locals: 'AssetDepreciableAssetsDP_JP dp;',
    body: 'dp.summariseAcquiredConsumedAmountByType(0, true);',
    expect: 'compiles',
  },
];

export default probes;
