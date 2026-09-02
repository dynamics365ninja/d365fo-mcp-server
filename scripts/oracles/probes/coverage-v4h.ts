/**
 * Probe batch v4/H4 — the KERNEL half of the form runtime API.
 *
 * G-14 is two jobs with two oracles and the plan said so. `FormRun` is an
 * ordinary AOT class (ApplicationPlatform, 209 methods) and the member oracle
 * reads it. Everything a form actually spends its day calling is NOT there:
 * `xFormRun`, `FormDataSource`, `FormDataObject` and every `Form*Control` are
 * kernel-implemented and have no AOT XML at all, so the member oracle answers
 * "NOT FOUND" for all of them. Only the compiler can confirm those.
 *
 * The census picked which ones are worth confirming. Across the 9,442 shipped
 * forms, `element.X()` resolves to a FormRun member in only 49 distinct cases —
 * and `args()` alone is 21,009 of the 22,913 platform calls. The rest of the
 * high-traffic names (`design` 680 files, `updateDesign` 724, `name` 632,
 * `controlId` 213, `dataSource` 81, `selectMode` 263, `inViewMode` 57) are not
 * FormRun members, which means they are either kernel or a convention shared by
 * hundreds of unrelated forms. Guessing which would produce exactly the kind of
 * catalogue this round exists to stop shipping.
 *
 * Every probe is a STATIC method taking the object as a parameter: the type
 * resolves at compile time and no instance is needed, so the batch stays in one
 * class and one build.
 *
 * The first run already earned its keep by REMOVING something. `updateDesign`
 * ranks first in the element-call census — 1,703 uses across 724 forms — and it
 * is not form-runtime API at all: it is the inventory-dimension convention,
 * `element.updateDesign(InventDimFormDesignUpdate::Init)`, which forms declare
 * themselves. `UpdateDesignMode` appears in ZERO of 76,196 shipped files. Breadth
 * of use is not evidence of being platform, and the compiler is what tells the
 * two apart.
 *
 * Run:  npm run oracle:probe -- --file scripts/oracles/probes/coverage-v4h.ts \
 *         --json .oracle-probe-v4h.json
 */
import type { Probe } from '../xppcProbe.js';

const probes: Probe[] = [
  // ── xFormRun: the base every form's `element` really is ───────────────────
  {
    id: 'FormRunDesignApi',
    question: 'Are design()/name()/controlId()/control() on the form runtime, or a convention?',
    methods: [`    public static void probe(FormRun _element)
    {
        FormDesign  design = _element.design();
        str         formName = _element.name();
        int         id = _element.controlId('Foo');
        FormControl ctrl = _element.control(id);

        info(strFmt('%1 %2 %3', design, formName, ctrl));
    }`],
  },
  {
    id: 'FormRunDataSourceApi',
    question: 'dataSource() by index and by name, and what it hands back',
    methods: [`    public static void probe(FormRun _element)
    {
        FormDataSource byIndex = _element.dataSource(1);
        FormDataSource byName  = _element.dataSource(formDataSourceStr(CustTable, CustTable));

        info(strFmt('%1 %2', byIndex.name(), byName.name()));
    }`],
  },
  {
    id: 'FormRunModeApi',
    question: 'selectMode/inViewMode/closeOk/closeCancel/wait — the ones the census ranks next',
    methods: [`    public static void probe(FormRun _element, FormControl _control)
    {
        boolean viewMode = _element.inViewMode();

        _element.selectMode(_control);
        _element.wait();
        _element.closeOk();
        _element.closeCancel();
        info(strFmt('%1', viewMode));
    }`],
  },

  // ── FormDataSource: the API a form spends its day in ──────────────────────
  {
    id: 'FormDataSourceCore',
    question: 'research/refresh/reread/executeQuery/cursor and the write half',
    methods: [`    public static void probe(FormDataSource _ds)
    {
        Common cursor = _ds.cursor();

        _ds.executeQuery();
        _ds.research(true);
        _ds.refresh();
        _ds.reread();
        _ds.write();
        _ds.validateWrite();
        _ds.delete();
        info(strFmt('%1', cursor.RecId));
    }`],
  },
  {
    id: 'FormDataSourceQuery',
    question: 'queryBuildDataSource()/query()/queryRun() and adding a range from a form',
    methods: [`    public static void probe(FormDataSource _ds)
    {
        QueryBuildDataSource qbds = _ds.queryBuildDataSource();
        QueryRun             qr   = _ds.queryRun();
        Query                q    = _ds.query();

        qbds.addRange(fieldNum(CustTable, AccountNum)).value('4*');
        info(strFmt('%1 %2', qr.query().dataSourceCount(), q.dataSourceCount()));
    }`],
  },
  {
    id: 'FormDataSourceObject',
    question: 'object(fieldNum) → FormDataObject, and the four properties people set on it',
    methods: [`    public static void probe(FormDataSource _ds)
    {
        FormDataObject fdo = _ds.object(fieldNum(CustTable, AccountNum));

        fdo.allowEdit(false);
        fdo.visible(true);
        fdo.mandatory(false);
        info(strFmt('%1', fdo.allowEdit()));
    }`],
  },
  {
    id: 'FormDataSourceDisplayOption',
    question: 'displayOption(Common, FormRowDisplayOption) — the row-colouring seam',
    methods: [`    public static void probe(FormDataSource _ds, Common _record, FormRowDisplayOption _option)
    {
        _ds.displayOption(_record, _option);
        _option.backColor(255);
    }`],
  },

  // ── controls ──────────────────────────────────────────────────────────────
  {
    id: 'FormControlCommon',
    question: 'enabled/visible/allowEdit on the abstract FormControl, text/valueStr on the string one',
    methods: [`    public static void probe(FormControl _control, FormStringControl _string)
    {
        _control.enabled(false);
        _control.visible(true);
        _control.allowEdit(false);

        _string.text('x');
        info(_string.valueStr());
    }`],
  },
  {
    id: 'FormControlRegisterOverride',
    question: 'registerOverrideMethod on a CONCRETE control, with the three-argument shape',
    methods: [`    public static void probe(FormStringControl _control, FormRun _element)
    {
        _control.registerOverrideMethod(
            methodStr(FormStringControl, lookup),
            methodStr(FormRun, run),
            _element);
    }`],
  },

  // ── the negative control ──────────────────────────────────────────────────
  // Same shape as every probe above. If xppc does not complain about THIS, the
  // build never reached the batch and every "compiles" in the log is worthless.
  {
    id: 'NegativeControlFormApi',
    question: 'NEGATIVE CONTROL — a method that does not exist on FormDataSource must fail',
    expect: 'fails',
    methods: [`    public static void probe(FormDataSource _ds)
    {
        _ds.thisMethodDoesNotExistOnFormDataSource();
    }`],
  },
];

export default probes;
