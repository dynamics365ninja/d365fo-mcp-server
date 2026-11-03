/**
 * Extension names from configured format strings (EXTENSION_ELEMENT_NAME_FORMAT,
 * EXTENSION_CLASS_NAME_FORMAT[_TABLE|_FORM], EXTENSION_NAME_FORMAT_UNDEFINED).
 *
 * The convention under test is a neutral example of the shape these settings exist
 * for: every element extension `{0}.CTSO`, and a CoC class token chosen by the type
 * of the object extended — `CTSO_{0}Cls`, `CTSO_{0}Dbt` (tables), `CTSO_{0}Frm`
 * (forms) — always completed with `_Extension`.
 *
 * The real modelClassifier and objectNaming run here; nothing is mocked.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  formatNameProblemAsGiven,
  inferExtendedBase,
  normalizeObjectName,
  resolveFormattedExtensionName,
} from '../../src/utils/objectNaming.js';
import { extensionClassBaseOf, registerCustomModel } from '../../src/utils/modelClassifier.js';
import {
  extensionNameFormatProblems,
  readClassExtensionName,
} from '../../src/utils/extensionNameFormat.js';
import {
  clearInferredModelPrefixes,
  getInferredModelPrefix,
  setModelObjectNameSource,
} from '../../src/utils/modelPrefixInference.js';
import { XmlTemplateGenerator } from '../../src/tools/xml/xmlTemplateGenerator.js';

const MODEL = 'ContosoExt';
const ELEMENT = '{0}.CTSO';
const CLS = 'CTSO_{0}Cls';
const TABLE = 'CTSO_{0}Dbt';
const FORM = 'CTSO_{0}Frm';

const ENV_KEYS = [
  'EXTENSION_PREFIX',
  'EXTENSION_SUFFIX',
  'EXTENSION_NAMING_STYLE',
  'EXTENSION_CLASS_NAMING_STYLE',
  'EXTENSION_PREFIX_SOURCE',
  'EXTENSION_ELEMENT_NAME_FORMAT',
  'EXTENSION_CLASS_NAME_FORMAT',
  'EXTENSION_CLASS_NAME_FORMAT_TABLE',
  'EXTENSION_CLASS_NAME_FORMAT_FORM',
  'EXTENSION_NAME_FORMAT_UNDEFINED',
];
let saved: Record<string, string | undefined>;

function setFormats(values: Partial<Record<'element' | 'cls' | 'table' | 'form' | 'undefinedMode', string>>): void {
  if (values.element !== undefined) process.env.EXTENSION_ELEMENT_NAME_FORMAT = values.element;
  if (values.cls !== undefined) process.env.EXTENSION_CLASS_NAME_FORMAT = values.cls;
  if (values.table !== undefined) process.env.EXTENSION_CLASS_NAME_FORMAT_TABLE = values.table;
  if (values.form !== undefined) process.env.EXTENSION_CLASS_NAME_FORMAT_FORM = values.form;
  if (values.undefinedMode !== undefined) process.env.EXTENSION_NAME_FORMAT_UNDEFINED = values.undefinedMode;
}

const ALL = { element: ELEMENT, cls: CLS, table: TABLE, form: FORM };
const name = (objectName: string, objectType: string, options?: { extendedBase?: string; baseType?: string }) =>
  normalizeObjectName(objectName, objectType, MODEL, undefined, options);

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.EXTENSION_PREFIX = 'Ctso';
  process.env.EXTENSION_PREFIX_SOURCE = 'config';
  clearInferredModelPrefixes();
  registerCustomModel(MODEL);
});

afterEach(() => {
  setModelObjectNameSource(null);
  clearInferredModelPrefixes();
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('no format set: every name is generated exactly as before', () => {
  // Expected values are the 1.22.0 results for each style; the formats are absent,
  // empty or blank, and EXTENSION_NAME_FORMAT_UNDEFINED alone changes nothing.
  const STYLES: Array<{ style: string; env: Record<string, string>; element: string; cls: string; bare: string }> = [
    { style: 'prefix (default)', env: {}, element: 'InventTable.CtsoExtension', cls: 'CustTableCtso_Extension', bare: 'CustTableCtso_Extension' },
    {
      style: 'model-name', env: { EXTENSION_NAMING_STYLE: 'model-name' },
      element: 'InventTable.ContosoExt', cls: 'CustTable_ContosoExt_Extension', bare: 'CustTable_ContosoExt_Extension',
    },
    {
      style: 'class prefix-leading', env: { EXTENSION_CLASS_NAMING_STYLE: 'prefix-leading' },
      element: 'InventTable.CtsoExtension', cls: 'CtsoCustTable_Extension', bare: 'CtsoCustTable_Extension',
    },
    {
      style: 'prefixSource=none', env: { EXTENSION_PREFIX_SOURCE: 'none' },
      element: 'InventTable.ContosoExt', cls: 'CustTable_ContosoExt_Extension', bare: 'CustTable_ContosoExt_Extension',
    },
    {
      style: 'prefixSource=as-given', env: { EXTENSION_PREFIX_SOURCE: 'as-given' },
      element: 'InventTable', cls: 'CustTable_Extension', bare: 'CustTable',
    },
  ];
  const UNSET_VARIANTS: Array<[string, () => void]> = [
    ['absent', () => {}],
    ['empty', () => setFormats({ element: '', cls: '', table: '', form: '' })],
    ['blank', () => setFormats({ element: '  ', cls: ' ', table: '\t', form: ' ' })],
    ['UNDEFINED alone', () => setFormats({ undefinedMode: 'class-format' })],
  ];

  for (const s of STYLES) {
    for (const [variant, apply] of UNSET_VARIANTS) {
      it(`${s.style}, formats ${variant}`, () => {
        Object.assign(process.env, s.env);
        apply();
        expect(name('InventTable', 'table-extension')).toBe(s.element);
        expect(name('CustTable_Extension', 'class-extension', { extendedBase: 'CustTable', baseType: 'table' })).toBe(s.cls);
        expect(name('CustTable', 'class-extension')).toBe(s.bare);
        expect(name('MyTable', 'table')).toBe(s.style.includes('as-given') || s.style.includes('none') ? 'MyTable' : 'CtsoMyTable');
        for (const t of ['table-extension', 'class-extension', 'form-extension', 'enum-extension', 'security-role-extension']) {
          expect(resolveFormattedExtensionName('CustTable', t, { baseType: 'table' }).kind).toBe('none');
        }
      });
    }
  }

  it('an element format leaves extension classes to the style, and class formats leave elements to it', () => {
    setFormats({ element: ELEMENT });
    expect(name('InventTable', 'table-extension')).toBe('InventTable.CTSO');
    expect(name('CustTable', 'class-extension', { baseType: 'table' })).toBe('CustTableCtso_Extension');
    delete process.env.EXTENSION_ELEMENT_NAME_FORMAT;
    setFormats({ cls: CLS });
    expect(name('InventTable', 'table-extension')).toBe('InventTable.CtsoExtension');
    expect(name('CustTable', 'class-extension', { baseType: 'class' })).toBe('CTSO_CustTableCls_Extension');
  });

  it('new objects keep their prefix rules under any format', () => {
    setFormats(ALL);
    expect(name('MyTable', 'table')).toBe('CtsoMyTable');
    expect(name('MyHelper', 'class')).toBe('CtsoMyHelper');
  });
});

describe('element extensions: EXTENSION_ELEMENT_NAME_FORMAT for every base type', () => {
  beforeEach(() => setFormats(ALL));

  it.each([
    'table-extension', 'form-extension', 'enum-extension', 'edt-extension', 'data-entity-extension',
    'menu-item-display-extension', 'menu-item-action-extension', 'menu-item-output-extension', 'menu-extension',
    'security-duty-extension', 'security-role-extension',
  ])('%s: InventTable → InventTable.CTSO', type => {
    expect(name('InventTable', type)).toBe('InventTable.CTSO');
  });

  it('replaces whatever follows the dot, and is idempotent', () => {
    expect(name('InventTable.CtsoExtension', 'table-extension')).toBe('InventTable.CTSO');
    expect(name('InventTable.ContosoExt', 'table-extension')).toBe('InventTable.CTSO');
    expect(name('InventTable.CTSO', 'table-extension')).toBe('InventTable.CTSO');
  });
});

describe('extension classes: the base TYPE selects the class format', () => {
  beforeEach(() => setFormats(ALL));

  it('class → EXTENSION_CLASS_NAME_FORMAT', () => {
    expect(name('SalesFormLetter', 'class-extension', { baseType: 'class' })).toBe('CTSO_SalesFormLetterCls_Extension');
    expect(name('SalesFormLetter_Extension', 'class-extension', { baseType: 'classStr' })).toBe('CTSO_SalesFormLetterCls_Extension');
  });

  it('table → _TABLE, form → _FORM (the [ExtensionOf] kinds as parsed: tablestr / formstr)', () => {
    expect(name('InventTable', 'class-extension', { baseType: 'table' })).toBe('CTSO_InventTableDbt_Extension');
    expect(name('InventTable', 'class-extension', { baseType: 'tablestr' })).toBe('CTSO_InventTableDbt_Extension');
    expect(name('InventTable', 'class-extension', { baseType: 'form' })).toBe('CTSO_InventTableFrm_Extension');
    expect(name('InventTable', 'class-extension', { baseType: 'formstr' })).toBe('CTSO_InventTableFrm_Extension');
  });

  it('the base comes from [ExtensionOf] (extendedBase) over the name', () => {
    expect(name('Whatever', 'class-extension', { extendedBase: 'InventTable', baseType: 'table' }))
      .toBe('CTSO_InventTableDbt_Extension');
  });

  it('a table or form without its own format falls back to the class format', () => {
    delete process.env.EXTENSION_CLASS_NAME_FORMAT_TABLE;
    delete process.env.EXTENSION_CLASS_NAME_FORMAT_FORM;
    expect(name('InventTable', 'class-extension', { baseType: 'table' })).toBe('CTSO_InventTableCls_Extension');
    expect(name('InventTable', 'class-extension', { baseType: 'form' })).toBe('CTSO_InventTableCls_Extension');
  });

  it('is idempotent, and a stated type re-names a name of the wrong format', () => {
    for (const [n, t] of [
      ['CTSO_InventTableDbt_Extension', 'table'],
      ['CTSO_InventTableFrm_Extension', 'form'],
      ['CTSO_SalesFormLetterCls_Extension', 'class'],
    ]) {
      expect(name(n, 'class-extension', { baseType: t })).toBe(n);
      expect(name(n, 'class-extension')).toBe(n);
    }
    expect(name('CTSO_InventTableCls_Extension', 'class-extension', { baseType: 'table' })).toBe('CTSO_InventTableDbt_Extension');
  });

  it('an explicit name for a DEFINED case is replaced by the format', () => {
    const r = resolveFormattedExtensionName('InventTable_Feature_Extension', 'class-extension', {
      extendedBase: 'InventTable', baseType: 'table',
    });
    expect(r).toMatchObject({ kind: 'name', name: 'CTSO_InventTableDbt_Extension', setting: 'EXTENSION_CLASS_NAME_FORMAT_TABLE' });
  });

  it('a class format that already ends in _Extension does not get it twice', () => {
    setFormats({ cls: 'CTSO_{0}Cls_Extension' });
    expect(name('SalesFormLetter', 'class-extension', { baseType: 'class' })).toBe('CTSO_SalesFormLetterCls_Extension');
  });
});

describe('cases no format defines: EXTENSION_NAME_FORMAT_UNDEFINED', () => {
  const UNDEFINED_CASES: Array<[string, string | undefined]> = [
    ['form data source', 'formdatasource'],
    ['form control', 'formcontrol'],
    ['view', 'view'],
    ['data entity', 'dataentityview'],
    ['map', 'map'],
    ['no base type', undefined],
  ];

  describe('ask (the default)', () => {
    beforeEach(() => setFormats(ALL));

    it.each(UNDEFINED_CASES)('%s: the tool asks instead of naming', (_label, baseType) => {
      const r = resolveFormattedExtensionName('CustTable', 'class-extension', { extendedBase: 'CustTable', baseType });
      expect(r.kind).toBe('ask');
      const message = (r as { message: string }).message;
      expect(message).toMatch(/^no naming convention for /);
      expect(message).toContain('ask the user for the name and call again with an explicit `name`');
      expect(message).toContain('EXTENSION_NAME_FORMAT_UNDEFINED=ask');
      // normalizeObjectName invents nothing either; the write path refuses first.
      expect(name('CustTable', 'class-extension', { extendedBase: 'CustTable', baseType })).toBe('CustTable');
    });

    it('names the case in the question', () => {
      const r = resolveFormattedExtensionName('CustTable', 'class-extension', { baseType: 'formdatasource' });
      expect((r as { message: string }).message).toContain('no naming convention for an extension class of a form-datasource');
      const none = resolveFormattedExtensionName('CustTable', 'class-extension');
      expect((none as { message: string }).message).toContain('an extension class whose base type was not given');
    });

    it('a {Base}_Extension name is still the base, so it is asked about too', () => {
      expect(resolveFormattedExtensionName('CustTable_Extension', 'class-extension', { baseType: 'view' }).kind).toBe('ask');
    });

    it('the explicit name the user gave on the second call is kept', () => {
      const r = resolveFormattedExtensionName('CTSO_CustTable_CustTableDSCls_Extension', 'class-extension', {
        extendedBase: 'CustTable', baseType: 'formdatasource',
      });
      expect(r).toMatchObject({ kind: 'name', name: 'CTSO_CustTable_CustTableDSCls_Extension' });
    });

    it('an explicit name that is no class name is refused, not kept', () => {
      const r = resolveFormattedExtensionName('Bad-Name_Extension', 'class-extension', {
        extendedBase: 'CustTable', baseType: 'view',
      });
      expect(r.kind).toBe('invalid');
    });

    it('without a class format, class-format has nothing to use and asks', () => {
      setFormats({ undefinedMode: 'class-format' });
      delete process.env.EXTENSION_CLASS_NAME_FORMAT;
      expect(resolveFormattedExtensionName('CustTable', 'class-extension', { baseType: 'view' }).kind).toBe('ask');
    });
  });

  describe('class-format', () => {
    beforeEach(() => setFormats({ ...ALL, undefinedMode: 'class-format' }));

    it.each(UNDEFINED_CASES)('%s: named by EXTENSION_CLASS_NAME_FORMAT', (_label, baseType) => {
      const r = resolveFormattedExtensionName('CustTable', 'class-extension', { extendedBase: 'CustTable', baseType });
      expect(r).toMatchObject({ kind: 'name', name: 'CTSO_CustTableCls_Extension' });
      expect((r as { setting: string }).setting).toContain('EXTENSION_NAME_FORMAT_UNDEFINED=class-format');
    });

    it('an explicit name is still kept for an undefined case', () => {
      const r = resolveFormattedExtensionName('CTSO_CustTable_SalesLineDSCls_Extension', 'class-extension', {
        extendedBase: 'CustTable', baseType: 'formdatasource',
      });
      expect(r).toMatchObject({ kind: 'name', name: 'CTSO_CustTable_SalesLineDSCls_Extension' });
    });
  });
});

describe('a format that cannot name anything is refused, never ignored', () => {
  it.each([
    [{ cls: 'CTSO_Cls' }, /EXTENSION_CLASS_NAME_FORMAT="CTSO_Cls" must contain \{0\}/],
    [{ cls: 'CTSO_{0}_{0}' }, /exactly once/],
    [{ table: 'CTSO-{0}Dbt' }, /may hold only letters, digits and _/],
    [{ cls: '1CTSO_{0}' }, /must start with a letter or _/],
    [{ element: '{0}CTSO' }, /must have the AOT element-extension shape/],
    [{ element: 'CTSO.{0}' }, /must have the AOT element-extension shape/],
  ])('%o', (formats, message) => {
    setFormats(formats as Record<string, string>);
    expect(extensionNameFormatProblems().join(' ')).toMatch(message);
    const type = 'element' in formats ? 'table-extension' : 'class-extension';
    const r = resolveFormattedExtensionName('CustTable', type, { baseType: 'table' });
    expect(r.kind).toBe('invalid');
    expect(name('CustTable', type, { baseType: 'table' })).toBe('CustTable');
  });

  it('an unknown UNDEFINED value is reported and treated as ask', () => {
    setFormats({ ...ALL, undefinedMode: 'clas-format' });
    expect(extensionNameFormatProblems().join(' ')).toMatch(/EXTENSION_NAME_FORMAT_UNDEFINED="clas-format" is not a known value/);
    expect(resolveFormattedExtensionName('CustTable', 'class-extension', { baseType: 'view' }).kind).toBe('ask');
  });
});

describe('reverse parsing: the base a formatted class name extends', () => {
  it('reads each format back (extensionClassBaseOf, case-insensitive fixed text)', () => {
    setFormats(ALL);
    expect(extensionClassBaseOf('CTSO_InventTableDbt_Extension', MODEL)).toBe('InventTable');
    expect(extensionClassBaseOf('CTSO_InventTableFrm_Extension', MODEL)).toBe('InventTable');
    expect(extensionClassBaseOf('CTSO_SalesFormLetterCls_Extension', MODEL)).toBe('SalesFormLetter');
    expect(extensionClassBaseOf('ctso_InventTabledbt_Extension', MODEL)).toBe('InventTable');
    expect(readClassExtensionName('CTSO_InventTableDbt_Extension')).toEqual([
      { base: 'InventTable', type: 'table', setting: 'EXTENSION_CLASS_NAME_FORMAT_TABLE', format: TABLE },
    ]);
  });

  it('a name no format produces falls back to the style reading', () => {
    setFormats(ALL);
    expect(readClassExtensionName('CustTableCtso_Extension')).toEqual([]);
    expect(extensionClassBaseOf('CustTableCtso_Extension', MODEL)).toBe('CustTable');
  });

  it('ambiguous — overlapping formats: the specific (form) reading wins; [ExtensionOf] settles it', () => {
    // CTSO_{0} and CTSO_{0}Frm both produce CTSO_CustTableFrm: the form CustTable's
    // class, and the class CustTableFrm's. The format configured for forms is the
    // deliberate one, so it is read first.
    setFormats({ cls: 'CTSO_{0}', form: FORM });
    const readings = readClassExtensionName('CTSO_CustTableFrm_Extension');
    expect(readings.map(r => [r.type, r.base])).toEqual([['form', 'CustTable'], ['class', 'CustTableFrm']]);
    expect(extensionClassBaseOf('CTSO_CustTableFrm_Extension', MODEL)).toBe('CustTable');
    expect(inferExtendedBase('CTSO_CustTableFrm_Extension', MODEL, () => true)).toBe('CustTable');
    // With the base from [ExtensionOf], the other reading is the one taken — and the
    // name stays as it is, since both formats spell it the same.
    expect(readClassExtensionName('CTSO_CustTableFrm_Extension', 'CustTableFrm').map(r => r.type)).toEqual(['class']);
    expect(name('CTSO_CustTableFrm_Extension', 'class-extension', { extendedBase: 'CustTableFrm', baseType: 'class' }))
      .toBe('CTSO_CustTableFrm_Extension');
  });

  it('ambiguous — the class format as fallback: a table class without _TABLE reads as base + class', () => {
    // Only the class format set: CTSO_InventTableCls is the class InventTable's AND the
    // table InventTable's (fallback). The base is the same either way, which is what a
    // CoC lookup needs; the type is reported as the format's (class). [ExtensionOf] decides.
    setFormats({ cls: CLS });
    expect(readClassExtensionName('CTSO_InventTableCls_Extension')).toEqual([
      { base: 'InventTable', type: 'class', setting: 'EXTENSION_CLASS_NAME_FORMAT', format: CLS },
    ]);
    expect(name('CTSO_InventTableCls_Extension', 'class-extension', { extendedBase: 'InventTable', baseType: 'table' }))
      .toBe('CTSO_InventTableCls_Extension');
  });

  it('Cls vs Frm with distinct tokens is not ambiguous', () => {
    setFormats(ALL);
    expect(readClassExtensionName('CTSO_CustTableFrm_Extension').map(r => [r.type, r.base])).toEqual([['form', 'CustTable']]);
    expect(readClassExtensionName('CTSO_CustTableCls_Extension').map(r => [r.type, r.base])).toEqual([['class', 'CustTable']]);
  });

  it('inferExtendedBase reads the format, never the index (identical on companion and shared server)', () => {
    setFormats(ALL);
    let asked = 0;
    const index = () => { asked++; return true; };
    expect(inferExtendedBase('CTSO_InventTableDbt_Extension', MODEL, index)).toBe('InventTable');
    expect(inferExtendedBase('CustTableCtsoCredit_Extension', MODEL, index)).toBeUndefined();
    expect(asked).toBe(0);
  });

  it('the class-extension template names the right intrinsic', () => {
    setFormats(ALL);
    expect(XmlTemplateGenerator.generateAxClassExtensionXml('CTSO_InventTableDbt_Extension')).toContain('[ExtensionOf(tableStr(InventTable))]');
    expect(XmlTemplateGenerator.generateAxClassExtensionXml('CTSO_InventTableFrm_Extension')).toContain('[ExtensionOf(formStr(InventTable))]');
    expect(XmlTemplateGenerator.generateAxClassExtensionXml('CTSO_SalesFormLetterCls_Extension')).toContain('[ExtensionOf(classStr(SalesFormLetter))]');
    expect(
      XmlTemplateGenerator.generateAxClassExtensionXml('CTSO_InventTableCls_Extension', undefined, { baseObjectType: 'table' }),
    ).toContain('[ExtensionOf(tableStr(InventTable))]');
  });
});

describe('prefix inference does not learn a token from formatted names', () => {
  // {0}.ConExtension states an infix the way an element extension does: without the
  // filter the model would "teach" the prefix Con, against the configured Ctso.
  const formatted = Array.from({ length: 10 }, (_, i) => `Table${i}.ConExtension`);

  it('without a format the token is learned (the conflict this guards against)', () => {
    setModelObjectNameSource(m => (m === MODEL ? formatted : []));
    process.env.EXTENSION_PREFIX_SOURCE = 'model';
    expect(getInferredModelPrefix(MODEL)?.regular).toBe('Con');
  });

  it('with the format set the formatted names are skipped', () => {
    setModelObjectNameSource(m => (m === MODEL ? formatted : []));
    process.env.EXTENSION_PREFIX_SOURCE = 'model';
    setFormats({ element: '{0}.ConExtension', cls: CLS });
    expect(getInferredModelPrefix(MODEL)).toBeNull();
    expect(name('MyTable', 'table')).toBe('CtsoMyTable');
  });

  it('regular objects still teach their prefix under a format', () => {
    const regulars = Array.from({ length: 10 }, (_, i) => `ConThing${i}`);
    setModelObjectNameSource(m => (m === MODEL ? [...regulars, ...formatted, 'CTSO_Thing1Cls_Extension'] : []));
    process.env.EXTENSION_PREFIX_SOURCE = 'model';
    setFormats({ element: '{0}.ConExtension', cls: CLS });
    expect(getInferredModelPrefix(MODEL)?.regular).toBe('Con');
  });
});

describe('naming.prefixSource=as-given with formats: nothing is renamed, a non-conforming name is refused', () => {
  beforeEach(() => {
    process.env.EXTENSION_PREFIX_SOURCE = 'as-given';
    setFormats(ALL);
  });

  it('the name is never changed', () => {
    expect(name('InventTable', 'table-extension')).toBe('InventTable');
    expect(name('InventTable', 'class-extension', { baseType: 'table' })).toBe('InventTable');
  });

  it('a name the format produces passes; any other is refused with the expected one', () => {
    expect(formatNameProblemAsGiven('InventTable.CTSO', 'table-extension')).toBeNull();
    expect(formatNameProblemAsGiven('CTSO_InventTableDbt_Extension', 'class-extension', { baseType: 'table' })).toBeNull();
    expect(formatNameProblemAsGiven('InventTable.Contoso', 'table-extension'))
      .toMatch(/does not follow EXTENSION_ELEMENT_NAME_FORMAT; it expects "InventTable\.CTSO"/);
    expect(formatNameProblemAsGiven('InventTable_Extension', 'class-extension', { extendedBase: 'InventTable', baseType: 'table' }))
      .toMatch(/it expects "CTSO_InventTableDbt_Extension"/);
  });

  it('an undefined case still asks', () => {
    expect(formatNameProblemAsGiven('CustTable', 'class-extension', { baseType: 'view' })).toMatch(/^no naming convention/);
  });

  it('no format: as-given behaves as before', () => {
    for (const k of ENV_KEYS.filter(k => k.includes('NAME_FORMAT'))) delete process.env[k];
    expect(formatNameProblemAsGiven('Whatever', 'class-extension')).toBeNull();
  });
});
