/**
 * Create the staging table a data entity with data management enabled names.
 *
 * `d365fo_file(action="create", objectType="data-entity")` with
 * dataManagementEnabled=true writes <DataManagementStagingTable>. Nothing
 * created that table, so the next build failed with a missing-table error and
 * the reply could only warn about it. This step runs right after the entity is
 * written and creates the table Visual Studio would have generated with it
 * (xml/dataEntityStagingTableXml.ts has the shape).
 *
 * It reads the entity as it was WRITTEN, so the label, the fields and the key
 * are the ones on disk. Each public entity field becomes one staging field with
 * the type of the table field it maps to:
 *
 *   - from the data source table's own XML when the symbol index knows where
 *     that file is (the exact field element, EDT, enum and string size);
 *   - otherwise from the index: the field's EDT or enum, and for an EDT the
 *     base type its chain resolves to.
 *
 * A type is never guessed. A field whose type cannot be resolved is left out
 * and named in the reply, and the table is still created so the entity builds.
 *
 * The table goes through the same create handler as any other table (passed in
 * as `create`, the way fieldTypeProvisioning.ts creates its EDTs and enums), so
 * naming, the project file, the symbol index, the best-practice defaults and
 * the undo ledger all apply to it. A table of that name that already exists is
 * left as is. autoCorrect=false keeps the create to the entity alone.
 */

import * as fs from 'fs/promises';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import type { XppServerContext } from '../../types/context.js';
import type { CreateOutcome } from './createD365File.js';
import { stagingTableNote } from '../xml/dataEntityXml.js';
import {
  buildStagingTableXml, readEntityForStaging, DMF_STAGING_FIELDS,
  type StagingEntityField, type StagingEntityInfo, type StagingTableField,
} from '../xml/dataEntityStagingTableXml.js';
import { resolveEdtBaseType } from '../smart/generateSmartTable.js';
import { isKernelEdt } from '../../knowledge/kernelEdts.js';
import { axTableFieldElement, normalizeFieldBaseType } from '../../utils/axFieldTypes.js';
import { lookupSymbolsNocase, type DbLike } from '../../utils/symbolLookup.js';
import { findD365FileViaIndex } from '../../utils/objectFileLookup.js';
import { normalizeObjectName } from '../../utils/objectNaming.js';

type CreateContext = Partial<Pick<XppServerContext, 'symbolIndex' | 'bridge'>>;
type CreateResult = { content: Array<{ type: string; text: string }>; isError?: boolean };
type CreateFn = (request: CallToolRequest, context?: any, outcome?: CreateOutcome) => Promise<CreateResult>;

/** The entity create this step follows. */
export interface StagingProvisionInput {
  /** The entity's name as written. */
  entityName: string;
  /** The entity file the create just wrote. */
  entityPath: string;
  modelName: string;
  /** The entity create's arguments: its model, package and project settings are passed on. */
  args: {
    properties?: unknown;
    autoCorrect?: unknown;
    packageName?: unknown;
    packagePath?: unknown;
    addToProject?: unknown;
    projectPath?: unknown;
    solutionPath?: unknown;
  };
}

/** A staging field, or why there is none. */
export type StagingFieldResolution = { field: StagingTableField } | { reason: string };

function readDb(context: CreateContext | undefined): DbLike | undefined {
  try {
    return context?.symbolIndex?.getReadDb?.() as DbLike | undefined;
  } catch {
    return undefined;
  }
}

/** The enum an enum-based EDT (or one that extends it) is bound to. */
function edtEnumType(db: DbLike, edt: string, depth = 0): string | undefined {
  if (depth > 8) return undefined;
  try {
    const row = db.prepare(`SELECT extends, enum_type FROM edt_metadata WHERE edt_name = ? LIMIT 1`).get(edt) as
      { extends: string | null; enum_type: string | null } | undefined;
    if (!row) return undefined;
    return row.enum_type || (row.extends ? edtEnumType(db, row.extends, depth + 1) : undefined);
  } catch {
    return undefined;
  }
}

function hasSymbol(db: DbLike, name: string, type: string): boolean {
  try {
    return lookupSymbolsNocase(db, name, { types: [type], limit: 1 }).length > 0;
  } catch {
    return false;
  }
}

/** The staging field for an EDT or enum NAME, as the index knows it. */
function fieldFromTypeName(db: DbLike | undefined, name: string, typeName: string): StagingFieldResolution {
  if (db && hasSymbol(db, typeName, 'enum')) {
    return { field: { name, fieldType: 'AxTableFieldEnum', enumType: typeName } };
  }
  if (!isKernelEdt(typeName) && !(db && hasSymbol(db, typeName, 'edt'))) {
    return { reason: `type ${typeName} is not in the symbol index` };
  }
  const base = normalizeFieldBaseType(resolveEdtBaseType(typeName, db));
  if (!base) return { reason: `the base type of EDT ${typeName} is not in the symbol index` };
  if (base !== 'Enum') return { field: { name, fieldType: axTableFieldElement(base), extendedDataType: typeName } };
  const enumType = db ? edtEnumType(db, typeName) : undefined;
  return enumType
    ? { field: { name, fieldType: 'AxTableFieldEnum', extendedDataType: typeName, enumType } }
    : { reason: `the enum behind EDT ${typeName} is not in the symbol index` };
}

/** `<AxTableField>` named `fieldName` in a table document: its i:type and the children a staging field copies. */
function readTableField(tableXml: string, fieldName: string): { fieldType: string; body: string } | undefined {
  const escaped = fieldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(
    `<AxTableField\\b[^>]*?i:type="(AxTableField\\w+)"[^>]*>\\s*<Name>${escaped}</Name>([\\s\\S]*?)</AxTableField>`, 'i',
  ).exec(tableXml);
  return m ? { fieldType: m[1], body: m[2] } : undefined;
}

const child = (body: string, name: string): string | undefined =>
  new RegExp(`<${name}>\\s*([^<]+?)\\s*</${name}>`).exec(body)?.[1];

/**
 * Resolve the staging field of every public entity field. `loadTableXml` returns
 * the XML of a data source's table, or undefined when it cannot be read.
 */
export async function resolveStagingFields(
  entity: StagingEntityInfo,
  db: DbLike | undefined,
  loadTableXml: (table: string) => Promise<string | undefined>,
): Promise<Array<{ entityField: StagingEntityField; resolution: StagingFieldResolution }>> {
  const dmf = new Set(DMF_STAGING_FIELDS.map(n => n.toLowerCase()));
  const out: Array<{ entityField: StagingEntityField; resolution: StagingFieldResolution }> = [];
  for (const f of entity.fields) {
    if (f.isPrivate) continue;
    let resolution: StagingFieldResolution;
    if (dmf.has(f.name.toLowerCase())) {
      resolution = { reason: 'the name is taken by a DMF field of the staging table' };
    } else if (/^AxDataEntityViewMappedField$/i.test(f.iType)) {
      resolution = await resolveMappedField(entity, f, db, loadTableXml);
    } else {
      resolution = resolveUnmappedField(f, db);
    }
    if ('field' in resolution && f.label) resolution.field.label = f.label;
    out.push({ entityField: f, resolution });
  }
  return out;
}

async function resolveMappedField(
  entity: StagingEntityInfo,
  f: StagingEntityField,
  db: DbLike | undefined,
  loadTableXml: (table: string) => Promise<string | undefined>,
): Promise<StagingFieldResolution> {
  const table = f.dataSource ? entity.dataSources.get(f.dataSource.toLowerCase()) : undefined;
  if (!table || !f.dataField) return { reason: `its data source ${f.dataSource ?? '(none)'} is not in the entity's query` };
  const source = `${table}.${f.dataField}`;

  const tableXml = await loadTableXml(table);
  const onDisk = tableXml ? readTableField(tableXml, f.dataField) : undefined;
  if (onDisk) {
    const extendedDataType = child(onDisk.body, 'ExtendedDataType');
    const enumType = child(onDisk.body, 'EnumType') ?? (extendedDataType && db ? edtEnumType(db, extendedDataType) : undefined);
    if (onDisk.fieldType === 'AxTableFieldEnum' && !enumType) return { reason: `${source} is an enum field without an EnumType` };
    return {
      field: {
        name: f.name, fieldType: onDisk.fieldType, extendedDataType, enumType,
        label: child(onDisk.body, 'Label'), stringSize: child(onDisk.body, 'StringSize'),
      },
    };
  }

  if (!db) return { reason: `${source}: the symbol index is not available` };
  let signature: string | undefined;
  try {
    const canonical = lookupSymbolsNocase(db, table, { types: ['table'], limit: 1 })[0]?.name ?? table;
    signature = (db.prepare(
      `SELECT signature FROM symbols WHERE type = 'field' AND parent_name = ? AND name = ? COLLATE NOCASE LIMIT 1`,
    ).get(canonical, f.dataField) as { signature: string | null } | undefined)?.signature?.trim() || undefined;
  } catch {
    signature = undefined;
  }
  if (!signature) return { reason: `${source} is not in the symbol index` };

  // The index stores the bare base type for a field that has neither an EDT nor an enum.
  const primitive = hasSymbol(db, signature, 'edt') || hasSymbol(db, signature, 'enum') || isKernelEdt(signature)
    ? undefined
    : normalizeFieldBaseType(signature);
  if (primitive === 'Enum') return { reason: `${source} is an enum field and the index does not say which enum` };
  if (primitive === 'String') return { reason: `${source} is a string without an EDT, so its size is unknown` };
  if (primitive) return { field: { name: f.name, fieldType: axTableFieldElement(primitive) } };
  const typed = fieldFromTypeName(db, f.name, signature);
  return 'reason' in typed ? { reason: `${source}: ${typed.reason}` } : typed;
}

/** An unmapped (computed) field declares its own type: the i:type suffix, an EDT or an enum. */
function resolveUnmappedField(f: StagingEntityField, db: DbLike | undefined): StagingFieldResolution {
  const base = normalizeFieldBaseType(f.iType.replace(/^AxDataEntityViewUnmappedField/i, ''));
  if (base === 'Enum') {
    const enumType = f.enumType ?? (f.extendedDataType && db ? edtEnumType(db, f.extendedDataType) : undefined);
    return enumType
      ? { field: { name: f.name, fieldType: 'AxTableFieldEnum', extendedDataType: f.extendedDataType, enumType } }
      : { reason: 'it is a computed enum field without an EnumType' };
  }
  if (base) {
    return { field: { name: f.name, fieldType: axTableFieldElement(base), extendedDataType: f.extendedDataType, stringSize: f.stringSize } };
  }
  if (f.enumType) return { field: { name: f.name, fieldType: 'AxTableFieldEnum', enumType: f.enumType } };
  if (f.extendedDataType) return fieldFromTypeName(db, f.name, f.extendedDataType);
  return { reason: 'it is a computed field with no type on the entity' };
}

const textOf = (r: CreateResult | undefined): string => (r?.content ?? []).map(c => c.text ?? '').join('\n');

/**
 * Create the staging table of the entity at `input.entityPath` when it has data
 * management enabled. Returns the lines for the entity create's reply: what was
 * created and what is still to do, the old warning when nothing was created, or
 * '' when the entity has no data management.
 */
export async function provisionStagingTable(
  input: StagingProvisionInput,
  context: CreateContext | undefined,
  create: CreateFn,
): Promise<string> {
  const props = input.args.properties as Record<string, any> | undefined;
  let entity: StagingEntityInfo | undefined;
  try {
    entity = readEntityForStaging(await fs.readFile(input.entityPath, 'utf-8'));
  } catch {
    entity = undefined;
  }
  // The entity could not be read back: say what the arguments alone tell.
  if (!entity) return stagingTableNote(input.entityName, props);
  if (!entity.dataManagementEnabled || !entity.stagingTable) return '';

  const staging = entity.stagingTable;
  const warning = stagingTableNote(input.entityName, { dataManagementEnabled: true, dataManagementStagingTable: staging });
  const notCreated = (why: string): string => `${warning}\n   It was not created for you: ${why}`;

  if (input.args.autoCorrect === false) return notCreated('autoCorrect=false keeps this create to the entity.');

  const db = readDb(context);
  const existing = db ? (() => {
    try { return lookupSymbolsNocase(db, staging, { types: ['table'], limit: 1 })[0]; } catch { return undefined; }
  })() : undefined;
  const leftAsIs = (where: string): string =>
    `\nℹ️ Staging table ${staging} already exists${where} and was left as is. It needs the DMF fields, one field per ` +
    `public entity field, the index StagingIdx and the DataEntity relation to ${input.entityName}.`;
  if (existing) return leftAsIs(existing.model ? ` (model ${existing.model})` : '');

  const writtenAs = normalizeObjectName(staging, 'table', input.modelName);
  if (writtenAs !== staging) {
    return notCreated(
      `this model's naming rules would write the table as ${writtenAs}, not the ${staging} the entity names. ` +
      `Name it in properties.dataManagementStagingTable, or create it yourself.`);
  }

  const tableXmlCache = new Map<string, Promise<string | undefined>>();
  const loadTableXml = (table: string): Promise<string | undefined> => {
    const key = table.toLowerCase();
    let pending = tableXmlCache.get(key);
    if (!pending) {
      pending = (async () => {
        if (!db || !context?.symbolIndex) return undefined;
        try {
          const canonical = lookupSymbolsNocase(db, table, { types: ['table'], limit: 1 })[0]?.name;
          const file = canonical ? await findD365FileViaIndex(context.symbolIndex as any, 'table', canonical) : null;
          return file ? await fs.readFile(file.filePath, 'utf-8') : undefined;
        } catch {
          return undefined;
        }
      })();
      tableXmlCache.set(key, pending);
    }
    return pending;
  };

  const resolved = await resolveStagingFields(entity, db, loadTableXml);
  const fields = resolved.flatMap(r => ('field' in r.resolution ? [r.resolution.field] : []));
  const missing = resolved.flatMap(r => ('reason' in r.resolution ? [{ name: r.entityField.name, reason: r.resolution.reason }] : []));
  const has = new Set(fields.map(f => f.name.toLowerCase()));
  const keyFields = entity.keyFields.filter(k => has.has(k.toLowerCase()));
  const missingKeys = entity.keyFields.filter(k => !has.has(k.toLowerCase()));

  const xmlContent = buildStagingTableXml({
    tableName: staging,
    entityName: entity.name,
    label: entity.label,
    configurationKey: entity.configurationKey,
    formRef: entity.formRef,
    fields,
    keyFields,
    autoReportFields: entity.autoReportFields,
  });

  const outcome: CreateOutcome = {};
  let created: CreateResult;
  try {
    created = await create(
      {
        method: 'tools/call',
        params: {
          name: 'create_d365fo_file',
          arguments: {
            objectType: 'table',
            objectName: staging,
            xmlContent,
            modelName: input.modelName,
            packageName: input.args.packageName,
            packagePath: input.args.packagePath,
            addToProject: input.args.addToProject,
            projectPath: input.args.projectPath,
            solutionPath: input.args.solutionPath,
          },
        },
      },
      context,
      outcome,
    );
  } catch (e) {
    return notCreated(e instanceof Error ? e.message : String(e));
  }
  if (outcome.alreadyExisted) return leftAsIs(outcome.filePath ? ` on disk (${outcome.filePath})` : ' on disk');
  const reply = textOf(created);
  if (created?.isError || outcome.finalObjectName !== staging) {
    return notCreated(reply.split('\n').find(l => l.trim()) ?? 'the table create failed.');
  }

  const inProject = /Added to project|Already referenced by project/.test(reply);
  const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many);
  return (
    `\n✅ Staging table ${staging} created: ${fields.length + DMF_STAGING_FIELDS.length} fields ` +
    `(the ${DMF_STAGING_FIELDS.length} DMF fields and ${fields.length} of ${resolved.length} public entity ` +
    `${plural(resolved.length, 'field', 'fields')}), index StagingIdx on ${['DefinitionGroup', 'ExecutionId', ...keyFields].join(', ')}, ` +
    `relation DataEntity to ${entity.name}${inProject ? ', added to the project' : ''}.` +
    (outcome.filePath ? `\n📁 ${outcome.filePath}` : '') +
    (input.args.addToProject && !inProject
      ? `\n⚠️ ${staging} was not added to the project. Add it before the build.`
      : '') +
    (missing.length
      ? `\n⚠️ ${missing.length} entity ${plural(missing.length, 'field was', 'fields were')} left out of ${staging} because the type ` +
        `could not be resolved. Add ${plural(missing.length, 'it', 'them')} with add-field, using the EDT or enum of the entity field: ` +
        `${missing.map(m => `${m.name} (${m.reason})`).join(', ')}.`
      : '') +
    (missingKeys.length
      ? `\n⚠️ ${missingKeys.join(', ')} ${plural(missingKeys.length, 'is an entity key field', 'are entity key fields')}: after adding ` +
        `${plural(missingKeys.length, 'it', 'them')}, also add ${plural(missingKeys.length, 'it', 'them')} to the index StagingIdx and to the DataEntity relation.`
      : '')
  );
}
