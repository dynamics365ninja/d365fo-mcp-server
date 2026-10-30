/**
 * Kernel EDTs — extended data types the X++ runtime defines, with NO AOT metadata element.
 *
 * Shipped tables reference them all the time (`<ExtendedDataType>DataAreaId</ExtendedDataType>`
 * 841 times, `UserId` 331, `RecId` 319, `ValidFromDateTime` 245 …) and standard EDTs extend
 * them (`RefRecId` extends `RecId`, 81 time EDTs extend `TimeOfDay`), but there is no
 * `AxEdt/<Name>.xml` for any of them. So every metadata-backed lookup answers "not found"
 * for a name that compiles: `IMetaEdtProvider.Exists` in the C# bridge, `readEdt`, the
 * symbol index and a disk probe.
 *
 * Treating that as "does not exist" broke valid writes (#1179):
 *   - the bridge's field guard (`RequireExtendedDataTypeExists`) refused `add-field` with
 *     "extended data type 'UserId' does not exist — nothing was written";
 *   - `generate_object(scaffold, table)` refused to write a table with such a field;
 *   - `validate_code(mode="references")` reported `<ExtendedDataType>UserId` as an ERROR;
 *   - the base-type heuristic typed `TimeOfDay`, `FieldId`, `TableId` … fields as String.
 * This module is the one list those paths consult, mirrored by the C# `KernelEdtNames`
 * set in `MetadataWriteService.cs` (a parity test keeps the two equal). It is the EDT
 * counterpart of `kernelEnums.ts`.
 *
 * MEMBERSHIP IS EVIDENCE-BASED. Candidates: every `<ExtendedDataType>` of a field in a
 * shipped AxTable / AxTableExtension / AxView / AxDataEntityView / AxMap, and every EDT
 * `<Extends>`, with no `AxEdt/*.xml` of that name (801 names, K:\AosService\
 * PackagesLocalDirectory, metamodel 7.0.7996.33). Each candidate was then asked of the
 * bridge with `readEdt`: 714 resolved (EDT files the walk missed), 87 answered "Object not
 * found". Those 87, folded case-insensitively, are the 83 entries below. `baseType` is the
 * field type every shipped use agrees on (none disagreed); `uses` is the shipped field count.
 */

import type { AxFieldBaseType } from '../utils/axFieldTypes.js';

/** A kernel EDT and the base type its fields have. */
export interface KernelEdt {
  /** Canonical casing (the spelling shipped metadata uses most). */
  name: string;
  /** Field base type of every shipped field on this EDT; absent when no field uses it. */
  baseType?: AxFieldBaseType;
  /** Shipped table/view/entity/map fields declared on it, for ordering and audit. */
  uses: number;
}

const ENTRIES: KernelEdt[] = [
  { name: 'DataAreaId', baseType: 'String', uses: 841 },
  { name: 'SelectableDataArea', baseType: 'String', uses: 608 },
  { name: 'UserId', baseType: 'String', uses: 331 },
  { name: 'RecId', baseType: 'Int64', uses: 319 },
  { name: 'ValidFromDateTime', baseType: 'UtcDateTime', uses: 245 },
  { name: 'ValidToDateTime', baseType: 'UtcDateTime', uses: 229 },
  { name: 'ValidFromDate', baseType: 'Date', uses: 216 },
  { name: 'ValidToDate', baseType: 'Date', uses: 202 },
  { name: 'TableName', baseType: 'String', uses: 193 },
  { name: 'FieldName', baseType: 'String', uses: 165 },
  { name: 'CreatedDateTime', baseType: 'UtcDateTime', uses: 105 },
  { name: 'RelationType', baseType: 'Int64', uses: 92 },
  { name: 'FieldId', baseType: 'Integer', uses: 86 },
  { name: 'TimeOfDay', baseType: 'Time', uses: 77 },
  { name: 'ClassName', baseType: 'String', uses: 70 },
  { name: 'ClassId', baseType: 'Integer', uses: 66 },
  { name: 'TableId', baseType: 'Integer', uses: 65 },
  { name: 'IdentifierName', baseType: 'String', uses: 47 },
  { name: 'SecurityRoleAotName', baseType: 'String', uses: 45 },
  { name: 'ModifiedDateTime', baseType: 'UtcDateTime', uses: 39 },
  { name: 'SecurityRoleName', baseType: 'String', uses: 38 },
  { name: 'CreatedBy', baseType: 'String', uses: 38 },
  { name: 'EnumName', baseType: 'String', uses: 37 },
  { name: 'SysRowVersionNumber', baseType: 'Int64', uses: 36 },
  { name: 'CreatedTransactionId', baseType: 'Int64', uses: 25 },
  { name: 'NetworkAlias', baseType: 'String', uses: 22 },
  { name: 'ExtendedTypeId', baseType: 'Integer', uses: 21 },
  { name: 'PartitionKey', baseType: 'String', uses: 20 },
  { name: 'UtilElementName', baseType: 'String', uses: 20 },
  { name: 'UserIdStr', baseType: 'String', uses: 19 },
  { name: 'MethodName', baseType: 'String', uses: 18 },
  { name: 'RecVersion', baseType: 'Integer', uses: 15 },
  { name: 'InstalledLanguageId', baseType: 'String', uses: 15 },
  { name: 'NetworkDomain', baseType: 'String', uses: 15 },
  { name: 'ModifiedBy', baseType: 'String', uses: 14 },
  { name: 'FormName', baseType: 'String', uses: 11 },
  { name: 'QueryName', baseType: 'String', uses: 11 },
  { name: 'SequenceNum', baseType: 'Int64', uses: 11 },
  { name: 'EnumId', baseType: 'Integer', uses: 10 },
  { name: 'SecurityDutyName', baseType: 'String', uses: 10 },
  { name: 'ConfigurationKeyName', baseType: 'String', uses: 9 },
  { name: 'SecurityDutyIdentifier', baseType: 'String', uses: 9 },
  { name: 'MenuItemName', baseType: 'String', uses: 8 },
  { name: 'ReportName', baseType: 'String', uses: 8 },
  { name: 'ResourceName', baseType: 'String', uses: 7 },
  { name: 'ConfigurationKeyId', baseType: 'Integer', uses: 7 },
  { name: 'ExtendedDataTypeName', baseType: 'String', uses: 7 },
  { name: 'Partition', baseType: 'Int64', uses: 7 },
  { name: 'MoneyMST', baseType: 'Real', uses: 7 },
  { name: 'UtilElementId', baseType: 'Integer', uses: 6 },
  { name: 'Sid', baseType: 'String', uses: 6 },
  { name: 'SecurityPrivilegeName', baseType: 'String', uses: 5 },
  { name: 'SecurityPrivilegeIdentifier', baseType: 'String', uses: 4 },
  { name: 'SecurableName', baseType: 'String', uses: 4 },
  { name: 'SecurityRoleDescription', baseType: 'String', uses: 4 },
  { name: 'MetadataXmlObject', baseType: 'String', uses: 3 },
  { name: 'PreferredLocale', baseType: 'String', uses: 3 },
  { name: 'WorkflowCategoryName', baseType: 'String', uses: 3 },
  { name: 'MenuItemNameDisplay', baseType: 'String', uses: 3 },
  { name: 'WorkflowTypeName', baseType: 'String', uses: 3 },
  { name: 'LicenseCodeId', baseType: 'Integer', uses: 2 },
  { name: 'SegregationOfDutiesRuleName', baseType: 'String', uses: 2 },
  { name: 'IndexName', baseType: 'String', uses: 2 },
  { name: 'RowNumber', baseType: 'Integer', uses: 2 },
  { name: 'ModelName', baseType: 'String', uses: 1 },
  { name: 'WebUrlItemName', baseType: 'String', uses: 1 },
  { name: 'MenuItemNameAction', baseType: 'String', uses: 1 },
  { name: 'DeploymentRecId', baseType: 'Int64', uses: 1 },
  { name: 'MenuItemNameOutput', baseType: 'String', uses: 1 },
  { name: 'ServiceName', baseType: 'String', uses: 1 },
  { name: 'TableCollectionName', baseType: 'String', uses: 1 },
  { name: 'ModelElementRecid', baseType: 'Int64', uses: 1 },
  { name: 'SecurityRisk', baseType: 'String', uses: 1 },
  { name: 'SecurityMitigation', baseType: 'String', uses: 1 },
  { name: 'SegregationOfDutiesOverrideComment', baseType: 'String', uses: 1 },
  { name: 'TitleFields', baseType: 'String', uses: 1 },
  { name: 'GlobalObjectCacheScope', baseType: 'String', uses: 1 },
  { name: 'WorkflowApprovalName', baseType: 'String', uses: 1 },
  { name: 'Money', baseType: 'Real', uses: 1 },
  { name: 'AssemblyName', baseType: 'String', uses: 1 },
  { name: 'SecurityDutyDescription', baseType: 'String', uses: 1 },
  { name: 'SegmentedEntryField', uses: 0 },
  { name: 'Sha1HashCode', baseType: 'Container', uses: 0 },
];

const BY_NAME = new Map(ENTRIES.map(e => [e.name.toLowerCase(), e]));

/** Lower-cased names, for set-membership checks. */
export const KERNEL_EDT_NAMES: ReadonlySet<string> = new Set(BY_NAME.keys());

/** Every kernel EDT, most-used first. */
export function kernelEdts(): readonly KernelEdt[] {
  return ENTRIES;
}

/** The kernel EDT of this name (case-insensitive), or undefined. */
export function getKernelEdt(name: string | undefined | null): KernelEdt | undefined {
  if (!name) return undefined;
  return BY_NAME.get(name.trim().toLowerCase());
}

/** True when the runtime defines this EDT although no AOT element does. */
export function isKernelEdt(name: string | undefined | null): boolean {
  return getKernelEdt(name) !== undefined;
}

/** Field base type of a kernel EDT, or undefined (not kernel, or no shipped field uses it). */
export function kernelEdtBaseType(name: string | undefined | null): AxFieldBaseType | undefined {
  return getKernelEdt(name)?.baseType;
}

/**
 * get_object_info's answer for a kernel EDT, which no reader can find: what it is, that
 * it is valid to use, and its base type. Null for any other name.
 */
export function describeKernelEdt(name: string): string | null {
  const entry = getKernelEdt(name);
  if (!entry) return null;
  return [
    `# EDT: ${entry.name} (kernel EDT)`,
    '',
    `\`${entry.name}\` is defined by the X++ runtime, not by an AOT element. There is no ` +
    `\`AxEdt/${entry.name}.xml\` in any package, so the bridge, the symbol index and a disk ` +
    `probe all correctly fail to find one, and there is nothing to index.`,
    '',
    `**It is valid to use.** \`<ExtendedDataType>${entry.name}</ExtendedDataType>\` on a field ` +
    `and \`<Extends>${entry.name}</Extends>\` on an EDT both compile` +
    (entry.uses > 0 ? ` (${entry.uses} shipped fields use it).` : '.'),
    ...(entry.baseType
      ? ['', `**Base type:** ${entry.baseType} — a field on it is \`AxTableField${entry.baseType === 'Integer' ? 'Int' : entry.baseType}\`.`]
      : []),
  ].join('\n');
}
