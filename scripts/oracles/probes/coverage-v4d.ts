/**
 * Probe batch v4d — the kernel buffer API and the overridable table methods.
 *
 * `xRecord` and `Common` have no AOT XML, so `oracle:members` answers NOT FOUND
 * for both and the symbol index has no row for a table's `validateWrite` — the
 * single most-asked X++ question in the usage data. `src/knowledge/tableDataMethods.ts`
 * is the fallback that answers it, and today it carries **8 methods**, hand-typed.
 * This batch is what lets it carry the rest without inventing a signature.
 *
 * Two families, because the two questions need different probes:
 *
 *  A. **Buffer API** — public members, probed by CALLING them. Existence and
 *     argument shape in one go.
 *  B. **Overridable table methods** — probed by writing the CoC wrapper the
 *     knowledge entry will recommend. This is stronger than calling: a wrapper
 *     whose signature disagrees with the base is rejected outright, so a probe
 *     that compiles has verified the exact declaration a caller must match. It is
 *     also the real use case, and several of these methods are protected and
 *     cannot be called from outside at all.
 *
 * Reading the failures matters as much as the passes. A method that does not
 * exist, one that exists with a different signature, and one that exists but is
 * not wrappable produce three different diagnostics, and only the first means
 * "leave it out of the catalog".
 *
 * Run:  npm run oracle:probe -- --file scripts/oracles/probes/coverage-v4d.ts \
 *         --json .oracle-probe-v4d.json
 */
import type { Probe } from '../xppcProbe.js';

/** An ApplicationSuite table the sandbox references, small and stable. */
const T = 'CustGroup';
const FIELD = `fieldNum(${T}, CustGroup)`;

/** Family A: call the member on a buffer. */
const call = (id: string, question: string, body: string, locals = `${T} buf;`): Probe => ({
  id,
  question,
  locals,
  body,
  expect: 'compiles',
});

/** Family B: wrap the method with the signature the catalog will publish. */
const wrap = (id: string, question: string, method: string, expect: Probe['expect'] = 'compiles'): Probe => ({
  id,
  question,
  declaration: `[ExtensionOf(tableStr(${T}))]\nfinal class ConProbe${id}_Extension`,
  methods: [method],
  expect,
});

const probes: Probe[] = [
  // ── Family A — the buffer API a test and a CoC wrapper both reach for ──────
  call('BufOrig', 'v4d/A — orig() returns a buffer of the same table (the pre-image)',
    `${T} pre = buf.orig();`),
  call('BufRecVersion', 'v4d/A — RecVersion is readable as a field, not a method',
    'int64 v = buf.RecVersion;'),
  call('BufData', 'v4d/A — data() returns the whole record as a container',
    'container c = buf.data();'),
  call('BufSetData', 'v4d/A — setData(container) is the inverse of data()',
    'buf.setData(buf.data());'),
  call('BufBuf2Buf', 'v4d/A — buf2Buf(from, to) is a GLOBAL function, not a member',
    `${T} target;\n        buf2Buf(buf, target);`),
  call('BufMerge', 'v4d/A — merge(other) folds another buffer into this one',
    `${T} other;\n        buf.merge(other);`),
  call('BufSetTmp', 'v4d/A — setTmp() turns a real buffer into an in-memory one',
    'buf.setTmp();'),
  call('BufSetTmpData', 'v4d/A — setTmpData(other) seeds a temp buffer from another',
    `${T} other;\n        buf.setTmp();\n        buf.setTmpData(other);`),
  call('BufSetConnection', 'v4d/A — setConnection(UserConnection) — the TempDB/report-DP binding',
    'buf.setConnection(uc);', `${T} buf;\n        UserConnection uc = new UserConnection();`),
  call('BufWasCached', 'v4d/A — wasCached() reports whether this row came from the cache',
    'boolean b = buf.wasCached();'),
  call('BufIsFieldDataRetrieved', 'v4d/A — isFieldDataRetrieved(fieldId) after a field-list select',
    `boolean b = buf.isFieldDataRetrieved(${FIELD});`),
  call('BufFieldState', 'v4d/A — fieldState(fieldId) — does it exist, and with one argument?',
    `int s = buf.fieldState(${FIELD});`),
  call('BufSelectForUpdate', 'v4d/A — selectForUpdate(true) before a write',
    'buf.selectForUpdate(true);'),
  call('BufReread', 'v4d/A — reread() refreshes the buffer from the database',
    'buf.reread();'),
  call('BufDynamicField', 'v4d/A — dynamic field access buf.(fieldId) returns anytype',
    `anytype v = buf.(${FIELD});`),
  call('BufCheckRecord', 'v4d/A — does checkRecord() exist? (least certain of the batch)',
    'boolean b = buf.checkRecord();'),
  call('BufCaption', 'v4d/A — caption() returns the record caption',
    'str s = buf.caption();'),
  call('BufCanSubmitToWorkflow', 'v4d/A — canSubmitToWorkflow(str) — one argument or none?',
    "boolean b = buf.canSubmitToWorkflow('');"),
  call('BufRenamePrimaryKey', 'v4d/A — renamePrimaryKey() cascades a key change',
    'buf.renamePrimaryKey();'),
  call('BufGetSQLStatements', 'v4d/A — getSQLStatements() after a generateOnly select',
    'str s = buf.getSQLStatements();'),

  // ── Family B — the overridable methods, probed as real CoC wrappers ────────
  wrap('WrapPostLoad', 'v4d/B — postLoad() signature and wrappability',
    `    public void postLoad()
    {
        next postLoad();
    }`),
  wrap('WrapAosValidateInsert', 'v4d/B — aosValidateInsert() returns boolean',
    `    public boolean aosValidateInsert()
    {
        return next aosValidateInsert();
    }`),
  wrap('WrapAosValidateUpdate', 'v4d/B — aosValidateUpdate()',
    `    public boolean aosValidateUpdate()
    {
        return next aosValidateUpdate();
    }`),
  wrap('WrapAosValidateDelete', 'v4d/B — aosValidateDelete()',
    `    public boolean aosValidateDelete()
    {
        return next aosValidateDelete();
    }`),
  wrap('WrapAosValidateRead', 'v4d/B — aosValidateRead()',
    `    public boolean aosValidateRead()
    {
        return next aosValidateRead();
    }`),
  wrap('WrapModifiedFieldValue', 'v4d/B — modifiedFieldValue(FieldId, anytype) — the two-argument twin of modifiedField',
    `    public void modifiedFieldValue(FieldId _fieldId, anytype _value)
    {
        next modifiedFieldValue(_fieldId, _value);
    }`),
  wrap('WrapDefaultField', 'v4d/B — defaultField(FieldId) — does it exist on a table?',
    `    public void defaultField(FieldId _fieldId)
    {
        next defaultField(_fieldId);
    }`),
  wrap('WrapDefaultRow', 'v4d/B — defaultRow()',
    `    public void defaultRow()
    {
        next defaultRow();
    }`),
  wrap('WrapToolTipField', 'v4d/B — toolTipField(FieldId) returns a string',
    `    public str toolTipField(fieldId _fieldId)
    {
        return next toolTipField(_fieldId);
    }`),
  wrap('WrapHelpField', 'v4d/B — helpField(FieldId)',
    `    public str helpField(fieldId _fieldId)
    {
        return next helpField(_fieldId);
    }`),
  wrap('WrapCaption', 'v4d/B — caption() as a wrapper, not just a call',
    `    public str caption()
    {
        return next caption();
    }`),
  wrap('WrapInitValue', 'v4d/B — initValue(), the catalog entry that already exists — a BASELINE',
    `    public void initValue()
    {
        next initValue();
    }`),
  wrap('WrapValidateWrite', 'v4d/B — validateWrite(), the most-asked one — a BASELINE',
    `    public boolean validateWrite()
    {
        return next validateWrite();
    }`),
  wrap('WrapNoSuchMethod', 'v4d/B — CONTROL: a method that does not exist must be REFUSED, so a '
    + 'compiling wrapper above actually means the base method is real',
    `    public void definitelyNotATableMethod()
    {
        next definitelyNotATableMethod();
    }`,
    'fails'),
];

export default probes;
