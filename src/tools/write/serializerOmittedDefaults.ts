/**
 * Property values the metadata serializer leaves out of the file because they are
 * the property's default, per root element type.
 *
 * `IMetadataProvider.Update()` writes a property only when its value differs from
 * the value a new instance of the metamodel class carries. So after a successful
 * `modify-property EntityCategory=Master` on a data entity the file holds NO
 * `<EntityCategory>` element at all — that absence is the value Master. A check
 * that looks for the literal element reads it as a lost write.
 *
 * Every AxDataEntityView entry was taken from two sources that agree:
 *
 *   • reflection over a new `AxDataEntityView` instance
 *     (Microsoft.Dynamics.AX.Metadata.dll): EntityCategory = Master (0), every NoYes
 *     property = No (0), EnableSetBasedSqlOperations = Auto (99, not 0);
 *   • a census of the 5,887 shipped AxDataEntityView files of platform 10.0.2790:
 *     the default member is the one that (almost) never appears while its siblings
 *     do. `<EntityCategory>` is absent from 3,121 files and says Master in only 4
 *     (Reference 1,019 · Document 739 · Transaction 686 · Parameters 295 ·
 *     Configuration 23). `<SupportsSetBasedSqlOperations>` says Yes in 2,485 files,
 *     No in 10 and is absent from 3,392. `<IsPublic>` is never No (Yes 4,753, absent
 *     1,134). `<EnableSetBasedSqlOperations>` is never Auto (No 99, absent 5,788).
 */

import { AX_TABLE_SERIALIZER_DEFAULTS } from '../xml/createTablePropertyHonesty.js';

const AX_DATA_ENTITY_VIEW_OMITTED_DEFAULTS: Record<string, readonly string[]> = {
  EntityCategory: ['Master'],
  EnableSetBasedSqlOperations: ['Auto'],
  AllowArchival: ['No'],
  AllowRetention: ['No'],
  AllowRowVersionChangeTracking: ['No'],
  AutoCreateDataverse: ['No'],
  DataManagementEnabled: ['No'],
  IsObsolete: ['No'],
  IsPublic: ['No'],
  IsReadOnly: ['No'],
  SupportsSetBasedSqlOperations: ['No'],
  ValidTimeStateEnabled: ['No'],
};

const OMITTED_DEFAULTS_BY_ROOT: Record<string, Record<string, readonly string[]>> = {
  AxTable: AX_TABLE_SERIALIZER_DEFAULTS,
  AxDataEntityView: AX_DATA_ENTITY_VIEW_OMITTED_DEFAULTS,
};

/**
 * A NoYes value as the serializer spells it. Callers pass `true`/`false` (the tool
 * schema's own booleans arrive as strings), the file says Yes/No.
 */
export function noYesSpelling(value: string): 'Yes' | 'No' | null {
  const v = value.trim().toLowerCase();
  if (v === 'true' || v === 'yes') return 'Yes';
  if (v === 'false' || v === 'no') return 'No';
  return null;
}

/** The root element of a metadata document (`AxTable`, `AxDataEntityView`, …). */
export function rootElementOf(xml: string): string | null {
  return /<(Ax\w+)[\s>/]/.exec(xml)?.[1] ?? null;
}

/**
 * True when `value` is the default the serializer omits for property `name` of a
 * `root` document, so no element in the file is the expected outcome of writing it.
 * Name and value compare case-insensitively, and true/false count as Yes/No.
 */
export function isOmittedDefault(root: string | null, name: string, value: string): boolean {
  const defaults = root ? OMITTED_DEFAULTS_BY_ROOT[root] : undefined;
  if (!defaults) return false;
  const key = Object.keys(defaults).find(k => k.toLowerCase() === name.trim().toLowerCase());
  if (!key) return false;
  const wanted = (noYesSpelling(value) ?? value.trim()).toLowerCase();
  return defaults[key].some(d => d.toLowerCase() === wanted);
}
