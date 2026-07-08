/**
 * Generate Smart Form Tool
 * AI-driven form generation using indexed metadata patterns
 */

import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { XppSymbolIndex } from '../metadata/symbolIndex.js';
import { SmartXmlBuilder, FormDataSourceSpec, FormControlSpec } from '../utils/smartXmlBuilder.js';
import { FormPatternTemplates } from '../utils/formPatternTemplates.js';
import { handleGetFormPatterns } from './getFormPatterns.js';
import path from 'path';
import fs from 'fs';
import { getConfigManager } from '../utils/configManager.js';
import { resolveObjectPrefix, applyObjectPrefix, getObjectSuffix, applyObjectSuffix } from '../utils/modelClassifier.js';
import { ProjectFileManager } from './createD365File.js';
import { extractModelFromProject, findProjectInSolution } from '../utils/projectUtils.js';
import { normalizeD365Xml } from '../utils/d365XmlNormalizer.js';
import { validateFormPatternXml } from '../validation/formPatternValidator.js';
import { resolvePattern } from '../knowledge/formPatterns/index.js';
import { expandPatternToXml, canExpandPattern } from '../utils/formControlExpander.js';
import { cloneFormXml } from '../utils/formCloner.js';
import { methodStubsForPattern, injectMethodStubs } from '../knowledge/formPatterns/methodStubs.js';
import { findBaseFormXml } from './modifyD365File.js';
import { getFieldControlMap, type FieldControlMap } from '../utils/fieldControlTypes.js';

interface GenerateSmartFormArgs {
  name: string;
  label?: string;
  caption?: string;
  dataSource?: string;
  linesTable?: string;
  linesDataSource?: string;
  formPattern?: string;
  copyFrom?: string;
  cloneFrom?: string;
  tableMapping?: Record<string, string>;
  includeMethodStubs?: boolean;
  generateControls?: boolean;
  modelName?: string;
  projectPath?: string;
  solutionPath?: string;
}

export const generateSmartFormTool: Tool = {
  name: 'generate_smart_form',
  description: 'Generate AxForm XML using D365FO pattern-aware templates. Supported patterns: SimpleList | SimpleListDetails | DetailsMaster | DetailsTransaction | Dialog | TableOfContents | Lookup | Workspace. Can copy structure from existing forms or auto-generate grid from table fields.',
  inputSchema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'Form name (e.g., "MyCustomForm")',
      },
      label: {
        type: 'string',
        description: 'Optional label for the form',
      },
      caption: {
        type: 'string',
        description: 'Optional caption/title datasource',
      },
      dataSource: {
        type: 'string',
        description: 'Optional: Table name for primary datasource. Tool will auto-generate grid with fields.',
      },
      linesTable: {
        type: 'string',
        description: 'Optional: Lines table name for header+lines patterns (DetailsTransaction). ' +
          'Creates a second datasource joined to the header (JoinSource + LinkType=Delayed), ' +
          'populates the lines grid with typed field controls, and the field list on the datasource.',
      },
      linesDataSource: {
        type: 'string',
        description: 'Optional: explicit lines datasource name (defaults to the lines table name).',
      },
      formPattern: {
        type: 'string',
        description: 'Optional: D365FO form pattern. Valid values: SimpleList (default, for setup/config lists), SimpleListDetails (list + detail panel), DetailsMaster (full master record), DetailsTransaction (header+lines, e.g. orders), Dialog (popup dialog), TableOfContents (tabbed settings page), Lookup (dropdown lookup), Workspace (operational workspace with KPI tiles and panorama sections). Aliases like "list", "master", "transaction", "dialog", "workspace", "panorama" are also accepted.',
      },
      copyFrom: {
        type: 'string',
        description: 'Optional (legacy): Copy datasource list from an existing form. Prefer cloneFrom for full-fidelity cloning.',
      },
      cloneFrom: {
        type: 'string',
        description: 'PREFERRED strategy: clone the COMPLETE XML of an existing form (full control hierarchy, ' +
          'patterns and sub-patterns preserved), then re-bind it via tableMapping. ' +
          'Use a Microsoft reference form for the chosen pattern (e.g. CustGroup for SimpleList, ' +
          'PaymTerm for SimpleListDetails, CustParameters for TableOfContents). ' +
          'Methods except classDeclaration are stripped; fields missing on target tables are dropped (reported).',
      },
      tableMapping: {
        type: 'object',
        additionalProperties: { type: 'string' },
        description: 'With cloneFrom: map of sourceTable → targetTable, e.g. {"CustGroup": "MyPrefixRentalGroup"}. ' +
          'Datasources are re-bound, fields not present on the target table are dropped and reported.',
      },
      includeMethodStubs: {
        type: 'boolean',
        description: 'If true, inject pattern-appropriate lifecycle method stubs ' +
          '(form init/executeQuery/closeOk, datasource initValue/active/validateWrite) with TODO markers.',
      },
      generateControls: {
        type: 'boolean',
        description: 'If true, auto-generate grid controls for datasource fields',
      },
      modelName: {
        type: 'string',
        description: 'Model name for file creation (auto-detected from projectPath)',
      },
      projectPath: {
        type: 'string',
        description: 'Path to .rnrproj file (used to extract correct ModelName)',
      },
      solutionPath: {
        type: 'string',
        description: 'Path to solution directory (alternative to projectPath)',
      },
    },
    required: ['name'],
  },
};

/**
 * Default Design/Caption for a scaffolded form (pure — no DB access).
 *
 * Regression (eval/corpus/runs/2026-07-06T17__L1-form-listpage__cb1b73d.json,
 * cross-referenced by L1-form-dialog and L1-form-lookup — "a systemic
 * scaffold default, not a one-off"): when neither an explicit `caption` nor
 * `label` argument was given, the caption defaulted to the raw object name
 * (e.g. "PFXDemoNoteHeaderListPage") instead of reusing the bound
 * datasource table's own Label — even though that Label is resolvable via
 * the bridge/symbol index and is exactly the value real D365FO forms use
 * (raw-text captions also trip BPErrorLabelIsText and cascade into
 * BPErrorCaptionNotDefined on unlabeled ActionPane/ButtonGroups). Reusing
 * the bound table's Label when available is both more correct and BP-clean.
 */
export function resolveFormCaption(
  explicitCaption: string | undefined,
  explicitLabel: string | undefined,
  tableLabel: string | undefined,
  fallbackName: string,
): string {
  return explicitCaption || explicitLabel || tableLabel || fallbackName;
}

/**
 * Look up a table's own Label reference (e.g. "@TaxTransactionInquiry:HeaderNote")
 * from the symbol index, for use as a scaffolded form's default caption. Returns
 * undefined when the table is unindexed or has no Label recorded — callers fall
 * back to `label`/the raw object name via `resolveFormCaption`.
 */
export function lookupTableLabel(symbolIndex: XppSymbolIndex, table: string | undefined): string | undefined {
  if (!table) return undefined;
  try {
    return symbolIndex.getSymbolByName?.(table, 'table')?.signature || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Pre-write check for cloneFrom: cloning copies the reference form's control
 * hierarchy and sub-patterns verbatim. If the caller asked for a different
 * pattern than the reference declares, the result will likely violate the
 * requested pattern (e.g. SimpleListDetails forbids a Tab the source carried)
 * and be rejected by the form-pattern validator. Returns a warning line when the
 * cloned form's declared <Pattern> differs from the requested pattern, or null
 * when they match / either can't be determined.
 */
export function cloneFromPatternMismatchWarning(
  requestedPattern: string | undefined,
  clonedXml: string,
  sourceFormName: string,
): string | null {
  if (!requestedPattern) return null;
  const intended = resolvePattern(requestedPattern);
  const clonedPattern = clonedXml.match(/<Pattern xmlns="">([^<]+)<\/Pattern>/)?.[1];
  if (!intended || !clonedPattern) return null;
  if (intended.xmlName.toLowerCase() === clonedPattern.toLowerCase()) return null;

  const ref = intended.referenceForms?.[0];
  return (
    `🛑 PATTERN MISMATCH — you requested "${intended.xmlName}" but "${sourceFormName}" is a "${clonedPattern}" form. ` +
    `Cloning copies that structure verbatim, so the result may violate "${intended.xmlName}" ` +
    `(controls/sub-patterns the target pattern disallows) and be rejected by the form-pattern validator.` +
    (ref
      ? ` Clone a "${intended.xmlName}" reference instead, e.g. cloneFrom="${ref}".`
      : ` Clone a reference form that already uses "${intended.xmlName}".`)
  );
}

/**
 * Pre-clone table-mapping coverage check (pure — no DB/fs access).
 *
 * `getTableFields(table)` must return the field-name list for a table, or `null`
 * when the table is unknown to the caller (e.g. not yet in the symbol index).
 * Two independent failure classes, checked separately:
 *   - unknownTargets: the MAPPED target table has no known fields at all — cloning
 *     cannot verify overlap, and (per cloneFormXml's own "unknown table → keep
 *     fields" fallback) would silently leave that datasource bound to the SOURCE
 *     table's fields instead of failing. Always worth surfacing loudly.
 *   - poorOverlap: both tables are known, but share too few fields (<30%) for the
 *     clone to be structurally meaningful.
 * Source tables with <3 known fields are skipped (too little signal either way).
 */
export function checkTableMappingCoverage(
  tableMapping: Record<string, string>,
  getTableFields: (table: string) => string[] | null,
): { unknownTargets: string[]; poorOverlap: string[] } {
  const unknownTargets: string[] = [];
  const poorOverlap: string[] = [];
  for (const [srcTable, tgtTable] of Object.entries(tableMapping)) {
    if (!tgtTable || srcTable.toLowerCase() === tgtTable.toLowerCase()) continue;
    const srcFields = getTableFields(srcTable);
    const tgtFields = getTableFields(tgtTable);
    if (!tgtFields || tgtFields.length === 0) {
      unknownTargets.push(tgtTable);
      continue;
    }
    if (!srcFields || srcFields.length < 3) continue;
    const tgtFieldSet = new Set(tgtFields.map((f) => f.toLowerCase()));
    const shared = srcFields.filter((f) => tgtFieldSet.has(f.toLowerCase()));
    const ratio = shared.length / srcFields.length;
    if (ratio < 0.3) {
      poorOverlap.push(
        `${srcTable} → ${tgtTable}: ${shared.length}/${srcFields.length} fields shared (${Math.round(ratio * 100)} %)`,
      );
    }
  }
  return { unknownTargets: [...new Set(unknownTargets)], poorOverlap };
}

export async function handleGenerateSmartForm(
  args: GenerateSmartFormArgs,
  symbolIndex: XppSymbolIndex
): Promise<any> {
  const {
    name,
    label,
    caption,
    dataSource,
    linesTable,
    linesDataSource,
    formPattern,
    copyFrom,
    cloneFrom,
    tableMapping,
    includeMethodStubs,
    generateControls,
    modelName,
    projectPath,
    solutionPath,
  } = args;

  console.log(`[generateSmartForm] Generating form: ${name}, dataSource=${dataSource}, pattern=${formPattern}, copyFrom=${copyFrom}, cloneFrom=${cloneFrom}`);

  const builder = new SmartXmlBuilder(symbolIndex);
  let dataSources: FormDataSourceSpec[] = [];
  let controls: FormControlSpec[] = [];

  // Strategy 1: copy datasources from an existing form
  if (copyFrom) {
    console.log(`[generateSmartForm] Copying structure from: ${copyFrom}`);
    try {
      const db = symbolIndex.getReadDb();

      const dbDataSources = db.prepare(`
        SELECT datasource_name, table_name, allow_edit, allow_create, allow_delete
        FROM form_datasources
        WHERE form_name = ?
        ORDER BY datasource_name
      `).all(copyFrom) as Array<{
        datasource_name: string;
        table_name: string;
        allow_edit: number;
        allow_create: number;
        allow_delete: number;
      }>;

      if (dbDataSources.length === 0) {
        const formExists = db.prepare(`
          SELECT name FROM symbols WHERE type = 'form' AND name = ? LIMIT 1
        `).get(copyFrom);

        if (!formExists) {
          throw new Error(`Form "${copyFrom}" not found in index`);
        }
        console.warn(`[generateSmartForm] Form "${copyFrom}" found but has no indexed datasources`);
      }

      dataSources = dbDataSources.map((ds) => ({
        name: ds.datasource_name,
        table: ds.table_name,
        allowEdit: ds.allow_edit === 1,
        allowCreate: ds.allow_create === 1,
        allowDelete: ds.allow_delete === 1,
      }));

      console.log(`[generateSmartForm] Copied ${dataSources.length} datasources from ${copyFrom}`);
    } catch (error) {
      console.error(`[generateSmartForm] Failed to copy from ${copyFrom}:`, error);
      throw new Error(`Failed to copy structure from ${copyFrom}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // Strategy 2: create datasource from table and analyze patterns
  if (dataSource && !copyFrom) {
    // Validates the table exists and fuzzy-corrects pluralisation (e.g. "...Tables" -> "...Table").
    let dataSourceResolved = dataSource;
    try {
      const db = symbolIndex.getReadDb();
      const directHit = db.prepare(
        `SELECT name FROM symbols WHERE type = 'table' AND name = ? COLLATE NOCASE LIMIT 1`,
      ).get(dataSource) as { name: string } | undefined;
      if (!directHit) {
        const add = (n: string | undefined) => {
          const v = (n ?? '').trim();
          if (v && !candidates.some((c: string) => c.toLowerCase() === v.toLowerCase())) candidates.push(v);
        };
        const candidates: string[] = [];
        add(dataSource.replace(/s$/i, ''));
        add(dataSource.replace(/Tables?$/i, 'Table'));
        add(dataSource.replace(/Table$/i, ''));
        const matched = candidates
          .map(c => db.prepare(
            `SELECT name FROM symbols WHERE type = 'table' AND name = ? COLLATE NOCASE LIMIT 1`,
          ).get(c) as { name: string } | undefined)
          .find(r => r)?.name;
        if (matched) {
          console.log(`[generateSmartForm] dataSource "${dataSource}" → "${matched}" (auto-corrected)`);
          dataSourceResolved = matched;
        } else {
          const alt = db.prepare(
            `SELECT name FROM symbols WHERE type = 'table' AND name LIKE ? COLLATE NOCASE ORDER BY LENGTH(name) ASC LIMIT 1`,
          ).get(`${dataSource.replace(/s$/i, '')}%`) as { name: string } | undefined;
          const suggestion = alt ? `\n\nDid you mean \`dataSource="${alt.name}"\`?` : '';
          return {
            content: [{
              type: 'text',
              text: `❌ Table "${dataSource}" not found in the symbol index.${suggestion}\n\nIf the table was just created in this session, call \`update_symbol_index\` first, then retry.`,
            }],
          };
        }
      }
    } catch {
      /* index unavailable — proceed with provided name */
    }

    console.log(`[generateSmartForm] Creating datasource for table: ${dataSourceResolved}`);
    dataSources.push({
      name: dataSourceResolved,
      table: dataSourceResolved,
      allowEdit: true,
      allowCreate: true,
      allowDelete: true,
    });

    if (formPattern) {
      try {
        await handleGetFormPatterns(
          { formPattern },
          symbolIndex
        );
        console.log(`[generateSmartForm] Analyzed pattern: ${formPattern}`);
      } catch (error) {
        console.warn(`[generateSmartForm] Pattern analysis failed:`, error);
      }
    }
  }

  // Strategy 3: generate controls for datasource fields (also collects gridFields
  // for pattern templates regardless of the generateControls flag)
  let gridFields: string[] = [];
  // Field -> control-type map (enum->ComboBox, date->Date, etc.) so generated controls
  // aren't all typed as String.
  let fieldTypes: FieldControlMap | undefined;
  let linesFields: string[] = [];
  let linesFieldTypes: FieldControlMap | undefined;

  // Table fields minus system fields, capped for a sensible grid width.
  const collectGridFields = (db: any, table: string): string[] => {
    const dbFields = db.prepare(`
      SELECT name FROM symbols
      WHERE type = 'field' AND parent_name = ? COLLATE NOCASE
      ORDER BY name
    `).all(table) as Array<{ name: string }>;
    return dbFields
      .map((f) => f.name)
      .filter((n) => !['RecId', 'RecVersion', 'DataAreaId', 'Partition'].includes(n))
      .slice(0, 8);
  };

  // May differ from the input after fuzzy resolution above.
  const dataSourceEffective = dataSources[0]?.table ?? dataSource;

  if (dataSource && dataSources.length > 0) {
    try {
      const db = symbolIndex.getReadDb();
      gridFields = collectGridFields(db, dataSourceEffective);
      fieldTypes = getFieldControlMap(db, dataSourceEffective);

      if (gridFields.length > 0) {
        if (generateControls) {
          const gridControl = builder.buildGridControl(
            `${dataSourceEffective}Grid`,
            dataSourceEffective,
            gridFields,
            fieldTypes,
          );
          controls.push(gridControl);
          console.log(`[generateSmartForm] Generated grid with ${gridFields.length} fields`);
        } else {
          console.log(`[generateSmartForm] Collected ${gridFields.length} grid fields for pattern template`);
        }
      }
    } catch (error) {
      console.warn(`[generateSmartForm] Failed to generate controls:`, error);
    }
  }

  // Lines datasource (header+lines patterns): add a second datasource bound to
  // the lines table, with its own typed field controls and field list.
  let linesTableResolved = linesTable || linesDataSource;
  // Effective lines datasource name; may differ from the corrected table name when an
  // explicit, distinct linesDataSource is supplied. Hoisted so method-stub injection
  // below references the same name as the datasource actually emitted.
  let linesDsNameResolved: string | undefined;
  // Note about an auto-corrected lines table name, surfaced via cloneNotes.
  let linesTableNote = '';
  if (linesTableResolved) {
    // Lines table names are commonly guessed wrong (e.g. header "...Table" -> "...TableLines"
    // instead of the real "...Line"). Try structured candidates from the given name and the
    // header table, auto-correct to the first that exists, hard-fail only if none resolve.
    try {
      const db = symbolIndex.getReadDb();
      const exists = db.prepare(
        `SELECT name FROM symbols WHERE type = 'table' AND name = ? COLLATE NOCASE LIMIT 1`,
      );
      const direct = exists.get(linesTableResolved) as { name: string } | undefined;
      if (!direct) {
        const candidates: string[] = [];
        const add = (n?: string | null) => {
          const v = (n ?? '').trim();
          if (v && !candidates.some(c => c.toLowerCase() === v.toLowerCase())) candidates.push(v);
        };
        const ln = linesTableResolved;
        add(ln.replace(/s$/i, ''));
        add(ln.replace(/Lines$/i, 'Line'));
        add(ln.replace(/Table(Lines?)$/i, 'Line'));
        add(ln.replace(/Table(Lines?)$/i, '$1'));
        if (dataSource) {
          const base = dataSource.replace(/Table$/i, ''); // header base, e.g. ContosoRentAgreement
          add(`${base}Line`);
          add(`${base}Lines`);
          add(`${base}TransLine`);
          add(`${base}Trans`);
        }

        let matched: string | undefined;
        for (const cand of candidates) {
          const hit = exists.get(cand) as { name: string } | undefined;
          if (hit) { matched = hit.name; break; }
        }

        if (matched) {
          linesTableNote =
            `\n   🔍 linesTable "${linesTableResolved}" not found — auto-corrected to "${matched}" (verified in the index).`;
          console.log(`[generateSmartForm] linesTable "${linesTableResolved}" → "${matched}" (auto-corrected)`);
          linesTableResolved = matched;
        } else {
          const stem = linesTableResolved.replace(/s$/i, '');
          const alt = db.prepare(
            `SELECT name FROM symbols WHERE type = 'table' AND name LIKE ? COLLATE NOCASE ORDER BY LENGTH(name) ASC LIMIT 1`,
          ).get(`${stem}%`) as { name: string } | undefined;
          const suggestion = alt && alt.name.toLowerCase() !== linesTableResolved.toLowerCase()
            ? `\n\nDid you mean \`linesTable="${alt.name}"\`?`
            : '';
          return {
            content: [{
              type: 'text',
              text:
                `❌ Lines table "${linesTableResolved}" not found in the symbol index.` +
                suggestion +
                `\n\nIf the table was just created in this session, call \`update_symbol_index\` first, then retry.`,
            }],
            isError: true,
          };
        }
      }
    } catch {
      /* index unavailable — skip validation and proceed */
    }

    // Datasource name: by D365FO convention it equals the (corrected) table name.
    // Honor an explicit linesDataSource ONLY when it is a genuinely distinct name —
    // not just the wrong pluralized guess (e.g. "ContosoRentAgreementLines") that the
    // table auto-correction above already resolved to "ContosoRentAgreementLine".
    // Otherwise the form ends up with a datasource named after a non-existent table.
    // Local const captures the (possibly auto-corrected) table name so TS keeps the
    // non-undefined narrowing through the reassignments above.
    const linesTbl: string = linesTableResolved;
    const explicitDsIsStalePlural =
      !!linesDataSource &&
      linesDataSource.toLowerCase() !== linesTbl.toLowerCase() &&
      (linesDataSource.replace(/s$/i, '').toLowerCase() === linesTbl.toLowerCase() ||
        linesDataSource.toLowerCase() === `${linesTbl.toLowerCase()}s`);
    const dsName = linesDataSource && !explicitDsIsStalePlural ? linesDataSource : linesTbl;
    linesDsNameResolved = dsName;

    // Guard against a duplicate datasource: skip when one already targets the same
    // table or already uses the same name (prevents the stale "…Lines" + correct
    // "…Line" double-datasource the form scaffolder previously produced).
    const isDuplicateDs = dataSources.some(
      ds =>
        ds.table.toLowerCase() === linesTbl.toLowerCase() ||
        ds.name.toLowerCase() === dsName.toLowerCase(),
    );
    if (!isDuplicateDs) {
      dataSources.push({
        name: dsName,
        table: linesTbl,
        allowEdit: true,
        allowCreate: true,
        allowDelete: true,
      });
    } else {
      console.log(`[generateSmartForm] Skipped duplicate lines datasource for table "${linesTbl}"`);
    }
    try {
      const db = symbolIndex.getReadDb();
      linesFields = collectGridFields(db, linesTableResolved);
      linesFieldTypes = getFieldControlMap(db, linesTableResolved);
      console.log(`[generateSmartForm] Lines datasource ${linesDsNameResolved} with ${linesFields.length} fields`);
    } catch (error) {
      console.warn(`[generateSmartForm] Failed to collect lines fields:`, error);
    }
  }

  // Fallback: At least one datasource needed
  if (dataSources.length === 0) {
    console.warn(`[generateSmartForm] No datasource configured, form will be empty`);
  }

  // Determine package path — prefer the bridge's custom packages root (where bridge-backed
  // writes actually land) so the reported/fallback path matches the real write location.
  const configManager = getConfigManager();
  const customPackagesRoot = await configManager.getCustomPackagesPath();
  const packagePath = customPackagesRoot || configManager.getPackagePath() || 'K:\\AosService\\PackagesLocalDirectory';

  // Resolve project/solution path — fall back to configManager (from .mcp.json / auto-detection)
  let resolvedProjectPath = projectPath;
  let resolvedSolutionPath = solutionPath;
  if (!resolvedProjectPath && !resolvedSolutionPath) {
    resolvedProjectPath = (await configManager.getProjectPath()) || undefined;
    resolvedSolutionPath = (await configManager.getSolutionPath()) || undefined;
    if (resolvedProjectPath) {
      console.log(`[generateSmartForm] Using projectPath from config/auto-detect: ${resolvedProjectPath}`);
    } else if (resolvedSolutionPath) {
      console.log(`[generateSmartForm] Using solutionPath from config/auto-detect: ${resolvedSolutionPath}`);
    }
  }

  // Resolve actual model name — always prefer extracting from .rnrproj over using modelName arg
  let resolvedModel = modelName;
  if (resolvedProjectPath) {
    const extracted = extractModelFromProject(resolvedProjectPath);
    if (extracted) {
      resolvedModel = extracted;
      console.log(`[generateSmartForm] Extracted model from .rnrproj: ${resolvedModel}`);
    }
  } else if (resolvedSolutionPath) {
    const project = findProjectInSolution(resolvedSolutionPath);
    if (project) {
      const extracted = extractModelFromProject(project);
      if (extracted) {
        resolvedModel = extracted;
        console.log(`[generateSmartForm] Extracted model from solution .rnrproj: ${resolvedModel}`);
      }
    }
  }

  const isNonWindows = process.platform !== 'win32';

  if (!resolvedModel) {
    // .rnrproj extraction failed (or wasn't attempted) — fall back in this order on ALL platforms:
    //   1. .mcp.json context (modelName field or last segment of workspacePath)
    //   2. Auto-detected model name (async) — e.g. from PackagesLocalDirectory regex / well-known paths
    //   3. D365FO_MODEL_NAME env var
    //   4. modelName arg — LAST because the AI often passes a placeholder like "any" or "whatever"
    const configModel = configManager.getModelName();
    const autoModel = configModel ? null : (await configManager.getAutoDetectedModelName());
    resolvedModel = configModel || autoModel || process.env.D365FO_MODEL_NAME || modelName || undefined;
    if (resolvedModel) {
      const ctx = configManager.getContext();
      const source = configModel === resolvedModel
        ? (ctx?.modelName ? 'modelName (mcp.json)' : 'workspacePath (mcp.json)')
        : autoModel === resolvedModel ? 'auto-detected (well-known paths)'
        : process.env.D365FO_MODEL_NAME === resolvedModel ? 'D365FO_MODEL_NAME env var'
        : 'modelName arg (fallback)';
      console.log(`[generateSmartForm] Using model from ${source}: ${resolvedModel}`);
    } else if (!isNonWindows) {
      // Windows VM: all sources exhausted — tell the user exactly what to configure.
      throw new Error(
        'Could not resolve model name. Provide modelName, projectPath, or solutionPath, ' +
        'or configure projectPath/solutionPath in .mcp.json or set D365FO_MODEL_NAME env var.'
      );
    }
    // Non-Windows: if still null, continue without a prefix.
  }

  console.log(`[generateSmartForm] Using model: ${resolvedModel ?? '(none — no prefix)'}`);

  // Apply extension prefix to form name (skip when model unknown)
  const objectPrefix = resolvedModel ? resolveObjectPrefix(resolvedModel) : '';
  let finalName = objectPrefix ? applyObjectPrefix(name, objectPrefix) : name;
  const objectSuffix = getObjectSuffix();
  finalName = applyObjectSuffix(finalName, objectSuffix);
  if (finalName !== name) {
    console.log(`[generateSmartForm] Applied naming: ${name} → ${finalName}`);
  }

  // Generate XML: clone an existing form (preferred) or build from a template.
  // Without an explicit pattern, default to the majority pattern mined from
  // standard models (property_stats), falling back to SimpleList.
  const normalizedPattern = formPattern
    ? FormPatternTemplates.normalizePattern(formPattern)
    : builder.defaultFormPattern();
  const primaryDs = dataSources[0];
  let xml: string;
  let cloneNotes = linesTableNote;

  if (cloneFrom) {
    const sourceXml = await findBaseFormXml(cloneFrom, symbolIndex);
    if (!sourceXml) {
      return {
        content: [{
          type: 'text',
          text:
            `❌ cloneFrom: form "${cloneFrom}" could not be read from the metadata store.\n\n` +
            `Options:\n` +
            `  1. Check the form name with search("${cloneFrom}", type="form").\n` +
            `  2. Rebuild/update the symbol index if the form is new.\n` +
            `  3. Fall back to a template: generate_object(mode="scaffold", objectType="form", name="${name}", formPattern="...", dataSource="...").`,
        }],
        isError: true,
      };
    }

    const db = symbolIndex.getReadDb();
    const fieldStmt = db.prepare(`
      SELECT name FROM symbols WHERE type = 'field' AND parent_name = ? COLLATE NOCASE
    `);
    // ── PRE-CLONE FIELD-OVERLAP CHECK ──────────────────────────────────────
    // Before cloning, verify the source and target tables are structurally
    // related (≥ 30 % shared fields per mapped pair). If the overlap is too
    // low, cloning will strip most controls and produce a useless form.
    // Fail-fast here rather than returning a gutted result.
    if (tableMapping && Object.keys(tableMapping).length > 0) {
      // Found live 2026-07-01 (usage-examples eval, scenario 2): cloneFrom="CustGroup"
      // + tableMapping to a just-created table not yet in the symbol index silently
      // produced a form with 0 datasources/controls, self-reported as success —
      // getTableFields returning null/empty for an unknown table used to make
      // cloneFormXml leave that datasource's fields untouched (still bound to the
      // SOURCE table) instead of failing. checkTableMappingCoverage now catches this
      // as `unknownTargets`, separate from the pre-existing `poorOverlap` check.
      const { unknownTargets, poorOverlap } = checkTableMappingCoverage(
        tableMapping as Record<string, string>,
        (table: string) => {
          const rows = fieldStmt.all(table) as Array<{ name: string }>;
          return rows.length > 0 ? rows.map((r) => r.name) : null;
        },
      );
      if (unknownTargets.length > 0) {
        return {
          content: [{
            type: 'text',
            text:
              `❌ PRE-CLONE CHECK — target table${unknownTargets.length > 1 ? 's' : ''} not found in the symbol index: ` +
              `${unknownTargets.join(', ')}.\n\n` +
              `Cloning cannot verify field overlap against an unindexed table, and the clone would silently keep ` +
              `"${cloneFrom}"'s OWN fields unmapped instead of failing — producing a form that looks bound to your ` +
              `table but whose datasource/controls still reference the source table's fields.\n\n` +
              `**Fix — choose one:**\n` +
              `1. If ${unknownTargets.join(', ')} was just created this session, index it first, then retry:\n` +
              `   \`update_symbol_index(filePath="<absolute path to ${unknownTargets[0]}.xml>")\`\n` +
              `2. Check the table name for a typo with \`search("${unknownTargets[0]}", type="table")\`.`,
          }],
          isError: true,
        };
      }
      if (poorOverlap.length > 0) {
        const targetList = Object.values(tableMapping as Record<string, string>).filter(Boolean).join(', ');
        return {
          content: [{
            type: 'text',
            text:
              `❌ PRE-CLONE CHECK — Poor field overlap between source and target tables:\n` +
              poorOverlap.map((s) => `  • ${s}`).join('\n') +
              `\n\nCloning "${cloneFrom}" would strip most of its controls ` +
              `(source and target tables are structurally unrelated).\n\n` +
              `**✅ Recommended fix — scaffold from a pattern template (fast, no cloning needed):**\n` +
              `\`\`\`\ngenerate_object(mode="scaffold", objectType="form",\n  name="${name}",\n  formPattern="${formPattern ?? 'SimpleList'}",\n  dataSource="${targetList}"\n)\n\`\`\`\n\n` +
              `**Alternative — find a structurally similar reference form first:**\n` +
              `\`object_patterns(domain="form", action="analyze", recommend={ "dataSource": "${targetList}", "pattern": "${formPattern ?? 'auto'}" })\`\n` +
              `Then re-run with the suggested \`cloneFrom\` value.`,
          }],
          isError: true,
        };
      }
    }
    // ── end pre-clone field-overlap check ─────────────────────────────────

    const cloneResult = cloneFormXml(sourceXml, {
      targetFormName: finalName,
      tableMapping,
      caption: caption || label,
      getTableFields: (table: string) => {
        const rows = fieldStmt.all(table) as Array<{ name: string }>;
        return rows.length > 0 ? rows.map((r) => r.name) : null; // unknown table → keep fields
      },
    });
    xml = cloneResult.xml;

    const noteLines: string[] = [`   Cloned from: ${cloneResult.sourceFormName}`];
    if (cloneResult.renamedDataSources.length > 0) {
      noteLines.push(`   Datasources re-bound: ${cloneResult.renamedDataSources.map(r => `${r.from}→${r.to}`).join(', ')}`);
    }
    if (cloneResult.strippedMethods.length > 0) {
      noteLines.push(`   Methods stripped (re-add what you need via d365fo_file(action="modify") add-method): ${cloneResult.strippedMethods.join(', ')}`);
    }
    if (cloneResult.clearedSourceCodeMirror) {
      noteLines.push(`   SourceCode datasource/control method mirror cleared (stale field/control method holders)`);
    }
    if (cloneResult.resetClassDeclaration) {
      noteLines.push(`   classDeclaration body reset to empty (source member vars/macros dropped with the methods)`);
    }
    if (cloneResult.removedIndexes.length > 0) {
      noteLines.push(`   Default datasource index dropped (source-table index): ${cloneResult.removedIndexes.map(i => `${i.dataSource}.${i.index}`).join(', ')}`);
    }
    if (cloneResult.droppedFields.length > 0) {
      noteLines.push(`   ⚠️ Fields dropped (missing on target table): ${cloneResult.droppedFields.map(d => `${d.dataSource}.${d.field}`).join(', ')}`);
    }
    // Poor-match guard: if a re-bound datasource lost most of its fields, the
    // reference form's table is structurally unrelated to the target — the clone
    // is likely unusable. Return an error immediately so the caller is forced to
    // pick a structurally similar reference form or scaffold from a template.
    // (Previously this only emitted a warning note and still returned the gutted
    // XML, which the model then tried to use — always resulting in manual rewrite.)
    const poorMatches = cloneResult.fieldStats.filter(s => s.total >= 3 && s.dropped / s.total >= 0.6);
    if (poorMatches.length > 0) {
      const matchSummary = poorMatches.map(s => `${s.dataSource}: ${s.dropped}/${s.total} fields dropped`).join('; ');
      const tableList = Object.values(tableMapping ?? {}).filter(Boolean).join(', ') || 'your target table';
      return {
        content: [{
          type: 'text',
          text:
            `❌ POOR CLONE MATCH — ${matchSummary}.\n\n` +
            `"${cloneResult.sourceFormName}" is bound to a table structurally unrelated to ${tableList}, ` +
            `so cloning would strip ${poorMatches.reduce((a, s) => a + s.dropped, 0)} of ${poorMatches.reduce((a, s) => a + s.total, 0)} controls and produce an unusable form.\n\n` +
            `**Fix — choose one:**\n` +
            `1. Find a structurally similar reference form first:\n` +
            `   \`object_patterns(domain="form", action="analyze", recommend={ "dataSource": "${tableList}", "pattern": "${formPattern ?? 'auto'}" })\`\n` +
            `   Then re-run with the suggested \`cloneFrom\` value.\n\n` +
            `2. Scaffold from a pattern template (no cloning needed):\n` +
            `   \`generate_object(mode="scaffold", objectType="form", name="${name}", formPattern="${formPattern ?? 'SimpleList'}", dataSource="${tableList}")\``,
        }],
        isError: true,
      };
    }
    if (cloneResult.removedControls.length > 0) {
      noteLines.push(`   ⚠️ Controls removed (bound to dropped fields): ${cloneResult.removedControls.join(', ')}`);
    }
    for (const rq of cloneResult.repointedQuickFilters) {
      noteLines.push(rq.to
        ? `   QuickFilter default column repointed: ${rq.from} → ${rq.to}`
        : `   ⚠️ QuickFilter default column "${rq.from}" was removed and no surviving column was found — set defaultColumnName manually`);
    }
    // Pattern-compatibility pre-check (see cloneFromPatternMismatchWarning).
    const mismatch = cloneFromPatternMismatchWarning(formPattern, xml, cloneResult.sourceFormName);
    if (mismatch) noteLines.push(`   ${mismatch}`);
    cloneNotes = `\n${noteLines.join('\n')}`;
  } else {
    const templateOpts = {
      formName: finalName,
      dsName: primaryDs?.name,
      dsTable: primaryDs?.table,
      caption: resolveFormCaption(caption, label, lookupTableLabel(symbolIndex, primaryDs?.table), finalName),
      gridFields,
      fieldTypes,
      linesDsName: linesDsNameResolved ?? (linesTableResolved || undefined),
      linesDsTable: linesTableResolved || undefined,
      linesFields,
      linesFieldTypes,
    };

    // Patterns FormPatternTemplates has a dedicated, hand-tuned builder for.
    // Anything else previously degraded silently to SimpleList; we now expand it
    // deterministically from the catalog instead (single source of truth).
    const TEMPLATED_PATTERNS = new Set([
      'SimpleList', 'SimpleListDetails', 'DetailsMaster', 'DetailsTransaction',
      'Dialog', 'TableOfContents', 'Lookup', 'ListPage', 'Workspace',
    ]);
    const intendedSpec = formPattern ? resolvePattern(formPattern) : undefined;

    let expanded: string | undefined;
    if (intendedSpec && !TEMPLATED_PATTERNS.has(intendedSpec.xmlName) && canExpandPattern(intendedSpec)) {
      // Deterministic catalog expansion. Self-test it: only adopt the result when
      // it is structurally error-free — otherwise fall through to the proven
      // template path so we can never regress.
      const candidate = expandPatternToXml(intendedSpec, templateOpts);
      const candidateReport = await validateFormPatternXml(candidate);
      if (!candidateReport.violations.some(v => v.severity === 'error')) {
        expanded = candidate;
        cloneNotes += `\n   ✅ Generated deterministically from the form-pattern catalog (pattern "${intendedSpec.xmlName}", no clone needed).`;
      } else {
        console.warn(`[generateSmartForm] Expander output for "${intendedSpec.xmlName}" failed self-test — falling back to template.`);
      }
    }

    if (expanded) {
      xml = expanded;
    } else {
      xml = FormPatternTemplates.build(normalizedPattern, templateOpts);

      // Warn when the requested pattern has no dedicated template and silently
      // degraded to another base (or to SimpleList). The emitted <Pattern> reflects
      // the template, not the request, and the self-test validates only the emitted
      // pattern — so this mismatch would otherwise pass unnoticed.
      const degradedPattern = xml.match(/<Pattern xmlns="">([^<]+)<\/Pattern>/)?.[1];
      if (formPattern && degradedPattern) {
        const intended = resolvePattern(formPattern);
        if (intended && intended.xmlName.toLowerCase() !== degradedPattern.toLowerCase()) {
          const ref = intended.referenceForms?.[0];
          cloneNotes +=
            `\n   ⚠️ No dedicated template for pattern "${intended.xmlName}" — generated a "${degradedPattern}" form instead.` +
            (ref
              ? ` For a true "${intended.xmlName}", clone a reference form: ` +
                `generate_object(mode="scaffold", objectType="form", name="${name}", cloneFrom="${ref}", tableMapping={...}).`
              : ` Clone a reference form for that pattern via cloneFrom=.`);
        }
      }
    }

    // Align the Design-level PatternVersion with the version this environment uses
    // for the pattern; template defaults can lag and be rejected by BP.
    const designPattern = xml.match(/<Pattern xmlns="">([^<]+)<\/Pattern>/)?.[1];

    if (designPattern) {
      const envVersion = resolveEnvPatternVersion(symbolIndex.getReadDb(), designPattern);
      if (envVersion) {
        const current = xml.match(/<PatternVersion xmlns="">([^<]*)<\/PatternVersion>/)?.[1];
        if (current && current !== envVersion) {
          xml = xml.replace(
            /(<PatternVersion xmlns="">)[^<]*(<\/PatternVersion>)/,
            `$1${envVersion}$2`,
          );
          cloneNotes += `\n   PatternVersion aligned to this environment: ${current} → ${envVersion}`;
        }
      }
    }
  }

  // Optional lifecycle method stubs (pattern-appropriate, with TODO markers)
  if (includeMethodStubs) {
    const patternInXml = xml.match(/<Pattern xmlns="">([^<]+)<\/Pattern>/)?.[1] ?? normalizedPattern;
    const stubDsName =
      xml.match(/<AxFormDataSource[^>]*>\s*<Name>([^<]+)<\/Name>/)?.[1] ?? primaryDs?.name ?? '';
    const stubLinesDsName = linesTableResolved ? (linesDsNameResolved || linesTableResolved) : undefined;
    const stubResult = injectMethodStubs(
      xml,
      methodStubsForPattern(patternInXml, stubDsName, stubLinesDsName),
      stubDsName,
      stubLinesDsName,
    );
    xml = stubResult.xml;
    if (stubResult.injected.length > 0) {
      cloneNotes += `\n   Method stubs injected: ${stubResult.injected.join(', ')}`;
    }
  }

  // Several patterns (SimpleList's Grid, and the FieldsFieldGroups Group control
  // on SimpleListDetails/DetailsMaster) bind <DataGroup>Overview</DataGroup> —
  // this ONLY builds if the datasource table has a matching AxTableFieldGroup
  // named "Overview". A brand-new/custom table created earlier in the same
  // session almost never has one yet, so the very next build fails with
  // "Field group 'Overview' does not exist" — a confusing failure with no clue
  // back to this control. Confirmed on this exact scaffold path (corpus:
  // eval/corpus/runs/2026-07-07T11__L3-form-add-datasource-lines__cb1b73d.json,
  // eval/corpus/runs/2026-07-07T15__L4-master-security-slice__cb1b73d.json).
  // This tool has no bridge/table-write access here to auto-create the field
  // group (and a prior investigation found that even a same-session
  // add-field-group call did not reliably become visible to xppc's build —
  // suspected metadata-provider staleness, unconfirmed without a live VM
  // re-check) — surface the dependency loudly instead of failing silently.
  if (/<DataGroup>Overview<\/DataGroup>/.test(xml)) {
    const overviewDsTable =
      xml.match(/<AxFormDataSource[^>]*>\s*<Name>[^<]+<\/Name>\s*<Table>([^<]+)<\/Table>/)?.[1]
      ?? primaryDs?.table ?? primaryDs?.name ?? dataSources[0]?.table;
    cloneNotes +=
      `\n   ⚠️ This form references a field group named "Overview" on ` +
      `${overviewDsTable ?? 'the datasource table'} — verify it already exists, or add one BEFORE ` +
      `building via d365fo_file(action="modify", objectType="table", objectName="${overviewDsTable ?? '<table>'}", ` +
      `operation="add-field-group", fieldGroupName="Overview", fieldGroupFields=[...]). Without it the ` +
      `build fails with "Field group 'Overview' does not exist".`;
  }

  console.log(`[generateSmartForm] Generated XML (${xml.length} bytes)`);

  // Self-test: generated XML must conform to its declared pattern.
  //  - Template path: errors mean template/catalog drift → hard-fail.
  //  - Clone path: a real source form may legitimately deviate from the
  //    catalog → report, don't block here (the write gate decides per
  //    FORM_PATTERN_ENFORCE at create time).
  const patternReport = await validateFormPatternXml(xml);
  const patternErrors = patternReport.violations.filter(v => v.severity === 'error');
  if (patternErrors.length > 0) {
    const errorList = patternErrors.map(v => `🔴 [${v.rule}] ${v.path}: ${v.excerpt}`).join('\n');
    if (!cloneFrom) {
      return {
        content: [{
          type: 'text',
          text:
            `❌ generate internal error: the generated XML violates its own pattern ` +
            `(${patternReport.pattern ?? normalizedPattern}). This indicates template/catalog drift — please report it.\n\n` +
            errorList,
        }],
        isError: true,
      };
    }
    cloneNotes +=
      `\n   ⚠️ Pattern validation found ${patternErrors.length} error(s) in the cloned XML ` +
      `(d365fo_file(action="create") will block them while FORM_PATTERN_ENFORCE=true):\n` +
      errorList.split('\n').map(l => `      ${l}`).join('\n');
  }

  // Warn when a datasource is bound to a table that does not exist in the index,
  // suggesting the closest real table name.
  //
  // Regression (eval/corpus/runs/2026-07-06T17__L1-form-dialog__cb1b73d.json): a
  // `symbols` row for a table can OUTLIVE the table itself — the index is a cache,
  // not invalidated when an object is deleted/rolled back on the VM. `SELECT 1 ...
  // WHERE name = ?` matched a phantom row from a prior (rolled-back) run's table, so
  // this check silently passed and the scaffold produced a form bound to a table with
  // no file on disk — a build failure with no warning here. Verify the indexed
  // file_path still exists before trusting a hit; a stale row is treated the same as
  // "not found".
  try {
    const db = symbolIndex.getReadDb();
    const tableRow = db.prepare(
      `SELECT file_path FROM symbols WHERE type = 'table' AND name = ? COLLATE NOCASE LIMIT 1`,
    );
    const seenTables = new Set<string>();
    for (const m of xml.matchAll(/<Table>([^<]+)<\/Table>/g)) {
      const table = m[1].trim();
      if (!table || seenTables.has(table.toLowerCase())) continue;
      seenTables.add(table.toLowerCase());
      const row = tableRow.get(table) as { file_path?: string } | undefined;
      const stale = row?.file_path && !fs.existsSync(row.file_path);
      if (row && !stale) continue;
      const stem = table.replace(/s$/i, '');
      const alt = db.prepare(
        `SELECT name FROM symbols WHERE type = 'table' AND name LIKE ? COLLATE NOCASE ORDER BY LENGTH(name) ASC LIMIT 1`,
      ).get(`${stem}%`) as { name: string } | undefined;
      cloneNotes +=
        `\n   ⚠️ Datasource table "${table}" ${stale ? 'is stale in the index (its file no longer exists on disk — run update_symbol_index)' : 'not found in the index'}` +
        (alt && alt.name.toLowerCase() !== table.toLowerCase() ? ` — did you mean "${alt.name}"?` : '') +
        ` The form will not build until that table exists or the datasource is re-pointed.`;
    }
  } catch {
    /* index unavailable — skip the existence check */
  }

  // On non-Windows (Azure/Linux) — return XML as text, no file write possible.
  if (isNonWindows) {
    console.log(`[generateSmartForm] Non-Windows environment — returning XML as text (no file write)`);
    const noModelNote = resolvedModel
      ? ''
      : `\n> ⚠️  No model resolved — XML generated without prefix. Pass \`modelName\` with the actual model name from .mcp.json (e.g. \`"ContosoExt"\`) for correct object naming.`;
    const nextStep = [
      ``,
      `**✅ MANDATORY NEXT STEP — immediately call \`d365fo_file(action="create")\` with the XML below:**`,
      `\`\`\``,
      `d365fo_file(action="create", `,
      `  objectType="form",`,
      `  objectName="${finalName}",`,
      `  xmlContent="<copy the full XML block below>",`,
      `  addToProject=true`,
      `)`,
      `\`\`\``,
      `⛔ NEVER use \`create_file\`, PowerShell scripts, or any built-in file tool — they corrupt D365FO metadata and break VS project integration.`,
    ].join('\n');
    return {
      content: [
        {
          type: 'text',
          text: [
            `✅ Form XML generated for **${finalName}**`,
            resolvedModel ? `   Model: ${resolvedModel}` : `   ℹ️  No model resolved — no prefix applied. Pass modelName to set prefix.`,
            `   DataSources: ${dataSources.length}, Controls: ${controls.length}`,
            cloneNotes,
            noModelNote,
            ``,
            `ℹ️  MCP server is running on Azure/Linux — file writing is handled by the local Windows companion. This is the expected hybrid workflow.`,
            nextStep,
            ``,
            `\`\`\`xml`,
            xml,
            `\`\`\``,
          ].join('\n'),
        },
      ],
    };
  }

  // Windows — write to file
  // Defense-in-depth: resolvedModel should have been validated in the block above,
  // but path.join(packagePath, undefined, ...) throws a cryptic TypeError — guard explicitly.
  if (!resolvedModel) {
    return {
      content: [{
        type: 'text',
        text:
          `❌ Cannot write form file: model name could not be resolved.\n\n` +
          `Add \`projectPath\` to .mcp.json so the tool can extract the model name from your .rnrproj:\n` +
          `\`\`\`json\n{ "servers": { "context": { "projectPath": "K:\\\\VSProjects\\\\...\\\\YourProject.rnrproj" } } }\n\`\`\``,
      }],
      isError: true,
    };
  }
  const targetPath = path.join(packagePath, resolvedModel, resolvedModel, 'AxForm', `${finalName}.xml`);
  const normalizedPath = targetPath.replace(/\//g, '\\');

  // Verify drive/root exists
  const driveOrRoot = path.parse(normalizedPath).root;
  if (driveOrRoot && !fs.existsSync(driveOrRoot)) {
    throw new Error(
      `❌ Drive or root path does not exist: ${driveOrRoot}\n\n` +
      `Attempting to create: ${normalizedPath}\n\n` +
      `Update "packagePath" in .mcp.json to match your actual D365FO installation.`
    );
  }

  const dir = path.dirname(normalizedPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(normalizedPath, normalizeD365Xml(xml), 'utf-8');
  console.log(`[generateSmartForm] Created file: ${normalizedPath}`);

  // Add to Visual Studio project if a projectPath is known
  let projectMessage = '';
  const effectiveProjectPath = resolvedProjectPath ||
    (await getConfigManager().getProjectPath()) ||
    undefined;

  if (effectiveProjectPath) {
    try {
      const projectManager = new ProjectFileManager();
      const wasAdded = await projectManager.addToProject(
        effectiveProjectPath,
        'form',
        finalName,
        normalizedPath
      );
      projectMessage = wasAdded
        ? `\n✅ Added to Visual Studio project:\n📋 Project: ${effectiveProjectPath}`
        : `\n✅ Already in Visual Studio project:\n📋 Project: ${effectiveProjectPath}`;
      console.log(`[generateSmartForm] addToProject result: ${wasAdded ? 'added' : 'already present'}`);
    } catch (projErr) {
      projectMessage = `\n⚠️ File created but could not be added to project: ${projErr instanceof Error ? projErr.message : String(projErr)}`;
      console.error(`[generateSmartForm] addToProject error:`, projErr);
    }
  } else {
    projectMessage = `\n⚠️ addToProject skipped — no projectPath found in .mcp.json or tool args.`;
  }

  return {
    content: [
      {
        type: 'text',
        text: [
          `✅ Form **${finalName}** created directly on the Windows VM.`,
          ``,
          `📁 File: ${normalizedPath}`,
          `📦 Model: ${resolvedModel}`,
          `📊 DataSources: ${dataSources.length}, Controls: ${controls.length}`,
          cloneNotes,
          projectMessage,
          ``,
          `⛔ DO NOT call \`d365fo_file(action="create")\` — the file is already written to disk at the path above. Calling d365fo_file would create a DUPLICATE at a different path which causes build conflicts.`,
          `⛔ DO NOT call \`generate\` again — task is COMPLETE.`,
          ``,
          `Next steps for the user:`,
          `1. Reload the project in Visual Studio (or close/reopen solution)`,
          `2. Build the project to synchronize the form`,
          `3. Refresh AOT to see the new object`,
        ].join('\n'),
      },
    ],
  };
}

/**
 * The most common Design-level PatternVersion this environment uses for a form
 * pattern, from mined form_patterns data. Returns null when no mined data exists.
 */
export function resolveEnvPatternVersion(db: any, patternXmlName: string): string | null {
  try {
    const row = db.prepare(`
      SELECT pattern_version, COUNT(*) AS n
      FROM form_patterns
      WHERE node_path = 'Design' AND pattern = ? AND pattern_version IS NOT NULL AND pattern_version != ''
      GROUP BY pattern_version
      ORDER BY n DESC
      LIMIT 1
    `).get(patternXmlName) as { pattern_version: string } | undefined;
    return row?.pattern_version ?? null;
  } catch {
    return null;
  }
}

// extractModelFromProject and findProjectInSolution moved to ../utils/projectUtils.ts
