/**
 * Extension names from configured format strings.
 *
 * The naming styles (EXTENSION_NAMING_STYLE / EXTENSION_CLASS_NAMING_STYLE) place
 * one token — the prefix infix or the model name — at a fixed spot. A convention
 * that fixes the whole shape cannot be expressed with them: `{0}.CTSO` for every
 * element extension, `CTSO_{0}Cls_Extension` for a CoC class, and a different
 * token by the type of the object extended (`CTSO_{0}Dbt_Extension` for a table,
 * `CTSO_{0}Frm_Extension` for a form). These settings say exactly that, with
 * `{0}` standing for the extended object's name.
 *
 * Nothing here is consulted while every format is empty: names are then built by
 * the styles, exactly as before. The base type is never guessed from a name — it
 * comes from the call ([ExtensionOf(<kind>Str(…))], or a stated type). Without
 * one, and for base types no format defines (form data sources and controls,
 * views, entities, maps …), EXTENSION_NAME_FORMAT_UNDEFINED decides: `ask` (the
 * default) returns the question to the caller instead of inventing a name,
 * `class-format` uses EXTENSION_CLASS_NAME_FORMAT.
 *
 * Reads the environment only, so it can be imported from modelClassifier and
 * modelPrefixInference without a cycle.
 */

export const ELEMENT_FORMAT_ENV = 'EXTENSION_ELEMENT_NAME_FORMAT';
export const CLASS_FORMAT_ENV = 'EXTENSION_CLASS_NAME_FORMAT';
export const CLASS_FORMAT_TABLE_ENV = 'EXTENSION_CLASS_NAME_FORMAT_TABLE';
export const CLASS_FORMAT_FORM_ENV = 'EXTENSION_CLASS_NAME_FORMAT_FORM';
export const UNDEFINED_FORMAT_ENV = 'EXTENSION_NAME_FORMAT_UNDEFINED';

/** The base types a class format exists for. */
export type FormattedBaseType = 'class' | 'table' | 'form';

/** Every class format is completed with this; D365FO requires it on extension classes. */
const EXTENSION_SUFFIX = '_Extension';

/** The fixed text a format may hold around `{0}`: identifier characters (and a dot for elements). */
const CLASS_FIXED = /^[A-Za-z0-9_]*$/;
const ELEMENT_FIXED = /^[A-Za-z0-9_.]*$/;

function env(name: string): string {
  return process.env[name]?.trim() ?? '';
}

/**
 * A class format as configured, without a trailing `_Extension`: the suffix is
 * always appended, so a value that already carries it must not get it twice.
 */
function classFormat(name: string): string {
  const raw = env(name);
  return raw.toLowerCase().endsWith(EXTENSION_SUFFIX.toLowerCase())
    ? raw.slice(0, -EXTENSION_SUFFIX.length)
    : raw;
}

export interface ExtensionNameFormats {
  element: string;
  cls: string;
  table: string;
  form: string;
  undefinedMode: 'ask' | 'class-format';
}

export function getExtensionNameFormats(): ExtensionNameFormats {
  return {
    element: env(ELEMENT_FORMAT_ENV),
    cls: classFormat(CLASS_FORMAT_ENV),
    table: classFormat(CLASS_FORMAT_TABLE_ENV),
    form: classFormat(CLASS_FORMAT_FORM_ENV),
    undefinedMode: env(UNDEFINED_FORMAT_ENV).toLowerCase() === 'class-format' ? 'class-format' : 'ask',
  };
}

/** True when element extensions are named by EXTENSION_ELEMENT_NAME_FORMAT. */
export function elementFormatActive(): boolean {
  return env(ELEMENT_FORMAT_ENV) !== '';
}

/** True when extension classes are named by the class formats (any of the three set). */
export function classFormatsActive(): boolean {
  return env(CLASS_FORMAT_ENV) !== '' || env(CLASS_FORMAT_TABLE_ENV) !== '' || env(CLASS_FORMAT_FORM_ENV) !== '';
}

export function anyExtensionNameFormatActive(): boolean {
  return elementFormatActive() || classFormatsActive();
}

/**
 * Why a configured format cannot name anything, one line per setting; empty when
 * every set value is usable. A format that is wrong is refused, not ignored: an
 * ignored one would silently hand naming back to the styles.
 */
export function extensionNameFormatProblems(): string[] {
  const out: string[] = [];
  const check = (setting: string, value: string, fixed: RegExp, element: boolean) => {
    if (!value) return;
    const parts = value.split('{0}');
    if (parts.length !== 2) {
      out.push(`${setting}="${value}" must contain {0} (the extended object's name) exactly once.`);
      return;
    }
    if (!parts.every(p => fixed.test(p))) {
      out.push(`${setting}="${value}" may hold only letters, digits and _${element ? ' and one dot' : ''} around {0}.`);
      return;
    }
    if (element) {
      // <Base>.<Token>: the base is {0}, so the dot and a token follow it.
      if (parts[0] !== '' || !/^\.[A-Za-z_][A-Za-z0-9_]*$/.test(parts[1])) {
        out.push(`${setting}="${value}" must have the AOT element-extension shape {0}.<Token> (e.g. {0}.Contoso).`);
      }
    } else if (parts[0] !== '' && !/^[A-Za-z_]/.test(parts[0])) {
      out.push(`${setting}="${value}" must start with a letter or _ (it begins a class name).`);
    }
  };
  check(ELEMENT_FORMAT_ENV, env(ELEMENT_FORMAT_ENV), ELEMENT_FIXED, true);
  const f = getExtensionNameFormats();
  check(CLASS_FORMAT_ENV, f.cls, CLASS_FIXED, false);
  check(CLASS_FORMAT_TABLE_ENV, f.table, CLASS_FIXED, false);
  check(CLASS_FORMAT_FORM_ENV, f.form, CLASS_FIXED, false);
  const undef = env(UNDEFINED_FORMAT_ENV);
  if (undef && !['ask', 'class-format'].includes(undef.toLowerCase())) {
    out.push(`${UNDEFINED_FORMAT_ENV}="${undef}" is not a known value (ask | class-format) — treated as "ask".`);
  }
  return out;
}

/**
 * The type of the extended object, from an [ExtensionOf] intrinsic kind
 * (`tablestr` → table) or a type a caller stated (`Table`, `form-datasource`).
 * Undefined for an empty input. Kinds no format exists for are returned in the
 * same dashed spelling (`form-datasource`, `data-entity`) so a message can name them.
 */
export function normalizeExtensionBaseType(kind: string | undefined | null): string | undefined {
  const k = (kind ?? '').trim().toLowerCase().replace(/str$/, '').replace(/[-_\s]/g, '');
  if (!k) return undefined;
  switch (k) {
    case 'class': return 'class';
    case 'table': return 'table';
    case 'form': return 'form';
    case 'formdatasource': return 'form-datasource';
    case 'formcontrol': return 'form-control';
    case 'dataentity':
    case 'dataentityview': return 'data-entity';
    default: return k;
  }
}

/** `{0}` replaced by `base`. */
export function applyNameFormat(format: string, base: string): string {
  return format.replace('{0}', base);
}

/** The element-extension name EXTENSION_ELEMENT_NAME_FORMAT gives `base`. */
export function formatElementExtensionName(base: string): string {
  return applyNameFormat(env(ELEMENT_FORMAT_ENV), base);
}

/** The class-extension name `format` gives `base`, `_Extension` appended. */
export function formatClassExtensionName(format: string, base: string): string {
  return `${applyNameFormat(format, base)}${EXTENSION_SUFFIX}`;
}

/** The format that names an extension class of `baseType`, and the setting it came from. */
export type ClassFormatRule =
  | { format: string; setting: string }
  | { format?: undefined; undefinedCase: string };

/**
 * Which class format names the extension class of an object of `baseType`.
 * table and form use their own format and fall back to the class format;
 * class uses the class format. Every other base type — and no base type —
 * is an undefined case, settled by EXTENSION_NAME_FORMAT_UNDEFINED.
 */
export function classFormatFor(baseType: string | undefined): ClassFormatRule {
  const f = getExtensionNameFormats();
  if (baseType === 'table' && f.table) return { format: f.table, setting: CLASS_FORMAT_TABLE_ENV };
  if (baseType === 'form' && f.form) return { format: f.form, setting: CLASS_FORMAT_FORM_ENV };
  if ((baseType === 'class' || baseType === 'table' || baseType === 'form') && f.cls) {
    return { format: f.cls, setting: CLASS_FORMAT_ENV };
  }
  const undefinedCase = baseType ? `an extension class of a ${baseType}` : 'an extension class whose base type was not given';
  if (f.undefinedMode === 'class-format' && f.cls) {
    return { format: f.cls, setting: `${CLASS_FORMAT_ENV} (${UNDEFINED_FORMAT_ENV}=class-format)` };
  }
  return { undefinedCase };
}

/** `name` read against `format`: the `{0}` part, or undefined when the fixed text differs. */
export function parseNameFormat(name: string, format: string): string | undefined {
  const at = format.indexOf('{0}');
  if (at < 0) return undefined;
  const head = format.slice(0, at);
  const tail = format.slice(at + 3);
  if (name.length <= head.length + tail.length) return undefined;
  // Case-insensitive, as X++ names are: CTSO_custTableCls_Extension still names CustTable.
  const lower = name.toLowerCase();
  if (!lower.startsWith(head.toLowerCase()) || !lower.endsWith(tail.toLowerCase())) return undefined;
  const base = name.slice(head.length, name.length - tail.length);
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(base) ? base : undefined;
}

/** One reading of an extension-class name under one configured class format. */
export interface ClassNameReading {
  base: string;
  type: FormattedBaseType;
  setting: string;
  format: string;
}

/**
 * Every reading of `name` (ending in `_Extension`) under the configured class
 * formats, most specific first: the format with the most fixed text, and on a
 * tie table/form before class.
 *
 * More than one reading is possible when formats overlap. With
 * EXTENSION_CLASS_NAME_FORMAT="CTSO_{0}" and …_FORM="CTSO_{0}Frm",
 * `CTSO_CustTableFrm_Extension` is the form CustTable's class AND the class
 * CustTableFrm's — both formats produce that same string. The specific format
 * comes first: it was configured on purpose for that base type, and a class
 * whose own name ends in the form token is the rarer case. A caller with the
 * [ExtensionOf] in hand passes the base and settles it (see readClassExtensionName).
 */
export function readClassExtensionName(name: string, extendedBase?: string): ClassNameReading[] {
  if (!classFormatsActive() || !name.toLowerCase().endsWith(EXTENSION_SUFFIX.toLowerCase())) return [];
  const stem = name.slice(0, -EXTENSION_SUFFIX.length);
  const f = getExtensionNameFormats();
  const out: ClassNameReading[] = [];
  const tryFormat = (format: string, type: FormattedBaseType, setting: string) => {
    if (!format) return;
    const base = parseNameFormat(stem, format);
    if (!base) return;
    if (extendedBase && base.toLowerCase() !== extendedBase.toLowerCase()) return;
    out.push({ base, type, setting, format });
  };
  tryFormat(f.table, 'table', CLASS_FORMAT_TABLE_ENV);
  tryFormat(f.form, 'form', CLASS_FORMAT_FORM_ENV);
  tryFormat(f.cls, 'class', CLASS_FORMAT_ENV);
  const fixed = (r: ClassNameReading) => r.format.length - 3;
  // Stable sort: equal fixed text keeps the table, form, class order above.
  return out.sort((a, b) => fixed(b) - fixed(a));
}

/**
 * Does `name` have the shape of a configured format — an element extension
 * under the element format, or an extension class under a class format?
 * Prefix inference skips these: their tokens are the format's, not a prefix.
 */
export function matchesConfiguredExtensionFormat(name: string): boolean {
  const element = env(ELEMENT_FORMAT_ENV);
  if (element && name.includes('.') && parseNameFormat(name, element)) return true;
  return readClassExtensionName(name).length > 0;
}

/** One line per active format, for get_workspace_info and validate_object_naming. */
export function describeExtensionNameFormats(): string[] {
  const f = getExtensionNameFormats();
  const lines: string[] = [];
  if (f.element) lines.push(`${ELEMENT_FORMAT_ENV}="${f.element}" — every element extension`);
  if (f.cls) lines.push(`${CLASS_FORMAT_ENV}="${f.cls}" + _Extension — extension classes of classes${f.table && f.form ? '' : ' (and the fallback for tables/forms)'}`);
  if (f.table) lines.push(`${CLASS_FORMAT_TABLE_ENV}="${f.table}" + _Extension — extension classes of tables`);
  if (f.form) lines.push(`${CLASS_FORMAT_FORM_ENV}="${f.form}" + _Extension — extension classes of forms`);
  if (classFormatsActive()) {
    lines.push(
      `${UNDEFINED_FORMAT_ENV}=${f.undefinedMode} — other base types (form data sources/controls, views, entities, maps …) ` +
      (f.undefinedMode === 'ask' || !f.cls
        ? 'and calls without a base type: the user is asked for the name'
        : 'and calls without a base type: the class format'),
    );
  }
  return lines;
}
