import path from 'path';
import { readdir, readFile, stat } from 'fs/promises';

/**
 * Guards a model's OData actions against xppc's incremental mode.
 *
 * xppc writes the OData resources of a package to `bin\Dynamics.AX.<Package>.ODataExtends.runtime`,
 * one entry per data entity with its fields and actions, and the OData service reads the actions
 * from there when the AOS starts. With `-incremental`, an entity that xppc recompiles gets its entry
 * rewritten WITHOUT its actions; a full build writes them. Measured on a CHE box: a Visual Studio
 * build of an entity listed `ExistingAction`; an incremental build after adding a second action
 * `NewAction` listed neither — the action that had worked was gone too — while the entity's
 * XppMetadata file held both methods; a full build listed both. So a green incremental build of an
 * entity with actions removes them from OData at the next AOS restart. The `.md` manifests are not
 * involved: they are byte-identical to Visual Studio's.
 */

/**
 * Element types whose source can declare OData actions. Actions are methods of the data entity
 * itself; an entity extension or an `[ExtensionOf(tableStr(Entity))]` class can add more, so a
 * recompile of either also counts. Only entities are compared with ODataExtends.runtime: the
 * other two are written to a sibling file this module does not read.
 */
const ENTITY_TYPE = 'AxDataEntityView';
const ACTION_SOURCE_TYPES = [ENTITY_TYPE, 'AxDataEntityViewExtension', 'AxClass'];

/**
 * `[SysODataActionAttribute('Name', true)]`, also with the `Attribute` suffix dropped, which X++
 * allows, and anywhere in a combined attribute list. Comments are stripped first: a commented-out
 * action would otherwise read as missing from every build and force a full build each time.
 */
const ODATA_ACTION_RE = /\bSysODataAction(?:Attribute)?\s*\(/i;
const ODATA_ACTION_NAME_RE = /\bSysODataAction(?:Attribute)?\s*\(\s*(?:"([^"]*)"|'([^']*)')/gi;

/**
 * The public action names a source declares: the FIRST argument of each SysODataActionAttribute,
 * which is what ODataExtends.runtime keys the action by (`ExistingAction`), not the method (`existingAction`).
 * A name that is not a string literal cannot be checked and is left out.
 */
export function extractODataActionNames(source: string): string[] {
  const names = new Set<string>();
  for (const m of stripXppComments(source).matchAll(ODATA_ACTION_NAME_RE)) {
    const name = (m[1] ?? m[2] ?? '').trim();
    if (name) names.add(name);
  }
  return [...names];
}

/**
 * Drop block and line comments. Naive about string literals — `'http://x'` loses the rest of its
 * line — which only matters if an attribute follows on that same line.
 */
export function stripXppComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\r\n]*/g, '');
}

const ACTION_KEY_RE = /<(?:\w+:)?KeyValueOfstringAxODataAction\w*>\s*<(?:\w+:)?Key>([^<]*)<\/(?:\w+:)?Key>/g;

/**
 * Entity AOT name → action names, from the content of a `Dynamics.AX.<Package>.ODataExtends.runtime`.
 *
 * The file is UTF-8 with a BOM, one line per entity: the entity's AOT name, a TAB, and one
 * single-line `<AxODataResource>` document (DataContractSerializer). Its actions are the `Key`s of
 * the `KeyValueOfstringAxODataAction…` items under `<Actions>`; an entity without actions has an
 * empty `<Items/>` there. Only `<Actions>` is searched, so a field can never be mistaken for one.
 */
export function parseODataExtendsRuntime(content: string): Map<string, string[]> {
  const entries = new Map<string, string[]>();
  for (const rawLine of content.replace(/^﻿/, '').split(/\r?\n/)) {
    const tab = rawLine.indexOf('\t');
    if (tab <= 0) continue;
    const entity = rawLine.slice(0, tab).trim();
    const xml = rawLine.slice(tab + 1);
    const start = xml.indexOf('<Actions>');
    const end = start === -1 ? -1 : xml.indexOf('</Actions>', start);
    const actionsXml = start === -1 ? '' : xml.slice(start, end === -1 ? undefined : end);
    entries.set(
      entity,
      [...actionsXml.matchAll(ACTION_KEY_RE)].map(m => m[1].trim()),
    );
  }
  return entries;
}

/**
 * The package's ODataExtends.runtime in `binDir`, or null when there is none. Its casing follows the
 * assembly name rather than the folder (`AtlFoundation\bin\Dynamics.AX.ATLFoundation…`), so the
 * name is matched case-insensitively; failing that, the one `*.ODataExtends.runtime` in the folder.
 */
export async function findODataExtendsRuntime(binDir: string, packageName: string): Promise<string | null> {
  let names: string[];
  try {
    names = await readdir(binDir);
  } catch {
    return null;
  }
  const expected = `dynamics.ax.${packageName}.odataextends.runtime`.toLowerCase();
  const exact = names.find(n => n.toLowerCase() === expected);
  if (exact) return path.join(binDir, exact);
  const any = names.filter(n => /^dynamics\.ax\..+\.odataextends\.runtime$/i.test(n));
  return any.length === 1 ? path.join(binDir, any[0]) : null;
}

/** An entity whose ODataExtends.runtime entry lacks actions its source declares. */
export interface MissingODataActions {
  entity: string;
  actions: string[];
}

/** What {@link scanODataActions} found in one package. */
export interface ODataActionScanResult {
  /** `<AxType>/<Name>` of each element an incremental build would recompile that declares an OData action. */
  recompiled: string[];
  /** Entities whose ODataExtends.runtime entry already lacks declared actions. Empty without that file. */
  missing: MissingODataActions[];
  /** The ODataExtends.runtime compared against, or null when the package has none yet. */
  runtimeFile: string | null;
  /** Non-fatal per-file problems; the file is treated as declaring no action. */
  errors: string[];
}

/**
 * Whether an incremental build of this package would lose OData actions, and whether the deployed
 * ODataExtends.runtime has lost some already.
 *
 * `recompiled` uses the signal pruneStaleCompilerMetadata relies on: xppc writes back an element's
 * compiler metadata whenever it compiles it, so a source newer than its `XppMetadata` file, or
 * without one, is an element this build compiles. Run it BEFORE that prune, which deletes the stale
 * metadata files and touches their sources. `missing` catches what an earlier incremental build
 * already dropped — a build whose entities are all current would otherwise never put them back.
 * An entity without an entry is skipped: a non-public entity has none, and an entity compiled for
 * the first time is in `recompiled` anyway. So is an entity in `recompiled`: an action it lacks is
 * one just added in the source, not one an earlier build dropped.
 *
 * Sources are read only when they matter: every entity (to know its actions), and the other types
 * only when they are about to be recompiled. Everything else costs two stats.
 */
export async function scanODataActions(
  compilerMetadataRoot: string,
  sourceRoot: string,
  packageName: string,
  { checkRecompile = true }: { checkRecompile?: boolean } = {},
): Promise<ODataActionScanResult> {
  const packageDir = path.join(sourceRoot, packageName);
  const runtimeFile = await findODataExtendsRuntime(path.join(packageDir, 'bin'), packageName);
  const result: ODataActionScanResult = { recompiled: [], missing: [], runtimeFile, errors: [] };
  const xppMetadataDir = path.join(compilerMetadataRoot, packageName, 'XppMetadata');

  let models;
  try {
    models = await readdir(packageDir, { withFileTypes: true });
  } catch (err: any) {
    result.errors.push(`${packageDir}: ${err?.message ?? err}`);
    return result;
  }

  const candidates: { sourceFile: string; metaFile: string; type: string; name: string }[] = [];
  for (const model of models) {
    if (!model.isDirectory()) continue;
    for (const type of ACTION_SOURCE_TYPES) {
      if (!checkRecompile && type !== ENTITY_TYPE) continue;
      const sourceTypeDir = path.join(packageDir, model.name, type);
      let files;
      try {
        files = await readdir(sourceTypeDir, { withFileTypes: true });
      } catch (err: any) {
        // Most models have no folder for most of these types.
        if (err?.code !== 'ENOENT' && err?.code !== 'ENOTDIR')
          result.errors.push(`${sourceTypeDir}: ${err?.message ?? err}`);
        continue;
      }
      for (const file of files) {
        if (!file.isFile() || !file.name.toLowerCase().endsWith('.xml')) continue;
        candidates.push({
          sourceFile: path.join(sourceTypeDir, file.name),
          metaFile: path.join(xppMetadataDir, model.name, type, file.name),
          type,
          name: path.basename(file.name, '.xml'),
        });
      }
    }
  }

  const declared = new Map<string, string[]>();
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(SCAN_CONCURRENCY, candidates.length) }, async () => {
      while (next < candidates.length) {
        const c = candidates[next++];
        try {
          const recompiles = checkRecompile && (await willRecompile(c.sourceFile, c.metaFile));
          if (!recompiles && !(c.type === ENTITY_TYPE && runtimeFile)) continue;
          const source = stripXppComments(await readFile(c.sourceFile, 'utf-8'));
          if (!ODATA_ACTION_RE.test(source)) continue;
          if (recompiles) result.recompiled.push(`${c.type}/${c.name}`);
          if (c.type === ENTITY_TYPE) declared.set(c.name, extractODataActionNames(source));
        } catch (err: any) {
          result.errors.push(`${c.sourceFile}: ${err?.message ?? err}`);
        }
      }
    }),
  );
  result.recompiled.sort();

  if (runtimeFile && declared.size > 0) {
    try {
      const recompiledEntities = new Set(
        result.recompiled.filter(r => r.startsWith(`${ENTITY_TYPE}/`)).map(r => r.slice(ENTITY_TYPE.length + 1).toLowerCase()),
      );
      result.missing = compareWithRuntime(declared, parseODataExtendsRuntime(await readFile(runtimeFile, 'utf-8')))
        .filter(m => !recompiledEntities.has(m.entity.toLowerCase()));
    } catch (err: any) {
      result.errors.push(`${runtimeFile}: ${err?.message ?? err}`);
    }
  }
  return result;
}

/** Declared actions absent from the entity's entry, case-insensitively; entities without an entry are skipped. */
export function compareWithRuntime(
  declared: Map<string, string[]>,
  runtime: Map<string, string[]>,
): MissingODataActions[] {
  const runtimeByEntity = new Map([...runtime].map(([entity, actions]) => [entity.toLowerCase(), actions]));
  const missing: MissingODataActions[] = [];
  for (const [entity, actions] of declared) {
    const present = runtimeByEntity.get(entity.toLowerCase());
    if (!present) continue;
    const have = new Set(present.map(a => a.toLowerCase()));
    const lost = actions.filter(a => !have.has(a.toLowerCase()));
    if (lost.length > 0) missing.push({ entity, actions: lost });
  }
  return missing.sort((a, b) => a.entity.localeCompare(b.entity));
}

/** `ProbeEntity (ExistingAction, NewAction)`, for logs and results. */
export function describeMissingODataActions(missing: MissingODataActions[], max = 10): string {
  const shown = missing
    .slice(0, max)
    .map(m => `${m.entity} (${m.actions.join(', ')})`)
    .join('; ');
  return missing.length > max ? `${shown}; … (+${missing.length - max})` : shown;
}

const SCAN_CONCURRENCY = 16;

/** Same rule as pruneStaleCompilerMetadata: an equal mtime is current. */
export async function willRecompile(sourceFile: string, metaFile: string): Promise<boolean> {
  const sourceMtime = (await stat(sourceFile)).mtimeMs;
  try {
    return sourceMtime > (await stat(metaFile)).mtimeMs;
  } catch (err: any) {
    if (err?.code === 'ENOENT') return true; // never compiled, or its metadata was cleared
    throw err;
  }
}
