/**
 * Probe batch — does xppc check the SECOND argument of a two-argument intrinsic?
 *
 * `validate_code(mode="references")` reports `fieldStr(T, missing)` and
 * `methodStr(C, missing)` as errors on the premise that intrinsic arguments are
 * compile-time checked. #1270 doubted it: in the first extension-target batch,
 * `methodStr(AssetProposal, conProbeNoSuchMethod)` compiled without a word. This
 * batch asks the question of every two-argument intrinsic, each next to a
 * control whose FIRST argument is unknown (which must fail, proving the
 * intrinsic is compiled at all).
 *
 * Answer (2026-11-12): all 13 FAIL on a missing member, so the premise holds and
 * the resolver's errors stand. The #1270 observation was an artifact: another
 * probe in that batch was a CoC extension class that DECLARED
 * `conProbeNoSuchMethod`, which adds the method to AssetProposal for the whole
 * build. Give every "missing" name in a batch its own spelling.
 *
 * The later rows answered what the member check in src/tools/write/intrinsicMembers.ts
 * enforces, all FAILS: the member must be declared on the NAMED type (inherited
 * methods and delegates, and kernel table methods the table does not override,
 * are "does not exist"); `methodStr` takes neither a table nor a form; static vs
 * instance must match the intrinsic; `delegateStr` rejects an ordinary method.
 * Tables have no kernel data-event delegates: `delegateStr(CustTable, onInserted)`
 * fails too.
 *
 * Targets: AssetProposal (class, declares canGoBatch), CustTable (table, field
 * AccountNum, method validateWrite, static find, field group AutoReport, index
 * AccountIdx), the CustTable form (data source CustTable).
 *
 * Run:  npm run oracle:probe -- --file scripts/oracles/probes/intrinsic-members.ts \
 *         --json .oracle-probe-intrinsic-members.json
 */
import type { Probe } from '../xppcProbe.js';

/** One statement assigning the intrinsic to a variable of the right type. */
function probe(id: string, question: string, expr: string, type: 'str' | 'int', expect?: Probe['expect']): Probe {
  return { id, question, body: `${type} value = ${expr};`, expect };
}

const MISSING = 'conProbeNoSuchMember';

const probes: Probe[] = [
  // ── Controls: the first argument IS checked ───────────────────────────────
  probe('CtlMethodStrClass', 'CONTROL — methodStr with an unknown class', `methodStr(ConProbeNoSuchClass, run)`, 'str', 'fails'),
  probe('CtlFieldStrTable', 'CONTROL — fieldStr with an unknown table', `fieldStr(ConProbeNoSuchTable, RecId)`, 'str', 'fails'),

  // ── Positive controls: real members compile ───────────────────────────────
  probe('OkMethodStr', 'methodStr of a declared method', 'methodStr(AssetProposal, canGoBatch)', 'str', 'compiles'),
  probe('OkFieldStr', 'fieldStr of a real field', 'fieldStr(CustTable, AccountNum)', 'str', 'compiles'),

  // ── The question: is the member checked? ─────────────────────────────────
  probe('MethodStr', 'methodStr(class, missing method)', `methodStr(AssetProposal, ${MISSING})`, 'str'),
  probe('MethodStrTable', 'methodStr(table, missing method)', `methodStr(CustTable, ${MISSING})`, 'str'),
  probe('StaticMethodStr', 'staticMethodStr(class, missing method)', `staticMethodStr(AssetProposal, ${MISSING})`, 'str'),
  probe('StaticMethodStrInstance', 'staticMethodStr naming an INSTANCE method', 'staticMethodStr(AssetProposal, canGoBatch)', 'str'),
  probe('TableMethodStr', 'tableMethodStr(table, missing method)', `tableMethodStr(CustTable, ${MISSING})`, 'str'),
  probe('TableStaticMethodStr', 'tableStaticMethodStr(table, missing method)', `tableStaticMethodStr(CustTable, ${MISSING})`, 'str'),
  probe('FieldStr', 'fieldStr(table, missing field)', `fieldStr(CustTable, ${MISSING})`, 'str'),
  probe('FieldNum', 'fieldNum(table, missing field)', `fieldNum(CustTable, ${MISSING})`, 'int'),
  probe('TableFieldGroupStr', 'tableFieldGroupStr(table, missing group)', `tableFieldGroupStr(CustTable, ${MISSING})`, 'str'),
  probe('IndexStr', 'indexStr(table, missing index)', `indexStr(CustTable, ${MISSING})`, 'str'),
  probe('DelegateStr', 'delegateStr(class, missing delegate) in a method body', `delegateStr(AssetProposal, ${MISSING})`, 'str'),
  probe('FormDataSourceStr', 'formDataSourceStr(form, missing data source)', `formDataSourceStr(CustTable, ${MISSING})`, 'str'),
  probe('FormControlStr', 'formControlStr(form, missing control)', `formControlStr(CustTable, ${MISSING})`, 'str'),
  probe('FormMethodStr', 'formMethodStr(form, missing method)', `formMethodStr(CustTable, ${MISSING})`, 'str'),

  // ── Members that exist, but of the wrong kind or only in the kernel ───────
  probe('MethodStrTableReal', 'methodStr(table, a method the table declares)', 'methodStr(CustTable, validateWrite)', 'str'),
  probe('MethodStrStatic', 'methodStr naming a STATIC class method', 'methodStr(AssetProposal, construct)', 'str'),
  probe('TableMethodStrKernel', 'tableMethodStr naming a kernel method the table does not declare (postLoad)',
    'tableMethodStr(CustTable, postLoad)', 'str'),
  probe('TableMethodStrStatic', 'tableMethodStr naming a STATIC table method (find)', 'tableMethodStr(CustTable, find)', 'str'),
  probe('TableStaticMethodStrInstance', 'tableStaticMethodStr naming an INSTANCE table method',
    'tableStaticMethodStr(CustTable, validateWrite)', 'str'),
  probe('TableMethodStrInherited', 'tableMethodStr naming a method only RunBaseBatch declares, through a class (wrong kind)',
    'tableMethodStr(AssetProposal, allowSaveLast)', 'str'),
  probe('DelegateStrOrdinary', 'delegateStr naming an ordinary method, in a method body', 'delegateStr(AssetProposal, canGoBatch)', 'str'),
  probe('DelegateStrOfStatic', 'delegateStr naming a STATIC delegate, in a method body',
    'delegateStr(AssetProposal, assetProposalCreating)', 'str'),
  probe('StaticDelegateStrOk', 'staticDelegateStr naming a static delegate, in a method body',
    'staticDelegateStr(AssetProposal, assetProposalCreating)', 'str', 'compiles'),
  probe('DelegateStrInherited', 'delegateStr naming an instance delegate only the base class (SalesFormLetter) declares',
    'delegateStr(SalesFormLetter_Invoice, getUpdateNowQtyDelegate)', 'str'),
  probe('StaticDelegateStrInstance', 'staticDelegateStr naming an INSTANCE delegate',
    'staticDelegateStr(SalesFormLetter, getUpdateNowQtyDelegate)', 'str'),
  probe('MethodStrForm', 'methodStr(form, a method the form declares) — SalesCreateOrder is only a form',
    'methodStr(SalesCreateOrder, changeType)', 'str'),
  probe('FormMethodStrReal', 'formMethodStr(form, a method the form declares)', 'formMethodStr(SalesCreateOrder, changeType)', 'str', 'compiles'),
  probe('MethodStrInherited', 'methodStr naming a method only the base class (RunBaseBatch) declares',
    'methodStr(AssetProposal, allowSaveLast)', 'str'),
  probe('StaticMethodStrInherited', 'staticMethodStr naming a static method only the base class (AssetProposal) declares',
    'staticMethodStr(AssetProposalDepreciation, construct)', 'str'),

  // ── Tables have kernel data-event delegates that no table XML declares ────
  probe('TableKernelDelegateBody', 'delegateStr(table, onInserted) — a kernel data-event delegate, in a body',
    'delegateStr(CustTable, onInserted)', 'str'),
  {
    id: 'TableKernelDelegateAttr',
    question: '[SubscribesTo(tableStr(CustTable), delegateStr(CustTable, onInserted))] handler',
    methods: [
      '[SubscribesTo(tableStr(CustTable), delegateStr(CustTable, onInserted))]\n' +
      '    public static void onCustInserted(Common _sender, DataEventArgs _e)\n    {\n    }',
    ],
  },
  probe('TableKernelDelegateMissing', 'delegateStr(table, a name that is no kernel delegate either)',
    'delegateStr(CustTable, onConProbeNoSuchEvent)', 'str'),
];

export default probes;
