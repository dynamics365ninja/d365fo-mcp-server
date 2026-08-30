/**
 * D365FO File Creator Tool
 * Creates physical XML files in the AOT package structure
 */

import * as fs from 'fs/promises';
import { directXmlSetIndexValidTimeState, coerceNoYesFlag } from './directXmlWriters.js';
import { writeFileAtomic } from '../../utils/atomicFileWrite.js';
import { XmlTemplateGenerator } from '../xml/xmlTemplateGenerator.js';
import * as path from 'path';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { getConfigManager, fallbackPackagePath } from '../../utils/configManager.js';
import { describePackagesRootScan } from '../../utils/packagesRoot.js';
import { upsertWrittenFileIntoIndex } from './inlineIndexUpsert.js';
import { ProjectFileManager, ProjectFileFinder, registerFileInActiveProject } from '../../workspace/projectFile.js';
import { verifyWrittenFile, renderWriteVerification, runInlineBpCheck, membershipOf, renderBatchEditHint } from './inlineWriteVerification.js';
import { validateWrittenXpp } from './inlineXppValidation.js';
import { createPhaseTimer } from '../../utils/phaseTimer.js';
import { registerCustomModel } from '../../utils/modelClassifier.js';
import { normalizeObjectName } from '../../utils/objectNaming.js';
import { PackageResolver } from '../../utils/packageResolver.js';
import { crossModelWriteRefusal, standDownNotice } from '../../utils/crossModelWriteGuard.js';
import { resolveAnchorModel } from './writeAnchorGuard.js';
import { xppMethodSourceForXml } from '../../utils/xppFormat.js';
import { bridgeValidateAfterWrite, canBridgeCreate, bridgeCreateObject, bridgeCreateSmartTable, isBridgeFailure, describeBridgeFailure } from '../../bridge/index.js';
import type { BridgeFailure } from '../../bridge/index.js';
import * as debouncedRefresh from '../../bridge/debouncedRefresh.js';
import { enforceGrounding } from '../../utils/provenanceStore.js';
import { gateOnFormPatternErrors, isFormPatternEnforceEnabled } from '../analysis/validateFormPattern.js';
import { validateFormExtensionControlShape, buildFormExtensionShapeError } from '../../utils/formExtensionShapeValidator.js';
import { gateOnReferenceErrors } from './resolveReferences.js';
import { normalizeD365Xml } from '../../utils/d365XmlNormalizer.js';
import { resolveEdtBaseType, resolveEdtEnumType, heuristicEdtBaseType, isEnumName, bridgeEdtBaseType } from '../smart/generateSmartTable.js';
import { recordCreatedArtifact } from '../../workspace/createdArtifactLedger.js';
import { resolveOrCreateLabelRef, type AutoLabelTarget } from './createLabel.js';
import { isRawLabelText } from '../../utils/labelReference.js';
import { sayOncePerSession } from '../../utils/repeatedNotes.js';
import {
  reconcileTableCreateProperties,
  renderTableCreateHonestyReport,
} from '../xml/createTablePropertyHonesty.js';


/**
 * Builds the "no projectPath could be resolved" warning shown when
 * addToProject=true but neither projectPath/solutionPath nor auto-detection
 * produced a usable path. When multiple .rnrproj files exist in the workspace,
 * auto-detection deliberately refuses to guess between them (see
 * workspaceDetector.ts detectD365Project) — list the candidates so the caller
 * knows to pass projectPath explicitly instead of silently landing on the
 * wrong project.
 */
/**
 * Once-per-session wrapper around the full warning.
 *
 * Measured: the block below rode on EVERY create in a project-less workspace
 * (~230 chars each time). It states a fact about the WORKSPACE, not about the
 * object just written, so repeating it verbatim on the twentieth create tells
 * the caller nothing it did not already have - and every one of those bytes is
 * re-read by every later request in the session. First occurrence stays whole;
 * later ones shrink to a pointer. See src/utils/repeatedNotes.ts.
 *
 * Scoped by the candidate situation rather than the model: the two branches
 * below say different things, and a workspace can move from one to the other
 * when a project is configured mid-session.
 */
function buildNoProjectPathWarning(): string {
  const candidates = getConfigManager().getWorkspaceProjectCandidates();
  // Keyed by the candidate PATHS, not their count: two different workspaces that
  // happen to have the same number of .rnrproj files would otherwise share one
  // key, and the second would never see its own candidate list.
  const scope = candidates.length > 1
    ? `ambiguous:${candidates.map(c => c.projectPath ?? c.modelName).sort().join('|')}`
    : 'none';
  return sayOncePerSession(
    'no-project-path',
    scope,
    buildNoProjectPathWarningFull(),
    `\n⚠️ Not added to a project (no projectPath resolved \u2014 see the first create in this session).\n`,
  );
}

function buildNoProjectPathWarningFull(): string {
  // The WORKSPACE candidates, not getAllDetectedProjects(): under
  // D365FO_SOLUTIONS_PATH the latter lists every project across every solution,
  // which would put a wrong count behind "in this workspace" and can run to
  // dozens of lines in what should be a short, actionable warning.
  const candidates = getConfigManager().getWorkspaceProjectCandidates();
  if (candidates.length > 1) {
    return `\n⚠️ addToProject=true but no projectPath could be resolved: ${candidates.length} .rnrproj ` +
      `files were found in this workspace and none matched unambiguously.\n` +
      `The file was created on disk but was NOT added to any Visual Studio project.\n\n` +
      `Pass projectPath explicitly to target the right one:\n` +
      candidates.map(c => `   - ${c.modelName}: ${c.projectPath ?? '(no .rnrproj)'}`).join('\n') + '\n';
  }
  // Same refusal, other route: the SOLUTIONS-PATH scan resolved the model and
  // stopped short of choosing between the projects that build it. Those were
  // recorded and then never shown — the caller got the generic message below and
  // no way to know a choice was all that was missing.
  const ambiguous = getConfigManager().getAmbiguousProjectPaths();
  if (ambiguous.length > 1) {
    const model = getConfigManager().getModelName() ?? 'this model';
    return `\n⚠️ addToProject=true but no projectPath could be resolved: ${ambiguous.length} projects ` +
      `build model "${model}" and none was auto-selected.\n` +
      `The file was created on disk but was NOT added to any Visual Studio project.\n\n` +
      `Pass projectPath explicitly to target the right one:\n` +
      ambiguous.slice(0, 10).map(pp => `   - ${pp}`).join('\n') +
      (ambiguous.length > 10 ? `\n   … and ${ambiguous.length - 10} more` : '') + '\n';
  }
  // The .mcp.json shape was five lines of JSON in a warning the caller usually
  // resolves by just passing projectPath; naming the key is enough.
  return `\n⚠️ addToProject=true but no projectPath could be resolved.\n` +
    `The file was created on disk but was NOT added to any Visual Studio project.\n` +
    `Pass projectPath explicitly, or set servers.context.projectPath in .mcp.json.\n`;
}

/**
 * The `d365fo_file(action="modify", …, operations:[…])` call that carries the
 * SAME entries the refused create was carrying.
 *
 * A create that lands on an existing object used to answer with three generic
 * retry options ("pass overwrite=true", "use modify", "pick another name"), and
 * the one the caller actually wants — apply these exact fields/indexes/values to
 * the object that is already there — was none of them. Naming `modify` without
 * its operations buys a discovery round trip: the caller must go and look the
 * per-operation parameter names up (they are NOT the create spelling: an EDT is
 * `fieldType` here, an index's fields are objects, …) before it can retry. So
 * the translation is done here, where both spellings are already known, and the
 * answer is one copy-paste rather than one more call.
 *
 * Method sources are named but not re-emitted: the caller is holding the X++ it
 * just passed, and inlining it again would put the whole class into a response
 * that is then re-billed on every later request in the session.
 */
export function renderEquivalentModifyCall(
  objectType: string,
  objectName: string,
  args: { properties?: Record<string, any>; sourceCode?: string },
): string {
  const ops: Record<string, unknown>[] = [];
  const props = args.properties ?? {};

  const put = (o: Record<string, unknown>, k: string, v: unknown) => {
    if (v !== undefined && v !== null && v !== '') o[k] = v;
  };

  for (const f of Array.isArray(props.fields) ? props.fields : []) {
    const op: Record<string, unknown> = { operation: 'add-field', fieldName: f?.name ?? f?.fieldName };
    if (f?.enumType) {
      // An enum-typed field is an AxTableFieldEnum: fieldEnumType and NO fieldType.
      put(op, 'fieldEnumType', f.enumType);
    } else {
      // `fieldType` on modify is the EDT name; the base-type keyword create takes
      // as `type` is `fieldBaseType` there.
      const edt = f?.edt ?? f?.extendedDataType;
      put(op, 'fieldType', edt);
      if (!edt) put(op, 'fieldBaseType', f?.type ?? f?.fieldType);
    }
    put(op, 'fieldMandatory', f?.mandatory);
    put(op, 'fieldLabel', f?.label);
    ops.push(op);
  }

  for (const g of Array.isArray(props.fieldGroups) ? props.fieldGroups : []) {
    const op: Record<string, unknown> = { operation: 'add-field-group', fieldGroupName: g?.name ?? g?.fieldGroupName };
    put(op, 'fieldGroupFields', g?.fields ?? g?.fieldGroupFields);
    put(op, 'fieldGroupLabel', g?.label);
    ops.push(op);
  }

  for (const idx of Array.isArray(props.indexes) ? props.indexes : []) {
    const raw = idx?.fields ?? idx?.indexFields;
    const op: Record<string, unknown> = { operation: 'add-index', indexName: idx?.name ?? idx?.indexName };
    if (Array.isArray(raw)) {
      op.indexFields = raw.map((f: any) => (typeof f === 'string' ? { fieldName: f } : f));
    }
    put(op, 'indexAllowDuplicates', idx?.allowDuplicates);
    put(op, 'indexAlternateKey', idx?.alternateKey);
    put(op, 'indexValidTimeStateKey', idx?.validTimeStateKey);
    put(op, 'indexValidTimeStateMode', idx?.validTimeStateMode);
    ops.push(op);
  }

  for (const r of Array.isArray(props.relations) ? props.relations : []) {
    const op: Record<string, unknown> = { operation: 'add-relation', relationName: r?.name ?? r?.relationName };
    put(op, 'relatedTable', r?.relatedTable);
    put(op, 'relationConstraints', r?.constraints ?? r?.relationConstraints);
    ops.push(op);
  }

  for (const v of Array.isArray(props.enumValues) ? props.enumValues : []) {
    const op: Record<string, unknown> = { operation: 'add-enum-value', enumValueName: v?.name ?? v?.enumValueName };
    put(op, 'enumValueLabel', v?.label);
    put(op, 'enumValueHelpText', v?.helpText);
    put(op, 'enumValueInt', v?.value);
    ops.push(op);
  }

  if (args.sourceCode?.trim()) {
    const { methods } = XmlTemplateGenerator.splitXppClassSource(args.sourceCode);
    for (const m of methods) {
      ops.push({ operation: 'add-method', methodName: m.name, sourceCode: `<the X++ you passed for ${m.name}>` });
    }
  }

  // Scalar properties, but ONLY the ones that are genuinely an XML element on
  // the object. `modify-property`'s propertyPath is the element NAME (`Label`,
  // `TableGroup`, …) — not the camelCase create key, and not every create key
  // has an element at all: `dataSource` on a query builds a whole
  // <DataSources> collection, `pattern`/`formTemplate` on a form pick a
  // template. Rendering those as modify-property would hand back a call that
  // fails, which is worse than not offering one, so an allowlist it is; the
  // collections above are where the real re-spelling cost lives anyway.
  const PROPERTY_ELEMENTS: Record<string, string> = {
    label: 'Label', helpText: 'HelpText', configurationKey: 'ConfigurationKey',
    extends: 'Extends', tableGroup: 'TableGroup', tableType: 'TableType',
    titleField1: 'TitleField1', titleField2: 'TitleField2',
    cacheLookup: 'CacheLookup', clusteredIndex: 'ClusteredIndex', primaryIndex: 'PrimaryIndex',
    formRef: 'FormRef', countryRegionCodes: 'CountryRegionCodes',
    developerDocumentation: 'DeveloperDocumentation', createdBy: 'CreatedBy',
    modifiedDateTime: 'ModifiedDateTime', createdDateTime: 'CreatedDateTime',
  };
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || typeof v === 'object') continue;
    const element = PROPERTY_ELEMENTS[k] ?? (PROPERTY_ELEMENTS[k[0].toLowerCase() + k.slice(1)] ? k : undefined);
    if (!element) continue;
    ops.push({ operation: 'modify-property', propertyPath: element, propertyValue: v });
  }

  if (ops.length === 0) return '';
  return `\n\nApply what you passed to the object that is already there — ONE call:\n` +
    `d365fo_file(action="modify", objectType="${objectType}", objectName="${objectName}", operations=${JSON.stringify(ops)})\n`;
}

const CreateD365FileArgsSchema = z.object({
  objectType: z
    .enum([
      'class', 'class-extension', 'table', 'enum', 'form', 'query', 'view', 'data-entity', 'report',
      'edt', 'edt-extension',
      'table-extension', 'form-extension', 'data-entity-extension', 'enum-extension',
      'menu-item-display', 'menu-item-action', 'menu-item-output',
      'menu-item-display-extension', 'menu-item-action-extension', 'menu-item-output-extension',
      'menu', 'menu-extension',
      'security-privilege', 'security-duty', 'security-role',
      'security-duty-extension', 'security-role-extension',
      'business-event', 'tile', 'kpi', 'map',
      'service', 'service-group',
      'macro', 'configuration-key', 'security-policy', 'aggregate-measurement', 'license-code',
    ])
    .describe('Type of D365FO object to create'),
  objectName: z
    .string()
    .describe('Name of the object (e.g., MyHelperClass, MyCustomTable)'),
  modelName: z
    .string()
    .optional()
    .describe('Model name (e.g., ContosoExtensions). Auto-detected from mcp.json if omitted.'),
  packageName: z
    .string()
    .optional()
    .describe('Package name (e.g., CustomExtensions, ApplicationSuite). Auto-resolved from model name if omitted.'),
  packagePath: z
    .string()
    .optional()
    .describe('Base package path (default: auto-detected from .mcp.json, or from the <drive>:\\AosService\\PackagesLocalDirectory found on this machine)'),
  sourceCode: z
    .string()
    .optional()
    .describe('X++ source code for the object (class declaration, methods, etc.)'),
  properties: z
    .record(z.string(), z.any())
    .optional()
    .describe('Additional properties for the object (extends, implements, etc.)'),
  autoCorrect: z
    .boolean()
    .optional()
    .default(true)
    .describe(
      'Apply a correction the server has already fully determined instead of reporting it — currently ' +
      'resolving a raw-text `label` to an existing or newly created @LabelFile:Id, reported as a ' +
      '"Note:" line. Same spelling and meaning as the modify path\'s autoCorrect. Set false for strict ' +
      'behaviour: the raw text is written as passed and comes back as a BPErrorLabelIsText advisory.'
    ),
  addToProject: z
    .boolean()
    .optional()
    .default(true)
    .describe('Whether to automatically add file to Visual Studio project (default: true — always pass true unless explicitly told not to)'),
  projectPath: z
    .string()
    .optional()
    .describe(
      'Path to .rnrproj file. Required for addToProject in any workspace holding more than one .rnrproj: ' +
      'auto-detection resolves a project only when there is exactly one, or one whose folder matches the ' +
      'workspace name, and otherwise refuses to guess. Call get_workspace_info to list the candidates.'
    ),
  solutionPath: z
    .string()
    .optional()
    .describe('Path to active VS solution directory. Used to find .rnrproj when projectPath is not given.'),
  xmlContent: z
    .string()
    .optional()
    .describe(
      'Custom XML content to write verbatim instead of generating a template. ' +
      'Use this in hybrid setups: call generate / generate on Azure ' +
      'to get AI-driven XML, then pass that XML here on the local Windows VM to write the file ' +
      'and add it to the VS2022 project.'
    ),
  overwrite: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      'Allow overwriting an existing file. Use together with xmlContent when you need to completely ' +
      'rewrite an object (e.g. table with corrupted field names). Default: false (returns error if file already exists).'
    ),
  groundingToken: z
    .string()
    .optional()
    .describe(
      'Provenance token returned by prepare(mode="change"). Proves the change was grounded in the indexed codebase. ' +
      'Required for *-extension objectTypes when GROUNDING_ENFORCE=true on the server.'
    ),
});


/**
 * Normalize the flexible field specs accepted by the tool / XML generators
 * (`{ name, edt?, type?, fieldType?, extendedDataType?, enumType?, mandatory?, label? }`)
 * into the key shape the C# bridge's WriteFieldParam actually deserializes.
 *
 * The bridge only reads JSON keys `type` and `edt` (`[JsonPropertyName]`), not
 * `fieldType`/`extendedDataType` — accept either input spelling and always emit
 * the bridge's keys. `type` may arrive as a base-type keyword ("Integer") or a
 * full i:type ("AxTableFieldInt"); the latter is stripped back to the keyword
 * the bridge's CreateTableField switch understands.
 */
export function normalizeFieldSpecsForBridge(
  fields: Record<string, unknown>[],
): Record<string, unknown>[] {
  return fields.map((f) => {
    let fieldType = f.type ?? f.fieldType;
    if (typeof fieldType === 'string') fieldType = fieldType.replace(/^AxTableField/, '');
    const out: Record<string, unknown> = { name: f.name };
    if (fieldType != null && fieldType !== '') out.type = fieldType;
    if (f.edt != null) out.edt = f.edt;
    else if (f.extendedDataType != null) out.edt = f.extendedDataType;
    if (f.enumType != null) out.enumType = f.enumType;
    if (f.mandatory != null) out.mandatory = f.mandatory;
    if (f.label != null) out.label = f.label;
    if (f.stringSize != null) out.stringSize = f.stringSize;
    return out;
  });
}

/**
 * Normalize the flexible index specs accepted by the tool into the key shape the
 * C# bridge's WriteIndexParam actually deserializes: `{ name, fields: string[],
 * alternateKey?, allowDuplicates? }`.
 *
 * Accepts both the bridge's native `{name, fields}` shape and the documented
 * `modify(operation="add-index")` shape `{indexName, indexFields: [{fieldName}]}`.
 * Unrecognized keys are silently ignored by System.Text.Json, so any unmapped
 * shape produces an index with an empty Name/Fields that xppc rejects at build time.
 */
/**
 * `properties.indexes[].validTimeStateKey / validTimeStateMode` are dropped by the
 * bridge (normalizeIndexSpecsForBridge forwards only name/fields/alternateKey/
 * allowDuplicates), so a date-effective table's key index came back without them.
 * Stamp them into the written XML and report what was written, in the same
 * "written after the create" voice as the property-honesty report.
 */
async function stampIndexValidTimeState(filePath: string, props: any): Promise<string> {
  const indexes = Array.isArray(props?.indexes) ? props.indexes : [];
  const notes: string[] = [];
  for (const idx of indexes) {
    const name = idx?.name ?? idx?.indexName;
    if (!name || (idx?.validTimeStateKey === undefined && idx?.validTimeStateMode === undefined)) continue;
    const r = await directXmlSetIndexValidTimeState(
      filePath,
      String(name),
      coerceNoYesFlag(idx.validTimeStateKey),
      idx.validTimeStateMode,
    );
    if (r) {
      notes.push(r.success
        ? `🔧 Written after the create (the bridge's AddIndex dropped it): ${r.message.replace(/^✅ /, '')}`
        : `❌ ${r.message}`);
    }
  }
  return notes.length ? `\n${notes.join('\n')}` : '';
}

export function normalizeIndexSpecsForBridge(
  indexes: Record<string, unknown>[],
): Record<string, unknown>[] {
  return indexes.map((idx) => {
    const name = idx.name ?? idx.indexName;
    const rawFields = (idx.fields ?? idx.indexFields) as unknown[] | undefined;
    const fields = Array.isArray(rawFields)
      ? rawFields
          .map((f) => (typeof f === 'string' ? f : (f as Record<string, unknown> | null)?.fieldName))
          .filter((f): f is string => typeof f === 'string' && f.length > 0)
      : undefined;
    const out: Record<string, unknown> = { name };
    if (fields && fields.length > 0) out.fields = fields;
    if (idx.alternateKey != null) out.alternateKey = idx.alternateKey;
    if (idx.allowDuplicates != null) out.allowDuplicates = idx.allowDuplicates;
    return out;
  });
}

/**
 * The XML template generator moved to ../xml/xmlTemplateGenerator.ts when the
 * generate/create fork was unified — see that file for the divergences it fixed.
 * Re-exported here because the create tool has always been its published home.
 */
export { XmlTemplateGenerator };


/**
 * Bring a bridge-written artifact to the line endings the MS serializer uses.
 *
 * The bridge writes the XML skeleton with CRLF but leaves the X++ inside
 * `<![CDATA[ ]]>` on bare LF, so a freshly created class is mixed-EOL (34 CRLF /
 * 98 LF when the L2-collections-map-list-container run measured it) while every
 * AxClass on disk is pure CRLF. It compiles either way, but the first
 * `modify` re-serialises the whole file to CRLF — so the artifact CHANGES
 * without anyone editing it, and a golden captured from a create churns on the
 * next touch. Every modify path already writes through normalizeD365Xml; this
 * closes the create half.
 *
 * Best-effort by design: a normalization failure must not fail a successful create.
 */
async function normalizeCreatedArtifactEol(filePath: string): Promise<void> {
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    const normalized = normalizeD365Xml(raw);
    if (normalized !== raw) await writeFileAtomic(filePath, normalized);
  } catch (err) {
    console.error(`[create_d365fo_file] EOL normalization skipped for ${filePath}: ${err}`);
  }
}

/**
 * Resolve the `values` / `enumValues` alias ONCE, before anything routes on it.
 *
 * `values` is a legacy spelling the bridge create path has always accepted
 * (`props.enumValues ?? props.values` → bridgeParams.values), but the TypeScript
 * XML generator reads `properties.enumValues` and nothing else. Two writers
 * disagreeing about the same payload is only harmless while both of them run;
 * they don't. An enum passed `values: [None=0, A=1]` routes AWAY from the bridge
 * (the resolved mode forbids explicit <Value> elements — see
 * enumModeForbidsExplicitValues below) and lands on the generator, which finds no
 * `enumValues`, writes `<EnumValues />`, and reports a clean ✅ for an enum with no
 * values at all.
 *
 * So normalise here, at the top of the handler, where every later reader — routing
 * predicate, bridge params, generator — sees the same list. Mutates in place: `args`
 * is this call's own parsed object.
 */
export function normalizeEnumValuesAlias(
  objectType: string,
  properties: Record<string, unknown> | undefined,
): void {
  if (objectType !== 'enum' && objectType !== 'enum-extension') return;
  if (!properties) return;
  if (properties.enumValues !== undefined) return;
  if (Array.isArray(properties.values)) properties.enumValues = properties.values;
}

/**
 * Collections on `properties` whose entries carry a `label` of their own, and
 * what one entry is called in the note the caller reads back.
 *
 * `fields` is the one that matters: the corpus shape was a table with three
 * labelled fields costing three search/info/create rounds of `labels` before the
 * create could even be attempted.
 */
const LABELLED_COLLECTIONS: Array<{ key: string; singular: string }> = [
  { key: 'fields', singular: 'field' },
  { key: 'fieldGroups', singular: 'field group' },
  { key: 'enumValues', singular: 'enum value' },
];

/**
 * Replace every raw-text `label` under `properties` with a real label reference,
 * reusing an existing label when one already carries that exact text.
 *
 * Mutates in place — `properties` is this call's own parsed object, and every
 * later reader (bridge params, XML generator, property reconciler) must see the
 * reference rather than the text. Returns one note per label it touched; a value
 * that is already an `@Ref` is left alone and produces no note.
 */
async function autoResolveRawLabels(
  properties: Record<string, unknown> | undefined,
  target: AutoLabelTarget,
  symbolIndex?: import('../../metadata/symbolIndex.js').XppSymbolIndex,
): Promise<string[]> {
  if (!properties) return [];
  const notes: string[] = [];

  const resolveInto = async (
    holder: Record<string, unknown>,
    what: string,
    enumType?: string,
  ): Promise<void> => {
    if (!isRawLabelText(holder.label)) return;
    const outcome = await resolveOrCreateLabelRef(
      { text: holder.label as string, what, enumType },
      target,
      symbolIndex,
    );
    if (!outcome) return;
    if (outcome.ref) holder.label = outcome.ref;
    notes.push(outcome.note);
  };

  await resolveInto(properties, 'Label');

  for (const { key, singular } of LABELLED_COLLECTIONS) {
    const entries = properties[key];
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (entry === null || typeof entry !== 'object') continue;
      const e = entry as Record<string, unknown>;
      const name = typeof e.name === 'string' ? e.name : undefined;
      await resolveInto(
        e,
        `${singular}${name ? ` "${name}"` : ''}`,
        typeof e.enumType === 'string' ? e.enumType : undefined,
      );
    }
  }

  return notes;
}

/**
 * Returns a BP warning string when a `label` property is raw text (not a @File:Id reference).
 * xppbp raises BPErrorLabelIsText for any object-level label that is not a label ID.
 * Use the `labels` tool to find or create a label ID before writing the object.
 */
function rawLabelBpWarning(properties: unknown, objectName: string): string {
  const label = (properties as Record<string, unknown> | undefined)?.label;
  if (typeof label === 'string' && label.length > 0 && !label.startsWith('@')) {
    return `\n\n⚠️ **BPErrorLabelIsText risk:** Label "${label}" is raw text, not a label ID.\n` +
      `xppbp will report BPErrorLabelIsText on ${objectName}.\n` +
      `Fix: call \`labels(action="search", text="${label}")\` to find an existing @LabelFile:Id,\n` +
      `or \`labels(action="create", ...)\` to create one, then re-create with the @reference.`;
  }
  return '';
}

/**
 * The caller's X++ as this server actually wrote it.
 *
 * Every create path renames a class/interface whose declared name differs from
 * the resolved object name, and that rename is usually what makes the name
 * legal. Linting the caller's own text instead reports the pre-rename name —
 * a naming violation against a name already fixed on disk.
 *
 * Delegates to the helper the writers use, so the two cannot drift. Source with
 * no class/interface header is returned untouched.
 */
export function sourceAsWritten(sourceCode: string | undefined, finalObjectName: string): string | undefined {
  if (!sourceCode) return sourceCode;
  try {
    return XmlTemplateGenerator.normalizeSelfReferenceName(finalObjectName, sourceCode, []).declaration;
  } catch {
    return sourceCode;
  }
}

/**
 * Warn, on an extensible enum create, that xppc allows only equality on it.
 *
 * IsExtensible=Yes makes the numbering an implementation detail the compiler
 * refuses to expose: `<`, `>`, `<=`, `>=` is the hard error "Cannot use
 * extensible enumerated type '…' in non-equality comparison". Extensibility is
 * the right default, but ranking needs ordering, and only the build says so.
 *
 * Advisory: an extensible enum compared only with == is perfectly correct.
 */
function extensibleEnumOrderingWarning(objectType: string, properties: unknown, enumName: string): string {
  if (objectType !== 'enum') return '';
  if (!(properties as Record<string, unknown> | undefined)?.isExtensible) return '';
  return `\n\n⚠️ **IsExtensible=true → equality comparisons only.** xppc rejects ` +
    `\`<\`, \`>\`, \`<=\`, \`>=\` between values of ${enumName} ("Cannot use extensible enumerated ` +
    `type in non-equality comparison"); only \`==\`, \`!=\` and \`switch\` are legal.\n` +
    `If any X++ has to RANK these values (a tier, a severity, a "cannot be downgraded" check), ` +
    `re-create this enum with isExtensible=false NOW — after code references it, the change costs ` +
    `a failed build first.`;
}

/**
 * Post-write parameter honesty for a table create (cluster #35).
 *
 * The metadata writer — bridge or template — accepts `properties` it does not know
 * how to write and reports ✅ anyway: `configurationKey` reached neither the smart
 * nor the generic bridge create because C# SetAxTableProperty() has no case for it
 * (corpus run 2026-07-22T16__L2-config-key-gated-table). Re-read what actually
 * landed on disk, write back anything repairable in canonical element order, and
 * return a report for whatever still could not be honoured. Best-effort by design:
 * a read/write failure here must never turn a successful create into an error.
 */
async function reconcileCreatedTableProperties(
  filePath: string | undefined,
  properties: unknown,
): Promise<string> {
  if (!filePath || !properties || typeof properties !== 'object') return '';
  try {
    const onDisk = await fs.readFile(filePath, 'utf-8');
    const reconciled = reconcileTableCreateProperties(onDisk, properties as Record<string, unknown>);
    if (reconciled.patched.length > 0) {
      await writeFileAtomic(filePath, normalizeD365Xml(reconciled.xml));
    }
    return renderTableCreateHonestyReport(reconciled);
  } catch (e) {
    console.error(`[create_d365fo_file] table property reconcile skipped: ${e}`);
    return '';
  }
}

/**
 * Create D365FO file handler function
 */
/**
 * What the caller needs to chain further work onto a create: the name the object
 * ACTUALLY got, after prefix/casing normalization, and where it was written.
 *
 * An out-parameter because neither alternative is sound. Parsing it back out of
 * the response text is brittle, and a module-level "last created" would be wrong
 * under two concurrent creates. Both fields are set at the point create computes
 * them, so every later return path carries them regardless of which one fires —
 * and a caller that finds them missing must NOT guess (see d365foFile.ts).
 */
export interface CreateOutcome {
  finalObjectName?: string;
  filePath?: string;
}

export async function handleCreateD365File(
  request: CallToolRequest,
  context?: {
    bridge?: import('../../bridge/bridgeClient.js').BridgeClient;
    symbolIndex?: import('../../metadata/symbolIndex.js').XppSymbolIndex;
  },
  outcome?: CreateOutcome,
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  const timer = createPhaseTimer();
  const args = CreateD365FileArgsSchema.parse(request.params.arguments);
  normalizeEnumValuesAlias(args.objectType, args.properties);

  // Grounding enforcement: extension objects modify the behaviour of existing
  // code, so when GROUNDING_ENFORCE=true the model must prove (via prepare_change)
  // that it inspected the real object before writing the extension.
  if (args.objectType.endsWith('-extension')) {
    const groundingError = enforceGrounding(
      args.groundingToken,
      `d365fo_file(action="create", objectType="${args.objectType}", objectName="${args.objectName}")`,
      args.objectName,
    );
    if (groundingError) return groundingError;
  }

  // Semantic reference gate: when GROUNDING_ENFORCE=true, every identifier in the
  // X++ source must be proven against the symbol index before it reaches disk.
  const referenceError = gateOnReferenceErrors(
    args.sourceCode,
    context?.symbolIndex,
    `d365fo_file(action="create", objectType="${args.objectType}", objectName="${args.objectName}")`,
  );
  if (referenceError) return referenceError;

  try {
    // Step 1: Try to find and parse .rnrproj to get actual ModelName
    let actualModelName = args.modelName;
    let wasAutoExtracted = false;
    let projectPathToUse = args.projectPath;
    let solutionPathToUse = args.solutionPath;
    
    console.error(
      `[create_d365fo_file] Initial modelName: ${actualModelName}`
    );

    // If neither projectPath nor solutionPath provided, try to get from config or auto-detect
    if (!projectPathToUse && !solutionPathToUse) {
      const configManager = getConfigManager();

      // Try to auto-detect from workspace (async)
      projectPathToUse = await configManager.getProjectPath() || undefined;
      solutionPathToUse = await configManager.getSolutionPath() || undefined;

      // If model name was not passed as argument, try to resolve from mcp.json config
      if (!actualModelName) {
        actualModelName = configManager.getModelName() ?? undefined;
        if (actualModelName) {
          const ctx = configManager.getContext();
          const source = ctx?.modelName ? 'modelName (mcp.json)' : 'workspacePath (mcp.json)';
          console.error(`[create_d365fo_file] Using modelName from ${source}: ${actualModelName}`);
        }
      }

      if (projectPathToUse) {
        console.error(
          `[create_d365fo_file] Using projectPath (auto-detected or from .mcp.json): ${projectPathToUse}`
        );
      } else if (solutionPathToUse) {
        console.error(
          `[create_d365fo_file] Using solutionPath (auto-detected or from .mcp.json): ${solutionPathToUse}`
        );
      }
    }

    // If projectPath is available, extract model name from it
    if (projectPathToUse) {
      const projectManager = new ProjectFileManager();
      const extractedModelName = await projectManager.extractModelName(
        projectPathToUse
      );
      if (extractedModelName) {
        actualModelName = extractedModelName;
        wasAutoExtracted = true;
        console.error(
          `[create_d365fo_file] Extracted ModelName from projectPath: ${actualModelName}`
        );
        
        // ✨ Register extracted model as custom (since it came from user's project)
        registerCustomModel(actualModelName);
      }
    }
    // If solutionPath is available, try to find .rnrproj and extract model name
    else if (solutionPathToUse) {
      const foundProjectPath = await ProjectFileFinder.findProjectInSolution(
        solutionPathToUse,
        actualModelName ?? ''
      );
      
      if (foundProjectPath) {
        const projectManager = new ProjectFileManager();
        const extractedModelName = await projectManager.extractModelName(
          foundProjectPath
        );
        if (extractedModelName) {
          actualModelName = extractedModelName;
          wasAutoExtracted = true;
          console.error(
            `[create_d365fo_file] Extracted ModelName from solutionPath .rnrproj: ${actualModelName}`
          );
          
          // ✨ Register extracted model as custom (since it came from user's project)
          registerCustomModel(actualModelName);
        }
      }
    }

    // ⚠️ CRITICAL: modelName is required — must come from args, mcp.json, or .rnrproj extraction
    if (!actualModelName) {
      const errorMsg =
        '❌ ERROR: modelName could not be resolved.\n\n' +
        'Provide it in one of these ways:\n' +
        '  1. Pass modelName explicitly in the tool call arguments\n' +
        '  2. Add modelName to .mcp.json context: { "context": { "modelName": "YourModel" } }\n' +
        '  3. Add workspacePath ending with the package/model name: { "context": { "workspacePath": "C:\\\\AosService\\\\PackagesLocalDirectory\\\\YourModel" } }\n' +
        '  4. Add projectPath or solutionPath to .mcp.json so the model is auto-extracted from .rnrproj';
      console.error(`[create_d365fo_file] ${errorMsg}`);
      return { content: [{ type: 'text', text: errorMsg }], isError: true };
    }

    // ⚠️ CRITICAL WARNING: If no project/solution path available anywhere
    if (!projectPathToUse && !solutionPathToUse) {
      console.error(
        `[create_d365fo_file] ⚠️ WARNING: No projectPath or solutionPath available (not in args, not in .mcp.json)!`
      );
      console.error(
        `[create_d365fo_file] ⚠️ Using modelName AS-IS: "${actualModelName}"`
      );
      console.error(
        `[create_d365fo_file] ⚠️ If "${actualModelName}" is a Microsoft model (e.g., ApplicationSuite), this will create the file in the WRONG location!`
      );
      console.error(
        `[create_d365fo_file] ⚠️ Add projectPath or solutionPath to .mcp.json config to auto-extract correct ModelName from .rnrproj!`
      );
      
      // Extra validation: Check for suspicious/placeholder model names
      const suspiciousNames = ['auto', 'test', 'example', 'temp', 'undefined', 'null'];
      // Known Microsoft standard D365FO models — NEVER use for custom code
      const knownMicrosoftModels = [
        'applicationsuite', 'applicationcommon', 'applicationfoundation', 'applicationplatform',
        'applicationwebcomponents', 'applicationworkspaces', 'foundation',
        'directory', 'dimensions', 'currency', 'calendar', 'casemanagement',
        'contactperson', 'datasharing', 'dataupgrade', 'datamaintenance',
        'electronicreporting', 'electronicreportingcore',
        'banktype', 'banktypes', 'benefitsmanagement', 'creditmanagement',
      ];
      const modelLower = actualModelName.toLowerCase();
      const isPlaceholder = suspiciousNames.includes(modelLower);
      const isMicrosoftModel = knownMicrosoftModels.includes(modelLower);

      if (isPlaceholder || isMicrosoftModel) {
        const reason = isPlaceholder
          ? `"${actualModelName}" is a placeholder value, not a real D365FO model`
          : `"${actualModelName}" is a Microsoft standard model — custom code must NEVER be created there`;
        const errorMsg =
          `❌ ERROR: ${reason}\n\n` +
          `Root cause: No projectPath or solutionPath was found (not in tool args, not in .mcp.json config).\n` +
          `Without projectPath, the tool uses the modelName parameter AS-IS, which is wrong.\n\n` +
          `To fix — add projectPath to .mcp.json (in the MCP server directory)::\n` +
          `  {\n` +
          `    "servers": {\n` +
          `      "context": {\n` +
          `        "projectPath": "C:\\\\VSProjects\\\\YourSolution\\\\YourProject\\\\YourProject.rnrproj",\n` +
          `        "solutionPath": "C:\\\\VSProjects\\\\YourSolution",\n` +
          `        "packagePath": "C:\\\\AosService\\\\PackagesLocalDirectory"\n` +
          `      }\n` +
          `    }\n` +
          `  }\n\n` +
          `Or pass projectPath explicitly in the tool call arguments.`;

        console.error(`[create_d365fo_file] ${errorMsg}`);

        return {
          content: [
            {
              type: 'text',
              text: errorMsg
            }
          ],
          isError: true,
        };
      }
    }

    console.error(
      `[create_d365fo_file] Final ModelName to use: ${actualModelName}${wasAutoExtracted ? ' (auto-extracted ✓)' : ' (as-is, NOT auto-extracted ⚠️)'}`
    );

    // Guard: refuse to create objects in generic placeholder model names.
    // These are never real D365FO models — if the AI reaches this point with a placeholder,
    // the workspace was not detected correctly and the file would land in the wrong location.
    const PLACEHOLDER_MODELS = new Set([
      'mymodel', 'mypackage', 'model', 'package', 'modelname', 'packagename',
      'yourmodel', 'yourpackage', 'custommodel', 'custompackage',
      'testmodel', 'testpackage', 'samplemodel', 'samplepackage',
    ]);
    if (actualModelName && PLACEHOLDER_MODELS.has(actualModelName.toLowerCase())) {
      return {
        content: [
          {
            type: 'text',
            text:
              `❌ Model name "${actualModelName}" looks like a placeholder — file creation aborted.\n\n` +
              `The workspace / project path was not detected correctly, so the model name\n` +
              `could not be resolved from the .rnrproj file.\n\n` +
              `To fix this, provide one of:\n` +
              `  • projectPath — full path to the .rnrproj file (e.g. K:\\...\\MyProject.rnrproj)\n` +
              `  • solutionPath — directory containing the .rnrproj\n` +
              `  • A correct modelName that matches an actual D365FO model on disk\n\n` +
              `Never use "MyModel", "MyPackage" or similar placeholders as modelName.`,
          },
        ],
        isError: true,
      };
    }

    // Cross-model guard: creating INTO a custom model other than the one this
    // workspace targets is the same mistake as modifying one — the object lands
    // outside this project's version control and inside code other models inherit.
    // `actualModelName` is what the write will actually use (caller's modelName, or
    // the workspace's), so the check sits after every fallback has been applied.
    // Resolved, not read synchronously: where the model comes only from the
    // background .rnrproj scan, the sync getter can still be null here — and a
    // null anchor makes the guard stand down.
    const crossModelCheck = {
      objectName: args.objectName,
      objectType: args.objectType,
      owningModel: actualModelName,
      activeModel: await resolveAnchorModel(getConfigManager()),
      toolSwitchedModel: getConfigManager().getToolProjectSwitch()?.forcedModel ?? null,
      action: 'create' as const,
    };
    const crossModelCreateRefusal = crossModelWriteRefusal(crossModelCheck);
    if (crossModelCreateRefusal) {
      return {
        content: [{ type: 'text', text: crossModelCreateRefusal }],
        isError: true,
      };
    }
    // Allowed, but possibly not into this model — see standDownNotice.
    const crossModelNotice = standDownNotice(crossModelCheck);

    // Name normalisation lives in utils/objectNaming so that modify resolves the
    // very same name from the very same arguments — the ninety lines that used to
    // sit here inline were the reason it did not. See normalizeObjectName.
    const finalObjectName = normalizeObjectName(
      args.objectName,
      args.objectType,
      actualModelName,
      (note: string) => console.error(`[create_d365fo_file] ${note}`),
    );
    if (finalObjectName !== args.objectName) {
      console.error(`[create_d365fo_file] Applied naming: ${args.objectName} → ${finalObjectName}`);
    }
    // Published here, before any of the return paths below, so a caller chaining
    // work onto this create targets the name that was WRITTEN rather than the one
    // that was asked for.
    if (outcome) outcome.finalObjectName = finalObjectName;
    // Disclose a rename in the RESPONSE, not only on stderr. The XML template
    // path says "prefixed from …"; the bridge path — every extension, class and
    // table — said nothing, so the object came back under a name the caller never
    // chose and could only infer from the file path.
    const renameNote = finalObjectName !== args.objectName
      ? `\n🔖 Named \`${finalObjectName}\`, not \`${args.objectName}\` as passed — the model's naming ` +
        `style decides this. The declaration inside the file matches; use this name in later calls.`
      : '';

    // ── Raw label text → a label reference, before anything is written ───────
    // Measured over 1,515 real MCP calls: `labels` was called 268 times against
    // 171 writes, and `labels → labels` was the most frequent consecutive pair in
    // the corpus (177). The whole of that traffic is search-then-info-then-create,
    // once per label, in front of a write that already carries the text. Doing it
    // here costs one index lookup and, at most, the create that was going to
    // happen anyway — and removes N round trips from every labelled object.
    //
    // An `@Ref` the caller passed is never touched, and autoCorrect=false keeps
    // the old behaviour (raw text written as passed + the BP advisory), the same
    // opt-out the modify path publishes.
    const autoLabelNotes = args.autoCorrect !== false && actualModelName
      ? await timer.time('label auto-resolve', () => autoResolveRawLabels(
          args.properties as Record<string, unknown> | undefined,
          {
            model: actualModelName as string,
            packagePath: args.packagePath,
            projectPath: projectPathToUse,
            solutionPath: solutionPathToUse,
            addToProject: args.addToProject,
          },
          context?.symbolIndex,
        ))
      : [];
    const labelAutoNote = autoLabelNotes.length > 0
      ? `\n\n${autoLabelNotes.map(n => `📝 Note: ${n}`).join('\n')}\n` +
        `(Pass autoCorrect=false to have raw label text written as-is and reported as a BP risk instead.)`
      : '';

    // Determine object folder based on type
    const objectFolderMap: Record<string, string> = {
      class: 'AxClass',
      'class-extension': 'AxClass',
      table: 'AxTable',
      enum: 'AxEnum',
      form: 'AxForm',
      query: 'AxQuery',
      view: 'AxView',
      'data-entity': 'AxDataEntityView',
      report: 'AxReport',
      edt: 'AxEdt',
      'edt-extension': 'AxEdtExtension',
      'table-extension': 'AxTableExtension',
      'form-extension': 'AxFormExtension',
      'data-entity-extension': 'AxDataEntityViewExtension',
      'enum-extension': 'AxEnumExtension',
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
      'business-event': 'AxClass',
      tile: 'AxTile',
      kpi: 'AxKPI',
      map: 'AxMap',
      service: 'AxService',
      'service-group': 'AxServiceGroup',
      macro: 'AxMacroDictionary',
      'configuration-key': 'AxConfigurationKey',
      'security-policy': 'AxSecurityPolicy',
      'aggregate-measurement': 'AxAggregateMeasurement',
      'license-code': 'AxLicenseCode',
    };

    const objectFolder = objectFolderMap[args.objectType];
    if (!objectFolder) {
      throw new Error(`Unsupported object type: ${args.objectType}`);
    }

    // Construct full path - resolve package name
    // Package name can differ from model name in any environment (not just UDE).
    const configManager = getConfigManager();
    const configPackagePath = configManager.getPackagePath();
    const envType = await configManager.getDevEnvironmentType();

    let basePath: string;
    let resolvedPackageName: string;

    // Resolve the custom write root (D365FO_CUSTOM_PACKAGES_PATH).
    // Applies in both UDE and traditional mode — it always points to the repo
    // working tree where custom model XML lives, regardless of dev env type.
    const customWritePath = await configManager.getCustomPackagesPath();

    if (args.packageName) {
      // Explicit packageName always wins, regardless of environment type
      resolvedPackageName = args.packageName;
      // Custom write root beats the MS PLD for explicit packageName calls too.
      basePath = args.packagePath || customWritePath || configPackagePath || fallbackPackagePath();
    } else if (envType === 'ude') {
      // UDE mode: auto-resolve package name via descriptor scan across both roots
      const msPath = await configManager.getMicrosoftPackagesPath();
      const roots = [customWritePath, msPath].filter(Boolean) as string[];

      const resolver = new PackageResolver(roots);
      const resolved = await resolver.resolve(actualModelName);

      if (resolved) {
        resolvedPackageName = resolved.packageName;
        basePath = resolved.rootPath;
      } else {
        // Fallback: assume package == model (common case)
        resolvedPackageName = actualModelName;
        basePath = customWritePath || args.packagePath || configPackagePath || fallbackPackagePath();
      }
    } else {
      // Traditional mode: try descriptor-based resolution first so a package
      // whose name differs from the model name (e.g. package "ISVPackage",
      // model "ISV Package") resolves correctly without an explicit packageName
      // arg. Scan both the custom write root and D365FO_PACKAGE_PATH for the
      // matching descriptor; fall back to assuming package == model otherwise.
      const roots = [customWritePath, configPackagePath].filter(Boolean) as string[];
      const resolver = new PackageResolver(roots);
      const resolved = roots.length ? await resolver.resolve(actualModelName) : null;

      if (resolved) {
        resolvedPackageName = resolved.packageName;
        basePath = resolved.rootPath;
      } else {
        // Fallback: assume package == model.
        // Prefer the custom write root over D365FO_PACKAGE_PATH so custom model
        // XML lands in the repo working tree rather than the MS PackagesLocalDirectory.
        resolvedPackageName = actualModelName;
        basePath =
          args.packagePath ||
          customWritePath ||
          configPackagePath ||
          fallbackPackagePath();
      }
    }

    console.error(
      `[create_d365fo_file] Environment: ${envType}, Package: ${resolvedPackageName}, Model: ${actualModelName}, BasePath: ${basePath}`,
    );

    const modelPath = path.join(
      basePath,
      resolvedPackageName,
      actualModelName,
      objectFolder,
    );
    const fileName = `${finalObjectName}.xml`;
    const fullPath = path.join(modelPath, fileName);

    // Security: prevent path traversal. path.join() resolves ".." segments,
    // so a crafted modelName/objectName could escape basePath entirely.
    // Resolve both paths and assert the target stays within basePath.
    const resolvedBase = path.resolve(basePath);
    const resolvedTarget = path.resolve(fullPath);
    if (!resolvedTarget.startsWith(resolvedBase + path.sep) && resolvedTarget !== resolvedBase) {
      throw new Error(
        `❌ Security error: resolved path "${resolvedTarget}" is outside base directory "${resolvedBase}".\n` +
        `Check modelName, packageName, objectName, and packagePath for path traversal sequences.`
      );
    }

    // Normalize path to Windows format (backslashes) for consistency
    const normalizedFullPath = fullPath.replace(/\//g, '\\');
    if (outcome) outcome.filePath = normalizedFullPath;

    // Ensure directory exists (create if needed)
    const directory = path.dirname(normalizedFullPath);

    // Verify drive/root exists before attempting recursive mkdir.
    // path.parse().root works on Windows but returns '' for Windows-style paths on POSIX,
    // so we extract the drive letter with a regex as a fallback.
    // (Node.js gives a cryptic '\\?' error when the drive letter doesn't exist)
    const windowsDriveMatch = /^([A-Za-z]:[/\\])/.exec(normalizedFullPath);
    const driveOrRoot = windowsDriveMatch ? windowsDriveMatch[1] : path.parse(directory).root; // e.g. "K:\" or "C:\"
    if (driveOrRoot) {
      try {
        await fs.access(driveOrRoot);
      } catch {
        const nonWindowsHint = process.platform !== 'win32'
          ? `\n\n⚠️  This server is running on ${process.platform}. Windows drive letters (${driveOrRoot}) are not accessible.\n` +
            `Run the MCP server locally on the D365FO Windows VM instead.`
          : '';
        throw new Error(
          `❌ Drive or root path does not exist: ${driveOrRoot}\n\n` +
          `Attempting to create: ${directory}\n\n` +
          `The packagePath in your .mcp.json points to a drive that is not accessible.\n` +
          `Update "packagePath" in .mcp.json to match your actual D365FO installation:\n\n` +
          `${describePackagesRootScan()}\n\n` +
          `Current packagePath: ${basePath}\n` +
          `Current drive checked: ${driveOrRoot}${nonWindowsHint}`
        );
      }
    }

    try {
      await fs.mkdir(directory, { recursive: true });
    } catch (mkdirError) {
      console.error(
        `[create_d365fo_file] Failed to create directory:`,
        mkdirError
      );
      const hint =
        (mkdirError instanceof Error && mkdirError.message.includes('\\?'))
          ? `\n\nHint: The path "${directory}" could not be created. ` +
            `Verify the drive letter exists and the path is correct. ` +
            `Update "packagePath" in .mcp.json to fix this.`
          : '';
      throw new Error(
        `Failed to create directory ${directory}: ${mkdirError instanceof Error ? mkdirError.message : 'Unknown error'}${hint}`
      );
    }

    // Check if file already exists
    let fileExisted = false;
    try {
      await fs.access(normalizedFullPath);
      fileExisted = true;
    } catch {
      // File does not exist — normal creation path
    }

    if (fileExisted) {
      if (!args.overwrite) {
        // Surface what's already on disk so the caller doesn't have to read the
        // file in chunks just to discover its contents. Previously this branch
        // returned only "already exists", forcing repeated read_file calls.
        let existingContent = '';
        try {
          existingContent = await fs.readFile(normalizedFullPath, 'utf-8');
        } catch { /* unreadable — fall through with no summary */ }

        let existingSummary = '';
        let inlineContent = '';
        if (existingContent) {
          const methodNames = [...existingContent.matchAll(/<Method>\s*<Name>([^<]+)<\/Name>/g)].map(m => m[1]);
          const fieldNames = [...existingContent.matchAll(/<AxTableField[A-Za-z]*>\s*<Name>([^<]+)<\/Name>/g)].map(m => m[1]);
          const summaryParts: string[] = [];
          if (methodNames.length) {
            summaryParts.push(`${methodNames.length} method(s): ${methodNames.slice(0, 30).join(', ')}${methodNames.length > 30 ? ', …' : ''}`);
          }
          if (fieldNames.length) {
            summaryParts.push(`${fieldNames.length} field(s): ${fieldNames.slice(0, 30).join(', ')}${fieldNames.length > 30 ? ', …' : ''}`);
          }
          const sizeKb = (Buffer.byteLength(existingContent, 'utf-8') / 1024).toFixed(1);
          existingSummary = `\n\n📄 Existing file (${sizeKb} KB):` +
            (summaryParts.length ? `\n  ${summaryParts.join('\n  ')}` : ' (no methods/fields detected)');

          // Inline the full content when small enough to be useful in one shot;
          // otherwise point at the targeted readers rather than dumping a huge file.
          const INLINE_LIMIT = 8000;
          inlineContent = existingContent.length <= INLINE_LIMIT
            ? `\n\n----- BEGIN ${path.basename(normalizedFullPath)} -----\n${existingContent}\n----- END -----`
            : `\n\n(File is ${sizeKb} KB — too large to inline. Use get_object_info to read specific members.)`;
        }

        // When the requested objectName was normalized to a different on-disk name,
        // say so explicitly — the file that "already exists" can otherwise look
        // unrelated to what the caller asked for (e.g. "Foo_Extension" → "FooAc_Extension").
        const nameNote = finalObjectName !== args.objectName
          ? `\n\nℹ️ Note: objectName "${args.objectName}" was normalized to "${finalObjectName}" ` +
            `(active naming style/prefix), so this is the file that matches your request.`
          : '';

        // A file on disk that the ACTIVE project does not reference is a real
        // gap, and this early return was the only place that could close it:
        // `create` used to bail here, before the addToProject block far below, and
        // `modify` registers nothing unless the caller passes a flag that is not
        // in the wire schema. So an object that existed but was unregistered
        // could never BECOME registered — which is how a table extension got
        // edited through a whole session while staying invisible to the build.
        const projectNote = await registerFileInActiveProject(
          args.objectType, finalObjectName, actualModelName, projectPathToUse,
        );

        return {
          content: [
            {
              type: 'text',
              // Lead with the call the caller actually wants — the SAME entries,
              // aimed at the object that already exists — instead of three
              // generic retry options that all cost another round trip first.
              text: `⚠️ File already exists: ${normalizedFullPath}${nameNote}${existingSummary}${projectNote}` +
                renderEquivalentModifyCall(args.objectType, finalObjectName, args) +
                `\nOtherwise: overwrite=true together with xmlContent replaces the file, ` +
                `or choose a different objectName.${inlineContent}`,
            },
          ],
          isError: true,
        };
      }
    }

    // ── Phase 4: Bridge-first creation via IMetadataProvider.Create() ──
    // For 15 supported types (class, class-extension, table, enum, edt, query, view, form,
    // menu, 3 menu-items, table/form/enum-extension): try C# bridge first.
    // Falls back to TypeScript XML generation if bridge unavailable or unsupported type
    // (report, data-entity, tile, kpi, business-event, security-privilege/duty/role, etc.).
    //
    // EXCEPTION — extensible enums: the C# bridge does not set UseEnumValue=No and
    // emits explicit <Value> elements, both of which xppc rejects with
    // "UseEnumValue property must be set to 'No' when IsExtensible is True".
    // Use the TypeScript XML generator (which handles this correctly) instead.
    //
    // EXCEPTION — security-privilege/duty/role: excluded from BRIDGE_CREATE_TYPES
    // entirely (see bridgeAdapter.ts) because the bridge silently drops their
    // structured collections (EntryPoints, DataEntityPermissions, Privileges, Duties).
    //
    // EXCEPTION — any enum carrying values at all.
    //
    // The bridge writes <UseEnumValue> only when the caller passes the scalar, and
    // it serialises a <Value> per numbered entry except the zeros .NET omits as a
    // type default. Both shapes are wrong:
    //   • numbered   → <Value>1/2/3</Value> with the caller's 0 silently gone;
    //   • unnumbered → no <UseEnumValue> and no <Value>, which xppc reads as
    //                  UseEnumValue=Yes, making every member 0 ("Duplicate value
    //                  '0' detected"). Only a FULL build reports it; the
    //                  incremental build and validate_code pass clean.
    //
    // Numbering is not what the bridge gets wrong — <UseEnumValue> is, and every
    // values payload depends on it. generateAxEnumXml emits it unconditionally and
    // honours suppressExplicitValues, so it writes all of them. The bridge keeps
    // the one shape it cannot get wrong: an enum with no values.
    const enumMustSkipBridge = (): boolean => {
      if (args.objectType !== 'enum') return false;
      const props = args.properties as Record<string, unknown> | undefined;
      if (props?.isExtensible) return true;
      // `enumValues` only: the `values` alias was folded into it by
      // normalizeEnumValuesAlias, so routing and the writers read one list.
      const vals = props?.enumValues as Array<{ name?: string; value?: number }> | undefined;
      return Array.isArray(vals) && vals.length > 0;
    };
    const skipBridgeForEnum = enumMustSkipBridge();

    // Set only when a bridge create THREW (not when it was unavailable or declined).
    // The XML fallback below is a different writer with a narrower feature set, so a
    // create that lands there because of a bridge outage must not answer with the
    // same ✅ as one the bridge performed.
    let bridgeFailure: BridgeFailure | null = null;

    if (!args.xmlContent && !skipBridgeForEnum && context?.bridge && actualModelName && canBridgeCreate(args.objectType)) {
      try {
        // Settle any rebuild an earlier write in this session scheduled but did not
        // wait for. Everything below reads the provider — the base object of an
        // extension, the EDTs a table's fields extend — so a scaffold that creates
        // an EDT and then a table using it must not see the pre-EDT model. Free
        // when no write is outstanding.
        await timer.time('provider refresh (pending writes)', () => debouncedRefresh.flush());

        // The bridge's `properties` is a flat string map (C# Dictionary<string,string>).
        // Keep only SCALAR values and stringify them. Structured collections
        // (fields/fieldGroups/indexes/relations/values/enumValues/methods) are
        // arrays/objects passed via their own bridge params below — if they leak into
        // `properties` the C# GetDictParam calls GetString() on a JSON array/boolean and
        // the whole create throws ("requires an element of type 'String', but the target
        // element has type 'Array'/'True'").
        const scalarProperties: Record<string, string> | undefined = args.properties
          ? Object.fromEntries(
              Object.entries(args.properties as Record<string, unknown>)
                .filter(([, v]) => v != null && (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'))
                .map(([k, v]) => [k, String(v)]),
            )
          : undefined;

        // Prepare parameters for the bridge
        const bridgeParams: Parameters<typeof bridgeCreateObject>[1] = {
          objectType: args.objectType,
          objectName: finalObjectName,
          modelName: actualModelName,
          properties: scalarProperties && Object.keys(scalarProperties).length > 0 ? scalarProperties : undefined,
        };

        // For classes: parse sourceCode into declaration + methods
        if ((args.objectType === 'class' || args.objectType === 'class-extension') && args.sourceCode) {
          const parsed = XmlTemplateGenerator.parseSourceForBridge(args.sourceCode, finalObjectName);
          bridgeParams.declaration = parsed.declaration;
          bridgeParams.methods = parsed.methods;
        }

        // For tables AND table-extensions: pass fields, fieldGroups, indexes, relations
        // from properties. (Previously only 'table' was handled, so a table-extension's
        // properties.fields were silently dropped and the file got an empty <Fields />.)
        // Field specs are normalized to the bridge's WriteFieldParam key shape so that
        // `{ edt, type }` keys are not lost — otherwise every field becomes a bare String.
        if ((args.objectType === 'table' || args.objectType === 'table-extension') && args.properties) {
          const props = args.properties as Record<string, unknown>;
          if (props.fields) bridgeParams.fields = normalizeFieldSpecsForBridge(props.fields as Record<string, unknown>[]);
          if (props.fieldGroups) bridgeParams.fieldGroups = props.fieldGroups as Record<string, unknown>[];
          if (props.indexes) bridgeParams.indexes = normalizeIndexSpecsForBridge(props.indexes as Record<string, unknown>[]);
          if (props.relations) bridgeParams.relations = props.relations as Record<string, unknown>[];
          if (props.methods) {
            bridgeParams.methods = (props.methods as { name: string; source?: string }[]).map(m => ({
              ...m,
              source: m.source !== undefined ? xppMethodSourceForXml(m.source) : m.source,
            }));
          }
        }

        // X++ handed to a table create via `sourceCode` reached NOBODY: only
        // `properties.methods` was forwarded, so a full method body was answered with
        // ✅ and an empty <Methods /> on disk (findings #19). Parse it the same way the
        // class path does; an explicit properties.methods still wins.
        if (
          (args.objectType === 'table' || args.objectType === 'table-extension') &&
          args.sourceCode &&
          !args.sourceCode.trim().startsWith('{') &&
          !bridgeParams.methods
        ) {
          const parsedTableSource = XmlTemplateGenerator.parseSourceForBridge(
            args.sourceCode,
            finalObjectName,
          );
          if (parsedTableSource.methods.length > 0) {
            bridgeParams.methods = parsedTableSource.methods;
          }
        }

        if ((args.objectType === 'table' || args.objectType === 'table-extension') && args.properties) {
          // Resolve each field's base type from its EDT when the caller only gave
          // `edt` (the documented usage — the tool schema says "EDT auto-resolved
          // when omitted"). Without this, C# CreateTableField() defaults ANY field
          // whose `type` is unset to AxTableFieldString regardless of the EDT's real
          // base type — a Real-based EDT (e.g. a rate/amount) or a Date-based EDT
          // silently becomes a string field. `generateSmartTable`/`generate_object`
          // already resolve this; the plain d365fo_file(create, table/table-extension)
          // path never did. Mirrors that resolution: bridge (authoritative) → indexed
          // edt_metadata chain → name heuristic.
          if (bridgeParams.fields && bridgeParams.fields.length > 0) {
            const db = context.symbolIndex?.getReadDb?.();
            const fieldsToResolve = (bridgeParams.fields as Record<string, unknown>[]).filter(f => {
              const edt = f.edt as string | undefined;
              if (!edt || f.type) return false;
              // An "EDT" that is really an enum name needs AxTableFieldEnum + EnumType;
              // decided from the local index, so it never reaches the bridge.
              if (db && !f.enumType && isEnumName(edt, db)) {
                f.enumType = edt;
                f.type = 'Enum';
                delete f.edt;
                return false;
              }
              return true;
            });

            // One readEdt per DISTINCT EDT, all in flight at once. Sequentially awaiting
            // one round trip per field made a wide table's create wait out N latencies
            // into the C# process end to end, and fields repeating an EDT paid for it
            // twice. The bridge dispatch loop is single-threaded, so this pipelines the
            // requests rather than truly parallelising them — the win is the round trips.
            const baseTypes = new Map<string, string | undefined>();
            await Promise.all(
              [...new Set(fieldsToResolve.map(f => f.edt as string))].map(async edt => {
                baseTypes.set(edt, await bridgeEdtBaseType(context.bridge, edt));
              }),
            );

            for (const f of fieldsToResolve) {
              const edt = f.edt as string;
              const resolved = baseTypes.get(edt)
                ?? (db ? resolveEdtBaseType(edt, db) : undefined)
                ?? heuristicEdtBaseType(edt);
              if (resolved) {
                f.type = resolved;
                // An EDT whose OWN base type is Enum (e.g. "Posted" extends "NoYes") only
                // gets the literal string "Enum" back from the resolvers above — without
                // the actual enum name, the bridge cannot emit a valid AxTableFieldEnum and
                // silently falls back to AxTableFieldString. Look up the underlying enum
                // name so the field is created correctly instead of building "successfully"
                // as a mistyped string field.
                if (resolved === 'Enum' && !f.enumType && db) {
                  const enumType = resolveEdtEnumType(edt, db);
                  if (enumType) f.enumType = enumType;
                }
              }
            }
          }
        }

        // For enums AND enum-extensions: pass values from properties.
        // Accept both `enumValues` (documented in tool description) and `values` (legacy).
        // Regression: only 'enum' was handled here, so an enum-extension's properties.enumValues
        // never reached bridgeParams.values — C# CreateEnumExtension() happily accepts a `values`
        // list, but was always called with null, silently writing an empty <EnumValues />
        // (write reported success; the dropped value surfaced two calls later as an unrelated
        // "unresolved enum value" build error). Same class of bug as the table/table-extension
        // fields gap fixed above.
        if ((args.objectType === 'enum' || args.objectType === 'enum-extension') && args.properties) {
          const props = args.properties as Record<string, unknown>;
          const enumVals = (props.enumValues ?? props.values) as Record<string, unknown>[] | undefined;
          if (enumVals) bridgeParams.values = enumVals;
        }

        // For views: pass fields from properties
        if (args.objectType === 'view' && args.properties) {
          const props = args.properties as Record<string, unknown>;
          if (props.fields) bridgeParams.fields = props.fields as Record<string, unknown>[];
        }

        // For EDTs: translate the tool's documented `edtType` property to the bridge's
        // expected `BaseType` key. C# CreateEdt() does `properties.TryGetValue("BaseType", ...)`
        // — a literal, case-SENSITIVE dictionary lookup — so sending `edtType` (as documented
        // in the tool schema and as suggest_edt/prepare recommend) never matched, silently
        // defaulting every bridge-created EDT to AxEdtString regardless of the requested type
        // (Real, Int, Date, Enum, ...). Confirmed via a live create of an EDT with
        // edtType:"Real", extends:"AmountCur" — the written XML came back i:type="AxEdtString".
        if (args.objectType === 'edt' && bridgeParams.properties && 'edtType' in bridgeParams.properties) {
          const { edtType, ...rest } = bridgeParams.properties;
          bridgeParams.properties = { ...rest, BaseType: edtType };
        }

        // For plain 'table' creates, prefer the bridge's BP-smart path
        // (CreateSmartTable) over the generic createObject/CreateTable RPC.
        // CreateTable writes exactly what the caller passed and nothing more —
        // no CacheLookup, PrimaryIndex/ClusteredIndex/ReplacementKey, TitleField1/2,
        // or the 5 standard FieldGroups (AutoReport/AutoLookup/AutoIdentification/
        // AutoSummary/AutoBrowse) that every real D365FO table gets. generate_object
        // (mode="scaffold"/"generate", objectType="table") already routes through
        // CreateSmartTable and gets these correctly; the plain create verb — the
        // one a generic "create a table" instruction naturally maps to — silently
        // produced a BP-defaults-free skeleton instead (eval corpus: L1-table-basic,
        // L3-form-detailstransaction, L4-ssrs-report-basic — golden_diff missing
        // CacheLookup/ClusteredIndex/PrimaryIndex/ReplacementKey/TitleField1/TitleField2
        // and all 5 standard FieldGroups). Try the smart path first; any failure or
        // unavailability falls through to the existing generic bridgeCreateObject/XML
        // paths below, unchanged.
        if (args.objectType === 'table') {
          const rawTableProps = (args.properties as Record<string, unknown> | undefined) ?? {};
          const smartTableGroup = typeof rawTableProps.tableGroup === 'string' ? rawTableProps.tableGroup : undefined;
          const smartTableType = typeof rawTableProps.tableType === 'string' ? rawTableProps.tableType : undefined;
          const smartLabel = typeof rawTableProps.label === 'string' ? rawTableProps.label : undefined;
          const smartExtraProperties = scalarProperties
            ? Object.fromEntries(
                Object.entries(scalarProperties).filter(
                  ([k]) => !['tableGroup', 'tableType', 'label'].includes(k),
                ),
              )
            : undefined;

          try {
            const smartAttempt = await bridgeCreateSmartTable(context.bridge, {
              objectName: finalObjectName,
              modelName: actualModelName,
              tableGroup: smartTableGroup,
              tableType: smartTableType,
              label: smartLabel ?? finalObjectName,
              fields: bridgeParams.fields,
              extraFieldGroups: bridgeParams.fieldGroups,
              indexes: bridgeParams.indexes,
              relations: bridgeParams.relations,
              methods: bridgeParams.methods,
              extraProperties: smartExtraProperties && Object.keys(smartExtraProperties).length > 0
                ? smartExtraProperties
                : undefined,
            });

            // A thrown CreateSmartTable is not "the bridge declined" — remember it so
            // the XML fallback below can say the BP defaults and the bridge-only
            // collections were never applied, instead of returning the same ✅.
            if (isBridgeFailure(smartAttempt)) bridgeFailure = smartAttempt;
            const smartResult = isBridgeFailure(smartAttempt) ? null : smartAttempt;

            if (smartResult?.success && smartResult.filePath) {
              console.error(`[create_d365fo_file] ✅ Created via C# bridge (BP-smart): ${smartResult.filePath}`);
              await normalizeCreatedArtifactEol(smartResult.filePath);

              let projectMsg = '';
              if (args.addToProject !== false) {
                if (projectPathToUse) {
                  try {
                    const projectManager = new ProjectFileManager();
                    await projectManager.addToProject(
                      projectPathToUse,
                      args.objectType,
                      finalObjectName,
                      smartResult.filePath,
                    );
                    projectMsg = `\n✅ Added to project: ${path.basename(projectPathToUse)}`;
                  } catch (projErr) {
                    projectMsg = `\n⚠️ Could not add to project: ${projErr}`;
                  }
                } else if (solutionPathToUse) {
                  try {
                    const detectedPath = await ProjectFileFinder.findProjectInSolution(
                      solutionPathToUse,
                      actualModelName,
                    );
                    if (detectedPath) {
                      const projectManager = new ProjectFileManager();
                      await projectManager.addToProject(
                        detectedPath,
                        args.objectType,
                        finalObjectName,
                        smartResult.filePath,
                      );
                      projectMsg = `\n✅ Added to project: ${path.basename(detectedPath)}`;
                    } else {
                      projectMsg = `\n⚠️ Could not find .rnrproj for model '${actualModelName}' in ${solutionPathToUse}`;
                    }
                  } catch (projErr) {
                    projectMsg = `\n⚠️ Could not add to project: ${projErr}`;
                  }
                } else {
                  projectMsg = buildNoProjectPathWarning();
                }
              }

              // Schedule (do not await) the provider rebuild that makes the new object
              // resolvable to subsequent bridge calls. Awaiting it serialized a full
              // DiskProvider rebuild into every create's response — once per object on a
              // multi-object scaffold — for a provider generation the create itself never
              // reads. The flush() gate at the top of this block and in modify_d365fo_file
              // is what preserves same-session resolvability.
              void debouncedRefresh.refresh(context.bridge);

              const rawLabelWarning = rawLabelBpWarning(args.properties, finalObjectName);
              // #35: CreateSmartTable ignores every property its C# switch does not
              // know (configurationKey, formRef, …) — repair or report, never drop.
              const honestyReport = await reconcileCreatedTableProperties(
                smartResult.filePath,
                args.properties,
              ) + await stampIndexValidTimeState(smartResult.filePath, args.properties);
              const bp = smartResult.bpDefaults;
              const bpSummary = bp
                ? `\n📋 BP defaults: CacheLookup=${bp.cacheLookup ?? '(n/a)'}, TitleField1=${bp.titleField1 ?? '(none)'}, ` +
                  `TitleField2=${bp.titleField2 ?? '(none)'}, PrimaryIndex=${bp.primaryIndex ?? '(none)'}, ` +
                  `ClusteredIndex=${bp.clusteredIndex ?? '(none)'}`
                : '';

              // Record the freshly-created file so undo_last_modification can roll
              // it back even in a non-git sandbox (PackagesLocalDirectory).
              if (!fileExisted) {
                recordCreatedArtifact({
                  filePath: smartResult.filePath,
                  objectType: args.objectType,
                  objectName: finalObjectName,
                  projectPath: projectPathToUse,
                });
              }

              // Index the new object in-process. The parser is right here, so making
              // the agent spend a round trip on update_symbol_index — which this very
              // response used to instruct it to do — plus another on the lookup that
              // failed for want of it, was pure waste.
              const indexNote = await upsertWrittenFileIntoIndex(smartResult.filePath, context);
              // Verify the write here rather than leaving the caller to spend a
              // verify_d365fo_project round trip asking what this call already knows.
              const verifyNote = renderWriteVerification(
                await verifyWrittenFile(
                  smartResult.filePath,
                  projectPathToUse,
                  membershipOf(args.objectType, finalObjectName, actualModelName),
                ),
              );
              const bpNote = await runInlineBpCheck((args as any).bpCheck, args.objectType, finalObjectName, context);

              return {
                content: [
                  {
                    type: 'text',
                    text: `✅ Created ${args.objectType} '${finalObjectName}' via IMetadataProvider.Create() (Smart)${crossModelNotice}${renameNote}\n` +
                      `📁 ${smartResult.filePath}${projectMsg}\n` +
                      `🔧 API: ${smartResult.api ?? 'IMetaTableProvider.Create (Smart)'}${bpSummary}${honestyReport}${rawLabelWarning}${labelAutoNote}${verifyNote}${indexNote}${bpNote}` +
                      validateWrittenXpp(sourceAsWritten(args.sourceCode, finalObjectName)),
                  },
                ],
              };
            }
            console.error(
              `[create_d365fo_file] createSmartTable returned ${JSON.stringify(smartResult)} — falling back to generic bridge create`,
            );
          } catch (smartErr) {
            console.error(`[create_d365fo_file] createSmartTable failed, falling back to generic bridge create: ${smartErr}`);
          }
        }

        const createAttempt = await timer.time(
          'C# bridge Create()',
          () => bridgeCreateObject(context.bridge, bridgeParams),
        );
        if (isBridgeFailure(createAttempt)) bridgeFailure = createAttempt;
        const bridgeResult = isBridgeFailure(createAttempt) ? null : createAttempt;
        if (bridgeResult?.success && bridgeResult.filePath) {
          console.error(`[create_d365fo_file] ✅ Created via C# bridge: ${bridgeResult.filePath}`);
          await normalizeCreatedArtifactEol(bridgeResult.filePath);

          // Add to .rnrproj if requested
          let projectMsg = '';
          if (args.addToProject !== false) {
            if (projectPathToUse) {
              try {
                const projectManager = new ProjectFileManager();
                await projectManager.addToProject(
                  projectPathToUse,
                  args.objectType,
                  finalObjectName,
                  bridgeResult.filePath,
                );
                projectMsg = `\n✅ Added to project: ${path.basename(projectPathToUse)}`;
              } catch (projErr) {
                projectMsg = `\n⚠️ Could not add to project: ${projErr}`;
              }
            } else if (solutionPathToUse) {
              // Try to find project in solution directory (same logic as XML fallback path)
              try {
                const detectedPath = await ProjectFileFinder.findProjectInSolution(
                  solutionPathToUse,
                  actualModelName,
                );
                if (detectedPath) {
                  const projectManager = new ProjectFileManager();
                  await projectManager.addToProject(
                    detectedPath,
                    args.objectType,
                    finalObjectName,
                    bridgeResult.filePath,
                  );
                  projectMsg = `\n✅ Added to project: ${path.basename(detectedPath)}`;
                } else {
                  projectMsg = `\n⚠️ Could not find .rnrproj for model '${actualModelName}' in ${solutionPathToUse}`;
                }
              } catch (projErr) {
                projectMsg = `\n⚠️ Could not add to project: ${projErr}`;
              }
            } else {
              projectMsg = buildNoProjectPathWarning();
            }
          }

          // Scheduled, not awaited — see the smart-table path above.
          void debouncedRefresh.refresh(context.bridge);

          const rawLabelWarning = rawLabelBpWarning(args.properties, finalObjectName);
          // #35: C# CreateTable() runs the same SetAxTableProperty() switch as the
          // smart path and ignores its return value just as thoroughly.
          const honestyReport = args.objectType === 'table'
            ? await reconcileCreatedTableProperties(bridgeResult.filePath, args.properties)
              + await stampIndexValidTimeState(bridgeResult.filePath, args.properties)
            : '';

          // Record the freshly-created file for non-git undo (see smart-table path).
          if (!fileExisted) {
            recordCreatedArtifact({
              filePath: bridgeResult.filePath,
              objectType: args.objectType,
              objectName: finalObjectName,
              projectPath: projectPathToUse,
            });
          }

          // Index the new object in-process — see the smart-table path above.
          const indexNote = await timer.time('symbol index upsert',
            () => upsertWrittenFileIntoIndex(bridgeResult.filePath, context));
          // Verify the write — see the smart-table path above.
          const verifyNote = renderWriteVerification(
            await timer.time('write verification', () => verifyWrittenFile(
              bridgeResult.filePath,
              projectPathToUse,
              membershipOf(args.objectType, finalObjectName, actualModelName),
            )),
          );
          const bpNote = await timer.time('inline BP check',
            () => runInlineBpCheck((args as any).bpCheck, args.objectType, finalObjectName, context));
          const xppRuleNote = validateWrittenXpp(sourceAsWritten(args.sourceCode, finalObjectName));

          return {
            content: [
              {
                type: 'text',
                text: `✅ Created ${args.objectType} '${finalObjectName}' via IMetadataProvider.Create()${crossModelNotice}${renameNote}\n` +
                  `📁 ${bridgeResult.filePath}${projectMsg}\n` +
                  `🔧 API: ${bridgeResult.message}${honestyReport}${rawLabelWarning}${labelAutoNote}${verifyNote}${indexNote}${bpNote}${xppRuleNote}${timer.render()}`,
              },
            ],
          };
        }
        // If bridge returned null or success=false, fall through to XML generation
        console.error(`[create_d365fo_file] Bridge returned ${JSON.stringify(bridgeResult)} — falling back to XML generation`);
      } catch (bridgeErr) {
        console.error(`[create_d365fo_file] Bridge create failed, falling back to XML: ${bridgeErr}`);
      }
    }

    // A view's <DataSource> must name the referenced QUERY'S ROOT DATASOURCE, not
    // the query. Neither `query` nor `view` is a bridge create type, so this
    // template is the only writer for them — read the query off disk (same model
    // folder) and hand its XML to the builder, which extracts the root name
    // (the 2026-07-21 eval sweep, finding #38).
    let effectiveProperties = args.properties;
    if (
      args.objectType === 'view' &&
      args.properties?.query &&
      !args.properties?.dataSource &&
      !args.properties?.queryRootDataSource &&
      !args.properties?.queryXml
    ) {
      const queryFile = path.join(
        path.dirname(modelPath),
        'AxQuery',
        `${String(args.properties.query)}.xml`,
      );
      try {
        const queryXml = await fs.readFile(queryFile, 'utf-8');
        effectiveProperties = { ...args.properties, queryXml };
        console.error(`[create_d365fo_file] Resolved view datasource from ${queryFile}`);
      } catch {
        console.error(
          `[create_d365fo_file] ⚠️ Could not read query '${args.properties.query}' at ${queryFile} — ` +
          `the view's <DataSource> falls back to the query name, which is usually wrong. ` +
          `Pass properties.dataSource explicitly.`,
        );
      }
    }

    // Generate (or use provided) XML content
    let xmlContent = args.xmlContent
      ? args.xmlContent
      : XmlTemplateGenerator.generate(
          args.objectType,
          finalObjectName,
          args.sourceCode,
          effectiveProperties
        );

    // Guard against HTML-entity-escaped xmlContent (e.g. "&lt;?xml..." instead of "<?xml...").
    // This writes silently — no XML parse happens on this path — so a caller mistake here
    // looks like a success and only breaks on the next build. Found authoring the
    // L2-numberseq-basic eval case: passing already-escaped XML through xmlContent produced
    // a file containing literal "&lt;"/"&gt;" instead of real tags.
    if (args.xmlContent && /&lt;\?xml|&lt;Ax\w/.test(args.xmlContent) && !args.xmlContent.trimStart().startsWith('<')) {
      throw new Error(
        'xmlContent appears to be HTML-entity-escaped (contains "&lt;" but does not start with a literal "<"). ' +
        'Pass raw XML (with literal < and >), not HTML-encoded text — this parameter is written to disk verbatim, unparsed.'
      );
    }

    // CRITICAL FIX: Replace unprefixed class/table names with prefixed finalObjectName
    // When xmlContent or sourceCode contains `class MyClass` but finalObjectName is `MyPrefixMyClass`,
    // the file would be named MyPrefixMyClass.xml but contain `class MyClass` — inconsistency!
    if (finalObjectName !== args.objectName && (args.xmlContent || args.sourceCode)) {
      const orig = args.objectName;
      const final = finalObjectName;
      // Escape for use in RegExp (handles dots in extension names like "Foo.Extension")
      const escapedOrig = orig.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

      // 1. `class OriginalName` / `public class OriginalName` etc.
      const classPattern = new RegExp(
        `\\b(public\\s+|private\\s+|protected\\s+|internal\\s+|final\\s+)?class\\s+${escapedOrig}\\b`,
        'g',
      );
      let replaced = xmlContent.replace(classPattern, (match) => match.replace(orig, final));

      // 2. classnum(OriginalName) — X++ intrinsic that refers to the class by name.
      //    Callers often write classnum(OriginalName) in the source code before prefixing.
      const classnumPattern = new RegExp(`\\bclassnum\\(\\s*${escapedOrig}\\s*\\)`, 'gi');
      replaced = replaced.replace(classnumPattern, (m) => m.replace(new RegExp(escapedOrig, 'i'), final));

      // 3. classStr(OriginalName) — used in [ExtensionOf(classStr(...))] and SysOperation attributes.
      const classStrPattern = new RegExp(`\\bclassStr\\(\\s*${escapedOrig}\\s*\\)`, 'gi');
      replaced = replaced.replace(classStrPattern, (m) => m.replace(new RegExp(escapedOrig, 'i'), final));

      if (replaced !== xmlContent) {
        console.error(
          `[create_d365fo_file] ✅ Fixed class name inconsistency: ` +
          `replaced \`${orig}\` with \`${final}\` in XML content (class decl, classnum, classStr)`,
        );
        xmlContent = replaced;
      }
    }

    // Sanitize AxReport XML structure — ensures required D365FO VS Designer elements
    // are always present, regardless of whether xmlContent came from the template or a caller.
    if (args.objectType === 'report') {
      xmlContent = XmlTemplateGenerator.sanitizeReportXml(xmlContent);
      // Convert remaining <Text><![CDATA[…]]></Text> to entity-encoded form.
      // sanitizeReportXml operates on CDATA internally; this final step converts
      // the output so that D365FO VS Designer renders the design correctly.
      xmlContent = XmlTemplateGenerator.encodeReportTextElement(xmlContent);
    }

    // Sanitize menu item XML — D365FO metadata deserializer requires
    // xmlns="Microsoft.Dynamics.AX.Metadata.V1" on the root element.
    if (args.objectType === 'menu-item-display' ||
        args.objectType === 'menu-item-action' ||
        args.objectType === 'menu-item-output') {
      xmlContent = XmlTemplateGenerator.sanitizeMenuItemXml(xmlContent);
    }

    // Sanitize table XML — ensures correct field element format required by D365FO deserializer.
    if (args.objectType === 'table') {
      xmlContent = XmlTemplateGenerator.sanitizeTableXml(xmlContent);
    }

    // Sanitize query XML — ensures xmlns="" and i:type="AxQuerySimple" on root element.
    if (args.objectType === 'query') {
      xmlContent = XmlTemplateGenerator.sanitizeQueryXml(xmlContent);
    }

    // Sanitize enum XML — fixes <Values> → <EnumValues> and adds xmlns:i if missing.
    // Applies to both template-generated and caller-provided xmlContent.
    if (args.objectType === 'enum') {
      xmlContent = XmlTemplateGenerator.sanitizeEnumXml(xmlContent);
    }

    // Safety net: ensure every pair of adjacent </Method>…<Method> is separated by
    // exactly one blank line. This guards against xmlContent supplied by callers
    // (e.g. from generate or generate_d365fo_xml) that might already be
    // correct, or against edge-cases in the generator that produces no blank line.
    // The replacement is idempotent: \n\n\n → \n\n (no double-blank lines created).
    xmlContent = xmlContent.replace(
      /<\/Method>\n(\t*)<Method>/g,
      '</Method>\n\n$1<Method>'
    );

    // #35: the template writer knows a FIXED property list too — anything else the
    // caller passed lands nowhere. Reconcile before the write so a repairable
    // property is emitted in canonical order and the rest is reported, not dropped.
    // The same reconcile now also names the structural collections the template has
    // no writer for (indexes/relations/custom field groups), which is the half that
    // used to come back as an identical ✅.
    let tableHonestyReport = '';
    if (args.objectType === 'table') {
      const reconciled = reconcileTableCreateProperties(xmlContent, args.properties);
      xmlContent = reconciled.xml;
      tableHonestyReport = renderTableCreateHonestyReport(reconciled);
    }

    // Why this writer ran at all. Only set when a bridge create threw — an
    // unavailable bridge or an unsupported objectType is the normal route here and
    // says nothing about the file's completeness.
    const bridgeFallbackNote = bridgeFailure
      ? `\n⚠️ Written by the local XML template, NOT by IMetadataProvider — ` +
        `${describeBridgeFailure(bridgeFailure)}.\n` +
        `   The template covers fewer constructs than the bridge does, so read the object ` +
        `back with get_object_info before building on it.\n`
      : '';

    // Form pattern gate: structural pattern violations (FP001-FP005, FP007)
    // block the write when FORM_PATTERN_ENFORCE is enabled (default).
    // Recommendations are appended to the success message instead.
    let formPatternWarnings = '';
    if (args.objectType === 'form') {
      const gate = await gateOnFormPatternErrors(
        xmlContent,
        `d365fo_file(action="create", form ${finalObjectName})`,
      );
      if (gate.blocked) {
        return gate.blocked;
      }
      if (gate.warningsText) {
        formPatternWarnings = `\n${gate.warningsText}\n`;
      }
    }

    // Form-extension control-shape gate: reject the malformed control shapes an AI
    // tends to hand-write (<AxFormControlExtension>, <ParentControlName>,
    // <FormControlExtension> wrapping the control, AxFormIntControl) — they pass XML
    // well-formedness but the D365FO deserializer rejects them. Blocks when
    // FORM_PATTERN_ENFORCE is on (default), else appends a warning.
    if (args.objectType === 'form-extension' && args.xmlContent) {
      const shapeProblems = validateFormExtensionControlShape(xmlContent);
      if (shapeProblems.length > 0) {
        const shapeError = buildFormExtensionShapeError(finalObjectName, shapeProblems);
        if (isFormPatternEnforceEnabled()) {
          return { content: [{ type: 'text', text: shapeError }], isError: true };
        }
        formPatternWarnings += `\n⚠️ ${shapeError}\n`;
      }
    }

    // Debug: Log XML content length
    const xmlSource = args.xmlContent ? 'provided by caller' : 'generated from template';
    console.error(
      `[create_d365fo_file] XML content (${xmlSource}): ${xmlContent.length} bytes`
    );
    console.error(
      `[create_d365fo_file] XML preview: ${xmlContent.substring(0, 200)}...`
    );

    // Write file matching D365FO convention: no BOM, CRLF, no trailing newline
    try {
      await writeFileAtomic(normalizedFullPath, normalizeD365Xml(xmlContent));
    } catch (writeError) {
      console.error(`[create_d365fo_file] Failed to write file:`, writeError);
      
      // Check if it's a disk/path issue
      const errorMessage = writeError instanceof Error ? writeError.message : String(writeError);
      if (errorMessage.includes('EINVAL') || errorMessage.includes('ENOENT')) {
        throw new Error(
          `Failed to write file to ${normalizedFullPath}.\n\n` +
          `Possible causes:\n` +
          `1. Drive K:\\ does not exist (running on Linux/Mac? Use packagePath parameter to override)\n` +
          `2. Directory ${path.dirname(normalizedFullPath)} is not accessible\n` +
          `3. Insufficient permissions\n\n` +
          `Original error: ${errorMessage}`
        );
      }
      throw writeError;
    }

    // Verify file was written
    const stats = await fs.stat(normalizedFullPath);
    const fileSizeKb = (stats.size / 1024).toFixed(1);
    console.error(
      `[create_d365fo_file] ✅ Written: ${normalizedFullPath}  (${fileSizeKb} KB)`
    );

    // This path paid for the rebuild TWICE: once here on the response path, and
    // again inside the fire-and-forget bridgeValidateAfterWrite() below, which
    // already goes through the same coalescer before reading the object back.
    // Scheduling here collapses both into the one rebuild validation waits for.
    if (context?.bridge) void debouncedRefresh.refresh(context.bridge);

    const bridgeValidation = '';
    // The read-back validation never reached the caller — every outcome went to
    // stderr — while its validateObject RPC sat in the sequential bridge pipe and
    // delayed the next MCP call. The refresh scheduled just above is the half that
    // callers depend on and runs unconditionally. Kept for debugging only.
    // See: https://github.com/dynamics365ninja/d365fo-mcp-server/issues/407
    if (process.env.DEBUG_LOGGING === 'true') {
      bridgeValidateAfterWrite(
        context?.bridge,
        args.objectType,
        finalObjectName,
      ).then(validationMsg => {
        if (validationMsg) {
          console.error(`[create_d365fo_file] Bridge validation: ${validationMsg}`);
        }
      }).catch(e => {
        console.error(`[create_d365fo_file] Bridge validation skipped: ${e}`);
      });
    }

    // Add to Visual Studio project if requested
    let projectMessage = '';
    if (args.addToProject) {
      // Try to find project file if not explicitly specified
      // Use projectPathToUse which includes values from .mcp.json config
      let projectPath = projectPathToUse;
      
      if (!projectPath && solutionPathToUse) {
        // Try to find project in solution directory
        // Use solutionPathToUse which includes values from .mcp.json config
        console.error(
          `[create_d365fo_file] Searching for .rnrproj in solution: ${solutionPathToUse}, model: ${actualModelName}`
        );
        const detectedPath = await ProjectFileFinder.findProjectInSolution(
          solutionPathToUse,
          actualModelName
        );

        if (!detectedPath) {
          console.error(
            `[create_d365fo_file] No .rnrproj found in solution directory`
          );
          projectMessage = `\n⚠️ Could not find .rnrproj file for model '${actualModelName}' in solution directory.\n` +
            `Searched in: ${solutionPathToUse}\n` +
            `Please specify projectPath parameter explicitly or add it to .mcp.json.\n`;
        } else {
          console.error(
            `[create_d365fo_file] Found project file: ${detectedPath}`
          );
          projectPath = detectedPath;
        }
      } else if (!projectPath) {
        projectMessage = `\n⚠️ Cannot add to project: projectPath could not be resolved.\n` +
          `Add projectPath to .mcp.json config, or pass it as a tool argument.\n` +
          `Example .mcp.json: { "servers": { "context": { "projectPath": "K:\\\\VSProjects\\\\MySolution\\\\MyModel\\\\MyModel.rnrproj" } } }\n`;
      }

      if (projectPath) {
        try {
          // Validate project file exists
          await fs.access(projectPath);

          // D365FO projects expect ABSOLUTE paths to XML files, not relative
          // The full path must point to the exact XML location in PackagesLocalDirectory
          // Ensure Windows path format with backslashes
          const absoluteXmlPath = normalizedFullPath;

          // Add to project
          const projectManager = new ProjectFileManager();
          const wasAdded = await projectManager.addToProject(
            projectPath,
            args.objectType,
            finalObjectName,
            absoluteXmlPath
          );

          if (wasAdded) {
            console.error(`[create_d365fo_file] Successfully added to project`);
            // No "right-click → Reload Project" line: ~110 chars of a human's VS
            // UI chore, repeated on EVERY create and re-billed on every later
            // request in the session, that the agent reading this cannot act on.
            projectMessage = `\n✅ Added to project: ${projectPath}\n`;
          } else {
            console.error(`[create_d365fo_file] File already exists in project`);
            projectMessage = `\n✅ Already referenced by project: ${projectPath}\n`;
          }
        } catch (projectError) {
          const errMsg = projectError instanceof Error ? projectError.message : 'Unknown error';
          const isLocked = errMsg.includes('EBUSY') || errMsg.includes('EPERM') || errMsg.includes('EACCES');
          console.error(
            `[create_d365fo_file] Failed to add to project:`,
            projectError
          );
          projectMessage = `\n⚠️ File created but failed to add to project:\n${errMsg}\n` +
            (isLocked
              ? `This usually means Visual Studio has the .rnrproj file locked.\n` +
                `Close Visual Studio (or unload the project), re-run the tool, then reopen.\n`
              : '');
        }
      } else if (!projectMessage) {
        // No projectPath found from any source — surface this in the response so AI and user see it
        projectMessage = buildNoProjectPathWarning() +
          `\nUntil resolved, add the file manually in Visual Studio: right-click project → Add Existing Item → ${normalizedFullPath}\n`;
      }
    }

    // Only the step the AGENT can take, and only ONE of them.
    //
    // `bpCheck:true` makes the build run the best-practice checker too, so this
    // is one follow-up call rather than the build → run_bp_check →
    // verify_d365fo_project chain the logs actually show (39 run_bp_check and 35
    // verify_d365fo_project calls in 1,400, largely right after writes that had
    // already verified themselves inline — see verifyNote/indexNote above).
    //
    // The old tail also carried a `⛔ TASK COMPLETE — do NOT call generate,
    // generate, or d365fo_file(action="create") again` banner: 133 chars that
    // named the same tool twice (a copy/paste defect) to say what the one clause
    // appended to the batch-edit hint below says in 47.
    const nextSteps = (args.addToProject
      ? `Next: build_d365fo_project(bpCheck:true) — builds AND best-practice-checks in one call.\n`
      : `Next: add the file to your .rnrproj, then build_d365fo_project(bpCheck:true) — builds AND best-practice-checks in one call.\n`) +
      // finalObjectName, not args.objectName — see renderBatchEditHint.
      renderBatchEditHint(args.objectType, finalObjectName, { afterCreate: true }) +
      `It exists now — do not create it again.\n`;

    // Record the freshly-created file for non-git undo (see the bridge paths above).
    if (!fileExisted) {
      recordCreatedArtifact({
        filePath: normalizedFullPath,
        objectType: args.objectType,
        objectName: finalObjectName,
        projectPath: args.addToProject ? projectPathToUse : undefined,
      });
    }

    // Index the new object in-process — see the bridge paths above.
    const indexNote = await upsertWrittenFileIntoIndex(normalizedFullPath, context);
    // Verify the write — see the bridge paths above.
    const verifyNote = renderWriteVerification(
      await verifyWrittenFile(
        normalizedFullPath,
        args.addToProject ? projectPathToUse : undefined,
        membershipOf(args.objectType, finalObjectName, actualModelName),
      ),
    );
    const bpNote = await runInlineBpCheck((args as any).bpCheck, args.objectType, finalObjectName, context);
    // Offline X++ rules on the source as written. A create hands over the whole
    // class, so the class-scoped rules (COC004, COC005) apply here — the cheap
    // moment to catch what xppbp does not and only a build would.
    const xppRuleNote = validateWrittenXpp(sourceAsWritten(args.sourceCode, finalObjectName));

    // Return success message with file path
    return {
      content: [
        {
          type: 'text',
          // One headline plus the path. `📄 Object:`, `📦 Model:` and `🔧 Type:`
          // were three more lines re-stating what the path already spells out
          // (…\<model>\<model>\<objectFolder>\<finalObjectName>.xml); only the
          // rename disclosure is information the path does not carry, so that is
          // the part kept — see createRenameDisclosure.test.ts for why it must be.
          text: `✅ Created ${args.objectType} ${finalObjectName}` +
            `${finalObjectName !== args.objectName ? ` (prefixed from "${args.objectName}")` : ''}` +
            `${crossModelNotice}\n📁 ${normalizedFullPath}\n` +
            bridgeValidation +
            formPatternWarnings +
            bridgeFallbackNote +
            tableHonestyReport +
            rawLabelBpWarning(args.properties, finalObjectName) +
            labelAutoNote +
            extensibleEnumOrderingWarning(args.objectType, args.properties, finalObjectName) +
            projectMessage +
            verifyNote +
            indexNote +
            bpNote +
            xppRuleNote +
            timer.render() +
            `\n${nextSteps}`,
        },
      ],
    };
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `❌ Error creating D365FO file:\n\n${error instanceof Error ? error.message : 'Unknown error'}`,
        },
      ],
      isError: true,
    };
  }
}

// This handler has no schema of its own — it is reached through a unified
// tool. Tool registration (name, description, inputSchema) lives in
// src/server/toolSchemas/, one file per published tool, aggregated by
// toolSchemas/index.ts. It is NOT in mcpServer.ts; that file only spreads
// the aggregated array into the ListTools response.