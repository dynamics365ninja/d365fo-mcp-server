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
 * Two answers beyond the question: `methodStr` does not accept a table
 * ("does not specify a known class"; use `tableMethodStr`), and `staticMethodStr`
 * naming an instance method fails ("must specify a static method"). The resolver
 * does not check the member of `tableMethodStr`, `tableStaticMethodStr`,
 * `delegateStr`, `indexStr`, `tableFieldGroupStr` or the `form*Str` intrinsics
 * yet; each of them would be an error-severity check by this evidence.
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
];

export default probes;
