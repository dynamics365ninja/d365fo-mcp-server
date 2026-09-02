/**
 * Probe batch v4e — pin the signatures v4d corrected.
 *
 * v4d asked whether members exist. Five answers were "not in the shape you
 * asked", and a catalog written from "it failed" would simply omit them — which
 * is how a fallback that exists to stop people inventing signatures ends up
 * hiding real methods. Each probe here re-asks in the shape the compiler named:
 *
 *   data()                 → NOT a container; the diagnostic says the value is a
 *                            `CustGroup`, i.e. a buffer of the same table.
 *   setData                → does not exist on a table at all.
 *   isFieldDataRetrieved   → argument 1 is `str`, not a FieldId.
 *   getSQLStatements       → does not exist on a table buffer.
 *   modifiedFieldValue     → IS wrappable, but as
 *                            `(FieldName _fieldName, int _value)` — a field NAME
 *                            and an int, not `(FieldId, anytype)`. Worth pinning
 *                            precisely: it is the twin of `modifiedField`, which
 *                            really does take a FieldId, so the pair is a trap.
 *
 * Also here: the arity questions v4d could not settle, because a call that
 * compiles with one argument says nothing about whether zero also compiles.
 *
 * Run:  npm run oracle:probe -- --file scripts/oracles/probes/coverage-v4e.ts \
 *         --json .oracle-probe-v4e.json
 */
import type { Probe } from '../xppcProbe.js';

const T = 'CustGroup';

const call = (id: string, question: string, body: string, expect: Probe['expect'] = 'compiles'): Probe => ({
  id, question, locals: `${T} buf;`, body, expect,
});

const probes: Probe[] = [
  {
    id: 'DataReturnsBuffer',
    question: 'v4e — data() returns a BUFFER of the same table, not a container',
    locals: `${T} buf;\n        ${T} copy;`,
    body: 'copy.data(buf.data());',
    expect: 'compiles',
  },
  call('DataAssignToBuffer', 'v4e — the common idiom: one buffer takes the data of another',
    `${T} copy;\n        copy = buf.data();`),
  call('IsFieldDataRetrievedStr', 'v4e — isFieldDataRetrieved takes a field NAME (str)',
    `boolean b = buf.isFieldDataRetrieved(fieldStr(${T}, CustGroup));`),
  call('CanSubmitNoArgs', 'v4e — canSubmitToWorkflow() with NO argument: is the str optional?',
    'boolean b = buf.canSubmitToWorkflow();'),
  call('FieldStateReturnsEnum', 'v4e — what fieldState(fieldId) returns: an int accepted it, does the '
    + 'FieldState enum too?',
    `FieldState s = buf.fieldState(fieldNum(${T}, CustGroup));`),
  call('CheckRecordArity', 'v4e — checkRecord() with an argument: does the boolean form exist?',
    'boolean b = buf.checkRecord(true);'),

  {
    id: 'WrapModifiedFieldValueCorrected',
    question: 'v4e — modifiedFieldValue wrapped with the signature the compiler named: (FieldName, int)',
    declaration: `[ExtensionOf(tableStr(${T}))]\nfinal class ConProbeWrapModifiedFieldValueCorrected_Extension`,
    methods: [
      `    public void modifiedFieldValue(FieldName _fieldName, int _value)
    {
        next modifiedFieldValue(_fieldName, _value);
    }`,
    ],
    expect: 'compiles',
  },
  {
    id: 'WrapModifiedFieldBaseline',
    question: 'v4e — modifiedField(FieldId) for contrast: the twin DOES take a FieldId, which is what '
      + 'makes the pair a trap',
    declaration: `[ExtensionOf(tableStr(${T}))]\nfinal class ConProbeWrapModifiedFieldBaseline_Extension`,
    methods: [
      `    public void modifiedField(FieldId _fieldId)
    {
        next modifiedField(_fieldId);
    }`,
    ],
    expect: 'compiles',
  },
];

export default probes;
