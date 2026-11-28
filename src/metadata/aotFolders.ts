/**
 * Object type → the Ax* metadata folder its XML lives in, inside the model folder:
 * <Package>/<Model>/<AxFolder>/<Name>.xml.
 *
 * One copy for the writer, the project registration and the on-disk lookup. These
 * used to keep their own maps, and the lookup's had fallen behind: it knew 30 of the
 * create tool's object types, so `project add-object` answered "no such file on
 * disk" for a security policy, configuration key, license code or macro that the
 * create tool had just written there.
 *
 * Every objectType `d365fo_file(action="create")` accepts has an entry, except
 * `model-descriptor`, which is not inside a model folder (see
 * findModelDescriptorPath). tests/metadata/aotFolders.test.ts holds the two lists
 * together.
 */
export const AOT_FOLDER_BY_OBJECT_TYPE: Readonly<Record<string, string>> = {
  class: 'AxClass',
  'class-extension': 'AxClass',
  'business-event': 'AxClass',
  table: 'AxTable',
  'table-extension': 'AxTableExtension',
  enum: 'AxEnum',
  'enum-extension': 'AxEnumExtension',
  edt: 'AxEdt',
  'edt-extension': 'AxEdtExtension',
  form: 'AxForm',
  'form-extension': 'AxFormExtension',
  query: 'AxQuery',
  view: 'AxView',
  map: 'AxMap',
  'data-entity': 'AxDataEntityView',
  'data-entity-extension': 'AxDataEntityViewExtension',
  report: 'AxReport',
  'menu-item-display': 'AxMenuItemDisplay',
  'menu-item-action': 'AxMenuItemAction',
  'menu-item-output': 'AxMenuItemOutput',
  'menu-item-display-extension': 'AxMenuItemDisplayExtension',
  'menu-item-action-extension': 'AxMenuItemActionExtension',
  'menu-item-output-extension': 'AxMenuItemOutputExtension',
  menu: 'AxMenu',
  'menu-extension': 'AxMenuExtension',
  'security-privilege': 'AxSecurityPrivilege',
  'security-duty': 'AxSecurityDuty',
  'security-role': 'AxSecurityRole',
  'security-duty-extension': 'AxSecurityDutyExtension',
  'security-role-extension': 'AxSecurityRoleExtension',
  'security-policy': 'AxSecurityPolicy',
  tile: 'AxTile',
  kpi: 'AxKPI',
  service: 'AxService',
  'service-group': 'AxServiceGroup',
  macro: 'AxMacroDictionary',
  'configuration-key': 'AxConfigurationKey',
  'license-code': 'AxLicenseCode',
  'aggregate-measurement': 'AxAggregateMeasurement',
  'ignore-diagnostic-list': 'AxIgnoreDiagnosticList',
};

/** The Ax* folder of an object type, or undefined for a type that has none. */
export function aotFolderFor(objectType: string): string | undefined {
  return Object.hasOwn(AOT_FOLDER_BY_OBJECT_TYPE, objectType)
    ? AOT_FOLDER_BY_OBJECT_TYPE[objectType]
    : undefined;
}
