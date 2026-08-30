/**
 * Shared builder for AxForm XML.
 *
 * createD365File.ts and generateD365Xml.ts each expose a mirrored
 * XmlTemplateGenerator class; both delegate here so the two cannot drift
 * (mirrors the securityPrivilegeXml.ts / queryViewXml.ts pattern).
 *
 * The generate mirror had drifted all the way to ignoring its input: its
 * parameter was literally named `_properties` and it returned a fixed empty
 * shell — no pattern, no data source, no controls, no caption. Since the
 * documented hybrid flow is generate → create(xmlContent), a caller who asked
 * for a SimpleList form over a table got an empty form on disk, and an empty
 * form builds clean.
 */

import { FormPatternTemplates } from '../../utils/formPatternTemplates.js';
import {
  getFieldControlMapFromDisk,
  resetTableXmlIndexCache,
  tableDeclaresFieldGroup,
  type FieldControlMap,
} from '../../utils/fieldControlTypes.js';

/**
 * Resolve a data source table's field→control types.
 *
 * The templates have accepted `fieldTypes` all along and `generate_object`
 * supplies it, but this builder — the one behind
 * `d365fo_file(action="create", objectType="form")` — never did, so EVERY grid
 * column came out as an AxFormStringControl. That is invisible for a string
 * field and a build error for any other: a date column fails the build with
 * "AxForm/…/DataField: Data type mismatch", naming the form rather than the
 * field type it actually disagrees with. Found by capturing
 * L3-form-event-handler-class on the VM.
 *
 * A caller-supplied map still wins, so the smart-form path is unaffected.
 */
function resolveFieldTypes(
  table: string | undefined,
  supplied: unknown,
): FieldControlMap | undefined {
  if (supplied instanceof Map) return supplied as FieldControlMap;
  if (!table) return undefined;
  const map = getFieldControlMapFromDisk(table);
  return map.size > 0 ? map : undefined;
}

/**
 * Build an AxForm from a design pattern.
 *
 * The pattern comes from `properties.pattern` (the design pattern) or
 * `properties.formTemplate` (the VS template name); both are fuzzy strings
 * normalized to a canonical pattern. When neither is given we default to
 * SimpleList — the most common shape for a new setup table.
 */
export function buildAxFormXml(formName: string, properties?: Record<string, any>): string {
  const rawPattern = properties?.pattern || properties?.formTemplate;
  const pattern = rawPattern
    ? FormPatternTemplates.normalizePattern(String(rawPattern))
    : 'SimpleList';

  const dsTable = properties?.dataSourceTable || properties?.dataSource || undefined;
  const linesDsTable = properties?.linesDataSourceTable || properties?.linesDataSource;

  // A table written moments ago in this same call is on disk but in no cached
  // listing, so the listing is rebuilt once here — before BOTH lookups below
  // read it, not inside one of them.
  //
  // Measured on this VM (214 packages): ~400 ms to rebuild, ~0–5 ms per lookup
  // afterwards. That is paid once per form create, an operation whose next step
  // is a multi-second compile, and it buys the correct control type for every
  // column plus a `<DataGroup>` that is not dangling — both of which otherwise
  // cost a whole build to discover.
  resetTableXmlIndexCache();

  // The grid binds to a field group through <DataGroup>, exactly as shipped
  // forms do (CustGroup and VendGroup both bind Overview). It is a build error
  // when the table does not declare that group — "Field group 'Overview' does
  // not exist" — and an INCREMENTAL build passes it silently, which is how
  // three captured goldens ended up carrying a dangling one.
  //
  // Only POSITIVE evidence changes anything: `false` here means the table was
  // read and does not declare the group. A table that cannot be read leaves the
  // historical default in place rather than quietly dropping the binding.
  const requestedGroup = typeof properties?.dataGroup === 'string' && properties.dataGroup.trim()
    ? String(properties.dataGroup).trim()
    : 'Overview';
  const declares = dsTable ? tableDeclaresFieldGroup(dsTable, requestedGroup) : undefined;
  const gridDataGroup: string | false | undefined =
    declares === false ? false : (requestedGroup === 'Overview' ? undefined : requestedGroup);

  return FormPatternTemplates.build(pattern, {
    formName,
    dsName: properties?.dataSource || undefined,
    dsTable,
    caption: properties?.caption,
    gridFields: Array.isArray(properties?.gridFields) ? properties.gridFields : undefined,
    linesDsName: properties?.linesDataSource,
    linesDsTable,
    sections: Array.isArray(properties?.sections) ? properties.sections : undefined,
    fieldTypes: resolveFieldTypes(dsTable, properties?.fieldTypes),
    linesFieldTypes: resolveFieldTypes(linesDsTable, properties?.linesFieldTypes),
    gridDataGroup,
  });
}
